# adb-webusb

A JavaScript adb *client* that talks to `adbd` directly over WebUSB. No adb
server, no native helper, no daemon on port 5037.

This is a port of the host side of `packages/modules/adb` at
`refs/heads/android17-release`. Every file carries the AOSP Apache-2.0 header,
and the port was written from the AOSP sources and `docs/dev/*.md` in that tree
— not from any third-party implementation. `ya-webadb` was not consulted or
copied from, so there is no MIT code and no mixed provenance to disclose.

## Layout

| Path | Ported from |
| --- | --- |
| `src/constants.js` | `adb.h`, `file_sync_protocol.h`, `shell_protocol.h`, `transport.cpp` |
| `src/packet.js` | `types.h`, `adb.cpp` (`calculate_apacket_checksum`) |
| `src/crypto/adb-key.js` | `crypto/rsa_2048_key.cpp`, `client/auth.cpp`, `libcrypto_utils/android_pubkey.c` |
| `src/transport/webusb.js` | `client/usb_libusb_device.cpp`, `client/transport_usb.cpp`, `docs/dev/zero_length_packet.md` |
| `src/connection.js` | `adb.cpp` (`handle_packet`, `send_connect`, `parse_banner`) |
| `src/stream.js` | `sockets.cpp`, `docs/dev/delayed_ack.md` |
| `src/services/shell.js` | `shell_protocol.h`, `shell_service_protocol.cpp` |
| `src/services/sync.js` | `file_sync_protocol.h`, `daemon/file_sync_service.cpp`, `client/file_sync_client.cpp` |

## Usage

```js
import { Adb } from './src/index.js';

// Must be called from a click handler: requestDevice() needs a user gesture.
const adb = await Adb.connect();

console.log(await adb.shell('getprop ro.build.fingerprint'));

for (const entry of await adb.list('/sdcard')) console.log(entry.name, entry.mode);

await adb.push('/data/local/tmp/hello.txt', new TextEncoder().encode('hi'));
const bytes = await adb.pull('/data/local/tmp/hello.txt');
```

Streaming, for anything large:

```js
const sync = await adb.sync();
for await (const chunk of sync.pull('/sdcard/movie.mp4')) writer.write(chunk);
await sync.close();
```

An interactive PTY, for wiring to xterm.js:

```js
const shell = await adb.interactiveShell();
shell.resize(24, 80);
for await (const { id, data } of shell.packets()) terminal.write(data);
```

## The parts that are easy to get wrong

**Zero-length packets.** `adbd`'s functionfs reader posts a fixed 16 KiB
request rather than following the protocol, so any transfer whose length is an
exact multiple of `wMaxPacketSize` leaves the device waiting for a terminating
short packet. Chrome does not append ZLPs for you. `AdbWebUsbTransport`
checks `length % outPacketSize === 0` on every transfer, header included —
the header is 24 bytes, which is a multiple of 8, so full-speed endpoints hit
this too. Skipping it produces the nondeterministic "received too many bytes
while waiting for payload" disconnects described in
`docs/dev/zero_length_packet.md`.

**AUTH signing is not a normal RSA signature.** `client/auth.cpp` calls
`RSA_sign(NID_sha1, token, 20, ...)`, which treats the 20-byte token as an
*already computed* SHA-1 digest and wraps it in the PKCS#1 v1.5 DigestInfo
encoding. WebCrypto always hashes its input first, so it cannot be used here.
`AdbKey.sign()` builds the encoded message by hand and does the modular
exponentiation with BigInt (CRT, so it costs a couple of milliseconds).

**The public key blob is not SPKI.** `adbd` wants the 524-byte
`RSAPublicKey` struct from `android_pubkey.c`: word count, `n0inv`
(`-1/n[0] mod 2^32`), the modulus and `R² mod n` both little-endian, then the
exponent. Base64 it, append `" user@host"`, and NUL-terminate the payload.

**Delayed ACK is all-or-nothing.** `adbd` compares `A_OPEN` `arg1` against
what it negotiated and closes the socket on a mismatch, so `arg1` must be
`INITIAL_DELAYED_ACK_BYTES` when both banners advertise `delayed_ack` and `0`
otherwise. Likewise `A_OKAY` carries a 4-byte payload in that mode and nothing
at all outside it. `AdbStream` treats a mismatch in either direction as a
protocol error rather than guessing.

**Do not over-advertise features.** The banner is a promise. Listing
`sendrecv_v2_zstd` without a zstd decoder means `adbd` will happily send you
compressed frames. `HOST_FEATURES` in `constants.js` lists only what is
implemented.

**Checksums.** The transport starts at `A_VERSION_MIN`, so the initial `CNXN`
and any `AUTH` packets carry a real payload checksum; once the device's `CNXN`
reports `A_VERSION_SKIP_CHECKSUM` the field goes to zero. Old devices need the
first behaviour and new ones need the second.

## Tests

```
node test/selftest.mjs   # framing, struct ids, android_pubkey, PKCS#1 encoding
node test/loopback.mjs   # handshake, mux, flow control against a mock adbd
node test/sync.mjs       # sync struct layouts and message sequencing
```

These need no hardware. The demo in `demo/` needs a real device; serve it over
https or localhost.

## Not done yet

- `forward:` / `reverse:forward:` — reverse is straightforward over this
  stream layer; forward needs a host-side listener, which the browser cannot
  provide without a companion transport.
- Compressed sync (`brotli`, `lz4`, `zstd`). `RECV_V2`/`SEND_V2` are wired up
  with `kSyncFlagNone`, which every device advertising `sendrecv_v2` accepts.
  Brotli is the cheapest to add: `DecompressionStream('br')` is available in
  Chrome.
- `A_STLS` and wireless pairing. Only reachable over TCP, so it is out of
  scope for a WebUSB-only transport, but the `A_STLS` constant is defined and
  the connection rejects it with a clear message.
- `install` / `abb_exec` ergonomics. The raw service is exposed; the
  streamed-install state machine from `client/adb_install.cpp` is not ported.
- Incremental install, `fastdeploy`, mDNS discovery.

## Browser support

Chrome and Edge 61+, and Chromium-based browsers generally. Firefox and Safari
do not implement WebUSB. On Linux, add a udev rule for the device; on Windows,
the device needs the WinUSB driver bound to the adb interface.
