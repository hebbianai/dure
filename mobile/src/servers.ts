/** 서버 목록의 순수 로직. Tauri/DOM 없이 테스트된다. */

/** Rust `server_store::ServerEntry`와 같은 모양. */
export interface ServerEntry {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  /**
   * `SHA256:…`. 호스트 키 고정은 유일한 모드이므로 비어 있으면 연결할 수 없다.
   * An older entry saved without a fingerprint is carried as it is, and the
   * detail screen says so.
   */
  host_key_fingerprint: string;
  /** 페어링으로 들어온 항목인가. 지우면 노트북 없이는 되돌릴 수 없다. */
  paired: boolean;
  /**
   * 노트북이 이 기기의 연결용 키를 authorized_keys에 어떻게 넣었는지.
   * `forced_command` | `account_wide` | 빈 문자열(모름).
   */
  attach_key_confinement: string;
}

/** Rust `server_store::CONFINEMENT_*`와 같은 값. */
export const CONFINEMENT_FORCED_COMMAND = "forced_command";
export const CONFINEMENT_ACCOUNT_WIDE = "account_wide";

/**
 * 이 항목의 키가 서버에서 무엇을 할 수 있는지 한 줄로.
 *
 * `account_wide`를 숨기지 않는 것이 요점이다. 페어링 시점에는 아직 존재하지도
 * 않는 세션에 붙어야 하는데 강제 명령은 세션 id를 적어야 해서, 노트북이 넣을
 * 수 있는 연결용 줄에는 강제 명령이 없다 — 즉 그 키는 그 계정으로 아무 명령이나
 * 실행할 수 있다. 손으로 굳힌 서버와 똑같아 보이게 두면 거짓말이 된다.
 */
export function confinementNote(
  entry: ServerEntry,
  /**
   * 게이트웨이가 **관측해** 보고한 값. 아직 물어보지 않았거나 그 필드를 보내지
   * 않는 예전 게이트웨이면 `undefined`다.
   */
  observed?: boolean,
): string | undefined {
  if (!entry.paired) return undefined;

  // 관측이 의도를 이긴다. `attach_key_confinement`는 노트북이 *심으려 했던* 것이고
  // 이 값은 서버에서 *실제로 일어난* 것이다. 둘이 갈리는 실제 사례가 있었다:
  // Tailscale SSH는 세션을 직접 서빙하며 authorized_keys를 아예 열지 않으므로,
  // 페어링이 심은 `command="…",restrict`가 적용되지 않는다. 그런 서버에서 이
  // 화면은 "고정되어 있습니다"라고 거짓말을 했다 (2026-07-29 관측).
  if (observed === false) {
    return "이 서버에서는 강제 명령이 적용되지 않았습니다 — 키가 이 계정으로 어떤 명령이든 실행할 수 있습니다";
  }
  if (observed === true) {
    return "연결용 키가 강제 명령에 고정되어 있습니다 (서버에서 확인)";
  }

  // 관측이 없을 때만 페어링 시점의 의도로 말한다. 그리고 그것이 의도라는 것을
  // 문장이 드러낸다 — "확인"이라는 말을 붙이지 않는다.
  if (entry.attach_key_confinement === CONFINEMENT_FORCED_COMMAND) {
    return "연결용 키를 강제 명령에 고정해 설치했습니다 (아직 서버에서 확인하지 않음)";
  }
  if (entry.attach_key_confinement === CONFINEMENT_ACCOUNT_WIDE) {
    return "연결용 키에 강제 명령이 없습니다 — 이 계정으로 어떤 명령이든 실행할 수 있습니다";
  }
  return "연결용 키가 어떻게 제한되어 있는지 노트북이 알려주지 않았습니다";
}

export interface ServerDraft {
  id?: string;
  label: string;
  host: string;
  /** 사용자가 입력한 그대로. 빈 문자열이면 기본 포트. */
  port: string;
  username: string;
  hostKeyFingerprint: string;
  /** 편집 중인 항목이 페어링으로 들어왔는지. 저장할 때 그대로 보존한다. */
  paired?: boolean;
  attachKeyConfinement?: string;
}

export const DEFAULT_SSH_PORT = 22;

/** russh가 호스트 키를 `SHA256:<base64>`로 렌더링한다. 다른 형식은 절대 맞지 않는다. */
const FINGERPRINT_PREFIX = "SHA256:";

/**
 * One thing wrong with a draft. Shaped so an error that cannot happen cannot
 * be written: a port is never empty (blank means 22) and a fingerprint is
 * never required (it is learned from the host, not typed), so `empty` names
 * only the three typed fields.
 */
export type DraftFieldError =
  | { field: "label" | "host" | "username"; code: "empty" }
  | { field: "port"; code: "port_not_a_number" | "port_out_of_range" | "port_zero" }
  | { field: "hostKeyFingerprint"; code: "fingerprint_shape" };

export type DraftResult =
  | { ok: true; entry: ServerEntry }
  | { ok: false; errors: DraftFieldError[] };

/**
 * 입력값을 저장 가능한 항목으로 바꾼다.
 *
 * 포트를 `Number(text) || DEFAULT`로 쓰지 않는 이유: `"0"`과 `"abc"`가 모두
 * 22로 조용히 바뀐다. 0은 유효한 u16이라 Rust 쪽 serde도 통과하고, 실패는
 * 한참 뒤 연결 시점에 정체불명의 오류로 나타난다.
 *
 * 지문도 같은 이유로 여기서 모양을 본다. `SHA256:`이 없는 문자열은 완벽히
 * 정상적인 텍스트지만 호스트가 제시하는 값과 결코 같아질 수 없어서, 실패가
 * "호스트 키가 고정 목록에 없습니다"로 나온다 — 오타를 서버 문제로 오해하게
 * 만드는 메시지다.
 *
 * An empty fingerprint passes. The fingerprint is learned from the host when
 * it is added, so the edit screen has no field for it; if a save that only
 * fixes the port of a fingerprint-less entry from a hand-edited file were
 * refused here, that entry could never be fixed at all. The detail screen
 * says it cannot connect without a fingerprint, and 제거 → 추가 learns one again.
 */
export function draftToEntry(draft: ServerDraft, newId: () => string): DraftResult {
  const errors: DraftFieldError[] = [];

  const label = draft.label.trim();
  const host = draft.host.trim();
  const username = draft.username.trim();
  const portText = draft.port.trim();
  const hostKeyFingerprint = draft.hostKeyFingerprint.trim();

  if (label.length === 0) errors.push({ field: "label", code: "empty" });
  if (host.length === 0) errors.push({ field: "host", code: "empty" });
  if (username.length === 0) errors.push({ field: "username", code: "empty" });

  let port = DEFAULT_SSH_PORT;
  if (portText.length > 0) {
    if (!/^\d+$/.test(portText)) {
      errors.push({ field: "port", code: "port_not_a_number" });
    } else {
      const parsed = Number.parseInt(portText, 10);
      if (parsed === 0) {
        errors.push({ field: "port", code: "port_zero" });
      } else if (parsed > 65535) {
        errors.push({ field: "port", code: "port_out_of_range" });
      } else {
        port = parsed;
      }
    }
  }

  if (
    hostKeyFingerprint.length > 0 &&
    (!hostKeyFingerprint.startsWith(FINGERPRINT_PREFIX) ||
      hostKeyFingerprint.length === FINGERPRINT_PREFIX.length)
  ) {
    errors.push({ field: "hostKeyFingerprint", code: "fingerprint_shape" });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    entry: {
      id: draft.id ?? newId(),
      label,
      host,
      port,
      username,
      host_key_fingerprint: hostKeyFingerprint,
      // 편집이 출처를 지우지 않는다. 페어링 항목의 이름만 바꿨다고 해서
      // "노트북이 넣은 키"라는 사실이 사라지지는 않고, 그 사실이 사라지면
      // 삭제가 되돌릴 수 없다는 경고도 함께 사라진다.
      paired: draft.paired ?? false,
      attach_key_confinement: draft.attachKeyConfinement ?? "",
    },
  };
}

/** 저장된 항목을 다시 편집 화면으로. 지문이 없는 예전 항목도 그대로 실어 온다. */
export function entryToDraft(entry: ServerEntry): ServerDraft {
  return {
    id: entry.id,
    label: entry.label,
    host: entry.host,
    port: entry.port === DEFAULT_SSH_PORT ? "" : String(entry.port),
    username: entry.username,
    hostKeyFingerprint: entry.host_key_fingerprint,
    paired: entry.paired,
    attachKeyConfinement: entry.attach_key_confinement,
  };
}

/** 기본 포트는 감춘다 — 화면 폭이 좁아 의미 없는 글자를 지운다. */
export function formatEndpoint(entry: ServerEntry): string {
  const authority =
    entry.port === DEFAULT_SSH_PORT ? entry.host : `${entry.host}:${entry.port}`;
  return `${entry.username}@${authority}`;
}

/** 한글 라벨이 섞이므로 코드 포인트 정렬이 아니라 로케일 정렬을 쓴다. */
export function sortServers<T extends ServerEntry>(servers: readonly T[]): T[] {
  return [...servers].sort((left, right) => {
    const byLabel = left.label.localeCompare(right.label, "ko");
    if (byLabel !== 0) return byLabel;
    return formatEndpoint(left).localeCompare(formatEndpoint(right), "ko");
  });
}
