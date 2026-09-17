/**
 * Starting an agent because somebody pressed start on their phone.
 *
 * The decision and its refusals live in [`answerHubStartAgent`]; this hook
 * supplies only the parts that need a running window — the store's view of
 * seats, the dock, and the spawn saga.
 *
 * # Only the main window — and here that is correctness
 *
 * Every window hears the event. For the read round trips, several answers are
 * merely wasteful: the first to arrive settles the trip and the rest are
 * discarded. This one *writes*. Two windows answering means two sagas, two
 * worktrees, and two agents from one press, and the round trip discarding the
 * second reply does not undo the second agent.
 *
 * # Why a ref, not a dependency
 *
 * Spaces and folders change while somebody works. Listing them as effect
 * dependencies would tear down and re-register the listener on each change,
 * and a press that arrived in the gap would go unanswered — which the phone
 * cannot tell apart from an agent that failed to start.
 */

import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef } from "react";
import { visibleProviders } from "@/lib/agents/agentInstalls";
import { loadRepoBranchState } from "@/lib/agents/repoBranchLoad";
import {
	projectLaunchCapabilities,
	seatOfLaunchTarget,
} from "@/lib/hub/launchOffer";
import {
	answerHubStartAgent,
	type HubStartAgentDispatch,
	type StartAgentPlan,
	type StartAgentSeat,
	StartAgentStillRunningError,
} from "@/lib/hub/startAgentBridge";
import { t } from "@/lib/i18n";
import { spawnJournal } from "@/lib/ipc/spawn";
import { hubStartAgentResult } from "@/lib/ipc/system";
import { planWorktree } from "@/lib/scm/worktrees/worktreePlan";
import { spawnFailureMessage } from "@/lib/sessions/launch/spawnFailure";
import {
	artifactIdFromReceipt,
	runSpawnSagaFromCli,
} from "@/lib/sessions/launch/spawnSaga";
import { paneHmuxSessionId } from "@/lib/spaces/hmuxSessionIdentity";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { isMainWindow } from "@/lib/workspace/window/windows";
import { useStore } from "@/store";
import type { Provider } from "@/types";

/** How long to wait for a space to mount before calling it unavailable. */
const REVEAL_DEADLINE_MS = 5_000;
const REVEAL_POLL_MS = 50;

/**
 * How long to watch either the first run or a retry of a saga.
 *
 * Stay under the hub's 20s deadline so the phone receives `still_starting`
 * while the durable run continues and can retry the same press.
 */
const SAGA_WATCH_DEADLINE_MS = 15_000;
const SAGA_WATCH_POLL_MS = 200;

/** A saga that has stopped moving, whichever way it went. */
const TERMINAL_SAGA_STATES = new Set([
	"succeeded",
	"failed",
	"compensated",
	"manual_intervention_required",
]);

/**
 * Bring a space up far enough to receive a pane.
 *
 * The desk keeps only as many spaces mounted as the machine can afford, so the
 * one somebody picked on their phone may have no dock at all. Making it active
 * is what mounts it. Nothing happens when it is already mounted — the desk
 * should not jump to another space just because a pane was added to one that
 * was already there.
 */
async function revealSpace(spaceId: string): Promise<boolean> {
	if (getDockview(spaceId)) return true;
	const store = useStore.getState();
	if (!store.desktops.some((space) => space.id === spaceId)) return false;
	store.setActiveSpace(spaceId);
	const deadline = Date.now() + REVEAL_DEADLINE_MS;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, REVEAL_POLL_MS));
		if (getDockview(spaceId)) return true;
	}
	return false;
}

/**
 * The receipt once it has stopped moving.
 *
 * Wait for the runner before reading, since it may be resuming an old failure.
 * Both waits share the deadline so the phone hears when a run is still going.
 */
async function settledReceipt(receiptId: string, isRunning: () => boolean) {
	const deadline = Date.now() + SAGA_WATCH_DEADLINE_MS;
	while (true) {
		if (!isRunning()) {
			const receipt = await spawnJournal.receipt(receiptId);
			if (TERMINAL_SAGA_STATES.has(receipt.state)) return receipt;
		}
		if (Date.now() >= deadline) throw new StartAgentStillRunningError();
		await new Promise((resolve) => setTimeout(resolve, SAGA_WATCH_POLL_MS));
	}
}

/** Why a typed branch cannot be used, as one sentence about that branch. */
function branchRefusal(
	blocker: NonNullable<ReturnType<typeof planWorktree>["blocker"]>,
	branch: string,
): string {
	switch (blocker.kind) {
		case "branch-in-main-worktree":
			return t("sessions.hubStartAgent.branchInMainWorktree", { branch });
		case "worktree-path-taken":
		case "existing-worktree-requires-explicit-selection":
			return t("sessions.hubStartAgent.branchHasWorktree", { branch });
		default:
			return t("sessions.hubStartAgent.branchUnusable", { branch });
	}
}

/**
 * The worktree plan for a branch somebody typed on their phone.
 *
 * Runs the desk's own planner rather than deriving a path here. The planner is
 * what knows that `agent/refactor-auth` lives in `.worktrees/refactor-auth`,
 * that an existing branch is checked out rather than created, and that a path
 * another worktree already holds is a collision — three facts a second
 * derivation would get subtly wrong, and the disagreement would only show up
 * as a saga that fails on a repository somebody has been working in.
 *
 * Nothing typed means nothing planned: the saga then names the branch after
 * the agent, exactly as it does for the desk's own dialog.
 */
async function worktreePlanFor(
	plan: StartAgentPlan,
): Promise<Record<string, unknown>> {
	if (!plan.useWorktree || !plan.branch) return {};
	const store = useStore.getState();
	const project = store.projects.find((one) => one.id === plan.projectId);
	if (!project) return {};
	const state = await loadRepoBranchState(project, store.sshHosts);
	const planned = planWorktree({
		repoPath: project.path,
		agentName: plan.branch,
		branch: plan.branch,
		mode: state.branches.some((one) => one.name === plan.branch)
			? "existing-branch"
			: "new-branch",
		branches: state.branches,
		worktrees: state.worktrees,
	});
	// The planner knows three outcomes; the saga's request contract accepts two.
	// Passing the third through would be rejected deep inside the saga as
	// `invalid_request`, which reaches the phone as a code nobody can act on —
	// so the reason is said here, where it is still a sentence about a branch.
	if (planned.blocker)
		throw new Error(branchRefusal(planned.blocker, plan.branch));
	if (planned.action === "adopt-worktree") {
		throw new Error(
			t("sessions.hubStartAgent.branchHasWorktree", { branch: planned.branch }),
		);
	}
	return {
		worktreePlan: {
			branch: planned.branch,
			worktreePath: planned.worktreePath,
			action: planned.action,
			...(planned.baseRef ? { baseRef: planned.baseRef } : {}),
			...(planned.worktreeRoot ? { worktreeRoot: planned.worktreeRoot } : {}),
		},
	};
}

async function runStartSaga(
	plan: StartAgentPlan,
): Promise<{ agentId: string }> {
	const created = await spawnJournal.createSaga(
		{
			project: plan.projectId,
			provider: plan.kindId,
			runtime: "hmux",
			useWorktree: plan.useWorktree,
			spaceId: plan.spaceId,
			permissionMode: "default",
			...(await worktreePlanFor(plan)),
		},
		// The phone's name for the press. A retry lands on the same receipt and
		// the resume path finishes the run already in flight; a second press
		// carries a new name and is a second agent, which is what was asked.
		`hub-start:${plan.actionId}`,
	);
	let running = true;
	const run = runSpawnSagaFromCli({ receiptId: created.receiptId }).finally(
		() => {
			running = false;
		},
	);
	// The first run must share the retry's watch deadline. Wait for its return
	// before accepting a terminal receipt: a retry may still be resuming the
	// previous failure. The race observes runner rejections even after timeout.
	const watch = settledReceipt(created.receiptId, () => running);
	const receipt = await Promise.race([run.then(() => watch), watch]);
	if (receipt.state !== "succeeded")
		throw new Error(spawnFailureMessage(receipt));
	const agentId = artifactIdFromReceipt(receipt, "pane", "agent_registration");
	if (!agentId) throw new Error(receipt.state);
	return { agentId };
}

export function useHubStartAgent(): void {
	const desktops = useStore((state) => state.desktops);
	const projects = useStore((state) => state.projects);
	const installedAgents = useStore((state) => state.installedAgents);
	const sshHosts = useStore((state) => state.sshHosts);

	const seats = useMemo(() => {
		const spaces = new Set(desktops.map((space) => space.id));
		const folders = new Map(projects.map((project) => [project.id, project]));
		return (targetId: string): StartAgentSeat | undefined => {
			const seat = seatOfLaunchTarget(targetId);
			if (!seat || !spaces.has(seat.spaceId)) return undefined;
			const project = folders.get(seat.projectId);
			if (!project) return undefined;
			const capabilities = projectLaunchCapabilities(project, sshHosts);
			return {
				...seat,
				startable: capabilities.startable,
				worktreeSupported: capabilities.worktree_supported,
			};
		};
	}, [desktops, projects, sshHosts]);
	const spaces = useMemo(
		() => new Set(desktops.map((space) => space.id)),
		[desktops],
	);

	const current = useRef({ seats, spaces, installedAgents });
	current.current = { seats, spaces, installedAgents };

	useEffect(() => {
		if (!isMainWindow()) return;
		let disposed = false;
		const pending = listen<HubStartAgentDispatch>(
			"hub://start-agent",
			(event) => {
				void answerHubStartAgent(event.payload, {
					seat: (targetId) => current.current.seats(targetId),
					space: (spaceId) => current.current.spaces.has(spaceId),
					folder: async (path) => {
						const project = await useStore
							.getState()
							.ensureProjectForPath(path);
						return {
							projectId: project.id,
							startable: project.kind === "local",
						};
					},
					kindAllowed: (kindId, projectId) => {
						if (!visibleProviders().includes(kindId as Provider)) return false;
						const project = useStore
							.getState()
							.projects.find((one) => one.id === projectId);
						return (
							project?.kind === "ssh" ||
							current.current.installedAgents.includes(kindId as Provider)
						);
					},
					reveal: revealSpace,
					start: runStartSaga,
					session: (agentId) => {
						const agent = useStore
							.getState()
							.agents.find((one) => one.id === agentId);
						return agent
							? paneHmuxSessionId({ kind: "agent" }, agent)
							: undefined;
					},
					report: hubStartAgentResult,
				});
			},
		);
		void pending.then((unlisten) => {
			if (disposed) unlisten();
		});
		return () => {
			disposed = true;
			void pending.then((unlisten) => unlisten());
		};
	}, []);
}
