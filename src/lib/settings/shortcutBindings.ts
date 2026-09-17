// 단축키 바인딩 — 카탈로그(기본값) + 사용자 재지정 → 실제로 동작하는 바인딩.
//
// 설정 › 단축키 페이지의 상태 필터(All/Modified/Unassigned/Conflicts)는 전부
// 여기서 나오는 값으로 센다. 키 이벤트 해석까지 순수 함수로 두어 vitest에서
// 실제 키 조합을 넣어 검증할 수 있게 했다 — 앱 전역 keydown 핸들러는 이
// 모듈의 matchesChord만 부른다.

import {
  allShortcuts,
  type Shortcut,
  shortcutDefinition,
} from "@/lib/settings/settingsShortcuts";

/** 동시에 누르는 한 조합. 표시용 키캡 문자열의 배열과 1:1로 대응한다. */
export interface KeyChord {
  /** ⌘(macOS) 또는 Ctrl */
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** 소문자 정규화한 주 키. "arrowleft", "backspace", "1", "p" 등 */
  key: string;
}

/** 재지정 값. null이면 "할당 없음"(사용자가 일부러 비운 것). */
export type ShortcutOverride = KeyChord | null;
export type ShortcutOverrides = Readonly<Record<string, ShortcutOverride>>;

const MOD = "⌘";
const SHIFT = "⇧";
const ALT = "⌥";

/** 키캡 라벨 → 주 키 이름. 카탈로그가 쓰는 기호를 이벤트 key와 잇는다. */
const LABEL_TO_KEY: Record<string, string> = {
  "⌫": "backspace",
  "←": "arrowleft",
  "→": "arrowright",
  "↑": "arrowup",
  "↓": "arrowdown",
  "+": "+",
  "−": "-",
  "↵": "enter",
};
const KEY_TO_LABEL: Record<string, string> = {
  backspace: "⌫",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  enter: "↵",
  " ": "Space",
  "-": "−",
};

/** 카탈로그의 키캡 시퀀스(["⌘","⇧","T"]) → KeyChord. 해석 못 하면 null. */
export function chordFromLabels(labels: readonly string[]): KeyChord | null {
  const chord: KeyChord = { mod: false, shift: false, alt: false, key: "" };
  for (const label of labels) {
    if (label === MOD) chord.mod = true;
    else if (label === SHIFT) chord.shift = true;
    else if (label === ALT) chord.alt = true;
    else if (label === "…") return null; // 범위 표기(⌘1…⌘9)는 단일 조합이 아니다
    else chord.key = (LABEL_TO_KEY[label] ?? label).toLowerCase();
  }
  return chord.key ? chord : null;
}

/** KeyChord → 키캡 시퀀스. 표시 순서는 ⌘ ⇧ ⌥ 다음 주 키로 고정한다. */
export function chordToLabels(chord: KeyChord): string[] {
  const labels: string[] = [];
  if (chord.mod) labels.push(MOD);
  if (chord.shift) labels.push(SHIFT);
  if (chord.alt) labels.push(ALT);
  const main = KEY_TO_LABEL[chord.key] ?? chord.key.toUpperCase();
  labels.push(main);
  return labels;
}

/**
 * 같은 물리 키의 shift 변형을 하나로 모은다 — US 배열에서 ⌘+는 실제로 ⌘⇧=로,
 * ⌘_는 ⌘⇧-로 도착한다. 이 둘을 갈라 두면 "⌘ +"라고 적힌 단축키가 배열에 따라
 * 안 먹는다. 그래서 +/− 는 shift를 보지 않는다(기존 폰트 크기 핸들러와 동일).
 *
 * `?` → `/`는 다른 이유로 필요하다: US 배열에서 ⇧/는 event.key를 "?"로
 * 보낸다. 카탈로그가 "/"를 메인 키로, "⇧"을 **별도** 라벨로 명시하는
 * feedback.command(⌘⇧/) 같은 조합은 +/−와 달리 shift 여부를 그대로 봐야
 * 하므로, "/"는 SHIFT_INSENSITIVE에 넣지 않는다 — 그래야 맨 ⌘/는 계속
 * 안 잡힌다(리뷰 지적: 원래 별칭이 없어 ⌘⇧/가 아예 발동하지 않았다).
 */
const KEY_ALIASES: Record<string, string> = { "=": "+", _: "-", "?": "/" };
const SHIFT_INSENSITIVE = new Set(["+", "-"]);

/** 키보드 이벤트 → KeyChord. 수정 키만 눌린 상태는 조합이 아니므로 null. */
export function chordFromEvent(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): KeyChord | null {
  const raw = event.key.toLowerCase();
  if (raw === "meta" || raw === "control" || raw === "shift" || raw === "alt") return null;
  // ⌘⇧T처럼 shift가 걸리면 event.key가 대문자로 오는데, 소문자로 정규화해
  // 저장·비교 양쪽이 같은 표현을 쓰게 한다.
  const key = KEY_ALIASES[raw] ?? raw;
  return {
    mod: event.metaKey || event.ctrlKey,
    shift: SHIFT_INSENSITIVE.has(key) ? false : event.shiftKey,
    alt: event.altKey,
    key,
  };
}

function chordEquals(a: KeyChord | null, b: KeyChord | null): boolean {
  if (!a || !b) return false;
  return a.mod === b.mod && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
}

/**
 * 설정에서 새 조합을 받는 중인가.
 *
 * 캡처 중에는 전역 단축키가 하나도 발동하면 안 된다 — ⌘W를 지정하려고 눌렀는데
 * pane이 닫히면 안 되니까. stopPropagation으로는 막을 수 없다(같은 window
 * 노드에 먼저 등록된 리스너는 그대로 실행된다). 그래서 모든 전역 핸들러가
 * 반드시 거치는 matchesChord에서 잠근다.
 */
let captureActive = false;
export function setShortcutCaptureActive(active: boolean): void {
  captureActive = active;
}
export function isShortcutCaptureActive(): boolean {
  return captureActive;
}

/** 이 이벤트가 해당 조합인가. 앱 전역 핸들러의 유일한 판정 경로다. */
export function matchesChord(
  chord: KeyChord | null,
  event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
): boolean {
  if (captureActive) return false;
  return chordEquals(chord, chordFromEvent(event));
}

/**
 * 전역 단축키로 받아도 되는 조합인가.
 *
 * ⌘/Ctrl이나 ⌥ 중 하나는 반드시 있어야 한다. 맨 키(Space·Enter·문자)를 그대로
 * 받으면 그 순간부터 앱 어디서든 타이핑이 가로채인다 — 키캡 버튼을 클릭한 직후
 * Space를 누르는 건 아주 흔한 사고다.
 */
export function isBindableChord(chord: KeyChord | null): chord is KeyChord {
  return chord !== null && (chord.mod || chord.alt);
}

/** "명시적으로 재지정했는가". 재지정 값은 KeyChord 아니면 null만 저장되므로
 *  (persistedAppState의 정규화가 보장한다) undefined면 곧 "재지정 없음"이다.
 *  Object.hasOwn은 이 프로젝트의 TS lib 타깃에 없어 쓰지 않는다. */
function hasOverrideKey(overrides: ShortcutOverrides, id: string): boolean {
  return overrides[id] !== undefined;
}

/** 재지정을 얹은 새 맵. store 리듀서가 그대로 쓴다. */
export function withShortcutOverride(
  overrides: ShortcutOverrides,
  id: string,
  chord: ShortcutOverride,
): Record<string, ShortcutOverride> {
  return { ...overrides, [id]: chord };
}

/** 재지정을 걷어낸 새 맵(= 카탈로그 기본값으로 복귀). 원래 없었으면 같은
 *  참조를 돌려줘 불필요한 store 갱신이 일어나지 않게 한다. */
export function withoutShortcutOverride(
  overrides: ShortcutOverrides,
  id: string,
): ShortcutOverrides {
  if (overrides[id] === undefined) return overrides;
  const { [id]: _removed, ...rest } = overrides;
  return rest;
}

export interface ResolvedShortcut extends Shortcut {
  /** 이 항목을 재지정할 수 있는가. 해석 뒤 keys가 비어도(할당 해제) 유지되므로
   *  UI는 반드시 이 값을 봐야 한다 — isRebindable(resolved)는 쓰면 안 된다. */
  rebindable: boolean;
  /** 실제로 동작하는 조합. null이면 할당 없음. */
  chord: KeyChord | null;
  /** 기본값에서 바뀌었는가 */
  modified: boolean;
  /** 할당이 비어 있는가 */
  unassigned: boolean;
  /** 표시용 키캡 시퀀스들 (카탈로그의 범위 표기를 유지) */
  keys: readonly (readonly string[])[];
}

/** 카탈로그가 단일 조합으로 표현되지 않는 항목(⌘1…⌘9)은 재지정 대상에서 뺀다. */
export function isRebindable(shortcut: Shortcut): boolean {
  return shortcut.keys.length === 1 && chordFromLabels(shortcut.keys[0]) !== null;
}

/** 기본 카탈로그에 사용자 재지정을 얹어 실제 바인딩을 만든다. */
export function resolveShortcuts(
  overrides: ShortcutOverrides,
  catalog: readonly Shortcut[] = allShortcuts(),
): ResolvedShortcut[] {
  return catalog.map((shortcut) => {
    // 범위 표기(⌘1…⌘9)는 단일 조합으로 못 쓰지만 "할당이 없는" 것은 아니다 —
    // 전용 핸들러가 이미 처리한다. 재지정 대상에서만 빼고 배정된 것으로 센다.
    const rebindable = isRebindable(shortcut);
    const base = rebindable ? chordFromLabels(shortcut.keys[0]) : null;
    const hasOverride = rebindable && hasOverrideKey(overrides, shortcut.id);
    const chord = hasOverride ? overrides[shortcut.id] : base;
    return {
      ...shortcut,
      rebindable,
      chord,
      modified: hasOverride && !chordEquals(chord, base),
      unassigned: rebindable && chord === null,
      keys: chord ? [chordToLabels(chord)] : hasOverride ? [] : shortcut.keys,
    };
  });
}

/** 특정 명령의 현재 조합. 전역 핸들러가 쓰는 조회 함수. */
export function shortcutChord(
  id: string,
  overrides: ShortcutOverrides,
  catalog?: readonly Shortcut[],
): KeyChord | null {
  const shortcut =
    catalog === undefined
      ? shortcutDefinition(id)
      : catalog.find((candidate) => candidate.id === id);
  if (!shortcut) return null;
  const base = shortcut.keys.length === 1 ? chordFromLabels(shortcut.keys[0]) : null;
  return hasOverrideKey(overrides, id) && base !== null ? overrides[id] : base;
}

/**
 * 같은 조합을 두 명령이 나눠 가진 경우.
 *
 * source가 다른 항목(앱 vs 터미널)은 충돌로 세지 않는다 — 그 둘의 우선순위는
 * 설정 › 단축키 › Terminal의 단축키가 이미 정하고 있어서, 겹치는 것 자체가
 * 의도된 설계다.
 */
export function conflictingShortcutIds(resolved: readonly ResolvedShortcut[]): Set<string> {
  const byChord = new Map<string, ResolvedShortcut[]>();
  for (const shortcut of resolved) {
    if (!shortcut.chord) continue;
    const key = `${shortcut.source}|${shortcut.chord.mod}|${shortcut.chord.shift}|${shortcut.chord.alt}|${shortcut.chord.key}`;
    byChord.set(key, [...(byChord.get(key) ?? []), shortcut]);
  }
  const conflicted = new Set<string>();
  for (const group of byChord.values()) {
    if (group.length < 2) continue;
    for (const shortcut of group) conflicted.add(shortcut.id);
  }
  return conflicted;
}

export type ShortcutStatusFilter = "all" | "modified" | "unassigned" | "conflicts";

/** 상태 필터별 개수 — 페이지 왼쪽 목록의 숫자. */
export function shortcutStatusCounts(
  resolved: readonly ResolvedShortcut[],
): Record<ShortcutStatusFilter, number> {
  const conflicts = conflictingShortcutIds(resolved);
  return {
    all: resolved.length,
    modified: resolved.filter((s) => s.modified).length,
    unassigned: resolved.filter((s) => s.unassigned).length,
    conflicts: conflicts.size,
  };
}

/** 상태 필터 + 검색어를 함께 적용한다. 검색은 명령 이름과 키 표기 양쪽을 본다. */
export function filterShortcuts(
  resolved: readonly ResolvedShortcut[],
  status: ShortcutStatusFilter,
  query: string,
  translate: (command: string) => string = (command) => command,
): ResolvedShortcut[] {
  const conflicts = status === "conflicts" ? conflictingShortcutIds(resolved) : null;
  const normalized = query.trim().toLowerCase();
  return resolved.filter((shortcut) => {
    if (status === "modified" && !shortcut.modified) return false;
    if (status === "unassigned" && !shortcut.unassigned) return false;
    if (conflicts && !conflicts.has(shortcut.id)) return false;
    if (!normalized) return true;
    const haystack = `${translate(shortcut.command)} ${shortcut.keys.flat().join(" ")}`;
    return haystack.toLowerCase().includes(normalized);
  });
}
