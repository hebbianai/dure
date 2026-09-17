#!/bin/sh
# Spawn saga E2E smoke (test-harness-blueprint §1) — 실행 중인 debug 앱에 대고
# fake provider로 /spawn/v2 전 과정을 밀폐 검증한다. 토큰 소모 0.
#
# 전제:
#   1) debug 앱이 fake provider 주입 env와 함께 떠 있어야 한다:
#        HEBBIAN_QA_PROVIDER_BIN="$(pwd)/scripts/qa/fake-provider" pnpm tauri dev
#   2) 앱 store에 로컬 프로젝트가 등록돼 있어야 한다.
# 사용:
#   sh scripts/qa/spawn-saga-smoke.sh <project-name> [scenario-word]
#   scenario-word 기본 "ok" — fake provider의 첫 프롬프트 단어 스크립팅과 일치.
set -eu

PROJECT="${1:?usage: spawn-saga-smoke.sh <project-name> [scenario]}"
SCENARIO="${2:-ok}"
NAME="saga-smoke-$(date +%s)"

python3 - "$PROJECT" "$SCENARIO" "$NAME" <<'PYEOF'
import hashlib, json, os, sys, time, urllib.request

project, scenario, name = sys.argv[1:4]
srv = json.load(open(os.path.expanduser("~/.hebbian/server.json")))
base = f"http://127.0.0.1:{srv['port']}"
headers = {"Authorization": f"Bearer {srv['token']}", "Content-Type": "application/json"}

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read())

prompt = f"{scenario} smoke prompt"
status, created = call("POST", "/spawn/v2", {
    "project": project, "name": name, "provider": "claude",
    "prompt": prompt, "useWorktree": True,
})
assert status == 202 and created.get("ok"), f"spawn/v2 응답 이상: {status} {created}"
receipt_id = created["receiptId"]
print(f"receiptId={receipt_id}")

deadline = time.time() + 90
final = None
while time.time() < deadline:
    _, body = call("GET", f"/spawn/{receipt_id}")
    receipt = body.get("receipt", {})
    state = receipt.get("state")
    if state in ("succeeded", "failed", "compensated", "manual_intervention_required"):
        final = receipt
        break
    time.sleep(2)
assert final, "90초 내 terminal state 미도달"

steps = {s["step"]: s for s in final["steps"]}
evidence = steps.get("prompt_delivery", {}).get("evidence", {}).get("level")
delivery = steps.get("prompt_delivery", {}).get("delivery", {})
print(f"state={final['state']}")
for s in final["steps"]:
    print(f"  {s['step']}: {s['status']}")
print(f"evidence={evidence}")

if scenario == "ok":
    assert final["state"] == "succeeded", f"기대 succeeded, 실제 {final['state']}"
    bad = [s['step'] for s in final['steps'] if s['status'] not in ('ok', 'skipped')]
    assert not bad, f"미종결 단계: {bad}"
    assert evidence == "written_to_pty", f"Host write 증거 미기록: {evidence}"
    assert delivery.get("state") == "written_to_pty", f"전달 상태 이상: {delivery}"
    assert delivery.get("promptDigest") == "sha256:" + hashlib.sha256(prompt.encode()).hexdigest()
    assert delivery.get("promptLen") == len(prompt.encode())
    host_receipt = delivery.get("receipt", {})
    assert host_receipt.get("terminalEpoch"), f"terminal epoch 누락: {host_receipt}"
    assert host_receipt.get("recordId", "").isdigit() and int(host_receipt["recordId"]) > 0
    assert host_receipt.get("inputBaselineOutputSequence", "").isdigit()
    revision = host_receipt.get("initialAgentRuntimeRevision")
    assert revision is None or (revision.isdigit() and int(revision) > 0)
print("SMOKE OK")
PYEOF
