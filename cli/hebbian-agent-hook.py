#!/usr/bin/env python3
# hebbian agent activity hook — HebbianIDE가 관리한다(재설치/업데이트 시 덮어씀).
#
# 각 에이전트(claude/codex/kimi)의 검토된 활동 훅에 걸려, 프롬프트와
# turn 상태를 앱 로컬 서버로 보고한다. 앱은 이걸 "이 에이전트가 지금 하는
# 작업"과 Host 소유 runtime fact로 쓴다 (herdr식 — 훅으로 세션↔작업 매핑).
#
# 매핑: 데몬이 에이전트 프로세스에 심은 HEBBIAN_SESSION(=우리 sessionId)을
# 훅이 상속받아 되돌려주므로, 로그 파싱·세션 id 부여 없이 정확히 매핑된다.
#
# 의존성 없음(python3 표준 라이브러리만). 실패는 조용히 무시 — 훅이 에이전트
# 동작을 절대 막지 않게 한다.

import json
import os
import re
import sys
import urllib.request


def extract_prompt(raw):
    """provider마다 stdin 형식이 조금씩 다르다. JSON이면 알려진 필드에서,
    아니면 평문 전체를 프롬프트로 본다."""
    raw = raw.strip()
    if not raw:
        return ""
    try:
        data = json.loads(raw)
    except Exception:
        return raw  # 일부 provider는 평문 프롬프트를 그대로 넘긴다
    if isinstance(data, str):
        return data.strip()
    if not isinstance(data, dict):
        return ""
    for key in ("prompt", "user_prompt", "userPrompt", "message", "text", "input", "content"):
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""

def extract_conversation_id(data):
    """Forward only a bounded provider-native identity, never arbitrary hook data."""
    if not isinstance(data, dict):
        return ""
    for key in ("session_id", "sessionId", "conversation_id", "conversationId"):
        value = data.get(key)
        if not isinstance(value, str):
            continue
        value = value.strip()
        if value and len(value) <= 256 and re.fullmatch(r"[A-Za-z0-9._:+-]+", value):
            return value
    return ""


def inherited_hmux_fence(session_id):
    """Return the complete non-secret Host generation inherited by the hook."""
    values = {
        "workspaceId": os.environ.get("HMUX_WORKSPACE_ID", "").strip(),
        "sessionId": session_id.strip(),
        "runnerPrincipal": os.environ.get("HMUX_RUNNER_PRINCIPAL", "").strip(),
        "runnerInstance": os.environ.get("HMUX_RUNNER_INSTANCE", "").strip(),
        "channelEpoch": os.environ.get("HMUX_CHANNEL_EPOCH", "").strip(),
        "hostInstanceId": os.environ.get("HMUX_HOST_INSTANCE_ID", "").strip(),
        "terminalEpoch": os.environ.get("HMUX_TERMINAL_EPOCH", "").strip(),
    }
    identity_fields = (
        "workspaceId",
        "sessionId",
        "runnerPrincipal",
        "runnerInstance",
        "hostInstanceId",
        "terminalEpoch",
    )
    if not all(
        0 < len(values[field]) <= 256
        and re.fullmatch(r"[A-Za-z0-9._:+-]+", values[field])
        for field in identity_fields
    ):
        return None
    if not re.fullmatch(r"[0-9]+", values["channelEpoch"]):
        return None
    try:
        channel_epoch = int(values["channelEpoch"])
    except ValueError:
        return None
    if channel_epoch <= 0 or channel_epoch > 18446744073709551615:
        return None
    return values


def has_hmux_generation_evidence():
    """Distinguish a malformed current Host fence from a legacy Host."""
    return any(
        os.environ.get(name, "").strip()
        for name in (
            "HMUX_RUNNER_PRINCIPAL",
            "HMUX_RUNNER_INSTANCE",
            "HMUX_CHANNEL_EPOCH",
            "HMUX_HOST_INSTANCE_ID",
            "HMUX_TERMINAL_EPOCH",
        )
    )


# 훅 이벤트 → 4상태 매핑 (B2). provider별 capability matrix:
#   claude: UserPromptSubmit/Stop/Notification 3종 → working/done/blocked
#   codex: UserPromptSubmit/Stop → working/done
#   kimi: UserPromptSubmit만 → working 힌트 (종료/승인은 hmux semantic·
#         화면 폴백이 담당)
# SubagentStop은 상위 세션 상태가 아니므로 무시.
EVENT_STATE = {
    "UserPromptSubmit": "working",
    "Stop": "done",
    # Notification은 아래 main()에서 메시지 내용으로 blocked/waiting을 가른다.
}


def app_root():
    """앱 홈 해석 — DURE_HOME > ~/.dure.

    Legacy ~/.hebbian is a migrate-home input, never a writable fallback.
    """
    override = os.environ.get("DURE_HOME")
    if override:
        return override
    return os.path.expanduser("~/.dure")


def post(port, token, path, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=body,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=0.5).read()
    except Exception:
        pass


def main():
    # legacy 호스트는 HEBBIAN_SESSION, 관리형 hmux runtime은 HMUX_SESSION_ID(=동일 id).
    # hmux 중립성 때문에 HEBBIAN_SESSION을 안 심으므로 폴백한다 (UC-16).
    if os.environ.get("HMUX") == "1":
        session_id = os.environ.get("HMUX_SESSION_ID") or os.environ.get("HEBBIAN_SESSION")
    else:
        session_id = os.environ.get("HEBBIAN_SESSION") or os.environ.get("HMUX_SESSION_ID")
    if not session_id:
        return

    # argv[1] = provider (claude/codex/kimi) — 훅이 어느 provider config에 걸렸는지.
    # 이걸로 앱이 화면 감지 없이 provider를 확정한다(codex 등 TUI 감지 실패 대비).
    provider = sys.argv[1] if len(sys.argv) > 1 else ""
    # argv[2] = 이벤트 이름 폴백 (stdin JSON에 hook_event_name이 없는 provider용)
    event_arg = sys.argv[2] if len(sys.argv) > 2 else ""

    raw = sys.stdin.read()
    event = event_arg or "UserPromptSubmit"
    data = {}
    try:
        parsed = json.loads(raw.strip() or "{}")
        if isinstance(parsed, dict):
            data = parsed
            if isinstance(data.get("hook_event_name"), str):
                event = data["hook_event_name"]
    except Exception:
        pass
    conversation_id = extract_conversation_id(data)
    session_fence = inherited_hmux_fence(session_id)
    has_generation_evidence = has_hmux_generation_evidence()

    try:
        with open(os.path.join(app_root(), "server.json"), encoding="utf-8") as f:
            srv = json.load(f)
    except Exception:
        return
    # A3: 훅은 에이전트 세션 내부에서 실행되므로 report 전용 토큰을 우선
    # 사용한다 — 이 토큰은 보고 라우트(/hooks, /activity)만 통과하고 세션
    # 조작 라우트에서는 403이다. 구 앱(reportToken 없음)은 token으로 폴백.
    port = srv.get("port")
    token = srv.get("reportToken") or srv.get("token")
    if not port or not token:
        return

    # 상태 보고 (/hooks) — 이벤트가 상태로 매핑될 때만.
    state = EVENT_STATE.get(event)
    # Notification은 승인 요청 외에 60초 idle 알림에도 온다 — 승인 신호가
    # 있을 때만 blocked, 아니면 waiting(입력 대기). 이 문자열 판별은 host
    # semantic이 없는 legacy 세션의 best-effort 표시용일 뿐이다(권위 아님).
    if event == "Notification":
        msg = data.get("message") if isinstance(data.get("message"), str) else ""
        state = "blocked" if re.search(r"permission|approval|allow", msg or "", re.I) else "waiting"
    if state:
        payload = {"sessionId": session_id, "state": state, "event": event}
        # --terminal-events: 설치자가 이 provider에 종료/승인 이벤트까지
        # 등록했다는 선언 — 앱은 이 capability로 working lease를 정한다
        # (provider 이름 분기 금지 — 확장성 불변식).
        payload["terminalEvents"] = "--terminal-events" in sys.argv
        if provider:
            payload["provider"] = provider
        if conversation_id:
            payload["conversationId"] = conversation_id
            if session_fence is not None or has_generation_evidence:
                payload["sessionFence"] = session_fence
        post(port, token, "/hooks", payload)

    # "지금 하는 작업" 문자열 보고 (/activity) — 기존 동작 유지.
    text = extract_prompt(raw)
    if event == "UserPromptSubmit" and text:
        text = " ".join(text.split())[:200]
        payload = {"sessionId": session_id, "text": text}
        if provider:
            payload["provider"] = provider
        if conversation_id:
            payload["conversationId"] = conversation_id
            if session_fence is not None or has_generation_evidence:
                payload["sessionFence"] = session_fence
        post(port, token, "/activity", payload)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    finally:
        # Codex Stop 훅은 exit 0의 stdout을 JSON으로 파싱한다. 로컬 보고가
        # 불가능해도 빈 성공 응답을 보내 에이전트 turn을 오염시키지 않는다.
        if len(sys.argv) > 2 and sys.argv[1] == "codex" and sys.argv[2] == "Stop":
            sys.stdout.write("{}\n")
