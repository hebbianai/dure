// Hide model for the "unopened agents" list — the sibling of
// detectedWorktreeVisibility with the same meaning: hiding suppresses only the
// exact observation the user saw, and new activity resurfaces the row. For a
// registered agent the activity authority is its attention episode sequence
// (agentAttentionStore.episodes) — the single producer of "this agent needs
// your eyes" events — so a hidden agent reappears when a new episode lands.

export const UNOPENED_AGENT_HIDDEN_LIMIT = 512;

const IDENTITY_MEMBER_LIMIT = 4 * 1024;

export interface UnopenedAgentVisibilityTarget {
	readonly id: string;
	/** Current attention episode sequence for this agent (0 if none yet). */
	readonly episode: number;
}

export interface HiddenUnopenedAgent {
	readonly id: string;
	/** Episode sequence observed at hide time. Volatile per app run — the
	 *  persisted shape drops it and rehydration defaults it to 0, so a restart
	 *  alone keeps the row hidden while the first fresh episode reveals it. */
	readonly observedEpisode: number;
}

function validId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value.length <= IDENTITY_MEMBER_LIMIT
	);
}

function validEpisode(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function normalizeHiddenUnopenedAgents(
	value: unknown,
): HiddenUnopenedAgent[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const normalized: HiddenUnopenedAgent[] = [];
	for (let index = value.length - 1; index >= 0; index -= 1) {
		const record = value[index] as Partial<HiddenUnopenedAgent> | null;
		if (
			!record ||
			typeof record !== "object" ||
			Array.isArray(record) ||
			!validId(record.id) ||
			seen.has(record.id)
		) {
			continue;
		}
		seen.add(record.id);
		normalized.push({
			id: record.id,
			// Absent after rehydration (the persisted shape is id-only) — 0 means
			// "reveal on the first fresh episode of this run".
			observedEpisode: validEpisode(record.observedEpisode)
				? record.observedEpisode
				: 0,
		});
		if (normalized.length === UNOPENED_AGENT_HIDDEN_LIMIT) break;
	}
	return normalized.reverse();
}

/** Rehydration path for persisted entries. The attention episode sequence
 *  restarts at 0 every app run, so an observation from a previous run would
 *  swallow that run's first fresh episodes. Keep the ids (a restart alone is
 *  not activity) and zero the observation (the first fresh episode reveals). */
export function rehydrateHiddenUnopenedAgents(
	value: unknown,
): HiddenUnopenedAgent[] {
	return normalizeHiddenUnopenedAgents(value).map((record) => ({
		id: record.id,
		observedEpisode: 0,
	}));
}

export function hideUnopenedAgent(
	current: readonly HiddenUnopenedAgent[],
	target: UnopenedAgentVisibilityTarget,
): readonly HiddenUnopenedAgent[] {
	if (!validId(target.id)) return current;
	const next: HiddenUnopenedAgent = {
		id: target.id,
		observedEpisode: validEpisode(target.episode) ? target.episode : 0,
	};
	const retained = current.filter((record) => record.id !== next.id);
	return normalizeHiddenUnopenedAgents([...retained, next]);
}

export function isUnopenedAgentHidden(
	target: UnopenedAgentVisibilityTarget,
	hidden: readonly HiddenUnopenedAgent[],
): boolean {
	const observation = hidden.find((record) => record.id === target.id);
	return Boolean(observation && target.episode <= observation.observedEpisode);
}
