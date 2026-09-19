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

import {
  A_AUTH, A_CLSE, A_CNXN, A_OKAY, A_OPEN, A_STLS, A_VERSION, A_VERSION_MIN,
  A_VERSION_SKIP_CHECKSUM, A_WRTE, ADB_AUTH_RSAPUBLICKEY, ADB_AUTH_SIGNATURE, ADB_AUTH_TOKEN,
  FEATURE_DELAYED_ACK, HOST_FEATURES, INITIAL_DELAYED_ACK_BYTES, MAX_PAYLOAD, MAX_PAYLOAD_V1,
} from './constants.js';
import { commandName } from './packet.js';
import { AdbStream, AdbStreamClosedError } from './stream.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class AdbAuthenticationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdbAuthenticationError';
  }
}

export class AdbConnection extends EventTarget {
  #transport;
  #keys;
  #keyIndex = 0;
  #streams = new Map();
  #nextLocalId = 1;
  #protocolVersion = A_VERSION_MIN;
  #maxPayload = MAX_PAYLOAD_V1;
  #features = new Set();
  #readLoop = null;
  #connected = false;

  /**
   * @param transport AdbWebUsbTransport, already open()ed.
   * @param keys      One or more AdbKey instances, tried in order, exactly as
   *                  adb walks ADB_VENDOR_KEYS then ~/.android/adbkey.
   */
  constructor(transport, keys) {
    super();
    this.#transport = transport;
    this.#keys = Array.isArray(keys) ? keys : [keys];
    if (this.#keys.length === 0) throw new Error('at least one AdbKey is required');
  }

  get transport() { return this.#transport; }
  get maxPayload() { return this.#maxPayload; }
  get features() { return this.#features; }
  get banner() { return this.#banner; }
  get product() { return this.#product; }
  get deviceType() { return this.#deviceType; }
  get connected() { return this.#connected; }

  #banner = '';
  #product = {};
  #deviceType = '';
  #connectResolvers = null;

  supportsFeature(feature) { return this.#features.has(feature); }

  /**
   * Both ends must advertise delayed_ack before it may be used; adbd rejects
   * an A_OPEN whose arg1 disagrees with what it negotiated.
   */
  get supportsDelayedAck() {
    return HOST_FEATURES.includes(FEATURE_DELAYED_ACK) && this.#features.has(FEATURE_DELAYED_ACK);
  }

  get #useChecksum() { return this.#protocolVersion < A_VERSION_SKIP_CHECKSUM; }

  /** Perform the CNXN/AUTH handshake. Resolves when the device is online. */
  async connect() {
    if (this.#connected) return this;
    this.#connectResolvers = deferred();
    this.#readLoop = this.#runReadLoop();
    this.#readLoop.catch(() => {});
    await this.#sendConnect();
    return this.#connectResolvers.promise;
  }

  async #sendConnect() {
    // The host banner. adbd reads the features list out of it; the property
    // fields are only populated on the device side.
    const banner = `host::features=${HOST_FEATURES.join(',')}`;
    const payload = encoder.encode(banner);
    if (payload.length > MAX_PAYLOAD_V1) throw new Error('connection banner is too long');
    await this.#transport.writePacket({
      command: A_CNXN,
      arg0: A_VERSION,
      arg1: MAX_PAYLOAD,
      payload,
      useChecksum: this.#useChecksum,
    });
  }

  async #runReadLoop() {
    try {
      for (;;) {
        const packet = await this.#transport.readPacket();
        await this.#handlePacket(packet);
      }
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  #fail(error) {
    this.#connected = false;
    this.#connectResolvers?.reject(error);
    for (const stream of this.#streams.values()) stream._onClose(error);
    this.#streams.clear();
    this.dispatchEvent(new CustomEvent('disconnect', { detail: error }));
  }

  async #handlePacket(packet) {
    switch (packet.command) {
      case A_CNXN:
        return this.#handleConnect(packet);
      case A_AUTH:
        return this.#handleAuth(packet);
      case A_STLS:
        // adb over TLS is only reachable over TCP pairing, not over USB.
        throw new AdbAuthenticationError('device requested STLS, which is not supported over USB');
      case A_OKAY:
        return this.#handleOkay(packet);
      case A_WRTE:
        return this.#handleWrite(packet);
      case A_CLSE:
        return this.#handleClose(packet);
      default:
        // An unrecognised command means the streams have desynchronised.
        throw new Error(`unexpected packet ${commandName(packet.command)}`);
    }
  }

  #handleConnect(packet) {
    this.#protocolVersion = Math.min(packet.arg0, A_VERSION);
    this.#maxPayload = Math.min(packet.arg1 || MAX_PAYLOAD_V1, MAX_PAYLOAD);
    this.#banner = decoder.decode(packet.payload).replace(/\0+$/, '');
    const parsed = parseBanner(this.#banner);
    this.#deviceType = parsed.type;
    this.#product = parsed.properties;
    this.#features = parsed.features;
    this.#connected = true;
    this.#connectResolvers?.resolve(this);
    this.dispatchEvent(new CustomEvent('connect', { detail: this }));
  }

  async #handleAuth(packet) {
    if (packet.arg0 !== ADB_AUTH_TOKEN) {
      throw new AdbAuthenticationError(`unexpected AUTH type ${packet.arg0}`);
    }
    const key = this.#keys[this.#keyIndex++];
    if (key) {
      const signature = key.sign(packet.payload);
      await this.#transport.writePacket({
        command: A_AUTH,
        arg0: ADB_AUTH_SIGNATURE,
        payload: signature,
        useChecksum: this.#useChecksum,
      });
      return;
    }

    // Out of keys. Offer the public key and let the user accept it on the
    // device; adbd expects a NUL-terminated string here.
    const line = this.#keys[this.#keys.length - 1].encodePublicKeyLine();
    const payload = encoder.encode(line + '\0');
    await this.#transport.writePacket({
      command: A_AUTH,
      arg0: ADB_AUTH_RSAPUBLICKEY,
      payload,
      useChecksum: this.#useChecksum,
    });
    this.dispatchEvent(new CustomEvent('unauthorized', {
      detail: { message: 'Accept the RSA key fingerprint prompt on the device.' },
    }));
  }

  #handleOkay(packet) {
    if (packet.arg0 === 0 || packet.arg1 === 0) return;
    const stream = this.#streams.get(packet.arg1);
    if (!stream) {
      // The peer is acknowledging a socket we have already torn down.
      return this._sendClose(packet.arg1, packet.arg0).catch(() => {});
    }
    let ackedBytes = null;
    if (packet.payload.length === 4) {
      ackedBytes = new DataView(
        packet.payload.buffer, packet.payload.byteOffset, 4).getInt32(0, true);
    } else if (packet.payload.length !== 0) {
      throw new Error(`invalid A_OKAY payload size: ${packet.payload.length}`);
    }
    stream._onOkay(packet.arg0, ackedBytes);
  }

  #handleWrite(packet) {
    const stream = this.#streams.get(packet.arg1);
    if (!stream) return;
    stream._onWrite(packet.payload);
  }

  #handleClose(packet) {
    if (packet.arg1 === 0) return;
    const stream = this.#streams.get(packet.arg1);
    if (!stream) return;
    this.#streams.delete(packet.arg1);
    stream._onClose();
  }

  // ---- stream management ----

  /**
   * Open a service, e.g. "shell,v2,raw:ls -l", "sync:", "reboot:bootloader".
   * Resolves once the device has acknowledged with A_OKAY.
   */
  async open(service) {
    if (!this.#connected) throw new Error('not connected');
    const localId = this.#nextLocalId++;
    const delayedAck = this.supportsDelayedAck;
    const stream = new AdbStream(this, localId, service, { delayedAck });
    this.#streams.set(localId, stream);

    // adbd historically read the destination as a C string.
    const payload = encoder.encode(service + '\0');
    try {
      await this.#transport.writePacket({
        command: A_OPEN,
        arg0: localId,
        arg1: delayedAck ? INITIAL_DELAYED_ACK_BYTES : 0,
        payload,
        useChecksum: this.#useChecksum,
      });
      return await stream.ready;
    } catch (error) {
      this.#streams.delete(localId);
      throw error;
    }
  }

  _removeStream(localId) { this.#streams.delete(localId); }

  _sendWrite(stream, payload) {
    return this.#transport.writePacket({
      command: A_WRTE,
      arg0: stream.localId,
      arg1: stream.remoteId,
      payload,
      useChecksum: this.#useChecksum,
    });
  }

  _sendOkay(stream, ackedBytes) {
    let payload = new Uint8Array(0);
    if (ackedBytes !== null) {
      payload = new Uint8Array(4);
      new DataView(payload.buffer).setInt32(0, ackedBytes, true);
    }
    return this.#transport.writePacket({
      command: A_OKAY,
      arg0: stream.localId,
      arg1: stream.remoteId,
      payload,
      useChecksum: this.#useChecksum,
    });
  }

  _sendClose(localId, remoteId) {
    return this.#transport.writePacket({
      command: A_CLSE,
      arg0: localId,
      arg1: remoteId,
      useChecksum: this.#useChecksum,
    });
  }

  async close() {
    this.#connected = false;
    for (const stream of this.#streams.values()) stream._onClose(new AdbStreamClosedError());
    this.#streams.clear();
    await this.#transport.close();
  }
}

/** "device::ro.product.name=x;...;features=a,b,c" */
export function parseBanner(banner) {
  const pieces = banner.split(':');
  const type = pieces[0] ?? '';
  const properties = {};
  const features = new Set();
  if (pieces.length > 2) {
    for (const field of pieces.slice(2).join(':').split(';')) {
      const index = field.indexOf('=');
      if (index === -1) continue;
      const name = field.slice(0, index);
      const value = field.slice(index + 1);
      if (name === 'features') {
        for (const feature of value.split(',')) if (feature) features.add(feature);
      } else {
        properties[name] = value;
      }
    }
  }
  return { type, properties, features };
}

function deferred() {
  if (typeof Promise.withResolvers === 'function') return Promise.withResolvers();
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
