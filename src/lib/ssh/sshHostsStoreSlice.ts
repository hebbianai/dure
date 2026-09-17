// SSH Host projection plus per-session connection state. Host creation and
// mutation belong to the durable credential lifecycle, never this view slice.

import type { RemoteShellHostDraft } from "@/lib/hmux/remote/remoteHmuxShellRegistration";
import type { SshHostConfig, SshState } from "@/types";

interface SshRegistrationDecision {
	readonly requestId: string;
	readonly candidate: RemoteShellHostDraft;
	readonly expiresAt: number;
	readonly response: Promise<boolean>;
	readonly answer: (accepted: boolean) => void;
}

export interface SshHostsStoreSlice {
	sshHosts: SshHostConfig[];
	sshStates: Record<string, SshState>;
	sshMessages: Record<string, string>;
	sshRegistrationDecisions: readonly SshRegistrationDecision[];
	requestSshRegistrationDecision: (
		requestId: string,
		candidate: RemoteShellHostDraft,
		lifetimeMs: number,
	) => Promise<boolean>;

	setSshState: (sessionId: string, s: SshState, message?: string) => void;
}

type SliceSet = (
	updater: (
		state: SshHostsStoreSlice,
	) => SshHostsStoreSlice | Partial<SshHostsStoreSlice>,
) => void;

export function createSshHostsStoreSlice(
	set: SliceSet,
	get: () => SshHostsStoreSlice,
): SshHostsStoreSlice {
	return {
		sshHosts: [],
		sshStates: {},
		sshMessages: {},
		sshRegistrationDecisions: [],

		requestSshRegistrationDecision: (requestId, candidate, lifetimeMs) => {
			const current = get().sshRegistrationDecisions.find(
				(entry) => entry.requestId === requestId,
			);
			if (current) return current.response;
			let respond!: (accepted: boolean) => void;
			const response = new Promise<boolean>((resolve) => {
				respond = resolve;
			});
			const decision: SshRegistrationDecision = {
				requestId,
				candidate,
				response,
				expiresAt: performance.now() + lifetimeMs,
				answer: (accepted) => {
					if (!get().sshRegistrationDecisions.includes(decision)) return;
					clearTimeout(timer);
					set((state) => ({
						sshRegistrationDecisions: state.sshRegistrationDecisions.filter(
							(entry) => entry !== decision,
						),
					}));
					// Native admission still decides whether this answer is live.
					respond(accepted && performance.now() < decision.expiresAt);
				},
			};
			const timer = setTimeout(() => decision.answer(false), lifetimeMs);
			set((state) => ({
				sshRegistrationDecisions: [...state.sshRegistrationDecisions, decision],
			}));
			return response;
		},

		setSshState: (sessionId, st, message) =>
			set((s) => {
				const next: Partial<SshHostsStoreSlice> = {};
				if (s.sshStates[sessionId] !== st) {
					next.sshStates = { ...s.sshStates, [sessionId]: st };
				}
				if (message && s.sshMessages[sessionId] !== message) {
					next.sshMessages = { ...s.sshMessages, [sessionId]: message };
				}
				if (st === "connected" && s.sshMessages[sessionId]) {
					next.sshMessages = { ...s.sshMessages, [sessionId]: "" };
				}
				return Object.keys(next).length ? next : s;
			}),
	};
}
