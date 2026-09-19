/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Error types for the WebUSB fastboot client. These mirror the
 * fastboot::RetCode categories used by AOSP's C++ driver (see
 * fastboot_driver_interface.h) so callers porting logic from the CLI
 * tool can reason about failures the same way, but as JS Error
 * subclasses with a `.code` field instead of an enum return value.
 */

import { RetCode } from './constants.js';

export class FastbootError extends Error {
  /**
   * @param {string} code One of the RetCode values.
   * @param {string} message Human-readable description.
   */
  constructor(code, message) {
    super(message);
    this.name = 'FastbootError';
    this.code = code;
  }
}

export class DeviceFailError extends FastbootError {
  constructor(message) {
    super(RetCode.DEVICE_FAIL, message);
    this.name = 'DeviceFailError';
  }
}

export class TimeoutError extends FastbootError {
  constructor(message = 'Timed out waiting for a response from the device') {
    super(RetCode.TIMEOUT, message);
    this.name = 'TimeoutError';
  }
}

export class UsbError extends FastbootError {
  constructor(message) {
    super(RetCode.IO_ERROR, message);
    this.name = 'UsbError';
  }
}

export class ProtocolError extends FastbootError {
  constructor(message) {
    super(RetCode.BAD_DEV_RESP, message);
    this.name = 'ProtocolError';
  }
}
