/*
 * Copyright (C) 2018 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * This file is a JavaScript port of system/core/fastboot/constants.h from
 * the Android Open Source Project. Values are transcribed verbatim; no
 * source code from that file is reused beyond the string/number literals
 * that make up the wire protocol itself.
 */

// Fastboot protocol commands (see README.md "Command Reference").
export const FB_CMD_GETVAR = 'getvar';
export const FB_CMD_DOWNLOAD = 'download';
export const FB_CMD_UPLOAD = 'upload';
export const FB_CMD_FLASH = 'flash';
export const FB_CMD_ERASE = 'erase';
export const FB_CMD_BOOT = 'boot';
export const FB_CMD_SET_ACTIVE = 'set_active';
export const FB_CMD_CONTINUE = 'continue';
export const FB_CMD_REBOOT = 'reboot';
export const FB_CMD_SHUTDOWN = 'shutdown';
export const FB_CMD_REBOOT_BOOTLOADER = 'reboot-bootloader';
export const FB_CMD_REBOOT_RECOVERY = 'reboot-recovery';
export const FB_CMD_REBOOT_FASTBOOT = 'reboot-fastboot';
export const FB_CMD_CREATE_PARTITION = 'create-logical-partition';
export const FB_CMD_DELETE_PARTITION = 'delete-logical-partition';
export const FB_CMD_RESIZE_PARTITION = 'resize-logical-partition';
export const FB_CMD_UPDATE_SUPER = 'update-super';
export const FB_CMD_OEM = 'oem';
export const FB_CMD_GSI = 'gsi';
export const FB_CMD_SNAPSHOT_UPDATE = 'snapshot-update';
export const FB_CMD_FETCH = 'fetch';

// Response prefixes (always exactly 4 bytes on the wire).
export const RESPONSE_OKAY = 'OKAY';
export const RESPONSE_FAIL = 'FAIL';
export const RESPONSE_DATA = 'DATA';
export const RESPONSE_INFO = 'INFO';
export const RESPONSE_TEXT = 'TEXT';

// Wire limits from the protocol spec.
export const FB_COMMAND_SZ = 4096;
export const FB_RESPONSE_SZ = 256;

// getvar variable names.
export const FB_VAR_VERSION = 'version';
export const FB_VAR_VERSION_BOOTLOADER = 'version-bootloader';
export const FB_VAR_VERSION_BASEBAND = 'version-baseband';
export const FB_VAR_VERSION_OS = 'version-os';
export const FB_VAR_VERSION_VNDK = 'version-vndk';
export const FB_VAR_PRODUCT = 'product';
export const FB_VAR_SERIALNO = 'serialno';
export const FB_VAR_SECURE = 'secure';
export const FB_VAR_UNLOCKED = 'unlocked';
export const FB_VAR_CURRENT_SLOT = 'current-slot';
export const FB_VAR_MAX_DOWNLOAD_SIZE = 'max-download-size';
export const FB_VAR_HAS_SLOT = 'has-slot';
export const FB_VAR_SLOT_COUNT = 'slot-count';
export const FB_VAR_PARTITION_SIZE = 'partition-size';
export const FB_VAR_PARTITION_TYPE = 'partition-type';
export const FB_VAR_SLOT_SUCCESSFUL = 'slot-successful';
export const FB_VAR_SLOT_UNBOOTABLE = 'slot-unbootable';
export const FB_VAR_IS_LOGICAL = 'is-logical';
export const FB_VAR_IS_USERSPACE = 'is-userspace';
export const FB_VAR_IS_FORCE_DEBUGGABLE = 'is-force-debuggable';
export const FB_VAR_HW_REVISION = 'hw-revision';
export const FB_VAR_VARIANT = 'variant';
export const FB_VAR_OFF_MODE_CHARGE_STATE = 'off-mode-charge';
export const FB_VAR_BATTERY_VOLTAGE = 'battery-voltage';
export const FB_VAR_BATTERY_SOC = 'battery-soc';
export const FB_VAR_BATTERY_SOC_OK = 'battery-soc-ok';
export const FB_VAR_SUPER_PARTITION_NAME = 'super-partition-name';
export const FB_VAR_SNAPSHOT_UPDATE_STATUS = 'snapshot-update-status';
export const FB_VAR_CPU_ABI = 'cpu-abi';
export const FB_VAR_SYSTEM_FINGERPRINT = 'system-fingerprint';
export const FB_VAR_VENDOR_FINGERPRINT = 'vendor-fingerprint';
export const FB_VAR_DYNAMIC_PARTITION = 'dynamic-partition';
export const FB_VAR_FIRST_API_LEVEL = 'first-api-level';
export const FB_VAR_SECURITY_PATCH_LEVEL = 'security-patch-level';
export const FB_VAR_TREBLE_ENABLED = 'treble-enabled';
export const FB_VAR_MAX_FETCH_SIZE = 'max-fetch-size';
export const FB_VAR_DMESG = 'dmesg';

// 32-bit unsigned max, matching FastBootDriver::MAX_DOWNLOAD_SIZE.
export const MAX_DOWNLOAD_SIZE = 0xffffffff;

// Matches FastBootDriver::RESP_TIMEOUT (seconds), used as the default
// per-status-packet timeout. INFO/TEXT packets reset this timer, same
// as the C++ driver, so long erase/flash operations don't spuriously
// time out as long as the bootloader keeps sending progress.
export const RESP_TIMEOUT_MS = 30000;

// Matches FastBootDriver::TRANSPORT_CHUNK_SIZE — the granularity the
// C++ driver coalesces sparse-file writes into before handing them to
// the transport. WebUSB bulk transfers have no such requirement, but
// we keep chunking uploads/downloads to this size (configurable) so
// progress callbacks fire at a reasonable cadence and so a single
// USB transfer request doesn't try to move an entire multi-GB image
// in one call.
export const DEFAULT_USB_CHUNK_SIZE = 16384;

export const RetCode = Object.freeze({
  SUCCESS: 'SUCCESS',
  BAD_ARG: 'BAD_ARG',
  IO_ERROR: 'IO_ERROR',
  BAD_DEV_RESP: 'BAD_DEV_RESP',
  DEVICE_FAIL: 'DEVICE_FAIL',
  TIMEOUT: 'TIMEOUT',
});
