import { exactHmuxPaneAttachmentIdentity } from "@/lib/hmux/hmuxPaneAttachment";
import {
	foundExactHmuxSessions,
	inspectHmuxSessionsExact,
} from "@/lib/hmux/identity/exactHmuxSessionInspection";
import { managedCreateChainStopEffective } from "@/lib/hmux/managed/managedCreateChainStopReceipt";
import {
	planRemoteHmuxCatalogTarget,
	type RemoteHmuxCatalogSessionV1,
} from "@/lib/hmux/remote/remoteHmuxBroker";
import { hmux, remoteHmuxCatalog, remoteHmuxKnownHostTrust } from "@/lib/ipc";
import { applyOnboardingImportDraft } from "@/lib/onboarding/onboardingImportApply";
import { readOnboardingImportJournal } from "@/lib/onboarding/onboardingImportJournal";
import {
	type OnboardingImportDesktopRuntimeReceipt,
	onboardingImportRuntimeSucceeded,
} from "@/lib/onboarding/onboardingImportRuntimeReceipt";
import { qaSshFixture } from "@/lib/qa/qaSshFixture";
import {
	finalizeManagedAgentRemoval,
	resolveManagedAgentStopTarget,
	stopManagedAgentProvider,
} from "@/lib/sessions/managed/managedAgentStop";
import { createSshHostDurably } from "@/lib/ssh/sshCredentialLifecycle";
import { waitForDesktopDockview } from "@/lib/workspace/dock/dockRegistry";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";
import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import { useStore } from "@/store";
import type { Agent } from "@/types";

type QaLogger = (...args: unknown[]) => void;

const delay = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitUntil(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	do {
		if (await predicate()) return true;
		await delay(100);
	} while (Date.now() < deadline);
	return predicate();
}

// 라벨이 아니라 전용 앵커로 찾는다 — 버튼 문구는 선택 개수와 로케일에 따라
// 바뀌므로 문자열 일치는 조용히 깨진다(오케스트레이션 함정 체크리스트).
function setupButton(): HTMLButtonElement | undefined {
	return (
		document.querySelector<HTMLButtonElement>(
			"button[data-onboarding-import-apply]",
		) ?? undefined
	);
}

export async function seedOnboardingSshHostFromQaFlag(
	flag: string,
): Promise<boolean> {
	const host = qaSshFixture(flag, "onboardingssh");
	if (!host) return false;
	const state = useStore.getState();
	if (
		state.sshHosts.some(
			(existing) =>
				existing.host === host.host &&
				existing.port === host.port &&
				existing.user === host.user &&
				existing.keyPath === host.keyPath,
		)
	) {
		return false;
	}
	const registration = await createSshHostDurably({
		name: host.name,
		host: host.host,
		port: host.port,
		user: host.user,
		auth: "key",
		keyPath: host.keyPath,
	});
	return registration.created;
}

async function selectQaCrossHostThreePaneDraft(flag: string): Promise<boolean> {
	if (!flag.includes("onboardingthreepane")) return true;
	const fixture = qaSshFixture(flag, "onboardingssh");
	if (!fixture) return false;
	const host = useStore
		.getState()
		.sshHosts.find(
			(candidate) =>
				candidate.host === fixture.host && candidate.user === fixture.user,
		);
	if (!host) return false;
	// 선택된 pane은 배치 그리드 칸으로, 빠진 pane은 목록 행으로 그려진다. 둘 다
	// 같은 pane 정체 속성을 실으므로 표현이 아니라 정체로 찾는다.
	const paneNodes = () =>
		Array.from(
			document.querySelectorAll<HTMLElement>("[data-import-pane-key]"),
		);
	const paneNode = (paneKey: string) =>
		paneNodes().find((node) => node.dataset.importPaneKey === paneKey);

	// 빠진 세션 목록은 기본으로 접혀 있다 — 펼쳐야 그 안의 pane을 다시 넣을 수 있다.
	const expandLeftOutLists = async (): Promise<boolean> => {
		for (const toggle of Array.from(
			document.querySelectorAll<HTMLButtonElement>(
				"[data-import-overflow-toggle]",
			),
		)) {
			if (toggle.getAttribute("aria-expanded") === "true") continue;
			toggle.click();
			const opened = await waitUntil(
				() => toggle.getAttribute("aria-expanded") === "true",
				1_000,
			);
			if (!opened) return false;
		}
		return true;
	};

	if (!(await expandLeftOutLists())) return false;
	const remote = paneNodes().find((node) => {
		const text = node.textContent ?? "";
		return (
			node.dataset.importLocation === "ssh" &&
			node.dataset.importHostId === host.id &&
			text.includes(fixture.expectedWorkspacePath)
		);
	});
	const desktop = remote?.closest<HTMLElement>("[data-import-desktop-id]");
	if (!remote || !desktop) return false;
	const local = Array.from(
		desktop.querySelectorAll<HTMLElement>("[data-import-pane-key]"),
	)
		.filter((node) => node.dataset.importLocation === "local")
		.slice(0, 2);
	if (local.length !== 2) return false;
	const selectedKeys = new Set(
		[remote, ...local].map((node) => node.dataset.importPaneKey),
	);
	if (selectedKeys.has(undefined) || selectedKeys.size !== 3) return false;

	const allKeys = paneNodes().map((node) => node.dataset.importPaneKey);
	if (allKeys.some((paneKey) => !paneKey)) return false;
	// Toggle handlers replace an immutable draft. Clicking many controls in one
	// browser task makes every handler observe the same stale render and the last
	// click wins. Wait for each React commit before changing the next pane.
	for (const paneKey of allKeys as string[]) {
		const desired = selectedKeys.has(paneKey);
		// 앞선 클릭이 pane을 그리드↔목록으로 옮겼을 수 있으므로 매번 다시 찾는다.
		if (!(await expandLeftOutLists())) return false;
		const node = paneNode(paneKey);
		if (!node) return false;
		if (node.dataset.selected === String(desired)) continue;
		const toggle = node.querySelector<HTMLButtonElement>(
			"[data-import-selected-toggle]",
		);
		if (!toggle || toggle.disabled) return false;
		toggle.click();
		const committed = await waitUntil(
			() => paneNode(paneKey)?.dataset.selected === String(desired),
			1_000,
		);
		if (!committed) return false;
	}
	if (!(await expandLeftOutLists())) return false;
	return paneNodes().every((node) => {
		const paneKey = node.dataset.importPaneKey;
		return Boolean(
			paneKey && node.dataset.selected === String(selectedKeys.has(paneKey)),
		);
	});
}

async function managedSessionsByAgent(
	agents: readonly Agent[],
): Promise<
	Map<
		string,
		RemoteHmuxCatalogSessionV1 | { sessionClass?: string; lifecycle: string }
	>
> {
	const result = new Map<
		string,
		RemoteHmuxCatalogSessionV1 | { sessionClass?: string; lifecycle: string }
	>();
	const local = agents.filter(
		(agent) => agent.runtimeBinding?.source === "local",
	);
	const targets = local.flatMap((agent) => {
		const binding = agent.runtimeBinding;
		return binding?.source === "local" &&
			(binding.runtime === "hmux_managed_v1" ||
				binding.runtime === "hmux_standalone_v1")
			? [
					{
						sessionId: binding.sessionId,
						workspaceId: binding.workspaceId,
					},
				]
			: [];
	});
	for (const session of foundExactHmuxSessions(
		await inspectHmuxSessionsExact(targets),
	)) {
		const agent = local.find((candidate) => {
			const binding = candidate.runtimeBinding;
			return (
				binding?.source === "local" &&
				(binding.runtime === "hmux_managed_v1" ||
					binding.runtime === "hmux_standalone_v1") &&
				binding.sessionId === session.sessionId &&
				binding.workspaceId === session.workspaceId
			);
		});
		if (agent) result.set(agent.id, session);
	}
	const remoteHostIds = new Set(
		agents.flatMap((agent) =>
			agent.runtimeBinding?.runtime === "hmux_managed_v1" &&
			agent.runtimeBinding.source === "ssh"
				? [agent.runtimeBinding.hostId]
				: [],
		),
	);
	for (const hostId of remoteHostIds) {
		const state = useStore.getState();
		const host = state.sshHosts.find((candidate) => candidate.id === hostId);
		if (!host) continue;
		const trust = await remoteHmuxKnownHostTrust(host.id, host.host, host.port);
		const target = planRemoteHmuxCatalogTarget(state.sshHosts, host.id, trust);
		const catalog = await remoteHmuxCatalog(target);
		for (const agent of agents) {
			const binding = agent.runtimeBinding;
			if (
				binding?.runtime !== "hmux_managed_v1" ||
				binding.source !== "ssh" ||
				binding.hostId !== hostId
			) {
				continue;
			}
			const matches = catalog.sessions.filter(
				(session) =>
					session.sessionId === binding.sessionId &&
					session.workspaceId === binding.workspaceId,
			);
			if (matches.length === 1) result.set(agent.id, matches[0]);
		}
	}
	return result;
}

export async function runOnboardingImportProbe(
	log: QaLogger,
	flag = "",
): Promise<void> {
	let journal = readOnboardingImportJournal();
	if (journal?.status !== "complete") {
		const buttonReady = await waitUntil(() => Boolean(setupButton()), 15_000);
		if (!buttonReady) {
			log("onboarding-import", { ok: false, phase: "button_missing" });
			return;
		}
		if (!(await selectQaCrossHostThreePaneDraft(flag))) {
			log("onboarding-import", {
				ok: false,
				phase: "three_pane_selection_failed",
			});
			return;
		}
		const button = setupButton();
		if (!button || button.disabled) {
			log("onboarding-import", { ok: false, phase: "button_disabled" });
			return;
		}
		button.click();
		await waitUntil(
			() => readOnboardingImportJournal()?.status === "complete",
			20_000,
		);
		journal = readOnboardingImportJournal();
	}
	const committed = journal?.status === "complete";
	if (!committed || journal?.status !== "complete" || !journal.receipt) {
		log("onboarding-import", {
			ok: false,
			phase: "apply_not_committed",
			journalStatus: journal?.status ?? "missing",
		});
		return;
	}
	// let journal은 클로저(importedAgents)에서 TS 내로잉이 풀린다 — 가드를
	// 통과한 시점의 값을 const로 고정해 캡처한다.
	const committedJournal = journal;
	await applyOnboardingImportDraft(committedJournal.draft);

	const importedAgents = () =>
		useStore
			.getState()
			.agents.filter((agent) => committedJournal.agentIds.includes(agent.id));
	const desktopRuntime: OnboardingImportDesktopRuntimeReceipt[] = [];
	for (const desktopId of committedJournal.desktopIds) {
		useStore.getState().setActiveSpace(desktopId);
		const api = await waitForDesktopDockview(desktopId, 5_000);
		const expectedPanes = panelsFromLayout(
			useStore.getState().layouts[desktopId],
		).filter((pane) => pane.component === "agent");
		const expectedPanelIds = expectedPanes.map((pane) => pane.id);
		const livePanelIds = api?.panels.map((panel) => panel.id) ?? [];
		const desktopAgentIds = new Set(expectedPanes.map(agentIdFromPane));
		const desktopAgents = importedAgents().filter((agent) =>
			desktopAgentIds.has(agent.id),
		);
		const attached = await waitUntil(async () => {
			if (desktopAgents.length === 0) return false;
			const statuses = await Promise.all(
				desktopAgents.map((agent) => {
					const binding = agent.runtimeBinding;
					if (binding?.runtime !== "hmux_managed_v1") return false;
					const matches =
						api?.panels.filter(
							(pane) =>
								agentIdFromPane({
									id: pane.id,
									component: pane.api.component,
									params: pane.params,
								}) === agent.id,
						) ?? [];
					if (matches.length !== 1) return false;
					const identity = exactHmuxPaneAttachmentIdentity({
						windowLabel: "main",
						desktopId,
						panelId: matches[0].id,
						sessionId: binding.sessionId,
						workspaceId: binding.workspaceId,
					});
					return hmux.paneAttachmentStatus(
						identity.ownerId,
						identity.sessionId,
						identity.workspaceId,
					);
				}),
			);
			return statuses.every(
				(status) => status !== false && status.state === "attached",
			);
		}, 30_000);
		desktopRuntime.push({
			desktopId,
			expectedPanelIds,
			livePanelIds,
			attached,
		});
	}

	const agents = importedAgents();
	const sessionsByAgent = await managedSessionsByAgent(agents);
	const result = agents.map((agent) => {
		const session = sessionsByAgent.get(agent.id);
		return {
			agentId: agent.id,
			provider: agent.provider,
			conversationId: agent.conversationId,
			runtime: agent.runtimeBinding?.runtime,
			started: agent.started,
			sessionClass: session?.sessionClass ?? "missing",
			lifecycle: session?.lifecycle ?? "missing",
			activity: useStore.getState().agentActivity[agent.id] ?? "missing",
		};
	});
	log("onboarding-import", {
		ok: onboardingImportRuntimeSucceeded({
			expectedDesktopIds: committedJournal.desktopIds,
			expectedAgentIds: committedJournal.agentIds,
			desktops: desktopRuntime,
			agents: result,
		}),
		desktopCount: committedJournal.desktopIds.length,
		agentCount: result.length,
		desktopRuntime,
		result,
	});
}

export async function runOnboardingImportCleanup(log: QaLogger): Promise<void> {
	const journal = readOnboardingImportJournal();
	if (!journal) {
		log("onboarding-import-cleanup", {
			ok: true,
			stopped: [],
			missingJournal: true,
		});
		return;
	}
	const state = useStore.getState();
	const importedAgents = state.agents.filter((agent) =>
		journal.agentIds.includes(agent.id),
	);
	const stopped: Array<{
		agentId: string;
		outcome: string;
		sessionId: string;
		workspaceId: string;
	}> = [];
	const errors: Array<{ agentId: string; message: string }> = [];
	for (const agent of importedAgents) {
		try {
			const target = resolveManagedAgentStopTarget(agent.id);
			const stoppedExecution = await stopManagedAgentProvider(target);
			const { receipt } = stoppedExecution;
			await finalizeManagedAgentRemoval(stoppedExecution.target, receipt);
			let stoppedSession: Omit<(typeof stopped)[number], "agentId">;
			if ("chain" in receipt) {
				const effective = managedCreateChainStopEffective(receipt);
				stoppedSession = {
					outcome: receipt.stopReceipt?.outcome ?? "closed_before_completion",
					sessionId: effective.sessionId,
					workspaceId: effective.workspaceId,
				};
			} else {
				stoppedSession = {
					outcome: receipt.outcome,
					sessionId: receipt.sessionId,
					workspaceId: receipt.workspaceId,
				};
			}
			stopped.push({
				agentId: agent.id,
				...stoppedSession,
			});
		} catch (error) {
			errors.push({
				agentId: agent.id,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	log("onboarding-import-cleanup", {
		ok: errors.length === 0,
		stopped,
		errors,
	});
}
