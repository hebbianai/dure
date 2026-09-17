#!/bin/sh

# Publish one immutable proof that an isolated QA Hmux session executed the
# expected fake provider. Real provider processes never write these receipts,
# so the native performance client can fail closed before accepting metrics.
dure_qa_capture_provider_start() {
  dure_qa_provider=$1
  dure_qa_capture_root=${DURE_QA_CAPTURE_DIR:-${HEBBIAN_QA_CAPTURE_DIR:-}}
  dure_qa_session_id=${HMUX_SESSION_ID:-}

  [ -n "$dure_qa_capture_root" ] || return 0
  case "$dure_qa_provider" in
    claude | codex) ;;
    *) return 1 ;;
  esac
  case "$dure_qa_session_id" in
    "" | *[!A-Za-z0-9._-]*) return 1 ;;
  esac

  dure_qa_receipt_root="$dure_qa_capture_root/provider-sessions"
  mkdir -p "$dure_qa_receipt_root"
  chmod 700 "$dure_qa_receipt_root"
  dure_qa_receipt="$dure_qa_receipt_root/$dure_qa_session_id.json"
  dure_qa_temporary="$dure_qa_receipt.$$"
  umask 077
  printf '{"schema":1,"provider":"%s","sessionId":"%s"}\n' \
    "$dure_qa_provider" "$dure_qa_session_id" >"$dure_qa_temporary"
  chmod 600 "$dure_qa_temporary"
  if ! ln "$dure_qa_temporary" "$dure_qa_receipt"; then
    rm -f "$dure_qa_temporary"
    return 1
  fi
  rm -f "$dure_qa_temporary"
}

# Real provider TUIs paint typed characters before a line is submitted. Keep
# that terminal contract in one provider-neutral adapter so performance probes
# do not depend on line-buffering or provider response time.
dure_qa_tui_input_begin() {
  DURE_QA_TUI_STTY=
  DURE_QA_TUI_INPUT_ORDINAL=0
  if [ -t 0 ]; then
    DURE_QA_TUI_STTY=$(stty -g </dev/stdin) || return 1
    stty -echo -icanon min 1 time 0 </dev/stdin || return 1
  fi
  trap 'dure_qa_tui_input_restore' EXIT
}

# Keep the provider boundary observable without parsing a repaint. Each file is
# one complete submitted line, so local and remote QA can assert exact bytes and
# count independently of terminal history truncation.
dure_qa_capture_tui_line() {
  dure_qa_input_capture_root=${DURE_QA_CAPTURE_DIR:-${HEBBIAN_QA_CAPTURE_DIR:-}}
  dure_qa_input_session_id=${HMUX_SESSION_ID:-}
  [ -n "$dure_qa_input_capture_root" ] || return 0
  case "$dure_qa_input_session_id" in
    "" | *[!A-Za-z0-9._-]*) return 1 ;;
  esac

  DURE_QA_TUI_INPUT_ORDINAL=$((DURE_QA_TUI_INPUT_ORDINAL + 1))
  dure_qa_input_root="$dure_qa_input_capture_root/provider-inputs/$dure_qa_input_session_id"
  mkdir -p "$dure_qa_input_root"
  chmod 700 "$dure_qa_input_capture_root/provider-inputs" "$dure_qa_input_root"
  dure_qa_input_name=$(printf '%06d.input' "$DURE_QA_TUI_INPUT_ORDINAL")
  dure_qa_input="$dure_qa_input_root/$dure_qa_input_name"
  dure_qa_input_temporary="$dure_qa_input.$$"
  umask 077
  printf '%s' "$DURE_QA_TUI_LINE" >"$dure_qa_input_temporary"
  chmod 600 "$dure_qa_input_temporary"
  if ! ln "$dure_qa_input_temporary" "$dure_qa_input"; then
    rm -f "$dure_qa_input_temporary"
    return 1
  fi
  rm -f "$dure_qa_input_temporary"
}

dure_qa_tui_input_restore() {
  if [ -n "${DURE_QA_TUI_STTY:-}" ] && [ -t 0 ]; then
    stty "$DURE_QA_TUI_STTY" </dev/stdin || true
  fi
}

dure_qa_read_tui_line() {
  DURE_QA_TUI_LINE=
  while IFS= read -r -n 1 dure_qa_tui_char; do
    if [ -z "$dure_qa_tui_char" ]; then
      dure_qa_capture_tui_line || return 1
      return 0
    fi
    printf '%s' "$dure_qa_tui_char"
    DURE_QA_TUI_LINE="${DURE_QA_TUI_LINE}${dure_qa_tui_char}"
  done
  [ -n "$DURE_QA_TUI_LINE" ] || return 1
  dure_qa_capture_tui_line
}
