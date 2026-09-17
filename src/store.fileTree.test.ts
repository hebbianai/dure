import { beforeEach, describe, expect, it } from "vitest";
import { fileTreeKey } from "@/lib/files/fileTreeExpansion";
import { useStore } from "@/store";

// 펼침 상태는 useFileTreeExpansion 스토어가 소유한다 — src/lib/fileTreeExpansion.test.ts 참고.
// 여기서는 메인 스토어가 들고 있는 "마지막에 연 파일"만 다룬다.

const repo = fileTreeKey("local", undefined, "/repo");
const remote = fileTreeKey("ssh", "host-1", "/srv/app");

beforeEach(() => {
  useStore.setState({ fileTreeSelected: {} });
});

describe("파일 트리 선택 파일", () => {
  it("트리마다 마지막에 연 파일을 따로 기억한다", () => {
    const { setFileTreeSelected } = useStore.getState();
    setFileTreeSelected(repo, "/repo/src/App.tsx");
    setFileTreeSelected(remote, "/srv/app/main.py");
    setFileTreeSelected(repo, "/repo/README.md");

    const state = useStore.getState().fileTreeSelected;
    expect(state[repo]).toBe("/repo/README.md");
    expect(state[remote]).toBe("/srv/app/main.py");
  });

  it("트리가 계속 늘어나면 오래된 것부터 버리고 최근 것은 남긴다", () => {
    const { setFileTreeSelected } = useStore.getState();
    for (let i = 0; i < 45; i++) {
      setFileTreeSelected(fileTreeKey("local", undefined, `/repo-${i}`), `/repo-${i}/main.ts`);
    }
    const state = useStore.getState().fileTreeSelected;

    expect(Object.keys(state)).toHaveLength(40);
    expect(state[fileTreeKey("local", undefined, "/repo-0")]).toBeUndefined();
    expect(state[fileTreeKey("local", undefined, "/repo-44")]).toBe("/repo-44/main.ts");
  });

  it("다시 만진 트리는 최근으로 올라가 상한에 밀려나지 않는다", () => {
    const { setFileTreeSelected } = useStore.getState();
    setFileTreeSelected(repo, "/repo/src/App.tsx");
    for (let i = 0; i < 39; i++) {
      setFileTreeSelected(fileTreeKey("local", undefined, `/other-${i}`), `/other-${i}/main.ts`);
    }
    // 상한 직전에 다시 사용 → 가장 오래된 축에서 최근으로 이동한다.
    setFileTreeSelected(repo, "/repo/README.md");
    setFileTreeSelected(fileTreeKey("local", undefined, "/fresh"), "/fresh/main.ts");

    const state = useStore.getState().fileTreeSelected;
    expect(state[repo]).toBe("/repo/README.md");
    expect(state[fileTreeKey("local", undefined, "/other-0")]).toBeUndefined();
  });
});
