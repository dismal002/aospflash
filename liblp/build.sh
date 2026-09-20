#!/usr/bin/env bash
# build.sh — compile liblp + our wrapper into a single WASM module.
#
# Layout this script expects:
#   liblp/                  <- the AOSP liblp source you already have
#     builder.cpp
#     super_layout_builder.cpp
#     reader.cpp
#     writer.cpp
#     utility.cpp
#     include/liblp/...
#     (do NOT compile the original property_fetcher.cpp or images.cpp — see notes)
#   wrapper/
#     wasm_shim.cpp
#     wasm_property_fetcher.cpp
#   compat/
#     openssl/sha.h
#     cutils/android_get_control_file.h
#   libbase/                <- system/core/base from AOSP (NOT included here —
#                              pull it separately, see README)
#
# Requires: emsdk activated (`source /path/to/emsdk/emsdk_env.sh`)

set -euo pipefail

LIBLP_DIR="${LIBLP_DIR:-.}"
LIBBASE_DIR="${LIBBASE_DIR:-./libbase}"
OUT_DIR="${OUT_DIR:-./out}"
mkdir -p "$OUT_DIR"

# liblp source files we actually need. Deliberately excludes:
#   - property_fetcher.cpp  (replaced entirely by wrapper/wasm_property_fetcher.cpp)
#   - images.cpp             (only needed for writing real sparse .img files to
#                              disk — SuperLayoutBuilder/MetadataBuilder never
#                              call into it for the in-memory blob flow used here)
#   - partition_opener.cpp   (real block-device opening; unused in-browser)
LIBLP_SRCS=(
  "$LIBLP_DIR/liblp/builder.cpp"
  "$LIBLP_DIR/liblp/super_layout_builder.cpp"
  "$LIBLP_DIR/liblp/reader.cpp"
  "$LIBLP_DIR/liblp/writer.cpp"
  "$LIBLP_DIR/liblp/utility.cpp"
  "$LIBLP_DIR/liblp/images.cpp"
)

# Minimal libbase pieces liblp actually touches (file I/O helpers, string
# formatting, logging). Pull the real files from AOSP system/core/base;
# logging.cpp/logging.h already support a non-Android host build.
LIBBASE_SRCS=(
  "$LIBBASE_DIR/logging.cpp"
  "$LIBBASE_DIR/stringprintf.cpp"
  "$LIBBASE_DIR/file.cpp"
  "$LIBBASE_DIR/strings.cpp"
)

WRAPPER_SRCS=(
  wrapper/wasm_shim.cpp
  wrapper/wasm_property_fetcher.cpp
)

em++ \
  -std=c++20 \
  -O2 \
  -fno-exceptions \
  -D_FILE_OFFSET_BITS=64 \
  -D__HOST__=1 \
  -I "$LIBLP_DIR/liblp/include" \
  -I "$LIBLP_DIR/liblp" \
  -I "$LIBLP_DIR/libsparse/include" \
  -I "$LIBBASE_DIR/include" \
  -I compat \
  "${LIBLP_SRCS[@]}" \
  "${LIBBASE_SRCS[@]}" \
  "${WRAPPER_SRCS[@]}" \
  --bind \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=LiblpModule \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s ENVIRONMENT=web \
  -o "$OUT_DIR/liblp.js"

echo "Built $OUT_DIR/liblp.js + $OUT_DIR/liblp.wasm"
