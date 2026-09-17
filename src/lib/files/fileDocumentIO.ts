import type { FileTarget } from "@/lib/files/fileTarget";
import { readFile, sshReadFile, writeFile, sshWriteFile, findFileCandidates, sshFindFileCandidates, hostToOpts } from "@/lib/ipc";
import type { FileDocumentIO } from "@/lib/files/fileDocument";
import { useStore } from "@/store";
import { t } from "@/lib/i18n";
import { showErrorToast, showToast } from "@/lib/toast";

function connection(target: FileTarget) {
  const host = useStore.getState().sshHosts.find((host) => host.id === target.hostId);
  return { id: target.sessionId, connectOpts: host ? hostToOpts(host) : undefined };
}

/** Native routing and retained drafts are the document model's only external ports. */
export const fileDocumentIO: FileDocumentIO = {
  read: (target) => target.source === "local" ? readFile(target.path) : sshReadFile({ ...connection(target), path: target.path }),
  findCandidates: (target) => target.source === "local" ? findFileCandidates(target.path) : sshFindFileCandidates({ ...connection(target), path: target.path }),
  write: (target, content) => target.source === "local" ? writeFile(target.path, content) : sshWriteFile({ ...connection(target), path: target.path, content }),
  readDraft: (key) => useStore.getState().fileDrafts[key],
  writeDraft: (key, content) => useStore.getState().setFileDraft(key, content),
  notify(event, error) {
    if (event === "restored") showToast(t("panels.fileViewer.restoredUnsavedEdits"), 4000);
    if (event === "saved") showToast(t("common.saved"), 1500);
    if (event === "saveFailed") showErrorToast(t("common.saveFailed", { error: String(error) }));
  },
};
