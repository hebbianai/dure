import { DEFAULT_UI_PREFS } from "@/lib/settings/uiPrefs";
import { deletedRemoteDraftKeys } from "@/lib/files/remoteFileDelete";
import { useStore } from "@/store";

function currentSpaceId() {
  return useStore.getState().activeSpaceId;
}

/** Store wiring for the file explorer's workspace context. */
export function useFilesPaneState() {
  return {
    focus: useStore((state) => state.focusCtx),
    projects: useStore((state) => state.projects),
    currentSpaceId,
  };
}

/** File-tree selection and preferences subscribe only to the values it renders. */
export function useFileTreeState(rootKey: string) {
  return {
    selected: useStore((state) => state.fileTreeSelected[rootKey]),
    setFileTreeSelected: useStore((state) => state.setFileTreeSelected),
    showGitIgnored: useStore((state) => state.uiPrefs.showGitIgnored ?? DEFAULT_UI_PREFS.showGitIgnored),
  };
}

export function findFileHost(hostId: string | undefined) {
  return useStore.getState().sshHosts.find((host) => host.id === hostId);
}

export function discardDeletedFileDrafts(input: { hostId: string; path: string; isDirectory: boolean }) {
  const state = useStore.getState();
  for (const key of deletedRemoteDraftKeys({ ...input, keys: Object.keys(state.fileDrafts) })) {
    state.setFileDraft(key, null);
  }
}
