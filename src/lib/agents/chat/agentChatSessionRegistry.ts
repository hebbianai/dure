import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

export interface AgentChatSessionLifecycle {
	start(): void;
	stop(): void;
}

type TimerHandle = ReturnType<typeof setTimeout> | number;

interface RegistryEntry<T extends AgentChatSessionLifecycle> {
	agentId: string;
	controller: T;
	references: number;
	releaseTimer?: TimerHandle;
}

export interface AgentChatSessionLease<T extends AgentChatSessionLifecycle> {
	controller: T;
	release(): void;
}

export function createAgentChatSessionRegistry<
	T extends AgentChatSessionLifecycle,
>(options: {
	create(input: {
		agentId: string;
		backendProfileId: string;
		interactionSessionId: string;
		routeAuthority?: DureBackendRouteAuthorityV1;
	}): T;
	releaseGraceMs?: number;
	setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
	clearTimer?: (timer: TimerHandle) => void;
}) {
	const entries = new Map<string, RegistryEntry<T>>();
	const releaseGraceMs = options.releaseGraceMs ?? 5_000;
	const setTimer = options.setTimer ?? setTimeout;
	const clearTimer = options.clearTimer ?? clearTimeout;

	return {
		acquire(input: {
			agentId: string;
			backendProfileId: string;
			interactionSessionId: string;
			routeAuthority?: DureBackendRouteAuthorityV1;
		}): AgentChatSessionLease<T> {
			const key = JSON.stringify([
				input.backendProfileId,
				input.interactionSessionId,
				input.routeAuthority,
			]);
			let entry = entries.get(key);
			if (entry && entry.agentId !== input.agentId) {
				throw new Error("agent_chat_registry_identity_conflict");
			}
			if (!entry) {
				entry = {
					agentId: input.agentId,
					controller: options.create(input),
					references: 0,
				};
				entries.set(key, entry);
			}
			if (entry.releaseTimer) clearTimer(entry.releaseTimer);
			entry.releaseTimer = undefined;
			const wasUnreferenced = entry.references === 0;
			entry.references += 1;
			if (wasUnreferenced) entry.controller.start();
			let released = false;
			return {
				controller: entry.controller,
				release() {
					if (released) return;
					released = true;
					const current = entries.get(key);
					if (!current || current !== entry) return;
					current.references = Math.max(0, current.references - 1);
					if (current.references > 0 || current.releaseTimer) return;
					current.releaseTimer = setTimer(() => {
						const idle = entries.get(key);
						if (!idle || idle !== current || idle.references > 0) return;
						idle.controller.stop();
						entries.delete(key);
					}, releaseGraceMs);
				},
			};
		},
	};
}
