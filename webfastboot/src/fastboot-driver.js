/*
 * Copyright (C) 2018 The Android Open Source Project
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met: [see LICENSE / original fastboot_driver.cpp header]
 *
 * This file is a JavaScript port of the public command surface of
 * system/core/fastboot/fastboot_driver.{h,cpp} (FastBootDriver) from
 * the Android Open Source Project, adapted to run over a WebUsbTransport
 * instead of AOSP's native Transport. Command names/wire format come
 * from constants.h and the fastboot protocol spec (README.md), both of
 * which are part of this same AOSP source tree.
 *
 * Differences from the C++ driver, all a consequence of running in a
 * browser instead of a native process:
 *  - Everything is async/Promise-based instead of blocking calls.
 *  - Buffers are ArrayBuffer/Uint8Array instead of fds/mmap.
 *  - Sparse-file splitting lives in sparse.js and is handled by the
 *    caller (or FastbootDriver#flashBlob, a convenience method not
 *    present in the C++ driver) rather than by libsparse.
 */

import * as C from './constants.js';
import { DeviceFailError, ProtocolError, TimeoutError, UsbError } from './errors.js';
import { prepareForFlashing } from './sparse.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * @typedef {Object} DriverCallbacks
 * @property {(message: string) => void} [prolog] Called before a command starts.
 * @property {(error: Error|null) => void} [epilog] Called after a command finishes.
 * @property {(message: string) => void} [info] Called for each INFO packet.
 * @property {(message: string) => void} [text] Called for each TEXT packet.
 */

/**
 * JavaScript port of AOSP's fastboot::FastBootDriver. Talks the
 * fastboot USB protocol over any transport exposing
 * `read(len)`, `writeChunked(data, chunkSize, onProgress)` and
 * `write(data)` — see usb-transport.js.
 */
export class FastbootDriver {
  static RESP_TIMEOUT_MS = C.RESP_TIMEOUT_MS;
  static MAX_DOWNLOAD_SIZE = C.MAX_DOWNLOAD_SIZE;

  /**
   * @param {import('./usb-transport.js').WebUsbTransport} transport
   * @param {DriverCallbacks} [callbacks]
   */
  constructor(transport, callbacks = {}) {
    this.transport = transport;
    this.prolog = callbacks.prolog ?? (() => {});
    this.epilog = callbacks.epilog ?? (() => {});
    this.infoCallback = callbacks.info ?? (() => {});
    this.textCallback = callbacks.text ?? (() => {});
    this.chunkSize = C.DEFAULT_USB_CHUNK_SIZE;
  }

  /**
   * Swaps in a new transport, e.g. after reconnecting post-reboot.
   * Equivalent to FastBootDriver::set_transport(). Doesn't close the
   * old transport — the caller (see rebootToUserspaceFastboot in
   * flashall.js) already has it and knows whether it's still open.
   * @param {import('./usb-transport.js').WebUsbTransport} transport
   */
  setTransport(transport) {
    this.transport = transport;
  }

  // ---- Simple one-line commands (RawCommand wrappers) --------------------

  async boot() {
    return this._rawCommand(C.FB_CMD_BOOT, 'Booting');
  }

  async continueBoot() {
    return this._rawCommand(C.FB_CMD_CONTINUE, 'Resuming boot');
  }

  async createPartition(partition, size) {
    return this._rawCommand(
      `${C.FB_CMD_CREATE_PARTITION}:${partition}:${size}`,
      `Creating '${partition}'`,
    );
  }

  async deletePartition(partition) {
    return this._rawCommand(
      `${C.FB_CMD_DELETE_PARTITION}:${partition}`,
      `Deleting '${partition}'`,
    );
  }

  async erase(partition) {
    return this._rawCommand(`${C.FB_CMD_ERASE}:${partition}`, `Erasing '${partition}'`);
  }

  async flash(partition) {
    return this._rawCommand(`${C.FB_CMD_FLASH}:${partition}`, `Writing '${partition}'`);
  }

  /** @returns {Promise<string>} The variable's value. */
  async getVar(key) {
    const result = await this._rawCommand(`${C.FB_CMD_GETVAR}:${key}`, null);
    return result.response;
  }

  /**
   * Fetches every variable via `getvar:all`. Returns the raw INFO lines
   * (each formatted by the bootloader as "key:value"); parsing is left
   * to the caller since the format isn't strictly specified beyond that.
   * @returns {Promise<string[]>}
   */
  async getVarAll() {
    const result = await this._rawCommand(`${C.FB_CMD_GETVAR}:all`, null);
    return result.info;
  }

  async reboot() {
    return this._rawCommand(C.FB_CMD_REBOOT, 'Rebooting');
  }

  /** @param {string} target e.g. "bootloader", "recovery", "fastboot" */
  async rebootTo(target) {
    return this._rawCommand(`reboot-${target}`, `Rebooting into ${target}`);
  }

  async resizePartition(partition, size) {
    return this._rawCommand(
      `${C.FB_CMD_RESIZE_PARTITION}:${partition}:${size}`,
      `Resizing '${partition}'`,
    );
  }

  async setActive(slot) {
    return this._rawCommand(
      `${C.FB_CMD_SET_ACTIVE}:${slot}`,
      `Setting current slot to '${slot}'`,
    );
  }

  async snapshotUpdate(command) {
    return this._rawCommand(`${C.FB_CMD_SNAPSHOT_UPDATE}:${command}`, `Snapshot ${command}`);
  }

  /**
   * Sends `update-super:<superName>[:wipe]`, merging a previously
   * downloaded super_empty.img into the device's real super partition.
   * Equivalent to AOSP's UpdateSuperTask::Run (task.cpp) — the caller
   * is responsible for downloading super_empty.img first (see
   * updateSuper() in flashall.js) and for being in userspace fastboot,
   * same as upstream.
   * @param {string} superName Usually 'super'; see FB_VAR_SUPER_PARTITION_NAME.
   * @param {boolean} [wantsWipe] Recreate all dynamic partitions instead of merging.
   */
  async updateSuper(superName, wantsWipe = false) {
    let command = `${C.FB_CMD_UPDATE_SUPER}:${superName}`;
    if (wantsWipe) command += ':wipe';
    return this._rawCommand(command, 'Updating super partition');
  }

  async oem(args) {
    return this._rawCommand(`${C.FB_CMD_OEM} ${args}`, `oem ${args}`);
  }

  /**
   * Sends a `flashing <subcommand>` command — this is how AOSP's CLI
   * implements `fastboot flashing unlock/lock/unlock_critical/
   * lock_critical/get_unlock_ability` (fastboot.cpp's "flashing"
   * handler): it's not a distinct protocol feature, just a raw command
   * string passed straight through via RawCommand, the same as `oem`.
   *
   * IMPORTANT caveats carried over from the underlying protocol, not
   * anything specific to this port:
   *  - `unlock`/`lock` typically require the user to physically confirm
   *    on the device's own screen (a volume-key prompt shown by the
   *    bootloader). The device will not send OKAY until that happens,
   *    so this call can hang for as long as the person takes to
   *    respond — there's no separate "waiting for confirmation" status,
   *    it's just a slow OKAY/FAIL.
   *  - A real unlock always wipes all user data on the device (this is
   *    enforced by the bootloader itself, not by this library).
   *  - Whether unlocking is permitted at all is carrier/OEM policy;
   *    `get_unlock_ability` reports it, but many devices return FAIL
   *    for `unlock` regardless (locked-down carrier bootloaders,
   *    already-unlocked devices treating it as a no-op, etc).
   *  - Subcommand spelling must match exactly: 'unlock', 'lock',
   *    'unlock_critical', 'lock_critical', 'get_unlock_ability'.
   *
   * @param {'unlock'|'lock'|'unlock_critical'|'lock_critical'|'get_unlock_ability'} subcommand
   */
  async flashingCommand(subcommand) {
    const allowed = ['unlock', 'lock', 'unlock_critical', 'lock_critical', 'get_unlock_ability'];
    if (!allowed.includes(subcommand)) {
      throw new ProtocolError(`Unknown 'flashing' subcommand: ${subcommand}`);
    }
    return this._rawCommand(`flashing ${subcommand}`, `flashing ${subcommand}`);
  }

  /** Convenience wrapper for `flashing unlock`. See flashingCommand() caveats. */
  async unlockBootloader() {
    return this.flashingCommand('unlock');
  }

  /** Convenience wrapper for `flashing lock`. */
  async lockBootloader() {
    return this.flashingCommand('lock');
  }

  /** Convenience wrapper for `flashing unlock_critical`. */
  async unlockCriticalBootloader() {
    return this.flashingCommand('unlock_critical');
  }

  /** Convenience wrapper for `flashing lock_critical`. */
  async lockCriticalBootloader() {
    return this.flashingCommand('lock_critical');
  }

  /**
   * Convenience wrapper for `flashing get_unlock_ability`. Returns the
   * raw response body; devices that implement this report "1" (allowed)
   * or "0" (not allowed) as the OKAY payload, but it's worth checking
   * the raw string since some bootloaders are inconsistent about it.
   */
  async getUnlockAbility() {
    const result = await this.flashingCommand('get_unlock_ability');
    return result.response;
  }

  // ---- Download / upload / fetch -----------------------------------------

  /**
   * Downloads a buffer to the device's staging area (the `download:`
   * command), for use by a subsequent flash/boot/etc. Equivalent to
   * FastBootDriver::Download(const std::vector<char>&, ...).
   *
   * @param {ArrayBuffer|Uint8Array} data
   * @param {(sent: number, total: number) => void} [onProgress]
   * @param {string} [label] Used only for the prolog message.
   */
  async download(data, onProgress, label) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.byteLength === 0 || bytes.byteLength > C.MAX_DOWNLOAD_SIZE) {
      throw new ProtocolError('Buffer is too large or 0 bytes');
    }

    const message = label
      ? `Sending '${label}' (${Math.floor(bytes.byteLength / 1024)} KB)`
      : `Sending ${Math.floor(bytes.byteLength / 1024)} KB`;
    this.prolog(message);
    let result;
    try {
      const cmd = `${C.FB_CMD_DOWNLOAD}:${bytes.byteLength.toString(16).padStart(8, '0')}`;
      await this._writeCommand(cmd);
      const dlResp = await this._handleResponse();
      if (dlResp.status !== C.RESPONSE_DATA) {
        throw new ProtocolError(`Device did not accept download (got ${dlResp.status})`);
      }

      await this.transport.writeChunked(bytes, this.chunkSize, onProgress);
      result = await this._handleResponse();
      if (result.status !== C.RESPONSE_OKAY) {
        throw new DeviceFailError(`download failed: ${result.response}`);
      }
    } catch (e) {
      this.epilog(e);
      throw e;
    }
    this.epilog(null);
    return result;
  }

  /**
   * Convenience helper with no direct C++ equivalent: downloads+flashes
   * a full (possibly multi-GB) blob to `partition`, automatically
   * splitting it into Android-sparse pieces if it's larger than the
   * device's reported max-download-size. This is the JS analogue of
   * what the fastboot CLI's flash logic (fastboot.cpp) does by calling
   * into libsparse before each Download()/Flash() pair.
   *
   * @param {string} partition
   * @param {ArrayBuffer|Uint8Array} data
   * @param {(sent: number, total: number) => void} [onProgress]
   */
  async flashBlob(partition, data, onProgress) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

    let maxDownloadSize = 0;
    try {
      const raw = (await this.getVar(C.FB_VAR_MAX_DOWNLOAD_SIZE)).trim();
      // Bootloaders report this as either a hex or decimal string depending
      // on vendor; try hex first (the common case) and fall back to decimal.
      maxDownloadSize = parseInt(raw, 16) || parseInt(raw, 10) || 0;
    } catch {
      // Some bootloaders don't report it; fall back to no splitting.
      maxDownloadSize = 0;
    }

    const pieces = prepareForFlashing(bytes, maxDownloadSize);
    let sentTotal = 0;
    for (const piece of pieces) {
      await this.download(
        piece,
        (sent) => {
          if (onProgress) onProgress(sentTotal + sent, bytes.byteLength);
        },
        partition,
      );
      sentTotal += piece.byteLength;
      await this.flash(partition);
    }
  }

  /**
   * Runs `download:` then `flash:partition` back to back, equivalent to
   * FastBootDriver::FlashPartition (the single-buffer overload). For
   * anything that might exceed the device's max-download-size, prefer
   * flashBlob() instead.
   */
  async flashPartition(partition, data) {
    await this.download(data, undefined, partition);
    return this.flash(partition);
  }

  /**
   * Implements the `upload`/`fetch` "device sends us data" pattern
   * (FastBootDriver::RunAndReadBuffer), used by both upload() and
   * fetch(). Reads exactly the number of bytes the device announced
   * via its DATA response, in chunks, then reads the final status.
   */
  async _runAndReadBuffer(cmd) {
    await this._writeCommand(cmd);
    const resp = await this._handleResponse();
    if (resp.status !== C.RESPONSE_DATA) {
      throw new ProtocolError(`${cmd} request failed: expected DATA, got ${resp.status}`);
    }
    const totalSize = parseInt(resp.response, 16);
    if (!(totalSize > 0)) {
      throw new ProtocolError(`${cmd} request failed, device reports ${totalSize} bytes available`);
    }

    const out = new Uint8Array(totalSize);
    let offset = 0;
    const bufSize = Math.min(totalSize, 1024 * 1024);
    while (offset < totalSize) {
      const remaining = totalSize - offset;
      const chunkSize = Math.min(bufSize, remaining);
      const chunk = await this.transport.read(chunkSize);
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const final = await this._handleResponse();
    if (final.status !== C.RESPONSE_OKAY) {
      throw new DeviceFailError(`${cmd} did not complete: ${final.response}`);
    }
    return out;
  }

  /**
   * Reads back whatever the last command staged for upload.
   * @returns {Promise<Uint8Array>}
   */
  async upload() {
    this.prolog('Uploading');
    try {
      const data = await this._runAndReadBuffer(C.FB_CMD_UPLOAD);
      this.epilog(null);
      return data;
    } catch (e) {
      this.epilog(e);
      throw e;
    }
  }

  /**
   * Reads a region of a partition back from the device (the `fetch`
   * command), for devices that support it.
   * @param {string} partition
   * @param {number} [offset]
   * @param {number} [size]
   * @returns {Promise<Uint8Array>}
   */
  async fetch(partition, offset, size) {
    let cmd = `${C.FB_CMD_FETCH}:${partition}`;
    if (offset !== undefined && offset >= 0) {
      cmd += `:0x${offset.toString(16).padStart(8, '0')}`;
      if (size !== undefined && size >= 0) {
        cmd += `:0x${size.toString(16).padStart(8, '0')}`;
      }
    }
    this.prolog(`Fetching ${partition}`);
    try {
      const data = await this._runAndReadBuffer(cmd);
      this.epilog(null);
      return data;
    } catch (e) {
      this.epilog(e);
      throw e;
    }
  }

  // ---- Low level -----------------------------------------------------------

  /**
   * Sends a raw command string and returns the final response.
   * Equivalent to FastBootDriver::RawCommand.
   * @param {string} cmd
   * @returns {Promise<{status: string, response: string, info: string[], dataSize?: number}>}
   */
  async rawCommand(cmd) {
    return this._rawCommand(cmd, null);
  }

  async _rawCommand(cmd, message) {
    if (message !== null && message !== undefined) this.prolog(message);
    if (textEncoder.encode(cmd).byteLength > C.FB_COMMAND_SZ) {
      const err = new ProtocolError('Command length is too long');
      if (message !== null) this.epilog(err);
      throw err;
    }
    try {
      await this._writeCommand(cmd);
      const result = await this._handleResponse();
      if (result.status === C.RESPONSE_FAIL) {
        throw new DeviceFailError(`remote: '${result.response}'`);
      }
      if (message !== null && message !== undefined) this.epilog(null);
      return result;
    } catch (e) {
      if (message !== null && message !== undefined) this.epilog(e);
      throw e;
    }
  }

  async _writeCommand(cmd) {
    await this.transport.write(textEncoder.encode(cmd));
  }

  /**
   * Reads and classifies one or more status packets until a terminal
   * OKAY/FAIL/DATA response, resetting the timeout on every INFO/TEXT
   * packet — this matches FastBootDriver::HandleResponse exactly,
   * including the timeout-reset-on-progress behavior that keeps slow
   * NAND erases from spuriously timing out.
   */
  async _handleResponse() {
    const info = [];
    const deadline = () => Date.now() + C.RESP_TIMEOUT_MS;
    let timeoutAt = deadline();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (Date.now() > timeoutAt) {
        throw new TimeoutError();
      }

      const raw = await this._readWithTimeout(timeoutAt);
      const text = textDecoder.decode(raw);
      const status = text.slice(0, 4);
      const body = text.slice(4);

      if (status === C.RESPONSE_INFO) {
        this.infoCallback(body);
        info.push(body);
        timeoutAt = deadline();
      } else if (status === C.RESPONSE_TEXT) {
        this.textCallback(body);
        timeoutAt = deadline();
      } else if (status === C.RESPONSE_OKAY) {
        return { status, response: body, info };
      } else if (status === C.RESPONSE_FAIL) {
        return { status, response: body, info };
      } else if (status === C.RESPONSE_DATA) {
        const dataSize = parseInt(body, 16);
        if (Number.isNaN(dataSize) || dataSize > C.MAX_DOWNLOAD_SIZE) {
          throw new ProtocolError(`Data size too large (${body})`);
        }
        return { status, response: body, info, dataSize };
      } else {
        throw new ProtocolError(`Device sent unknown status code: ${text}`);
      }
    }
  }

  async _readWithTimeout(timeoutAt) {
    const remaining = timeoutAt - Date.now();
    if (remaining <= 0) throw new TimeoutError();
    let timer;
    try {
      return await Promise.race([
        this.transport.read(C.FB_RESPONSE_SZ),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new TimeoutError()), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Equivalent to FastBootDriver::WaitForDisconnect(). */
  async waitForDisconnect() {
    try {
      await this.transport.waitForDisconnect();
    } catch (e) {
      throw new UsbError(e.message || String(e));
    }
  }
}
