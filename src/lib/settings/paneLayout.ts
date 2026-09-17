// 분할 패널 표시값의 정규화 — 설정 인풋과 Workspace 배선이 같은 규칙을 쓴다.
//
// 인풋은 사용자가 아무 문자열이나 칠 수 있는 자리라, 확정 시점에 한 번만
// 정규화한다(NumberField와 같은 판단). 값이 비었거나 숫자가 아니면 기본값으로
// 되돌린다.

/** 분할선 두께(px)의 허용 범위. 0은 경계가 사라지고, 12를 넘으면 내용이 밀린다. */
export const MIN_SPLITTER_SIZE = 1;
export const MAX_SPLITTER_SIZE = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 분할선은 정수 px만 쓴다 — 소수 px는 브라우저마다 다르게 반올림된다. */
export function normalizeSplitterSize(raw: string | number, fallback: number): number {
  const parsed = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(parsed) || String(raw).trim() === "") return fallback;
  return clamp(Math.round(parsed), MIN_SPLITTER_SIZE, MAX_SPLITTER_SIZE);
}
