/*
 * Copyright (C) 2025 The Android Open Source Project
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
 */

// Ported from packages/modules/adb/adb.h

export const A_SYNC = 0x434e5953;
export const A_CNXN = 0x4e584e43;
export const A_OPEN = 0x4e45504f;
export const A_OKAY = 0x59414b4f;
export const A_CLSE = 0x45534c43;
export const A_WRTE = 0x45545257;
export const A_AUTH = 0x48545541;
export const A_STLS = 0x534c5453;

export const COMMAND_NAMES = new Map([
  [A_SYNC, 'SYNC'], [A_CNXN, 'CNXN'], [A_OPEN, 'OPEN'], [A_OKAY, 'OKAY'],
  [A_CLSE, 'CLSE'], [A_WRTE, 'WRTE'], [A_AUTH, 'AUTH'], [A_STLS, 'STLS'],
]);

// ADB protocol version.
//   0x01000000: original
//   0x01000001: skip checksum (Dec 2017)
export const A_VERSION_MIN = 0x01000000;
export const A_VERSION_SKIP_CHECKSUM = 0x01000001;
export const A_VERSION = 0x01000001;

export const MAX_PAYLOAD_V1 = 4 * 1024;
export const MAX_PAYLOAD = 1024 * 1024;

// Initial unacknowledged-byte budget granted to the peer when delayed ACK is
// negotiated. See docs/dev/delayed_ack.md.
export const INITIAL_DELAYED_ACK_BYTES = 32 * 1024 * 1024;

export const TOKEN_SIZE = 20;

export const ADB_AUTH_TOKEN = 1;
export const ADB_AUTH_SIGNATURE = 2;
export const ADB_AUTH_RSAPUBLICKEY = 3;

// USB interface descriptors advertised by adbd's functionfs gadget.
export const ADB_CLASS = 0xff;
export const ADB_SUBCLASS = 0x42;
export const ADB_PROTOCOL = 0x01;

// USB Debug Capability (DbC) uses the same wire protocol on a different
// class/subclass pair.
export const ADB_DBC_CLASS = 0xdc;
export const ADB_DBC_SUBCLASS = 0x02;

export function isAdbInterface(usbClass, usbSubclass, usbProtocol) {
  return usbProtocol === ADB_PROTOCOL &&
    ((usbClass === ADB_CLASS && usbSubclass === ADB_SUBCLASS) ||
     (usbClass === ADB_DBC_CLASS && usbSubclass === ADB_DBC_SUBCLASS));
}

// Feature strings, from transport.cpp.
export const FEATURE_SHELL_V2 = 'shell_v2';
export const FEATURE_CMD = 'cmd';
export const FEATURE_STAT_V2 = 'stat_v2';
export const FEATURE_LS_V2 = 'ls_v2';
export const FEATURE_FIXED_PUSH_MKDIR = 'fixed_push_mkdir';
export const FEATURE_APEX = 'apex';
export const FEATURE_ABB = 'abb';
export const FEATURE_ABB_EXEC = 'abb_exec';
export const FEATURE_FIXED_PUSH_SYMLINK_TIMESTAMP = 'fixed_push_symlink_timestamp';
export const FEATURE_SENDRECV_V2 = 'sendrecv_v2';
export const FEATURE_SENDRECV_V2_DRY_RUN_SEND = 'sendrecv_v2_dry_run_send';
export const FEATURE_DELAYED_ACK = 'delayed_ack';

// What this host implementation is prepared to speak. Do not advertise a
// feature the client does not actually implement: adbd will take us at our
// word and the connection will wedge.
export const HOST_FEATURES = [
  FEATURE_SHELL_V2,
  FEATURE_CMD,
  FEATURE_STAT_V2,
  FEATURE_LS_V2,
  FEATURE_FIXED_PUSH_MKDIR,
  FEATURE_APEX,
  FEATURE_ABB,
  FEATURE_ABB_EXEC,
  FEATURE_FIXED_PUSH_SYMLINK_TIMESTAMP,
  FEATURE_SENDRECV_V2,
  FEATURE_SENDRECV_V2_DRY_RUN_SEND,
  FEATURE_DELAYED_ACK,
];

// ---- sync protocol (file_sync_protocol.h) ----

const mkid = (s) =>
  s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) |
  ((s.charCodeAt(3) << 24) >>> 0);

export const SYNC = {
  LSTAT_V1: mkid('STAT'),
  STAT_V2: mkid('STA2'),
  LSTAT_V2: mkid('LST2'),
  LIST_V1: mkid('LIST'),
  LIST_V2: mkid('LIS2'),
  DENT_V1: mkid('DENT'),
  DENT_V2: mkid('DNT2'),
  SEND_V1: mkid('SEND'),
  SEND_V2: mkid('SND2'),
  RECV_V1: mkid('RECV'),
  RECV_V2: mkid('RCV2'),
  DONE: mkid('DONE'),
  DATA: mkid('DATA'),
  OKAY: mkid('OKAY'),
  FAIL: mkid('FAIL'),
  QUIT: mkid('QUIT'),
};

export const SYNC_DATA_MAX = 64 * 1024;

export const SyncFlag = {
  None: 0,
  Brotli: 1,
  LZ4: 2,
  Zstd: 4,
  DryRun: 0x80000000,
};

// ---- shell protocol (shell_protocol.h) ----

export const ShellId = {
  Stdin: 0,
  Stdout: 1,
  Stderr: 2,
  Exit: 3,
  CloseStdin: 4,
  WindowSizeChange: 5,
  Invalid: 255,
};
