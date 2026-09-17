import { searchLocalDirectories } from "@/lib/ipc/files";
import { locateGitCheckoutPaths } from "@/lib/ipc/git";
import {
	repositoryProjectPath,
	type LocalFolderSuggestion,
} from "@/lib/spaces/localFolderSuggestions";

/** OS discovery is independent of provider history. Git owns checkout identity. */
export async function searchLocalProjects(
	query: string,
): Promise<LocalFolderSuggestion[]> {
	const paths = await searchLocalDirectories(query);
	if (paths.length === 0) return [];
	const locations = await locateGitCheckoutPaths(paths);
	const results = new Map<string, LocalFolderSuggestion>();
	for (const [index, candidate] of paths.entries()) {
		const location = locations[index];
		if (location && "absentPath" in location) continue;
		const path = repositoryProjectPath(
			location?.canonicalPath ?? candidate,
			location?.gitCommonDir,
		);
		results.set(path, {
			path,
			name: path.split("/").filter(Boolean).slice(-1)[0] ?? path,
			isRepo: Boolean(location),
			sessionCount: 0,
			lastMtime: 0,
		});
	}
	return [...results.values()].sort(
		(a, b) =>
			Number(b.isRepo) - Number(a.isRepo) || a.path.localeCompare(b.path),
	);
}

export function mergeProjectSearchResults(
	recent: readonly LocalFolderSuggestion[],
	found: readonly LocalFolderSuggestion[],
	registeredPaths: readonly string[],
): LocalFolderSuggestion[] {
	const registered = new Set(
		registeredPaths.map((path) => path.replace(/\/+$/, "")),
	);
	const results = new Map(found.map((result) => [result.path, result]));
	for (const suggestion of recent) {
		const observed = results.get(suggestion.path);
		results.set(suggestion.path, {
			...suggestion,
			isRepo: suggestion.isRepo || Boolean(observed?.isRepo),
		});
	}
	return [...results.values()]
		.filter((result) => !registered.has(result.path))
		.sort(
			(a, b) =>
				Number(b.isRepo) - Number(a.isRepo) ||
				b.lastMtime - a.lastMtime ||
				a.path.localeCompare(b.path),
		)
		.slice(0, 100);
}
