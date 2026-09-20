/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * WebUSB implementation of the transport used by AOSP's fastboot host
 * driver. AOSP's own transport is an abstract interface (transport.h):
 *
 *   class Transport {
 *    public:
 *     virtual ssize_t Read(void* data, size_t len) = 0;
 *     virtual ssize_t Write(const void* data, size_t len) = 0;
 *     virtual int Close() = 0;
 *     virtual int Reset() = 0;
 *     virtual int WaitForDisconnect() { return 0; }
 *   };
 *
 * usb.cpp / usb_linux.cpp / usb_osx.cpp implement that interface on top
 * of libusb/native USB stacks, which don't exist in a browser. This file
 * implements the equivalent behavior on top of the WebUSB API so the
 * protocol driver (fastboot-driver.js, itself a port of
 * fastboot_driver.cpp) can be used unmodified from a web page.
 *
 * Device matching mirrors usb.cpp's is_fastboot_interface(): class 0xFF
 * (vendor-specific), subclass 0x42, protocol 0x03, with one bulk-in and
 * one bulk-out endpoint.
 */

import { UsbError } from './errors.js';

const FASTBOOT_CLASS = 0xff;
const FASTBOOT_SUBCLASS = 0x42;
const FASTBOOT_PROTOCOL = 0x03;

/**
 * The WebUSB device filter fastboot bootloaders match under. Pass this
 * (or something derived from it) to navigator.usb.requestDevice().
 * WebUSB filters can't match on interface class, so this only narrows
 * by the common Google/AOSP fastboot vendor ID; findFastbootInterface()
 * below does the real (interface-level) matching after the user picks
 * a device, same as usb.cpp does at the interface level regardless of
 * which vendor ID matched.
 */
export const FASTBOOT_USB_FILTERS = [
  { classCode: FASTBOOT_CLASS, subclassCode: FASTBOOT_SUBCLASS, protocolCode: FASTBOOT_PROTOCOL },
];

/**
 * Finds the fastboot interface + alternate + bulk endpoints on an
 * already-selected WebUSB device, equivalent to usb.cpp's interface
 * scan inside usb_open().
 *
 * @param {USBDevice} device
 * @returns {{configurationValue: number, interfaceNumber: number,
 *            alternateSetting: number, inEndpoint: number, outEndpoint: number}}
 */
export function findFastbootInterface(device) {
  for (const config of device.configurations) {
    for (const iface of config.interfaces) {
      for (const alt of iface.alternates) {
        if (
          alt.interfaceClass === FASTBOOT_CLASS &&
          alt.interfaceSubclass === FASTBOOT_SUBCLASS &&
          alt.interfaceProtocol === FASTBOOT_PROTOCOL
        ) {
          const inEp = alt.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
          const outEp = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
          if (inEp && outEp) {
            return {
              configurationValue: config.configurationValue,
              interfaceNumber: iface.interfaceNumber,
              alternateSetting: alt.alternateSetting,
              inEndpoint: inEp.endpointNumber,
              outEndpoint: outEp.endpointNumber,
              // wMaxPacketSize of the bulk-out endpoint: 64 (FS) or 512 (HS/SS).
              // Used to determine whether a ZLP is needed after a payload transfer.
              outPacketSize: outEp.packetSize || 512,
            };
          }
        }
      }
    }
  }
  return null;
}

export class WebUsbTransport {
  /** @param {USBDevice} device An already-permitted (requestDevice()'d) WebUSB device. */
  constructor(device) {
    this.device = device;
    this._iface = null;
    this._claimed = false;
    // wMaxPacketSize of the bulk-out endpoint, set during open().
    // 64 = USB Full Speed ("Connected (slow)"), 512 = USB High Speed.
    this._outPacketSize = 512;
  }

  /**
   * Opens the device, selects the fastboot configuration/interface, and
   * claims it. Equivalent to the device-open half of usb.cpp's
   * usb_open(): finding the interface, then libusb_claim_interface().
   */
  async open() {
    const info = findFastbootInterface(this.device);
    if (!info) {
      throw new UsbError('No fastboot (class 0xFF/0x42/0x03) interface found on this device');
    }
    this._iface = info;
    this._outPacketSize = info.outPacketSize || 512;
    console.log(`[USB] bulk-out wMaxPacketSize: ${this._outPacketSize}`);

    if (!this.device.opened) {
      await this.device.open();
    }
    if (this.device.configuration?.configurationValue !== info.configurationValue) {
      await this.device.selectConfiguration(info.configurationValue);
    }
    await this.device.claimInterface(info.interfaceNumber);
    if (info.alternateSetting !== 0) {
      await this.device.selectAlternateInterface(info.interfaceNumber, info.alternateSetting);
    }
    this._claimed = true;
  }

  /**
   * Reads up to `len` bytes. Returns a Uint8Array that may be shorter
   * than `len` (fastboot responses are always <= 256 bytes and sent as
   * a single USB transaction, so short reads are normal and expected —
   * same semantics as Transport::Read's return value).
   *
   * @param {number} len
   * @returns {Promise<Uint8Array>}
   */
  async read(len) {
    if (!this._claimed) throw new UsbError('Transport is not open');
    let result;
    try {
      result = await this.device.transferIn(this._iface.inEndpoint, len);
    } catch (e) {
      throw new UsbError(`USB read failed: ${e.message || e}`);
    }
    if (result.status !== 'ok') {
      throw new UsbError(`USB read failed with status '${result.status}'`);
    }
    return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
  }

  /**
   * Writes `data` (a BufferSource) in a single bulk-out transfer.
   * Callers that need to send more than fits comfortably in one
   * transfer should chunk before calling this (see writeChunked
   * below) — mirroring how the C++ driver's SparseWriteCallback
   * coalesces into TRANSPORT_CHUNK_SIZE pieces before calling
   * Transport::Write.
   *
   * @param {BufferSource} data
   */
  async write(data) {
    if (!this._claimed) throw new UsbError('Transport is not open');
    let result;
    try {
      result = await this.device.transferOut(this._iface.outEndpoint, data);
    } catch (e) {
      throw new UsbError(`USB write failed: ${e.message || e}`);
    }
    if (result.status !== 'ok') {
      throw new UsbError(`USB write failed with status '${result.status}'`);
    }
    if (result.bytesWritten !== data.byteLength) {
      throw new UsbError(
        `Short write: wrote ${result.bytesWritten} of ${data.byteLength} bytes`,
      );
    }
  }

  /**
   * Writes `data` in chunks of at most `chunkSize` bytes, reporting
   * progress via `onProgress(bytesSent, totalBytes)` after each chunk.
   * Used for large downloads (flashing images) where a single
   * transferOut() call for a multi-hundred-MB buffer is undesirable.
   *
   * @param {BufferSource} data
   * @param {number} chunkSize
   * @param {(sent: number, total: number) => void} [onProgress]
   */
  /**
   * Sends a USB Zero-Length Packet on the bulk-out endpoint to terminate
   * a transfer whose byte count is an exact multiple of wMaxPacketSize.
   * Mirrors usb.cpp's UsbTransport::Write() ZLP logic.
   * @private
   */
  async writeChunked(data, chunkSize, onProgress) {
    // Pre-buffer small Blobs (<= 32 MB) into contiguous memory to avoid
    // per-chunk async Blob.slice() overhead on fast images like boot/recovery.
    if (data instanceof Blob && data.size <= 32 * 1024 * 1024) {
      data = new Uint8Array(await data.arrayBuffer());
    }
    const isBlob = data instanceof Blob;
    const view = isBlob
      ? null
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
    const total = isBlob ? data.size : view.byteLength;
    let sent = 0;
    let lastProgressAt = performance.now();
    // DEBUG watchdog: warns if no chunk completes for 10s.
    const wd = setInterval(() => {
      const idle = ((performance.now() - lastProgressAt) / 1000).toFixed(0);
      console.warn(`[USB] no chunk completed for ${idle}s; sent=${sent}/${total} (${((sent / total) * 100).toFixed(1)}%)`);
    }, 10000);
    try {
      while (sent < total) {
        const end = Math.min(sent + chunkSize, total);
        const buf = isBlob ? await data.slice(sent, end).arrayBuffer() : view.subarray(sent, end);
        await this.write(buf);
        sent = end;
        lastProgressAt = performance.now();
        if (onProgress) onProgress(sent, total);
      }
    } finally {
      clearInterval(wd);
    }
  }

  /** Equivalent to Transport::Reset() — a USB bus reset of the device. */
  async reset() {
    if (typeof this.device.reset === 'function') {
      await this.device.reset();
    }
  }

  /** Equivalent to Transport::Close(). */
  async close() {
    try {
      if (this._claimed && this._iface) {
        await this.device.releaseInterface(this._iface.interfaceNumber);
      }
    } catch {
      // Device may have already disconnected; ignore.
    } finally {
      this._claimed = false;
    }
    try {
      if (this.device.opened) {
        await this.device.close();
      }
    } catch {
      // Ignore close races with physical disconnects.
    }
  }

  /**
   * Equivalent to Transport::WaitForDisconnect(). WebUSB surfaces
   * disconnection as a 'disconnect' event on navigator.usb rather than
   * a blocking call, so we adapt it into a Promise here.
   */
  waitForDisconnect() {
    return new Promise((resolve) => {
      const handler = (event) => {
        if (event.device === this.device) {
          navigator.usb.removeEventListener('disconnect', handler);
          resolve();
        }
      };
      navigator.usb.addEventListener('disconnect', handler);
    });
  }
}

/**
 * Convenience wrapper around navigator.usb.requestDevice() that applies
 * the fastboot filter set. Must be called from a user gesture (click
 * handler, etc.) per the WebUSB spec.
 *
 * @returns {Promise<USBDevice>}
 */
export async function requestFastbootDevice() {
  if (!navigator.usb) {
    throw new UsbError('WebUSB is not available in this browser/context (requires HTTPS)');
  }
  return navigator.usb.requestDevice({ filters: FASTBOOT_USB_FILTERS });
}

/**
 * Finds `oldDevice` again among navigator.usb.getDevices() (the set
 * the user has already granted this origin permission for), after it
 * has disconnected and re-enumerated as a new USBDevice object — e.g.
 * after `reboot-fastboot` swaps the bootloader for fastbootd. This is
 * the WebUSB-side equivalent of AOSP's own reboot_to_userspace_fastboot(),
 * which re-runs its native device scan (open_device()) after a
 * WaitForDisconnect() for the same reason: the OS assigns the
 * reconnected device a new handle, so the old Transport can't just be
 * reused.
 *
 * Matches by serial number when the device reports one (this survives
 * re-enumeration reliably); otherwise falls back to vendor/product ID,
 * which is ambiguous if more than one identical device is attached.
 *
 * @param {USBDevice} oldDevice
 * @param {{timeoutMs?: number, pollIntervalMs?: number}} [opts]
 * @returns {Promise<WebUsbTransport>} An already-open transport for the reconnected device.
 */
export async function waitForReconnect(oldDevice, opts = {}) {
  const { timeoutMs = 20000, pollIntervalMs = 250 } = opts;
  if (!navigator.usb) {
    throw new UsbError('WebUSB is not available in this browser/context (requires HTTPS)');
  }

  // AOSP's own reboot_to_userspace_fastboot() sleeps a beat after
  // WaitForDisconnect() before re-scanning, since not every platform's
  // disconnect signal fires exactly when the device is ready to be
  // reopened; do the same here before polling getDevices().
  await sleep(1000);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const devices = await navigator.usb.getDevices();
    const match = findMatchingDevice(oldDevice, devices);
    if (match) {
      const transport = new WebUsbTransport(match);
      try {
        await transport.open();
        return transport;
      } catch {
        // Enumerated but not yet claimable (still settling); keep polling.
      }
    }
    await sleep(pollIntervalMs);
  }
  throw new UsbError('Timed out waiting for the device to reconnect');
}

function findMatchingDevice(oldDevice, devices) {
  if (!devices || devices.length === 0) return null;
  if (oldDevice.serialNumber) {
    const bySerial = devices.find((d) => d.serialNumber && d.serialNumber === oldDevice.serialNumber);
    if (bySerial) return bySerial;
  }
  const byExactProduct = devices.find((d) => d.vendorId === oldDevice.vendorId && d.productId === oldDevice.productId);
  if (byExactProduct) return byExactProduct;

  const byVendor = devices.find((d) => d.vendorId === oldDevice.vendorId);
  if (byVendor) return byVendor;

  return devices[0];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
