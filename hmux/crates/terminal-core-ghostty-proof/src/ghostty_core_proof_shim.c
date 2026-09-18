#if defined(__linux__)
#define _GNU_SOURCE
#endif

#include <ghostty/vt.h>

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

// Zig's Windows standard library uses this ntdll export to keep its module
// view current, but the reviewed Windows SDK import library does not publish
// the symbol. Resolve the OS-owned export at this native ABI leaf so the
// provider-neutral Rust core does not acquire a Windows compatibility path.
LONG NTAPI LdrRegisterDllNotification(ULONG flags,
                                      PVOID notification_function,
                                      PVOID context,
                                      PVOID *cookie) {
  typedef LONG(NTAPI * RegisterDllNotification)(ULONG, PVOID, PVOID, PVOID *);
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  if (ntdll == NULL) return (LONG)0xc0000002L;
  RegisterDllNotification register_notification =
      (RegisterDllNotification)GetProcAddress(ntdll,
                                              "LdrRegisterDllNotification");
  if (register_notification == NULL) return (LONG)0xc0000002L;
  return register_notification(flags, notification_function, context, cookie);
}
#endif

#if defined(__linux__)
#include <linux/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

// Zig 0.16 emits the libc statx call for the reviewed musl Ghostty archive,
// while Rust 1.85's bundled musl libc predates that exported wrapper. Keep the
// ABI at this native leaf and delegate directly to the stable Linux syscall;
// the macOS proof never compiles this branch.
int statx(int directory_fd,
          const char *restrict path,
          int flags,
          unsigned int mask,
          struct statx *restrict result) {
  return (int)syscall(SYS_statx, directory_fd, path, flags, mask, result);
}
#endif

typedef struct HmuxGhosttyCore HmuxGhosttyCore;
/* Bytes of OSC 0/2 title carried per projection header. A pane title is a
   short human label; anything longer is copied truncated and flagged, so
   the FFI struct stays plain data with no allocation across the boundary. */
enum { HMUX_GHOSTTY_TITLE_CAPACITY = 512 };

typedef struct {
  size_t reply_len;
  uint8_t reply_overflow;
  size_t clipboard_len;
  uint8_t clipboard_overflow;
  uint8_t dirty_kind;
  uint8_t projection_degraded;
  size_t dirty_rows;
  size_t visited_rows;
  size_t total_rows;
  size_t scrollback_rows;
} HmuxGhosttyMutation;

typedef struct {
  uint16_t columns;
  uint16_t rows;
  uint16_t cursor_column;
  uint16_t cursor_row;
  uint8_t alternate_screen;
  uint8_t cursor_visible;
  uint8_t application_cursor;
  uint8_t bracketed_paste;
  size_t total_rows;
  size_t scrollback_rows;
  /* FNV-1a of the current title. The observation is what decides whether a
     write changed the presentation; without this a title-only OSC would
     never publish a frame until some cell happened to repaint. */
  uint64_t title_hash;
} HmuxGhosttyObservation;

typedef struct {
  uint8_t r;
  uint8_t g;
  uint8_t b;
} HmuxGhosttyRgb;

typedef struct {
  uint8_t fg_kind;
  uint32_t fg_value;
  uint8_t bg_kind;
  uint32_t bg_value;
  uint8_t underline_kind;
  uint32_t underline_value;
  uint16_t flags;
  int32_t underline;
} HmuxGhosttyCellStyle;

typedef struct {
  uint16_t row;
  uint16_t column;
  uint8_t width;
  const uint8_t *grapheme;
  size_t grapheme_len;
  HmuxGhosttyCellStyle style;
  const uint8_t *hyperlink;
  size_t hyperlink_len;
} HmuxGhosttyProjectedCell;

typedef struct {
  uint16_t columns;
  uint16_t rows;
  uint16_t cursor_column;
  uint16_t cursor_row;
  uint8_t alternate_screen;
  uint8_t cursor_visible;
  uint8_t cursor_blinking;
  uint8_t cursor_shape;
  uint8_t cursor_wrap_pending;
  uint8_t application_cursor;
  uint8_t application_keypad;
  uint8_t bracketed_paste;
  uint8_t focus_reporting;
  uint8_t insert_mode;
  uint8_t origin_mode;
  uint8_t auto_wrap;
  uint8_t newline_mode;
  uint8_t reverse_wrap;
  uint8_t synchronized_output;
  uint8_t mouse_tracking;
  uint8_t mouse_encoding;
  HmuxGhosttyRgb foreground;
  HmuxGhosttyRgb background;
  HmuxGhosttyRgb cursor;
  HmuxGhosttyRgb palette[256];
  uint8_t title[HMUX_GHOSTTY_TITLE_CAPACITY];
  uint16_t title_len;
  uint8_t title_truncated;
} HmuxGhosttyProjectionHeader;

typedef int (*HmuxGhosttyRowCallback)(void *userdata,
                                      uint16_t row,
                                      uint8_t wraps,
                                      uint8_t continues);
typedef int (*HmuxGhosttyCellCallback)(
    void *userdata, const HmuxGhosttyProjectedCell *cell);
typedef int (*HmuxGhosttyGridRowCallback)(
    void *userdata,
    uint16_t row,
    uint8_t wraps,
    uint8_t continues,
    const GhosttyGridRef *reference,
    uint16_t columns);
typedef int (*HmuxGhosttyArchiveRowCallback)(void *userdata,
                                             uint16_t row,
                                             uint8_t wraps,
                                             uint8_t continues,
                                             uint64_t logical_line_id,
                                             uint32_t logical_cell_offset);
typedef int (*HmuxGhosttyArchiveGridRowCallback)(
    void *userdata,
    uint16_t row,
    uint8_t wraps,
    uint8_t continues,
    uint64_t logical_line_id,
    uint32_t logical_cell_offset,
    const GhosttyGridRef *reference,
    uint16_t columns);

typedef struct {
  size_t index_nodes_visited;
  size_t chunks_visited;
  size_t cells_visited;
} HmuxGhosttyArchiveProjectionWork;

extern int hmux_ghostty_history_rows_from_tracked_ref(
    void *reference,
    size_t maximum_rows,
    HmuxGhosttyGridRowCallback callback,
    void *userdata,
    size_t *visited_rows,
    uint8_t *has_more_before,
    uint8_t *has_more_after,
    int32_t *cursor_row,
    uint16_t *cursor_column);
extern int hmux_ghostty_tracked_grid_ref_move_rows(
    void *reference,
    int64_t delta,
    int64_t *moved_rows);
extern int hmux_ghostty_history_archive_project_grid(
    void *archive,
    uint64_t logical_line_id,
    uint32_t logical_cell_offset,
    uint16_t columns,
    size_t maximum_rows,
    HmuxGhosttyArchiveGridRowCallback callback,
    void *userdata,
    HmuxGhosttyArchiveProjectionWork *work,
    uint8_t *has_more_before,
    uint8_t *has_more_after);

struct HmuxGhosttyCore {
  GhosttyTerminal terminal;
  GhosttyRenderState projector;
  GhosttyRenderStateRowIterator projector_rows;
  GhosttyRenderStateRowCells projector_cells;
  GhosttyKeyEncoder key_encoder;
  GhosttyKeyEvent key_event;
  GhosttyMouseEncoder mouse_encoder;
  GhosttyMouseEvent mouse_event;
  uint8_t *reply_buffer;
  size_t reply_capacity;
  size_t reply_len;
  bool reply_overflow;
  uint8_t *clipboard_buffer;
  size_t clipboard_capacity;
  size_t clipboard_len;
  bool clipboard_overflow;
};

enum { HMUX_GHOSTTY_SHIM_ERROR = -100 };

static int hmux_observe(HmuxGhosttyCore *core,
                        HmuxGhosttyObservation *observation);

/* The title Ghostty tracks from OSC 0/2 — a borrowed view, valid only until
   the next vt_write, so callers copy or hash it before returning. A terminal
   that has never been given a title, live or restored from a snapshot, answers
   success with an empty string (pinned by the proof tests), so a failure here
   is a real engine failure and propagates like every other getter's. */
static GhosttyResult hmux_read_title(HmuxGhosttyCore *core,
                                     GhosttyString *title) {
  title->ptr = NULL;
  title->len = 0;
  return ghostty_terminal_get(core->terminal, GHOSTTY_TERMINAL_DATA_TITLE,
                              title);
}

static uint64_t hmux_fnv1a64(const uint8_t *bytes, size_t len) {
  uint64_t hash = 1469598103934665603ull;
  for (size_t index = 0; index < len; index++) {
    hash ^= bytes[index];
    hash *= 1099511628211ull;
  }
  return hash;
}

static void hmux_release(HmuxGhosttyCore *core) {
  if (core == NULL) return;
  if (core->mouse_event != NULL)
    ghostty_mouse_event_free(core->mouse_event);
  if (core->mouse_encoder != NULL)
    ghostty_mouse_encoder_free(core->mouse_encoder);
  if (core->key_event != NULL) ghostty_key_event_free(core->key_event);
  if (core->key_encoder != NULL)
    ghostty_key_encoder_free(core->key_encoder);
  if (core->projector_cells != NULL)
    ghostty_render_state_row_cells_free(core->projector_cells);
  if (core->projector_rows != NULL)
    ghostty_render_state_row_iterator_free(core->projector_rows);
  if (core->projector != NULL) ghostty_render_state_free(core->projector);
  if (core->terminal != NULL) ghostty_terminal_free(core->terminal);
  free(core);
}

static void hmux_write_pty(GhosttyTerminal terminal,
                           void *userdata,
                           const uint8_t *data,
                           size_t len) {
  (void)terminal;
  HmuxGhosttyCore *core = userdata;
  if (core == NULL || len == 0) return;
  if (len > SIZE_MAX - core->reply_len) {
    core->reply_len = SIZE_MAX;
    core->reply_overflow = true;
    return;
  }
  if (core->reply_len > core->reply_capacity ||
      len > core->reply_capacity - core->reply_len) {
    core->reply_len += len;
    core->reply_overflow = true;
    return;
  }
  memcpy(core->reply_buffer + core->reply_len, data, len);
  core->reply_len += len;
}

static GhosttyClipboardWriteResult hmux_write_clipboard(
    GhosttyTerminal terminal,
    void *userdata,
    const GhosttyClipboardWrite *write) {
  (void)terminal;
  HmuxGhosttyCore *core = userdata;
  if (core == NULL || write == NULL || write->size < sizeof(*write) ||
      write->location != GHOSTTY_CLIPBOARD_LOCATION_STANDARD) {
    return GHOSTTY_CLIPBOARD_WRITE_RESULT_UNSUPPORTED;
  }

  const uint8_t *content = NULL;
  size_t content_len = 0;
  bool content_found = write->contents_len == 0;
  if (write->contents_len != 0) {
    if (write->contents == NULL) {
      return GHOSTTY_CLIPBOARD_WRITE_RESULT_INVALID_DATA;
    }
    static const uint8_t text_plain[] = "text/plain";
    for (size_t index = 0; index < write->contents_len; ++index) {
      const GhosttyClipboardContent candidate = write->contents[index];
      if (candidate.mime.len == sizeof(text_plain) - 1 &&
          candidate.mime.ptr != NULL &&
          memcmp(candidate.mime.ptr, text_plain, sizeof(text_plain) - 1) == 0) {
        if (candidate.data.len != 0 && candidate.data.ptr == NULL) {
          return GHOSTTY_CLIPBOARD_WRITE_RESULT_INVALID_DATA;
        }
        content = candidate.data.ptr;
        content_len = candidate.data.len;
        content_found = true;
        break;
      }
    }
    if (!content_found) {
      return GHOSTTY_CLIPBOARD_WRITE_RESULT_UNSUPPORTED;
    }
  }

  const size_t prefix_len = sizeof(uint32_t);
  if (content_len > UINT32_MAX || core->clipboard_len > core->clipboard_capacity ||
      prefix_len > core->clipboard_capacity - core->clipboard_len ||
      content_len > core->clipboard_capacity - core->clipboard_len - prefix_len) {
    core->clipboard_overflow = true;
    return GHOSTTY_CLIPBOARD_WRITE_RESULT_BUSY;
  }
  const uint32_t encoded_len = (uint32_t)content_len;
  uint8_t *destination = core->clipboard_buffer + core->clipboard_len;
  destination[0] = (uint8_t)(encoded_len & 0xffu);
  destination[1] = (uint8_t)((encoded_len >> 8) & 0xffu);
  destination[2] = (uint8_t)((encoded_len >> 16) & 0xffu);
  destination[3] = (uint8_t)((encoded_len >> 24) & 0xffu);
  if (content_len != 0) memcpy(destination + prefix_len, content, content_len);
  core->clipboard_len += prefix_len + content_len;
  return GHOSTTY_CLIPBOARD_WRITE_RESULT_SUCCESS;
}

static int hmux_configure(HmuxGhosttyCore *core) {
  GhosttyTerminalModeConfig grapheme_clusters = {
      .mode = GHOSTTY_MODE_GRAPHEME_CLUSTER,
      .value = true,
  };
  GhosttyResult result = ghostty_terminal_set(
      core->terminal, GHOSTTY_TERMINAL_OPT_MODE_DEFAULT,
      &grapheme_clusters);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_terminal_set(
      core->terminal, GHOSTTY_TERMINAL_OPT_USERDATA, core);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_terminal_set(
      core->terminal, GHOSTTY_TERMINAL_OPT_WRITE_PTY,
      (const void *)hmux_write_pty);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_terminal_set(
      core->terminal, GHOSTTY_TERMINAL_OPT_CLIPBOARD_WRITE,
      (const void *)hmux_write_clipboard);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_render_state_new(NULL, &core->projector);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_render_state_row_iterator_new(NULL, &core->projector_rows);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_render_state_row_cells_new(NULL, &core->projector_cells);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_key_encoder_new(NULL, &core->key_encoder);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_key_event_new(NULL, &core->key_event);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_mouse_encoder_new(NULL, &core->mouse_encoder);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_mouse_event_new(NULL, &core->mouse_event);
  if (result != GHOSTTY_SUCCESS) return result;
  return GHOSTTY_SUCCESS;
}

static uint32_t hmux_rgb_value(GhosttyColorRgb color) {
  return ((uint32_t)color.r << 16) | ((uint32_t)color.g << 8) |
         (uint32_t)color.b;
}

static void hmux_style_color(GhosttyStyleColor color,
                             uint8_t *kind,
                             uint32_t *value) {
  *kind = (uint8_t)color.tag;
  switch (color.tag) {
    case GHOSTTY_STYLE_COLOR_PALETTE:
      *value = color.value.palette;
      break;
    case GHOSTTY_STYLE_COLOR_RGB:
      *value = hmux_rgb_value(color.value.rgb);
      break;
    default:
      *value = 0;
      break;
  }
}

static int hmux_content_background(GhosttyCell cell,
                                   HmuxGhosttyCellStyle *style) {
  GhosttyCellContentTag tag = GHOSTTY_CELL_CONTENT_CODEPOINT;
  GhosttyResult result =
      ghostty_cell_get(cell, GHOSTTY_CELL_DATA_CONTENT_TAG, &tag);
  if (result != GHOSTTY_SUCCESS) return result;
  if (tag == GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE) {
    GhosttyColorPaletteIndex palette = 0;
    result = ghostty_cell_get(
        cell, GHOSTTY_CELL_DATA_COLOR_PALETTE, &palette);
    if (result == GHOSTTY_SUCCESS) {
      style->bg_kind = GHOSTTY_STYLE_COLOR_PALETTE;
      style->bg_value = palette;
    }
    return result;
  }
  if (tag == GHOSTTY_CELL_CONTENT_BG_COLOR_RGB) {
    GhosttyColorRgb rgb = {0};
    result = ghostty_cell_get(cell, GHOSTTY_CELL_DATA_COLOR_RGB, &rgb);
    if (result == GHOSTTY_SUCCESS) {
      style->bg_kind = GHOSTTY_STYLE_COLOR_RGB;
      style->bg_value = hmux_rgb_value(rgb);
    }
    return result;
  }
  return GHOSTTY_SUCCESS;
}

static bool hmux_mode(HmuxGhosttyCore *core, GhosttyMode mode) {
  GhosttyTerminalModeConfig config = {.mode = mode, .value = false};
  return ghostty_terminal_get(
             core->terminal, GHOSTTY_TERMINAL_DATA_MODE, &config) ==
             GHOSTTY_SUCCESS &&
         config.value;
}

typedef struct {
  const char *code;
  GhosttyKey key;
} HmuxGhosttyKeyCode;

static GhosttyKey hmux_key_from_code(const uint8_t *code, size_t len) {
  if (code == NULL || len == 0) return GHOSTTY_KEY_UNIDENTIFIED;
  if (len == 4 && memcmp(code, "Key", 3) == 0 &&
      code[3] >= 'A' && code[3] <= 'Z') {
    return (GhosttyKey)(GHOSTTY_KEY_A + code[3] - 'A');
  }
  if (len == 6 && memcmp(code, "Digit", 5) == 0 &&
      code[5] >= '0' && code[5] <= '9') {
    return (GhosttyKey)(GHOSTTY_KEY_DIGIT_0 + code[5] - '0');
  }
  if (len == 7 && memcmp(code, "Numpad", 6) == 0 &&
      code[6] >= '0' && code[6] <= '9') {
    return (GhosttyKey)(GHOSTTY_KEY_NUMPAD_0 + code[6] - '0');
  }
  if (code[0] == 'F' && len >= 2 && len <= 3) {
    unsigned value = 0;
    for (size_t index = 1; index < len; index++) {
      if (code[index] < '0' || code[index] > '9') {
        value = 0;
        break;
      }
      value = value * 10 + (unsigned)(code[index] - '0');
    }
    if (value >= 1 && value <= 25) {
      return (GhosttyKey)(GHOSTTY_KEY_F1 + value - 1);
    }
  }

  static const HmuxGhosttyKeyCode keys[] = {
      {"Backquote", GHOSTTY_KEY_BACKQUOTE},
      {"Backslash", GHOSTTY_KEY_BACKSLASH},
      {"BracketLeft", GHOSTTY_KEY_BRACKET_LEFT},
      {"BracketRight", GHOSTTY_KEY_BRACKET_RIGHT},
      {"Comma", GHOSTTY_KEY_COMMA},
      {"Equal", GHOSTTY_KEY_EQUAL},
      {"IntlBackslash", GHOSTTY_KEY_INTL_BACKSLASH},
      {"IntlRo", GHOSTTY_KEY_INTL_RO},
      {"IntlYen", GHOSTTY_KEY_INTL_YEN},
      {"Minus", GHOSTTY_KEY_MINUS},
      {"Period", GHOSTTY_KEY_PERIOD},
      {"Quote", GHOSTTY_KEY_QUOTE},
      {"Semicolon", GHOSTTY_KEY_SEMICOLON},
      {"Slash", GHOSTTY_KEY_SLASH},
      {"AltLeft", GHOSTTY_KEY_ALT_LEFT},
      {"AltRight", GHOSTTY_KEY_ALT_RIGHT},
      {"Backspace", GHOSTTY_KEY_BACKSPACE},
      {"CapsLock", GHOSTTY_KEY_CAPS_LOCK},
      {"ContextMenu", GHOSTTY_KEY_CONTEXT_MENU},
      {"ControlLeft", GHOSTTY_KEY_CONTROL_LEFT},
      {"ControlRight", GHOSTTY_KEY_CONTROL_RIGHT},
      {"Enter", GHOSTTY_KEY_ENTER},
      {"MetaLeft", GHOSTTY_KEY_META_LEFT},
      {"MetaRight", GHOSTTY_KEY_META_RIGHT},
      {"ShiftLeft", GHOSTTY_KEY_SHIFT_LEFT},
      {"ShiftRight", GHOSTTY_KEY_SHIFT_RIGHT},
      {"Space", GHOSTTY_KEY_SPACE},
      {"Tab", GHOSTTY_KEY_TAB},
      {"Convert", GHOSTTY_KEY_CONVERT},
      {"KanaMode", GHOSTTY_KEY_KANA_MODE},
      {"NonConvert", GHOSTTY_KEY_NON_CONVERT},
      {"Delete", GHOSTTY_KEY_DELETE},
      {"End", GHOSTTY_KEY_END},
      {"Help", GHOSTTY_KEY_HELP},
      {"Home", GHOSTTY_KEY_HOME},
      {"Insert", GHOSTTY_KEY_INSERT},
      {"PageDown", GHOSTTY_KEY_PAGE_DOWN},
      {"PageUp", GHOSTTY_KEY_PAGE_UP},
      {"ArrowDown", GHOSTTY_KEY_ARROW_DOWN},
      {"ArrowLeft", GHOSTTY_KEY_ARROW_LEFT},
      {"ArrowRight", GHOSTTY_KEY_ARROW_RIGHT},
      {"ArrowUp", GHOSTTY_KEY_ARROW_UP},
      {"NumLock", GHOSTTY_KEY_NUM_LOCK},
      {"NumpadAdd", GHOSTTY_KEY_NUMPAD_ADD},
      {"NumpadBackspace", GHOSTTY_KEY_NUMPAD_BACKSPACE},
      {"NumpadClear", GHOSTTY_KEY_NUMPAD_CLEAR},
      {"NumpadClearEntry", GHOSTTY_KEY_NUMPAD_CLEAR_ENTRY},
      {"NumpadComma", GHOSTTY_KEY_NUMPAD_COMMA},
      {"NumpadDecimal", GHOSTTY_KEY_NUMPAD_DECIMAL},
      {"NumpadDivide", GHOSTTY_KEY_NUMPAD_DIVIDE},
      {"NumpadEnter", GHOSTTY_KEY_NUMPAD_ENTER},
      {"NumpadEqual", GHOSTTY_KEY_NUMPAD_EQUAL},
      {"NumpadMultiply", GHOSTTY_KEY_NUMPAD_MULTIPLY},
      {"NumpadSubtract", GHOSTTY_KEY_NUMPAD_SUBTRACT},
      {"Escape", GHOSTTY_KEY_ESCAPE},
      {"PrintScreen", GHOSTTY_KEY_PRINT_SCREEN},
      {"ScrollLock", GHOSTTY_KEY_SCROLL_LOCK},
      {"Pause", GHOSTTY_KEY_PAUSE},
  };
  for (size_t index = 0; index < sizeof(keys) / sizeof(keys[0]); index++) {
    const size_t expected_len = strlen(keys[index].code);
    if (len == expected_len &&
        memcmp(code, keys[index].code, expected_len) == 0) {
      return keys[index].key;
    }
  }
  return GHOSTTY_KEY_UNIDENTIFIED;
}

static GhosttyMods hmux_key_modifiers(uint32_t modifiers) {
  GhosttyMods result = 0;
  if ((modifiers & (1u << 0)) != 0) result |= GHOSTTY_MODS_SHIFT;
  if ((modifiers & (1u << 1)) != 0) result |= GHOSTTY_MODS_ALT;
  if ((modifiers & (1u << 2)) != 0) result |= GHOSTTY_MODS_CTRL;
  if ((modifiers & (1u << 3)) != 0) result |= GHOSTTY_MODS_SUPER;
  if ((modifiers & (1u << 4)) != 0) result |= GHOSTTY_MODS_CAPS_LOCK;
  if ((modifiers & (1u << 5)) != 0) result |= GHOSTTY_MODS_NUM_LOCK;
  return result;
}

static uint32_t hmux_unshifted_codepoint(GhosttyKey key,
                                         const uint8_t *utf8,
                                         size_t utf8_len) {
  if (utf8_len == 1 && utf8 != NULL && utf8[0] < 0x80) {
    uint8_t value = utf8[0];
    if (value >= 'A' && value <= 'Z') value = (uint8_t)(value + 'a' - 'A');
    return value;
  }
  if (key >= GHOSTTY_KEY_A && key <= GHOSTTY_KEY_Z)
    return (uint32_t)('a' + key - GHOSTTY_KEY_A);
  if (key >= GHOSTTY_KEY_DIGIT_0 && key <= GHOSTTY_KEY_DIGIT_9)
    return (uint32_t)('0' + key - GHOSTTY_KEY_DIGIT_0);
  return 0;
}

static GhosttyMouseButton hmux_mouse_button(uint32_t button) {
  switch (button) {
    case 0:
      return GHOSTTY_MOUSE_BUTTON_LEFT;
    case 1:
      return GHOSTTY_MOUSE_BUTTON_MIDDLE;
    case 2:
      return GHOSTTY_MOUSE_BUTTON_RIGHT;
    case 3:
      return GHOSTTY_MOUSE_BUTTON_FOUR;
    case 4:
      return GHOSTTY_MOUSE_BUTTON_FIVE;
    default:
      return GHOSTTY_MOUSE_BUTTON_UNKNOWN;
  }
}

static int hmux_encode_mouse_once(HmuxGhosttyCore *core,
                                  GhosttyMouseAction action,
                                  GhosttyMouseButton button,
                                  uint32_t modifiers,
                                  uint32_t pixel_x,
                                  uint32_t pixel_y,
                                  uint8_t *buffer,
                                  size_t capacity,
                                  size_t *written) {
  ghostty_mouse_event_set_action(core->mouse_event, action);
  if (button == GHOSTTY_MOUSE_BUTTON_UNKNOWN) {
    ghostty_mouse_event_clear_button(core->mouse_event);
  } else {
    ghostty_mouse_event_set_button(core->mouse_event, button);
  }
  ghostty_mouse_event_set_mods(
      core->mouse_event, hmux_key_modifiers(modifiers));
  ghostty_mouse_event_set_position(
      core->mouse_event,
      (GhosttyMousePosition){.x = (float)pixel_x, .y = (float)pixel_y});
  return ghostty_mouse_encoder_encode(
      core->mouse_encoder, core->mouse_event, (char *)buffer, capacity,
      written);
}

static int hmux_append_mouse(HmuxGhosttyCore *core,
                             GhosttyMouseAction action,
                             GhosttyMouseButton button,
                             uint32_t modifiers,
                             uint32_t pixel_x,
                             uint32_t pixel_y,
                             uint8_t *buffer,
                             size_t capacity,
                             size_t *total) {
  size_t written = 0;
  const int result = hmux_encode_mouse_once(
      core, action, button, modifiers, pixel_x, pixel_y,
      buffer == NULL ? NULL : buffer + *total,
      capacity >= *total ? capacity - *total : 0, &written);
  if (result != GHOSTTY_SUCCESS) {
    if (result == GHOSTTY_OUT_OF_SPACE && written <= SIZE_MAX - *total)
      *total += written;
    return result;
  }
  if (written > SIZE_MAX - *total) return HMUX_GHOSTTY_SHIM_ERROR;
  *total += written;
  return GHOSTTY_SUCCESS;
}

static int hmux_projection_header(HmuxGhosttyCore *core,
                                  HmuxGhosttyProjectionHeader *header) {
  if (core == NULL || header == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  memset(header, 0, sizeof(*header));
  HmuxGhosttyObservation observation = {0};
  int result = hmux_observe(core, &observation);
  if (result != GHOSTTY_SUCCESS) return result;
  header->columns = observation.columns;
  header->rows = observation.rows;
  header->cursor_column = observation.cursor_column;
  header->cursor_row = observation.cursor_row;
  header->alternate_screen = observation.alternate_screen;
  header->cursor_visible = observation.cursor_visible;
  header->application_cursor = observation.application_cursor;
  header->bracketed_paste = observation.bracketed_paste;

  GhosttyRenderStateColors colors =
      GHOSTTY_INIT_SIZED(GhosttyRenderStateColors);
  GhosttyResult ghostty_result =
      ghostty_render_state_colors_get(core->projector, &colors);
  if (ghostty_result != GHOSTTY_SUCCESS) return ghostty_result;
  header->foreground =
      (HmuxGhosttyRgb){colors.foreground.r, colors.foreground.g,
                       colors.foreground.b};
  header->background =
      (HmuxGhosttyRgb){colors.background.r, colors.background.g,
                       colors.background.b};
  header->cursor = colors.cursor_has_value
                       ? (HmuxGhosttyRgb){colors.cursor.r, colors.cursor.g,
                                          colors.cursor.b}
                       : header->foreground;
  for (size_t index = 0; index < 256; index++) {
    header->palette[index] =
        (HmuxGhosttyRgb){colors.palette[index].r, colors.palette[index].g,
                         colors.palette[index].b};
  }

  GhosttyRenderStateCursorVisualStyle cursor_style =
      GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
  bool cursor_blinking = false;
  ghostty_result = ghostty_render_state_get(
      core->projector, GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE,
      &cursor_style);
  if (ghostty_result != GHOSTTY_SUCCESS) return ghostty_result;
  ghostty_result = ghostty_render_state_get(
      core->projector, GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING,
      &cursor_blinking);
  if (ghostty_result != GHOSTTY_SUCCESS) return ghostty_result;
  header->cursor_shape = (uint8_t)cursor_style;
  header->cursor_blinking = cursor_blinking ? 1 : 0;
  bool pending_wrap = false;
  ghostty_result = ghostty_terminal_get(
      core->terminal, GHOSTTY_TERMINAL_DATA_CURSOR_PENDING_WRAP,
      &pending_wrap);
  if (ghostty_result != GHOSTTY_SUCCESS) return ghostty_result;
  header->cursor_wrap_pending = pending_wrap ? 1 : 0;

  header->application_keypad = hmux_mode(core, GHOSTTY_MODE_KEYPAD_KEYS);
  header->focus_reporting = hmux_mode(core, GHOSTTY_MODE_FOCUS_EVENT);
  header->insert_mode = hmux_mode(core, GHOSTTY_MODE_INSERT);
  header->origin_mode = hmux_mode(core, GHOSTTY_MODE_ORIGIN);
  header->auto_wrap = hmux_mode(core, GHOSTTY_MODE_WRAPAROUND);
  header->newline_mode = hmux_mode(core, GHOSTTY_MODE_LINEFEED);
  header->reverse_wrap = hmux_mode(core, GHOSTTY_MODE_REVERSE_WRAP) ||
                         hmux_mode(core, GHOSTTY_MODE_REVERSE_WRAP_EXT);
  header->synchronized_output = hmux_mode(core, GHOSTTY_MODE_SYNC_OUTPUT);
  if (hmux_mode(core, GHOSTTY_MODE_ANY_MOUSE)) {
    header->mouse_tracking = 3;
  } else if (hmux_mode(core, GHOSTTY_MODE_BUTTON_MOUSE)) {
    header->mouse_tracking = 2;
  } else if (hmux_mode(core, GHOSTTY_MODE_NORMAL_MOUSE)) {
    header->mouse_tracking = 2;
  } else if (hmux_mode(core, GHOSTTY_MODE_X10_MOUSE)) {
    header->mouse_tracking = 1;
  }
  if (hmux_mode(core, GHOSTTY_MODE_SGR_PIXELS_MOUSE)) {
    header->mouse_encoding = 5;
  } else if (hmux_mode(core, GHOSTTY_MODE_SGR_MOUSE)) {
    header->mouse_encoding = 3;
  } else if (hmux_mode(core, GHOSTTY_MODE_URXVT_MOUSE)) {
    header->mouse_encoding = 4;
  } else if (hmux_mode(core, GHOSTTY_MODE_UTF8_MOUSE)) {
    header->mouse_encoding = 2;
  } else {
    header->mouse_encoding = 1;
  }

  GhosttyString title;
  ghostty_result = hmux_read_title(core, &title);
  if (ghostty_result != GHOSTTY_SUCCESS) return ghostty_result;
  size_t title_len = title.len;
  if (title_len > HMUX_GHOSTTY_TITLE_CAPACITY) {
    title_len = HMUX_GHOSTTY_TITLE_CAPACITY;
    header->title_truncated = 1;
  }
  if (title_len > 0) memcpy(header->title, title.ptr, title_len);
  header->title_len = (uint16_t)title_len;
  return GHOSTTY_SUCCESS;
}

int hmux_ghostty_core_projection_header(
    HmuxGhosttyCore *core,
    HmuxGhosttyProjectionHeader *header) {
  return hmux_projection_header(core, header);
}

static int hmux_observe(HmuxGhosttyCore *core,
                        HmuxGhosttyObservation *observation) {
  if (core == NULL || observation == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  memset(observation, 0, sizeof(*observation));
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  GhosttyTerminalModeConfig application_cursor = {
      .mode = GHOSTTY_MODE_DECCKM,
      .value = false,
  };
  GhosttyTerminalModeConfig bracketed_paste = {
      .mode = GHOSTTY_MODE_BRACKETED_PASTE,
      .value = false,
  };
  const GhosttyTerminalData keys[] = {
      GHOSTTY_TERMINAL_DATA_COLS,
      GHOSTTY_TERMINAL_DATA_ROWS,
      GHOSTTY_TERMINAL_DATA_CURSOR_X,
      GHOSTTY_TERMINAL_DATA_CURSOR_Y,
      GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN,
      GHOSTTY_TERMINAL_DATA_CURSOR_VISIBLE,
      GHOSTTY_TERMINAL_DATA_TOTAL_ROWS,
      GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS,
      GHOSTTY_TERMINAL_DATA_MODE,
      GHOSTTY_TERMINAL_DATA_MODE,
  };
  void *values[] = {
      &observation->columns,
      &observation->rows,
      &observation->cursor_column,
      &observation->cursor_row,
      &screen,
      &observation->cursor_visible,
      &observation->total_rows,
      &observation->scrollback_rows,
      &application_cursor,
      &bracketed_paste,
  };
  size_t written = 0;
  GhosttyResult result = ghostty_terminal_get_multi(
      core->terminal, sizeof(keys) / sizeof(keys[0]), keys, values, &written);
  if (result != GHOSTTY_SUCCESS || written != sizeof(keys) / sizeof(keys[0])) {
    return result == GHOSTTY_SUCCESS ? HMUX_GHOSTTY_SHIM_ERROR : result;
  }
  observation->alternate_screen =
      screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE ? 1 : 0;
  observation->cursor_visible = observation->cursor_visible != 0 ? 1 : 0;
  observation->application_cursor = application_cursor.value ? 1 : 0;
  observation->bracketed_paste = bracketed_paste.value ? 1 : 0;
  GhosttyString title;
  result = hmux_read_title(core, &title);
  if (result != GHOSTTY_SUCCESS) return result;
  observation->title_hash = hmux_fnv1a64(title.ptr, title.len);
  return GHOSTTY_SUCCESS;
}

typedef struct {
  uint16_t columns;
  HmuxGhosttyRowCallback row_callback;
  HmuxGhosttyCellCallback cell_callback;
  void *userdata;
} HmuxGhosttyTrackedProjection;

static size_t hmux_utf8_codepoint(uint32_t codepoint, uint8_t output[4]) {
  if (codepoint <= 0x7f) {
    output[0] = (uint8_t)codepoint;
    return 1;
  }
  if (codepoint <= 0x7ff) {
    output[0] = (uint8_t)(0xc0 | (codepoint >> 6));
    output[1] = (uint8_t)(0x80 | (codepoint & 0x3f));
    return 2;
  }
  if (codepoint >= 0xd800 && codepoint <= 0xdfff) return 0;
  if (codepoint <= 0xffff) {
    output[0] = (uint8_t)(0xe0 | (codepoint >> 12));
    output[1] = (uint8_t)(0x80 | ((codepoint >> 6) & 0x3f));
    output[2] = (uint8_t)(0x80 | (codepoint & 0x3f));
    return 3;
  }
  if (codepoint <= 0x10ffff) {
    output[0] = (uint8_t)(0xf0 | (codepoint >> 18));
    output[1] = (uint8_t)(0x80 | ((codepoint >> 12) & 0x3f));
    output[2] = (uint8_t)(0x80 | ((codepoint >> 6) & 0x3f));
    output[3] = (uint8_t)(0x80 | (codepoint & 0x3f));
    return 4;
  }
  return 0;
}

static int hmux_project_grid_row(void *userdata,
                                 uint16_t row_index,
                                 uint8_t wraps,
                                 uint8_t continues,
                                 const GhosttyGridRef *row_reference,
                                 uint16_t columns) {
  HmuxGhosttyTrackedProjection *projection = userdata;
  if (projection == NULL || row_reference == NULL ||
      columns != projection->columns ||
      projection->row_callback(projection->userdata, row_index, wraps,
                               continues) != 0) {
    return HMUX_GHOSTTY_SHIM_ERROR;
  }

  for (uint16_t column = 0; column < columns; ++column) {
    GhosttyGridRef reference = *row_reference;
    reference.x = column;
    GhosttyCell cell = 0;
    GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
    GhosttyResult result = ghostty_grid_ref_cell(&reference, &cell);
    if (result != GHOSTTY_SUCCESS) return result;
    result = ghostty_grid_ref_style(&reference, &style);
    if (result != GHOSTTY_SUCCESS) return result;

    GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
    bool protected_cell = false;
    const GhosttyCellData cell_keys[] = {
        GHOSTTY_CELL_DATA_WIDE,
        GHOSTTY_CELL_DATA_PROTECTED,
    };
    void *cell_values[] = {&wide, &protected_cell};
    size_t cell_written = 0;
    result = ghostty_cell_get_multi(
        cell, sizeof(cell_keys) / sizeof(cell_keys[0]), cell_keys,
        cell_values, &cell_written);
    if (result != GHOSTTY_SUCCESS ||
        cell_written != sizeof(cell_keys) / sizeof(cell_keys[0])) {
      return result == GHOSTTY_SUCCESS ? HMUX_GHOSTTY_SHIM_ERROR : result;
    }
    uint8_t width = 1;
    if (wide == GHOSTTY_CELL_WIDE_WIDE) {
      width = 2;
    } else if (wide == GHOSTTY_CELL_WIDE_SPACER_TAIL) {
      width = 0;
    }

    uint32_t codepoint_stack[16];
    uint32_t *codepoints = codepoint_stack;
    uint32_t *codepoint_heap = NULL;
    size_t codepoint_len = 0;
    result = ghostty_grid_ref_graphemes(
        &reference, codepoints,
        sizeof(codepoint_stack) / sizeof(codepoint_stack[0]), &codepoint_len);
    if (result == GHOSTTY_OUT_OF_SPACE) {
      if (codepoint_len > 1024 || codepoint_len > SIZE_MAX / sizeof(uint32_t)) {
        return HMUX_GHOSTTY_SHIM_ERROR;
      }
      codepoint_heap = malloc(codepoint_len * sizeof(uint32_t));
      if (codepoint_heap == NULL) return GHOSTTY_OUT_OF_MEMORY;
      codepoints = codepoint_heap;
      result = ghostty_grid_ref_graphemes(
          &reference, codepoints, codepoint_len, &codepoint_len);
    }
    if (result != GHOSTTY_SUCCESS) {
      free(codepoint_heap);
      return result;
    }
    if (codepoint_len > SIZE_MAX / 4) {
      free(codepoint_heap);
      return HMUX_GHOSTTY_SHIM_ERROR;
    }
    uint8_t grapheme_stack[64];
    uint8_t *grapheme = grapheme_stack;
    uint8_t *grapheme_heap = NULL;
    const size_t grapheme_capacity = codepoint_len * 4;
    if (grapheme_capacity > sizeof(grapheme_stack)) {
      grapheme_heap = malloc(grapheme_capacity);
      if (grapheme_heap == NULL) {
        free(codepoint_heap);
        return GHOSTTY_OUT_OF_MEMORY;
      }
      grapheme = grapheme_heap;
    }
    size_t grapheme_len = 0;
    for (size_t index = 0; index < codepoint_len; ++index) {
      const size_t written =
          hmux_utf8_codepoint(codepoints[index], grapheme + grapheme_len);
      if (written == 0) {
        free(grapheme_heap);
        free(codepoint_heap);
        return HMUX_GHOSTTY_SHIM_ERROR;
      }
      grapheme_len += written;
    }
    free(codepoint_heap);

    HmuxGhosttyCellStyle projected_style = {0};
    hmux_style_color(style.fg_color, &projected_style.fg_kind,
                     &projected_style.fg_value);
    hmux_style_color(style.bg_color, &projected_style.bg_kind,
                     &projected_style.bg_value);
    result = hmux_content_background(cell, &projected_style);
    if (result != GHOSTTY_SUCCESS) {
      free(grapheme_heap);
      return result;
    }
    hmux_style_color(style.underline_color,
                     &projected_style.underline_kind,
                     &projected_style.underline_value);
    projected_style.underline = style.underline;
    if (style.bold) projected_style.flags |= 1u << 0;
    if (style.faint) projected_style.flags |= 1u << 1;
    if (style.italic) projected_style.flags |= 1u << 2;
    if (style.blink) projected_style.flags |= 1u << 3;
    if (style.inverse) projected_style.flags |= 1u << 4;
    if (style.invisible) projected_style.flags |= 1u << 5;
    if (style.strikethrough) projected_style.flags |= 1u << 6;
    if (style.overline) projected_style.flags |= 1u << 7;
    if (protected_cell) projected_style.flags |= 1u << 8;

    uint8_t hyperlink_stack[256];
    uint8_t *hyperlink = hyperlink_stack;
    uint8_t *hyperlink_heap = NULL;
    size_t hyperlink_len = 0;
    bool has_hyperlink = false;
    result = ghostty_cell_get(
        cell, GHOSTTY_CELL_DATA_HAS_HYPERLINK, &has_hyperlink);
    if (result == GHOSTTY_SUCCESS && has_hyperlink) {
      result = ghostty_grid_ref_hyperlink_uri(
          &reference, hyperlink, sizeof(hyperlink_stack), &hyperlink_len);
      if (result == GHOSTTY_OUT_OF_SPACE) {
        if (hyperlink_len > 4096) {
          free(grapheme_heap);
          return HMUX_GHOSTTY_SHIM_ERROR;
        }
        hyperlink_heap = malloc(hyperlink_len);
        if (hyperlink_heap == NULL) {
          free(grapheme_heap);
          return GHOSTTY_OUT_OF_MEMORY;
        }
        hyperlink = hyperlink_heap;
        result = ghostty_grid_ref_hyperlink_uri(
            &reference, hyperlink, hyperlink_len, &hyperlink_len);
      }
    }
    if (result != GHOSTTY_SUCCESS) {
      free(hyperlink_heap);
      free(grapheme_heap);
      return result;
    }

    const HmuxGhosttyProjectedCell projected_cell = {
        .row = row_index,
        .column = column,
        .width = width,
        .grapheme = grapheme,
        .grapheme_len = grapheme_len,
        .style = projected_style,
        .hyperlink = hyperlink,
        .hyperlink_len = hyperlink_len,
    };
    const int callback_result =
        projection->cell_callback(projection->userdata, &projected_cell);
    free(hyperlink_heap);
    free(grapheme_heap);
    if (callback_result != 0) return HMUX_GHOSTTY_SHIM_ERROR;
  }
  return GHOSTTY_SUCCESS;
}

typedef struct {
  HmuxGhosttyTrackedProjection cells;
  HmuxGhosttyArchiveRowCallback row_callback;
} HmuxGhosttyArchiveProjection;

static int hmux_archive_noop_row(void *userdata,
                                 uint16_t row,
                                 uint8_t wraps,
                                 uint8_t continues) {
  (void)userdata;
  (void)row;
  (void)wraps;
  (void)continues;
  return 0;
}

static int hmux_project_archive_grid_row(
    void *userdata,
    uint16_t row,
    uint8_t wraps,
    uint8_t continues,
    uint64_t logical_line_id,
    uint32_t logical_cell_offset,
    const GhosttyGridRef *reference,
    uint16_t columns) {
  HmuxGhosttyArchiveProjection *projection = userdata;
  if (projection == NULL || projection->row_callback == NULL ||
      projection->row_callback(projection->cells.userdata, row, wraps,
                               continues, logical_line_id,
                               logical_cell_offset) != 0) {
    return HMUX_GHOSTTY_SHIM_ERROR;
  }
  return hmux_project_grid_row(&projection->cells, row, wraps, continues,
                               reference, columns);
}

int hmux_ghostty_history_archive_project(
    void *archive,
    uint64_t logical_line_id,
    uint32_t logical_cell_offset,
    uint16_t columns,
    size_t maximum_rows,
    HmuxGhosttyArchiveRowCallback row_callback,
    HmuxGhosttyCellCallback cell_callback,
    void *userdata,
    HmuxGhosttyArchiveProjectionWork *work,
    uint8_t *has_more_before,
    uint8_t *has_more_after) {
  if (archive == NULL || columns == 0 || maximum_rows == 0 ||
      row_callback == NULL || cell_callback == NULL || work == NULL ||
      has_more_before == NULL || has_more_after == NULL) {
    return HMUX_GHOSTTY_SHIM_ERROR;
  }
  HmuxGhosttyArchiveProjection projection = {
      .cells =
          {
              .columns = columns,
              .row_callback = hmux_archive_noop_row,
              .cell_callback = cell_callback,
              .userdata = userdata,
          },
      .row_callback = row_callback,
  };
  return hmux_ghostty_history_archive_project_grid(
      archive, logical_line_id, logical_cell_offset, columns, maximum_rows,
      hmux_project_archive_grid_row, &projection, work, has_more_before,
      has_more_after);
}

int hmux_ghostty_screen_anchor_project(
    void *anchor,
    uint16_t columns,
    size_t maximum_rows,
    HmuxGhosttyRowCallback row_callback,
    HmuxGhosttyCellCallback cell_callback,
    void *userdata,
    size_t *visited_rows,
    uint8_t *has_more_before,
    uint8_t *has_more_after,
    int32_t *cursor_row,
    uint16_t *cursor_column) {
  if (anchor == NULL || columns == 0 || row_callback == NULL ||
      cell_callback == NULL || visited_rows == NULL || has_more_before == NULL ||
      has_more_after == NULL || cursor_row == NULL || cursor_column == NULL) {
    return HMUX_GHOSTTY_SHIM_ERROR;
  }
  HmuxGhosttyTrackedProjection projection = {
      .columns = columns,
      .row_callback = row_callback,
      .cell_callback = cell_callback,
      .userdata = userdata,
  };
  return hmux_ghostty_history_rows_from_tracked_ref(
      anchor, maximum_rows, hmux_project_grid_row, &projection, visited_rows,
      has_more_before, has_more_after, cursor_row, cursor_column);
}

typedef struct {
  HmuxGhosttyRowCallback row_callback;
  void *userdata;
} HmuxGhosttyTrackedRowIndex;

static int hmux_index_grid_row(void *userdata,
                               uint16_t row,
                               uint8_t wraps,
                               uint8_t continues,
                               const GhosttyGridRef *reference,
                               uint16_t columns) {
  HmuxGhosttyTrackedRowIndex *index = userdata;
  (void)reference;
  (void)columns;
  if (index == NULL || index->row_callback == NULL) {
    return HMUX_GHOSTTY_SHIM_ERROR;
  }
  return index->row_callback(index->userdata, row, wraps, continues);
}

int hmux_ghostty_screen_anchor_index_rows(
    void *anchor,
    size_t maximum_rows,
    HmuxGhosttyRowCallback row_callback,
    void *userdata,
    size_t *visited_rows,
    uint8_t *has_more_before,
    uint8_t *has_more_after,
    int32_t *cursor_row,
    uint16_t *cursor_column) {
  if (anchor == NULL || row_callback == NULL || visited_rows == NULL ||
      has_more_before == NULL || has_more_after == NULL || cursor_row == NULL ||
      cursor_column == NULL) {
    return HMUX_GHOSTTY_SHIM_ERROR;
  }
  HmuxGhosttyTrackedRowIndex index = {
      .row_callback = row_callback,
      .userdata = userdata,
  };
  return hmux_ghostty_history_rows_from_tracked_ref(
      anchor, maximum_rows, hmux_index_grid_row, &index, visited_rows,
      has_more_before, has_more_after, cursor_row, cursor_column);
}

int hmux_ghostty_screen_anchor_move_rows(void *anchor,
                                         int64_t delta,
                                         int64_t *moved_rows) {
  if (anchor == NULL || moved_rows == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  return hmux_ghostty_tracked_grid_ref_move_rows(anchor, delta, moved_rows);
}

int hmux_ghostty_core_project_active(
    HmuxGhosttyCore *core,
    HmuxGhosttyProjectionHeader *header,
    HmuxGhosttyRowCallback row_callback,
    HmuxGhosttyCellCallback cell_callback,
    void *userdata) {
  if (core == NULL || header == NULL || row_callback == NULL ||
      cell_callback == NULL) {
    return HMUX_GHOSTTY_SHIM_ERROR;
  }
  int result = hmux_projection_header(core, header);
  if (result != GHOSTTY_SUCCESS) return result;
  GhosttyResult ghostty_result = ghostty_render_state_get(
      core->projector, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
      &core->projector_rows);
  if (ghostty_result != GHOSTTY_SUCCESS) return ghostty_result;

  uint16_t row_index = 0;
  while (ghostty_render_state_row_iterator_next(core->projector_rows)) {
    if (row_index >= header->rows) return HMUX_GHOSTTY_SHIM_ERROR;
    GhosttyRow row = 0;
    ghostty_result = ghostty_render_state_row_get(
        core->projector_rows, GHOSTTY_RENDER_STATE_ROW_DATA_RAW, &row);
    if (ghostty_result != GHOSTTY_SUCCESS) return ghostty_result;
    bool wraps = false;
    bool continues = false;
    const GhosttyRowData row_keys[] = {
        GHOSTTY_ROW_DATA_WRAP,
        GHOSTTY_ROW_DATA_WRAP_CONTINUATION,
    };
    void *row_values[] = {&wraps, &continues};
    size_t row_written = 0;
    ghostty_result = ghostty_row_get_multi(
        row, sizeof(row_keys) / sizeof(row_keys[0]), row_keys, row_values,
        &row_written);
    if (ghostty_result != GHOSTTY_SUCCESS ||
        row_written != sizeof(row_keys) / sizeof(row_keys[0])) {
      return ghostty_result == GHOSTTY_SUCCESS ? HMUX_GHOSTTY_SHIM_ERROR
                                               : ghostty_result;
    }
    if (row_callback(userdata, row_index, wraps ? 1 : 0,
                     continues ? 1 : 0) != 0) {
      return HMUX_GHOSTTY_SHIM_ERROR;
    }

    ghostty_result = ghostty_render_state_row_get(
        core->projector_rows, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
        &core->projector_cells);
    if (ghostty_result != GHOSTTY_SUCCESS) return ghostty_result;
    uint16_t column = 0;
    while (ghostty_render_state_row_cells_next(core->projector_cells)) {
      if (column >= header->columns) return HMUX_GHOSTTY_SHIM_ERROR;
      GhosttyCell cell = 0;
      GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
      ghostty_result = ghostty_render_state_row_cells_get(
          core->projector_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW,
          &cell);
      if (ghostty_result != GHOSTTY_SUCCESS) return ghostty_result;
      ghostty_result = ghostty_render_state_row_cells_get(
          core->projector_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE,
          &style);
      if (ghostty_result != GHOSTTY_SUCCESS) return ghostty_result;

      GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
      bool protected_cell = false;
      const GhosttyCellData cell_keys[] = {
          GHOSTTY_CELL_DATA_WIDE,
          GHOSTTY_CELL_DATA_PROTECTED,
      };
      void *cell_values[] = {&wide, &protected_cell};
      size_t cell_written = 0;
      ghostty_result = ghostty_cell_get_multi(
          cell, sizeof(cell_keys) / sizeof(cell_keys[0]), cell_keys,
          cell_values, &cell_written);
      if (ghostty_result != GHOSTTY_SUCCESS ||
          cell_written != sizeof(cell_keys) / sizeof(cell_keys[0])) {
        return ghostty_result == GHOSTTY_SUCCESS ? HMUX_GHOSTTY_SHIM_ERROR
                                                 : ghostty_result;
      }
      uint8_t width = 1;
      if (wide == GHOSTTY_CELL_WIDE_WIDE) {
        width = 2;
      } else if (wide == GHOSTTY_CELL_WIDE_SPACER_TAIL) {
        width = 0;
      }

      uint8_t grapheme_stack[64];
      GhosttyBuffer grapheme = {
          .ptr = grapheme_stack,
          .cap = sizeof(grapheme_stack),
          .len = 0,
      };
      uint8_t *grapheme_heap = NULL;
      ghostty_result = ghostty_render_state_row_cells_get(
          core->projector_cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &grapheme);
      if (ghostty_result == GHOSTTY_OUT_OF_SPACE) {
        if (grapheme.len > 1024) return HMUX_GHOSTTY_SHIM_ERROR;
        grapheme_heap = malloc(grapheme.len);
        if (grapheme_heap == NULL) return GHOSTTY_OUT_OF_MEMORY;
        grapheme.ptr = grapheme_heap;
        grapheme.cap = grapheme.len;
        ghostty_result = ghostty_render_state_row_cells_get(
            core->projector_cells,
            GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8, &grapheme);
      }
      if (ghostty_result != GHOSTTY_SUCCESS) {
        free(grapheme_heap);
        return ghostty_result;
      }

      HmuxGhosttyCellStyle projected_style = {0};
      hmux_style_color(style.fg_color, &projected_style.fg_kind,
                       &projected_style.fg_value);
      hmux_style_color(style.bg_color, &projected_style.bg_kind,
                       &projected_style.bg_value);
      hmux_style_color(style.underline_color,
                       &projected_style.underline_kind,
                       &projected_style.underline_value);
      projected_style.underline = style.underline;
      if (style.bold) projected_style.flags |= 1u << 0;
      if (style.faint) projected_style.flags |= 1u << 1;
      if (style.italic) projected_style.flags |= 1u << 2;
      if (style.blink) projected_style.flags |= 1u << 3;
      if (style.inverse) projected_style.flags |= 1u << 4;
      if (style.invisible) projected_style.flags |= 1u << 5;
      if (style.strikethrough) projected_style.flags |= 1u << 6;
      if (style.overline) projected_style.flags |= 1u << 7;
      if (protected_cell) projected_style.flags |= 1u << 8;

      GhosttyColorRgb resolved = {0};
      ghostty_result = ghostty_render_state_row_cells_get(
          core->projector_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR,
          &resolved);
      if (ghostty_result == GHOSTTY_SUCCESS) {
        projected_style.fg_kind = GHOSTTY_STYLE_COLOR_RGB;
        projected_style.fg_value = hmux_rgb_value(resolved);
      } else if (ghostty_result != GHOSTTY_INVALID_VALUE &&
                 ghostty_result != GHOSTTY_NO_VALUE) {
        free(grapheme_heap);
        return ghostty_result;
      }
      ghostty_result = ghostty_render_state_row_cells_get(
          core->projector_cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR,
          &resolved);
      if (ghostty_result == GHOSTTY_SUCCESS) {
        projected_style.bg_kind = GHOSTTY_STYLE_COLOR_RGB;
        projected_style.bg_value = hmux_rgb_value(resolved);
      } else if (ghostty_result != GHOSTTY_INVALID_VALUE &&
                 ghostty_result != GHOSTTY_NO_VALUE) {
        free(grapheme_heap);
        return ghostty_result;
      }

      uint8_t hyperlink_stack[256];
      uint8_t *hyperlink = hyperlink_stack;
      uint8_t *hyperlink_heap = NULL;
      size_t hyperlink_len = 0;
      bool has_hyperlink = false;
      ghostty_result = ghostty_cell_get(
          cell, GHOSTTY_CELL_DATA_HAS_HYPERLINK, &has_hyperlink);
      if (ghostty_result != GHOSTTY_SUCCESS) {
        free(grapheme_heap);
        return ghostty_result;
      }
      if (has_hyperlink) {
        GhosttyGridRef reference = GHOSTTY_INIT_SIZED(GhosttyGridRef);
        GhosttyPoint point = {
            .tag = GHOSTTY_POINT_TAG_VIEWPORT,
            .value = {.coordinate = {.x = column, .y = row_index}},
        };
        ghostty_result =
            ghostty_terminal_grid_ref(core->terminal, point, &reference);
        if (ghostty_result == GHOSTTY_SUCCESS) {
          ghostty_result = ghostty_grid_ref_hyperlink_uri(
              &reference, hyperlink, sizeof(hyperlink_stack), &hyperlink_len);
        }
        if (ghostty_result == GHOSTTY_OUT_OF_SPACE) {
          if (hyperlink_len > 4096) {
            free(grapheme_heap);
            return HMUX_GHOSTTY_SHIM_ERROR;
          }
          hyperlink_heap = malloc(hyperlink_len);
          if (hyperlink_heap == NULL) {
            free(grapheme_heap);
            return GHOSTTY_OUT_OF_MEMORY;
          }
          hyperlink = hyperlink_heap;
          ghostty_result = ghostty_grid_ref_hyperlink_uri(
              &reference, hyperlink, hyperlink_len, &hyperlink_len);
        }
        if (ghostty_result != GHOSTTY_SUCCESS) {
          free(hyperlink_heap);
          free(grapheme_heap);
          return ghostty_result;
        }
      }

      const HmuxGhosttyProjectedCell projected_cell = {
          .row = row_index,
          .column = column,
          .width = width,
          .grapheme = grapheme.ptr,
          .grapheme_len = grapheme.len,
          .style = projected_style,
          .hyperlink = hyperlink,
          .hyperlink_len = hyperlink_len,
      };
      int callback_result = cell_callback(userdata, &projected_cell);
      free(hyperlink_heap);
      free(grapheme_heap);
      if (callback_result != 0) return HMUX_GHOSTTY_SHIM_ERROR;
      column += 1;
    }
    if (column != header->columns) return HMUX_GHOSTTY_SHIM_ERROR;
    row_index += 1;
  }
  return row_index == header->rows ? GHOSTTY_SUCCESS
                                   : HMUX_GHOSTTY_SHIM_ERROR;
}

int hmux_ghostty_core_scroll_viewport_row(HmuxGhosttyCore *core,
                                          size_t row) {
  if (core == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  GhosttyTerminalScrollViewport behavior = {
      .tag = GHOSTTY_SCROLL_VIEWPORT_ROW,
      .value = {.row = row},
  };
  ghostty_terminal_scroll_viewport(core->terminal, behavior);
  return ghostty_render_state_update(core->projector, core->terminal);
}

static int hmux_ghostty_core_logical_bounds(HmuxGhosttyCore *core,
                                             GhosttyPoint point,
                                             GhosttyPointTag output_tag,
                                             uint32_t *point_row,
                                             uint32_t *start_row) {
  if (core == NULL || point_row == NULL || start_row == NULL) {
    return HMUX_GHOSTTY_SHIM_ERROR;
  }
  GhosttyGridRef reference = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  GhosttyResult result =
      ghostty_terminal_grid_ref(core->terminal, point, &reference);
  if (result != GHOSTTY_SUCCESS) return result;

  GhosttyPointCoordinate projected = {0};
  result = ghostty_terminal_point_from_grid_ref(
      core->terminal, &reference, output_tag, &projected);
  if (result != GHOSTTY_SUCCESS) return result;
  *point_row = projected.y;

  // A non-NULL zero-length whitespace set disables trimming. We only need
  // Ghostty's canonical soft-wrap boundary, including blank segments.
  static const uint32_t no_whitespace = 0;
  GhosttyTerminalSelectLineOptions options =
      GHOSTTY_INIT_SIZED(GhosttyTerminalSelectLineOptions);
  options.ref = reference;
  options.whitespace = &no_whitespace;
  options.whitespace_len = 0;
  options.semantic_prompt_boundary = false;
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  result = ghostty_terminal_select_line(core->terminal, &options, &selection);
  if (result == GHOSTTY_NO_VALUE) {
    *start_row = *point_row;
    return GHOSTTY_SUCCESS;
  }
  if (result != GHOSTTY_SUCCESS) return result;

  GhosttyPointCoordinate origin = {0};
  result = ghostty_terminal_point_from_grid_ref(
      core->terminal, &selection.start, output_tag, &origin);
  if (result != GHOSTTY_SUCCESS) return result;
  *start_row = origin.y;
  return GHOSTTY_SUCCESS;
}

int hmux_ghostty_core_history_logical_start(HmuxGhosttyCore *core,
                                             uint32_t row,
                                             uint32_t *start_row) {
  GhosttyPoint point = {
      .tag = GHOSTTY_POINT_TAG_HISTORY,
      .value = {.coordinate = {.x = 0, .y = row}},
  };
  uint32_t projected_row = 0;
  return hmux_ghostty_core_logical_bounds(
      core, point, GHOSTTY_POINT_TAG_HISTORY, &projected_row, start_row);
}

int hmux_ghostty_core_viewport_logical_bounds(HmuxGhosttyCore *core,
                                               uint32_t *screen_row,
                                               uint32_t *start_row) {
  GhosttyPoint point = {
      .tag = GHOSTTY_POINT_TAG_VIEWPORT,
      .value = {.coordinate = {.x = 0, .y = 0}},
  };
  return hmux_ghostty_core_logical_bounds(
      core, point, GHOSTTY_POINT_TAG_SCREEN, screen_row, start_row);
}

int hmux_ghostty_core_track_history_row(HmuxGhosttyCore *core,
                                        uint32_t row,
                                        void **output) {
  if (core == NULL || output == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  *output = NULL;
  GhosttyPoint point = {
      .tag = GHOSTTY_POINT_TAG_HISTORY,
      .value = {.coordinate = {.x = 0, .y = row}},
  };
  GhosttyTrackedGridRef reference = NULL;
  const GhosttyResult result =
      ghostty_terminal_grid_ref_track(core->terminal, point, &reference);
  if (result != GHOSTTY_SUCCESS) return result;
  *output = reference;
  return GHOSTTY_SUCCESS;
}

int hmux_ghostty_core_track_screen_row(HmuxGhosttyCore *core,
                                       uint32_t row,
                                       void **output) {
  if (core == NULL || output == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  *output = NULL;
  GhosttyPoint point = {
      .tag = GHOSTTY_POINT_TAG_SCREEN,
      .value = {.coordinate = {.x = 0, .y = row}},
  };
  GhosttyTrackedGridRef reference = NULL;
  const GhosttyResult result =
      ghostty_terminal_grid_ref_track(core->terminal, point, &reference);
  if (result != GHOSTTY_SUCCESS) return result;
  *output = reference;
  return GHOSTTY_SUCCESS;
}

int hmux_ghostty_core_track_viewport_row(HmuxGhosttyCore *core,
                                         uint16_t row,
                                         void **output) {
  if (core == NULL || output == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  *output = NULL;
  GhosttyPoint point = {
      .tag = GHOSTTY_POINT_TAG_VIEWPORT,
      .value = {.coordinate = {.x = 0, .y = row}},
  };
  GhosttyTrackedGridRef reference = NULL;
  const GhosttyResult result =
      ghostty_terminal_grid_ref_track(core->terminal, point, &reference);
  if (result != GHOSTTY_SUCCESS) return result;
  *output = reference;
  return GHOSTTY_SUCCESS;
}

int hmux_ghostty_screen_anchor_row(void *anchor, uint32_t *row) {
  if (anchor == NULL || row == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  GhosttyPointCoordinate point = {0};
  const GhosttyResult result = ghostty_tracked_grid_ref_point(
      anchor, GHOSTTY_POINT_TAG_SCREEN, &point);
  if (result != GHOSTTY_SUCCESS) return result;
  *row = point.y;
  return GHOSTTY_SUCCESS;
}

void hmux_ghostty_screen_anchor_free(void *anchor) {
  ghostty_tracked_grid_ref_free(anchor);
}

int hmux_ghostty_history_cursor_row(void *cursor, uint32_t *row) {
  if (cursor == NULL || row == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  GhosttyPointCoordinate point = {0};
  const GhosttyResult result = ghostty_tracked_grid_ref_point(
      cursor, GHOSTTY_POINT_TAG_HISTORY, &point);
  if (result != GHOSTTY_SUCCESS) return result;
  *row = point.y;
  return GHOSTTY_SUCCESS;
}

void hmux_ghostty_history_cursor_free(void *cursor) {
  ghostty_tracked_grid_ref_free(cursor);
}

static int hmux_project(HmuxGhosttyCore *core,
                        HmuxGhosttyMutation *mutation) {
  GhosttyResult result =
      ghostty_render_state_update(core->projector, core->terminal);
  if (result != GHOSTTY_SUCCESS) return result;

  GhosttyRenderStateDirty dirty = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
  result = ghostty_render_state_get(
      core->projector, GHOSTTY_RENDER_STATE_DATA_DIRTY, &dirty);
  if (result != GHOSTTY_SUCCESS) return result;
  mutation->dirty_kind = (uint8_t)dirty;

  result = ghostty_render_state_get(
      core->projector, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
      &core->projector_rows);
  if (result != GHOSTTY_SUCCESS) return result;
  size_t dirty_rows = 0;
  size_t visited_rows = 0;
  while (ghostty_render_state_row_iterator_next(core->projector_rows)) {
    visited_rows += 1;
    bool row_dirty = false;
    result = ghostty_render_state_row_get(
        core->projector_rows, GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY, &row_dirty);
    if (result != GHOSTTY_SUCCESS) return result;
    if (row_dirty) dirty_rows += 1;
    bool clean = false;
    result = ghostty_render_state_row_set(
        core->projector_rows, GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY, &clean);
    if (result != GHOSTTY_SUCCESS) return result;
  }
  mutation->dirty_rows = dirty_rows;
  mutation->visited_rows = visited_rows;

  GhosttyRenderStateDirty clean = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
  result = ghostty_render_state_set(
      core->projector, GHOSTTY_RENDER_STATE_OPTION_DIRTY, &clean);
  if (result != GHOSTTY_SUCCESS) return result;

  const GhosttyTerminalData keys[] = {
      GHOSTTY_TERMINAL_DATA_TOTAL_ROWS,
      GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS,
  };
  void *values[] = {&mutation->total_rows, &mutation->scrollback_rows};
  size_t written = 0;
  result = ghostty_terminal_get_multi(
      core->terminal, sizeof(keys) / sizeof(keys[0]), keys, values, &written);
  if (result != GHOSTTY_SUCCESS || written != sizeof(keys) / sizeof(keys[0])) {
    return result == GHOSTTY_SUCCESS ? HMUX_GHOSTTY_SHIM_ERROR : result;
  }
  return GHOSTTY_SUCCESS;
}

static void hmux_begin_effects(HmuxGhosttyCore *core,
                               uint8_t *reply_buffer,
                               size_t reply_capacity,
                               uint8_t *clipboard_buffer,
                               size_t clipboard_capacity) {
  core->reply_buffer = reply_buffer;
  core->reply_capacity = reply_capacity;
  core->reply_len = 0;
  core->reply_overflow = false;
  core->clipboard_buffer = clipboard_buffer;
  core->clipboard_capacity = clipboard_capacity;
  core->clipboard_len = 0;
  core->clipboard_overflow = false;
}

static void hmux_finish_effects(HmuxGhosttyCore *core,
                                HmuxGhosttyMutation *mutation) {
  mutation->reply_len = core->reply_len;
  mutation->reply_overflow = core->reply_overflow ? 1 : 0;
  mutation->clipboard_len = core->clipboard_len;
  mutation->clipboard_overflow = core->clipboard_overflow ? 1 : 0;
  core->reply_buffer = NULL;
  core->reply_capacity = 0;
  core->reply_len = 0;
  core->reply_overflow = false;
  core->clipboard_buffer = NULL;
  core->clipboard_capacity = 0;
  core->clipboard_len = 0;
  core->clipboard_overflow = false;
}

int hmux_ghostty_core_new(uint16_t columns,
                          uint16_t rows,
                          size_t history_lines,
                          HmuxGhosttyCore **output) {
  if (output == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  *output = NULL;
  HmuxGhosttyCore *core = calloc(1, sizeof(*core));
  if (core == NULL) return GHOSTTY_OUT_OF_MEMORY;
  GhosttyResult result =
      ghostty_terminal_new(NULL, &core->terminal, columns, rows);
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        core->terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, NULL);
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        core->terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES,
        &history_lines);
  }
  const size_t continuation_limit = 4096;
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        core->terminal, GHOSTTY_TERMINAL_OPT_CONTINUATION_MAX_BYTES,
        &continuation_limit);
  }
  if (result == GHOSTTY_SUCCESS) result = hmux_configure(core);
  if (result != GHOSTTY_SUCCESS) {
    hmux_release(core);
    return result;
  }
  HmuxGhosttyMutation initial = {0};
  result = hmux_project(core, &initial);
  if (result != GHOSTTY_SUCCESS) {
    hmux_release(core);
    return result;
  }
  *output = core;
  return GHOSTTY_SUCCESS;
}

void hmux_ghostty_core_free(HmuxGhosttyCore *core) {
  hmux_release(core);
}

int hmux_ghostty_core_encode_key(HmuxGhosttyCore *core,
                                 const uint8_t *utf8,
                                 size_t utf8_len,
                                 const uint8_t *code,
                                 size_t code_len,
                                 uint32_t modifiers,
                                 uint8_t repeat,
                                 uint8_t *buffer,
                                 size_t capacity,
                                 size_t *written) {
  if (core == NULL || written == NULL ||
      (utf8_len != 0 && utf8 == NULL) ||
      (code_len != 0 && code == NULL) ||
      (capacity != 0 && buffer == NULL)) {
    return HMUX_GHOSTTY_SHIM_ERROR;
  }
  // An unidentified key with no text is the engine's call, not a shim error:
  // libghostty-vt encodes it as nothing in both legacy and kitty modes.
  // Refusing it here made the Host reject a harmless press (#711).
  const GhosttyKey key = hmux_key_from_code(code, code_len);
  ghostty_key_encoder_setopt_from_terminal(core->key_encoder, core->terminal);
  ghostty_key_event_set_action(
      core->key_event,
      repeat != 0 ? GHOSTTY_KEY_ACTION_REPEAT : GHOSTTY_KEY_ACTION_PRESS);
  ghostty_key_event_set_key(core->key_event, key);
  ghostty_key_event_set_mods(core->key_event, hmux_key_modifiers(modifiers));
  ghostty_key_event_set_consumed_mods(core->key_event, 0);
  ghostty_key_event_set_composing(core->key_event, false);
  ghostty_key_event_set_utf8(
      core->key_event, (const char *)utf8, utf8_len);
  ghostty_key_event_set_unshifted_codepoint(
      core->key_event, hmux_unshifted_codepoint(key, utf8, utf8_len));
  return ghostty_key_encoder_encode(
      core->key_encoder, core->key_event, (char *)buffer, capacity, written);
}

int hmux_ghostty_core_encode_paste(HmuxGhosttyCore *core,
                                   const uint8_t *utf8,
                                   size_t utf8_len,
                                   uint8_t *buffer,
                                   size_t capacity,
                                   size_t *written) {
  if (core == NULL || written == NULL ||
      (utf8_len != 0 && utf8 == NULL) ||
      (capacity != 0 && buffer == NULL)) {
    return HMUX_GHOSTTY_SHIM_ERROR;
  }
  char *copy = NULL;
  if (utf8_len != 0) {
    copy = malloc(utf8_len);
    if (copy == NULL) return GHOSTTY_OUT_OF_MEMORY;
    memcpy(copy, utf8, utf8_len);
  }
  const GhosttyResult result = ghostty_paste_encode(
      copy, utf8_len, hmux_mode(core, GHOSTTY_MODE_BRACKETED_PASTE),
      (char *)buffer, capacity, written);
  free(copy);
  return result;
}

int hmux_ghostty_core_encode_focus(HmuxGhosttyCore *core,
                                   uint8_t focused,
                                   uint8_t *buffer,
                                   size_t capacity,
                                   size_t *written) {
  if (core == NULL || written == NULL ||
      (capacity != 0 && buffer == NULL)) {
    return HMUX_GHOSTTY_SHIM_ERROR;
  }
  if (!hmux_mode(core, GHOSTTY_MODE_FOCUS_EVENT)) {
    *written = 0;
    return GHOSTTY_SUCCESS;
  }
  return ghostty_focus_encode(
      focused != 0 ? GHOSTTY_FOCUS_GAINED : GHOSTTY_FOCUS_LOST,
      (char *)buffer, capacity, written);
}

int hmux_ghostty_core_encode_pointer(HmuxGhosttyCore *core,
                                     uint32_t kind,
                                     uint32_t button,
                                     uint32_t modifiers,
                                     int32_t wheel_delta_x,
                                     int32_t wheel_delta_y,
                                     uint32_t pixel_x,
                                     uint32_t pixel_y,
                                     uint32_t surface_width,
                                     uint32_t surface_height,
                                     uint32_t cell_width,
                                     uint32_t cell_height,
                                     uint32_t padding_top,
                                     uint32_t padding_bottom,
                                     uint32_t padding_right,
                                     uint32_t padding_left,
                                     uint32_t pressed_buttons,
                                     uint8_t *buffer,
                                     size_t capacity,
                                     size_t *written) {
  if (core == NULL || written == NULL ||
      (capacity != 0 && buffer == NULL) || cell_width == 0 ||
      cell_height == 0) {
    return HMUX_GHOSTTY_SHIM_ERROR;
  }
  *written = 0;
  ghostty_mouse_encoder_setopt_from_terminal(
      core->mouse_encoder, core->terminal);
  const GhosttyMouseEncoderSize size = {
      .size = sizeof(GhosttyMouseEncoderSize),
      .screen_width = surface_width,
      .screen_height = surface_height,
      .cell_width = cell_width,
      .cell_height = cell_height,
      .padding_top = padding_top,
      .padding_bottom = padding_bottom,
      .padding_right = padding_right,
      .padding_left = padding_left,
  };
  ghostty_mouse_encoder_setopt(
      core->mouse_encoder, GHOSTTY_MOUSE_ENCODER_OPT_SIZE, &size);
  const bool any_button_pressed = pressed_buttons != 0;
  ghostty_mouse_encoder_setopt(
      core->mouse_encoder, GHOSTTY_MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED,
      &any_button_pressed);
  const bool track_last_cell = true;
  ghostty_mouse_encoder_setopt(
      core->mouse_encoder, GHOSTTY_MOUSE_ENCODER_OPT_TRACK_LAST_CELL,
      &track_last_cell);

  if (kind == 1 || kind == 2 || kind == 3) {
    const GhosttyMouseAction action =
        kind == 1 ? GHOSTTY_MOUSE_ACTION_PRESS
                  : kind == 2 ? GHOSTTY_MOUSE_ACTION_RELEASE
                              : GHOSTTY_MOUSE_ACTION_MOTION;
    const GhosttyMouseButton encoded_button =
        kind == 3 ? GHOSTTY_MOUSE_BUTTON_UNKNOWN : hmux_mouse_button(button);
    return hmux_append_mouse(
        core, action, encoded_button, modifiers, pixel_x, pixel_y, buffer,
        capacity, written);
  }
  if (kind != 4) return HMUX_GHOSTTY_SHIM_ERROR;

  const struct {
    int32_t delta;
    GhosttyMouseButton negative;
    GhosttyMouseButton positive;
  } axes[] = {
      {wheel_delta_y, GHOSTTY_MOUSE_BUTTON_FOUR,
       GHOSTTY_MOUSE_BUTTON_FIVE},
      {wheel_delta_x, GHOSTTY_MOUSE_BUTTON_SIX,
       GHOSTTY_MOUSE_BUTTON_SEVEN},
  };
  for (size_t axis = 0; axis < sizeof(axes) / sizeof(axes[0]); ++axis) {
    const int64_t delta = axes[axis].delta;
    const uint64_t count =
        (uint64_t)(delta < 0 ? -delta : delta);
    const GhosttyMouseButton wheel_button =
        delta < 0 ? axes[axis].negative : axes[axis].positive;
    for (uint64_t index = 0; index < count; ++index) {
      const int result = hmux_append_mouse(
          core, GHOSTTY_MOUSE_ACTION_PRESS, wheel_button, modifiers, pixel_x,
          pixel_y, buffer, capacity, written);
      if (result != GHOSTTY_SUCCESS) return result;
    }
  }
  return GHOSTTY_SUCCESS;
}

int hmux_ghostty_core_write(HmuxGhosttyCore *core,
                            const uint8_t *bytes,
                            size_t length,
                            uint8_t *reply_buffer,
                            size_t reply_capacity,
                            uint8_t *clipboard_buffer,
                            size_t clipboard_capacity,
                            HmuxGhosttyMutation *mutation) {
  if (core == NULL || mutation == NULL ||
      (length != 0 && bytes == NULL) ||
      (reply_capacity != 0 && reply_buffer == NULL) ||
      (clipboard_capacity != 0 && clipboard_buffer == NULL)) {
    return HMUX_GHOSTTY_SHIM_ERROR;
  }
  memset(mutation, 0, sizeof(*mutation));
  hmux_begin_effects(core, reply_buffer, reply_capacity, clipboard_buffer,
                     clipboard_capacity);
  ghostty_terminal_vt_write(core->terminal, bytes, length);
  hmux_finish_effects(core, mutation);
  return hmux_project(core, mutation);
}

int hmux_ghostty_core_resize(HmuxGhosttyCore *core,
                             uint16_t columns,
                             uint16_t rows,
                             uint8_t *reply_buffer,
                             size_t reply_capacity,
                             uint8_t *clipboard_buffer,
                             size_t clipboard_capacity,
                             HmuxGhosttyMutation *mutation) {
  if (core == NULL || mutation == NULL ||
      (reply_capacity != 0 && reply_buffer == NULL) ||
      (clipboard_capacity != 0 && clipboard_buffer == NULL)) {
    return HMUX_GHOSTTY_SHIM_ERROR;
  }
  memset(mutation, 0, sizeof(*mutation));
  hmux_begin_effects(core, reply_buffer, reply_capacity, clipboard_buffer,
                     clipboard_capacity);
  GhosttyResult result =
      ghostty_terminal_resize(core->terminal, columns, rows, 0, 0);
  hmux_finish_effects(core, mutation);
  if (result != GHOSTTY_SUCCESS) return result;
  result = hmux_project(core, mutation);
  if (result != GHOSTTY_SUCCESS) {
    /* The native resize has already committed. Projection is presentation
       work, so report its degradation without misclassifying the committed
       geometry as a failed canonical mutation. */
    mutation->dirty_kind = 2;
    mutation->projection_degraded = 1;
  }
  return GHOSTTY_SUCCESS;
}

int hmux_ghostty_core_observe(HmuxGhosttyCore *core,
                              HmuxGhosttyObservation *observation) {
  return hmux_observe(core, observation);
}

/* Only untouched normal-screen padding can be excluded from a transcript's
   tail. Inspect at most the active screen below its cursor, never scrollback;
   keep explicit spaces, styling, hyperlinks, protected cells and wrapped rows. */
int hmux_ghostty_core_content_rows(HmuxGhosttyCore *core, uint16_t *rows) {
  if (core == NULL || rows == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  HmuxGhosttyObservation observation;
  int result = hmux_observe(core, &observation);
  if (result != GHOSTTY_SUCCESS) return result;
  *rows = observation.rows;
  if (observation.alternate_screen) return GHOSTTY_SUCCESS;

  while (*rows > (uint32_t)observation.cursor_row + 1) {
    GhosttyPoint point = {
        .tag = GHOSTTY_POINT_TAG_ACTIVE,
        .value = {.coordinate = {.x = 0, .y = *rows - 1}},
    };
    GhosttyGridRef reference = GHOSTTY_INIT_SIZED(GhosttyGridRef);
    result = ghostty_terminal_grid_ref(core->terminal, point, &reference);
    if (result != GHOSTTY_SUCCESS) return result;
    GhosttyRow row = 0;
    result = ghostty_grid_ref_row(&reference, &row);
    if (result != GHOSTTY_SUCCESS) return result;
    bool wraps = false, continues = false;
    result = ghostty_row_get(row, GHOSTTY_ROW_DATA_WRAP, &wraps);
    if (result != GHOSTTY_SUCCESS) return result;
    result = ghostty_row_get(row, GHOSTTY_ROW_DATA_WRAP_CONTINUATION, &continues);
    if (result != GHOSTTY_SUCCESS) return result;
    if (wraps || continues) return GHOSTTY_SUCCESS;

    for (uint16_t column = 0; column < observation.columns; ++column) {
      reference.x = column;
      GhosttyCell cell = 0;
      result = ghostty_grid_ref_cell(&reference, &cell);
      if (result != GHOSTTY_SUCCESS) return result;
      bool text = false, styled = false, hyperlink = false, protected_cell = false;
      GhosttyCellContentTag tag = GHOSTTY_CELL_CONTENT_CODEPOINT;
      GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
      GhosttyCellSemanticContent semantic = GHOSTTY_CELL_SEMANTIC_OUTPUT;
      const GhosttyCellData keys[] = {
          GHOSTTY_CELL_DATA_HAS_TEXT, GHOSTTY_CELL_DATA_HAS_STYLING,
          GHOSTTY_CELL_DATA_HAS_HYPERLINK, GHOSTTY_CELL_DATA_PROTECTED,
          GHOSTTY_CELL_DATA_CONTENT_TAG, GHOSTTY_CELL_DATA_WIDE,
          GHOSTTY_CELL_DATA_SEMANTIC_CONTENT,
      };
      void *values[] = {&text, &styled, &hyperlink, &protected_cell,
                        &tag, &wide, &semantic};
      size_t written = 0;
      result = ghostty_cell_get_multi(cell, sizeof(keys) / sizeof(keys[0]),
                                      keys, values, &written);
      if (result != GHOSTTY_SUCCESS || written != sizeof(keys) / sizeof(keys[0])) {
        return result == GHOSTTY_SUCCESS ? HMUX_GHOSTTY_SHIM_ERROR : result;
      }
      if (text || styled || hyperlink || protected_cell ||
          tag != GHOSTTY_CELL_CONTENT_CODEPOINT ||
          wide != GHOSTTY_CELL_WIDE_NARROW || semantic != GHOSTTY_CELL_SEMANTIC_OUTPUT) {
        return GHOSTTY_SUCCESS;
      }
    }
    *rows -= 1;
  }
  return GHOSTTY_SUCCESS;
}

extern int hmux_ghostty_formatter_format_active(GhosttyFormatter formatter,
                                                uint8_t *buffer,
                                                size_t capacity,
                                                size_t *written);

int hmux_ghostty_core_format(HmuxGhosttyCore *core,
                             uint8_t styled,
                             uint8_t active_only,
                             uint8_t *buffer,
                             size_t capacity,
                             size_t *written) {
  if (core == NULL || written == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  GhosttyFormatterTerminalOptions options =
      GHOSTTY_INIT_SIZED(GhosttyFormatterTerminalOptions);
  options.emit = styled ? GHOSTTY_FORMATTER_FORMAT_VT
                        : GHOSTTY_FORMATTER_FORMAT_PLAIN;
  options.trim = true;
  if (styled) {
    options.extra.size = sizeof(options.extra);
    options.extra.modes = true;
    options.extra.scrolling_region = true;
    options.extra.tabstops = true;
    options.extra.pwd = true;
    options.extra.keyboard = true;
    options.extra.screen.size = sizeof(options.extra.screen);
    options.extra.screen.cursor = true;
    options.extra.screen.style = true;
    options.extra.screen.hyperlink = true;
    options.extra.screen.protection = true;
    options.extra.screen.kitty_keyboard = true;
    options.extra.screen.charsets = true;
  }
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  if (active_only) {
    HmuxGhosttyObservation observation = {0};
    GhosttyResult result = hmux_observe(core, &observation);
    if (result != GHOSTTY_SUCCESS) return result;
    if (observation.columns == 0 || observation.rows == 0)
      return HMUX_GHOSTTY_SHIM_ERROR;
    selection.start = (GhosttyGridRef)GHOSTTY_INIT_SIZED(GhosttyGridRef);
    selection.end = (GhosttyGridRef)GHOSTTY_INIT_SIZED(GhosttyGridRef);
    GhosttyPoint start = {
        .tag = GHOSTTY_POINT_TAG_ACTIVE,
        .value = {.coordinate = {.x = 0, .y = 0}},
    };
    GhosttyPoint end = {
        .tag = GHOSTTY_POINT_TAG_ACTIVE,
        .value = {.coordinate = {.x = observation.columns - 1,
                                 .y = observation.rows - 1}},
    };
    result = ghostty_terminal_grid_ref(core->terminal, start, &selection.start);
    if (result != GHOSTTY_SUCCESS) return result;
    result = ghostty_terminal_grid_ref(core->terminal, end, &selection.end);
    if (result != GHOSTTY_SUCCESS) return result;
    /* These references live only through this immutable formatting call. */
    options.selection = &selection;
  }
  GhosttyFormatter formatter = NULL;
  GhosttyResult result = ghostty_formatter_terminal_new(
      NULL, &formatter, core->terminal, options);
  if (result != GHOSTTY_SUCCESS) return result;
  result = active_only
      ? hmux_ghostty_formatter_format_active(formatter, buffer, capacity, written)
      : ghostty_formatter_format_buf(formatter, buffer, capacity, written);
  ghostty_formatter_free(formatter);
  return result;
}

int hmux_ghostty_core_snapshot(HmuxGhosttyCore *core,
                               uint8_t *buffer,
                               size_t capacity,
                               size_t *written) {
  if (core == NULL || written == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  return ghostty_snapshot_encode_buf(
      core->terminal, buffer, capacity, written);
}

int hmux_ghostty_core_cell_hyperlink(HmuxGhosttyCore *core,
                                     uint16_t column,
                                     uint16_t row,
                                     uint8_t *buffer,
                                     size_t capacity,
                                     size_t *written) {
  if (core == NULL || written == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  GhosttyGridRef reference = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  GhosttyPoint point = {
      .tag = GHOSTTY_POINT_TAG_ACTIVE,
      .value = {.coordinate = {.x = column, .y = row}},
  };
  GhosttyResult result =
      ghostty_terminal_grid_ref(core->terminal, point, &reference);
  if (result != GHOSTTY_SUCCESS) return result;
  return ghostty_grid_ref_hyperlink_uri(
      &reference, buffer, capacity, written);
}

int hmux_ghostty_core_restore(const uint8_t *snapshot,
                              size_t snapshot_length,
                              HmuxGhosttyCore **output) {
  if (snapshot == NULL || output == NULL) return HMUX_GHOSTTY_SHIM_ERROR;
  *output = NULL;
  GhosttySnapshotDecoder decoder = NULL;
  GhosttyResult result = ghostty_snapshot_decoder_new_buf(
      NULL, &decoder, snapshot, snapshot_length);
  if (result != GHOSTTY_SUCCESS) return result;
  HmuxGhosttyCore *core = calloc(1, sizeof(*core));
  if (core == NULL) {
    ghostty_snapshot_decoder_free(decoder);
    return GHOSTTY_OUT_OF_MEMORY;
  }
  result = ghostty_snapshot_decoder_decode(decoder, &core->terminal);
  ghostty_snapshot_decoder_free(decoder);
  /* Old snapshots may retain embedder defaults. Clear only those defaults;
     terminal-origin OSC overrides and explicit cell backgrounds survive. */
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        core->terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, NULL);
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_terminal_set(
        core->terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, NULL);
  }
  if (result == GHOSTTY_SUCCESS) result = hmux_configure(core);
  if (result != GHOSTTY_SUCCESS) {
    hmux_release(core);
    return result;
  }
  HmuxGhosttyMutation initial = {0};
  result = hmux_project(core, &initial);
  if (result != GHOSTTY_SUCCESS) {
    hmux_ghostty_core_free(core);
    return result;
  }
  *output = core;
  return GHOSTTY_SUCCESS;
}
