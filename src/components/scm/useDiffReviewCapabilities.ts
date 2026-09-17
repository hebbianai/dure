import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DiffReviewCapabilityCache,
  diffReviewCapabilityFromGitProbe,
  type DiffReviewCapability,
} from "@/lib/scm/review/diffReviewCapability";
import { probeGitWorktreeRoot } from "@/lib/ipc";

const capabilityCache = new DiffReviewCapabilityCache();

async function probeLocalWorktree(cwd: string): Promise<DiffReviewCapability> {
  const result = await probeGitWorktreeRoot(cwd);
  return diffReviewCapabilityFromGitProbe(result);
}

function sameCapability(
  left: DiffReviewCapability | undefined,
  right: DiffReviewCapability,
): boolean {
  return (
    left?.status === right.status &&
    (left.status !== "available" ||
      (right.status === "available" && left.worktreePath === right.worktreePath))
  );
}

/** local standalone cwd들만 probe하고 exact-cwd 결과를 메뉴 wiring에 제공한다. */
export function useDiffReviewCapabilities(cwds: readonly string[]) {
  const signature = JSON.stringify([...new Set(cwds.filter((cwd) => cwd.trim()))]);
  const paths = useMemo(() => JSON.parse(signature) as string[], [signature]);
  const wantedRef = useRef<ReadonlySet<string>>(new Set(paths));
  const [capabilities, setCapabilities] = useState<
    ReadonlyMap<string, DiffReviewCapability>
  >(() => new Map());

  const publish = useCallback((cwd: string, capability: DiffReviewCapability) => {
    if (!wantedRef.current.has(cwd)) return;
    setCapabilities((current) => {
      if (sameCapability(current.get(cwd), capability)) return current;
      const next = new Map(current);
      next.set(cwd, capability);
      return next;
    });
  }, []);

  const probe = useCallback(
    async (cwd: string) => {
      if (!wantedRef.current.has(cwd)) return;
      const cached = capabilityCache.read(cwd);
      if (cached) {
        publish(cwd, cached);
      } else {
        // TTL이 끝난 결과는 새 probe가 끝날 때까지 fail-closed 한다.
        setCapabilities((current) => {
          if (!current.has(cwd)) return current;
          const next = new Map(current);
          next.delete(cwd);
          return next;
        });
      }
      publish(cwd, await capabilityCache.probe(cwd, probeLocalWorktree));
    },
    [publish],
  );

  useLayoutEffect(() => {
    wantedRef.current = new Set(paths);
    setCapabilities((current) => {
      const next = new Map<string, DiffReviewCapability>();
      for (const cwd of paths) {
        const capability = capabilityCache.read(cwd);
        if (capability) next.set(cwd, capability);
      }
      if (
        current.size === next.size &&
        [...next].every(([cwd, value]) => sameCapability(current.get(cwd), value))
      ) {
        return current;
      }
      return next;
    });
  }, [paths]);

  useEffect(() => {
    let cancelled = false;
    for (const cwd of paths) {
      void capabilityCache.probe(cwd, probeLocalWorktree).then((capability) => {
        if (!cancelled) publish(cwd, capability);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [paths, publish]);

  return { capabilities, probe };
}
