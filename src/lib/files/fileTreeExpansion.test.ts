import { describe, expect, it } from "vitest";
import {
  MAX_PATHS_PER_TREE,
  MAX_TREES,
  fileTreeKey,
  isExpanded,
  normalizeExpansionState,
  toggleExpanded,
  touchTree,
  type FileTreeExpansionState,
} from "@/lib/files/fileTreeExpansion";

const empty: FileTreeExpansionState = { trees: {}, recency: [] };

describe("fileTreeKey", () => {
  it("keys the same repo directory identically regardless of trailing slash", () => {
    expect(fileTreeKey("local", undefined, "/repo/a/")).toBe(
      fileTreeKey("local", undefined, "/repo/a"),
    );
  });

  it("separates local and ssh trees, and ssh trees by hostId", () => {
    const local = fileTreeKey("local", undefined, "/repo");
    const sshA = fileTreeKey("ssh", "host-a", "/repo");
    const sshB = fileTreeKey("ssh", "host-b", "/repo");
    expect(new Set([local, sshA, sshB]).size).toBe(3);
  });

  it("ignores a stray hostId for local trees", () => {
    expect(fileTreeKey("local", "host-a", "/repo")).toBe(
      fileTreeKey("local", undefined, "/repo"),
    );
  });

  it("keeps the filesystem root distinct from empty", () => {
    expect(fileTreeKey("local", undefined, "/")).toContain('"/"');
  });
});

describe("toggleExpanded / isExpanded", () => {
  const key = fileTreeKey("local", undefined, "/repo");

  it("expands and collapses a directory", () => {
    let state = toggleExpanded(empty, key, "/repo/src");
    expect(isExpanded(state, key, "/repo/src")).toBe(true);
    state = toggleExpanded(state, key, "/repo/src");
    expect(isExpanded(state, key, "/repo/src")).toBe(false);
  });

  it("keeps descendant flags when collapsing a parent", () => {
    let state = toggleExpanded(empty, key, "/repo/src");
    state = toggleExpanded(state, key, "/repo/src/lib");
    state = toggleExpanded(state, key, "/repo/src");
    expect(isExpanded(state, key, "/repo/src")).toBe(false);
    expect(isExpanded(state, key, "/repo/src/lib")).toBe(true);
  });

  it("drops a tree entirely once its last path collapses", () => {
    let state = toggleExpanded(empty, key, "/repo/src");
    state = toggleExpanded(state, key, "/repo/src");
    expect(state.trees[key]).toBeUndefined();
    expect(state.recency).not.toContain(key);
  });

  it("caps paths per tree by dropping the oldest expansion", () => {
    let state = empty;
    for (let i = 0; i <= MAX_PATHS_PER_TREE; i++) {
      state = toggleExpanded(state, key, `/repo/d${i}`);
    }
    expect(state.trees[key]).toHaveLength(MAX_PATHS_PER_TREE);
    expect(isExpanded(state, key, "/repo/d0")).toBe(false);
    expect(isExpanded(state, key, `/repo/d${MAX_PATHS_PER_TREE}`)).toBe(true);
  });

  it("evicts the least recently used tree beyond the cap", () => {
    let state = empty;
    for (let i = 0; i <= MAX_TREES; i++) {
      state = toggleExpanded(state, fileTreeKey("local", undefined, `/r${i}`), `/r${i}/x`);
    }
    expect(state.recency).toHaveLength(MAX_TREES);
    expect(state.trees[fileTreeKey("local", undefined, "/r0")]).toBeUndefined();
    expect(state.trees[fileTreeKey("local", undefined, `/r${MAX_TREES}`)]).toBeDefined();
  });

  it("keeps a revisited tree alive under LRU pressure", () => {
    const first = fileTreeKey("local", undefined, "/r0");
    let state = toggleExpanded(empty, first, "/r0/x");
    for (let i = 1; i < MAX_TREES; i++) {
      state = toggleExpanded(state, fileTreeKey("local", undefined, `/r${i}`), `/r${i}/x`);
    }
    state = touchTree(state, first);
    state = toggleExpanded(state, fileTreeKey("local", undefined, "/rN"), "/rN/x");
    expect(state.trees[first]).toBeDefined();
  });
});

describe("touchTree", () => {
  const key = fileTreeKey("local", undefined, "/repo");

  it("returns the same reference when nothing changes", () => {
    expect(touchTree(empty, key)).toBe(empty);
    const state = toggleExpanded(empty, key, "/repo/src");
    expect(touchTree(state, key)).toBe(state);
  });

  it("moves a stale tree to most-recent", () => {
    const other = fileTreeKey("local", undefined, "/other");
    let state = toggleExpanded(empty, key, "/repo/src");
    state = toggleExpanded(state, other, "/other/x");
    const touched = touchTree(state, key);
    expect(touched.recency[touched.recency.length - 1]).toBe(key);
  });
});

describe("normalizeExpansionState", () => {
  it("defaults malformed data to empty", () => {
    expect(normalizeExpansionState(undefined)).toEqual(empty);
    expect(normalizeExpansionState(null)).toEqual(empty);
    expect(normalizeExpansionState("junk")).toEqual(empty);
    expect(normalizeExpansionState({ trees: 3 })).toEqual(empty);
  });

  it("drops non-string paths, duplicates, and empty trees", () => {
    const state = normalizeExpansionState({
      trees: { a: ["/x", 1, "/x", "/y"], b: [], c: "junk" },
      recency: ["a"],
    });
    expect(state.trees).toEqual({ a: ["/x", "/y"] });
    expect(state.recency).toEqual(["a"]);
  });

  it("rebuilds recency for trees missing from it and prunes unknown keys", () => {
    const state = normalizeExpansionState({
      trees: { a: ["/x"], b: ["/y"] },
      recency: ["ghost", "b"],
    });
    expect(state.recency).toEqual(["b", "a"]);
  });

  it("enforces caps during hydration", () => {
    const trees: Record<string, string[]> = {};
    for (let i = 0; i <= MAX_TREES; i++) {
      trees[`k${i}`] = Array.from({ length: MAX_PATHS_PER_TREE + 5 }, (_, j) => `/p${j}`);
    }
    const state = normalizeExpansionState({ trees, recency: Object.keys(trees) });
    expect(state.recency).toHaveLength(MAX_TREES);
    expect(Object.keys(state.trees)).toHaveLength(MAX_TREES);
    for (const paths of Object.values(state.trees)) {
      expect(paths).toHaveLength(MAX_PATHS_PER_TREE);
    }
  });
});
