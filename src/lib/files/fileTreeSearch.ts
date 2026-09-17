import { buildFileNameSearchCommand } from "@/lib/search/nativeSearchSources";

export const FILE_TREE_SEARCH_LIMIT = 100;

export interface FileTreeSearchResult {
	name: string;
	path: string;
	relativePath: string;
}

function normalizedQuery(query: string): string {
	return query.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function buildFileTreeSearchCommand(
	root: string,
	query: string,
): string {
	return buildFileNameSearchCommand(
		root,
		normalizedQuery(query),
		FILE_TREE_SEARCH_LIMIT,
	);
}

function resultRank(result: FileTreeSearchResult, query: string): number {
	const name = result.name.toLocaleLowerCase();
	const relativePath = result.relativePath.toLocaleLowerCase();
	const needle = query.toLocaleLowerCase();
	if (name === needle) return 0;
	if (name.startsWith(needle)) return 1;
	if (name.includes(needle)) return 2;
	if (relativePath.startsWith(needle)) return 3;
	return 4;
}

export function parseFileTreeSearchResults(
	root: string,
	query: string,
	stdout: string,
): FileTreeSearchResult[] {
	const normalizedRoot = root.replace(/\/+$/, "");
	const normalizedNeedle = normalizedQuery(query);
	const seen = new Set<string>();
	const results: FileTreeSearchResult[] = [];

	for (const raw of stdout.split("\n")) {
		const relativePath = raw.replace(/\r$/, "").replace(/^\.\//, "");
		if (
			!relativePath ||
			relativePath.includes("\0") ||
			relativePath.startsWith("/") ||
			relativePath.split("/").includes("..") ||
			seen.has(relativePath)
		) {
			continue;
		}
		seen.add(relativePath);
		results.push({
			name: relativePath.split("/").pop() ?? relativePath,
			path: `${normalizedRoot}/${relativePath}`,
			relativePath,
		});
	}

	return results
		.sort(
			(left, right) =>
				resultRank(left, normalizedNeedle) -
					resultRank(right, normalizedNeedle) ||
				left.relativePath.length - right.relativePath.length ||
				left.relativePath.localeCompare(right.relativePath),
		)
		.slice(0, FILE_TREE_SEARCH_LIMIT);
}
