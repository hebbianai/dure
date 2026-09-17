// unified diff 텍스트의 라인별 파일 귀속 (순수 로직) — diff 안 코드 라인에
// 그 파일의 언어 구문 강조를 입히기 위한 구간 계산. CodeMirror 없이 vitest로
// 검증 가능해야 한다.
import { splitDiffSections } from "@/lib/scm/diff/diffSections";

export interface DiffFileRegion {
  /** 이 구간이 시작하는 1-based 라인 번호 (`diff --git` 헤더 라인). */
  fromLine: number;
  /** 구간의 파일 경로 (표시/언어 판별용, b/ 쪽). */
  path: string;
}

/** `diff --git` 경계마다 구간을 만든다. 경계 이전 라인은 어떤 구간에도 없다. */
export function diffFileRegions(text: string): DiffFileRegion[] {
  return splitDiffSections(text).flatMap((section) =>
    section.file === null ? [] : [{ fromLine: section.fromLine, path: section.file }],
  );
}

/** line(1-based)이 속한 구간의 경로. 첫 경계 이전이면 null. */
export function regionPathAtLine(regions: DiffFileRegion[], line: number): string | null {
  let path: string | null = null;
  for (const region of regions) {
    if (region.fromLine > line) break;
    path = region.path;
  }
  return path;
}

/** 구간들이 건드리는 파일 경로 (중복 제거). 언어팩 preload 대상 산출용 —
 *  문법은 파일 단위가 아니라 언어 단위로 받으므로 경로 목록만 넘기면 된다. */
export function diffPathsIn(regions: readonly DiffFileRegion[]): string[] {
  return [...new Set(regions.map((region) => region.path))];
}
