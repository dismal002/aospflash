// compat/openssl/sha.h
//
// utility.cpp's only use of OpenSSL is three calls: SHA256_Init/Update/Final,
// used to checksum geometry/metadata blocks. Rather than port all of OpenSSL
// to Emscripten just for that, this header implements the same three
// functions with a small from-scratch SHA-256 (FIPS 180-4), so utility.cpp
// needs zero changes. Put this directory earlier on the -I search path than
// any real OpenSSL headers so this one wins.
//
// This is a standard, public specification (FIPS 180-4) implemented here
// from scratch — not copied from any codebase.

#pragma once

#include <cstdint>
#include <cstring>

typedef struct SHA256_CTX_st {
    uint32_t state[8];
    uint64_t bitcount;
    uint8_t buffer[64];
    size_t buffer_len;
} SHA256_CTX;

namespace wasm_sha256_detail {

inline uint32_t rotr(uint32_t x, uint32_t n) { return (x >> n) | (x << (32 - n)); }

inline void transform(uint32_t state[8], const uint8_t block[64]) {
    static const uint32_t k[64] = {
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2};

    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
        w[i] = (uint32_t(block[i * 4]) << 24) | (uint32_t(block[i * 4 + 1]) << 16) |
               (uint32_t(block[i * 4 + 2]) << 8) | uint32_t(block[i * 4 + 3]);
    }
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }

    uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
    uint32_t e = state[4], f = state[5], g = state[6], h = state[7];

    for (int i = 0; i < 64; i++) {
        uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        uint32_t ch = (e & f) ^ (~e & g);
        uint32_t temp1 = h + S1 + ch + k[i] + w[i];
        uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t temp2 = S0 + maj;

        h = g;
        g = f;
        f = e;
        e = d + temp1;
        d = c;
        c = b;
        b = a;
        a = temp1 + temp2;
    }

    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
}

}  // namespace wasm_sha256_detail

inline int SHA256_Init(SHA256_CTX* ctx) {
    static const uint32_t iv[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    memcpy(ctx->state, iv, sizeof(iv));
    ctx->bitcount = 0;
    ctx->buffer_len = 0;
    return 1;
}

inline int SHA256_Update(SHA256_CTX* ctx, const void* data, size_t len) {
    const uint8_t* p = static_cast<const uint8_t*>(data);
    ctx->bitcount += static_cast<uint64_t>(len) * 8;

    while (len > 0) {
        size_t space = 64 - ctx->buffer_len;
        size_t take = len < space ? len : space;
        memcpy(ctx->buffer + ctx->buffer_len, p, take);
        ctx->buffer_len += take;
        p += take;
        len -= take;

        if (ctx->buffer_len == 64) {
            wasm_sha256_detail::transform(ctx->state, ctx->buffer);
            ctx->buffer_len = 0;
        }
    }
    return 1;
}

inline int SHA256_Final(uint8_t digest[32], SHA256_CTX* ctx) {
    uint8_t pad[72];
    size_t pad_len = 0;
    pad[pad_len++] = 0x80;

    size_t used = ctx->buffer_len;
    size_t zeros = (used < 56) ? (56 - used) : (120 - used);
    memset(pad + pad_len, 0, zeros - 1);
    pad_len += zeros - 1;

    uint64_t bitcount = ctx->bitcount;
    for (int i = 7; i >= 0; i--) {
        pad[pad_len++] = static_cast<uint8_t>(bitcount >> (i * 8));
    }

    SHA256_Update(ctx, pad, pad_len);

    for (int i = 0; i < 8; i++) {
        digest[i * 4] = static_cast<uint8_t>(ctx->state[i] >> 24);
        digest[i * 4 + 1] = static_cast<uint8_t>(ctx->state[i] >> 16);
        digest[i * 4 + 2] = static_cast<uint8_t>(ctx->state[i] >> 8);
        digest[i * 4 + 3] = static_cast<uint8_t>(ctx->state[i]);
    }
    return 1;
}
