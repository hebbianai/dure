export interface UsageLimitHandoffOutcome {
	readonly fromName?: string;
	readonly toName: string;
	readonly resume?: "accepted" | "not_sent" | "uncertain";
}

type HandoffResult =
	| { readonly kind: "pending" }
	| { readonly kind: "completed"; readonly outcome: UsageLimitHandoffOutcome }
	| { readonly kind: "failed"; readonly error: string };

interface HandoffAttempt {
	readonly agentId: string;
	readonly failureAtMs: number;
}

interface HandoffEpisode {
	readonly attempt: HandoffAttempt;
	readonly result: HandoffResult;
}

// Client presentation and attempt deduplication only. The canonical runtime
// transition remains the authority for changing accounts.
const episodes = new Map<string, HandoffEpisode>();
const listeners = new Set<() => void>();
let revision = 0;

function publish() {
	revision += 1;
	for (const listener of listeners) listener();
}

export const usageLimitHandoffState = {
	subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	},
	revision: () => revision,
	read(agentId: string, failureAtMs: number): HandoffEpisode | undefined {
		const episode = episodes.get(agentId);
		return episode && episode.attempt.failureAtMs >= failureAtMs
			? episode
			: undefined;
	},
	begin(
		agentId: string,
		failureAtMs: number,
	): HandoffAttempt | undefined {
		const prior = episodes.get(agentId);
		if (
			prior &&
			(prior.attempt.failureAtMs > failureAtMs ||
				(prior.attempt.failureAtMs === failureAtMs &&
					prior.result.kind !== "failed"))
		)
			return undefined;
		const attempt = { agentId, failureAtMs };
		episodes.set(agentId, { attempt, result: { kind: "pending" } });
		publish();
		return attempt;
	},
	settle(attempt: HandoffAttempt, result: HandoffResult): void {
		// A delayed response from an older failure cannot overwrite its successor.
		if (episodes.get(attempt.agentId)?.attempt !== attempt) return;
		episodes.set(attempt.agentId, { attempt, result });
		publish();
	},
};
