# webusb-fastboot

A WebUSB implementation of the [fastboot protocol](https://android.googlesource.com/platform/system/core/+/main/fastboot/README.md),
written from scratch for the browser.

## Why this exists instead of using fastboot.js

[fastboot.js](https://github.com/kdrag0n/fastbootjs) already does this, but it's
licensed in a way that's incompatible with contributing it back into AOSP.
Rather than depend on it (or derive code from it), this library is a **direct
port of AOSP's own C++ fastboot host driver**
(`system/core/fastboot/{fastboot_driver.h,fastboot_driver.cpp,constants.h}`,
BSD-style/Apache-2.0 licensed, copyright The Android Open Source Project) onto
WebUSB. Since AOSP already owns and licenses that source for exactly this kind
of reuse, there's no licensing conflict in reusing it as the basis for a
browser client that's intended to be contributed back upstream.

What's actually new here (because there's no AOSP source to port for it,
since these concerns don't exist in a native CLI tool):

- **`usb-transport.js`** — implements the `Transport` interface
  (`transport.h`) on top of `navigator.usb` instead of libusb. AOSP's own
  `usb.cpp`/`usb_linux.cpp`/`usb_osx.cpp` are native and not portable to a
  browser regardless of license, so this part is an original implementation
  against the WebUSB spec and the fastboot USB interface descriptor
  (class `0xFF`, subclass `0x42`, protocol `0x03`) documented in that same
  `usb.cpp`.
- **`sparse.js`** — an independent implementation of the (publicly
  documented) Android sparse image binary format, used to split large
  images into pieces when a device's `max-download-size` is smaller than
  the image being flashed, the same way AOSP's CLI does via `libsparse`
  (which is C, uses raw file descriptors, and isn't meaningfully portable
  to JS either).

Everything else — command strings, the `getvar`/`download`/`flash`/etc.
call sequence, response-parsing state machine (`OKAY`/`FAIL`/`DATA`/`INFO`/
`TEXT`), and timeout/retry behavior — mirrors `FastBootDriver` line for line
where the JS/async equivalent allows, so it can be reviewed against the
upstream C++ source and kept in sync with it over time.

## Status / what's implemented

| AOSP command | Method |
|---|---|
| `getvar:%s` | `getVar(key)` |
| `getvar:all` | `getVarAll()` |
| `download:%08x` | `download(data, onProgress?, label?)` |
| `flash:%s` | `flash(partition)` / `flashPartition()` / `flashBlob()` |
| `erase:%s` | `erase(partition)` |
| `boot` | `boot()` |
| `continue` | `continueBoot()` |
| `reboot`, `reboot-%s` | `reboot()`, `rebootTo(target)` |
| `set_active:%s` | `setActive(slot)` |
| `create/delete/resize-logical-partition` | `createPartition()`, `deletePartition()`, `resizePartition()` |
| `snapshot-update:%s` | `snapshotUpdate(command)` |
| `oem %s` | `oem(args)` |
| `flashing unlock/lock/unlock_critical/lock_critical/get_unlock_ability` | `flashingCommand(sub)`, `unlockBootloader()`, `lockBootloader()`, `unlockCriticalBootloader()`, `lockCriticalBootloader()`, `getUnlockAbility()` |
| `upload` | `upload()` |
| `fetch:%s[:offset[:size]]` | `fetch(partition, offset?, size?)` |
| raw command | `rawCommand(cmd)` |

Not ported (native/CLI-only concerns with no browser equivalent): TCP/UDP
transports (`tcp.cpp`, `udp.cpp`), the device-side implementation
(`device/`), and the `fastboot` CLI's flashing-plan/update-package logic
(`fastboot.cpp`'s `FlashAllTool`, `fastboot-info.txt` parsing, etc.) — those
belong in a higher-level tool built on top of this library, not in the
protocol client itself.

## Usage

```js
import { connect } from './src/index.js';

// Must be called from a user gesture (e.g. a click handler) — WebUSB
// requires this for navigator.usb.requestDevice().
const driver = await connect({
  info: (msg) => console.log('(bootloader)', msg),
});

console.log(await driver.getVar('product'));

const image = await (await fetch('boot.img')).arrayBuffer();
await driver.flashBlob('boot', image, (sent, total) => {
  console.log(`${sent}/${total}`);
});

await driver.rebootTo('bootloader');
```

### Unlocking the bootloader

```js
// Check whether the device even allows it (not all bootloaders report this).
console.log(await driver.getUnlockAbility()); // "1" or "0"

// This will typically show a confirmation prompt on the device's own
// screen that the user must accept with the volume/power keys before
// it responds, and a real unlock wipes all user data.
await driver.unlockBootloader();
```

See `examples/demo.html` for a complete working page (open it via a local
HTTPS/localhost server — WebUSB does not work over `file://`).

### Lower-level API

If you already have a `USBDevice` (e.g. from your own device picker UI):

```js
import { WebUsbTransport, FastbootDriver } from './src/index.js';

const transport = new WebUsbTransport(usbDevice);
await transport.open();
const driver = new FastbootDriver(transport);
```

## Browser/environment requirements

- WebUSB (`navigator.usb`): Chromium-based browsers only, as of this
  writing. Must be served over HTTPS or `localhost`.
- The OS must not have already claimed the device's fastboot interface
  with another driver (e.g. `adb`/`fastboot`'s own USB driver on Windows,
  or an already-attached native fastboot process on Linux/macOS holding
  the interface).

## License

Apache-2.0, matching the AOSP source this is derived from. See `LICENSE`.
