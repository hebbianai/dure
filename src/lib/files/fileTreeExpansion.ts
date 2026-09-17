/** 탐색기 파일 트리의 "펼쳐진 디렉토리" 상태.
 *  트리 키(레포 cwd + 소스 + 호스트) 단위로 저장해, 같은 디렉토리로
 *  다시 돌아오면 — 탭 전환·리마운트·앱 재시작 후에도 — 펼침이 복원된다. */
export interface FileTreeExpansionState {
  /** treeKey → 펼쳐진 디렉토리 절대경로 목록(펼친 순서 유지) */
  trees: Record<string, string[]>;
  /** LRU 명시용 — 오래된 키가 앞, 최근 키가 뒤 */
  recency: string[];
}

export const MAX_TREES = 20;
export const MAX_PATHS_PER_TREE = 200;

export type FileTreeSource = "local" | "ssh";

/** trailing 구분자만 제거한다 — realpath·대소문자 변환은 사용자 가시 경로
 *  정체성을 깨뜨리므로 하지 않는다. 루트("/")는 보존. */
function normalizeTreeCwd(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** 콜론 결합은 경로에 든 콜론과 충돌할 수 있어 JSON 튜플로 인코딩한다.
 *  SSH는 표시 이름이 아닌 hostId를 써서 호스트 이름 변경에도 상태가 유지된다. */
export function fileTreeKey(
  source: FileTreeSource,
  hostId: string | undefined,
  cwd: string,
): string {
  return JSON.stringify([
    source,
    source === "ssh" ? (hostId ?? "") : "",
    normalizeTreeCwd(cwd),
  ]);
}

export function isExpanded(
  state: Pick<FileTreeExpansionState, "trees">,
  key: string,
  path: string,
): boolean {
  return state.trees[key]?.includes(path) ?? false;
}

function touchRecency(recency: string[], key: string): string[] {
  const rest = recency.filter((k) => k !== key);
  rest.push(key);
  return rest;
}

/** 접기는 해당 디렉토리 하나만 제거하고 자손 플래그는 남긴다 — 부모를
 *  다시 펼치면 이전의 하위 전개가 그대로 복원된다. */
export function toggleExpanded(
  state: FileTreeExpansionState,
  key: string,
  path: string,
): FileTreeExpansionState {
  const current = state.trees[key] ?? [];
  let nextPaths: string[];
  if (current.includes(path)) {
    nextPaths = current.filter((p) => p !== path);
  } else {
    nextPaths = [...current, path];
    while (nextPaths.length > MAX_PATHS_PER_TREE) nextPaths.shift();
  }

  const trees = { ...state.trees };
  let recency: string[];
  if (nextPaths.length === 0) {
    delete trees[key];
    recency = state.recency.filter((k) => k !== key);
  } else {
    trees[key] = nextPaths;
    recency = touchRecency(state.recency, key);
    while (recency.length > MAX_TREES) {
      const evicted = recency.shift();
      if (evicted !== undefined) delete trees[evicted];
    }
  }
  return { trees, recency };
}

/** 트리를 최근 사용으로 표시한다. 저장된 트리가 없거나 이미 맨 뒤면
 *  같은 참조를 돌려줘 불필요한 저장(setItem)을 막는다. */
export function touchTree(
  state: FileTreeExpansionState,
  key: string,
): FileTreeExpansionState {
  if (!(key in state.trees)) return state;
  if (state.recency[state.recency.length - 1] === key) return state;
  return { trees: state.trees, recency: touchRecency(state.recency, key) };
}

/** hydration 방어 — 문자열 검증·중복 제거·상한 적용, 손상 데이터는 빈 상태로. */
export function normalizeExpansionState(raw: unknown): FileTreeExpansionState {
  const empty: FileTreeExpansionState = { trees: {}, recency: [] };
  if (typeof raw !== "object" || raw === null) return empty;
  const rawTrees = (raw as { trees?: unknown }).trees;
  const rawRecency = (raw as { recency?: unknown }).recency;
  if (typeof rawTrees !== "object" || rawTrees === null) return empty;

  const trees: Record<string, string[]> = {};
  for (const [key, paths] of Object.entries(rawTrees)) {
    if (!Array.isArray(paths)) continue;
    const cleaned = [...new Set(paths.filter((p): p is string => typeof p === "string"))];
    if (cleaned.length === 0) continue;
    trees[key] = cleaned.slice(-MAX_PATHS_PER_TREE);
  }

  const seen = new Set<string>();
  const recency: string[] = [];
  const pushKey = (key: unknown) => {
    if (typeof key !== "string" || seen.has(key) || !(key in trees)) return;
    seen.add(key);
    recency.push(key);
  };
  if (Array.isArray(rawRecency)) rawRecency.forEach(pushKey);
  Object.keys(trees).forEach(pushKey); // recency에 빠진 트리는 뒤(최근)로 붙인다
  while (recency.length > MAX_TREES) {
    const evicted = recency.shift();
    if (evicted !== undefined) delete trees[evicted];
  }
  return { trees, recency };
}
