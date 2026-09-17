import { t } from "@/lib/i18n";
import { hostToOpts, sshExecOnce } from "@/lib/ipc";
import { runShell } from "@/lib/ipc/process";
import { useStore } from "@/store";

export interface WorkspaceCommandTarget {
  source: "local" | "ssh";
  hostId?: string;
}

/** Resolve the current SSH configuration once, at command submission. */
export async function runWorkspaceCommand(target: WorkspaceCommandTarget, command: string) {
  if (target.source === "local") return runShell(command);
  const host = useStore.getState().sshHosts.find((host) => host.id === target.hostId);
  if (!host) throw new Error(t("common.hostNotFound"));
  return sshExecOnce(hostToOpts(host), command);
}
