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

/**
 * A_WRTE boundaries carry no meaning to the sub-protocols layered on top of a
 * stream, so sync and shell_v2 messages routinely straddle them. This buffers
 * whatever arrives and hands back exact byte counts.
 */
export class StreamReader {
  #stream;
  #chunks = [];
  #available = 0;
  #eof = false;

  constructor(stream) { this.#stream = stream; }

  get atEof() { return this.#eof && this.#available === 0; }

  async #fill(needed) {
    while (this.#available < needed) {
      const chunk = await this.#stream.read();
      if (chunk === null) { this.#eof = true; return false; }
      this.#chunks.push(chunk);
      this.#available += chunk.length;
    }
    return true;
  }

  /** Exactly `length` bytes, or null at a clean end of stream. */
  async readExactly(length) {
    if (length === 0) return new Uint8Array(0);
    if (!await this.#fill(length)) {
      if (this.#available === 0) return null;
      throw new Error(`stream ended after ${this.#available} of ${length} bytes`);
    }
    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = this.#chunks[0];
      const take = Math.min(chunk.length, length - offset);
      out.set(chunk.subarray(0, take), offset);
      offset += take;
      if (take === chunk.length) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(take);
      this.#available -= take;
    }
    return out;
  }

  async readDataView(length) {
    const bytes = await this.readExactly(length);
    if (bytes === null) return null;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}
