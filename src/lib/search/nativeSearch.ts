import type { AgentActivity } from "@/types";

const NATIVE_SEARCH_KINDS = [
	"agent",
	"session",
	"worktree",
	"file",
	"command",
	"repository",
] as const;

export type NativeSearchKind = (typeof NATIVE_SEARCH_KINDS)[number];

export type NativeSearchStatus =
	| "working"
	| "waiting"
	| "done"
	| "connecting"
	| "blocked"
	| "connected"
	| "exited";

type NativeSearchAction =
	| {
			type: "focus-panel";
			desktopId: string;
			panelId: string;
	  }
	| {
			type: "open-agent";
			agentId: string;
			desktopId: string;
	  }
	| {
			type: "open-worktree";
			path: string;
			source: "local" | "ssh";
			hostId?: string;
	  }
	| {
			type: "open-file";
			path: string;
			source: "local" | "ssh";
			hostId?: string;
	  }
	| {
			type: "open-repository";
			projectId: string;
			name: string;
	  }
	| {
			type: "copy-command";
			command: string;
	  }
	| {
			type: "app-command";
			command:
				| "new-terminal"
				| "new-desktop"
				| "balance-panes"
				| "open-settings"
				| "open-onboarding"
				| "open-token-inspector"
				| "open-feedback";
	  };

export interface NativeSearchItem {
	id: string;
	kind: NativeSearchKind;
	title: string;
	detail?: string;
	keywords?: readonly string[];
	status?: NativeSearchStatus;
	action: NativeSearchAction;
}

export interface NativeSearchQuery {
	text: string;
	kinds: ReadonlySet<NativeSearchKind>;
	prefix?: "@" | "/" | ">" | "#";
}

const ALL_KINDS = new Set<NativeSearchKind>(NATIVE_SEARCH_KINDS);
const PREFIX_KINDS: Record<
	NonNullable<NativeSearchQuery["prefix"]>,
	NativeSearchKind[]
> = {
	"@": ["agent", "session"],
	"/": ["file"],
	">": ["command"],
	"#": ["worktree", "repository"],
};

const KIND_ORDER: Record<NativeSearchKind, number> = {
	agent: 0,
	session: 1,
	worktree: 2,
	file: 3,
	command: 4,
	repository: 5,
};

const STATUS_BOOST: Partial<Record<NativeSearchStatus, number>> = {
	blocked: 24,
	working: 20,
	waiting: 16,
	done: 14,
	connecting: 12,
	connected: 8,
	exited: 0,
};

function normalized(value: string): string {
	return value.normalize("NFKC").toLowerCase().trim();
}

export function parseNativeSearchQuery(raw: string): NativeSearchQuery {
	const trimmed = raw.trimStart();
	const prefix = trimmed[0] as NativeSearchQuery["prefix"];
	if (prefix && prefix in PREFIX_KINDS) {
		return {
			text: trimmed.slice(1).trim(),
			kinds: new Set(PREFIX_KINDS[prefix]),
			prefix,
		};
	}
	return { text: trimmed.trim(), kinds: new Set(ALL_KINDS) };
}

function subsequenceScore(haystack: string, needle: string): number | null {
	let cursor = 0;
	let first = -1;
	let previous = -1;
	let gaps = 0;
	for (const character of needle) {
		const index = haystack.indexOf(character, cursor);
		if (index < 0) return null;
		if (first < 0) first = index;
		if (previous >= 0) gaps += index - previous - 1;
		previous = index;
		cursor = index + 1;
	}
	return 260 - first * 3 - gaps * 2;
}

function fieldScore(haystack: string, needle: string): number | null {
	if (!needle) return 0;
	if (haystack === needle) return 1_000;
	if (haystack.startsWith(needle))
		return 820 - Math.min(80, haystack.length - needle.length);
	const wordIndex = haystack.search(
		new RegExp(
			`(?:^|[\\s/_.:@#-])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
		),
	);
	if (wordIndex >= 0) return 680 - Math.min(120, wordIndex);
	const substringIndex = haystack.indexOf(needle);
	if (substringIndex >= 0) return 520 - Math.min(160, substringIndex);
	return subsequenceScore(haystack, needle);
}

function itemScore(item: NativeSearchItem, query: string): number | null {
	const title = normalized(item.title);
	const detail = normalized(item.detail ?? "");
	const keywords = normalized(item.keywords?.join(" ") ?? "");
	const tokens = normalized(query).split(/\s+/).filter(Boolean);
	let score = STATUS_BOOST[item.status ?? "exited"] ?? 0;

	for (const token of tokens) {
		const candidates = [
			fieldScore(title, token),
			fieldScore(detail, token),
			fieldScore(keywords, token),
		];
		const best = Math.max(
			...candidates.map((candidate, index) =>
				candidate === null
					? Number.NEGATIVE_INFINITY
					: candidate * [1, 0.55, 0.45][index],
			),
		);
		if (!Number.isFinite(best)) return null;
		score += best;
	}
	return score;
}

export function rankNativeSearchItems(
	items: readonly NativeSearchItem[],
	rawQuery: string,
	limit = 60,
): NativeSearchItem[] {
	if (limit <= 0) return [];
	const query = parseNativeSearchQuery(rawQuery);
	return items
		.map((item, index) => ({
			item,
			index,
			score: query.kinds.has(item.kind) ? itemScore(item, query.text) : null,
		}))
		.filter(
			(
				candidate,
			): candidate is {
				item: NativeSearchItem;
				index: number;
				score: number;
			} => candidate.score !== null,
		)
		.sort(
			(left, right) =>
				right.score - left.score ||
				KIND_ORDER[left.item.kind] - KIND_ORDER[right.item.kind] ||
				left.index - right.index,
		)
		.slice(0, limit)
		.map(({ item }) => item);
}

export function nativeSearchStatus(
	activity:
		| AgentActivity
		| "blocked"
		| "done"
		| "connected"
		| "reconnecting"
		| "error"
		| "closed"
		| "unknown"
		| undefined,
): NativeSearchStatus | undefined {
	if (activity === "reconnecting") return "connecting";
	if (activity === "error" || activity === "closed") return "exited";
	if (
		activity === "working" ||
		activity === "waiting" ||
		activity === "done" ||
		activity === "connecting" ||
		activity === "blocked" ||
		activity === "connected" ||
		activity === "exited"
	) {
		return activity;
	}
	return undefined;
}
