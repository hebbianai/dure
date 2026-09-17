import {
	canonicalAgentNameCandidate,
	uniqueAgentName,
} from "@/lib/agents/agentName";
import type { RepoBranchState } from "@/lib/agents/repoBranchLoad";
import { agentNameSuggestion } from "@/lib/ipc/agentNaming";
import {
	defaultBranchName,
	defaultWorktreePath,
} from "@/lib/scm/worktrees/worktreePlan";
import type { Provider } from "@/types";

const MAX_SLUG_WORDS = 4;

export {
	canonicalAgentNameCandidate as sanitizeAgentNameCandidate,
	uniqueAgentName,
};

/** The naming instruction asks the provider for a "3-4 word kebab-case name
 * (lowercase ascii letters, digits, hyphens)". `canonicalAgentNameCandidate`
 * only enforces the charset, so a whole error sentence the naming CLI prints to
 * stdout — e.g. an MCP handshake error when it initializes the project's MCP
 * servers — slugifies into a valid-charset multi-word (or dotted) string and
 * would become the agent name. This enforces the *shape* the instruction
 * promised: at most MAX_SLUG_WORDS hyphen-separated words, each purely
 * alphanumeric (so a dotted identity token like `client.listtools` is
 * rejected). A candidate that fails this is not a name — the caller falls back
 * to the deterministic heuristic. */
function isNameShapedSlug(slug: string): boolean {
	const words = slug.split("-");
	return (
		words.length <= MAX_SLUG_WORDS &&
		words.every((word) => /^[a-z0-9]+$/.test(word))
	);
}

const AGENT_BRANCH_PREFIX = defaultBranchName("");

/** Names the repository already claims, so `uniqueAgentName` skips them
 * exactly like a registered agent. A deleted agent leaves its
 * `agent/<name>` branch and `.worktrees/<name>` checkout behind, and the spawn
 * saga refuses both as `workspace_identity_conflict` — the app's agent list
 * alone let "Fix" re-pick an `agent/fix-N` branch that still existed. */
export function repoClaimedAgentNames(
	repo: RepoBranchState,
	projectPath: string,
): string[] {
	const claimed = new Set<string>();
	for (const branch of repo.branches) {
		if (branch.name.startsWith(AGENT_BRANCH_PREFIX)) {
			claimed.add(branch.name.slice(AGENT_BRANCH_PREFIX.length));
		}
	}
	for (const worktree of repo.worktrees) {
		const directory = worktree.path.slice(worktree.path.lastIndexOf("/") + 1);
		if (
			directory &&
			defaultWorktreePath(projectPath, directory) === worktree.path
		) {
			claimed.add(directory);
		}
	}
	return [...claimed];
}

/** Deterministic heuristic used when AI naming is unavailable. */
export function fallbackAgentSlug(prompt: string): string | null {
	const words = prompt
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9\s-]+/g, " ")
		.split(/\s+/)
		.filter((word) => word.length >= 1 && /[a-z0-9]/.test(word));
	const slug = canonicalAgentNameCandidate(
		words.slice(0, MAX_SLUG_WORDS).join("-").replace(/-+/g, "-"),
	);
	return slug !== null && slug.length >= 3 ? slug : null;
}

export interface SuggestNameDependencies {
	suggest: (providerId: string, prompt: string, cwd: string) => Promise<string>;
	timeoutMs: number;
}

const defaultSuggestDependencies: SuggestNameDependencies = {
	suggest: agentNameSuggestion,
	timeoutMs: 8000,
};

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("quick_dispatch_naming_timeout")),
			timeoutMs,
		);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(cause) => {
				clearTimeout(timer);
				reject(cause);
			},
		);
	});
}

function lastNonEmptyLine(raw: string): string {
	const lines = raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return lines[lines.length - 1] ?? "";
}

/** Instant, never-failing name: heuristic slug → provider-count name. The
 * spawn path uses this so the AI suggestion never sits on the critical path
 * (a headless provider CLI + LLM round trip, typically 2-6s). */
export function deterministicQuickDispatchName(input: {
	prompt: string;
	providerId: Provider;
	takenNames: readonly string[];
}): string {
	const slug = fallbackAgentSlug(input.prompt);
	if (slug) return uniqueAgentName(slug, input.takenNames);
	const count = input.takenNames.filter((name) =>
		name.startsWith(`${input.providerId}-`),
	).length;
	return uniqueAgentName(`${input.providerId}-${count + 1}`, input.takenNames);
}

/** Never rejects: AI suggestion → heuristic slug → provider-count name. */
export async function suggestQuickDispatchName(
	input: {
		prompt: string;
		providerId: Provider;
		projectPath: string;
		takenNames: readonly string[];
	},
	deps: SuggestNameDependencies = defaultSuggestDependencies,
): Promise<string> {
	try {
		const raw = await withTimeout(
			deps.suggest(input.providerId, input.prompt, input.projectPath),
			deps.timeoutMs,
		);
		const sanitized = canonicalAgentNameCandidate(lastNonEmptyLine(raw));
		if (sanitized && isNameShapedSlug(sanitized)) {
			return uniqueAgentName(sanitized, input.takenNames);
		}
	} catch {
		// Naming must never fail a dispatch; fall through to the heuristics.
	}
	return deterministicQuickDispatchName(input);
}
