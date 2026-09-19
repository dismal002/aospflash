// compat/cutils/android_get_control_file.h
//
// utility.cpp's GetDescriptorSize() calls android_get_control_file() as a
// fallback when statting a raw fd fails. That whole function is only ever
// reached when liblp is asked to size a *real* block device file descriptor
// (init-style control-file handoff) — a code path our WASM build never
// takes, since we only ever operate on in-memory blobs via
// ReadFromImageBlob()/MetadataBuilder::New(metadata). This stub just lets
// utility.cpp compile unmodified; it is never actually called.

#pragma once

inline int android_get_control_file(const char* /*path*/) {
    return -1;
}
