// Shared per-projects-array lookup index for the Spaces navigator.
//
// The row derivation used to run `projects.filter(...).sort(...)[0]` per row
// (O(rows × projects log projects)) and `projects.find(...)` per unopened
// agent. This module sorts once per distinct `projects` array and answers
// each lookup with a scan over the pre-sorted list plus a per-cwd memo, so a
// re-derivation storm costs O(rows) map hits instead of repeated sorts.
//
// The index is cached by the identity of the `projects` array (WeakMap), so
// every consumer in the same render tree (useSpaces rows, the unopened-agent
// list) shares one build without prop threading. Zustand replaces the array
// on any project change, which invalidates the cache entry naturally.

export interface ProjectPathRecord {
	readonly id: string;
	readonly path: string;
}

export interface ProjectIndex<P extends ProjectPathRecord> {
	readonly byId: ReadonlyMap<string, P>;
	/** Longest-prefix owner of `cwd` — same predicate and tie-break as the
	 *  previous inline `filter(...).sort(byPathLengthDesc)[0]` (stable sort:
	 *  equal-length ties keep registration order). */
	resolveByCwd(cwd: string): P | undefined;
}

function ownsPath(projectPath: string, cwd: string): boolean {
	return cwd === projectPath || cwd.startsWith(`${projectPath}/`);
}

function buildProjectIndex<P extends ProjectPathRecord>(
	projects: readonly P[],
): ProjectIndex<P> {
	const byLongestPath = [...projects].sort(
		(a, b) => b.path.length - a.path.length,
	);
	const byId = new Map(projects.map((project) => [project.id, project]));
	const byCwd = new Map<string, P | undefined>();
	return {
		byId,
		resolveByCwd(cwd: string): P | undefined {
			if (byCwd.has(cwd)) return byCwd.get(cwd);
			const match = byLongestPath.find((project) =>
				ownsPath(project.path, cwd),
			);
			byCwd.set(cwd, match);
			return match;
		},
	};
}

const indexCache = new WeakMap<object, ProjectIndex<ProjectPathRecord>>();

/** One index per distinct `projects` array identity, shared across consumers. */
export function projectIndexFor<P extends ProjectPathRecord>(
	projects: readonly P[],
): ProjectIndex<P> {
	const cached = indexCache.get(projects as object);
	if (cached) return cached as ProjectIndex<P>;
	const built = buildProjectIndex(projects);
	indexCache.set(projects as object, built as ProjectIndex<ProjectPathRecord>);
	return built;
}
