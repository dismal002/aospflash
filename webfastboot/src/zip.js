/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * JavaScript port of the zip-reading half of fastboot.cpp's
 * ZipImageSource (UnzipToMemory/UnzipToFile + FindEntry, backed by
 * AOSP's libziparchive). libziparchive itself is a native C library
 * with no browser equivalent, so this is an independent reader
 * against the public ZIP file format (PKWARE's APPNOTE.TXT), written
 * from scratch: central-directory-first lookup, STORE and DEFLATE
 * entries only (the two methods libziparchive itself supports), with
 * DEFLATE handled by the browser's built-in `DecompressionStream`
 * instead of a bundled inflate implementation.
 *
 * This covers what flashall.js needs from an update/factory-image
 * zip: getFile(name) returning an entry's uncompressed bytes, or null
 * if the entry doesn't exist (matching ZipImageSource::ReadFile's
 * bool-return/not-found semantics, adapted to the ImageSource shape
 * flashall.js already uses for FileMapImageSource).
 */

import { ProtocolError } from './errors.js';

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const LOCAL_HEADER_SIG = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;

const EOCD_MIN_SIZE = 22;
const EOCD64_LOCATOR_SIZE = 20;
const MAX_COMMENT_SIZE = 0xffff;

/**
 * Minimal random-access byte source so the same parsing code works
 * whether the caller handed us a Blob/File (read lazily, in slices —
 * important since factory-image zips can be 1GB+) or an in-memory
 * ArrayBuffer/Uint8Array.
 */
class ByteSource {
  /** @param {Blob|ArrayBuffer|Uint8Array} input */
  constructor(input) {
    if (input instanceof Blob) {
      this._blob = input;
      this.size = input.size;
    } else {
      this._bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      this.size = this._bytes.byteLength;
    }
  }

  /**
   * @param {number} offset
   * @param {number} length
   * @returns {Promise<Uint8Array>}
   */
  async read(offset, length) {
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new ProtocolError('Zip read out of bounds (truncated or corrupt archive)');
    }
    if (this._blob) {
      const buf = await this._blob.slice(offset, offset + length).arrayBuffer();
      return new Uint8Array(buf);
    }
    return this._bytes.subarray(offset, offset + length);
  }
}

/** @typedef {{method: number, compressedSize: number, uncompressedSize: number, localHeaderOffset: number}} CentralDirEntry */

/**
 * JavaScript port (scope-limited to what's used here) of AOSP's
 * ZipImageSource: an ImageSource backed by a zip archive's contents,
 * used by flashAll()/update() for update.zip / target-files zips /
 * the image-<device>-<build>.zip inside a factory image bundle.
 * @implements {import('./flashall.js').ImageSource}
 */
export class ZipImageSource {
  /** @param {ByteSource} source @param {Map<string, CentralDirEntry>} entries */
  constructor(source, entries) {
    this._source = source;
    this._entries = entries;
  }

  /**
   * Parses the archive's central directory (and, if present, ZIP64
   * end-of-central-directory records) up front. The bulk of each
   * entry's bytes aren't read until getFile() is called for it.
   *
   * @param {Blob|File|ArrayBuffer|Uint8Array} zipInput
   * @returns {Promise<ZipImageSource>}
   */
  static async open(zipInput) {
    const source = new ByteSource(zipInput);
    const eocd = await findEndOfCentralDirectory(source);
    const entries = await readCentralDirectory(source, eocd);
    return new ZipImageSource(source, entries);
  }

  /**
   * @param {string} name
   * @returns {Promise<Uint8Array|null>} null if the archive has no such entry.
   */
  /**
   * @param {string} name
   * @param {(loaded: number, total: number) => void} [onProgress]
   * @returns {Promise<Uint8Array|Blob|null>} null if the archive has no such entry.
   */
  async getFile(name, onProgress) {
    let entry = this._entries.get(name);
    if (!entry) {
      // Look for entries matching by basename (e.g. "volantis-mmb29v/image-volantis-mmb29v.zip" or "images/boot.img")
      const lowerName = name.toLowerCase();
      for (const [key, val] of this._entries.entries()) {
        const base = key.split('/').pop();
        if (key === name || base === name || key.toLowerCase() === lowerName || base.toLowerCase() === lowerName) {
          entry = val;
          break;
        }
      }
    }
    if (!entry) return null;
    return extractEntry(this._source, entry, onProgress);
  }

  /** @returns {string[]} Names of every entry in the archive. */
  listFiles() {
    return [...this._entries.keys()];
  }
}

// ---- Central directory / EOCD parsing -------------------------------------

async function findEndOfCentralDirectory(source) {
  // The EOCD record is fixed-size except for a trailing comment of up
  // to 65535 bytes, so scan backwards for its signature within that
  // window from the end of the file (mirrors what libziparchive's
  // MapCentralDirectory does).
  const searchSize = Math.min(source.size, EOCD_MIN_SIZE + MAX_COMMENT_SIZE);
  const tailOffset = source.size - searchSize;
  const tail = await source.read(tailOffset, searchSize);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  let eocdPos = -1;
  for (let i = tail.byteLength - EOCD_MIN_SIZE; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos === -1) {
    throw new ProtocolError('Not a valid zip archive (no end-of-central-directory record found)');
  }

  let totalEntries = view.getUint16(eocdPos + 10, true);
  let cdSize = view.getUint32(eocdPos + 12, true);
  let cdOffset = view.getUint32(eocdPos + 16, true);

  // ZIP64: a plain EOCD can't represent >~4GB archives or >65535
  // entries, both plausible for a factory-image zip. When the 32-bit
  // fields are saturated, the real values live in a ZIP64 EOCD
  // record, found via a locator that sits immediately before the
  // regular EOCD.
  const looksZip64 = cdOffset === 0xffffffff || cdSize === 0xffffffff || totalEntries === 0xffff;
  if (looksZip64) {
    const locatorOffset = tailOffset + eocdPos - EOCD64_LOCATOR_SIZE;
    if (locatorOffset < 0) {
      throw new ProtocolError('Zip claims ZIP64 but has no end-of-central-directory locator');
    }
    const locator = await source.read(locatorOffset, EOCD64_LOCATOR_SIZE);
    const lview = new DataView(locator.buffer, locator.byteOffset, locator.byteLength);
    if (lview.getUint32(0, true) !== EOCD64_LOCATOR_SIG) {
      throw new ProtocolError('Malformed ZIP64 end-of-central-directory locator');
    }
    const eocd64Offset = Number(lview.getBigUint64(8, true));

    const eocd64Header = await source.read(eocd64Offset, 56);
    const eview = new DataView(eocd64Header.buffer, eocd64Header.byteOffset, eocd64Header.byteLength);
    if (eview.getUint32(0, true) !== EOCD64_SIG) {
      throw new ProtocolError('Malformed ZIP64 end-of-central-directory record');
    }
    totalEntries = Number(eview.getBigUint64(32, true));
    cdSize = Number(eview.getBigUint64(40, true));
    cdOffset = Number(eview.getBigUint64(48, true));
  }

  return { totalEntries, cdSize, cdOffset };
}

async function readCentralDirectory(source, eocd) {
  const cdBytes = await source.read(eocd.cdOffset, eocd.cdSize);
  const view = new DataView(cdBytes.buffer, cdBytes.byteOffset, cdBytes.byteLength);
  const decoder = new TextDecoder(); // filenames are UTF-8 when the UTF-8 bit is set; treated as such either way

  const entries = new Map();
  let offset = 0;
  for (let i = 0; i < eocd.totalEntries; i++) {
    if (offset + 46 > cdBytes.byteLength) {
      throw new ProtocolError('Central directory truncated while reading a file header');
    }
    if (view.getUint32(offset, true) !== CENTRAL_DIR_SIG) {
      throw new ProtocolError('Malformed central directory (bad file header signature)');
    }

    const method = view.getUint16(offset + 10, true);
    let compressedSize = view.getUint32(offset + 20, true);
    let uncompressedSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    let localHeaderOffset = view.getUint32(offset + 42, true);

    const nameStart = offset + 46;
    const name = decoder.decode(cdBytes.subarray(nameStart, nameStart + nameLen));

    // ZIP64 extra field: present when any of the 32-bit fields above
    // were saturated, in that fixed order (uncompressed, compressed,
    // local header offset) — only the saturated ones are included.
    const needsZip64 =
      compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff;
    if (needsZip64) {
      const extraStart = nameStart + nameLen;
      const zip64 = parseZip64Extra(cdBytes, extraStart, extraLen, {
        uncompressedSize,
        compressedSize,
        localHeaderOffset,
      });
      uncompressedSize = zip64.uncompressedSize;
      compressedSize = zip64.compressedSize;
      localHeaderOffset = zip64.localHeaderOffset;
    }

    entries.set(name, { method, compressedSize, uncompressedSize, localHeaderOffset });
    offset = nameStart + nameLen + extraLen + commentLen;
  }

  return entries;
}

/**
 * Reads the ZIP64 extra field (id 0x0001), whose sub-fields are
 * present *only* for the values that were 0xffffffff in the
 * fixed-size record, in the fixed order: uncompressed size,
 * compressed size, local header offset, disk number.
 */
function parseZip64Extra(bytes, extraStart, extraLen, placeholders) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = extraStart;
  const end = extraStart + extraLen;
  const result = { ...placeholders };

  while (pos + 4 <= end) {
    const id = view.getUint16(pos, true);
    const size = view.getUint16(pos + 2, true);
    const dataStart = pos + 4;
    if (id === ZIP64_EXTRA_ID) {
      let p = dataStart;
      if (result.uncompressedSize === 0xffffffff) {
        result.uncompressedSize = Number(view.getBigUint64(p, true));
        p += 8;
      }
      if (result.compressedSize === 0xffffffff) {
        result.compressedSize = Number(view.getBigUint64(p, true));
        p += 8;
      }
      if (result.localHeaderOffset === 0xffffffff) {
        result.localHeaderOffset = Number(view.getBigUint64(p, true));
        p += 8;
      }
      return result;
    }
    pos = dataStart + size;
  }
  throw new ProtocolError('Zip entry needs ZIP64 sizes but has no ZIP64 extra field');
}

// ---- Entry extraction -------------------------------------------------

async function extractEntry(source, entry, onProgress) {
  // The local file header duplicates (and can disagree slightly with,
  // e.g. via data-descriptor flags) the central directory's name/extra
  // lengths, so re-read it to find where this entry's actual payload
  // starts — same reason UnzipToFile/ExtractToMemory go through
  // libziparchive's own local-header handling rather than trusting
  // the central directory's offsets alone.
  const header = await source.read(entry.localHeaderOffset, 30);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== LOCAL_HEADER_SIG) {
    throw new ProtocolError('Malformed zip entry (bad local file header signature)');
  }
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;

  if (entry.method === 0) {
    // Stored (no compression).
    if (source._blob) {
      if (onProgress) onProgress(entry.uncompressedSize, entry.uncompressedSize);
      return source._blob.slice(dataStart, dataStart + entry.uncompressedSize);
    }
    const compressed = await source.read(dataStart, entry.compressedSize);
    if (onProgress) onProgress(entry.uncompressedSize, entry.uncompressedSize);
    return new Blob([compressed]);
  }
  if (entry.method === 8) {
    let compressed;
    if (source._blob) {
      compressed = source._blob.slice(dataStart, dataStart + entry.compressedSize);
    } else {
      compressed = await source.read(dataStart, entry.compressedSize);
    }
    return inflateRawToBlob(compressed, entry.uncompressedSize, onProgress);
  }
  throw new ProtocolError(
    `Unsupported zip compression method ${entry.method} (only stored/deflate are supported)`,
  );
}

/**
 * Decompresses a raw DEFLATE stream into an off-heap Blob using the platform's
 * built-in DecompressionStream.
 *
 * @param {Blob|Uint8Array} compressed
 * @param {number} expectedSize
 * @param {(loaded: number, total: number) => void} [onProgress]
 * @returns {Promise<Blob>}
 */
async function inflateRawToBlob(compressed, expectedSize, onProgress) {
  if (typeof DecompressionStream === 'undefined') {
    throw new ProtocolError(
      'This browser has no DecompressionStream support, required to read compressed zip entries',
    );
  }
  const ds = new DecompressionStream('deflate-raw');
  let rawStream;
  if (compressed instanceof Blob) {
    rawStream = compressed.stream().pipeThrough(ds);
  } else {
    const bufferSlice = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
    rawStream = new Response(bufferSlice).body.pipeThrough(ds);
  }

  let totalBytes = 0;
  let lastReport = 0;
  const progressTransform = new TransformStream({
    transform(chunk, controller) {
      totalBytes += chunk.byteLength;
      if (onProgress && expectedSize && totalBytes - lastReport > 2 * 1024 * 1024) {
        lastReport = totalBytes;
        onProgress(totalBytes, expectedSize);
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (onProgress && expectedSize) {
        onProgress(totalBytes, expectedSize);
      }
    },
  });

  const stream = rawStream.pipeThrough(progressTransform);
  return new Response(stream).blob();
}

