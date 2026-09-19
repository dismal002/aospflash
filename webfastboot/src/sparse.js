/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Support for the Android sparse image format used by fastboot.
 *
 * This is an independent implementation of the on-disk format
 * documented publicly by AOSP (system/core/libsparse/sparse_format.h)
 * — no code from libsparse is reused, only the (openly published)
 * binary layout, which any compatible implementation must match:
 *
 *   sparse_header (28 bytes, LE):
 *     u32 magic            0xed26ff3a
 *     u16 major_version    1
 *     u16 minor_version    0
 *     u16 file_hdr_sz      28
 *     u16 chunk_hdr_sz     12
 *     u32 blk_sz           block size in bytes (image is a multiple of this)
 *     u32 total_blks       total blocks represented by this image
 *     u32 total_chunks     number of chunk_header entries that follow
 *     u32 image_checksum   crc32 of the *original* raw image, or 0
 *
 *   chunk_header (12 bytes, LE), one per chunk, immediately followed by
 *   the chunk's payload (if any):
 *     u16 chunk_type       0xCAC1 raw | 0xCAC2 fill | 0xCAC3 dont-care | 0xCAC4 crc32
 *     u16 reserved1
 *     u32 chunk_sz         size of this chunk, in blocks
 *     u32 total_sz         total bytes of this chunk incl. the 12-byte header
 *
 *   raw:       total_sz == 12 + chunk_sz*blk_sz; payload is the raw bytes.
 *   fill:      total_sz == 12 + 4;               payload is one u32 fill value,
 *                                                 repeated to fill chunk_sz*blk_sz bytes.
 *   dont-care: total_sz == 12;                    no payload; skip chunk_sz blocks.
 *   crc32:     total_sz == 12 + 4;                payload is a crc32 value (verification only).
 *
 * We use this to do what AOSP's host fastboot does before flashing a
 * partition larger than the bootloader's max-download-size: split one
 * logical image into several sparse chunks that are each independently
 * downloadable, where each chunk still declares the *full* partition's
 * total_blks and represents everything outside its own slice as
 * "don't care" so the bootloader writes each piece at the correct
 * absolute block offset. This mirrors libsparse's sparse_file_resparse(),
 * which fastboot.cpp calls via resparse_file()/load_sparse_files() when
 * get_sparse_limit() determines the image exceeds the device's reported
 * max-download-size.
 */

import { ProtocolError } from './errors.js';

const SPARSE_HEADER_MAGIC = 0xed26ff3a;
const SPARSE_HEADER_SIZE = 28;
const CHUNK_HEADER_SIZE = 12;

export const ChunkType = Object.freeze({
  RAW: 0xcac1,
  FILL: 0xcac2,
  DONT_CARE: 0xcac3,
  CRC32: 0xcac4,
});

export const DEFAULT_BLOCK_SIZE = 4096;

/** @typedef {{type: number, blocks: number, data?: Uint8Array, fill?: number}} SparseChunk */

/**
 * Returns true if `buffer` begins with a valid sparse header.
 * @param {ArrayBuffer|Uint8Array} buffer
 */
export function isSparse(buffer) {
  const view = toDataView(buffer);
  return view.byteLength >= 4 && view.getUint32(0, true) === SPARSE_HEADER_MAGIC;
}

/**
 * Parses an existing Android sparse image (as produced by a build, e.g.
 * system.img) into its block size, total block count, and chunk list.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{blockSize: number, totalBlocks: number, chunks: SparseChunk[]}}
 */
export function parseSparse(buffer) {
  const view = toDataView(buffer);
  const bytes = toUint8Array(buffer);

  if (view.byteLength < SPARSE_HEADER_SIZE || view.getUint32(0, true) !== SPARSE_HEADER_MAGIC) {
    throw new ProtocolError('Not a valid Android sparse image (bad magic)');
  }
  const fileHdrSz = view.getUint16(8, true);
  const chunkHdrSz = view.getUint16(10, true);
  const blockSize = view.getUint32(12, true);
  const totalBlocks = view.getUint32(16, true);
  const totalChunks = view.getUint32(20, true);

  if (fileHdrSz < SPARSE_HEADER_SIZE || chunkHdrSz < CHUNK_HEADER_SIZE) {
    throw new ProtocolError('Unsupported sparse header size');
  }

  const chunks = [];
  let offset = fileHdrSz;
  for (let i = 0; i < totalChunks; i++) {
    if (offset + chunkHdrSz > view.byteLength) {
      throw new ProtocolError('Sparse image truncated while reading chunk headers');
    }
    const chunkType = view.getUint16(offset, true);
    const chunkSzBlocks = view.getUint32(offset + 4, true);
    const totalSz = view.getUint32(offset + 8, true);
    const payloadStart = offset + chunkHdrSz;
    const payloadLen = totalSz - chunkHdrSz;

    if (payloadStart + payloadLen > view.byteLength) {
      throw new ProtocolError('Sparse image truncated while reading chunk payload');
    }

    switch (chunkType) {
      case ChunkType.RAW:
        chunks.push({
          type: ChunkType.RAW,
          blocks: chunkSzBlocks,
          data: bytes.subarray(payloadStart, payloadStart + payloadLen),
        });
        break;
      case ChunkType.FILL:
        chunks.push({
          type: ChunkType.FILL,
          blocks: chunkSzBlocks,
          fill: view.getUint32(payloadStart, true),
        });
        break;
      case ChunkType.DONT_CARE:
        chunks.push({ type: ChunkType.DONT_CARE, blocks: chunkSzBlocks });
        break;
      case ChunkType.CRC32:
        // Verification-only; we don't check it, but we do need to skip it.
        break;
      default:
        throw new ProtocolError(`Unknown sparse chunk type 0x${chunkType.toString(16)}`);
    }

    offset += totalSz;
  }

  return { blockSize, totalBlocks, chunks };
}

/**
 * Converts a raw image buffer into a normalized chunk list (blockSize,
 * totalBlocks, chunks), collapsing all-zero blocks into DONT_CARE runs
 * so the resulting sparse image is smaller than the raw input — the
 * same optimization libsparse's sparse_file_read() applies.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {number} [blockSize]
 */
export function rawToChunks(buffer, blockSize = DEFAULT_BLOCK_SIZE) {
  const bytes = toUint8Array(buffer);
  const totalBlocks = Math.ceil(bytes.byteLength / blockSize);
  const chunks = [];

  let i = 0;
  while (i < totalBlocks) {
    const start = i * blockSize;
    const end = Math.min(start + blockSize, bytes.byteLength);
    const block = bytes.subarray(start, end);

    if (isAllZero(block) && end - start === blockSize) {
      // Extend a run of all-zero blocks into one DONT_CARE chunk.
      let j = i + 1;
      while (j < totalBlocks) {
        const s2 = j * blockSize;
        const e2 = Math.min(s2 + blockSize, bytes.byteLength);
        if (e2 - s2 !== blockSize || !isAllZero(bytes.subarray(s2, e2))) break;
        j++;
      }
      chunks.push({ type: ChunkType.DONT_CARE, blocks: j - i });
      i = j;
    } else {
      // Extend a run of "real data" blocks into one RAW chunk.
      let j = i + 1;
      const dataStart = start;
      while (j < totalBlocks) {
        const s2 = j * blockSize;
        const e2 = Math.min(s2 + blockSize, bytes.byteLength);
        const blk = bytes.subarray(s2, e2);
        if (e2 - s2 === blockSize && isAllZero(blk)) break;
        j++;
      }
      const dataEnd = Math.min(j * blockSize, bytes.byteLength);
      let data = bytes.subarray(dataStart, dataEnd);
      // Pad the final partial block up to blockSize with zeros.
      if (data.byteLength % blockSize !== 0) {
        const padded = new Uint8Array(Math.ceil(data.byteLength / blockSize) * blockSize);
        padded.set(data);
        data = padded;
      }
      chunks.push({ type: ChunkType.RAW, blocks: j - i, data });
      i = j;
    }
  }

  return { blockSize, totalBlocks, chunks };
}

/**
 * Serializes {blockSize, totalBlocks, chunks} into a sparse image
 * buffer (Uint8Array) ready to send with FastbootDriver#download().
 *
 * @param {{blockSize: number, totalBlocks: number, chunks: SparseChunk[]}} image
 */
export function buildSparse({ blockSize, totalBlocks, chunks }) {
  let size = SPARSE_HEADER_SIZE;
  for (const c of chunks) {
    size += CHUNK_HEADER_SIZE;
    if (c.type === ChunkType.RAW) size += c.data.byteLength;
    else if (c.type === ChunkType.FILL) size += 4;
  }

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);

  view.setUint32(0, SPARSE_HEADER_MAGIC, true);
  view.setUint16(4, 1, true); // major_version
  view.setUint16(6, 0, true); // minor_version
  view.setUint16(8, SPARSE_HEADER_SIZE, true); // file_hdr_sz
  view.setUint16(10, CHUNK_HEADER_SIZE, true); // chunk_hdr_sz
  view.setUint32(12, blockSize, true);
  view.setUint32(16, totalBlocks, true);
  view.setUint32(20, chunks.length, true);
  view.setUint32(24, 0, true); // image_checksum: unused

  let offset = SPARSE_HEADER_SIZE;
  for (const c of chunks) {
    view.setUint16(offset, c.type, true);
    view.setUint16(offset + 2, 0, true); // reserved1
    view.setUint32(offset + 4, c.blocks, true);

    if (c.type === ChunkType.RAW) {
      const totalSz = CHUNK_HEADER_SIZE + c.data.byteLength;
      view.setUint32(offset + 8, totalSz, true);
      out.set(c.data, offset + CHUNK_HEADER_SIZE);
      offset += totalSz;
    } else if (c.type === ChunkType.FILL) {
      view.setUint32(offset + 8, CHUNK_HEADER_SIZE + 4, true);
      view.setUint32(offset + CHUNK_HEADER_SIZE, c.fill, true);
      offset += CHUNK_HEADER_SIZE + 4;
    } else {
      view.setUint32(offset + 8, CHUNK_HEADER_SIZE, true);
      offset += CHUNK_HEADER_SIZE;
    }
  }

  return out;
}

/**
 * Splits a normalized chunk list into multiple sparse images, each
 * encoding no more than `maxSize` bytes on the wire, such that flashing
 * them to the same partition in order reproduces the original image.
 * Equivalent to what fastboot.cpp calls via resparse_file() /
 * get_sparse_limit() when an image exceeds the device's
 * max-download-size.
 *
 * @param {{blockSize: number, totalBlocks: number, chunks: SparseChunk[]}} image
 * @param {number} maxSize Max size in bytes of each resulting sparse image
 *   (this is compared against the *serialized* size, header included).
 * @returns {Uint8Array[]}
 */
export function resparse(image, maxSize) {
  const { blockSize, totalBlocks, chunks } = image;
  const budget = maxSize - SPARSE_HEADER_SIZE;
  // Reserve room for a trailing DONT_CARE chunk (added by flush() after
  // the packing check below) and, when splitting an oversized RAW atom,
  // for a leading DONT_CARE chunk too, plus the atom's own header.
  if (budget <= 3 * CHUNK_HEADER_SIZE + blockSize) {
    throw new ProtocolError('maxSize is too small to hold even one block of data');
  }
  const effectiveBudget = budget - CHUNK_HEADER_SIZE; // reserve for trailing skip
  const maxRawBlocksPerChunk = Math.floor((budget - 3 * CHUNK_HEADER_SIZE) / blockSize);

  // Step 1: normalize into a flat sequence of atoms, each small enough
  // on its own to fit within `budget` bytes, so the packing step below
  // never has to split an atom mid-stream. DONT_CARE atoms are already
  // "small" regardless of block count (they carry no payload), so only
  // RAW atoms need splitting; FILL atoms are always exactly 16 bytes.
  const atoms = [];
  for (const c of chunks) {
    if (c.type === ChunkType.RAW && c.blocks > maxRawBlocksPerChunk) {
      let off = 0;
      while (off < c.blocks) {
        const n = Math.min(maxRawBlocksPerChunk, c.blocks - off);
        atoms.push({
          type: ChunkType.RAW,
          blocks: n,
          data: c.data.subarray(off * blockSize, (off + n) * blockSize),
        });
        off += n;
      }
    } else {
      atoms.push(c);
    }
  }

  // Step 2: greedily pack atoms into outputs of at most `budget` bytes.
  // Every output declares the full image's totalBlocks and pads with a
  // leading/trailing DONT_CARE run to cover whatever this particular
  // output doesn't carry real data for, so the bootloader always writes
  // each piece's payload at the correct absolute block offset — this is
  // the standard "resparse" trick, and it's cheap because DONT_CARE
  // chunks cost a fixed 12-byte header no matter how many blocks they
  // skip.
  const chunkBytes = (a) => {
    if (a.type === ChunkType.RAW) return CHUNK_HEADER_SIZE + a.data.byteLength;
    if (a.type === ChunkType.FILL) return CHUNK_HEADER_SIZE + 4;
    return CHUNK_HEADER_SIZE; // DONT_CARE
  };

  const outputs = [];
  let currentChunks = [];
  let currentSize = 0; // bytes used within currentChunks (excludes the 28-byte file header)
  let localCursor = 0; // blocks accounted for within currentChunks
  let blockCursor = 0; // absolute block position of the next atom to be placed

  const flush = () => {
    if (currentChunks.length === 0) return;
    const trailing = totalBlocks - localCursor;
    const finalChunks =
      trailing > 0 ? [...currentChunks, { type: ChunkType.DONT_CARE, blocks: trailing }] : currentChunks;
    outputs.push(buildSparse({ blockSize, totalBlocks, chunks: finalChunks }));
    currentChunks = [];
    currentSize = 0;
    localCursor = 0;
  };

  for (const atom of atoms) {
    let size = chunkBytes(atom);

    if (currentSize + size > effectiveBudget && currentChunks.length > 0) {
      flush();
    }

    if (currentChunks.length === 0 && blockCursor > 0) {
      // Leading skip so this output's data lands at the right absolute
      // offset. Cheap: fixed 12-byte header regardless of blockCursor.
      currentChunks.push({ type: ChunkType.DONT_CARE, blocks: blockCursor });
      currentSize += CHUNK_HEADER_SIZE;
      localCursor = blockCursor;
    }

    currentChunks.push(atom);
    currentSize += size;
    localCursor += atom.blocks;
    blockCursor += atom.blocks;
  }

  flush();

  if (outputs.length === 0) {
    return [
      buildSparse({ blockSize, totalBlocks, chunks: [{ type: ChunkType.DONT_CARE, blocks: totalBlocks }] }),
    ];
  }
  return outputs;
}

/**
 * High-level helper: given a raw or already-sparse image and the
 * device's max-download-size (from `getvar:max-download-size`),
 * returns an array of one or more sparse image buffers ready to
 * download+flash in sequence. Returns a single-element array
 * containing the original bytes untouched if no splitting is needed.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {number} maxDownloadSize 0/undefined means "no limit reported".
 * @param {number} [blockSize]
 */
export function prepareForFlashing(buffer, maxDownloadSize, blockSize = DEFAULT_BLOCK_SIZE) {
  const bytes = toUint8Array(buffer);

  if (!maxDownloadSize || bytes.byteLength <= maxDownloadSize) {
    return [bytes];
  }

  const image = isSparse(bytes) ? parseSparse(bytes) : rawToChunks(bytes, blockSize);
  return resparse(image, maxDownloadSize);
}

// --- internal helpers -----------------------------------------------------

function toUint8Array(buffer) {
  if (buffer instanceof Uint8Array) return buffer;
  return new Uint8Array(buffer);
}

function toDataView(buffer) {
  if (buffer instanceof Uint8Array) {
    return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  return new DataView(buffer);
}

function isAllZero(bytes) {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}
