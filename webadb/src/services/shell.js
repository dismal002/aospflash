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

import { FEATURE_SHELL_V2, ShellId } from '../constants.js';
import { StreamReader } from '../reader.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * shell_v2 framing, from shell_protocol.h: one id byte, a little-endian
 * uint32 length, then that many bytes.
 */
function frame(id, data) {
  const packet = new Uint8Array(5 + data.length);
  packet[0] = id;
  new DataView(packet.buffer).setUint32(1, data.length, true);
  packet.set(data, 5);
  return packet;
}

/**
 * A running subprocess over shell_v2: stdout and stderr stay separate and the
 * exit status comes back over the wire.
 */
export class AdbSubprocess {
  #stream;
  #reader;

  constructor(stream) {
    this.#stream = stream;
    this.#reader = new StreamReader(stream);
  }

  /** Yields { id, data } for each shell protocol packet. */
  async *packets() {
    for (;;) {
      const header = await this.#reader.readExactly(5);
      if (header === null) return;
      const id = header[0];
      const length = new DataView(header.buffer, header.byteOffset, 5).getUint32(1, true);
      const data = length > 0 ? await this.#reader.readExactly(length) : new Uint8Array(0);
      if (data === null) return;
      yield { id, data };
    }
  }

  write(data) {
    return this.#stream.write(frame(ShellId.Stdin, typeof data === 'string'
      ? encoder.encode(data) : data));
  }

  closeStdin() {
    return this.#stream.write(frame(ShellId.CloseStdin, new Uint8Array(0)));
  }

  /** ASCII "rows cols xpixels ypixels", matching struct winsize handling. */
  resize(rows, columns) {
    return this.#stream.write(
      frame(ShellId.WindowSizeChange, encoder.encode(`${rows}x${columns},0,0\0`)));
  }

  close() { return this.#stream.close(); }

  /** Run to completion and collect output. */
  async wait() {
    let stdout = '';
    let stderr = '';
    let exitCode = null;
    for await (const { id, data } of this.packets()) {
      if (id === ShellId.Stdout) stdout += decoder.decode(data, { stream: true });
      else if (id === ShellId.Stderr) stderr += decoder.decode(data, { stream: true });
      else if (id === ShellId.Exit) { exitCode = data[0]; break; }
    }
    await this.#stream.close();
    return { stdout, stderr, exitCode };
  }
}

function escapeArg(arg) {
  // Single-quote and escape embedded quotes, the same shape adb's
  // ShellServiceArg escaping produces.
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

export function buildCommand(command) {
  if (command === undefined || command === null) return '';
  if (Array.isArray(command)) return command.map(escapeArg).join(' ');
  return String(command);
}

/**
 * Spawn a command. With shell_v2 you get separated streams and an exit code;
 * on older devices the legacy "shell:" service merges stderr into stdout and
 * reports no status.
 */
export async function spawn(connection, command, { pty = false, terminalType } = {}) {
  const argument = buildCommand(command);
  if (connection.supportsFeature(FEATURE_SHELL_V2)) {
    const mode = pty ? 'pty' : 'raw';
    const prefix = terminalType ? `TERM=${terminalType} ` : '';
    const stream = await connection.open(`shell,v2,${mode}:${prefix}${argument}`);
    return new AdbSubprocess(stream);
  }
  const stream = await connection.open(`shell:${argument}`);
  return new LegacySubprocess(stream);
}

/** Pre-shell_v2 fallback: a single undifferentiated output stream. */
export class LegacySubprocess {
  #stream;
  constructor(stream) { this.#stream = stream; }

  async *packets() {
    for await (const data of this.#stream) yield { id: ShellId.Stdout, data };
  }

  write(data) {
    return this.#stream.write(typeof data === 'string' ? encoder.encode(data) : data);
  }

  closeStdin() { return Promise.resolve(); }
  resize() { return Promise.resolve(); }
  close() { return this.#stream.close(); }

  async wait() {
    const stdout = decoder.decode(await this.#stream.readAll());
    await this.#stream.close();
    return { stdout, stderr: '', exitCode: null };
  }
}
