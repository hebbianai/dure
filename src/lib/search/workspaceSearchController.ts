import type { ExecResult } from "@/lib/ipc/hmuxContracts";
import { createValueStore } from "@/lib/state/broadcast";
import type { WorkspaceCommandTarget } from "@/lib/workspace/workspaceCommand";
import {
  buildWorkspaceReplaceCommand,
  buildWorkspaceSearchCommand,
  parseWorkspaceSearchOutput,
} from "@/lib/search/workspaceSearch";

export interface WorkspaceSearchTarget extends WorkspaceCommandTarget {
  cwd: string;
}
export interface WorkspaceSearchInput {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  includeGlob: string;
  excludeGlob: string;
}
export interface WorkspaceSearchSnapshot {
  target: WorkspaceSearchTarget;
  input: WorkspaceSearchInput;
  result: ReturnType<typeof parseWorkspaceSearchOutput>;
}
interface SearchState {
  phase: "idle" | "searching" | "replacing";
  snapshot: WorkspaceSearchSnapshot | null;
  error: string | null;
  replacedFiles: number | null;
}
export interface WorkspaceReplacement {
  snapshot: WorkspaceSearchSnapshot;
  replacement: string;
  preserveCase: boolean;
}
const EMPTY: SearchState = { phase: "idle", snapshot: null, error: null, replacedFiles: null };

/** One mounted target owns its replaceable search observation and mutation admission.
 * Invalidating an observation does not cancel an already submitted native command. */
export function createWorkspaceSearchController(
  target: WorkspaceSearchTarget | null,
  execute: (target: WorkspaceSearchTarget, command: string) => Promise<ExecResult>,
) {
  const state = createValueStore<SearchState>(EMPTY);
  const context = target ? { ...target } : null;
  let revision = 0;
  let replacing = false;

  function fail(ticket: number, error: unknown) {
    if (ticket === revision) {
      state.set({ ...state.get(), phase: "idle", error: String(error) });
    }
  }

  async function read(ticket: number, input: WorkspaceSearchInput, replacedFiles: number | null = null) {
    if (!context) return;
    try {
      const result = await execute(context, buildWorkspaceSearchCommand({ ...input, cwd: context.cwd }));
      if (ticket !== revision) return;
      // grep's no-match exit is expected unless stderr reports a failure.
      if (result.code !== 0 && result.stderr.trim()) {
        state.set({ ...EMPTY, error: result.stderr.trim() });
        return;
      }
      state.set({
        phase: "idle",
        snapshot: { target: context, input, result: parseWorkspaceSearchOutput(result.stdout) },
        error: null,
        replacedFiles,
      });
    } catch (error) {
      if (ticket === revision) state.set({ ...EMPTY, error: String(error) });
    }
  }

  return {
    getSnapshot: state.get,
    subscribe: state.subscribe,
    clear() {
      revision++;
      state.set(EMPTY);
    },
    async search(draft: WorkspaceSearchInput) {
      const input = { ...draft, query: draft.query.trim() };
      if (!context || !input.query || replacing) return;
      const ticket = ++revision;
      state.set({ ...state.get(), phase: "searching", error: null, replacedFiles: null });
      await read(ticket, input);
    },
    async replace(request: WorkspaceReplacement) {
      const current = state.get();
      if (!context || replacing || current.phase !== "idle" ||
        current.snapshot !== request.snapshot || !request.snapshot.result.groups.length) return;
      replacing = true;
      const ticket = ++revision;
      const { input, result } = request.snapshot;
      state.set({ ...current, phase: "replacing", error: null, replacedFiles: null });
      try {
        const response = await execute(context, buildWorkspaceReplaceCommand({
          ...input,
          cwd: context.cwd,
          replacement: request.replacement,
          preserveCase: request.preserveCase,
          files: result.groups.map((group) => group.file),
        }));
        if (ticket !== revision) return;
        if (response.code !== 0) {
          fail(ticket, response.stderr.trim() || response.stdout.trim() || `exit ${response.code}`);
          return;
        }
        await read(ticket, input, result.groups.length);
      } catch (error) {
        fail(ticket, error);
      } finally {
        replacing = false;
      }
    },
    reportError(snapshot: WorkspaceSearchSnapshot, error: unknown) {
      const current = state.get();
      if (current.phase === "idle" && current.snapshot === snapshot) fail(revision, error);
    },
  };
}
