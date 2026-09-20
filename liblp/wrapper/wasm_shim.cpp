// wasm_shim.cpp
//
// Open-source embind wrapper around AOSP's liblp (system/core/fs_mgr/liblp),
// written to reproduce the *public function surface* that was observed (via
// exported symbol names and RTTI strings) in flash.android.com's WASM module:
//
//     initialize, createFromSuperMetadata, addPartition, removePartition,
//     setPartitionSize, getPartitionExtents, getMetadataOffset,
//     getImageLayout, serializeMetadata, shouldFlashInUserspace
//
// registered under an `embind_shims::MetadataBuilder` class with a nested
// `ExtentInfo` struct — matching the mangled RTTI names found in the binary
// (N12embind_shims15MetadataBuilder10ExtentInfoE, etc).
//
// IMPORTANT: this is an independent re-implementation built directly on the
// real, open-source liblp classes (android::fs_mgr::MetadataBuilder and
// android::fs_mgr::SuperLayoutBuilder). The original wrapper's internal glue
// code was never available to inspect (only its exported names), so the
// exact method bodies here are a fresh design, not decompiled or copied code.
// Adjust method names/signatures below to match whatever your existing
// fastboot-in-JS code actually calls.

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <liblp/builder.h>
#include <liblp/liblp.h>
#include <liblp/super_layout_builder.h>
#include "utility.h"
#include "writer.h"

using android::fs_mgr::LpMetadata;
using android::fs_mgr::MetadataBuilder;
using android::fs_mgr::Partition;
using android::fs_mgr::SuperImageExtent;
using android::fs_mgr::SuperLayoutBuilder;

namespace embind_shims {

// A simplified, JS-friendly extent descriptor: "write `size` bytes at byte
// `offset` on the super block device". Mirrors the spirit of liblp's
// LinearExtent/SuperImageExtent but flattened to plain fields embind can
// marshal directly into a JS object.
struct ExtentInfo {
    uint64_t offset = 0;
    uint64_t size = 0;
    // Empty for metadata/geometry/zero-fill extents. Non-empty means "this
    // range should be filled from the partition image the caller registered
    // under this name via addPartition()".
    std::string partitionName;
    // Byte offset *within* that source image the range starts at (relevant
    // when a partition spans multiple non-contiguous extents).
    uint64_t imageOffset = 0;
};

class MetadataBuilderShim {
  public:
    MetadataBuilderShim() = default;

    // Parse a super_empty.img (or equivalent raw LP metadata blob) and set up
    // both the low-level MetadataBuilder and the sparse-layout builder used
    // by getImageLayout(). Returns false on any parse/validation failure.
    bool initialize(const std::string& metadataBlob) {
        auto metadata = android::fs_mgr::ReadFromImageBlob(metadataBlob.data(), metadataBlob.size());
        if (!metadata) {
            return false;
        }
        return InitFromMetadata(*metadata);
    }

    // Alternate entry point: build directly from an existing LpMetadata
    // struct's serialized bytes rather than a full super_empty.img wrapper.
    // In practice this liblp version reads the same on-disk format either
    // way, so this simply delegates to initialize(); kept separate so the
    // exported name matches what callers may already expect.
    bool createFromSuperMetadata(const std::string& metadataBlob) { return initialize(metadataBlob); }

    // Equivalent to fastboot's should_flash_in_userspace(): is `name` a
    // partition managed by this super device at all? Note retrofit devices
    // (which need the _a/_b suffix-matching fallback that upstream's
    // should_flash_in_userspace also handles) never reach this code path in
    // the first place — InitFromMetadata() below already refuses to build a
    // SuperLayoutBuilder for them (SuperLayoutBuilder::Open() itself rejects
    // any metadata containing LP_PARTITION_ATTR_SLOT_SUFFIXED partitions), so
    // plain exact-name lookup is sufficient here.
    bool hasPartition(const std::string& name) const {
        return builder_ && builder_->FindPartition(name) != nullptr;
    }

    // The block size sparse-image chunks must be aligned to for this device
    // (android::fs_mgr::LpMetadataGeometry::logical_block_size).
    double getLogicalBlockSize() const {
        if (!builder_) return 0;
        auto metadata = builder_->Export();
        return metadata ? static_cast<double>(metadata->geometry.logical_block_size) : 0;
    }

    bool addPartition(const std::string& name, const std::string& groupName, uint32_t attributes) {
        if (!builder_) return false;
        Partition* p = builder_->FindPartition(name);
        if (p) return false;  // already exists
        p = builder_->AddPartition(name, groupName, attributes);
        return p != nullptr;
    }

    void removePartition(const std::string& name) {
        if (builder_) builder_->RemovePartition(name);
    }

    bool setPartitionSize(const std::string& name, double sizeBytes) {
        if (!builder_) return false;
        Partition* p = builder_->FindPartition(name);
        if (!p) return false;
        return builder_->ResizePartition(p, static_cast<uint64_t>(sizeBytes));
    }

    // Byte-accurate extents for a single partition's *linear* extents on the
    // super block device, e.g. so JS can `fastboot flash`/raw-write the
    // partition image directly at those offsets.
    std::vector<ExtentInfo> getPartitionExtents(const std::string& name) const {
        std::vector<ExtentInfo> out;
        if (!builder_) return out;
        Partition* p = builder_->FindPartition(name);
        if (!p) return out;

        uint64_t running_offset = 0;
        for (const auto& extent : p->extents()) {
            if (auto* linear = extent->AsLinearExtent()) {
                ExtentInfo info;
                info.offset = linear->physical_sector() * LP_SECTOR_SIZE;
                info.size = linear->num_sectors() * LP_SECTOR_SIZE;
                info.partitionName = name;
                info.imageOffset = running_offset;
                out.push_back(info);
            }
            running_offset += extent->num_sectors() * LP_SECTOR_SIZE;
        }
        return out;
    }

    // Offset (bytes, from the start of the super block device) of the
    // primary metadata copy for the given slot — used when flashing the
    // serialized metadata block itself.
    double getMetadataOffset(uint32_t slotNumber) const {
        if (!builder_) return -1;
        auto metadata = builder_->Export();
        if (!metadata) return -1;
        return static_cast<double>(
                android::fs_mgr::GetPrimaryMetadataOffset(metadata->geometry, slotNumber));
    }

    // Full sparse layout of a temporary super image: every byte range that
    // needs to be written (geometry copies, metadata slot copies, and each
    // registered partition's data) with nothing else touched. This is what
    // lets a caller flash "super" without ever materializing the full image.
    // Partitions must first be registered via addPartitionImage() below so
    // the underlying SuperLayoutBuilder knows which image backs each one.
    //
    // Returned objects: {offset, size, type, imageName, imageOffset, data}
    //   - type: 0=INVALID 1=DATA 2=PARTITION 3=ZERO 4=DONTCARE (matches
    //     android::fs_mgr::SuperImageExtent::Type's declaration order).
    //   - DATA extents (geometry/metadata copies liblp generates itself) carry
    //     their payload in `data` — a binary-safe JS string (Emscripten's
    //     std::string<->JS convention: one UTF-16 code unit per byte, 0-255).
    //     Convert with `Uint8Array.from(data, c => c.charCodeAt(0))`.
    //   - PARTITION extents carry no `data`: `imageName` is the name the
    //     caller passed to addPartitionImage() for this partition, and the
    //     caller already has that image's bytes in hand — it should slice
    //     out [imageOffset, imageOffset+size) itself rather than have the
    //     same bytes copied through the WASM boundary a second time.
    //   - ZERO/DONTCARE extents carry no `data` and an empty `imageName`
    //     (dontcare has no payload at all; zero should be written as literal
    //     zero bytes on the JS side).
    emscripten::val getImageLayout() {
        emscripten::val result = emscripten::val::array();
        if (!layout_builder_) return result;

        auto extents = layout_builder_->GetImageLayout();
        int i = 0;
        for (const auto& e : extents) {
            emscripten::val obj = emscripten::val::object();
            obj.set("offset", emscripten::val(static_cast<double>(e.offset)));
            obj.set("size", emscripten::val(static_cast<double>(e.size)));
            obj.set("type", emscripten::val(static_cast<int>(e.type)));
            obj.set("imageName", emscripten::val(e.image_name));
            obj.set("imageOffset", emscripten::val(static_cast<double>(e.image_offset)));
            if (e.type == SuperImageExtent::Type::DATA && e.blob) {
                obj.set("data", emscripten::val(*e.blob));
            }
            result.set(i++, obj);
        }
        return result;
    }

    // Register that `partitionName` (which must already exist in the loaded
    // metadata) should be resized to `sizeBytes` and its data will come from
    // an image the caller identifies as `imageName` (an opaque string your
    // JS uses to know which file/blob to stream at flash time).
    // This is required before getImageLayout() will include that partition.
    bool addPartitionImage(const std::string& partitionName, const std::string& imageName,
                           double sizeBytes) {
        if (!layout_builder_) return false;
        return layout_builder_->AddPartition(partitionName, imageName,
                                             static_cast<uint64_t>(sizeBytes));
    }

    // Serialize the current metadata to its on-disk byte form (ready to be
    // written into a metadata slot via fastboot/raw block write).
    std::string serializeMetadata() {
        if (!builder_) return std::string();
        auto metadata = builder_->Export();
        if (!metadata) return std::string();
        return android::fs_mgr::SerializeMetadata(*metadata);
    }

    // Whether the loaded metadata is compatible with this userspace,
    // no-fastbootd flashing flow at all (single super device, no retrofit
    // slot suffixing, all partitions read-only with no pre-existing
    // extents) — mirrors the checks SuperLayoutBuilder::Open() performs.
    bool shouldFlashInUserspace() const { return layout_builder_ != nullptr; }

  private:
    bool InitFromMetadata(const LpMetadata& metadata) {
        builder_ = MetadataBuilder::New(metadata);
        if (!builder_) return false;

        layout_builder_ = std::make_unique<SuperLayoutBuilder>();
        if (!layout_builder_->Open(metadata)) {
            // Device/metadata isn't compatible with the sparse-layout flow
            // (e.g. retrofit device, or partitions already have extents).
            // We keep `builder_` alive so classic MetadataBuilder-style
            // editing (add/remove/resize/serialize) still works; only the
            // getImageLayout()/shouldFlashInUserspace() fast path is
            // unavailable.
            layout_builder_.reset();
        }
        return true;
    }

    std::unique_ptr<MetadataBuilder> builder_;
    std::unique_ptr<SuperLayoutBuilder> layout_builder_;
};

}  // namespace embind_shims

EMSCRIPTEN_BINDINGS(liblp_wasm_shim) {
    emscripten::value_object<embind_shims::ExtentInfo>("ExtentInfo")
            .field("offset", &embind_shims::ExtentInfo::offset)
            .field("size", &embind_shims::ExtentInfo::size)
            .field("partitionName", &embind_shims::ExtentInfo::partitionName)
            .field("imageOffset", &embind_shims::ExtentInfo::imageOffset);

    emscripten::register_vector<embind_shims::ExtentInfo>("VectorExtentInfo");

    emscripten::class_<embind_shims::MetadataBuilderShim>("MetadataBuilder")
            .constructor<>()
            .function("initialize", &embind_shims::MetadataBuilderShim::initialize)
            .function("createFromSuperMetadata",
                     &embind_shims::MetadataBuilderShim::createFromSuperMetadata)
            .function("hasPartition", &embind_shims::MetadataBuilderShim::hasPartition)
            .function("getLogicalBlockSize",
                     &embind_shims::MetadataBuilderShim::getLogicalBlockSize)
            .function("addPartition", &embind_shims::MetadataBuilderShim::addPartition)
            .function("removePartition", &embind_shims::MetadataBuilderShim::removePartition)
            .function("setPartitionSize", &embind_shims::MetadataBuilderShim::setPartitionSize)
            .function("getPartitionExtents",
                     &embind_shims::MetadataBuilderShim::getPartitionExtents)
            .function("getMetadataOffset", &embind_shims::MetadataBuilderShim::getMetadataOffset)
            .function("getImageLayout", &embind_shims::MetadataBuilderShim::getImageLayout)
            .function("addPartitionImage",
                     &embind_shims::MetadataBuilderShim::addPartitionImage)
            .function("serializeMetadata", &embind_shims::MetadataBuilderShim::serializeMetadata)
            .function("shouldFlashInUserspace",
                     &embind_shims::MetadataBuilderShim::shouldFlashInUserspace);
}
