// Fork-point diff statistics for an SSH worktree. Mirrors the local
// `agent_diff_stat` Tauri command (`src-tauri/src/diff.rs`) closely enough
// that `badgeFromStat` sees the same shape: base ref detection, merge-base,
// ahead/behind, and three numstat views. Untracked files join the worktree
// patch through intent-to-add on a private index copy; the real remote index
// is never written. Paths are NUL-delimited, so they arrive exact; only the
// per-file status letter is coarser than the local command (M or R).

import type { AgentDiffStat, DiffFileStat } from "@/lib/ipc";
import { shellQuote } from "@/lib/platform/shell";

const SECTIONS = ["committed", "worktree", "files"] as const;
type Section = (typeof SECTIONS)[number];

/** One POSIX `sh` script: a single SSH round trip per badge refresh. Each
 * numstat view is framed as `@<section> <token count>` followed by that many
 * NUL-terminated tokens, so no sentinel can collide with a path. */
const SCRIPT = `set -u
cd "$1" || exit 2
base=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)
base=\${base#refs/remotes/}
if [ -z "$base" ]; then
  for c in origin/main origin/master main master; do
    if git rev-parse --verify --quiet "$c^{commit}" >/dev/null 2>&1; then
      base=$c
      break
    fi
  done
fi
if [ -z "$base" ]; then
  echo 'Could not find a base branch (origin/HEAD, main, and master are all missing)' >&2
  exit 3
fi
mb=$(git merge-base "$base" HEAD) || exit 4
ab=$(git rev-list --left-right --count "HEAD...$base") || exit 5
printf 'base %s\\nmerge-base %s\\nab %s\\n' "$base" "$mb" "$ab"
tmp=$(mktemp) || exit 6
out=$(mktemp) || exit 6
trap 'rm -f "$tmp" "$out"' EXIT
idx=$(git rev-parse --git-path index)
cp "$idx" "$tmp" 2>/dev/null || rm -f "$tmp"
export GIT_INDEX_FILE="$tmp"
git add --intent-to-add --ignore-errors -- . >/dev/null 2>&1 || true
section() {
  name=$1
  shift
  git --no-optional-locks -c diff.autoRefreshIndex=false diff --numstat -z -M "$@" > "$out" || return 1
  printf '@%s %s\\n' "$name" "$(tr -cd '\\000' < "$out" | wc -c)"
  cat "$out"
}
section committed "$mb" HEAD || exit 7
section worktree HEAD || exit 8
section files "$mb" || exit 9
`;

/** The remote command for one worktree; the path travels as `$1`, never
 * interpolated into the script body. */
export function remoteDiffStatCommand(worktreePath: string): string {
	return `sh -c ${shellQuote(SCRIPT)} dure-diff-stat ${shellQuote(worktreePath)}`;
}

function count(token: string): number | null {
	if (token === "-") return null;
	const value = Number.parseInt(token, 10);
	return Number.isInteger(value) && value >= 0 ? value : null;
}

/** `git diff --numstat -z -M` tokens: `ADD\tDEL\tPATH`, or for a rename
 * `ADD\tDEL\t` followed by the old and new path as two more tokens. */
function parseNumstatTokens(tokens: readonly string[]): DiffFileStat[] {
	const files: DiffFileStat[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const [added, deleted, path] = tokens[index]?.split("\t") ?? [];
		if (added === undefined || deleted === undefined || path === undefined) {
			throw new Error(`Invalid numstat token: ${tokens[index]}`);
		}
		if (path.length > 0) {
			files.push({
				path,
				oldPath: null,
				added: count(added),
				deleted: count(deleted),
				status: "M",
			});
			continue;
		}
		const oldPath = tokens[index + 1];
		const newPath = tokens[index + 2];
		if (!oldPath || !newPath) throw new Error("Truncated rename token");
		files.push({
			path: newPath,
			oldPath,
			added: count(added),
			deleted: count(deleted),
			status: "R",
		});
		index += 2;
	}
	return files;
}

function parseDivergence(value: string): { ahead: number; behind: number } {
	const [ahead, behind, extra] = value.trim().split(/\s+/);
	const left = count(ahead ?? "");
	const right = count(behind ?? "");
	if (left === null || right === null || extra !== undefined) {
		throw new Error(`Invalid branch divergence result: ${value.trim()}`);
	}
	return { ahead: left, behind: right };
}

/** Parses the script's stdout. Throws when the header or a section is
 * missing so a truncated stream never becomes an all-clear badge. */
export function parseRemoteDiffStat(stdout: string): AgentDiffStat {
	let baseRef = "";
	let mergeBase = "";
	let divergence: { ahead: number; behind: number } | undefined;
	const sections: Partial<Record<Section, DiffFileStat[]>> = {};
	let cursor = 0;
	while (cursor < stdout.length) {
		const lineEnd = stdout.indexOf("\n", cursor);
		if (lineEnd === -1) throw new Error("Incomplete remote diff stat");
		const line = stdout.slice(cursor, lineEnd).replace(/\r$/, "");
		cursor = lineEnd + 1;
		if (line.startsWith("@")) {
			const [, name, countText] = /^@(\S+)[ \t]+(\d+)$/.exec(line) ?? [];
			const section = SECTIONS.find((candidate) => candidate === name);
			const tokenCount = count((countText ?? "").trim());
			if (!section || tokenCount === null) {
				throw new Error(`Invalid diff section header: ${line}`);
			}
			const tokens: string[] = [];
			for (let read = 0; read < tokenCount; read += 1) {
				const nul = stdout.indexOf("\0", cursor);
				if (nul === -1) throw new Error("Incomplete remote diff stat");
				tokens.push(stdout.slice(cursor, nul));
				cursor = nul + 1;
			}
			sections[section] = parseNumstatTokens(tokens);
		} else if (line.startsWith("base ")) baseRef = line.slice(5).trim();
		else if (line.startsWith("merge-base ")) mergeBase = line.slice(11).trim();
		else if (line.startsWith("ab "))
			divergence = parseDivergence(line.slice(3));
	}
	const { committed, worktree, files } = sections;
	if (
		!baseRef ||
		!mergeBase ||
		!divergence ||
		!committed ||
		!worktree ||
		!files
	) {
		throw new Error("Incomplete remote diff stat");
	}
	return {
		baseRef,
		mergeBase,
		committedFiles: committed,
		worktreeFiles: worktree,
		...divergence,
		files,
	};
}
