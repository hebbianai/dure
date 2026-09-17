export type DiffReviewCapability =
  | { readonly status: "available"; readonly worktreePath: string }
  | { readonly status: "unavailable" };

export interface GitProbeResult {
  readonly code: number;
  readonly stdout: string;
}

export interface DiffReviewSpaceCandidate {
  readonly kind: string;
  readonly cwd?: string;
  readonly hostId?: string;
}

/** SSH cwd와 같은 문자열의 로컬 경로를 실수로 review 대상으로 삼지 않는다. */
export function localStandaloneDiffCwd(
  candidate: DiffReviewSpaceCandidate,
): string | undefined {
  if (candidate.kind !== "term" || candidate.hostId) return undefined;
  if (!candidate.cwd?.trim()) return undefined;
  return candidate.cwd;
}

export function diffReviewCapabilityFromGitProbe(
  result: GitProbeResult,
): DiffReviewCapability {
  if (result.code !== 0) return { status: "unavailable" };
  // Git의 줄 끝만 제거한다. 합법적인 경로 끝 공백까지 trim하면 다른 worktree
  // identity로 바뀔 수 있다.
  const worktreePath = result.stdout.replace(/[\r\n]+$/u, "");
  return worktreePath
    ? { status: "available", worktreePath }
    : { status: "unavailable" };
}

type Probe = (cwd: string) => Promise<DiffReviewCapability>;

interface CacheEntry {
  readonly inFlight?: Promise<DiffReviewCapability>;
  readonly value?: DiffReviewCapability;
  readonly expiresAt: number;
}

export interface DiffReviewCapabilityCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * cwd별 Git capability probe를 dedupe하는 작은 TTL/LRU cache.
 *
 * 결과는 오직 같은 cwd key에만 귀속된다. 늦게 끝난 이전 cwd probe가 새 cwd를
 * available로 만드는 경로가 없고, eviction된 in-flight 결과도 cache에 되살아나지
 * 않는다.
 */
export class DiffReviewCapabilityCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: DiffReviewCapabilityCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 128);
    this.ttlMs = Math.max(0, options.ttlMs ?? 30_000);
    this.now = options.now ?? Date.now;
  }

  read(cwd: string): DiffReviewCapability | undefined {
    const entry = this.entries.get(cwd);
    if (!entry?.value) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(cwd);
      return undefined;
    }
    this.touch(cwd, entry);
    return entry.value;
  }

  probe(cwd: string, run: Probe): Promise<DiffReviewCapability> {
    if (!cwd.trim()) return Promise.resolve({ status: "unavailable" });

    const entry = this.entries.get(cwd);
    if (entry?.inFlight) {
      this.touch(cwd, entry);
      return entry.inFlight;
    }
    const cached = this.read(cwd);
    if (cached) return Promise.resolve(cached);

    const request = run(cwd).catch(() => ({ status: "unavailable" }) as const);
    this.touch(cwd, { inFlight: request, expiresAt: 0 });
    void request.then((value) => {
      const current = this.entries.get(cwd);
      if (current?.inFlight !== request) return;
      this.touch(cwd, {
        value,
        expiresAt: this.now() + this.ttlMs,
      });
    });
    return request;
  }

  private touch(cwd: string, entry: CacheEntry) {
    this.entries.delete(cwd);
    this.entries.set(cwd, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
