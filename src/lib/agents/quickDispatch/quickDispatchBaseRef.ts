import type { ExecResult } from "@/lib/ipc/hmuxContracts";

const FETCH_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 3000;

export type BoundedGitExec = (
	args: string[],
	timeoutMs: number,
) => Promise<ExecResult>;

interface RefProbe {
	/** ref string this resolves to — consumed by resolveBaseCommit's `${ref}^{commit}`. */
	ref: string;
	/** exact ref path passed to `rev-parse --verify --quiet`. */
	gitRef: string;
}

/** Pinned probe order: remote default candidates before local ones. */
const PROBES: readonly RefProbe[] = [
	{ ref: "origin/main", gitRef: "refs/remotes/origin/main" },
	{ ref: "origin/master", gitRef: "refs/remotes/origin/master" },
	{ ref: "main", gitRef: "refs/heads/main" },
	{ ref: "master", gitRef: "refs/heads/master" },
];

/**
 * Resolves the ref that quick-dispatch worktrees should branch from — the
 * project's default branch, not the checkout's HEAD.
 *
 * A bounded background fetch refreshes refs without delaying launch.
 * Resolve locally known `origin/HEAD` via `symbolic-ref` → `origin/main` → `origin/master` →
 * local `main` → `master` → `HEAD` as the terminal fallback.
 *
 * `exec` is injected so callers can wire the bounded Tauri git command
 * (`gitExecLocalBounded`) while tests script the responses directly. Every
 * probe failure — non-zero exit, empty output, or a rejected `exec` call —
 * falls through to the next candidate; nothing here ever rejects.
 */
export async function resolveQuickDispatchBaseRef(
	exec: BoundedGitExec,
): Promise<string> {
	void exec(["fetch", "--quiet", "--prune"], FETCH_TIMEOUT_MS).catch(() => null);

	const originHead = await exec(
		["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
		PROBE_TIMEOUT_MS,
	).catch(() => null);
	const head = originHead?.code === 0 ? originHead.stdout.trim() : "";
	if (head) return head;

	for (const probe of PROBES) {
		const result = await exec(
			["rev-parse", "--verify", "--quiet", probe.gitRef],
			PROBE_TIMEOUT_MS,
		).catch(() => null);
		if (result?.code === 0 && result.stdout.trim()) return probe.ref;
	}

	return "HEAD";
}
