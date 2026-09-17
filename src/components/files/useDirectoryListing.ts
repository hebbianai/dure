import { useEffect, useReducer, useState } from "react";
import { loadDirectory, type DirectoryTarget } from "@/lib/files/directoryListing";
import type { DirEntry } from "@/lib/ipc";

interface Listing {
  key: string;
  entries: DirEntry[];
  error: string | null;
}

/** Root and expanded nodes retain one listing and abandon obsolete observations. */
export function useDirectoryListing(
  { path, source, hostId, showGitIgnored }: DirectoryTarget,
  revision: number,
  enabled = true,
) {
  const [retryRevision, reload] = useReducer((value: number) => value + 1, 0);
  const key = JSON.stringify([source, hostId, path, showGitIgnored, revision, retryRevision]);
  const [listing, setListing] = useState<Listing | null>(null);
  const current = listing?.key === key ? listing : null;
  useEffect(() => {
    if (!enabled || current) return;
    let disposed = false;
    void loadDirectory({ path, source, hostId, showGitIgnored }).then(
      (entries) => {
        if (!disposed) setListing({ key, entries, error: null });
      },
      (error) => {
        if (!disposed) setListing({ key, entries: [], error: String(error) });
      },
    );
    return () => { disposed = true; };
  }, [path, source, hostId, showGitIgnored, key, current, enabled]);
  return {
    reload,
    entries: current?.entries ?? null,
    error: current?.error ?? null,
    loading: enabled && current === null,
  };
}
