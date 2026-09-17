// Session-runtime store slice — the runtime-only (never persisted) projection
// of live session facts: activity, Host-owned agent runtime state, Hmux attach
// metadata, cwd/title/provider detection, and restart/refresh signals.
// Extracted from store.ts as a composition slice (precedent:
// providerLaunchDefaultsStoreSlice); implementations moved verbatim so update
// and no-op semantics are unchanged.

import type { AgentRuntimeLaunchPresentation } from "@/lib/agents/agentRuntimeLaunchPresentation";
import { compareDecimalStrings } from "@/lib/decimalString";
import { mergeHmuxSessionMetadata } from "@/lib/hmux/identity/hmuxSessionMetadata";
import type { HmuxAgentRuntimeState, HmuxSessionSummary } from "@/lib/ipc";
import { sanitizeSessionTitle } from "@/lib/sessions/sessionTitle";
import type { AgentActivity, Provider, SshState } from "@/types";

export interface SessionAgentRuntimeObservation {
	publish(state: HmuxAgentRuntimeState): void;
	dispose(): void;
}

/** Observer identities retain only the Host epoch they currently observe. */
type SessionAgentRuntimeObservers = Record<string, string | null>;

export function hasSessionAgentRuntimeObservation(
	state: HmuxAgentRuntimeState | undefined,
	observers: SessionAgentRuntimeObservers | undefined,
): boolean | undefined {
	if (observers === undefined) return undefined;
	return (
		state !== undefined &&
		Object.values(observers).includes(state.terminalEpoch)
	);
}

export interface SessionRuntimeStoreSlice {
	// runtime (not persisted)
	agentActivity: Record<string, AgentActivity>;
	/** Host-owned semantic state for Hmux agent sessions; runtime-only and revision fenced. */
	sessionAgentRuntimeState: Record<string, HmuxAgentRuntimeState>;
	/** Local stream lifetimes; an empty entry means the retained facts are unobserved. */
	sessionAgentRuntimeObservers: Record<string, SessionAgentRuntimeObservers>;
	/** Complete backend-committed launch selection keyed by registered Agent. */
	agentRuntimeLaunchPresentation: Record<
		string,
		AgentRuntimeLaunchPresentation
	>;
	/** Exact attach receipts keyed by [workspaceId, sessionId]; runtime-only. */
	hmuxSessionMetadata: Record<string, HmuxSessionSummary>;
	/** Monotonic manual refresh requests keyed by DockView pane id; runtime-only. */
	terminalRefreshRequests: Record<string, number>;
	/** 세션별 라이브 cwd (터미널 OSC 7로 갱신) — herdr식 쉘→프로젝트 자동 인식 */
	sessionCwd: Record<string, string>;
	/** 세션에서 감지된 에이전트 종류 (화면 패턴) — 없으면 그냥 쉘 */
	sessionAgent: Record<string, Provider | null>;
	/** 세션의 터미널 타이틀 (OSC 0/2) — herdr식으로 감지된 세션 이름에 사용 */
	sessionTitle: Record<string, string>;
	/** herdr식 활동 — 에이전트 훅(UserPromptSubmit)이 보고하는 "지금 하는 작업"
	 *  (최근 프롬프트). 세션 id로 매핑, 휘발(persist 제외). */
	sessionActivity: Record<string, { text: string; at?: number }>;
	/** 훅이 확정한 provider — 화면 감지(sessionAgent)보다 우선한다. codex 등
	 *  alt-screen TUI는 화면에서 provider를 잘못 잡으므로, 훅이 걸린 provider로
	 *  못박아 detectAgent가 덮어쓰지 못하게 한다. */
	sessionAgentPin: Record<string, Provider>;
	/** 에이전트 세션 강제 재시작 신호 (패널이 epoch에 합산) */
	restartRequests: Record<string, number>;

	setAgentActivity: (agentId: string, a: AgentActivity) => void;
	beginSessionAgentRuntimeObservation: (
		sessionId: string,
	) => SessionAgentRuntimeObservation;
	setSessionAgentRuntimeState: (
		sessionId: string,
		state: HmuxAgentRuntimeState,
	) => void;
	setHmuxSessionMetadata: (session: HmuxSessionSummary) => void;
	setHmuxSessionsMetadata: (sessions: readonly HmuxSessionSummary[]) => void;
	requestTerminalRefresh: (paneId: string) => void;
	setSessionCwd: (sessionId: string, cwd: string) => void;
	setSessionAgent: (sessionId: string, kind: Provider | null) => void;
	setSessionTitle: (sessionId: string, title: string) => void;
	/** Latest prompt and activity time from a native hook or structured timeline. */
	setSessionActivity: (sessionId: string, text: string, observedAt?: number) => void;
	/** provider 확정(훅/데몬) — 화면 감지보다 우선. null이면 확정 해제(에이전트 종료) */
	setSessionAgentPin: (sessionId: string, provider: Provider | null) => void;
	forgetSessionRuntime: (sessionIds: readonly string[]) => void;
	requestAgentRestart: (agentId: string) => void;
}

/** forgetSessionRuntime also clears the per-session SSH records, so the host
 *  store must carry them alongside this slice. */
type SessionRuntimeHostState = SessionRuntimeStoreSlice & {
	sshStates: Record<string, SshState>;
	sshMessages: Record<string, string>;
};

type SliceSet = (
	updater: (
		state: SessionRuntimeHostState,
	) => SessionRuntimeHostState | Partial<SessionRuntimeHostState>,
) => void;

function projectAgentRuntimeState(
	current: SessionRuntimeHostState,
	sessionId: string,
	state: HmuxAgentRuntimeState,
): Record<string, HmuxAgentRuntimeState> {
	const previous = current.sessionAgentRuntimeState[sessionId];
	if (
		previous?.terminalEpoch === state.terminalEpoch &&
		compareDecimalStrings(state.revision, previous.revision) <= 0
	) {
		return current.sessionAgentRuntimeState;
	}
	return { ...current.sessionAgentRuntimeState, [sessionId]: state };
}

export function createSessionRuntimeStoreSlice(
	set: SliceSet,
): SessionRuntimeStoreSlice {
	const setHmuxSessionsMetadata = (sessions: readonly HmuxSessionSummary[]) =>
		set((current) => {
			const hmuxSessionMetadata = mergeHmuxSessionMetadata(
				current.hmuxSessionMetadata,
				sessions,
			);
			return hmuxSessionMetadata === current.hmuxSessionMetadata
				? current
				: { hmuxSessionMetadata };
		});

	return {
		agentActivity: {},
		sessionAgentRuntimeState: {},
		sessionAgentRuntimeObservers: {},
		agentRuntimeLaunchPresentation: {},
		hmuxSessionMetadata: {},
		terminalRefreshRequests: {},
		sessionCwd: {},
		sessionAgent: {},
		sessionTitle: {},
		sessionActivity: {},
		sessionAgentPin: {},
		restartRequests: {},

		setAgentActivity: (agentId, a) =>
			set((s) =>
				s.agentActivity[agentId] === a
					? s
					: { agentActivity: { ...s.agentActivity, [agentId]: a } },
			),
		beginSessionAgentRuntimeObservation: (sessionId) => {
			const id = crypto.randomUUID();
			set((current) => ({
				sessionAgentRuntimeObservers: {
					...current.sessionAgentRuntimeObservers,
					[sessionId]: {
						...current.sessionAgentRuntimeObservers[sessionId],
						[id]: null,
					},
				},
			}));
			return {
				publish: (state) =>
					set((current) => {
						const observers = current.sessionAgentRuntimeObservers[sessionId];
						// Disposal or session removal revokes this exact writer permanently.
						if (!observers || !(id in observers)) return current;
						const epoch = observers[id];
						if (
							epoch !== null &&
							(epoch !== state.terminalEpoch ||
								epoch !== current.sessionAgentRuntimeState[sessionId]?.terminalEpoch)
						) {
							return current;
						}
						const sessionAgentRuntimeState = projectAgentRuntimeState(
							current,
							sessionId,
							state,
						);
						if (observers[id] === state.terminalEpoch) {
							return sessionAgentRuntimeState ===
								current.sessionAgentRuntimeState
								? current
								: { sessionAgentRuntimeState };
						}
						// Publish the snapshot and its availability atomically, including equal-revision reconnects.
						return {
							sessionAgentRuntimeState,
							sessionAgentRuntimeObservers: {
								...current.sessionAgentRuntimeObservers,
								[sessionId]: { ...observers, [id]: state.terminalEpoch },
							},
						};
					}),
				dispose: () =>
					set((current) => {
						const observers = current.sessionAgentRuntimeObservers[sessionId];
						if (!observers || !(id in observers)) return current;
						const remaining = { ...observers };
						delete remaining[id];
						return {
							sessionAgentRuntimeObservers: {
								...current.sessionAgentRuntimeObservers,
								[sessionId]: remaining,
							},
						};
					}),
			};
		},
		setSessionAgentRuntimeState: (sessionId, state) =>
			set((current) => {
				const sessionAgentRuntimeState = projectAgentRuntimeState(
					current,
					sessionId,
					state,
				);
				return sessionAgentRuntimeState === current.sessionAgentRuntimeState
					? current
					: { sessionAgentRuntimeState };
			}),
		setHmuxSessionMetadata: (session) => setHmuxSessionsMetadata([session]),
		setHmuxSessionsMetadata,
		requestTerminalRefresh: (paneId) =>
			set((current) => ({
				terminalRefreshRequests: {
					...current.terminalRefreshRequests,
					[paneId]: (current.terminalRefreshRequests[paneId] ?? 0) + 1,
				},
			})),
		setSessionCwd: (sessionId, cwd) =>
			set((st) => {
				// Normalize at the write boundary so project grouping's prefix
				// matching never sees a trailing-slash variant of the same path.
				const clean = cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd;
				return st.sessionCwd[sessionId] === clean
					? st
					: { sessionCwd: { ...st.sessionCwd, [sessionId]: clean } };
			}),
		setSessionAgent: (sessionId, kind) =>
			set((st) =>
				st.sessionAgent[sessionId] === kind
					? st
					: { sessionAgent: { ...st.sessionAgent, [sessionId]: kind } },
			),
		setSessionTitle: (sessionId, title) =>
			set((st) => {
				const clean = sanitizeSessionTitle(title);
				return st.sessionTitle[sessionId] === clean
					? st
					: { sessionTitle: { ...st.sessionTitle, [sessionId]: clean } };
			}),
		setSessionActivity: (sessionId, text, observedAt) =>
			set((st) => {
				const t = sanitizeSessionTitle(text).slice(0, 200);
				const previous = st.sessionActivity[sessionId];
				if (observedAt === undefined) {
					if (!t || previous?.text === t) return st;
				} else if (
					!Number.isFinite(observedAt) ||
					observedAt < 0 ||
					(previous?.at !== undefined && observedAt <= previous.at)
				) {
					return st;
				}
				// Replay uses provider time, never the time the UI reattached.
				// A bounded tail may omit the prompt while still proving new activity.
				return {
					sessionActivity: {
						...st.sessionActivity,
						[sessionId]: {
							text: t || previous?.text || "",
							at: observedAt ?? previous?.at,
						},
					},
				};
			}),
		setSessionAgentPin: (sessionId, provider) =>
			set((st) => {
				if (!provider) {
					if (!(sessionId in st.sessionAgentPin)) return st;
					const next = { ...st.sessionAgentPin };
					delete next[sessionId];
					return { sessionAgentPin: next };
				}
				return st.sessionAgentPin[sessionId] === provider
					? st
					: {
							sessionAgentPin: {
								...st.sessionAgentPin,
								[sessionId]: provider,
							},
						};
			}),
		forgetSessionRuntime: (sessionIds) =>
			set((st) => {
				const ids = new Set(sessionIds);
				if (ids.size === 0) return st;
				const withoutSessions = <T>(record: Record<string, T>) =>
					Object.fromEntries(
						Object.entries(record).filter(([id]) => !ids.has(id)),
					);
				return {
					sessionAgentRuntimeObservers: withoutSessions(
						st.sessionAgentRuntimeObservers,
					),
					sessionAgentRuntimeState: withoutSessions(
						st.sessionAgentRuntimeState,
					),
					sessionCwd: withoutSessions(st.sessionCwd),
					sessionAgent: withoutSessions(st.sessionAgent),
					sessionTitle: withoutSessions(st.sessionTitle),
					sessionActivity: withoutSessions(st.sessionActivity),
					sessionAgentPin: withoutSessions(st.sessionAgentPin),
					sshStates: withoutSessions(st.sshStates),
					sshMessages: withoutSessions(st.sshMessages),
				};
			}),
		requestAgentRestart: (agentId) =>
			set((s) => ({
				restartRequests: {
					...s.restartRequests,
					[agentId]: (s.restartRequests[agentId] ?? 0) + 1,
				},
			})),
	};
}
