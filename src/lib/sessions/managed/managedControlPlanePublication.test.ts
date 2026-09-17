// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import type {
	HmuxExactSessionInspectionResult,
	HmuxExactSessionTarget,
	HmuxSessionSummary,
} from "@/lib/ipc";
import { useStore } from "@/store";
import {
	hmuxSessionSummaryFixture,
	managedAgentFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";
import {
	MANAGED_OBSERVATION_SHARE_MS,
	observeManagedControlPlane,
	resetManagedControlPlaneObservationForTest,
} from "./managedControlPlaneObservation";

const mocks = vi.hoisted(() => ({
	inspectSessionsExact: vi.fn(),
	controlPlaneCensus: vi.fn(),
	getAllWebviewWindows: vi.fn(),
	visibilityComplete: true,
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getAllWebviewWindows: mocks.getAllWebviewWindows,
}));
vi.mock("@/lib/ipc", () => ({
	hmux: {
		inspectSessionsExact: mocks.inspectSessionsExact,
		controlPlaneCensus: mocks.controlPlaneCensus,
	},
}));
vi.mock("@/lib/workspace/desktop/desktopVisibilityLease", () => ({
	isDesktopWorkspaceWindowLabel: () => false,
	assessDesktopVisibilityLeases: () => ({
		complete: mocks.visibilityComplete,
		visibleDesktopIds: new Set(["desk-1"]),
	}),
}));

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-05T00:00:00Z"));
	vi.clearAllMocks();
	resetManagedControlPlaneObservationForTest();
	mocks.visibilityComplete = true;
	mocks.getAllWebviewWindows.mockResolvedValue([{ label: "main" }]);
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: "visible",
	});
	useStore.setState({ agents: [], layouts: {}, hmuxSessionMetadata: {} });
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function observedSession() {
	const session = hmuxSessionSummaryFixture({ outputSeq: "0" });
	useStore.setState({
		agents: [
			managedAgentFixture({
				runtimeBinding: managedBindingFixture({
					sessionId: session.sessionId,
					workspaceId: session.workspaceId,
				}),
			}),
		],
	});
	useStore.getState().setHmuxSessionsMetadata([session]);
	return session;
}

function deferredInspection() {
	let resolve!: (sessions: HmuxSessionSummary[]) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<HmuxExactSessionInspectionResult[]>(
		(accept, fail) => {
			resolve = (sessions) =>
				accept(sessions.map((session) => ({ outcome: "found", session })));
			reject = fail;
		},
	);
	return { promise, resolve, reject };
}

describe("managed observation publication", () => {
	it.each([true, false])(
		"keeps the newer observation after an older request finishes (visibilityComplete=%s)",
		async (visibilityComplete) => {
			const session = observedSession();
			const key = hmuxSessionMetadataKey(
				session.workspaceId,
				session.sessionId,
			);
			const olderInspection = deferredInspection();
			const newerInspection = deferredInspection();
			mocks.inspectSessionsExact
				.mockReturnValueOnce(olderInspection.promise)
				.mockReturnValueOnce(newerInspection.promise);
			const options = { maxAgeMs: MANAGED_OBSERVATION_SHARE_MS };
			const older = observeManagedControlPlane(options);
			const newer = observeManagedControlPlane({ maxAgeMs: 0 });
			expect(mocks.inspectSessionsExact).toHaveBeenCalledTimes(2);
			mocks.visibilityComplete = visibilityComplete;
			newerInspection.resolve([{ ...session, outputSeq: "2" }]);
			const latest = await newer;
			const published = useStore.getState().hmuxSessionMetadata;
			expect(published[key].outputSeq).toBe("2");
			expect(latest?.sessions[0].outputSeq).toBe(
				visibilityComplete ? "2" : undefined,
			);

			mocks.visibilityComplete = true;
			olderInspection.resolve([{ ...session, outputSeq: "1" }]);
			expect((await older)?.sessions[0].outputSeq).toBe("1");
			expect.soft(useStore.getState().hmuxSessionMetadata).toBe(published);
			expect.soft(await observeManagedControlPlane(options)).toBe(latest);
			expect(mocks.inspectSessionsExact).toHaveBeenCalledTimes(2);
		},
	);

	it("keeps a superseded result private while the newer observation is pending", async () => {
		const session = observedSession();
		const initialMetadata = useStore.getState().hmuxSessionMetadata;
		const olderInspection = deferredInspection();
		const newerInspection = deferredInspection();
		mocks.inspectSessionsExact
			.mockReturnValueOnce(olderInspection.promise)
			.mockReturnValueOnce(newerInspection.promise);
		const options = { maxAgeMs: MANAGED_OBSERVATION_SHARE_MS };
		const older = observeManagedControlPlane(options);
		const newer = observeManagedControlPlane({ maxAgeMs: 0 });
		olderInspection.resolve([{ ...session, outputSeq: "1" }]);
		expect((await older)?.sessions[0].outputSeq).toBe("1");
		expect.soft(useStore.getState().hmuxSessionMetadata).toBe(initialMetadata);
		const joined = observeManagedControlPlane(options);
		newerInspection.resolve([{ ...session, outputSeq: "2" }]);
		const latest = await newer;
		expect(await joined).toBe(latest);
		expect(mocks.inspectSessionsExact).toHaveBeenCalledTimes(2);
	});

	it("publishes the same cached observation to reentrant metadata subscribers", async () => {
		const session = observedSession();
		mocks.inspectSessionsExact
			.mockResolvedValueOnce([{ outcome: "found", session }])
			.mockResolvedValueOnce([
				{ outcome: "found", session: { ...session, outputSeq: "1" } },
			]);
		const options = { maxAgeMs: MANAGED_OBSERVATION_SHARE_MS };
		await observeManagedControlPlane(options);
		let reentrant: ReturnType<typeof observeManagedControlPlane> | undefined;
		const unsubscribe = useStore.subscribe((state, previous) => {
			if (state.hmuxSessionMetadata !== previous.hmuxSessionMetadata) {
				reentrant = observeManagedControlPlane(options);
			}
		});
		try {
			const latest = await observeManagedControlPlane({ maxAgeMs: 0 });
			expect(reentrant).toBeDefined();
			expect(await reentrant).toBe(latest);
			expect(mocks.inspectSessionsExact).toHaveBeenCalledTimes(2);
		} finally {
			unsubscribe();
		}
	});

	it.each([true, false])(
		"keeps the newer outcome when overlapping inspection fails (newerFails=%s)",
		async (newerFails) => {
			const session = observedSession();
			const key = hmuxSessionMetadataKey(
				session.workspaceId,
				session.sessionId,
			);
			const olderInspection = deferredInspection();
			const newerInspection = deferredInspection();
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			mocks.inspectSessionsExact
				.mockReturnValueOnce(olderInspection.promise)
				.mockReturnValueOnce(newerInspection.promise);
			const options = { maxAgeMs: MANAGED_OBSERVATION_SHARE_MS };
			const older = observeManagedControlPlane(options);
			const newer = observeManagedControlPlane({ maxAgeMs: 0 });
			if (newerFails)
				newerInspection.reject(new Error("newer inspection failed"));
			else newerInspection.resolve([{ ...session, outputSeq: "2" }]);
			const latest = await newer;
			expect(latest?.sessions[0].outputSeq).toBe(newerFails ? undefined : "2");
			const published = useStore.getState().hmuxSessionMetadata;
			expect(published[key].outputSeq).toBe(newerFails ? "0" : "2");

			if (newerFails) olderInspection.resolve([{ ...session, outputSeq: "1" }]);
			else olderInspection.reject(new Error("older inspection failed"));
			expect((await older)?.sessions[0].outputSeq).toBe(
				newerFails ? "1" : undefined,
			);
			expect(useStore.getState().hmuxSessionMetadata).toBe(published);
			expect(await observeManagedControlPlane(options)).toBe(latest);
			expect(mocks.inspectSessionsExact).toHaveBeenCalledTimes(2);
			expect(warning).toHaveBeenCalledOnce();
		},
	);

	it("keeps a reentrant fresh observation in flight after publication finishes", async () => {
		const session = observedSession();
		const nextInspection = deferredInspection();
		mocks.inspectSessionsExact
			.mockResolvedValueOnce([
				{ outcome: "found", session: { ...session, outputSeq: "1" } },
			])
			.mockReturnValueOnce(nextInspection.promise);
		let reentrant: ReturnType<typeof observeManagedControlPlane> | undefined;
		const unsubscribe = useStore.subscribe((state, previous) => {
			if (
				state.hmuxSessionMetadata !== previous.hmuxSessionMetadata &&
				!reentrant
			) {
				reentrant = observeManagedControlPlane({ maxAgeMs: 0 });
			}
		});
		try {
			expect(
				(await observeManagedControlPlane({ maxAgeMs: 0 }))?.sessions[0]
					.outputSeq,
			).toBe("1");
			expect(reentrant).toBeDefined();
			vi.advanceTimersByTime(MANAGED_OBSERVATION_SHARE_MS + 1);
			const joined = observeManagedControlPlane({
				maxAgeMs: MANAGED_OBSERVATION_SHARE_MS,
			});
			nextInspection.resolve([{ ...session, outputSeq: "2" }]);
			const latest = await reentrant;
			expect(latest?.sessions[0].outputSeq).toBe("2");
			expect(await joined).toBe(latest);
			expect(mocks.inspectSessionsExact).toHaveBeenCalledTimes(2);
		} finally {
			unsubscribe();
		}
	});

	it("keeps publication failures unavailable to subsequent shared reads", async () => {
		const session = observedSession();
		const initialMetadata = useStore.getState().hmuxSessionMetadata;
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(
			useStore.getState(),
			"setHmuxSessionsMetadata",
		).mockImplementationOnce(() => {
			throw new Error("publication failed");
		});
		mocks.inspectSessionsExact.mockResolvedValueOnce([
			{ outcome: "found", session: { ...session, outputSeq: "1" } },
		]);
		expect(await observeManagedControlPlane({ maxAgeMs: 0 })).toBeUndefined();
		expect(
			await observeManagedControlPlane({
				maxAgeMs: MANAGED_OBSERVATION_SHARE_MS,
			}),
		).toBeUndefined();
		expect(useStore.getState().hmuxSessionMetadata).toBe(initialMetadata);
		expect(mocks.inspectSessionsExact).toHaveBeenCalledOnce();
		expect(warning).toHaveBeenCalledOnce();
	});

	it.each([
		{ count: 103, visibilityComplete: true },
		{ count: 423, visibilityComplete: true },
		{ count: 103, visibilityComplete: false },
	])(
		"publishes $count sessions atomically (visibilityComplete=$visibilityComplete)",
		async ({ count, visibilityComplete }) => {
			mocks.visibilityComplete = visibilityComplete;
			const sessions = Array.from({ length: count }, (_, index) =>
				hmuxSessionSummaryFixture({
					sessionId: `session-${index}`,
					outputSeq: "1",
				}),
			);
			const retained = hmuxSessionSummaryFixture({
				sessionId: "outside-observation",
			});
			const keyOf = (session: HmuxSessionSummary) =>
				hmuxSessionMetadataKey(session.workspaceId, session.sessionId);
			useStore.setState({
				agents: sessions.map((session) =>
					managedAgentFixture({
						id: `agent-${session.sessionId}`,
						runtimeBinding: managedBindingFixture({
							sessionId: session.sessionId,
							workspaceId: session.workspaceId,
						}),
					}),
				),
			});
			useStore
				.getState()
				.setHmuxSessionsMetadata([
					retained,
					...sessions.map((session) => ({ ...session, outputSeq: "0" })),
				]);
			const retainedMetadata =
				useStore.getState().hmuxSessionMetadata[keyOf(retained)];
			const summaries = new Map(
				sessions.map((session) => [keyOf(session), session]),
			);
			mocks.inspectSessionsExact.mockImplementation(
				async (targets: HmuxExactSessionTarget[]) =>
					targets.map((target) => ({
						outcome: "found",
						session: summaries.get(
							hmuxSessionMetadataKey(target.workspaceId, target.sessionId),
						),
					})),
			);
			const publications: Record<string, HmuxSessionSummary>[] = [];
			const unsubscribe = useStore.subscribe((state, previous) => {
				if (state.hmuxSessionMetadata !== previous.hmuxSessionMetadata) {
					publications.push(state.hmuxSessionMetadata);
				}
			});
			try {
				const options = { maxAgeMs: MANAGED_OBSERVATION_SHARE_MS };
				const [rehost, shell] = await Promise.all([
					observeManagedControlPlane(options),
					observeManagedControlPlane(options),
				]);
				expect(shell).toBe(rehost);
				expect(rehost?.sessions).toEqual(
					visibilityComplete ? sessions : undefined,
				);
				expect(mocks.inspectSessionsExact).toHaveBeenCalledTimes(
					Math.ceil(count / 128),
				);
				expect(mocks.getAllWebviewWindows).toHaveBeenCalledOnce();
				expect(mocks.controlPlaneCensus).not.toHaveBeenCalled();
				expect(publications).toHaveLength(1);
				const metadata = useStore.getState().hmuxSessionMetadata;
				expect(publications[0]).toBe(metadata);
				for (const session of sessions)
					expect(metadata[keyOf(session)]).toMatchObject(session);
				expect(metadata[keyOf(retained)]).toBe(retainedMetadata);

				publications.length = 0;
				vi.advanceTimersByTime(5_000);
				await Promise.all([
					observeManagedControlPlane(options),
					observeManagedControlPlane(options),
				]);
				expect(mocks.inspectSessionsExact).toHaveBeenCalledTimes(
					2 * Math.ceil(count / 128),
				);
				expect(mocks.getAllWebviewWindows).toHaveBeenCalledTimes(2);
				expect(publications).toHaveLength(0);
				expect(useStore.getState().hmuxSessionMetadata).toBe(metadata);
			} finally {
				unsubscribe();
			}
		},
	);
});
