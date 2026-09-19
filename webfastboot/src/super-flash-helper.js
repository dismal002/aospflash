/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * JavaScript port of AOSP fastboot's SuperFlashHelper
 * (system/core/fastboot/super_flash_helper.{h,cpp}), adapted to run on the
 * liblp WASM module (liblp-wasm-shim/wrapper/wasm_shim.cpp) instead of
 * linking liblp natively, and to read partition images from an in-memory
 * ImageSource (see flashall.js) instead of open file descriptors.
 *
 * Ported 1:1, method for method:
 *   SuperFlashHelper::Open          -> open()
 *   SuperFlashHelper::IncludeInSuper -> includeInSuper()
 *   SuperFlashHelper::AddPartition   -> addPartition()
 *   SuperFlashHelper::GetSparseLayout -> getSparseLayout()
 *   SuperFlashHelper::WillFlash       -> willFlash()
 *
 * Not ported (out of scope, same as flashall.js's other omissions):
 *   - Retrofit devices. Upstream's should_flash_in_userspace() has a
 *     slot-suffix-matching fallback for retrofit (pre-dynamic-partitions
 *     A/B) devices. liblp's own SuperLayoutBuilder::Open() already refuses
 *     to build a layout at all for retrofit metadata (any partition with
 *     LP_PARTITION_ATTR_SLOT_SUFFIXED), so open() below simply fails and
 *     the caller falls back to the unoptimized flow — matching what
 *     upstream effectively does too (CanOptimize's pattern match still
 *     runs, but SuperFlashHelper::Open's builder_.Open() call fails first).
 */

import { isSparse, ChunkType, buildSparse } from './sparse.js';

/** Matches android::fs_mgr::SuperImageExtent::Type's declaration order. */
export const ExtentType = Object.freeze({
  INVALID: 0,
  DATA: 1,
  PARTITION: 2,
  ZERO: 3,
  DONTCARE: 4,
});

/**
 * Emscripten's std::string <-> JS binding is *binary-safe but not
 * UTF-8*: each byte maps to exactly one UTF-16 code unit (0-255), not
 * through any text decoder. wasm_shim.cpp's serializeMetadata()/
 * getImageLayout() `data` fields and initialize()'s input parameter all
 * use this convention — these two helpers convert to/from it explicitly
 * so nothing ever routes through TextEncoder/TextDecoder (which would
 * corrupt bytes >= 0x80).
 */
function bytesToBinaryString(bytes) {
  // Building the string in large chunks avoids blowing the engine's
  // argument-count limit on String.fromCharCode(...bytes) for big buffers.
  const CHUNK = 0x8000;
  let result = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    result += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return result;
}

function binaryStringToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/**
 * @typedef {Object} SuperFlashSource
 * @property {(name: string) => Promise<Uint8Array|null>} getFile Same shape
 *   as flashall.js's ImageSource.
 */

export class SuperFlashHelper {
  /**
   * @param {SuperFlashSource} source
   * @param {any} liblpModule An instantiated module from liblp.js, i.e. the
   *   result of `await LiblpModule()` (see wasm_project/build.sh's output).
   */
  constructor(source, liblpModule) {
    this._source = source;
    this._mod = liblpModule;
    this._builder = new liblpModule.MetadataBuilder();
    this._opened = false;
    this._imageBytes = new Map(); // imageName -> Uint8Array, kept alive for getSparseLayout()
    this._willFlash = new Set();
    this._extentsCache = null;
  }

  /**
   * Parses super_empty.img. Returns false if the device isn't a candidate
   * for optimized super flashing at all (retrofit, malformed image, etc) —
   * matching SuperFlashHelper::Open's contract exactly: false here should
   * be treated as "silently fall back", not an error.
   * @param {Uint8Array} superEmptyImgBytes
   * @returns {boolean}
   */
  open(superEmptyImgBytes) {
    const binaryString = bytesToBinaryString(
      superEmptyImgBytes instanceof Uint8Array ? superEmptyImgBytes : new Uint8Array(superEmptyImgBytes),
    );
    this._opened = this._builder.initialize(binaryString);
    return this._opened;
  }

  /** Equivalent to SuperFlashHelper::IncludeInSuper. */
  includeInSuper(partition) {
    return this._opened && this._builder.hasPartition(partition);
  }

  /**
   * Equivalent to SuperFlashHelper::AddPartition. `imageName` is whatever
   * key your ImageSource resolves (e.g. "system.img"); its bytes are read
   * once and cached (kept alive) for getSparseLayout().
   * @param {string} partition Concrete partition name, slot suffix included
   *   (i.e. already resolved the way flashImageEntry() resolves it).
   * @param {string} imageName
   * @param {boolean} optional
   * @returns {Promise<boolean>} false means "give up on optimizing
   *   entirely", matching upstream (a hard failure partway through still
   *   means falling back to the unoptimized path for everything).
   */
  async addPartition(partition, imageName, optional) {
    if (!this.includeInSuper(partition)) return true;

    let bytes = this._imageBytes.get(imageName);
    if (bytes === undefined) {
      const fetched = await this._source.getFile(imageName);
      if (!fetched) {
        if (!optional) return false;
        return true;
      }
      if (isSparse(fetched)) {
        // Matches upstream: "cannot optimize dynamic partitions with sparse
        // images" — sparse inputs would need to be unsparsed first to slice
        // arbitrary byte ranges out of them, which upstream doesn't bother
        // with either.
        return false;
      }
      bytes = fetched;
      this._imageBytes.set(imageName, bytes);
    }

    if (!this._builder.addPartitionImage(partition, imageName, bytes.byteLength)) {
      return false;
    }
    this._willFlash.add(partition);
    return true;
  }

  /** Equivalent to SuperFlashHelper::WillFlash. */
  willFlash(partition) {
    return this._willFlash.has(partition);
  }

  /**
   * Equivalent to SuperFlashHelper::GetSparseLayout, but returns a plain
   * Android-sparse-image Uint8Array (via sparse.js#buildSparse) instead of
   * a libsparse handle, since that's what FastbootDriver#flashBlob()
   * consumes directly (flashBlob already resparses/splits it against the
   * device's max-download-size, same as upstream's own resparse_file()
   * call in OptimizedFlashSuperTask::Run — no separate splitting step
   * needed here).
   * @returns {Uint8Array|null} null means "could not build a layout";
   *   caller should fall back to the unoptimized flow.
   */
  getSparseLayout() {
    if (!this._extentsCache) {
      const extents = this._builder.getImageLayout();
      if (!extents || extents.length === 0) return null;
      this._extentsCache = extents;
    }
    const extents = this._extentsCache;

    const blockSize = this._builder.getLogicalBlockSize();
    if (!blockSize) return null;

    const last = extents[extents.length - 1];
    const flashedBytes = last.offset + last.size;
    const totalBlocks = Math.ceil(flashedBytes / blockSize);

    // buildSparse() has no per-chunk offset field — like the real Android
    // sparse format, each chunk is assumed to start exactly where the
    // previous one's blocks ended. liblp's GetImageLayout() already
    // guarantees this (it explicitly fills any gap with a DONTCARE extent
    // and sorts by offset — see AddGapExtents() in super_layout_builder.cpp),
    // so `cursor` below is a sanity check on that invariant, not new logic.
    let cursor = 0;
    const chunks = [];
    for (const extent of extents) {
      if (extent.offset % blockSize !== 0 || extent.size % blockSize !== 0) {
        // liblp aligns every extent it emits to the sparse/metadata
        // alignment it computed internally; if that ever doesn't hold,
        // something is wrong enough that a fresh block boundary can't be
        // assumed and we should bail rather than build a corrupt image.
        return null;
      }
      if (extent.offset / blockSize !== cursor) {
        return null; // non-contiguous layout — refuse rather than misalign the image
      }

      switch (extent.type) {
        case ExtentType.DONTCARE:
          chunks.push({ type: ChunkType.DONT_CARE, blocks: extent.size / blockSize });
          break;
        case ExtentType.ZERO:
          chunks.push({ type: ChunkType.FILL, blocks: extent.size / blockSize, fill: 0 });
          break;
        case ExtentType.DATA: {
          const data = binaryStringToBytes(extent.data || '');
          chunks.push({ type: ChunkType.RAW, blocks: extent.size / blockSize, data });
          break;
        }
        case ExtentType.PARTITION: {
          const source = this._imageBytes.get(extent.imageName);
          if (!source) return null; // shouldn't happen; addPartition() always caches first
          const data = source.subarray(extent.imageOffset, extent.imageOffset + extent.size);
          chunks.push({ type: ChunkType.RAW, blocks: extent.size / blockSize, data });
          break;
        }
        default:
          return null;
      }
      cursor += extent.size / blockSize;
    }

    return buildSparse({ blockSize, totalBlocks, chunks });
  }
}
