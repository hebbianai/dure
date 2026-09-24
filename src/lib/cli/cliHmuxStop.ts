import type { AgentCanonicalSpawnV1 } from "@/lib/agents/agentCanonicalSpawn";
import { CanonicalAgentLegacyWriterRefusedError } from "@/lib/agents/agentWriterPartition";
import type { CanonicalAgentStopReceiptV1 } from "@/lib/agents/canonicalAgentStopLifecycle";
import {
	applyCanonicalAgentStopPresentationV1,
	executeCanonicalAgentStopV1,
	prepareCanonicalAgentStopV1,
} from "@/lib/agents/canonicalAgentStopRuntime";
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
import type { Agent } from "@/types";

export interface CliHmuxStopRuntime {
	claim: typeof claimCliRequest;
	resolve: typeof resolveCliHmuxStopTarget;
	prepare: typeof prepareManagedAgentStopTarget;
	reconcile: typeof reconcileManagedAgentStop;
	cleanupExited: typeof cleanupExitedManagedAgentRegistration;
	stop: typeof stopManagedAgentProvider;
	finalize: typeof finalizeManagedAgentRemoval;
	canonical?: {
		prepare: typeof prepareCanonicalAgentStopV1;
		execute: typeof executeCanonicalAgentStopV1;
		finalize: typeof applyCanonicalAgentStopPresentationV1;
	};
}

/** Capture presentation separately from the runtime stop authority. */
export function resolveCliHmuxStopTarget(
	name: string,
	targetPanelId?: string,
): { selection: OptionalAgentPaneSelection } & (
	| { target: ManagedAgentStopTarget }
	| { canonical: Agent & { canonicalSpawn: AgentCanonicalSpawnV1 } }
) {
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
	return agent.canonicalSpawn
		? {
				canonical: { ...agent, canonicalSpawn: agent.canonicalSpawn },
				selection,
			}
		: { target: resolveManagedAgentStopTarget(agent), selection };
}

const canonicalRuntime = {
	prepare: prepareCanonicalAgentStopV1,
	execute: executeCanonicalAgentStopV1,
	finalize: applyCanonicalAgentStopPresentationV1,
};

const runtime: CliHmuxStopRuntime = {
	claim: claimCliRequest,
	resolve: resolveCliHmuxStopTarget,
	prepare: prepareManagedAgentStopTarget,
	reconcile: reconcileManagedAgentStop,
	cleanupExited: cleanupExitedManagedAgentRegistration,
	stop: stopManagedAgentProvider,
	finalize: finalizeManagedAgentRemoval,
	canonical: canonicalRuntime,
};

function agentReceipt(selected: ReturnType<typeof resolveCliHmuxStopTarget>) {
	const { selection } = selected;
	if ("canonical" in selected) {
		return {
			id: selected.canonical.id,
			name: selected.canonical.name,
			sessionId: selected.canonical.sessionId,
			...(selection.kind === "agent" ? {} : { panelId: selection.panelId }),
		};
	}
	const { target } = selected;
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
	let dispatchStop: CanonicalAgentStopReceiptV1 | undefined;
	try {
		const name = String(params.name ?? "").trim();
		const targetPanelId =
			String(params.targetPanelId ?? "").trim() || undefined;
		selected = deps.resolve(name, targetPanelId);
		const { selection } = selected;
		if (!(await claim())) return null;
		if ("canonical" in selected) {
			const canonical = deps.canonical ?? canonicalRuntime;
			revalidateAgentPaneSelection(selection);
			const prepared = await canonical.prepare(selected.canonical);
			revalidateAgentPaneSelection(selection);
			dispatchStop = await canonical.execute({
				...prepared,
				client: {
					...prepared.client,
					apply: (receipt, authority) => {
						revalidateAgentPaneSelection(selection);
						if (receipt.workspaceDisposition !== "preserve") {
							throw new Error(
								"An existing stop removes the workspace; resume it through its original cleanup flow",
							);
						}
						return prepared.client.apply(receipt, authority);
					},
				},
			});
			if (!(await canonical.finalize(prepared.provenance, dispatchStop))) {
				throw new Error(
					"Agent presentation changed; retry cleanup for the original Agent",
				);
			}
			return { ok: true, dispatchStop, agent: agentReceipt(selected) };
		}
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
							: selected && "canonical" in selected
								? dispatchStop
									? "agent_dispatch_stop_cleanup_failed"
									: "agent_dispatch_stop_failed"
								: stopped || cleanup
									? "managed_agent_cleanup_failed"
									: "hmux_managed_stop_failed",
				message:
					stopped || dispatchStop
						? `${error instanceof Error ? error.message : String(error)}; provider is stopped and the same command can safely retry registry cleanup`
						: error instanceof Error
							? error.message
							: String(error),
			},
			...(stopped ? { stop: stopped.receipt } : {}),
			...(cleanup ? { cleanup } : {}),
			...(dispatchStop ? { dispatchStop } : {}),
			...(selected ? { agent: agentReceipt(selected) } : {}),
		};
	}
}
