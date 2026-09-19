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

import { COMMAND_NAMES } from './constants.js';

export const PACKET_HEADER_SIZE = 24;

const EMPTY = new Uint8Array(0);

/**
 * The 24-byte amessage header: six little-endian 32-bit words.
 *   command, arg0, arg1, data_length, data_check, magic
 */
export function encodeHeader({ command, arg0 = 0, arg1 = 0, payload = EMPTY, checksum = 0 }) {
  const header = new Uint8Array(PACKET_HEADER_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, command, true);
  view.setUint32(4, arg0 >>> 0, true);
  view.setUint32(8, arg1 >>> 0, true);
  view.setUint32(12, payload.length, true);
  view.setUint32(16, checksum >>> 0, true);
  view.setUint32(20, (command ^ 0xffffffff) >>> 0, true);
  return header;
}

export function decodeHeader(bytes) {
  if (bytes.length !== PACKET_HEADER_SIZE) {
    throw new AdbProtocolError(`short header: ${bytes.length} bytes`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const command = view.getUint32(0, true);
  const magic = view.getUint32(20, true);
  if (magic !== ((command ^ 0xffffffff) >>> 0)) {
    throw new AdbProtocolError(
      `invalid magic: command=0x${command.toString(16)} magic=0x${magic.toString(16)}`);
  }
  return {
    command,
    arg0: view.getUint32(4, true),
    arg1: view.getUint32(8, true),
    dataLength: view.getUint32(12, true),
    checksum: view.getUint32(16, true),
  };
}

/** Sum of payload bytes, mod 2^32. Only sent to pre-2017 devices. */
export function calculateChecksum(payload) {
  let sum = 0;
  for (let i = 0; i < payload.length; i++) sum = (sum + payload[i]) >>> 0;
  return sum;
}

export function commandName(command) {
  return COMMAND_NAMES.get(command) ?? `0x${command.toString(16).padStart(8, '0')}`;
}

export class AdbProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdbProtocolError';
  }
}
