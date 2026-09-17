import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createReferenceAwareLocalStorage } from "@/lib/persistence/persistStorage";
import {
  normalizeExpansionState,
  toggleExpanded,
  touchTree,
  type FileTreeExpansionState,
} from "@/lib/files/fileTreeExpansion";

interface FileTreeExpansionStore extends FileTreeExpansionState {
  toggle: (key: string, path: string) => void;
  touch: (key: string) => void;
}

/** 메인 "agent-ide" 스토어와 분리된 전용 storage key — 토글마다 앱 전체
 *  durable 스냅샷을 직렬화하지 않도록 파일 트리 UI 상태만 따로 저장한다. */
export const useFileTreeExpansion = create<FileTreeExpansionStore>()(
  persist(
    (set) => ({
      trees: {},
      recency: [],
      toggle: (key, path) => set((s) => toggleExpanded(s, key, path)),
      touch: (key) =>
        set((s) => {
          const next = touchTree(s, key);
          return next === s ? {} : next;
        }),
    }),
    {
      name: "agent-ide-file-tree",
      version: 1,
      storage: createReferenceAwareLocalStorage(),
      partialize: (s) => ({ trees: s.trees, recency: s.recency }),
      merge: (persisted, current) => ({
        ...current,
        ...normalizeExpansionState(persisted),
      }),
    },
  ),
);
