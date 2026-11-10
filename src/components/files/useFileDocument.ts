import type { FileTarget } from "@/lib/files/fileTarget";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createFileDocument } from "@/lib/files/fileDocument";
import { fileDocumentIO } from "@/lib/files/fileDocumentIO";
import { subscribeFileDeletion } from "@/lib/files/fileDeletionEvents";
import { subscribeFileReopen } from "@/lib/files/fileReopenEvents";
import { t } from "@/lib/i18n";

/** React owns the pane's observation lifetime and preferences, never a second draft. */
export function useFileDocument(
  { path, source, hostId, sessionId }: FileTarget,
  autoSaveEnabled: boolean,
  autoSaveDelayMs: number,
) {
  const document = useMemo(() => createFileDocument({ path, source, hostId, sessionId }, fileDocumentIO), [path, source, hostId, sessionId]);
  const state = useSyncExternalStore(document.subscribe, document.getSnapshot);
  useEffect(() => {
    document.attach();
    const unsubscribe = subscribeFileDeletion((notice) => document.deleted(notice, t("panels.fileViewer.deletedOnRemote")));
    const unsubscribeReopen = subscribeFileReopen({ path, source, hostId, sessionId }, () => document.reopened());
    return () => {
      unsubscribeReopen();
      // Deletion can still invalidate a queued close-flush while a native write drains.
      void document.detach().then(unsubscribe, unsubscribe);
    };
  }, [document]);
  useEffect(() => document.configureAutoSave(autoSaveEnabled, autoSaveDelayMs), [document, autoSaveEnabled, autoSaveDelayMs]);
  return { ...state, document };
}
