import type { Project } from "@/types";
import type { FocusContext } from "@/lib/workspace/focusContext";
import { shellQuote } from "@/lib/platform/shell";

/** Preserve relative nested creation, including parent directories for files. */
export function createEntryCommand(cwd: string, name: string, kind: "file" | "dir") {
  return kind === "dir"
    ? `cd ${shellQuote(cwd)} && mkdir -p ${shellQuote(name)}`
    : `cd ${shellQuote(cwd)} && mkdir -p "$(dirname ${shellQuote(name)})" && touch ${shellQuote(name)}`;
}

/** The nearest project must match both the path and its execution host. */
export function filesPaneTitle(focus: FocusContext | null, projects: readonly Project[]): string | null {
  if (!focus) return null;
  const norm = (path: string) => path.replace(/\/+$/, "");
  const cwd = norm(focus.cwd);
  const project = projects
    .filter((project) => focus.source === "ssh"
      ? project.kind === "ssh" && project.sshHostId === focus.hostId
      : project.kind === "local")
    .filter((project) => cwd === norm(project.path) || cwd.startsWith(`${norm(project.path)}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (project) return project.name;
  const base = cwd.replace(/\/\.(?:claude-)?worktrees\/[^/]+$/, "");
  return base.split("/").filter(Boolean).pop() || cwd;
}
