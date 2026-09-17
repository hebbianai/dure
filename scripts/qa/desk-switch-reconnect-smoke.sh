#!/bin/sh
# 데스크탑 전환 재연결 재현/게이트: 격리 HOME으로 실제 tauri dev 앱을 띄우고
# 앱 내 deskswitch probe(src/qa.ts)가 실제 hmux standalone 세션으로 터미널
# 9개 데스크탑 A + 2개 B를 만들어 A↔B 왕복 결과(warm/cold, remount 분해)를
# qa.log로 보고한다. 연결 진단(hmux-connection-diagnostics.json)의
# initial_attach 수도 함께 출력한다. 기본은 리포트 모드(재현 목적).
# DESK_EXPECT=warm 이면 왕복이 전부 warm이어야 성공(수리 후 게이트).
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "desk-switch smoke: macOS is required" >&2
  exit 1
fi

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
cd "$repo_root"

state_root=$(mktemp -d "${TMPDIR:-/tmp}/hebbian-deskswitch-qa.XXXXXX")
qa_home="$state_root/home"
qa_discovery="$state_root/hmux-discovery"
app_log="$state_root/tauri-dev.log"
mkdir -p "$qa_home" "$qa_discovery"
chmod 700 "$qa_home" "$qa_discovery"

real_home=${HOME:-}
export CARGO_HOME=${CARGO_HOME:-"$real_home/.cargo"}
export RUSTUP_HOME=${RUSTUP_HOME:-"$real_home/.rustup"}

dev_pid=
terminate_tree() {
  target=$1
  for child in $(pgrep -P "$target" 2>/dev/null || true); do
    terminate_tree "$child"
  done
  kill "$target" 2>/dev/null || true
}
cleanup_hmux_sessions() {
  # 프로브가 만든 standalone 호스트는 detached라 앱 종료로 안 죽는다.
  # 격리 discovery root의 generation-fenced JSON으로 exact session/PID만
  # 내린다. 사람이 읽는 `hmux ls` 열은 session name의 공백에 안전하지 않다.
  droot="$qa_discovery"
  [ -d "$droot" ] || return 0
  sessions="$state_root/hmux-sessions.tsv"
  hmux --discovery-root "$droot" --json ls 2>/dev/null |
    node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const sessions = JSON.parse(input);
        for (const session of sessions) {
          const id = session?.session_id;
          const pid = session?.host_process?.process_id;
          if (
            typeof id !== "string" ||
            id.length === 0 ||
            !Number.isSafeInteger(pid) ||
            pid <= 1
          ) {
            throw new Error("invalid isolated Hmux cleanup descriptor");
          }
          process.stdout.write(`${id}\t${pid}\n`);
        }
      });
    ' >"$sessions"
  while IFS="$(printf '\t')" read -r id pid; do
    [ -n "$id" ] || continue
    hmux --discovery-root "$droot" kill "$id" >/dev/null 2>&1 || true
    attempt=0
    while [ "$attempt" -lt 20 ] && kill -0 "$pid" 2>/dev/null; do
      attempt=$((attempt + 1))
      sleep 0.1
    done
    if kill -0 "$pid" 2>/dev/null; then
      host_command=$(ps -p "$pid" -o command= 2>/dev/null || true)
      case "$host_command" in
        "$qa_home"/.local/share/hmux/versions/*/bin/hmux-runtime\ internal-hmux-host) ;;
        *)
          echo "desk-switch smoke: refusing unexpected cleanup PID $pid" >&2
          return 1
          ;;
      esac
      terminate_tree "$pid"
      attempt=0
      while [ "$attempt" -lt 20 ] && kill -0 "$pid" 2>/dev/null; do
        attempt=$((attempt + 1))
        sleep 0.1
      done
    fi
  done <"$sessions"
  while IFS="$(printf '\t')" read -r _id pid; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "desk-switch smoke: isolated Hmux Host $pid survived cleanup" >&2
      return 1
    fi
  done <"$sessions"
}
cleanup() {
  cleanup_status=0
  # Stop the producer before taking the exact discovery snapshot; otherwise a
  # late pane mount can create a Host after cleanup has enumerated sessions.
  if [ -n "$dev_pid" ]; then
    terminate_tree "$dev_pid"
    wait "$dev_pid" 2>/dev/null || true
  fi
  cleanup_hmux_sessions || cleanup_status=$?
  rm -f "$repo_root/qa.autorun"
  rm -rf "$state_root"
  return "$cleanup_status"
}
trap cleanup EXIT HUP INT TERM

pnpm hmux:runtime:stage:dev

echo deskswitch > qa.autorun
rm -f qa.log

vite_port=$(
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(String(server.address().port));
      server.close();
    });
  '
)
config="{\"build\":{\"devUrl\":\"http://127.0.0.1:$vite_port\",\"beforeDevCommand\":\"pnpm exec vite --host 127.0.0.1 --port $vite_port\"},\"app\":{\"windows\":[{\"label\":\"main\",\"title\":\"HebbianIDE DeskSwitch QA\",\"url\":\"index.html\",\"width\":1280,\"height\":800,\"visible\":true}]}}"

# 채널을 강제하지 않는다(dev 기본) — stable 강제 시 dev-staged hmux 런타임이
# 'host exited before ready(exit 1)'로 죽어 전 pane이 legacy PTY로 폴백됐다
# (qa.log deskswitch-warn 실측). 실 hmux 재현이 목적이므로 dev 채널 그대로.
HOME="$qa_home" HMUX_DISCOVERY_ROOT="$qa_discovery" \
  pnpm tauri dev --no-watch --config "$config" >"$app_log" 2>&1 &
dev_pid=$!

i=0
while [ $i -lt 240 ]; do
  if [ -f qa.log ] && grep -q '"deskswitch"' qa.log; then
    result=$(grep '"deskswitch"' qa.log | tail -n 1)
    echo "$result"
    diag="$qa_home/.hebbian/hmux-connection-diagnostics.json"
    if [ -f "$diag" ]; then
      attaches=$(grep -o 'hmux_initial_attach' "$diag" | wc -l | tr -d ' ')
      echo "connection diagnostics: initial_attach events = $attaches"
    fi
    if printf '%s' "$result" | grep -q '"error"'; then
      echo "desk-switch smoke: PROBE ERROR" >&2
      exit 1
    fi
    if [ "${DESK_EXPECT:-report}" = "warm" ]; then
      cold=$(printf '%s' "$result" | grep -o '"warm":false' | wc -l | tr -d ' ')
      if [ "$cold" -gt 0 ]; then
        echo "desk-switch smoke: FAIL — $cold cold round-trip transitions (expected all warm)" >&2
        exit 1
      fi
      echo "desk-switch smoke: OK (all round-trips warm)"
    else
      echo "desk-switch smoke: REPORTED (repro mode)"
    fi
    exit 0
  fi
  if ! kill -0 "$dev_pid" 2>/dev/null; then
    echo "desk-switch smoke: tauri dev exited early; log tail:" >&2
    tail -n 60 "$app_log" >&2
    exit 1
  fi
  sleep 2
  i=$((i + 1))
done
echo "desk-switch smoke: TIMEOUT; app log tail:" >&2
tail -n 40 "$app_log" >&2
exit 1
