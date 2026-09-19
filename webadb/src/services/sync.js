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
  FEATURE_LS_V2, FEATURE_SENDRECV_V2, FEATURE_STAT_V2, SYNC, SYNC_DATA_MAX, SyncFlag,
} from '../constants.js';
import { StreamReader } from '../reader.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const STAT_V1_SIZE = 16;
const STAT_V2_SIZE = 72;
const DENT_V1_SIZE = 20;
const DENT_V2_SIZE = 76;

export class AdbSyncError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdbSyncError';
  }
}

function idToString(id) {
  return String.fromCharCode(id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff, (id >>> 24) & 0xff);
}

/** S_IFMT bits, as reported by the device's lstat. */
export const FileType = {
  MASK: 0o170000,
  SOCKET: 0o140000,
  SYMLINK: 0o120000,
  REGULAR: 0o100000,
  BLOCK: 0o060000,
  DIRECTORY: 0o040000,
  CHAR: 0o020000,
  FIFO: 0o010000,
};

export const isDirectory = (mode) => (mode & FileType.MASK) === FileType.DIRECTORY;
export const isRegularFile = (mode) => (mode & FileType.MASK) === FileType.REGULAR;
export const isSymlink = (mode) => (mode & FileType.MASK) === FileType.SYMLINK;

/**
 * A single "sync:" session. The service is request/response and strictly
 * ordered, so one operation must finish before the next begins; callers who
 * want concurrency should open separate sessions.
 */
export class AdbSync {
  #stream;
  #reader;
  #connection;
  #busy = Promise.resolve();

  constructor(connection, stream) {
    this.#connection = connection;
    this.#stream = stream;
    this.#reader = new StreamReader(stream);
  }

  static async open(connection) {
    const stream = await connection.open('sync:');
    return new AdbSync(connection, stream);
  }

  get supportsStatV2() { return this.#connection.supportsFeature(FEATURE_STAT_V2); }
  get supportsLsV2() { return this.#connection.supportsFeature(FEATURE_LS_V2); }
  get supportsSendRecvV2() { return this.#connection.supportsFeature(FEATURE_SENDRECV_V2); }

  /** Serialize operations; the sync service has no request IDs to match on. */
  #serialize(operation) {
    const run = this.#busy.then(operation, operation);
    this.#busy = run.then(() => {}, () => {});
    return run;
  }

  /** Same lock, held across a streaming operation until release() is called. */
  async #acquire() {
    const previous = this.#busy;
    let release;
    this.#busy = new Promise((resolve) => { release = resolve; });
    await previous.catch(() => {});
    return release;
  }

  #sendRequest(id, path) {
    const pathBytes = encoder.encode(path);
    const packet = new Uint8Array(8 + pathBytes.length);
    const view = new DataView(packet.buffer);
    view.setUint32(0, id, true);
    view.setUint32(4, pathBytes.length, true);
    packet.set(pathBytes, 8);
    return this.#stream.write(packet);
  }

  async #readId() {
    const view = await this.#reader.readDataView(4);
    if (view === null) throw new AdbSyncError('sync stream closed unexpectedly');
    return view.getUint32(0, true);
  }

  async #readFailMessage() {
    const view = await this.#reader.readDataView(4);
    const length = view.getUint32(0, true);
    const message = length > 0 ? await this.#reader.readExactly(length) : new Uint8Array(0);
    return decoder.decode(message);
  }

  // ---- stat ----

  /** lstat by default; pass { follow: true } for STAT_V2's stat() semantics. */
  stat(path, { follow = false } = {}) {
    return this.#serialize(async () => {
      if (this.supportsStatV2) {
        await this.#sendRequest(follow ? SYNC.STAT_V2 : SYNC.LSTAT_V2, path);
        const view = await this.#reader.readDataView(STAT_V2_SIZE);
        const id = view.getUint32(0, true);
        if (id !== (follow ? SYNC.STAT_V2 : SYNC.LSTAT_V2)) {
          throw new AdbSyncError(`unexpected reply ${idToString(id)} to stat`);
        }
        const error = view.getUint32(4, true);
        if (error !== 0) throw new AdbSyncError(`stat ${path}: errno ${error}`);
        return {
          dev: view.getBigUint64(8, true),
          ino: view.getBigUint64(16, true),
          mode: view.getUint32(24, true),
          nlink: view.getUint32(28, true),
          uid: view.getUint32(32, true),
          gid: view.getUint32(36, true),
          size: view.getBigUint64(40, true),
          atime: view.getBigInt64(48, true),
          mtime: view.getBigInt64(56, true),
          ctime: view.getBigInt64(64, true),
        };
      }
      await this.#sendRequest(SYNC.LSTAT_V1, path);
      const view = await this.#reader.readDataView(STAT_V1_SIZE);
      if (view.getUint32(0, true) !== SYNC.LSTAT_V1) {
        throw new AdbSyncError('unexpected reply to stat');
      }
      const mode = view.getUint32(4, true);
      // v1 cannot distinguish "does not exist" from a zeroed stat.
      if (mode === 0) throw new AdbSyncError(`stat ${path}: no such file or directory`);
      return {
        mode,
        size: BigInt(view.getUint32(8, true)),
        mtime: BigInt(view.getUint32(12, true)),
      };
    });
  }

  // ---- list ----

  /** Directory entries, excluding nothing -- "." and ".." are included. */
  list(path) {
    return this.#serialize(async () => {
      const v2 = this.supportsLsV2;
      await this.#sendRequest(v2 ? SYNC.LIST_V2 : SYNC.LIST_V1, path);
      const size = v2 ? DENT_V2_SIZE : DENT_V1_SIZE;
      const entries = [];
      for (;;) {
        const view = await this.#reader.readDataView(size);
        if (view === null) throw new AdbSyncError('sync stream closed during list');
        const id = view.getUint32(0, true);
        if (id === SYNC.DONE) return entries;
        if (id === SYNC.FAIL) throw new AdbSyncError(await this.#readFailMessage());
        if (id !== (v2 ? SYNC.DENT_V2 : SYNC.DENT_V1)) {
          throw new AdbSyncError(`unexpected reply ${idToString(id)} to list`);
        }
        const entry = v2
          ? {
              error: view.getUint32(4, true),
              dev: view.getBigUint64(8, true),
              ino: view.getBigUint64(16, true),
              mode: view.getUint32(24, true),
              nlink: view.getUint32(28, true),
              uid: view.getUint32(32, true),
              gid: view.getUint32(36, true),
              size: view.getBigUint64(40, true),
              atime: view.getBigInt64(48, true),
              mtime: view.getBigInt64(56, true),
              ctime: view.getBigInt64(64, true),
              nameLength: view.getUint32(72, true),
            }
          : {
              mode: view.getUint32(4, true),
              size: BigInt(view.getUint32(8, true)),
              mtime: BigInt(view.getUint32(12, true)),
              nameLength: view.getUint32(16, true),
            };
        const name = decoder.decode(await this.#reader.readExactly(entry.nameLength));
        delete entry.nameLength;
        entries.push({ name, ...entry });
      }
    });
  }

  // ---- pull ----

  /**
   * Stream a file off the device. Yields Uint8Array chunks.
   *
   * Compression is deliberately not negotiated: brotli, LZ4 and zstd would
   * each drag in a decoder, and RECV_V2 with kSyncFlagNone is accepted by
   * every device that advertises sendrecv_v2.
   */
  async *pull(path) {
    // Hold the session lock for the whole transfer: interleaving another
    // request would corrupt the reply stream.
    const release = await this.#acquire();
    try {
      if (this.supportsSendRecvV2) {
        await this.#sendRequest(SYNC.RECV_V2, path);
        const setup = new Uint8Array(8);
        const view = new DataView(setup.buffer);
        view.setUint32(0, SYNC.RECV_V2, true);
        view.setUint32(4, SyncFlag.None, true);
        await this.#stream.write(setup);
      } else {
        await this.#sendRequest(SYNC.RECV_V1, path);
      }
      for (;;) {
        const view = await this.#reader.readDataView(8);
        if (view === null) throw new AdbSyncError('sync stream closed during pull');
        const id = view.getUint32(0, true);
        const length = view.getUint32(4, true);
        if (id === SYNC.DONE) return;
        if (id === SYNC.FAIL) {
          const message = length > 0
            ? decoder.decode(await this.#reader.readExactly(length)) : 'pull failed';
          throw new AdbSyncError(message);
        }
        if (id !== SYNC.DATA) {
          throw new AdbSyncError(`unexpected reply ${idToString(id)} during pull`);
        }
        yield await this.#reader.readExactly(length);
      }
    } finally {
      release();
    }
  }

  /** Convenience wrapper: the whole file as one buffer. */
  async pullToBytes(path) {
    const chunks = [];
    let total = 0;
    for await (const chunk of this.pull(path)) {
      chunks.push(chunk);
      total += chunk.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }

  // ---- push ----

  /**
   * Write a file to the device.
   *
   * @param path    Destination path on the device.
   * @param content Uint8Array, Blob/File, ReadableStream, or async iterable of
   *                Uint8Array.
   * @param options mode (default 0o644) and mtime in seconds (default now).
   */
  push(path, content, { mode = 0o644, mtime = Math.floor(Date.now() / 1000), dryRun = false } = {}) {
    return this.#serialize(async () => {
      if (this.supportsSendRecvV2) {
        await this.#sendRequest(SYNC.SEND_V2, path);
        const setup = new Uint8Array(12);
        const view = new DataView(setup.buffer);
        view.setUint32(0, SYNC.SEND_V2, true);
        view.setUint32(4, mode, true);
        view.setUint32(8, dryRun ? SyncFlag.DryRun : SyncFlag.None, true);
        await this.#stream.write(setup);
      } else {
        if (dryRun) throw new AdbSyncError('dry run requires the sendrecv_v2 feature');
        // v1 packs the mode into the path as "path,mode".
        await this.#sendRequest(SYNC.SEND_V1, `${path},${mode}`);
      }

      for await (const chunk of toChunks(content)) {
        for (let offset = 0; offset < chunk.length; offset += SYNC_DATA_MAX) {
          const slice = chunk.subarray(offset, Math.min(offset + SYNC_DATA_MAX, chunk.length));
          const packet = new Uint8Array(8 + slice.length);
          const view = new DataView(packet.buffer);
          view.setUint32(0, SYNC.DATA, true);
          view.setUint32(4, slice.length, true);
          packet.set(slice, 8);
          await this.#stream.write(packet);
        }
      }

      // DONE carries the mtime in the size field.
      const done = new Uint8Array(8);
      const doneView = new DataView(done.buffer);
      doneView.setUint32(0, SYNC.DONE, true);
      doneView.setUint32(4, mtime, true);
      await this.#stream.write(done);

      const id = await this.#readId();
      if (id === SYNC.FAIL) throw new AdbSyncError(await this.#readFailMessage());
      if (id !== SYNC.OKAY) throw new AdbSyncError(`unexpected reply ${idToString(id)} to push`);
      await this.#reader.readExactly(4);  // msglen, always 0 on OKAY
    });
  }

  async close() {
    try {
      await this.#serialize(async () => {
        const quit = new Uint8Array(8);
        new DataView(quit.buffer).setUint32(0, SYNC.QUIT, true);
        await this.#stream.write(quit);
      });
    } catch { /* the device may have hung up already */ }
    await this.#stream.close();
  }
}

async function* toChunks(content) {
  if (content instanceof Uint8Array) { yield content; return; }
  if (content instanceof ArrayBuffer) { yield new Uint8Array(content); return; }
  if (typeof content === 'string') { yield encoder.encode(content); return; }
  if (typeof Blob !== 'undefined' && content instanceof Blob) {
    yield* toChunks(content.stream());
    return;
  }
  if (typeof ReadableStream !== 'undefined' && content instanceof ReadableStream) {
    const reader = content.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value instanceof Uint8Array ? value : new Uint8Array(value);
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  if (content?.[Symbol.asyncIterator] || content?.[Symbol.iterator]) {
    for await (const chunk of content) {
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    }
    return;
  }
  throw new TypeError('unsupported content type for push');
}
