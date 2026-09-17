import { CanonicalAgentLegacyWriterRefusedError } from "@/lib/agents/agentWriterPartition";
import { claimCliRequest } from "@/lib/cli/cliRequestBroker";
import { resolveAgentByName } from "@/lib/hmux/identity/hmuxAgentTarget";
import { cleanupExitedManagedAgentRegistration } from "@/lib/sessions/cleanup/exitedManagedAgentCleanupRuntime";
import {
	finalizeManagedAgentRemoval,
	type ManagedAgentStopTarget,
	prepareManagedAgentStopTarget,
	reconcileManagedAgentStop,
	resolveManagedAgentStopTarget,
	stopManagedAgentProvider,
} from "@/lib/sessions/managed/managedAgentStop";
import { resolveLegacyAgentPaneTarget } from "@/lib/sessions/managed/managedAgentTarget";
import {
	type OptionalAgentPaneSelection,
	resolveOptionalAgentPaneSelection,
	revalidateAgentPaneSelection,
} from "@/lib/workspace/pane/agentPaneSelection";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";

export interface CliHmuxStopRuntime {
	claim: typeof claimCliRequest;
	resolve: typeof resolveCliHmuxStopTarget;
	prepare: typeof prepareManagedAgentStopTarget;
	reconcile: typeof reconcileManagedAgentStop;
	cleanupExited: typeof cleanupExitedManagedAgentRegistration;
	stop: typeof stopManagedAgentProvider;
	finalize: typeof finalizeManagedAgentRemoval;
}

/** Capture presentation separately from the runtime stop authority. */
export function resolveCliHmuxStopTarget(
	name: string,
	targetPanelId?: string,
): { target: ManagedAgentStopTarget; selection: OptionalAgentPaneSelection } {
	const agent = resolveAgentByName(name);
	const selection: OptionalAgentPaneSelection = targetPanelId
		? resolveOptionalAgentPaneSelection(targetPanelId)
		: { kind: "agent", agentId: agent.id };
	if (selection.kind !== "absent" && selection.agentId !== agent.id) {
		throw new PaneCommandError(
			"pane_changed",
			"selected pane references a different Agent",
		);
	}
	return { target: resolveManagedAgentStopTarget(agent), selection };
}

const runtime: CliHmuxStopRuntime = {
	claim: claimCliRequest,
	resolve: resolveCliHmuxStopTarget,
	prepare: prepareManagedAgentStopTarget,
	reconcile: reconcileManagedAgentStop,
	cleanupExited: cleanupExitedManagedAgentRegistration,
	stop: stopManagedAgentProvider,
	finalize: finalizeManagedAgentRemoval,
};

function agentReceipt({
	target,
	selection,
}: ReturnType<typeof resolveCliHmuxStopTarget>) {
	return {
		id: target.agent.id,
		name: target.agent.name,
		sessionId: target.binding.sessionId,
		workspaceId: target.binding.workspaceId,
		panelId:
			selection.kind === "agent"
				? resolveLegacyAgentPaneTarget(target.agent).panelId
				: selection.panelId,
	};
}

export async function handleCliHmuxStop(
	params: Record<string, unknown>,
	reqId: string,
	deps: CliHmuxStopRuntime = runtime,
) {
	let claimed = false;
	const claim = async () => {
		if (claimed) return true;
		claimed = await deps.claim(reqId);
		return claimed;
	};
	let selected: ReturnType<typeof resolveCliHmuxStopTarget> | undefined;
	let stopped: Awaited<ReturnType<typeof stopManagedAgentProvider>> | undefined;
	let cleanup: Awaited<
		ReturnType<typeof cleanupExitedManagedAgentRegistration>
	>;
	try {
		const name = String(params.name ?? "").trim();
		const targetPanelId =
			String(params.targetPanelId ?? "").trim() || undefined;
		selected = deps.resolve(name, targetPanelId);
		const { selection } = selected;
		if (!(await claim())) return null;
		const target = await deps.prepare(selected.target);
		selected = { target, selection };

		stopped = await deps.reconcile(target);
		if (!stopped) {
			cleanup = await deps.cleanupExited(target.agent);
			if (cleanup) {
				if (
					cleanup.outcome !== "cleaned" &&
					cleanup.reason !== "already_removed"
				) {
					throw new Error(
						cleanup.message ??
							`exited managed agent cleanup refused: ${cleanup.reason ?? "unknown"}`,
					);
				}
				return { ok: true, cleanup, agent: agentReceipt(selected) };
			}
			revalidateAgentPaneSelection(selection);
			stopped = await deps.stop(target);
		}
		await deps.finalize(stopped.target, stopped.receipt);
		return { ok: true, stop: stopped.receipt, agent: agentReceipt(selected) };
	} catch (error) {
		if (!(await claim())) return null;
		return {
			ok: false,
			error: {
				code:
					error instanceof CanonicalAgentLegacyWriterRefusedError
						? error.code
						: error instanceof PaneCommandError
							? error.code
							: stopped || cleanup
								? "managed_agent_cleanup_failed"
								: "hmux_managed_stop_failed",
				message: stopped
					? `${error instanceof Error ? error.message : String(error)}; provider is stopped and the same command can safely retry registry cleanup`
					: error instanceof Error
						? error.message
						: String(error),
			},
			...(stopped ? { stop: stopped.receipt } : {}),
			...(cleanup ? { cleanup } : {}),
			...(selected ? { agent: agentReceipt(selected) } : {}),
		};
	}
}
