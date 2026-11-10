import { createBroadcast } from "@/lib/state/broadcast";
import { fileDraftKey, type FileTarget } from "@/lib/files/fileTarget";

// Opening a file that already has a pane reuses that pane. Its document hears
// about the repeated open so it can show what is on disk now.
const reopens = createBroadcast<string>();

export function publishFileReopen(target: FileTarget): void {
  reopens.publish(fileDraftKey(target));
}

export function subscribeFileReopen(target: FileTarget, listener: () => void): () => void {
  const key = fileDraftKey(target);
  return reopens.subscribe((reopened) => {
    if (reopened === key) listener();
  });
}
