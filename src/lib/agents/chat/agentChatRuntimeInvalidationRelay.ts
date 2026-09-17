import {
	type StructuredAgentRuntimeProjectionGenerationV1,
	sameStructuredAgentRuntimeProjectionGeneration,
} from "@/lib/agents/agentRuntimeProjectionRecovery";

export type AgentChatRuntimeInvalidationListener = (
	generation: StructuredAgentRuntimeProjectionGenerationV1,
) => boolean | Promise<boolean>;

interface RuntimeInvalidationSubscription {
	readonly notify: AgentChatRuntimeInvalidationListener;
}

/** Relays the latest runtime generation until one view confirms that its
 * structured projection is stable. Connection recovery remains owned by the
 * session controller; this class only preserves delivery across view churn. */
export class AgentChatRuntimeInvalidationRelay {
	private readonly subscriptions = new Set<RuntimeInvalidationSubscription>();
	private observed?: StructuredAgentRuntimeProjectionGenerationV1;
	private pending?: StructuredAgentRuntimeProjectionGenerationV1;

	subscribe(listener: AgentChatRuntimeInvalidationListener): () => void {
		const subscription = { notify: listener };
		this.subscriptions.add(subscription);
		if (this.pending) this.notify(subscription, this.pending);
		return () => this.subscriptions.delete(subscription);
	}

	observe(generation: StructuredAgentRuntimeProjectionGenerationV1): void {
		if (
			!sameStructuredAgentRuntimeProjectionGeneration(this.observed, generation)
		) {
			this.observed = generation;
			this.pending = generation;
		}
		this.notifyPending();
	}

	invalidate(): void {
		if (this.observed) this.pending = this.observed;
		this.notifyPending();
	}

	private notifyPending(): void {
		const pending = this.pending;
		if (!pending) return;
		for (const subscription of [...this.subscriptions]) {
			this.notify(subscription, pending);
		}
	}

	private notify(
		subscription: RuntimeInvalidationSubscription,
		generation: StructuredAgentRuntimeProjectionGenerationV1,
	): void {
		try {
			void Promise.resolve(subscription.notify(generation)).then(
				(acknowledged) => {
					if (
						acknowledged &&
						sameStructuredAgentRuntimeProjectionGeneration(
							this.pending,
							generation,
						)
					) {
						this.pending = undefined;
					}
				},
				() => {
					// Retain the generation for the next observation or subscriber.
				},
			);
		} catch {
			// A synchronous observer failure likewise leaves the generation pending.
		}
	}
}
