// 터미널 pane이 가로채는 편집 키 → 보낼 제어문자. 조합은 설정 › 단축키의
// 재지정을 그대로 따르고(lib/shortcutBindings), 여기는 "어떤 조합이 어떤
// 동작인가"만 결정한다 — xterm 없이 vitest로 검증하려고 분리했다.

import {
  chordFromEvent,
  isBindableChord,
  matchesChord,
  shortcutChord,
  type ShortcutOverrides,
} from "@/lib/settings/shortcutBindings";

export type TerminalKeyAction = "copy" | "kill-line" | "bol" | "eol" | "kill-word";

/** 동작 → PTY로 보낼 제어문자. copy는 클립보드라 시퀀스가 없다. */
export const TERMINAL_CONTROL_SEQUENCE: Record<Exclude<TerminalKeyAction, "copy">, string> = {
  "kill-line": "\x15", // ^U
  bol: "\x01", // ^A
  eol: "\x05", // ^E
  "kill-word": "\x17", // ^W
};

/** 카탈로그의 명령 id ↔ 동작. 순서가 곧 판정 우선순위다. */
const ACTION_BY_SHORTCUT: readonly [string, TerminalKeyAction][] = [
  ["term-copy", "copy"],
  ["term-kill-line", "kill-line"],
  ["term-bol", "bol"],
  ["term-eol", "eol"],
  ["term-kill-word", "kill-word"],
];

export interface TerminalKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * 이 키 입력이 가로챌 편집 동작인가. 아니면 null(그대로 터미널로 넘긴다).
 *
 * 할당을 해제한 항목은 shortcutChord가 null을 돌려주고 matchesChord가 false라
 * 자동으로 통과된다 — 해제하면 그 키가 다시 셸로 간다.
 */
export function terminalKeyAction(
  event: TerminalKeyEvent,
  overrides: ShortcutOverrides,
): TerminalKeyAction | null {
  // Ctrl은 터미널의 것이다 — 절대 가로채지 않는다.
  //
  // KeyChord의 mod는 "플랫폼 명령 수정 키"라 ⌘와 Ctrl을 하나로 본다. 앱 전역
  // 단축키에는 그게 맞지만 터미널에서는 치명적이다: 그대로 두면 ⌘C 바인딩이
  // Ctrl+C에도 걸려, 선택 영역이 있을 때 SIGINT가 복사로 먹힌다(그리고 아무것도
  // PTY로 안 나가서 선택이 안 풀려 계속 반복된다). Ctrl+←/→/⌫도 단어 이동·단어
  // 삭제 대신 줄 이동·줄 삭제가 된다. 기존 핸들러의 !e.ctrlKey 조건과 같다.
  if (event.ctrlKey) return null;
  if (!isBindableChord(chordFromEvent(event))) return null;
  for (const [id, action] of ACTION_BY_SHORTCUT) {
    if (matchesChord(shortcutChord(id, overrides), event)) return action;
  }
  return null;
}

/**
 * 이 키 입력이 PTY로 보내야 할 제어문자. 복사이거나 해당 없음이면 null.
 *
 * 편집 동작은 결국 "제어문자 하나를 보낸다"로 끝나므로, 소비자가 동작 이름과
 * 시퀀스 표를 다시 맞춰보지 않도록 여기서 한 번에 답한다.
 */
export function terminalEditingSequence(
  event: TerminalKeyEvent,
  overrides: ShortcutOverrides,
): string | null {
  const action = terminalKeyAction(event, overrides);
  return action === null || action === "copy"
    ? null
    : TERMINAL_CONTROL_SEQUENCE[action];
}
