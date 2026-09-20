#ifndef _ANDROID_LOG_H
#define _ANDROID_LOG_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum LogId {
  LOG_ID_MIN = 0,
  LOG_ID_MAIN = 0,
  LOG_ID_RADIO = 1,
  LOG_ID_EVENTS = 2,
  LOG_ID_SYSTEM = 3,
  LOG_ID_CRASH = 4,
  LOG_ID_STATS = 5,
  LOG_ID_SECURITY = 6,
  LOG_ID_KERNEL = 7,
  LOG_ID_MAX,
  LOG_ID_DEFAULT = 0x7FFFFFFF
} log_id_t;

typedef enum android_LogPriority {
  ANDROID_LOG_UNKNOWN = 0,
  ANDROID_LOG_DEFAULT,
  ANDROID_LOG_VERBOSE,
  ANDROID_LOG_DEBUG,
  ANDROID_LOG_INFO,
  ANDROID_LOG_WARN,
  ANDROID_LOG_ERROR,
  ANDROID_LOG_FATAL,
  ANDROID_LOG_SILENT,
} android_LogPriority;

struct __android_log_message {
  size_t struct_size;
  int32_t buffer_id;
  int32_t priority;
  const char* tag;
  const char* file;
  uint32_t line;
  const char* message;
};

typedef void (*__android_log_aborter_function)(const char* abort_message);
typedef void (*__android_log_logger_function)(const struct __android_log_message* log_message);

inline void __android_log_set_default_tag(const char* tag) {}
inline void __android_log_buf_print(int buf_id, int priority, const char* tag, const char* fmt, ...) {}
inline void __android_log_set_logger(__android_log_logger_function logger) {}
inline void __android_log_set_aborter(__android_log_aborter_function aborter) {}
inline void __android_log_call_aborter(const char* msg) {}
inline int __android_log_get_minimum_priority(void) { return ANDROID_LOG_INFO; }
inline int __android_log_is_loggable(int priority, const char* tag, int default_priority) { return 1; }
inline int __android_log_set_minimum_priority(int priority) { return ANDROID_LOG_INFO; }
inline void __android_log_logd_logger(const struct __android_log_message* log_message) {}
inline void __android_log_write_log_message(struct __android_log_message* log_message) {}

#ifdef __cplusplus
}
#endif

#endif
