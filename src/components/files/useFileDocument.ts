import type { FileTarget } from "@/lib/files/fileTarget";
import { useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { FileDocumentIOContext } from "@/components/files/fileDocumentIOContext";
import { createFileDocument } from "@/lib/files/fileDocument";
import { subscribeFileDeletion } from "@/lib/files/fileDeletionEvents";
import { subscribeFileReopen } from "@/lib/files/fileReopenEvents";
import { t } from "@/lib/i18n";

/** React owns the pane's observation lifetime and preferences, never a second draft. */
export function useFileDocument(
  { path, source, hostId, sessionId }: FileTarget,
  autoSaveEnabled: boolean,
  autoSaveDelayMs: number,
) {
  const io = useContext(FileDocumentIOContext);
  const document = useMemo(() => createFileDocument({ path, source, hostId, sessionId }, io), [path, source, hostId, sessionId, io]);
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
