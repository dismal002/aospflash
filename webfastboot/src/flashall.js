/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * JavaScript port of `fastboot flashall`, i.e. AOSP's FlashAllTool
 * (fastboot.cpp) and the tasks it drives (task.cpp), adapted to a
 * browser: image files come from an in-memory ImageSource instead of
 * $ANDROID_PRODUCT_OUT or an update zip opened on the host filesystem,
 * and the reboot-to-fastbootd step during super-partition flashing is
 * a WebUSB reconnect (see usb-transport.js#waitForReconnect) instead
 * of a blocking libusb re-enumeration wait.
 *
 * fastboot-info.txt (ParseFastbootInfo / CollectTasksFromFastbootInfo)
 * IS ported — see the "fastboot-info.txt parsing" and "fastboot-info.txt
 * execution" sections below. When the image source has one, its
 * `flash`/`reboot`/`erase`/`update-super`/`if-wipe`/`version` script
 * drives flashing instead of the hardcoded image list; pass
 * `disableFastbootInfo: true` to flashAll()/update() to force the
 * image-list path even so (matching the CLI's --disable-fastboot-info).
 *
 * OptimizedFlashSuperTask (task.cpp) / SuperFlashHelper (super_flash_helper.cpp)
 * IS ported — see super-flash-helper.js and flashSuperOptimized() below. It
 * parses super_empty.img's liblp metadata (via a WASM build of liblp — see
 * super-flash-helper.js's header) to repack every dynamic partition into one
 * pre-sized sparse super image in a single pass, instead of update-super
 * followed by flashing each dynamic partition individually and resizing it
 * to 0 (AddResizeTasks) once everything's flashed. Pass a `liblpModule`
 * option to flashAll()/update() to enable it; without one, or if it fails
 * for any reason (non-A/B device, retrofit metadata, a dynamic-partition
 * image that's already sparse, etc), this falls back to the unoptimized
 * update-super + per-partition + resize-to-0 sequence automatically, the
 * same as upstream falls back when CanOptimize's task-list pattern match
 * (fastboot-info.txt path, or a --slot all / --disable-super-optimization /
 * --exclude-dynamic-partitions run) doesn't apply. This port only attempts
 * optimization for the hardcoded IMAGES-list path below, not the
 * fastboot-info.txt path — see runFastbootInfoTasks.
 *
 * Intentionally NOT ported (out of scope for this port):
 *  - Per-image patching: repack_ramdisk (GKI ramdisk fixups),
 *    rewrite_vbmeta_buffer (--disable-verity/--disable-verification),
 *    and installing a detached .sig file before flashing a partition.
 *    A fastboot-info.txt `flash --apply-vbmeta` line is parsed (so
 *    the script doesn't fail to load) but, like every other flash in
 *    this file, applied as a plain, unpatched image write.
 */

import * as C from './constants.js';
import { ProtocolError } from './errors.js';
import { isSparse, parseSparse } from './sparse.js';
import { waitForReconnect } from './usb-transport.js';
import { SuperFlashHelper } from './super-flash-helper.js';

/**
 * Matches fastboot.cpp's `#define FASTBOOT_INFO_VERSION`: the highest
 * fastboot-info.txt schema version this port understands. A file
 * declaring a newer `version` than this is rejected, the same way a
 * too-new fastboot-info.txt rejects an old host `fastboot` binary
 * upstream.
 */
const FASTBOOT_INFO_VERSION = 1;

/** @typedef {'boot_critical'|'normal'|'extra'} ImageTypeValue */
export const ImageType = Object.freeze({
  BOOT_CRITICAL: 'boot_critical', // Must be flashed for the device to boot the kernel.
  NORMAL: 'normal', // Flashed during flashall, after boot-critical images.
  EXTRA: 'extra', // Never auto-flashed by flashall (kept only for documentation).
});

/**
 * Ported verbatim from the `images` table in fastboot.cpp. An empty
 * `nickname` marks a "secondary slot" entry (AOSP's Image::IsSecondary),
 * e.g. system_other.img — flashed to the *other* slot's partition of
 * the same name. Only BOOT_CRITICAL and NORMAL entries are used by
 * flashall; EXTRA ones (bootloader/radio/cache/userdata/super) are
 * listed for completeness but never auto-flashed, matching upstream.
 */
export const IMAGES = [
  { nickname: 'boot', imgName: 'boot.img', partName: 'boot', optional: false, type: ImageType.BOOT_CRITICAL },
  { nickname: 'bootloader', imgName: 'bootloader.img', partName: 'bootloader', optional: true, type: ImageType.BOOT_CRITICAL },
  { nickname: 'init_boot', imgName: 'init_boot.img', partName: 'init_boot', optional: true, type: ImageType.BOOT_CRITICAL },
  { nickname: '', imgName: 'boot_other.img', partName: 'boot', optional: true, type: ImageType.NORMAL },
  { nickname: 'cache', imgName: 'cache.img', partName: 'cache', optional: true, type: ImageType.EXTRA },
  { nickname: 'dtbo', imgName: 'dtbo.img', partName: 'dtbo', optional: true, type: ImageType.BOOT_CRITICAL },
  { nickname: 'dts', imgName: 'dt.img', partName: 'dts', optional: true, type: ImageType.BOOT_CRITICAL },
  { nickname: 'odm', imgName: 'odm.img', partName: 'odm', optional: true, type: ImageType.NORMAL },
  { nickname: 'odm_dlkm', imgName: 'odm_dlkm.img', partName: 'odm_dlkm', optional: true, type: ImageType.NORMAL },
  { nickname: 'product', imgName: 'product.img', partName: 'product', optional: true, type: ImageType.NORMAL },
  { nickname: 'pvmfw', imgName: 'pvmfw.img', partName: 'pvmfw', optional: true, type: ImageType.BOOT_CRITICAL },
  { nickname: 'radio', imgName: 'radio.img', partName: 'radio', optional: true, type: ImageType.BOOT_CRITICAL },
  { nickname: 'recovery', imgName: 'recovery.img', partName: 'recovery', optional: true, type: ImageType.BOOT_CRITICAL },
  { nickname: 'super', imgName: 'super.img', partName: 'super', optional: true, type: ImageType.EXTRA },
  { nickname: 'system', imgName: 'system.img', partName: 'system', optional: false, type: ImageType.NORMAL },
  { nickname: 'system_dlkm', imgName: 'system_dlkm.img', partName: 'system_dlkm', optional: true, type: ImageType.NORMAL },
  { nickname: 'system_ext', imgName: 'system_ext.img', partName: 'system_ext', optional: true, type: ImageType.NORMAL },
  { nickname: '', imgName: 'system_other.img', partName: 'system', optional: true, type: ImageType.NORMAL },
  { nickname: 'userdata', imgName: 'userdata.img', partName: 'userdata', optional: true, type: ImageType.EXTRA },
  { nickname: 'vbmeta', imgName: 'vbmeta.img', partName: 'vbmeta', optional: true, type: ImageType.BOOT_CRITICAL },
  { nickname: 'vbmeta_system', imgName: 'vbmeta_system.img', partName: 'vbmeta_system', optional: true, type: ImageType.BOOT_CRITICAL },
  { nickname: 'vbmeta_vendor', imgName: 'vbmeta_vendor.img', partName: 'vbmeta_vendor', optional: true, type: ImageType.BOOT_CRITICAL },
  { nickname: 'vendor', imgName: 'vendor.img', partName: 'vendor', optional: true, type: ImageType.NORMAL },
  { nickname: 'vendor_boot', imgName: 'vendor_boot.img', partName: 'vendor_boot', optional: true, type: ImageType.BOOT_CRITICAL },
  { nickname: 'vendor_dlkm', imgName: 'vendor_dlkm.img', partName: 'vendor_dlkm', optional: true, type: ImageType.NORMAL },
  { nickname: 'vendor_kernel_boot', imgName: 'vendor_kernel_boot.img', partName: 'vendor_kernel_boot', optional: true, type: ImageType.BOOT_CRITICAL },
  { nickname: '', imgName: 'vendor_other.img', partName: 'vendor', optional: true, type: ImageType.NORMAL },
];

// ---- Image sources ---------------------------------------------------

/**
 * Minimal interface flashAll() needs to read image files by name.
 * Implement whatever's convenient for your app (a parsed factory-image
 * zip via a library like JSZip, a directory picker, drag-and-drop of
 * loose .img files, ...) and adapt it to this shape, or use
 * FileMapImageSource below for the common case.
 * @typedef {Object} ImageSource
 * @property {(name: string) => Promise<Uint8Array|null>} getFile
 *   Resolves the named file's bytes, or null if it doesn't exist.
 */

/**
 * ImageSource backed by a `name -> File|Blob|ArrayBuffer|Uint8Array`
 * map, e.g. built from JSZip's `zip.files`, or from a `<input
 * webkitdirectory>`/drag-and-drop file list keyed by `file.name`.
 * @implements {ImageSource}
 */
export class FileMapImageSource {
  /** @param {Map<string, Blob|ArrayBuffer|Uint8Array>|Record<string, Blob|ArrayBuffer|Uint8Array>} files */
  constructor(files) {
    this._files = files instanceof Map ? files : new Map(Object.entries(files));
  }

  async getFile(name) {
    const entry = this._files.get(name);
    if (entry === undefined) return null;
    if (entry instanceof Uint8Array) return entry;
    if (entry instanceof ArrayBuffer) return new Uint8Array(entry);
    // Blob/File
    return new Uint8Array(await entry.arrayBuffer());
  }
}

// ---- android-info.txt requirement checking ----------------------------

const REQUIRE_REJECT_RE = /^(require\s+|reject\s+)?\s*(\S+)\s*=\s*(.*)$/;
const REQUIRE_PRODUCT_RE = /^require-for-product:\s*(\S+)\s+(\S+)\s*=\s*(.*)$/;

function parseRequirementLine(line) {
  let match = line.match(REQUIRE_PRODUCT_RE);
  if (match) {
    const [, product, rawName, rawOptions] = match;
    const name = rawName === 'board' ? 'product' : rawName;
    return { name, product, invert: false, options: splitOptions(rawOptions) };
  }
  match = line.match(REQUIRE_REJECT_RE);
  if (match) {
    const [, verb, rawName, rawOptions] = match;
    const name = rawName === 'board' ? 'product' : rawName;
    return { name, product: '', invert: verb?.trim() === 'reject', options: splitOptions(rawOptions) };
  }
  return null;
}

function splitOptions(raw) {
  return raw.split('|').map((s) => s.trim());
}

async function checkSingleRequirement(driver, curProduct, req, onStatus) {
  if (req.product && req.product !== curProduct) {
    // Requirement only applies to a different product; not an error here.
    return true;
  }
  let varValue;
  try {
    varValue = await driver.getVar(req.name);
  } catch (e) {
    onStatus?.(`Could not getvar for '${req.name}': ${e.message || e}`);
    return false;
  }
  let match = req.options.some(
    (opt) => opt === varValue || (opt.endsWith('*') && varValue.startsWith(opt.slice(0, -1))),
  );
  if (req.invert) match = !match;
  return match;
}

/**
 * Equivalent to CheckRequirements() in fastboot.cpp: parses
 * android-info.txt's `require`/`reject`/`require-for-product` lines
 * and `require partition-exists=<name>` entries, and checks each
 * against the device's getvar values.
 *
 * `partition-exists` entries mark the named IMAGES entry non-optional
 * (mutating a shallow copy of `images`, never the shared IMAGES table)
 * — see HandlePartitionExists in fastboot.cpp for why this exists.
 *
 * @param {import('./fastboot-driver.js').FastbootDriver} driver
 * @param {string} androidInfoText Contents of android-info.txt.
 * @param {{force?: boolean, onStatus?: (msg: string) => void, images?: typeof IMAGES}} [opts]
 * @returns {Promise<typeof IMAGES>} Possibly-adjusted image list (partition-exists applied).
 */
export async function checkRequirements(driver, androidInfoText, opts = {}) {
  const { force = false, onStatus } = opts;
  const images = (opts.images ?? IMAGES).map((img) => ({ ...img }));

  let curProduct = '';
  try {
    curProduct = await driver.getVar(C.FB_VAR_PRODUCT);
  } catch {
    onStatus?.('getvar:product FAILED');
  }

  for (const rawLine of androidInfoText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const req = parseRequirementLine(line);
    if (!req) {
      onStatus?.(`android-info.txt syntax error: ${line}`);
      continue;
    }
    if (req.name === 'partition-exists') {
      const partitionName = req.options[0];
      const hasSlot = await getVarSafe(driver, `has-slot:${partitionName}`);
      if (hasSlot !== 'yes' && hasSlot !== 'no') {
        if (!force) {
          onStatus?.(`Warning: device does not have partition '${partitionName}'; skipping partition-exists check`);
          continue;
        }
      }
      const known = images.filter((img) => img.nickname === partitionName);
      if (known.length === 0) {
        if (!force) {
          throw new ProtocolError(
            `device requires partition ${partitionName} which is not known to this version of flashall`,
          );
        }
        continue;
      }
      known.forEach((img) => (img.optional = false));
      continue;
    }
    const met = await checkSingleRequirement(driver, curProduct, req, onStatus);
    if (!met && !force) {
      throw new ProtocolError(`requirements not met! (${line})`);
    } else if (!met) {
      onStatus?.(`requirements not met for '${line}', proceeding due to force`);
    }
  }
  return images;
}

// ---- Slot helpers (do_for_partitions / get_current_slot / etc.) -------

async function getVarSafe(driver, name) {
  try {
    return (await driver.getVar(name)).trim();
  } catch {
    return null;
  }
}

async function getCurrentSlot(driver) {
  const raw = await getVarSafe(driver, C.FB_VAR_CURRENT_SLOT);
  if (!raw) return '';
  return raw[0] === '_' ? raw.slice(1) : raw;
}

async function getSlotCount(driver) {
  const raw = await getVarSafe(driver, C.FB_VAR_SLOT_COUNT);
  const count = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(count) ? count : 0;
}

async function supportsAB(driver) {
  return (await getSlotCount(driver)) >= 2;
}

function otherSlotLetter(currentSlot, count) {
  if (!count) return '';
  const next = ((currentSlot.charCodeAt(0) - 97 + 1) % count) + 97;
  return String.fromCharCode(next);
}

async function getOtherSlot(driver, currentSlot) {
  const count = await getSlotCount(driver);
  const slot = currentSlot || (await getCurrentSlot(driver));
  if (!slot) return '';
  return otherSlotLetter(slot, count);
}

/** Equivalent to do_for_partition (single-slot resolution). */
async function resolvePartitionName(driver, baseName, slot) {
  const tokens = baseName.split(':');
  let hasSlot = (await getVarSafe(driver, `has-slot:${tokens[0]}`)) === 'yes';
  if (!hasSlot && (await supportsAB(driver))) {
    let checkSlot = slot;
    if (!checkSlot || checkSlot === 'all') {
      checkSlot = await getCurrentSlot(driver);
    }
    if (checkSlot) {
      const slottedName = `${tokens[0]}_${checkSlot}`;
      const sizeStr = await getVarSafe(driver, `partition-size:${slottedName}`);
      if (sizeStr && sizeStr !== '0' && sizeStr !== '0x0') {
        hasSlot = true;
      }
    }
  }
  if (!hasSlot) return baseName;
  let useSlot = slot;
  if (!useSlot || useSlot === 'all') {
    useSlot = await getCurrentSlot(driver);
    if (!useSlot) throw new ProtocolError('Failed to identify current slot');
  }
  tokens[0] += `_${useSlot}`;
  return tokens.join(':');
}

/**
 * Equivalent to do_for_partitions: resolves a base partition name plus
 * a requested slot ("", a letter, or "all") into the concrete
 * partition name(s) to act on.
 */
async function resolvePartitionNames(driver, baseName, slot) {
  if (slot !== 'all') return [await resolvePartitionName(driver, baseName, slot)];
  const tokens = baseName.split(':');
  let hasSlot = (await getVarSafe(driver, `has-slot:${tokens[0]}`)) === 'yes';
  if (!hasSlot && (await supportsAB(driver))) {
    const cur = await getCurrentSlot(driver);
    if (cur) {
      const slottedName = `${tokens[0]}_${cur}`;
      const sizeStr = await getVarSafe(driver, `partition-size:${slottedName}`);
      if (sizeStr && sizeStr !== '0' && sizeStr !== '0x0') {
        hasSlot = true;
      }
    }
  }
  if (!hasSlot) return [baseName];
  const count = await getSlotCount(driver);
  const names = [];
  for (let i = 0; i < count; i++) {
    names.push(await resolvePartitionName(driver, baseName, String.fromCharCode(97 + i)));
  }
  return names;
}

async function isLogicalPartition(driver, partition) {
  return (await getVarSafe(driver, `${C.FB_VAR_IS_LOGICAL}:${partition}`)) === 'yes';
}

/** Unsparsed size, matching AOSP's fastboot_buffer.image_size. */
async function logicalImageSize(bytes) {
  if (await isSparse(bytes)) {
    const headerBuf = bytes instanceof Blob ? await bytes.slice(0, 28).arrayBuffer() : bytes;
    const { blockSize, totalBlocks } = parseSparse(headerBuf);
    return blockSize * totalBlocks;
  }
  return bytes instanceof Blob ? bytes.size : bytes.byteLength;
}

// ---- Core flashing steps -----------------------------------------------

function isNoSuchPartitionError(err) {
  if (!err) return false;
  const msg = (err.message || String(err)).toLowerCase();
  return (
    msg.includes('no such file or directory') ||
    msg.includes('no such partition') ||
    msg.includes('partition does not exist') ||
    msg.includes('unknown partition') ||
    msg.includes('invalid partition') ||
    msg.includes('partition error') ||
    msg.includes('does not exist') ||
    msg.includes('not found')
  );
}

async function flashImageEntry(driver, source, entry, slot, ctx) {
  ctx.onStatus?.(`Unpacking '${entry.imgName}'…`);
  const bytes = await source.getFile(entry.imgName, (read, total) => {
    const pct = total ? Math.floor((read / total) * 100) : 0;
    ctx.onStatus?.(`Unpacking '${entry.imgName}': ${pct}%`);
  });
  if (!bytes) {
    if (entry.optional) return;
    throw new ProtocolError(`could not load '${entry.imgName}': not found in image source`);
  }
  const partitions = await resolvePartitionNames(driver, entry.partName, slot);
  for (const partition of partitions) {
    ctx.onStatus?.(`Flashing '${partition}'`);
    if (await isLogicalPartition(driver, partition)) {
      const imgSize = await logicalImageSize(bytes);
      await driver.resizePartition(partition, String(imgSize));
      ctx.dynamicPartitions.add(partition);
    }
    try {
      await driver.flashBlob(partition, bytes, (sent, total, label) => ctx.onProgress?.(label || partition, sent, total));
    } catch (err) {
      const isCore = entry.partName === 'boot' || entry.partName === 'system' || entry.partName === 'super';
      if ((entry.optional || !isCore) && isNoSuchPartitionError(err)) {
        console.warn(`[Fastboot] Optional/missing partition '${partition}' not present on device (${err.message}). Skipping.`);
        ctx.onStatus?.(`Skipping optional partition '${partition}' (not present on device)`);
        continue;
      }
      throw err;
    }
  }
}

async function flashImageList(driver, source, images, slot, ctx) {
  for (const entry of images) {
    await flashImageEntry(driver, source, entry, slot, ctx);
  }
}

/**
 * Equivalent to reboot_to_userspace_fastboot(): reboots into fastbootd
 * (the userspace fastboot HAL) if not already there, and swaps the
 * driver's transport once the device reconnects. No-op if the device
 * already reports is-userspace=yes.
 * @param {import('./fastboot-driver.js').FastbootDriver} driver
 * @param {{onStatus?: (msg: string) => void, onReboot?: () => void}} [opts]
 */
export async function rebootToUserspaceFastboot(driver, opts = {}) {
  if ((await getVarSafe(driver, C.FB_VAR_IS_USERSPACE)) === 'yes') return;
  const device = driver.transport.device;
  opts.onStatus?.('Rebooting into userspace fastboot (fastbootd)…');
  // Signal the caller BEFORE the reboot so it can suppress its USB disconnect
  // listener (app.js: isExpectingReboot = true) before the event fires.
  opts.onReboot?.();
  await driver.rebootTo('fastboot');
  await driver.waitForDisconnect();
  const newTransport = await waitForReconnect(device);
  driver.setTransport(newTransport);
  if ((await getVarSafe(driver, C.FB_VAR_IS_USERSPACE)) !== 'yes') {
    throw new ProtocolError(
      'Failed to boot into userspace fastboot; one or more components might be unbootable.',
    );
  }
}

async function cancelSnapshotIfNeeded(driver) {
  const status = await getVarSafe(driver, C.FB_VAR_SNAPSHOT_UPDATE_STATUS);
  const statusLower = (status || '').toLowerCase();
  if (status && statusLower !== 'none' && !statusLower.includes('unknown') && !statusLower.includes('fail')) {
    try {
      await driver.snapshotUpdate('cancel');
    } catch (e) {
      console.warn('snapshot-update cancel not supported or rejected:', e);
    }
  }
}

/**
 * Equivalent to UpdateSuperTask::Run: downloads super_empty.img (the
 * empty dynamic-partition layout produced by the build) and merges it
 * into the device's real super partition, rebooting to fastbootd first
 * if needed.
 */
async function updateSuper(driver, source, ctx, wantsWipe) {
  let emptySuper = await source.getFile('super_empty.img');
  if (!emptySuper) return false;
  if (emptySuper instanceof Blob) {
    emptySuper = new Uint8Array(await emptySuper.arrayBuffer());
  }

  await rebootToUserspaceFastboot(driver, ctx);

  const superName = (await getVarSafe(driver, C.FB_VAR_SUPER_PARTITION_NAME)) || 'super';
  ctx.onStatus?.(`Updating super partition '${superName}'`);
  await driver.download(emptySuper, undefined, 'super_empty.img');
  await driver.updateSuper(superName, wantsWipe);
  return true;
}

/**
 * Fallback equivalent to AddResizeTasks: resizes every dynamic
 * partition we flashed to 0 extents, so each gets a fresh, optimally
 * packed allocation instead of accumulating fragmentation across
 * repeated flashes. This is the path AOSP itself falls back to when it
 * can't build the single-pass optimized super image (see the
 * OptimizedFlashSuperTask note at the top of this file).
 */
async function resizeDynamicPartitionsToZero(driver, ctx) {
  for (const partition of ctx.dynamicPartitions) {
    ctx.onStatus?.(`Resizing '${partition}' to 0`);
    await driver.resizePartition(partition, '0');
  }
}

/**
 * Equivalent to OptimizedFlashSuperTask::Initialize + ::Run: attempts to
 * flash every dynamic partition in `images` plus super_empty.img as one
 * pre-sized sparse "super" image, instead of update-super followed by
 * flashing each dynamic partition individually. Matches upstream's
 * preconditions (supports_AB, not --slot all) and gives up cleanly —
 * returning null, same as upstream falling through to its normal
 * update-super/per-partition/resize-to-0 path — on anything upstream would
 * also refuse to optimize (no A/B, no super_empty.img, retrofit metadata, a
 * dynamic-partition image that's already sparse, couldn't determine the
 * super partition's name/size, or the device didn't accept the flash).
 *
 * @param {import('./fastboot-driver.js').FastbootDriver} driver
 * @param {ImageSource} source
 * @param {{onStatus?: Function, onProgress?: Function, dynamicPartitions: Set<string>}} ctx
 * @param {Array<{imgName: string, partName: string, optional: boolean}>} images
 *   Candidate images for the *current* flashing pass (i.e. already filtered
 *   to one slot's worth of boot-critical + normal images — this mirrors
 *   upstream scanning the task list for FlashTask entries, which by that
 *   point are likewise already resolved to one slot).
 * @param {string} slot Slot override/current slot these images are for.
 * @param {any} liblpModule An instantiated module from liblp.js.
 * @returns {Promise<Set<string>|null>} The set of concrete partition names
 *   that got flashed this way (to fold into ctx.dynamicPartitions and skip
 *   in the subsequent per-image pass), or null if optimization wasn't
 *   possible and the caller should fall back to the normal sequence.
 */
async function flashSuperOptimized(driver, source, ctx, images, slot, liblpModule) {
  if (!(await supportsAB(driver))) {
    return null; // Cannot optimize flashing super on a non-A/B device.
  }

  const superEmpty = await source.getFile('super_empty.img');
  if (!superEmpty) {
    return null; // Device doesn't use dynamic partitions at all.
  }
  const superEmptyBytes = superEmpty instanceof Blob ? new Uint8Array(await superEmpty.arrayBuffer()) : superEmpty;

  const superName = (await getVarSafe(driver, C.FB_VAR_SUPER_PARTITION_NAME)) || 'super';
  const partitionSizeStr = await getVarSafe(driver, `${C.FB_VAR_PARTITION_SIZE}:${superName}`);
  if (!partitionSizeStr) {
    return null; // Could not determine the super partition; can't optimize.
  }

  const helper = new SuperFlashHelper(source, liblpModule);
  if (!helper.open(superEmptyBytes)) {
    return null; // Not a candidate at all (e.g. retrofit metadata).
  }

  const resolved = [];
  for (const entry of images) {
    const [partition] = await resolvePartitionNames(driver, entry.partName, slot);
    resolved.push({ partition, imgName: entry.imgName, optional: entry.optional });
  }

  // Nothing to optimize if none of these images are actually dynamic
  // partitions — matches CanOptimize's pattern-match failing to find any
  // dynamic FlashTask following update-super in the task list.
  const anyDynamic = resolved.some(({ partition }) => helper.includeInSuper(partition));
  if (!anyDynamic) return null;

  for (const { partition, imgName, optional } of resolved) {
    if (!(await helper.addPartition(partition, imgName, optional))) {
      return null; // Matches upstream: any failure here abandons optimization entirely.
    }
  }

  const sparseImage = helper.getSparseLayout();
  if (!sparseImage) {
    return null;
  }

  await rebootToUserspaceFastboot(driver, ctx);
  ctx.onStatus?.(`Flashing optimized '${superName}'`);
  await driver.flashBlob(superName, sparseImage, (sent, total) =>
    ctx.onProgress?.(superName, sent, total),
  );

  const flashed = new Set();
  for (const { partition } of resolved) {
    if (helper.willFlash(partition)) flashed.add(partition);
  }
  return flashed;
}

/**
 * Equivalent to WipeTask::Run, minus the filesystem-image generation
 * step: AOSP's fb_perform_format() builds an empty ext4/f2fs image on
 * the host (via make_ext4fs-equivalent generators) sized to the
 * partition and flashes it, so the partition is immediately
 * mountable. Building a filesystem image from scratch is out of scope
 * for this port. We do what upstream itself falls back to when it has
 * no generator for a partition's filesystem type ("Erase successful,
 * but not automatically formatting") — a plain erase — since nearly
 * all modern Android devices reformat an erased/unformatted userdata
 * (and cache/metadata) on first boot.
 *
 * Shared by the `-w` partitions below and fastboot-info.txt's own
 * `erase <partition>` command — both ultimately construct a WipeTask
 * in fastboot.cpp.
 */
async function erasePartitionIfExists(driver, partition, ctx) {
  const type = await getVarSafe(driver, `partition-type:${partition}`);
  if (!type) return; // Matches WipeTask::Run's early return when the partition doesn't exist.
  ctx.onStatus?.(`Erasing '${partition}'`);
  try {
    await driver.erase(partition);
  } catch (e) {
    ctx.onStatus?.(`Failed to erase '${partition}': ${e.message || e}`);
  }
}

// Partitions AOSP's `-w` erases at the very end of a flashall/update
// run (WipeTask, one per name in fastboot.cpp's -w handling).
const WIPE_PARTITIONS = ['userdata', 'cache', 'metadata'];

async function wipeDataPartitions(driver, ctx) {
  for (const partition of WIPE_PARTITIONS) {
    await erasePartitionIfExists(driver, partition, ctx);
  }
}

// ---- fastboot-info.txt parsing (ParseFastbootInfo) ---------------------
//
// fastboot-info.txt is a plain-text script some devices ship in their
// target-files/factory packages, replacing the hardcoded IMAGES table
// above with an explicit, ordered list of instructions. This is a
// straight port of ParseFastbootInfo/ParseFastbootInfoLine and the
// per-command Parse*Command functions in fastboot.cpp: same
// tokenizing (split on whitespace; blank lines and `#`-prefixed
// comment lines ignored), the same five commands (`version`, `flash`,
// `reboot`, `erase`, `update-super`), and the same `if-wipe` line
// prefix.
//
// One deliberate deviation from upstream: a malformed line here
// throws a ProtocolError instead of upstream's LOG(ERROR) plus
// silently running zero tasks (ParseFastbootInfo returns an empty
// vector on any parse failure, and FlashAllTool::Flash then happily
// "flashes" nothing at all). Quietly no-op'ing a failed flash is a
// worse failure mode in a browser UI than in a terminal someone is
// watching scroll by, so we surface it instead.

function tokenizeInfoLine(line) {
  return line.split(/\s+/).filter((tok) => tok.length > 0);
}

function isIgnoredInfoLine(tokens) {
  return tokens.length === 0 || tokens[0][0] === '#';
}

/** Equivalent to CheckFastbootInfoRequirements(). */
function checkFastbootInfoVersion(tokens) {
  if (tokens.length !== 2 || tokens[0] !== 'version') {
    throw new ProtocolError(
      `unknown characters in version info in fastboot-info.txt -> ${tokens.join(' ')}`,
    );
  }
  if (!/^\d+$/.test(tokens[1])) {
    throw new ProtocolError(
      `version number contains non-numeric characters in fastboot-info.txt -> ${tokens.join(' ')}`,
    );
  }
  if (Number(tokens[1]) > FASTBOOT_INFO_VERSION) {
    throw new ProtocolError(
      `fastboot-info.txt version: ${tokens[1]} not compatible with host tool version --> ${FASTBOOT_INFO_VERSION}`,
    );
  }
}

/** Equivalent to ParseFlashCommand(). */
function parseFlashInfoCommand(parts) {
  let applyVbmeta = false;
  let slotOther = false;
  let partition = '';
  let imgName = '';
  for (const part of parts) {
    if (part === '--apply-vbmeta') {
      applyVbmeta = true;
    } else if (part === '--slot-other') {
      slotOther = true;
    } else if (!partition) {
      partition = part;
    } else if (!imgName) {
      imgName = part;
    } else {
      throw new ProtocolError(
        `unknown argument ${part} in fastboot-info.txt. parts: ${parts.join(' ')}`,
      );
    }
  }
  if (!partition) {
    throw new ProtocolError(
      `partition name not found when parsing fastboot-info.txt. parts: ${parts.join(' ')}`,
    );
  }
  if (!imgName) imgName = `${partition}.img`;
  return { type: 'flash', partition, imgName, applyVbmeta, slotOther };
}

/** Equivalent to ParseRebootCommand(). */
function parseRebootInfoCommand(parts) {
  if (parts.length === 0) return { type: 'reboot', target: '' };
  if (parts.length > 1) {
    throw new ProtocolError(
      `unknown arguments in reboot {target} in fastboot-info.txt: ${parts.join(' ')}`,
    );
  }
  return { type: 'reboot', target: parts[0] };
}

/** Equivalent to ParseWipeCommand(). */
function parseWipeInfoCommand(parts) {
  if (parts.length !== 1) {
    throw new ProtocolError(
      `unknown arguments in erase {partition} in fastboot-info.txt: ${parts.join(' ')}`,
    );
  }
  return { type: 'erase', partition: parts[0] };
}

/** Equivalent to ParseFastbootInfoLine(). */
function parseFastbootInfoLine(tokens) {
  const [cmd, ...rest] = tokens;
  if (cmd === 'flash') return parseFlashInfoCommand(rest);
  if (cmd === 'reboot') return parseRebootInfoCommand(rest);
  if (cmd === 'update-super' && tokens.length === 1) return { type: 'update-super' };
  if (cmd === 'erase' && tokens.length === 2) return parseWipeInfoCommand(rest);
  throw new ProtocolError(`unknown command parsing fastboot-info.txt line: ${tokens.join(' ')}`);
}

/**
 * Equivalent to ParseFastbootInfo(): turns fastboot-info.txt's text
 * into an ordered list of task descriptors for runFastbootInfoTasks().
 * Does NOT append the AddResizeTasks/OptimizedFlashSuperTask fallback
 * itself — same as the hardcoded image-list path, that's applied by
 * the caller once every parsed task has actually run (see
 * runFastbootInfoTasks below and resizeDynamicPartitionsToZero above).
 *
 * @param {string} text Contents of fastboot-info.txt.
 * @param {{wantsWipe?: boolean}} [opts] `wantsWipe` gates `if-wipe` lines,
 *   matching FlashingPlan::wants_wipe.
 * @returns {Array<Object>} Task descriptors, e.g.
 *   `{type:'flash', partition, imgName, applyVbmeta, slotOther}`,
 *   `{type:'reboot', target}`, `{type:'erase', partition}`,
 *   `{type:'update-super'}`.
 */
export function parseFastbootInfo(text, opts = {}) {
  const { wantsWipe = false } = opts;
  const tasks = [];
  for (const rawLine of text.split('\n')) {
    const tokens = tokenizeInfoLine(rawLine.trim());
    if (isIgnoredInfoLine(tokens)) continue;
    if (tokens.length > 1 && tokens[0] === 'version') {
      checkFastbootInfoVersion(tokens);
      continue;
    }
    let effectiveTokens = tokens;
    if (tokens.length >= 2 && tokens[0] === 'if-wipe') {
      if (!wantsWipe) continue;
      effectiveTokens = tokens.slice(1);
    }
    tasks.push(parseFastbootInfoLine(effectiveTokens));
  }
  return tasks;
}

// ---- fastboot-info.txt execution (CollectTasksFromFastbootInfo) --------

/**
 * Runs one `{type:'flash', ...}` descriptor from parseFastbootInfo().
 * Reuses flashImageEntry() for partition/slot resolution and the
 * logical-partition resize-then-flash sequence, exactly like the
 * hardcoded image list. `slotOther` (the line's `--slot-other` flag)
 * picks the secondary slot instead of the ambient one, matching
 * ParseFlashCommand.
 */
async function runFlashInfoTask(driver, source, task, ctx, slots) {
  const slot = task.slotOther ? slots.secondarySlot : slots.primarySlot;
  const isCore = task.partition === 'boot' || task.partition === 'system' || task.partition === 'super';
  await flashImageEntry(
    driver,
    source,
    { imgName: task.imgName, partName: task.partition, optional: !isCore },
    slot,
    ctx,
  );
}

/**
 * Runs one `{type:'reboot', target}` descriptor. Equivalent to
 * RebootTask::Run(). One deviation from upstream: for target
 * `'fastboot'`, RebootTask::Run() calls fb->WaitForDisconnect() a
 * second time right after reboot_to_userspace_fastboot() returns —
 * but that helper (rebootToUserspaceFastboot() here) already waits
 * for disconnect, reopens the transport, and confirms userspace
 * fastboot itself, so a further wait has nothing left to wait for in
 * a WebUSB reconnect flow and is omitted.
 */
async function runRebootInfoTask(driver, task, ctx) {
  const { target } = task;
  if (target === 'fastboot') {
    await rebootToUserspaceFastboot(driver, ctx);
  } else if (target === 'recovery' || target === 'bootloader') {
    await driver.rebootTo(target);
    await driver.waitForDisconnect();
  } else if (target === '') {
    await driver.reboot();
    await driver.waitForDisconnect();
  } else {
    throw new ProtocolError(`unknown reboot target ${target}`);
  }
}

/**
 * Runs the task list parseFastbootInfo() produced, in order — matching
 * CollectTasksFromFastbootInfo plus the task-running loop in
 * FlashAllTool::Flash. Once every task has run, applies the same
 * AddResizeTasks fallback the hardcoded image-list path uses (see the
 * OptimizedFlashSuperTask note at the top of this file) if an
 * `update-super` line ran and flashing landed on any dynamic
 * partitions.
 *
 * @param {import('./fastboot-driver.js').FastbootDriver} driver
 * @param {ImageSource} source
 * @param {Array<Object>} tasks From parseFastbootInfo().
 * @param {{onStatus?: Function, onProgress?: Function, dynamicPartitions: Set<string>}} ctx
 * @param {{primarySlot: string, secondarySlot: string}} slots
 * @param {boolean} wantsWipe Passed through to `update-super` lines.
 */
async function runFastbootInfoTasks(driver, source, tasks, ctx, slots, wantsWipe) {
  let ranUpdateSuper = false;
  for (const task of tasks) {
    switch (task.type) {
      case 'flash':
        await runFlashInfoTask(driver, source, task, ctx, slots);
        break;
      case 'reboot':
        await runRebootInfoTask(driver, task, ctx);
        break;
      case 'update-super':
        if (await updateSuper(driver, source, ctx, wantsWipe)) ranUpdateSuper = true;
        break;
      case 'erase':
        await erasePartitionIfExists(driver, task.partition, ctx);
        break;
      default:
        throw new ProtocolError(`unknown fastboot-info.txt task type: ${task.type}`);
    }
  }
  if (ranUpdateSuper && ctx.dynamicPartitions.size > 0) {
    await resizeDynamicPartitionsToZero(driver, ctx);
  }
}

// ---- Public entry point --------------------------------------------------

async function decodeText(bytesOrBlob) {
  if (!bytesOrBlob) return '';
  if (bytesOrBlob instanceof Blob) {
    return await bytesOrBlob.text();
  }
  return new TextDecoder().decode(bytesOrBlob);
}

/**
 * Runs the full `fastboot flashall` flow against an already-connected
 * device: checks android-info.txt requirements, sets the active slot,
 * then flashes either via the image source's own fastboot-info.txt
 * script (if it has one) or the hardcoded IMAGES list, resets
 * dynamic-partition allocations, and optionally reboots. Matches
 * FlashAllTool::Flash/CollectTasks: both paths share the same
 * requirement check, slot handling, and snapshot cancellation; only
 * how images get flashed differs.
 *
 * @param {import('./fastboot-driver.js').FastbootDriver} driver
 * @param {ImageSource} source
 * @param {Object} [options]
 * @param {string} [options.slot] '', a slot letter, or 'all'. Defaults to
 *   the device's current slot (matching bare `fastboot flashall`).
 * @param {boolean} [options.skipSecondary] Don't flash *_other.img secondary-slot images.
 * @param {boolean} [options.force] Proceed even if android-info.txt requirements aren't met.
 * @param {boolean} [options.wantsWipe] Pass `:wipe` to update-super (recreate all dynamic partitions).
 * @param {boolean} [options.disableFastbootInfo] Ignore fastboot-info.txt even if the image
 *   source has one, and always flash via the hardcoded IMAGES list instead. Matches the
 *   CLI's `--disable-fastboot-info`. Default false.
 * @param {boolean} [options.reboot] Reboot the device once flashing finishes. Default true.
 * @param {(message: string) => void} [options.onStatus]
 * @param {(partition: string, sent: number, total: number) => void} [options.onProgress]
 * @param {() => void} [options.onReboot] Called just before the device reboots to fastbootd
 *   so the caller can suppress its own USB disconnect listener.
 */
export async function flashAll(driver, source, options = {}) {
  const {
    slot: slotOverride = '',
    skipSecondary: skipSecondaryOpt = false,
    force = false,
    wantsWipe = false,
    disableFastbootInfo = false,
    // Matches the CLI's --disable-super-optimization / --exclude-dynamic-partitions.
    disableSuperOptimization = false,
    // An instantiated module from liblp.js (`await LiblpModule()`), i.e. the
    // WASM build in wasm_project/. Optional: without one, optimization is
    // silently skipped (same effect as disableSuperOptimization: true) and
    // flashing proceeds via the plain update-super + per-partition sequence.
    liblpModule = null,
    reboot = true,
    onStatus,
    onProgress,
    onReboot,
  } = options;

  const ctx = { onStatus, onProgress, onReboot, dynamicPartitions: new Set() };

  // 1. Check android-info.txt requirements (product/bootloader version/etc.).
  let images = IMAGES;
  const androidInfo = await source.getFile('android-info.txt');
  if (androidInfo) {
    images = await checkRequirements(driver, await decodeText(androidInfo), {
      force,
      onStatus,
    });
  } else {
    onStatus?.('No android-info.txt found; skipping requirement checks');
  }

  // 2. Set the active slot up front, so a reboot to fastbootd (below)
  //    boots into the right recovery/slot. Matches FlashAllTool::Flash.
  if (await supportsAB(driver)) {
    if (slotOverride === 'all') {
      await driver.setActive('a');
    } else if (slotOverride) {
      await driver.setActive(slotOverride);
    } else {
      const current = await getCurrentSlot(driver);
      if (current) await driver.setActive(current);
    }
  }

  // 3. Determine primary/secondary slots. Matches FlashAllTool::DetermineSlot.
  const currentSlot = slotOverride || (await getCurrentSlot(driver));
  let skipSecondary = skipSecondaryOpt;
  let secondarySlot = '';
  if (!skipSecondary) {
    secondarySlot =
      slotOverride && slotOverride !== 'all'
        ? await getOtherSlot(driver, slotOverride)
        : await getOtherSlot(driver, '');
    if (!secondarySlot) {
      if (await supportsAB(driver)) {
        onStatus?.('Warning: could not determine slot for secondary images; ignoring.');
      }
      skipSecondary = true;
    }
  }

  await cancelSnapshotIfNeeded(driver);

  // 4-7. Flash. Matches FlashAllTool::CollectTasks: prefer the image
  // source's own fastboot-info.txt script when it has one (and the
  // caller hasn't opted out), falling back to the hardcoded IMAGES
  // list otherwise.
  let usedFastbootInfo = false;
  if (!disableFastbootInfo) {
    const infoBytes = await source.getFile('fastboot-info.txt');
    if (infoBytes) {
      const infoTasks = parseFastbootInfo(await decodeText(infoBytes), { wantsWipe });
      await runFastbootInfoTasks(
        driver,
        source,
        infoTasks,
        ctx,
        { primarySlot: slotOverride, secondarySlot },
        wantsWipe,
      );
      usedFastbootInfo = true;
    } else {
      onStatus?.('No fastboot-info.txt found; flashing from hardcoded image list');
    }
  }

  if (!usedFastbootInfo) {
    // 4. Flash boot-critical images (both primary, and secondary if applicable).
    const bootCritical = images.filter((img) => img.type === ImageType.BOOT_CRITICAL);
    const normal = images.filter((img) => img.type === ImageType.NORMAL);
    const primaryNormal = normal.filter((img) => img.nickname !== '');
    const secondaryNormal = normal.filter((img) => img.nickname === '');

    await flashImageList(driver, source, bootCritical, slotOverride, ctx);

    // 5. Sync the super partition (may reboot to fastbootd) — via the
    //    single-pass optimized path if possible, otherwise the plain
    //    update-super + per-partition sequence. Matches
    //    OptimizedFlashSuperTask::Initialize's own preconditions (slot !=
    //    'all', A/B support, an actual dynamic-partition image present)
    //    before falling back.
    let updatedSuper = false;
    let optimizedPartitions = null;
    if (!disableSuperOptimization && liblpModule && slotOverride !== 'all') {
      optimizedPartitions = await flashSuperOptimized(
        driver,
        source,
        ctx,
        [...bootCritical, ...primaryNormal],
        slotOverride,
        liblpModule,
      );
    }

    if (optimizedPartitions) {
      for (const partition of optimizedPartitions) ctx.dynamicPartitions.add(partition);
      updatedSuper = true;
    } else {
      updatedSuper = await updateSuper(driver, source, ctx, wantsWipe);
      // 6. Flash the remaining OS images: primary slot only here — the
      //    optimized path above already covers this when it succeeds.
      await flashImageList(driver, source, primaryNormal, slotOverride, ctx);
    }

    // 6b. Secondary slot's *_other images, if any — never covered by the
    //     optimization above (see super-flash-helper.js's header note).
    if (!skipSecondary) {
      await flashImageList(driver, source, secondaryNormal, secondarySlot, ctx);
    }

    // 7. Dynamic partitions are already resized to their exact image sizes
    // during flashImageEntry(). Do NOT resize to 0 after flashing.
  }

  // 7.5. `-w`: erase userdata/cache/metadata. Runs after flashing,
  // matching AOSP's dispatcher order (wipe tasks run last, right
  // before the final reboot — see the note on WIPE_PARTITIONS above).
  if (wantsWipe) {
    await wipeDataPartitions(driver, ctx);
  }

  // 7.6. Set active slot at the end of all flashing and wiping (matches fastboot.cpp fp->wants_set_active).
  // This updates the Boot Control HAL metadata in NVRAM/GPT, marking the slot as active and bootable.
  if (await supportsAB(driver)) {
    const slotToActivate =
      slotOverride && slotOverride !== 'all' ? slotOverride : currentSlot || 'a';
    ctx.onStatus?.(`Setting active slot to '${slotToActivate}'`);
    try {
      await driver.setActive(slotToActivate);
    } catch (e) {
      ctx.onStatus?.(`Warning: failed to set active slot '${slotToActivate}': ${e.message || e}`);
    }
  }

  // 8. Reboot.
  if (reboot) {
    onStatus?.('Rebooting');
    await driver.reboot();
  }

  return { flashedDynamicPartitions: [...ctx.dynamicPartitions], usedSlot: currentSlot };
}

/**
 * Equivalent to `fastboot update <zip>`: opens a real .zip file (an
 * update.zip, a target-files-style zip, or the inner
 * image-<device>-<build>.zip from a factory bundle) and runs flashAll()
 * against it. AOSP's `update` and `flashall` commands both drive the
 * exact same FlashAllTool — the only difference at the command level is
 * where images come from (a zip vs $ANDROID_PRODUCT_OUT) — so this is a
 * thin wrapper, not a separate flashing engine.
 *
 * @param {import('./fastboot-driver.js').FastbootDriver} driver
 * @param {Blob|File|ArrayBuffer|Uint8Array} zipInput
 * @param {Parameters<typeof flashAll>[2]} [options] Same options as flashAll().
 */
export async function update(driver, zipInput, options = {}) {
  const { ZipImageSource } = await import('./zip.js');
  let source = await ZipImageSource.open(zipInput);

  // Factory image zips (e.g. volantis-mmb29v-factory-*.zip or Pixel factory zips)
  // contain an inner `image-<device>-<build>.zip` holding boot.img, system.img, etc.,
  // alongside outer scripts (flash-all.sh) and bootloader/radio images.
  // If an inner image zip exists, open it as the primary image source, falling back
  // to the root zip for files not found in the inner zip (such as bootloader images).
  const innerZipName = source.listFiles().find((name) => /(^|\/)image-.*\.zip$/i.test(name));
  let rootSource = source;
  if (innerZipName) {
    const innerBytes = await source.getFile(innerZipName);
    if (innerBytes) {
      const innerSource = await ZipImageSource.open(innerBytes);
      source = {
        async getFile(name) {
          const res = await innerSource.getFile(name);
          if (res !== null) return res;
          return rootSource.getFile(name);
        },
        listFiles() {
          return [...new Set([...innerSource.listFiles(), ...rootSource.listFiles()])];
        },
      };
    }
  }

  // Support bootloader-*.img and radio-*.img mapping in factory zips.
  const activeSource = source;
  source = {
    async getFile(name) {
      let res = await activeSource.getFile(name);
      if (res !== null) return res;
      if (name === 'bootloader.img') {
        const blName = rootSource.listFiles().find((n) => /(^|\/)bootloader-.*\.img$/i.test(n));
        if (blName) return rootSource.getFile(blName);
      }
      if (name === 'radio.img') {
        const radName = rootSource.listFiles().find((n) => /(^|\/)radio-.*\.img$/i.test(n));
        if (radName) return rootSource.getFile(radName);
      }
      return null;
    },
    listFiles() {
      return activeSource.listFiles();
    },
  };

  if (options.slot === 'all') {
    // Matches the CLI's warning for `fastboot update --slot all <zip>`.
    // Unlike `flashall --slot all` (which forces skipSecondary), `update`
    // only warns; DetermineSlot's own fallback still resolves a secondary
    // slot from the current slot, same as flashAll() already does.
    options.onStatus?.("Warning: slot set to 'all'. Secondary slots will not be flashed.");
  }
  return flashAll(driver, source, options);
}
