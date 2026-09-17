import { fileDraftKey, type FileTarget } from "@/lib/files/fileTarget";
import type { FileContent } from "@/lib/ipc/files";
import { createValueStore } from "@/lib/state/broadcast";
import { createAutoSaveScheduler, type AutoSaveScheduler } from "@/lib/settings/autoSave";
import { fileMatchesDeletion, type FileDeletionNotice } from "@/lib/files/fileDeletionEvents";
import { registerWindowWorkCheckpoint } from "@/lib/persistence/windowWorkCheckpoint";

export interface FileDocumentIO {
  read(target: FileTarget): Promise<FileContent>;
  findCandidates(target: FileTarget): Promise<string[]>;
  write(target: FileTarget, content: string): Promise<number>;
  readDraft(key: string): string | undefined;
  writeDraft(key: string, content: string | null): void;
  notify(event: "restored" | "saved" | "saveFailed", error?: unknown): void;
}
interface DocumentState {
  path: string;
  file: FileContent | null;
  draft: string | null;
  restoredDraft: boolean;
  candidates: string[];
  loading: boolean;
  saving: boolean;
  error: string | null;
}

export function isTextFile(file: FileContent): boolean {
  return file.kind === "text" || file.kind === "markdown";
}
export function canEditFile(file: FileContent | null): file is FileContent {
  return file !== null && isTextFile(file) && !file.truncated;
}
export function documentIsDirty(state: Pick<DocumentState, "file" | "draft">): boolean {
  return state.file !== null && state.draft !== null && state.draft !== state.file.content;
}

/** One pane's document. Native operations keep their captured target after detach;
 * only this owner may advance its baseline, retain its draft or schedule its writer. */
export function createFileDocument(target: FileTarget, io: FileDocumentIO) {
  const identity = { ...target };
  const state = createValueStore<DocumentState>({
    path: identity.path, file: null, draft: null, restoredDraft: false,
    candidates: [], loading: true, saving: false, error: null,
  });
  const update = (patch: Partial<DocumentState>) => state.set({ ...state.get(), ...patch });
  const at = (path: string): FileTarget => ({ ...identity, path });
  let readRevision = 0;
  const triedPaths = new Set<string>();
  let pendingSave: Promise<void> | null = null;
  let failedContent: string | null = null;
  let detached = false;
  let autoSaveEnabled = false;
  let delayMs = 0;
  let scheduler: AutoSaveScheduler | null = null;
  let stopCheckpoint: (() => void) | undefined;
  let checkpointHolds = 0;

  function retainDraft() {
    const current = state.get();
    if (canEditFile(current.file)) io.writeDraft(fileDraftKey(at(current.path)), documentIsDirty(current) ? current.draft : null);
  }
  function scheduleSave() {
    const current = state.get();
    if (!checkpointHolds && !detached && !current.loading && !current.saving && documentIsDirty(current) && current.draft !== failedContent) scheduler?.schedule();
    else scheduler?.cancel();
  }

  function save(): Promise<void> {
    if (pendingSave) return pendingSave;
    if (checkpointHolds) return Promise.resolve();
    const current = state.get();
    if (current.saving || !canEditFile(current.file) || current.loading || !documentIsDirty(current)) return Promise.resolve();
    const { file, path } = current;
    const content = current.draft!;
    scheduler?.cancel();
    update({ saving: true });
    pendingSave = Promise.resolve().then(async () => {
      try {
        await io.write(at(path), content);
        if (state.get().file !== file || state.get().path !== path) return;
        failedContent = null;
        update({
          file: { ...file, content, size: new TextEncoder().encode(content).length },
          draft: state.get().draft === content ? null : state.get().draft,
        });
        retainDraft();
        if (!detached) io.notify("saved");
      } catch (error) {
        if (state.get().file !== file || state.get().path !== path) return;
        failedContent = content;
        if (!detached) io.notify("saveFailed", error);
      } finally {
        pendingSave = null;
        update({ saving: false });
        if (detached) retainDraft();
        else scheduleSave();
      }
    });
    return pendingSave;
  }

  async function load(path = state.get().path, discardDraft = false) {
    const ticket = ++readRevision;
    scheduler?.cancel();
    failedContent = null;
    if (path !== state.get().path) {
      retainDraft();
      update({ path, file: null, draft: null });
    }
    update({ loading: true, error: null, candidates: [], restoredDraft: false });
    // Refresh observes the completed write, never a pre-write disk snapshot.
    await pendingSave;
    while (ticket === readRevision) {
      const reading = at(path);
      try {
        const file = await io.read(reading);
        if (ticket !== readRevision) return;
        const cached = discardDraft ? undefined : io.readDraft(fileDraftKey(reading));
        const draft = cached !== undefined && cached !== file.content && canEditFile(file) ? cached : null;
        update({ path, file, draft, loading: false, restoredDraft: draft !== null });
        if (discardDraft) io.writeDraft(fileDraftKey(reading), null);
        if (draft !== null) io.notify("restored");
        scheduleSave();
        return;
      } catch (error) {
        if (ticket !== readRevision) return;
        if (!triedPaths.has(path)) {
          triedPaths.add(path);
          const candidates = await io.findCandidates(reading).catch(() => []);
          if (ticket !== readRevision) return;
          if (candidates.length === 1 && !triedPaths.has(candidates[0])) {
            path = candidates[0];
            update({ path, file: null, draft: null });
            continue;
          }
          if (candidates.length > 1) {
            update({ candidates, loading: false });
            return;
          }
        }
        update({ error: String(error), loading: false });
        return;
      }
    }
  }

  return {
    getSnapshot: state.get,
    subscribe: state.subscribe,
    load,
    save,
    change(draft: string) {
      if (!canEditFile(state.get().file) || state.get().loading) return;
      update({ draft });
      scheduleSave();
    },
    revert() {
      failedContent = null;
      update({ draft: null });
      io.writeDraft(fileDraftKey(at(state.get().path)), null);
      scheduler?.cancel();
    },
    configureAutoSave(enabled: boolean, delay: number) {
      if (enabled === autoSaveEnabled && delay === delayMs && (!enabled || scheduler)) return;
      scheduler?.dispose();
      autoSaveEnabled = enabled;
      delayMs = delay;
      failedContent = null;
      scheduler = enabled ? createAutoSaveScheduler({ delayMs: delay, onSave: () => { void save(); } }) : null;
      scheduleSave();
    },
    deleted(deletion: FileDeletionNotice, error: string) {
      if (!fileMatchesDeletion(at(state.get().path), deletion)) return;
      readRevision++;
      scheduler?.cancel();
      io.writeDraft(fileDraftKey(at(state.get().path)), null);
      update({ file: null, draft: null, candidates: [], loading: false, error });
    },
    attach() {
      detached = false;
      stopCheckpoint ??= registerWindowWorkCheckpoint(async () => {
        checkpointHolds++;
        scheduler?.cancel();
        let released = false;
        const resume = () => {
          if (released) return;
          released = true;
          checkpointHolds--;
          scheduleSave();
        };
        try {
          await pendingSave;
          const current = state.get();
          const drafts: [string, string][] = [];
          if (canEditFile(current.file) && documentIsDirty(current)) {
            const digest = async (value: string) => {
              const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
              return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
            };
            // Only content-free fingerprints leave this document owner.
            drafts.push(await Promise.all([digest(fileDraftKey(at(current.path))), digest(current.draft!)]));
            if (state.get().draft !== current.draft || state.get().path !== current.path) throw new Error("app_restart_documents_changed");
          }
          retainDraft();
          return Object.assign(resume, { drafts });
        } catch (error) {
          resume();
          throw error;
        }
      });
      void load();
    },
    async detach() {
      detached = true;
      stopCheckpoint?.();
      stopCheckpoint = undefined;
      readRevision++;
      retainDraft();
      scheduler?.dispose();
      scheduler = null;
      if (autoSaveEnabled && (pendingSave || state.get().draft !== failedContent)) {
        await save();
        // No more edits arrive after close; at most one final newer draft remains.
        if (detached && documentIsDirty(state.get()) && state.get().draft !== failedContent) await save();
      }
    },
  };
}
