#ifndef _EXT4_UTILS_EXT4_UTILS_H_
#define _EXT4_UTILS_EXT4_UTILS_H_
#include <stdint.h>
#define EXT4_SUPER_MAGIC 0xEF53
#ifdef __cplusplus
extern "C" {
#endif
uint64_t get_block_device_size(int fd);
#ifdef __cplusplus
}
#endif
#endif
