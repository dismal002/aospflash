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

import { AdbConnection } from './connection.js';
import { AdbKeyStore } from './crypto/adb-key.js';
import { AdbSync } from './services/sync.js';
import { buildCommand, spawn } from './services/shell.js';
import { AdbWebUsbTransport, requestAdbDevice } from './transport/webusb.js';

const decoder = new TextDecoder();

export class Adb {
  constructor(connection) {
    this.connection = connection;
  }

  /**
   * Prompt for a device (or use one already authorized), open it, and run the
   * handshake.
   *
   * Must be called from a user gesture when `device` is omitted, because
   * navigator.usb.requestDevice() requires one.
   */
  static async connect({ device, key, keys } = {}) {
    const usbDevice = device ?? await requestAdbDevice();
    const transport = new AdbWebUsbTransport(usbDevice);
    await transport.open();
    // Default: every key in the user's key list (Settings > ADB Keys), in order.
    const keyList = keys ?? (key ? [key] : await new AdbKeyStore().loadOrCreate());
    const connection = new AdbConnection(transport, keyList);
    await connection.connect();
    return new Adb(connection);
  }

  get features() { return this.connection.features; }
  get product() { return this.connection.product; }
  get banner() { return this.connection.banner; }
  get serial() { return this.connection.transport.device.serialNumber ?? ''; }

  /** Spawn a command; returns an AdbSubprocess for incremental I/O. */
  spawn(command, options) { return spawn(this.connection, command, options); }

  /** Run a command to completion. */
  async exec(command, options) {
    const process = await this.spawn(command, options);
    return process.wait();
  }

  /** Run a command and return stdout, throwing on a non-zero exit. */
  async shell(command, options) {
    const { stdout, stderr, exitCode } = await this.exec(command, options);
    if (exitCode !== null && exitCode !== 0) {
      throw new Error(`command exited with ${exitCode}: ${stderr.trim() || stdout.trim()}`);
    }
    return stdout;
  }

  /** An interactive PTY session, for terminal front-ends. */
  interactiveShell(options = {}) {
    return this.spawn(undefined, { pty: true, terminalType: 'xterm-256color', ...options });
  }

  sync() { return AdbSync.open(this.connection); }

  async #withSync(operation) {
    const sync = await this.sync();
    try {
      return await operation(sync);
    } finally {
      await sync.close();
    }
  }

  stat(path, options) { return this.#withSync((sync) => sync.stat(path, options)); }
  list(path) { return this.#withSync((sync) => sync.list(path)); }
  push(path, content, options) {
    return this.#withSync((sync) => sync.push(path, content, options));
  }
  pull(path) { return this.#withSync((sync) => sync.pullToBytes(path)); }

  /** mode: '' (system), 'bootloader', 'recovery', 'sideload', 'fastboot'. */
  async reboot(mode = '') {
    const stream = await this.connection.open(`reboot:${mode}`);
    await stream.close();
  }

  /** Restart adbd as root. Returns adbd's status line. */
  root() { return this.#simpleService('root:'); }
  unroot() { return this.#simpleService('unroot:'); }

  /** Restart adbd listening on TCP, for switching to wireless debugging. */
  tcpip(port = 5555) { return this.#simpleService(`tcpip:${port}`); }

  /** Remount /system and friends read-write. */
  remount() { return this.#simpleService('remount:'); }

  async #simpleService(service) {
    const stream = await this.connection.open(service);
    const output = decoder.decode(await stream.readAll());
    await stream.close();
    return output.trim();
  }

  /**
   * "cmd"-backed services, e.g. abb_exec for package installs. Requires the
   * abb_exec feature; the argument separator is NUL, not a space.
   */
  async abbExec(args) {
    return this.connection.open(`abb_exec:${args.join('\0')}\0`);
  }

  /** Raw access for services this wrapper does not model. */
  open(service) { return this.connection.open(service); }

  close() { return this.connection.close(); }
}

export { buildCommand };
