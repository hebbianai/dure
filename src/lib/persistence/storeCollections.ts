// store가 쓰는 순수 컬렉션 헬퍼 — store.ts에서 추출(god-file 다이어트).
// zustand·Tauri를 모르는 순수 함수라 vitest에서 그대로 검증한다.

/** 워크트리를 오가면 루트가 계속 늘어나므로 최근 것만 남긴다.
 *  방금 쓴 루트를 지웠다 다시 넣어 객체 키 순서 = 최근 사용 순으로 유지한다. */
const FILE_TREE_ROOT_LIMIT = 40;

export function capFileTreeRoots<T>(
  record: Record<string, T>,
  rootKey: string,
  value: T,
): Record<string, T> {
  const { [rootKey]: _previous, ...rest } = record;
  const entries = Object.entries({ ...rest, [rootKey]: value });
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - FILE_TREE_ROOT_LIMIT)),
	);
}

/** 드래그한 항목(dragId)을 대상(targetId) 바로 앞으로 이동한 새 배열 반환 */
export function reorder<T extends { id: string }>(arr: T[], dragId: string, targetId: string,
): T[] {
  if (dragId === targetId) return arr;
  const next = [...arr];
  const from = next.findIndex((x) => x.id === dragId);
  if (from < 0) return arr;
  const [moved] = next.splice(from, 1);
  const to = next.findIndex((x) => x.id === targetId);
  if (to < 0) return arr;
  next.splice(to, 0, moved);
  return next;
}

export function omitRecordKeys<T>(record: Record<string, T>, keys: ReadonlySet<string>,
): Record<string, T> {
  if (keys.size === 0) return record;
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key)),
	);
}
