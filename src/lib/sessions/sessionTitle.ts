// 세션 제목/활동 텍스트 정리 — 일부 에이전트 CLI는 프롬프트를 감싼 봉투 태그를
// 그대로 터미널 타이틀(OSC 0/2)이나 훅 페이로드에 넣는다. 예: grok은 사용자
// 프롬프트를 <user_query>…</user_query> 로 감싸므로 "hi" 대신
// "<user_query> hi </user_query>" 가 사이드바 제목으로 올라온다.
// 여기서 태그만 벗겨 사람이 읽을 한 줄로 만든다.

/** 에이전트가 프롬프트/컨텍스트를 감쌀 때 쓰는 태그들 (짝이 깨져도 지운다 —
 *  OSC 타이틀은 길이 제한으로 잘려 닫는 태그가 없을 수 있다). */
const ENVELOPE_TAGS = [
  "user_query",
  "user-query",
  "userquery",
  "user_prompt",
  "system_reminder",
  "system-reminder",
  "user_info",
  "project_layout",
  "git_status",
  "background_context",
  "agent-memory",
  "fork-context",
  "command-name",
  "command-message",
  "command-args",
];

const ENVELOPE_TAG_RE = new RegExp(`</?(?:${ENVELOPE_TAGS.join("|")})\\s*/?>`, "gi");

/** `<tag>…</tag>` 로 전체가 감싸인 경우만 벗긴다 — 태그 이름을 몰라도 안전하게
 *  풀리고, 제목 중간의 `<div>` 같은 글자는 건드리지 않는다. */
const WRAPPED_RE = /^<([A-Za-z][\w.:-]*)>([\s\S]*)<\/\1>$/;

// Provider TUIs sometimes prefix a human title with the same activity mark
// they draw beside their own status line. Dure already renders one canonical
// provider glyph, so retaining this decoration looks like a duplicate logo.
// Require whitespace (or end-of-string) so an intentional symbol attached to
// a title is not stripped.
const PROVIDER_ACTIVITY_PREFIX_RE = /^(?:(?:[✻✳✶✽⏺◐◓◑◒⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])(?:\s+|$))+/u;

// Pi sets OSC 0/2 to `π - <session name> - <cwd>`. The pane already renders
// the canonical Pi glyph, so keep the useful session/cwd text and remove only
// that exact branded envelope. Accept typographic dashes used by extensions.
const PI_TITLE_PREFIX_RE = /^π\s*[-–—]\s*/u;

// Task notifications are internal metadata, including when a bounded preview
// cuts off the closing tag. Remove the payload before unwrapping envelopes.
const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*?(?:<\/task-notification>|$)/gi;

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

/** OSC 타이틀·훅 텍스트를 사이드바/패널 헤더용 한 줄로 정리한다. */
export function sanitizeSessionTitle(raw?: string | null): string {
  let text = oneLine((raw ?? "").replace(TASK_NOTIFICATION_RE, " "));
  for (let depth = 0; depth < 4; depth += 1) {
    const match = WRAPPED_RE.exec(text);
    if (!match) break;
    text = oneLine(match[2]);
  }
  // 태그만 남았으면 빈 문자열 — 호출부가 폴더명/기본 이름으로 폴백한다.
  return oneLine(
    text
      .replace(ENVELOPE_TAG_RE, " ")
      .replace(PROVIDER_ACTIVITY_PREFIX_RE, "")
      .replace(PI_TITLE_PREFIX_RE, ""),
  );
}
