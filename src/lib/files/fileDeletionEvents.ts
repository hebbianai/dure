import { createBroadcast } from "@/lib/state/broadcast";

export interface FileDeletionNotice {
  source: "local" | "ssh";
  hostId?: string;
  path: string;
  isDirectory: boolean;
}

type Listener = (notice: FileDeletionNotice) => void;
const deletions = createBroadcast<FileDeletionNotice>();

export function fileMatchesDeletion(
  file: { source: "local" | "ssh"; hostId?: string; path: string },
  deletion: FileDeletionNotice,
): boolean {
  if (file.source !== deletion.source || file.hostId !== deletion.hostId) return false;
  return (
    file.path === deletion.path ||
    (deletion.isDirectory && file.path.startsWith(`${deletion.path}/`))
  );
}

export function publishFileDeletion(notice: FileDeletionNotice): void {
  deletions.publish(notice);
}

export function subscribeFileDeletion(listener: Listener): () => void {
  return deletions.subscribe(listener);
}
