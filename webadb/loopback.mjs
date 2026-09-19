// Exercises the connection and stream layers against an in-memory adbd that
// speaks the wire protocol. Run with: node test/loopback.mjs
import assert from 'node:assert/strict';
import { AdbConnection } from '../src/connection.js';
import { AdbKey } from '../src/crypto/adb-key.js';
import {
  A_AUTH, A_CLSE, A_CNXN, A_OKAY, A_OPEN, A_WRTE, ADB_AUTH_SIGNATURE, ADB_AUTH_TOKEN,
  INITIAL_DELAYED_ACK_BYTES, MAX_PAYLOAD,
} from '../src/constants.js';

globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A minimal adbd: authenticates, then echoes whatever a stream is sent. */
class MockDevice {
  constructor({ features, delayedAck, deviceCredit = 64 }) {
    this.features = features;
    this.delayedAck = delayedAck;
    this.deviceCredit = deviceCredit;
    this.outbox = [];
    this.waiters = [];
    this.sockets = new Map();
    this.nextId = 100;
    this.sawSignature = false;
    this.receivedFromHost = new Map();
  }

  #emit(packet) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(packet); else this.outbox.push(packet);
  }

  readPacket() {
    if (this.outbox.length) return Promise.resolve(this.outbox.shift());
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async writePacket({ command, arg0 = 0, arg1 = 0, payload = new Uint8Array(0) }) {
    switch (command) {
      case A_CNXN: {
        // Challenge first, exactly as a locked device does.
        this.#emit({
          command: A_AUTH, arg0: ADB_AUTH_TOKEN, arg1: 0,
          payload: new Uint8Array(20).fill(0x5a),
        });
        return;
      }
      case A_AUTH: {
        assert.equal(arg0, ADB_AUTH_SIGNATURE);
        assert.equal(payload.length, 256);
        this.sawSignature = true;
        this.#emit({
          command: A_CNXN, arg0: 0x01000001, arg1: MAX_PAYLOAD,
          payload: encoder.encode(
            `device::ro.product.model=Mock;features=${this.features.join(',')}`),
        });
        return;
      }
      case A_OPEN: {
        if (this.delayedAck) assert.equal(arg1, INITIAL_DELAYED_ACK_BYTES);
        else assert.equal(arg1, 0);
        const remoteId = this.nextId++;
        this.sockets.set(arg0, remoteId);
        this.receivedFromHost.set(remoteId, []);
        this.#emit({
          command: A_OKAY, arg0: remoteId, arg1: arg0,
          payload: this.delayedAck ? int32le(this.deviceCredit) : new Uint8Array(0),
        });
        return;
      }
      case A_WRTE: {
        this.receivedFromHost.get(arg1).push(payload);
        // Echo back, then credit the bytes we consumed.
        this.#emit({ command: A_WRTE, arg0: arg1, arg1: arg0, payload });
        this.#emit({
          command: A_OKAY, arg0: arg1, arg1: arg0,
          payload: this.delayedAck ? int32le(payload.length) : new Uint8Array(0),
        });
        return;
      }
      case A_OKAY:
        // Host acknowledging our echo; nothing to do.
        return;
      case A_CLSE: {
        this.#emit({ command: A_CLSE, arg0: arg1, arg1: arg0, payload: new Uint8Array(0) });
        return;
      }
      default:
        throw new Error(`mock device got unexpected command 0x${command.toString(16)}`);
    }
  }

  close() { return Promise.resolve(); }
}

function int32le(value) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, true);
  return bytes;
}

let passed = 0;
const run = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.stack}`); process.exitCode = 1; }
};

const key = await AdbKey.generate({ name: 'test@loopback' });

await run('handshake: signs the token and parses the banner', async () => {
  const device = new MockDevice({ features: ['shell_v2', 'cmd'], delayedAck: false });
  const connection = new AdbConnection(device, [key]);
  await connection.connect();
  assert.equal(device.sawSignature, true);
  assert.equal(connection.deviceType, 'device');
  assert.equal(connection.product['ro.product.model'], 'Mock');
  assert.equal(connection.supportsFeature('shell_v2'), true);
  assert.equal(connection.supportsDelayedAck, false);
  assert.equal(connection.maxPayload, MAX_PAYLOAD);
});

await run('classic mode: echo round-trip', async () => {
  const device = new MockDevice({ features: ['shell_v2'], delayedAck: false });
  const connection = new AdbConnection(device, [key]);
  await connection.connect();
  const stream = await connection.open('shell,v2,raw:echo hi');
  await stream.write('hello');
  assert.equal(decoder.decode(await stream.read()), 'hello');
  await stream.write(' world');
  assert.equal(decoder.decode(await stream.read()), ' world');
  await stream.close();
});

await run('delayed ack: negotiated and credit is consumed then restored', async () => {
  const device = new MockDevice({
    features: ['shell_v2', 'delayed_ack'], delayedAck: true, deviceCredit: 8,
  });
  const connection = new AdbConnection(device, [key]);
  await connection.connect();
  assert.equal(connection.supportsDelayedAck, true);

  const stream = await connection.open('shell,v2,raw:cat');
  assert.equal(stream.usesDelayedAck, true);

  // Credit is 8 bytes. Three 5-byte writes must still complete, because the
  // device credits each one back as it consumes it.
  for (let i = 0; i < 3; i++) await stream.write('abcde');

  let received = '';
  for (let i = 0; i < 3; i++) received += decoder.decode(await stream.read());
  assert.equal(received, 'abcdeabcdeabcde');
  await stream.close();
});

await run('writes larger than maxPayload are split', async () => {
  const device = new MockDevice({ features: [], delayedAck: false });
  const connection = new AdbConnection(device, [key]);
  await connection.connect();
  const stream = await connection.open('sync:');
  const remoteId = device.sockets.get(stream.localId);

  const big = new Uint8Array(MAX_PAYLOAD + 1234).fill(0x41);
  const drain = (async () => {
    let total = 0;
    while (total < big.length) total += (await stream.read()).length;
    return total;
  })();
  await stream.write(big);
  assert.equal(await drain, big.length);

  const chunks = device.receivedFromHost.get(remoteId);
  assert.equal(chunks.length, 2, 'split into two A_WRTE packets');
  assert.equal(chunks[0].length, MAX_PAYLOAD);
  assert.equal(chunks[1].length, 1234);
  await stream.close();
});

await run('several streams multiplex independently', async () => {
  const device = new MockDevice({ features: ['delayed_ack'], delayedAck: true });
  const connection = new AdbConnection(device, [key]);
  await connection.connect();
  const [a, b] = await Promise.all([
    connection.open('shell,v2,raw:one'),
    connection.open('shell,v2,raw:two'),
  ]);
  assert.notEqual(a.localId, b.localId);
  await a.write('AAA');
  await b.write('BBB');
  assert.equal(decoder.decode(await a.read()), 'AAA');
  assert.equal(decoder.decode(await b.read()), 'BBB');
  await Promise.all([a.close(), b.close()]);
});

await run('a device-initiated close ends the stream', async () => {
  const device = new MockDevice({ features: [], delayedAck: false });
  const connection = new AdbConnection(device, [key]);
  await connection.connect();
  const stream = await connection.open('shell:exit');
  const remoteId = device.sockets.get(stream.localId);
  device.writePacket({ command: A_CLSE, arg0: stream.localId, arg1: remoteId });
  assert.equal(await stream.read(), null);
  assert.equal(stream.closed, true);
});

console.log(`\n${passed} checks passed`);
