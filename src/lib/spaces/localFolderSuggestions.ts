import type { ProviderConversationRecord } from "@/lib/agents/providerConversationDiscovery";

export interface LocalFolderSuggestion {
	path: string;
	name: string;
	isRepo: boolean;
	sessionCount: number;
	lastMtime: number;
}

const DEFAULT_SUGGESTION_LIMIT = 12;

function normalizeFolderPath(path: string): string {
	const trimmed = path.trim().replace(/\/+$/, "");
	return trimmed.length > 0 ? trimmed : path.trim();
}

/** A conventional common Git directory identifies the primary working folder. */
export function repositoryProjectPath(
	root: string,
	commonDir?: string,
): string {
	const common = normalizeFolderPath(commonDir ?? "");
	return common.endsWith("/.git") && common !== "/.git"
		? common.slice(0, -5)
		: normalizeFolderPath(root);
}

/** Project suggestions use the shared Git directory, so linked checkouts
 * contribute activity to their repository instead of occupying separate rows.
 * An unconventional Git directory does not identify a main checkout: retain
 * one observed checkout in that case, never invent a registration path. */
export function localFolderSuggestions(input: {
	records: readonly ProviderConversationRecord[];
	registeredPaths: readonly string[];
	query?: string;
	limit?: number;
}): LocalFolderSuggestion[] {
	const registered = new Set(input.registeredPaths.map(normalizeFolderPath));
	const byPath = new Map<string, LocalFolderSuggestion>();
	const repositoryPaths = new Map<string, string>();
	for (const record of input.records) {
		if (record.executionLocation !== "local") continue;
		const common = normalizeFolderPath(record.repositoryCommonDir ?? "");
		const root = normalizeFolderPath(record.repositoryRoot ?? "");
		if (!common || !root) continue;
		const candidate = repositoryProjectPath(root, common);
		const previous = repositoryPaths.get(common);
		if (!previous || candidate.localeCompare(previous) < 0) {
			repositoryPaths.set(common, candidate);
		}
	}

	for (const record of input.records) {
		if (record.executionLocation !== "local") continue;
		const common = normalizeFolderPath(record.repositoryCommonDir ?? "");
		const path =
			repositoryPaths.get(common) ??
			normalizeFolderPath(record.repositoryRoot?.trim() || record.cwd);
		if (!path || path === "/" || registered.has(path)) continue;
		const isRepo = Boolean(record.repositoryRoot?.trim() || common);
		const existing = byPath.get(path);
		if (existing) {
			existing.isRepo ||= isRepo;
			existing.sessionCount += 1;
			existing.lastMtime = Math.max(existing.lastMtime, record.mtime);
			continue;
		}
		byPath.set(path, {
			path,
			name: path.split("/").filter(Boolean).slice(-1)[0] ?? path,
			isRepo,
			sessionCount: 1,
			lastMtime: record.mtime,
		});
	}

	const needle = input.query?.trim().toLowerCase() ?? "";
	const matches = [...byPath.values()].filter(
		(suggestion) => !needle || suggestion.path.toLowerCase().includes(needle),
	);
	matches.sort(
		(left, right) =>
			Number(right.isRepo) - Number(left.isRepo) ||
			right.lastMtime - left.lastMtime ||
			right.sessionCount - left.sessionCount ||
			left.path.localeCompare(right.path),
	);
	return matches.slice(0, input.limit ?? DEFAULT_SUGGESTION_LIMIT);
}
