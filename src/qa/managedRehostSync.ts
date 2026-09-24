import { emit, emitTo } from "@tauri-apps/api/event";
import {
	getCurrentWebviewWindow,
	WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import type { BackgroundThrottlingPolicy } from "@tauri-apps/api/window";
import { webviewStorageOptions } from "@/lib/ipc/core";
import { DURABLE_STORE_REHYDRATED_EVENT } from "@/lib/persistence/durableStoreRehydration";
import { listenWhenReady } from "@/lib/platform/tauriBridge";
import { qaLog } from "@/lib/qa/qaLog";
import { MANAGED_AGENT_REHOSTED_EVENT } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import { startWindowSync } from "@/lib/workspace/window/windows";
import { probeRuntimeMutationAdmission } from "@/qa/agentRuntimeMutationAdmission";
import { probeConversationRegistrationReview } from "@/qa/conversationRegistrationReview";
import {
	managedAgentPaneReferenceCases,
	probeManagedAgentPaneReference,
} from "@/qa/managedAgentPaneReference";
import { probeLateNativeRehostResponse } from "@/qa/managedNativeRehostResponse";
import {
	probeNativeFreshCompletion,
	probeNativeReconciledCompletion,
	probeNativeResumeCompletion,
	probeNativeTransactionCompletion,
	probeNativeUnsupportedResume,
} from "@/qa/managedNativeResumeCompletion";
import { probePaneContextProjection } from "@/qa/paneContextProjection";
import { DURABLE_APP_STORE_NAME, durableAppStorage, useStore } from "@/store";
import {
	managedRehostAgentFixture as agent,
	managedRehostNotificationFixture as notification,
} from "@/test/managedRehostFixtures";

const REPORT_EVENT = "qa:managed-rehost-sync-report";
const RELOAD_EVENT = "qa:managed-rehost-sync-reload";
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

interface Report {
	proof: string;
	window: string;
	realm: string;
	notifications: number;
	rehydrations: number;
	sessionId?: string;
	conversationId?: string;
	storedSessionId?: string;
	pendingCmd?: string;
	skipPermissions?: boolean;
	credentialGeneration?: string | null;
	storedPendingCmd?: string;
	storedSkipPermissions?: boolean;
	storedCredentialGeneration?: string | null;
	draft?: string;
}

async function waitFor(description: string, ready: () => boolean) {
	const deadline = Date.now() + 20_000;
	while (!ready()) {
		if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
		await delay();
	}
}

/** Disposable hidden WebViews exercise native event delivery and shared storage.
 * Agent records are fixtures: this probe never launches or retires a provider. */
export async function runManagedRehostSyncProbe(): Promise<void> {
	const params = new URLSearchParams(location.search);
	const proof = params.get("qaManagedRehostSync");
	if (!import.meta.env.DEV || !proof) return;
	if (params.get("conversationOnly") === "1") {
		const { runManagedConversationContinuationProbe } = await import(
			"./managedConversationContinuation"
		);
		await runManagedConversationContinuationProbe(proof);
		return;
	}
	const isPeer = params.get("peer") === "1";
	const label = getCurrentWebviewWindow().label;
	const realm = crypto.randomUUID();
	const reports = new Map<string, Report>();
	const observations: Array<{ generation: number; reports: Report[] }> = [];
	const paneReferences: Array<
		Awaited<ReturnType<typeof probeManagedAgentPaneReference>>
	> = [];
	const paneContexts: Awaited<ReturnType<typeof probePaneContextProjection>>[] =
		[];
	let resumeCompletion:
		| Awaited<ReturnType<typeof probeNativeResumeCompletion>>
		| undefined;
	let unsupportedResume:
		| Awaited<ReturnType<typeof probeNativeUnsupportedResume>>
		| undefined;
	let mutationAdmission:
		| Awaited<ReturnType<typeof probeRuntimeMutationAdmission>>
		| undefined;
	let reconciliationCompletion:
		| Awaited<ReturnType<typeof probeNativeReconciledCompletion>>
		| undefined;
	const transactionCompletions: Array<
		Awaited<ReturnType<typeof probeNativeTransactionCompletion>>
	> = [];
	let freshCompletion:
		| Awaited<ReturnType<typeof probeNativeFreshCompletion>>
		| undefined;
	let conversationReview:
		| Awaited<ReturnType<typeof probeConversationRegistrationReview>>
		| undefined;
	const stops: Array<() => void> = [];
	let notifications = 0;
	let rehydrations = 0;
	const snapshot = (): Report => {
		const current = useStore.getState().agents[0];
		const stored = JSON.parse(
			localStorage.getItem(DURABLE_APP_STORE_NAME) ?? "null",
		)?.state.agents[0];
		return {
			proof,
			window: label,
			realm,
			notifications,
			rehydrations,
			sessionId: current?.sessionId,
			conversationId: current?.conversationId,
			storedSessionId: stored?.sessionId,
			pendingCmd: current?.pendingCmd,
			skipPermissions: current?.skipPermissions,
			credentialGeneration:
				current?.executionProfile?.kind === "credential_reference"
					? current.executionProfile.credential_generation
					: undefined,
			storedPendingCmd: stored?.pendingCmd,
			storedSkipPermissions: stored?.skipPermissions,
			storedCredentialGeneration:
				stored?.executionProfile?.credential_generation,
			draft: useStore.getState().fileDrafts["local:local:/repo/draft.ts"],
		};
	};
	const report = () => void emit(REPORT_EVENT, snapshot());
	const onRehydrated = () => {
		rehydrations += 1;
		report();
	};
	try {
		stops.push(
			await listenWhenReady<Report>(REPORT_EVENT, ({ payload }) => {
				if (payload.proof === proof) reports.set(payload.window, payload);
			}),
		);
		if (!isPeer) {
			useStore.setState({
				projects: [
					{
						id: "project-1",
						name: "Rehost QA",
						path: "/repo",
						kind: "local",
						isRepo: true,
					},
				],
				agents: [agent(2)],
				layouts: {},
			});
			// Finish initial hydration and exercise the UI fixture before starting
			// native cross-window invalidations that replace the in-memory store.
			await durableAppStorage.flush();
			await useStore.persist.rehydrate();
			for (const scenario of managedAgentPaneReferenceCases) {
				for (const exact of [false, true]) {
					paneReferences.push(
						await probeManagedAgentPaneReference(scenario, exact),
					);
				}
			}
			for (const panelId of ["slot", "agent:previous", "launcher:previous"]) {
				paneContexts.push(await probePaneContextProjection(panelId));
			}
			conversationReview = await probeConversationRegistrationReview();
		}
		useStore.setState({
			fileDrafts: { "local:local:/repo/draft.ts": "unsaved work" },
		});
		await durableAppStorage.flush();
		window.addEventListener(DURABLE_STORE_REHYDRATED_EVENT, onRehydrated);
		stops.push(() =>
			window.removeEventListener(DURABLE_STORE_REHYDRATED_EVENT, onRehydrated),
		);
		stops.push(startWindowSync());
		stops.push(
			await listenWhenReady(MANAGED_AGENT_REHOSTED_EVENT, () => {
				notifications += 1;
				void durableAppStorage.flush().then(report);
			}),
		);
		await waitFor("initial durable read", () => rehydrations > 0);
		if (isPeer) {
			stops.push(
				await listenWhenReady<{ proof: string }>(
					RELOAD_EVENT,
					({ payload }) => {
						if (payload.proof === proof) location.reload();
					},
				),
			);
			report();
			window.addEventListener(
				"pagehide",
				() => {
					for (const stop of stops) stop();
				},
				{ once: true },
			);
			return;
		}

		const peerLabel = `win-rehost-${proof}`;
		new WebviewWindow(peerLabel, {
			...(await webviewStorageOptions()),
			url: `index.html?qaWindowSmokeController=1&qaManagedRehostSync=${proof}&peer=1`,
			visible: false,
			focus: false,
			focusable: false,
			backgroundThrottling: "disabled" as BackgroundThrottlingPolicy,
		});
		await waitFor("peer durable read", () => reports.has(peerLabel));
		const assertCurrent = (
			generation: number,
			conversationId = `conversation-${generation}`,
			expected: Partial<Report> = {},
		) => {
			observations.push({ generation, reports: [...reports.values()] });
			for (const window of [label, peerLabel]) {
				const state = reports.get(window);
				if (
					state?.sessionId !== `session-${generation}` ||
					state.conversationId !== conversationId ||
					state.storedSessionId !== `session-${generation}` ||
					state.draft !== "unsaved work" ||
					Object.entries(expected).some(
						([key, value]) => state[key as keyof Report] !== value,
					)
				) {
					throw new Error(
						`Rehost projection regressed: ${JSON.stringify(state)}`,
					);
				}
			}
		};
		assertCurrent(2);
		for (const [index, generation] of [1, 2, 1, 1].entries()) {
			await emit(MANAGED_AGENT_REHOSTED_EVENT, notification(generation));
			await waitFor("both native notification receivers", () =>
				[label, peerLabel].every(
					(window) => (reports.get(window)?.notifications ?? 0) >= index + 1,
				),
			);
			assertCurrent(2);
		}
		for (const [index, launchKind] of (
			["resume_new_host", "fresh", "exact_resume"] as const
		).entries()) {
			const generation = 4 + index * 2;
			const backendSessionId = await probeLateNativeRehostResponse(
				launchKind,
				generation - 1,
			);
			if (backendSessionId !== `session-${generation}`) {
				throw new Error(
					`Unexpected fixture backend state: ${backendSessionId}`,
				);
			}
			await emit(MANAGED_AGENT_REHOSTED_EVENT, notification(generation));
			await waitFor("both windows after the late backend response", () =>
				[label, peerLabel].every((window) => {
					const state = reports.get(window);
					// Notification delivery can precede the independent durable read.
					return (
						(state?.notifications ?? 0) >= 5 + index &&
						state?.sessionId === `session-${generation}` &&
						state.storedSessionId === `session-${generation}`
					);
				}),
			);
			assertCurrent(
				generation,
				`conversation-${launchKind === "exact_resume" ? generation - 2 : generation}`,
				launchKind === "resume_new_host"
					? {
							pendingCmd: "next explicit launch",
							skipPermissions: true,
							credentialGeneration: "credential-observed-7",
							storedPendingCmd: "next explicit launch",
							storedSkipPermissions: true,
							storedCredentialGeneration: "credential-observed-7",
						}
					: {},
			);
		}
		const beforeCommit = reports.get(peerLabel)?.rehydrations ?? 0;
		useStore.setState({ agents: [agent(9)] });
		await durableAppStorage.flush();
		await waitFor(
			"durable invalidation without rehost notification",
			() =>
				(reports.get(peerLabel)?.rehydrations ?? 0) > beforeCommit &&
				reports.get(peerLabel)?.sessionId === "session-9",
		);
		report();
		await waitFor(
			"source durable commit",
			() => reports.get(label)?.sessionId === "session-9",
		);
		assertCurrent(9);
		const previousRealm = reports.get(peerLabel)?.realm;
		await emitTo(peerLabel, RELOAD_EVENT, { proof });
		await waitFor(
			"new peer WebView realm",
			() => reports.get(peerLabel)?.realm !== previousRealm,
		);
		assertCurrent(9);
		unsupportedResume = await probeNativeUnsupportedResume();
		resumeCompletion = await probeNativeResumeCompletion();
		if (
			resumeCompletion.creates !== 1 ||
			resumeCompletion.unavailableRoutes !== 1 ||
			resumeCompletion.projection !== "applied" ||
			[resumeCompletion.before, resumeCompletion.after].some(
				(snapshot) =>
					snapshot?.sessionId !== "session-10" ||
					snapshot.activity !== "working" ||
					snapshot.outputSeq !== "42",
			)
		)
			throw new Error(
				"Resume completion overwrote a newer runtime observation",
			);
		reconciliationCompletion = await probeNativeReconciledCompletion();
		if (
			reconciliationCompletion.reconciliations !== 1 ||
			reconciliationCompletion.projection !== "applied" ||
			[reconciliationCompletion.before, reconciliationCompletion.after].some(
				(snapshot) =>
					snapshot?.sessionId !== "session-11" ||
					snapshot.activity !== "working" ||
					snapshot.outputSeq !== "42",
			)
		)
			throw new Error(
				"Reconciliation completion overwrote a newer runtime observation",
			);
		for (const replay of [false, true]) {
			transactionCompletions.push(
				await probeNativeTransactionCompletion(replay),
			);
		}
		freshCompletion = await probeNativeFreshCompletion();
		mutationAdmission = await probeRuntimeMutationAdmission();
		if (
			!mutationAdmission.converged ||
			!mutationAdmission.preserved ||
			mutationAdmission.error !== "client_agent_runtime_transition_conflict" ||
			mutationAdmission.requests.length !== 2 ||
			mutationAdmission.requests.some(
				(operation) => operation !== "agent_runtime.projection.inspect",
			) ||
			mutationAdmission.storedPendingCmd !== "newer user work"
		)
			throw new Error("Stale source admitted a new runtime mutation");
		for (const [index, completed] of transactionCompletions.entries()) {
			const replay = index === 1;
			if (
				completed.commits !== 1 ||
				completed.executions !== (replay ? 0 : 1) ||
				completed.lookups !== (replay ? 1 : 0) ||
				completed.replayed !== replay ||
				completed.state !== "completed" ||
				completed.outcome !== "rehosted" ||
				[completed.before, completed.after].some(
					(snapshot) =>
						snapshot?.sessionId !== `session-${replay ? 13 : 12}` ||
						snapshot.activity !== "working" ||
						snapshot.outputSeq !== "42",
				)
			)
				throw new Error(
					"Shared rehost transaction completion overwrote a newer observation",
				);
		}
		if (
			freshCompletion.executions !== 1 ||
			freshCompletion.commits !== 1 ||
			!freshCompletion.completion?.ok ||
			freshCompletion.completion.rehost?.outcome !== "rehosted_fresh" ||
			[freshCompletion.before, freshCompletion.after].some(
				(snapshot) =>
					snapshot?.sessionId !== "session-14" ||
					snapshot.activity !== "working" ||
					snapshot.outputSeq !== "42",
			)
		)
			throw new Error("CLI Fresh completion overwrote a newer observation");
		qaLog("managed-rehost-sync", {
			proof,
			result: "passed",
			paneReferences,
			paneContexts,
			observations,
			resumeCompletion,
			unsupportedResume,
			mutationAdmission,
			reconciliationCompletion,
			transactionCompletions,
			freshCompletion,
			conversationReview,
		});
	} catch (error) {
		qaLog("managed-rehost-sync", {
			proof,
			result: "failed",
			paneReferences,
			paneContexts,
			error: String(error),
			observations,
			resumeCompletion,
			unsupportedResume,
			mutationAdmission,
			reconciliationCompletion,
			transactionCompletions,
			freshCompletion,
			conversationReview,
			reports: [...reports.values()],
		});
	} finally {
		if (!isPeer) for (const stop of stops) stop();
	}
}
