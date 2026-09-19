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
  ADB_CLASS, ADB_DBC_CLASS, ADB_DBC_SUBCLASS, ADB_PROTOCOL, ADB_SUBCLASS, isAdbInterface,
} from '../constants.js';
import { PACKET_HEADER_SIZE, decodeHeader, encodeHeader, calculateChecksum } from '../packet.js';

/** Filters for navigator.usb.requestDevice(). Matches any adb interface. */
export const ADB_DEVICE_FILTERS = [
  { classCode: ADB_CLASS, subclassCode: ADB_SUBCLASS, protocolCode: ADB_PROTOCOL },
  { classCode: ADB_DBC_CLASS, subclassCode: ADB_DBC_SUBCLASS, protocolCode: ADB_PROTOCOL },
];

export async function requestAdbDevice() {
  if (!navigator.usb) throw new Error('WebUSB is not available in this browser');
  return navigator.usb.requestDevice({ filters: ADB_DEVICE_FILTERS });
}

export async function getAuthorizedAdbDevices() {
  if (!navigator.usb) return [];
  const devices = await navigator.usb.getDevices();
  return devices.filter((device) => findAdbInterface(device) !== null);
}

function findAdbInterface(device) {
  for (const configuration of device.configurations) {
    for (const iface of configuration.interfaces) {
      for (const alternate of iface.alternates) {
        if (!isAdbInterface(alternate.interfaceClass, alternate.interfaceSubclass,
                            alternate.interfaceProtocol)) {
          continue;
        }
        const inEndpoint = alternate.endpoints.find(
          (e) => e.direction === 'in' && e.type === 'bulk');
        const outEndpoint = alternate.endpoints.find(
          (e) => e.direction === 'out' && e.type === 'bulk');
        if (!inEndpoint || !outEndpoint) continue;
        return {
          configurationValue: configuration.configurationValue,
          interfaceNumber: iface.interfaceNumber,
          alternateSetting: alternate.alternateSetting,
          inEndpoint,
          outEndpoint,
        };
      }
    }
  }
  return null;
}

/**
 * Packet-level transport over a WebUSB bulk pipe pair.
 *
 * Reads follow the aprotocol: request exactly 24 bytes for the header, read
 * data_length from it, then request exactly that many bytes. adbd sizes its
 * transfers to match, so the host never overflows an IRP.
 *
 * Writes need care in the other direction. adbd's functionfs reader always
 * posts a fixed 16 KiB request rather than following the protocol, so a
 * transfer whose length is an exact multiple of wMaxPacketSize leaves the
 * device waiting for a terminating short packet that never arrives. Chrome
 * does not append zero-length packets on our behalf, so this class does.
 * See docs/dev/zero_length_packet.md in the adb tree.
 */
export class AdbWebUsbTransport {
  #device;
  #iface = null;
  #writeLock = Promise.resolve();

  constructor(device) {
    this.#device = device;
  }

  get device() { return this.#device; }
  get connected() { return this.#device.opened && this.#iface !== null; }

  /** wMaxPacketSize of the OUT endpoint; decides when a ZLP is required. */
  get outPacketSize() { return this.#iface.outEndpoint.packetSize; }

  async open() {
    const iface = findAdbInterface(this.#device);
    if (!iface) throw new Error('device exposes no adb interface (ff/42/01)');

    if (!this.#device.opened) await this.#device.open();
    if (this.#device.configuration?.configurationValue !== iface.configurationValue) {
      await this.#device.selectConfiguration(iface.configurationValue);
    }
    await this.#device.claimInterface(iface.interfaceNumber);
    if (iface.alternateSetting !== 0) {
      await this.#device.selectAlternateInterface(iface.interfaceNumber, iface.alternateSetting);
    }
    this.#iface = iface;
  }

  async close() {
    const iface = this.#iface;
    this.#iface = null;
    if (!iface) return;
    try {
      await this.#device.releaseInterface(iface.interfaceNumber);
    } catch { /* the device may already be gone */ }
    try {
      await this.#device.close();
    } catch { /* ditto */ }
  }

  async #transferIn(length) {
    const result = await this.#device.transferIn(this.#iface.inEndpoint.endpointNumber, length);
    if (result.status === 'stall') {
      await this.#device.clearHalt('in', this.#iface.inEndpoint.endpointNumber);
      throw new Error('bulk IN endpoint stalled');
    }
    if (result.status !== 'ok') throw new Error(`bulk IN failed: ${result.status}`);
    return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
  }

  async #readExactly(length) {
    let chunk = await this.#transferIn(length);
    if (chunk.length === length) return chunk;
    // A conforming device will not short-read, but be forgiving rather than
    // desynchronising the stream.
    const out = new Uint8Array(length);
    let offset = 0;
    out.set(chunk, offset);
    offset += chunk.length;
    while (offset < length) {
      chunk = await this.#transferIn(length - offset);
      if (chunk.length === 0) throw new Error('unexpected end of stream');
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /** Read one packet. Resolves to { command, arg0, arg1, payload }. */
  async readPacket() {
    const header = decodeHeader(await this.#readExactly(PACKET_HEADER_SIZE));
    const payload = header.dataLength > 0
      ? await this.#readExactly(header.dataLength)
      : new Uint8Array(0);
    return { ...header, payload };
  }

  async #transferOut(bytes) {
    const endpoint = this.#iface.outEndpoint.endpointNumber;
    const result = await this.#device.transferOut(endpoint, bytes);
    if (result.status === 'stall') {
      await this.#device.clearHalt('out', endpoint);
      throw new Error('bulk OUT endpoint stalled');
    }
    if (result.status !== 'ok') throw new Error(`bulk OUT failed: ${result.status}`);
    // Terminate the transfer when its length lands exactly on a packet
    // boundary, or the device's fixed-size read will never complete.
    if (bytes.length > 0 && bytes.length % this.outPacketSize === 0) {
      await this.#device.transferOut(endpoint, new Uint8Array(0));
    }
  }

  /**
   * Write one packet. Header and payload go out as separate transfers, which
   * is what adbd's reader expects. Serialized so concurrent streams cannot
   * interleave a header with someone else's payload.
   */
  writePacket({ command, arg0 = 0, arg1 = 0, payload = new Uint8Array(0), useChecksum = false }) {
    const send = async () => {
      const checksum = useChecksum ? calculateChecksum(payload) : 0;
      await this.#transferOut(encodeHeader({ command, arg0, arg1, payload, checksum }));
      if (payload.length > 0) await this.#transferOut(payload);
    };
    const queued = this.#writeLock.then(send, send);
    this.#writeLock = queued.catch(() => {});
    return queued;
  }
}
