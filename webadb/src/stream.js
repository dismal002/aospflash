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

function deferred() {
  if (typeof Promise.withResolvers === 'function') return Promise.withResolvers();
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export class AdbStreamClosedError extends Error {
  constructor(message = 'stream closed') {
    super(message);
    this.name = 'AdbStreamClosedError';
  }
}

/**
 * One asocket. The remote end is addressed by remoteId; our end by localId.
 *
 * Two flow-control modes, chosen at OPEN time:
 *
 *  - Classic: exactly one A_WRTE may be outstanding. The next write waits for
 *    the peer's A_OKAY.
 *  - Delayed ACK: we advertise a receive budget in A_OPEN arg1 and the peer
 *    grants ours in the payload of its first A_OKAY. Later A_OKAY payloads
 *    credit back bytes the peer has consumed, so multiple writes can be in
 *    flight. See docs/dev/delayed_ack.md.
 */
export class AdbStream {
  #connection;
  #incoming = [];
  #readWaiters = [];
  #sendWaiters = [];
  #availableSendBytes = null;   // null => classic mode
  #writeReady = false;          // classic mode: may we send now?
  #pendingAck = 0;              // bytes received but not yet acknowledged
  #closed = false;
  #error = null;
  #opened = null;

  constructor(connection, localId, service, { delayedAck = false } = {}) {
    this.#connection = connection;
    this.localId = localId;
    this.remoteId = 0;
    this.service = service;
    if (delayedAck) this.#availableSendBytes = 0;
    this.#opened = deferred();
  }

  get closed() { return this.#closed; }
  get usesDelayedAck() { return this.#availableSendBytes !== null; }

  /** Resolves once the peer has acknowledged our A_OPEN. */
  get ready() { return this.#opened.promise; }

  // ---- inbound packet handlers, called by AdbConnection ----

  _onOkay(remoteId, ackedBytes) {
    if (this.remoteId === 0) {
      this.remoteId = remoteId;
      this.#opened.resolve(this);
    }
    if (this.#availableSendBytes !== null) {
      if (ackedBytes === null) {
        this._onClose(new Error('peer sent a bare A_OKAY on a delayed-ack stream'));
        return;
      }
      this.#availableSendBytes += ackedBytes;
      if (this.#availableSendBytes > 0) this.#releaseWriters();
    } else {
      if (ackedBytes !== null) {
        this._onClose(new Error('peer sent a delayed-ack A_OKAY on a classic stream'));
        return;
      }
      this.#writeReady = true;
      this.#releaseWriters();
    }
  }

  _onWrite(payload) {
    this.#incoming.push(payload);
    const waiter = this.#readWaiters.shift();
    if (waiter) waiter.resolve(this.#take());
  }

  _onClose(error = null) {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    if (this.remoteId === 0) {
      this.#opened.reject(error ?? new AdbStreamClosedError(`${this.service}: refused by device`));
    }
    for (const waiter of this.#readWaiters.splice(0)) {
      if (error) waiter.reject(error); else waiter.resolve(null);
    }
    for (const waiter of this.#sendWaiters.splice(0)) {
      waiter.reject(error ?? new AdbStreamClosedError());
    }
  }

  #releaseWriters() {
    for (const waiter of this.#sendWaiters.splice(0)) waiter.resolve();
  }

  #take() {
    const chunk = this.#incoming.shift();
    // Acknowledge only once the consumer has taken the data, so that the
    // device feels real backpressure instead of filling our heap.
    this.#pendingAck += chunk.length;
    queueMicrotask(() => this.#flushAck());
    return chunk;
  }

  #flushAck() {
    if (this.#closed || this.#pendingAck === 0) return;
    const acked = this.#pendingAck;
    this.#pendingAck = 0;
    this.#connection._sendOkay(this, this.usesDelayedAck ? acked : null)
      .catch((error) => this._onClose(error));
  }

  // ---- reading ----

  /** Next chunk from the device, or null once the stream is closed. */
  read() {
    if (this.#incoming.length > 0) return Promise.resolve(this.#take());
    if (this.#error) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => this.#readWaiters.push({ resolve, reject }));
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      const chunk = await this.read();
      if (chunk === null) return;
      yield chunk;
    }
  }

  /** Drain the stream to a single buffer. Only for bounded output. */
  async readAll() {
    const chunks = [];
    let total = 0;
    for await (const chunk of this) {
      chunks.push(chunk);
      total += chunk.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }

  toReadableStream() {
    const stream = this;
    return new ReadableStream({
      async pull(controller) {
        const chunk = await stream.read();
        if (chunk === null) controller.close(); else controller.enqueue(chunk);
      },
      cancel() { return stream.close(); },
    });
  }

  // ---- writing ----

  async write(data) {
    const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const maxPayload = this.#connection.maxPayload;
    for (let offset = 0; offset < payload.length; offset += maxPayload) {
      const chunk = payload.subarray(offset, Math.min(offset + maxPayload, payload.length));
      await this.#awaitSendPermission();
      if (this.#closed) throw this.#error ?? new AdbStreamClosedError();
      if (this.#availableSendBytes !== null) this.#availableSendBytes -= chunk.length;
      else this.#writeReady = false;
      await this.#connection._sendWrite(this, chunk);
    }
  }

  #awaitSendPermission() {
    if (this.#closed) return Promise.reject(this.#error ?? new AdbStreamClosedError());
    if (this.#availableSendBytes !== null) {
      if (this.#availableSendBytes > 0) return Promise.resolve();
    } else if (this.#writeReady) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => this.#sendWaiters.push({ resolve, reject }));
  }

  toWritableStream() {
    const stream = this;
    return new WritableStream({
      write(chunk) { return stream.write(chunk); },
      close() { return stream.close(); },
      abort() { return stream.close(); },
    });
  }

  // ---- teardown ----

  async close() {
    if (this.#closed) return;
    const remoteId = this.remoteId;
    this._onClose();
    if (remoteId !== 0) await this.#connection._sendClose(this.localId, remoteId);
    this.#connection._removeStream(this.localId);
  }
}
