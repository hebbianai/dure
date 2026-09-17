// Diff Review pane의 순수 로직 — unified diff 파싱/라인 분류/배지 포맷.
// CodeMirror·Tauri 없이 vitest로 검증 가능해야 한다.

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

const META_PREFIXES = [
  "diff --git ",
  "index ",
  "new file mode",
  "deleted file mode",
  "old mode",
  "new mode",
  "similarity index",
  "dissimilarity index",
  "rename from",
  "rename to",
  "copy from",
  "copy to",
  "Binary files ",
  "\\ No newline",
];

/**
 * unified diff의 한 줄을 렌더링 종류로 분류한다.
 * `+++`/`---` 헤더는 `a/`·`b/`·`/dev/null`·따옴표 경로가 뒤따를 때만 meta로
 * 본다 — `-- SQL 주석` 같은 내용 삭제 라인(`--- …`)을 meta로 죽이지 않기 위함
 * (백엔드가 diff.noprefix=false를 고정하므로 헤더엔 항상 접두가 붙는다).
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (/^(\+\+\+|---) ("?[ab]\/|\/dev\/null)/.test(line)) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (META_PREFIXES.some((p) => line.startsWith(p))) return "meta";
  return "context";
}

/** 파일별 +N/−N 배지 문자열. binary(numstat `-`)는 null로 들어온다. */
export function statLabel(f: { added: number | null; deleted: number | null }): string {
  if (f.added === null || f.deleted === null) return "BIN";
  return `+${f.added} −${f.deleted}`;
}

/** 전체 합계 배지용 totals. binary 파일은 count에서 제외하고 개수만 센다. */
export function statTotals(files: { added: number | null; deleted: number | null }[]): {
  added: number;
  deleted: number;
  binary: number;
} {
  let added = 0;
  let deleted = 0;
  let binary = 0;
  for (const f of files) {
    if (f.added === null || f.deleted === null) binary++;
    else {
      added += f.added;
      deleted += f.deleted;
    }
  }
  return { added, deleted, binary };
}
