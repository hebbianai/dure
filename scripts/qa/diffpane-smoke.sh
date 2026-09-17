#!/bin/sh
# Diff Review pane 스모크: 격리된 HOME으로 tauri dev를 띄우고, 앱 안의
# diffpane probe(src/qa.ts)가 일회용 저장소로 pane을 열어 DOM과 git index
# 불변을 검증한 결과를 qa.log로 받아 판정한다. macOS 전용(tauri dev).
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "diffpane smoke: macOS is required" >&2
  exit 1
fi

repo_root=$(
  CDPATH= cd -- "$(dirname "$0")/../.." &&
    pwd
)
cd "$repo_root"

state_root=$(mktemp -d "${TMPDIR:-/tmp}/dure-diffpane-qa.XXXXXX")
qa_home="$state_root/home"
app_log="$state_root/tauri-dev.log"
mkdir -p "$qa_home"
chmod 700 "$qa_home"

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
cleanup() {
  if [ -n "$dev_pid" ]; then
    terminate_tree "$dev_pid"
    wait "$dev_pid" 2>/dev/null || true
  fi
  rm -f "$repo_root/qa.autorun"
  rm -rf "$state_root" /tmp/dure-diffpane-qa
}
trap cleanup EXIT HUP INT TERM

pnpm hmux:runtime:stage:dev

echo diffpane > qa.autorun
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
config="{\"build\":{\"devUrl\":\"http://127.0.0.1:$vite_port\",\"beforeDevCommand\":\"pnpm exec vite --host 127.0.0.1 --port $vite_port\"},\"app\":{\"windows\":[{\"label\":\"main\",\"title\":\"Dure DiffPane QA\",\"url\":\"index.html\",\"width\":1100,\"height\":700,\"visible\":true}]}}"

# A3 스코프 체크가 $qa_home/.dure/server.json 을 읽으므로 채널을 stable로
# 고정한다 — 호출 셸의 DURE_APP_CHANNEL이 새면 descriptor가 channels/ 밑으로
# 이동해 체크가 서버 정상 상태에서도 실패한다.
HOME="$qa_home" DURE_APP_CHANNEL=stable VITE_DURE_APP_CHANNEL=stable pnpm tauri dev --no-watch --config "$config" >"$app_log" 2>&1 &
dev_pid=$!

i=0
while [ $i -lt 150 ]; do
  if [ -f qa.log ] && grep -q '"diffpane"' qa.log; then
    result=$(grep '"diffpane"' qa.log | tail -n 1)
    echo "$result"
    if printf '%s' "$result" | grep -q 'FAIL\|"error"'; then
      echo "diffpane smoke: FAIL" >&2
      exit 1
    fi
    # A3 스코프·게이트 실측: 살아있는 서버에 report 토큰의 control 라우트
    # 접근(403)과 confirm 없는 파괴적 라우트(428)를 확인한다. 실제 중지는
    # 게이트가 프론트 전달 전에 거절하므로 일어나지 않는다.
    if ! DURE_QA_HOME="$qa_home" python3 - <<'PY'
import json, os, urllib.request, urllib.error

home = os.environ["DURE_QA_HOME"]
with open(os.path.join(home, ".dure", "server.json"), encoding="utf-8") as f:
    srv = json.load(f)
port, control, report = srv["port"], srv["token"], srv.get("reportToken")
assert report, "server.json must publish reportToken"

def status(path, token, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=data,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST" if data is not None else "GET",
    )
    # correlated 라우트(perf.report)의 서버측 최악 응답은 ~7s(claim 후 504) —
    # 클라이언트 타임아웃은 그보다 길게, 네트워크 실패는 traceback으로 죽지
    # 말고 sentinel로 수렴시켜 4개 체크 상태를 전부 출력한다.
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.status
    except urllib.error.HTTPError as error:
        return error.code
    except urllib.error.URLError:
        return -1

checks = {
    "reportPing": (status("/ping", report), 200),
    "reportOnControlRoute": (status("/hmux/stop", report, {"name": "qa"}), 403),
    "controlStopWithoutConfirm": (status("/hmux/stop", control, {"name": "qa"}), 428),
    # perf.report(bd 9c9): 리로드 없는 실측 덤프가 correlated 경로로 응답하는지.
    "perfReport": (status("/perf/report", control, {}), 200),
}
failed = {k: v for k, v in checks.items() if v[0] != v[1]}
print("a3 scope checks:", {k: v[0] for k, v in checks.items()})
raise SystemExit(1 if failed else 0)
PY
    then
      echo "diffpane smoke: FAIL (a3 scope checks)" >&2
      exit 1
    fi
    echo "diffpane smoke: OK"
    exit 0
  fi
  if ! kill -0 "$dev_pid" 2>/dev/null; then
    echo "diffpane smoke: tauri dev exited early; log tail:" >&2
    tail -n 60 "$app_log" >&2
    exit 1
  fi
  sleep 2
  i=$((i + 1))
done
echo "diffpane smoke: TIMEOUT; app log tail:" >&2
tail -n 40 "$app_log" >&2
exit 1
