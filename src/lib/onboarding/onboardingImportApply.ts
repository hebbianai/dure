import { buildInitialAgentRegistration, resolveAgentLaunchCredential } from "@/lib/agents/agentLaunchCredential";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { panelsFromLayout, type SerializedPanelRef } from "@/lib/workspace/layout/layoutLifecycle";
import {
	ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT,
	onboardingImportDraftReady,
	onboardingImportDraftReadyWithinLimit,
	type OnboardingImportDesktopDraft,
	type OnboardingImportPaneDraft,
} from "@/lib/onboarding/onboardingImportDraft";
import {
	beginOnboardingImportJournal,
	completeOnboardingImportJournal,
	MAX_RECOVERABLE_ONBOARDING_DESKTOP_PANES,
	readOnboardingImportJournal,
	type OnboardingImportJournalStorage,
	type OnboardingImportReceiptV1,
} from "@/lib/onboarding/onboardingImportJournal";
import { serializeOnboardingImportLayout } from "@/lib/onboarding/onboardingImportLayout";
import { providerSupportsExplicitResume } from "@/lib/agents/providers";
import { useStore } from "@/store";
import type { Agent, Project, Space } from "@/types";

const SAFE_CONVERSATION_ID = /^[A-Za-z0-9._:+-]{1,256}$/;

export interface ApplyOnboardingImportOptions {
	storage?: OnboardingImportJournalStorage;
	/** Test seam and explicit recovery override. Production discovers this from Dockview. */
	reusableDesktopId?: string;
	/** Fault injection after the atomic state commit and before the durable receipt. */
	afterCommit?: () => void;
}

interface PlannedDesktop {
	draft: OnboardingImportDesktopDraft;
	id: string;
	panes: Array<{
		draft: OnboardingImportPaneDraft;
		paneId: string;
		agent: Agent;
	}>;
	layout: unknown;
}

function selectedDesktops(draft: { desktops: readonly OnboardingImportDesktopDraft[] }) {
	return draft.desktops
		.filter((desktop) => desktop.included)
		.map((desktop) => ({
			...desktop,
			panes: desktop.panes.filter((pane) => pane.selected),
		}))
		.filter((desktop) => desktop.panes.length > 0);
}

function projectKey(pane: OnboardingImportPaneDraft): string {
	return `${pane.executionLocation}\0${pane.hostId ?? "local"}\0${
		pane.repositoryCommonDir ?? pane.workspaceRoot
	}`;
}

function onboardingOnly(panes: readonly Pick<SerializedPanelRef, "component">[]): boolean {
	return panes.length <= 1 && panes.every((pane) => pane.component === "onboarding");
}

function discoverReusableDesktopId(): string | undefined {
	const state = useStore.getState();
	const active = state.activeSpaceId;
	const api = getDockview(active);
	if (!api || !onboardingOnly(api.panels.map(dockPanelReference))) return undefined;
	return active;
}

function validateDraftBeforeBoundary(
	draft: { desktops: readonly OnboardingImportDesktopDraft[] },
	desktopPaneLimit = ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT,
): void {
	const ready =
		desktopPaneLimit === ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT
			? onboardingImportDraftReady(draft as never)
			: onboardingImportDraftReadyWithinLimit(draft as never, desktopPaneLimit);
	if (!ready) {
		throw new Error("onboarding import requires at least one selected pane");
	}
	const conversationOwners = new Set<string>();
	for (const desktop of selectedDesktops(draft)) {
		for (const pane of desktop.panes) {
			if (pane.executionLocation === "ssh" && !pane.hostId) {
				throw new Error("remote onboarding import requires a registered SSH host");
			}
			if (
				!SAFE_CONVERSATION_ID.test(pane.conversationId) ||
				!providerSupportsExplicitResume(pane.provider)
			) {
				throw new Error(`provider cannot resume exact conversation: ${pane.provider}`);
			}
			const owner = `${pane.executionLocation}\0${pane.hostId ?? "local"}\0${pane.provider}\0${pane.conversationId}`;
			if (conversationOwners.has(owner)) {
				throw new Error("onboarding import contains a duplicate conversation");
			}
			conversationOwners.add(owner);
		}
	}
}

function sameImportedAgent(left: Agent, right: Agent): boolean {
	return (
		left.id === right.id &&
		left.provider === right.provider &&
		left.projectId === right.projectId &&
		left.worktreePath === right.worktreePath &&
		left.conversationId === right.conversationId &&
		left.runtimeBinding?.runtime === "hmux_managed_v1" &&
		right.runtimeBinding?.runtime === "hmux_managed_v1" &&
		left.runtimeBinding.source === right.runtimeBinding.source &&
		left.runtimeBinding.hostId === right.runtimeBinding.hostId &&
		left.runtimeBinding.sessionId === right.runtimeBinding.sessionId &&
		left.runtimeBinding.workspaceId === right.runtimeBinding.workspaceId
	);
}

function commitPlannedState(planned: readonly PlannedDesktop[]): void {
	const expectedAgents = planned.flatMap((desktop) =>
		desktop.panes.map((pane) => pane.agent),
	);
	const expectedAgentIds = new Set(expectedAgents.map((agent) => agent.id));
	const expectedDesktopIds = new Set(planned.map((desktop) => desktop.id));

	useStore.setState((current) => {
		const existingAgents = current.agents.filter((agent) =>
			expectedAgentIds.has(agent.id),
		);
		const existingDesktops = current.spaces.filter((desktop) =>
			expectedDesktopIds.has(desktop.id),
		);
		if (existingAgents.length === expectedAgents.length) {
			if (
				existingDesktops.length !== planned.length ||
				expectedAgents.some((expected) => {
					const existing = existingAgents.find((agent) => agent.id === expected.id);
					return !existing || !sameImportedAgent(existing, expected);
				})
			) {
				throw new Error("onboarding import recovery identity mismatch");
			}
			return {
				activeSpaceId: planned[0].id,
				uiPrefs: { ...current.uiPrefs, onboardingDismissed: true },
			};
		}
		if (existingAgents.length !== 0) {
			throw new Error("onboarding import found a partial agent commit");
		}

		const first = planned[0];
		const reusable = current.spaces.find((desktop) => desktop.id === first.id);
		if (
			reusable &&
			!onboardingOnly(
				getDockview(reusable.id)?.panels.map(dockPanelReference) ??
					panelsFromLayout(current.layouts[reusable.id]),
			)
		) {
			throw new Error("onboarding desktop changed before import commit");
		}
		if (existingDesktops.some((desktop) => desktop.id !== reusable?.id)) {
			throw new Error("onboarding import found a partial desktop commit");
		}

		const replacements = new Map(
			planned.map((desktop) => [
				desktop.id,
				{ id: desktop.id, name: desktop.draft.name.trim() } satisfies Space,
			]),
		);
		const spaces = current.spaces.map(
			(desktop) => replacements.get(desktop.id) ?? desktop,
		);
		for (const desktop of planned) {
			if (!spaces.some((candidate) => candidate.id === desktop.id)) {
				spaces.push(replacements.get(desktop.id)!);
			}
		}
		const layouts = { ...current.layouts };
		for (const desktop of planned) layouts[desktop.id] = desktop.layout;
		const activity = { ...current.agentActivity };
		for (const agent of expectedAgents) activity[agent.id] = "connecting";
		return {
			spaces,
			activeSpaceId: first.id,
			layouts,
			agents: [...current.agents, ...expectedAgents],
			agentActivity: activity,
			stats: {
				...current.stats,
				agentsStarted: current.stats.agentsStarted + expectedAgents.length,
			},
			uiPrefs: { ...current.uiPrefs, onboardingDismissed: true },
		};
	});
}

function projectCommittedDockviews(planned: readonly PlannedDesktop[]): void {
	// After response loss, the import plan still owns resource identities, but
	// the current store owns any subsequent content, placement or close edits.
	const layouts = useStore.getState().layouts;
	for (const desktop of planned) {
		const api = getDockview(desktop.id);
		const layout = layouts[desktop.id];
		if (!api || layout === undefined) continue;
		api.fromJSON(layout as Parameters<typeof api.fromJSON>[0], {
			reuseExistingPanels: true,
		});
	}
}

export async function applyOnboardingImportDraft(
	draft: { desktops: readonly OnboardingImportDesktopDraft[] },
	options: ApplyOnboardingImportOptions = {},
): Promise<OnboardingImportReceiptV1> {
	const previous = readOnboardingImportJournal(options.storage);
	validateDraftBeforeBoundary(
		previous?.draft ?? draft,
		previous
			? MAX_RECOVERABLE_ONBOARDING_DESKTOP_PANES
			: ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT,
	);
	const journal = beginOnboardingImportJournal(
		draft as never,
		{
			reusableDesktopId:
				options.reusableDesktopId ?? discoverReusableDesktopId(),
		},
		options.storage,
	);
	if (journal.status === "complete") {
		if (!journal.receipt) throw new Error("completed onboarding import has no receipt");
		return journal.receipt;
	}
	const exactDesktops = selectedDesktops(journal.draft);
	if (exactDesktops.length !== journal.desktopIds.length) {
		throw new Error("onboarding import desktop plan changed");
	}
	const projectRequests = new Map<
		string,
		{ path: string; hostId?: string }
	>();
	for (const desktop of exactDesktops) {
		for (const pane of desktop.panes) {
			const key = projectKey(pane);
			if (!projectRequests.has(key)) {
				projectRequests.set(key, {
					path: pane.workspaceRoot,
					...(pane.hostId ? { hostId: pane.hostId } : {}),
				});
			}
		}
	}
	const projects = new Map<string, Project>();
	for (const [key, request] of projectRequests) {
		const project = await useStore
			.getState()
			.ensureProjectForPath(request.path, request.hostId);
		projects.set(key, project);
	}

	const state = useStore.getState();
	let agentIndex = 0;
	const planned: PlannedDesktop[] = exactDesktops.map((desktop, desktopIndex) => {
		const panes = desktop.panes.map((pane) => {
			const project = projects.get(projectKey(pane));
			if (!project) throw new Error("onboarding project receipt is missing");
			const id = journal.agentIds[agentIndex];
			const paneId = journal.paneIds[agentIndex++];
			const credential = resolveAgentLaunchCredential({
				provider: pane.provider,
				requestedAccountId: null,
				activeAccountId: state.activeAccounts[pane.provider],
				accounts: state.accounts,
			});
			const registration = buildInitialAgentRegistration({
				id,
				name: pane.title.trim().slice(0, 64) || pane.provider,
				provider: pane.provider,
				project,
				worktreePath: pane.cwd,
				branch: "",
				credential,
			});
			return {
				draft: pane,
				paneId,
				agent: {
					...registration,
					started: true,
					conversationId: pane.conversationId,
				},
			};
		});
		const id = journal.desktopIds[desktopIndex];
		return {
			draft: desktop,
			id,
			panes,
			layout: serializeOnboardingImportLayout(
				desktop,
				panes.map((pane) => ({ paneKey: pane.draft.key, paneId: pane.paneId, agent: pane.agent })),
			),
		};
	});
	if (agentIndex !== journal.agentIds.length) {
		throw new Error("onboarding import agent plan changed");
	}

	commitPlannedState(planned);
	projectCommittedDockviews(planned);
	options.afterCommit?.();
	const receipt: OnboardingImportReceiptV1 = {
		projectIds: [...new Set([...projects.values()].map((project) => project.id))],
		desktopIds: journal.desktopIds,
		agentIds: journal.agentIds,
		committedAtMs: Date.now(),
	};
	completeOnboardingImportJournal(journal, receipt, options.storage);
	return receipt;
}
