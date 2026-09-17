export type WorkCheckpointResume = (() => void) & {
	drafts?: readonly (readonly [string, string])[];
};
type Resume = WorkCheckpointResume;
type Checkpoint = () => Promise<Resume>;
const work = new Set<Checkpoint>();

/** Mounted document owners retain their own drafts; this registry owns no data. */
export function registerWindowWorkCheckpoint(checkpoint: Checkpoint): Resume {
	work.add(checkpoint);
	return () => {
		work.delete(checkpoint);
	};
}

/** Wait for every owner, including late successes after another owner fails. */
export async function checkpointWindowWork(): Promise<Resume> {
	const selected = [...work];
	const results = await Promise.allSettled(
		selected.map((checkpoint) => Promise.resolve().then(checkpoint)),
	);
	const resume = () => {
		for (const result of results)
			if (result.status === "fulfilled") result.value();
	};
	const failed = results.find((result) => result.status === "rejected");
	if (failed?.status === "rejected") {
		resume();
		throw failed.reason;
	}
	if (
		selected.length !== work.size ||
		selected.some((checkpoint) => !work.has(checkpoint))
	) {
		resume();
		throw new Error("app_restart_documents_changed");
	}
	const drafts = new Map<string, string>();
	for (const result of results) {
		if (result.status !== "fulfilled") continue;
		for (const [identity, digest] of result.value.drafts ?? []) {
			if (drafts.has(identity) && drafts.get(identity) !== digest) {
				resume();
				throw new Error("app_restart_draft_conflict");
			}
			drafts.set(identity, digest);
		}
	}
	let released = false;
	return Object.assign(
		() => {
			if (!released) {
				released = true;
				resume();
			}
		},
		{ drafts: [...drafts] },
	);
}
