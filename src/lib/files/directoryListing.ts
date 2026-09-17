import { listDir, listRemoteDir, type DirEntry } from "@/lib/ipc";
import { useStore } from "@/store";

export interface DirectoryTarget {
  path: string;
  source: "local" | "ssh";
  hostId?: string;
  showGitIgnored: boolean;
}

function createLimiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

// Restored expanded nodes share the existing four-command SSH limit.
const limitSshLoad = createLimiter(4);

export async function loadDirectory(target: DirectoryTarget): Promise<DirEntry[]> {
  if (target.source === "ssh") {
    const host = useStore.getState().sshHosts.find((host) => host.id === target.hostId);
    if (!host) return [];
    // Remote ls has no ignore information; retain all entries.
    return limitSshLoad(() => listRemoteDir(host, target.path, true));
  }
  const hide = !target.showGitIgnored;
  const entries = await listDir(target.path, true, hide);
  return hide ? entries.filter((entry) => !entry.ignored) : entries;
}
