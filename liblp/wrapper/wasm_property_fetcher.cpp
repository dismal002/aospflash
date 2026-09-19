// wasm_property_fetcher.cpp
//
// liblp reads a handful of Android system properties (ro.boot.slot_suffix,
// ro.virtual_ab.enabled, etc — both appear as strings in the original binary,
// confirming this). None of that exists in a browser, so this file *replaces*
// liblp's own property_fetcher.cpp entirely (do not compile the original
// alongside this one — see build.sh) and installs our own IPropertyFetcher
// that returns values passed in from JS, instead of the real on-device
// PropertyFetcher (which calls android::base::GetProperty ->
// __system_property_get and won't link under Emscripten).
//
// This file provides every symbol liblp/property_fetcher.h promises:
// IPropertyFetcher::GetInstance(), IPropertyFetcher::OverrideForTesting(),
// and a (trivial, never-really-used) PropertyFetcher::GetProperty/
// GetBoolProperty, so nothing in the rest of liblp needs to change or link
// against android-base's real property implementation.

#include <liblp/property_fetcher.h>

#include <memory>
#include <string>
#include <unordered_map>

#include <emscripten/bind.h>

namespace android {
namespace fs_mgr {

// Trivial stand-ins for the real on-device implementation — always used via
// the WasmPropertyFetcher override below in practice, but defined so the
// class is concrete and linkable on its own.
std::string PropertyFetcher::GetProperty(const std::string&, const std::string& default_value) {
    return default_value;
}

bool PropertyFetcher::GetBoolProperty(const std::string&, bool default_value) {
    return default_value;
}

namespace {
std::unique_ptr<IPropertyFetcher>* GetInstanceAllocation() {
    static std::unique_ptr<IPropertyFetcher> instance = std::make_unique<PropertyFetcher>();
    return &instance;
}
}  // namespace

IPropertyFetcher* IPropertyFetcher::GetInstance() {
    return GetInstanceAllocation()->get();
}

void IPropertyFetcher::OverrideForTesting(std::unique_ptr<IPropertyFetcher>&& fetcher) {
    GetInstanceAllocation()->swap(fetcher);
    fetcher.reset();
}

}  // namespace fs_mgr
}  // namespace android

namespace {

class WasmPropertyFetcher : public android::fs_mgr::IPropertyFetcher {
  public:
    std::string GetProperty(const std::string& key, const std::string& defaultValue) override {
        auto it = props_.find(key);
        return it != props_.end() ? it->second : defaultValue;
    }

    bool GetBoolProperty(const std::string& key, bool defaultValue) override {
        auto it = props_.find(key);
        if (it == props_.end()) return defaultValue;
        return it->second == "1" || it->second == "true";
    }

    void Set(const std::string& key, const std::string& value) { props_[key] = value; }

  private:
    std::unordered_map<std::string, std::string> props_;
};

WasmPropertyFetcher* g_fetcher = nullptr;

}  // namespace

// Call this once from JS before using MetadataBuilder, e.g.:
//   Module.setDeviceProperty("ro.boot.slot_suffix", "_a");
//   Module.setDeviceProperty("ro.virtual_ab.enabled", "1");
// Any property not explicitly set falls back to whatever default liblp's
// caller passed to GetProperty()/GetBoolProperty() at each call site.
void setDeviceProperty(const std::string& key, const std::string& value) {
    if (!g_fetcher) {
        auto owned = std::make_unique<WasmPropertyFetcher>();
        g_fetcher = owned.get();
        android::fs_mgr::IPropertyFetcher::OverrideForTesting(std::move(owned));
    }
    g_fetcher->Set(key, value);
}

EMSCRIPTEN_BINDINGS(liblp_wasm_property_fetcher) {
    emscripten::function("setDeviceProperty", &setDeviceProperty);
}
