/** 삭제된 원격 항목 아래에 저장된 편집 초안 키만 고른다.
 * 경로 구분자를 포함해 비교하므로 `/repo/a`가 `/repo/ab`를 삼키지 않는다. */
export function deletedRemoteDraftKeys(input: {
  keys: readonly string[];
  hostId: string;
  path: string;
  isDirectory: boolean;
}): string[] {
  const keyPrefix = `ssh:${input.hostId}:`;
  const childPrefix = `${input.path}/`;
  return input.keys.filter((key) => {
    if (!key.startsWith(keyPrefix)) return false;
    const draftPath = key.slice(keyPrefix.length);
    return (
      draftPath === input.path ||
      (input.isDirectory && draftPath.startsWith(childPrefix))
    );
  });
}
