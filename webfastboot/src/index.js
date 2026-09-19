/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Public entry point for the WebUSB fastboot client.
 */

export { FastbootDriver } from './fastboot-driver.js';
export {
  WebUsbTransport,
  requestFastbootDevice,
  findFastbootInterface,
  waitForReconnect,
  FASTBOOT_USB_FILTERS,
} from './usb-transport.js';
export {
  flashAll,
  update,
  checkRequirements,
  rebootToUserspaceFastboot,
  parseFastbootInfo,
  FileMapImageSource,
  IMAGES,
  ImageType,
} from './flashall.js';
export { ZipImageSource } from './zip.js';
export * as constants from './constants.js';
export { FastbootError, DeviceFailError, TimeoutError, UsbError, ProtocolError } from './errors.js';
export {
  isSparse,
  parseSparse,
  rawToChunks,
  buildSparse,
  resparse,
  prepareForFlashing,
  ChunkType,
} from './sparse.js';

/**
 * Convenience one-shot helper: prompts the user to pick a device (must
 * be called from a user-gesture handler), opens it, and returns a ready
 * FastbootDriver.
 *
 * @param {import('./fastboot-driver.js').DriverCallbacks} [callbacks]
 * @returns {Promise<import('./fastboot-driver.js').FastbootDriver>}
 */
export async function connect(callbacks) {
  const { requestFastbootDevice, WebUsbTransport } = await import('./usb-transport.js');
  const { FastbootDriver } = await import('./fastboot-driver.js');

  const device = await requestFastbootDevice();
  const transport = new WebUsbTransport(device);
  await transport.open();
  return new FastbootDriver(transport, callbacks);
}
