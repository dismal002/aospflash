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
  base64Decode, base64Encode, bigIntToBytesBE, bigIntToBytesLE, bytesToBigIntBE,
  modInverse, modPow,
} from './bigint.js';
import { md5 } from './md5.js';

const MODULUS_BITS = 2048;
const MODULUS_BYTES = MODULUS_BITS / 8;            // 256
const MODULUS_WORDS = MODULUS_BITS / 32;           // 64
const ANDROID_PUBKEY_ENCODED_SIZE = 3 * 4 + 2 * MODULUS_BYTES;  // 524

// ASN.1 DigestInfo prefix for SHA-1, per RFC 8017 section 9.2 note 1.
const SHA1_DIGEST_INFO = new Uint8Array([
  0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e,
  0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14,
]);

function b64urlToBigInt(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return bytesToBigIntBE(base64Decode(padded + '='.repeat((4 - padded.length % 4) % 4)));
}

// DER length / TLV encoding, just enough to wrap a legacy PKCS#1 key as PKCS#8.
function derLength(length) {
  if (length < 0x80) return [length];
  const bytes = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function derEncode(tag, content) {
  const header = [tag, ...derLength(content.length)];
  const out = new Uint8Array(header.length + content.length);
  out.set(header);
  out.set(content, header.length);
  return out;
}

// AlgorithmIdentifier { rsaEncryption, NULL }
const RSA_ALGORITHM_IDENTIFIER = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

/** "BEGIN RSA PRIVATE KEY" (PKCS#1) -> "BEGIN PRIVATE KEY" (PKCS#8), which is all WebCrypto imports. */
function pkcs1ToPkcs8(pkcs1) {
  const octets = derEncode(0x04, pkcs1);
  const inner = new Uint8Array(3 + RSA_ALGORITHM_IDENTIFIER.length + octets.length);
  inner.set([0x02, 0x01, 0x00]);  // version 0
  inner.set(RSA_ALGORITHM_IDENTIFIER, 3);
  inner.set(octets, 3 + RSA_ALGORITHM_IDENTIFIER.length);
  return derEncode(0x30, inner);
}

/**
 * An adb authentication key: RSA-2048 with e = 65537, matching
 * adb::crypto::CreateRSA2048Key().
 *
 * adbd does not verify a normal RSA signature. It treats the 20-byte AUTH
 * token as an already-computed SHA-1 digest and checks the PKCS#1 v1.5
 * encoding around it -- the C++ side is RSA_sign(NID_sha1, token, 20, ...).
 * WebCrypto will always hash its input first, so signing is done here with
 * raw modular exponentiation instead.
 */
export class AdbKey {
  #privateJwk;
  #n; #d; #p; #q; #dp; #dq; #qi;
  #deviceFingerprint;

  constructor(privateJwk, { name = 'webadb@webusb' } = {}) {
    if (privateJwk.kty !== 'RSA' || !privateJwk.d) {
      throw new Error('an RSA private key in JWK form is required');
    }
    this.#privateJwk = privateJwk;
    this.name = name;
    this.#n = b64urlToBigInt(privateJwk.n);
    this.#d = b64urlToBigInt(privateJwk.d);
    if (privateJwk.p && privateJwk.q && privateJwk.dp && privateJwk.dq && privateJwk.qi) {
      this.#p = b64urlToBigInt(privateJwk.p);
      this.#q = b64urlToBigInt(privateJwk.q);
      this.#dp = b64urlToBigInt(privateJwk.dp);
      this.#dq = b64urlToBigInt(privateJwk.dq);
      this.#qi = b64urlToBigInt(privateJwk.qi);
    }
  }

  static async generate(options = {}) {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: MODULUS_BITS,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: 'SHA-1',
      },
      true,
      ['sign', 'verify'],
    );
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    return new AdbKey(jwk, options);
  }

  /**
   * Import a PEM private key like the ~/.android/adbkey that adb writes: PKCS#8
   * ("BEGIN PRIVATE KEY"), or the older PKCS#1 ("BEGIN RSA PRIVATE KEY").
   * Throws an Error with a user-presentable message if the key is unusable.
   */
  static async fromPem(pem, options = {}) {
    const match = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(pem);
    if (!match) throw new Error('That file is not a PEM-encoded private key.');
    const [, label, body] = match;
    if (label.includes('ENCRYPTED') || /Proc-Type:\s*4,ENCRYPTED/.test(body)) {
      throw new Error('Passphrase-protected keys are not supported.');
    }
    if (label !== 'PRIVATE KEY' && label !== 'RSA PRIVATE KEY') {
      throw new Error(`Unsupported key type "${label}". ADB keys are RSA private keys.`);
    }

    let der;
    try {
      der = base64Decode(body.replace(/\s+/g, ''));
    } catch {
      throw new Error('The key file is corrupt (invalid base64).');
    }
    if (label === 'RSA PRIVATE KEY') der = pkcs1ToPkcs8(der);

    let jwk;
    try {
      const imported = await crypto.subtle.importKey(
        'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' }, true, ['sign']);
      jwk = await crypto.subtle.exportKey('jwk', imported);
    } catch {
      throw new Error('Could not read that file as an RSA private key.');
    }

    // adbd's public key format is fixed at RSA-2048, e = 65537.
    const bits = b64urlToBigInt(jwk.n).toString(2).length;
    if (bits !== MODULUS_BITS) {
      throw new Error(`ADB requires an RSA-2048 key (this one is ${bits}-bit).`);
    }
    if (jwk.e !== 'AQAB') {
      throw new Error('ADB requires a key with public exponent 65537.');
    }
    return new AdbKey(jwk, options);
  }

  /** Round-trips through structuredClone-safe JSON for IndexedDB / localStorage. */
  toJSON() {
    return { jwk: this.#privateJwk, name: this.name };
  }

  static fromJSON({ jwk, name }) {
    return new AdbKey(jwk, { name });
  }

  /**
   * The 524-byte RSAPublicKey blob adbd expects, from
   * system/core/libcrypto_utils/android_pubkey.c:
   *
   *   uint32 modulus_size_words   (64)
   *   uint32 n0inv                (-1 / n[0] mod 2^32)
   *   uint8  modulus[256]         (little-endian)
   *   uint8  rr[256]              (R^2 mod n, R = 2^2048, little-endian)
   *   uint32 exponent             (65537)
   */
  encodePublicKey() {
    const n = this.#n;
    const r32 = 1n << 32n;
    const n0inv = r32 - modInverse(n % r32, r32);
    const rr = modPow(1n << BigInt(MODULUS_BITS), 2n, n);

    const out = new Uint8Array(ANDROID_PUBKEY_ENCODED_SIZE);
    const view = new DataView(out.buffer);
    view.setUint32(0, MODULUS_WORDS, true);
    view.setUint32(4, Number(n0inv), true);
    out.set(bigIntToBytesLE(n, MODULUS_BYTES), 8);
    out.set(bigIntToBytesLE(rr, MODULUS_BYTES), 8 + MODULUS_BYTES);
    view.setUint32(8 + 2 * MODULUS_BYTES, 65537, true);
    return out;
  }

  /**
   * The AUTH(RSAPUBLICKEY) payload: base64 of the blob above, a space, and a
   * "user@host" label. adbd shows the label in the authorization dialog.
   */
  encodePublicKeyLine() {
    return `${base64Encode(this.encodePublicKey())} ${this.name}`;
  }

  /**
   * SHA-256 over the DER SubjectPublicKeyInfo -- the same bytes
   * i2d_RSA_PUBKEY() produces, so this matches the fingerprint adb prints
   * and the one shown in the on-device pairing dialog.
   */
  async fingerprint() {
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: this.#privateJwk.n, e: this.#privateJwk.e, ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' },
      true,
      ['verify'],
    );
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', spki));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Colon-separated upper-case MD5 of the 524-byte public key blob, e.g.
   * "52:2A:80:...:05". This is what Android's "Allow USB debugging?" dialog shows
   * (AdbDebuggingManager hashes the decoded key), so it is what a user compares
   * against. Not the same value as fingerprint() above, which is SHA-256 of the SPKI.
   */
  deviceFingerprint() {
    this.#deviceFingerprint ??= Array.from(
      md5(this.encodePublicKey()), (b) => b.toString(16).padStart(2, '0').toUpperCase(),
    ).join(':');
    return this.#deviceFingerprint;
  }

  /** Sign a 20-byte AUTH token. Returns the 256-byte signature. */
  sign(token) {
    if (token.length !== 20) {
      throw new Error(`unexpected AUTH token size ${token.length}, expected 20`);
    }

    // EMSA-PKCS1-v1_5: 0x00 0x01 <0xff padding> 0x00 <DigestInfo || token>
    const tail = SHA1_DIGEST_INFO.length + token.length;
    const em = new Uint8Array(MODULUS_BYTES).fill(0xff);
    em[0] = 0x00;
    em[1] = 0x01;
    em[MODULUS_BYTES - tail - 1] = 0x00;
    em.set(SHA1_DIGEST_INFO, MODULUS_BYTES - tail);
    em.set(token, MODULUS_BYTES - token.length);

    const m = bytesToBigIntBE(em);
    const s = this.#dp !== undefined ? this.#signCrt(m) : modPow(m, this.#d, this.#n);
    return bigIntToBytesBE(s, MODULUS_BYTES);
  }

  #signCrt(m) {
    const m1 = modPow(m % this.#p, this.#dp, this.#p);
    const m2 = modPow(m % this.#q, this.#dq, this.#q);
    let diff = (m1 - m2) % this.#p;
    if (diff < 0n) diff += this.#p;
    const h = (this.#qi * diff) % this.#p;
    return m2 + this.#q * h;
  }
}

const STORAGE_KEY = 'webadb.keys.v2';
const LEGACY_STORAGE_KEY = 'webadb.key.v1';  // the single key stored before multi-key support

function defaultStorage() {
  // Merely touching localStorage throws when the browser blocks site storage.
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * The browser's stand-in for ~/.android/adbkey (plus ADB_VENDOR_KEYS): an ordered list
 * of keys kept in localStorage. AdbConnection signs the device's AUTH token with each key
 * in list order and, if none is recognised, offers the last key for on-device approval --
 * so a newly added key is only ever offered once the older ones have been tried.
 *
 * Keep keys stable: a key the user deletes here means a fresh authorization prompt on the
 * device. With no usable storage the list lives in memory for the life of the store object.
 */
export class AdbKeyStore {
  #storage;
  #memory = '[]';

  constructor(storage = defaultStorage()) {
    this.#storage = storage ?? null;
  }

  /** @returns {AdbKey[]} in stored order; unreadable entries are skipped. */
  list() {
    return this.#read();
  }

  /** The keys to connect with, generating a first one if the list is empty. */
  async loadOrCreate(options = {}) {
    const keys = this.#read();
    return keys.length > 0 ? keys : [await this.generate(options)];
  }

  /** Generate a new key and append it to the list. */
  async generate(options = {}) {
    const key = await AdbKey.generate(options);
    // Re-read after the await: generation is slow and another tab may have written meanwhile.
    const keys = this.#read();
    keys.push(key);
    this.#write(keys);
    return key;
  }

  /**
   * Add a key from PEM text (see AdbKey.fromPem). A key already in the list is not added twice.
   * @returns {{key: AdbKey, added: boolean}}
   */
  async importPem(pem, options = {}) {
    const key = await AdbKey.fromPem(pem, options);
    const keys = this.#read();
    const existing = keys.find((k) => k.deviceFingerprint() === key.deviceFingerprint());
    if (existing) return { key: existing, added: false };
    keys.push(key);
    this.#write(keys);
    return { key, added: true };
  }

  /** Delete the key with this deviceFingerprint(). @returns {boolean} whether one was removed. */
  remove(fingerprint) {
    const keys = this.#read();
    const kept = keys.filter((k) => k.deviceFingerprint() !== fingerprint);
    if (kept.length === keys.length) return false;
    this.#write(kept);
    return true;
  }

  #read() {
    let raw = this.#storage ? this.#storage.getItem(STORAGE_KEY) : this.#memory;
    if (raw === null) {
      // First run since multi-key support: adopt the old single key, then drop the old copy so a
      // key deleted later does not linger in localStorage.
      const legacy = this.#storage.getItem(LEGACY_STORAGE_KEY);
      raw = legacy === null ? '[]' : `[${legacy}]`;
      const keys = AdbKeyStore.#parse(raw);
      this.#write(keys);
      if (legacy !== null) this.#storage.removeItem(LEGACY_STORAGE_KEY);
      return keys;
    }
    return AdbKeyStore.#parse(raw);
  }

  static #parse(raw) {
    let entries;
    try { entries = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(entries)) return [];
    const keys = [];
    for (const entry of entries) {
      try { keys.push(AdbKey.fromJSON(entry)); } catch { /* corrupt entry: skip it */ }
    }
    return keys;
  }

  #write(keys) {
    const json = JSON.stringify(keys.map((k) => k.toJSON()));
    if (this.#storage) this.#storage.setItem(STORAGE_KEY, json);
    else this.#memory = json;
  }
}

/**
 * Single-key convenience kept for existing callers: the key AdbConnection would offer for
 * approval (the last in the list), generating one on first run.
 */
export async function loadOrCreateKey(storage = defaultStorage(), options = {}) {
  const keys = await new AdbKeyStore(storage).loadOrCreate(options);
  return keys[keys.length - 1];
}
