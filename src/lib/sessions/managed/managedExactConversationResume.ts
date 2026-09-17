import { effectiveAgentSkipPermissions } from "@/lib/agents/agentPermissionMode";
import {
	assertNeverManagedCreateAdvanceResolution,
	ManagedCreateRejectedError,
	ManagedCreateRetrySameError,
} from "@/lib/hmux/managed/managedCreateResolution";
import { type HmuxExactManagedCreateReceipt, hmux } from "@/lib/ipc";
import { publishManagedAgentRehostProjection } from "@/lib/sessions/managed/managedAgentRehostPublication";
import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import {
	commitManagedAgentRehostReceipt,
	type ManagedAgentRehostCommitReceipt,
} from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { MANAGED_BOOTSTRAP_GEOMETRY } from "@/lib/sessions/managed/managedAgentRuntime";
import { shortManagedRuntimeDigest } from "@/lib/sessions/managed/managedAgentRuntimeState";
import { managedProviderCommand } from "@/lib/sessions/managed/managedProviderCommand";
import {
	type HmuxManagedPaneBindingV1,
	hmuxManagedBinding,
} from "@/lib/terminal/terminalBinding";
import { currentTerminalDefaultColors } from "@/lib/theme/themePreference";
import { useStore } from "@/store";
import type { AccountProfile, Agent } from "@/types";

const inFlight = new Map<string, Promise<ManagedAgentRehostCommitReceipt>>();

interface ExactResumeLaunchSelection {
	credentialId?: string;
	credentialDirectory?: string;
}

function exactResumeLaunchSelection(
	agent: Agent,
	binding: HmuxManagedPaneBindingV1,
	accounts: readonly AccountProfile[],
): ExactResumeLaunchSelection {
	const pending = agent.pendingCredentialSwitch;
	const credentialId = pending
		? pending.targetCredentialId
		: (binding.credentialId ?? agent.credentialId);
	if (!credentialId) return {};
	const account = accounts.find(
		(candidate) =>
			candidate.id === credentialId && candidate.provider === agent.provider,
	);
	// A stale non-secret reference is replaceable bookkeeping, not launch
	// authority. Provider default is the only safe fallback: never trust a
	// persisted path after its account registry entry disappeared.
	if (!account) return {};
	return {
		credentialId,
		credentialDirectory: account.dir,
	};
}

function exactResumeInFlightKey(
	agent: Agent,
	binding: HmuxManagedPaneBindingV1,
	conversationId: string,
	credentialId: string | undefined,
): string {
	const fence = binding.stopFence;
	const seed = [
		"managed-exact-resume-v1",
		agent.id,
		binding.workspaceId,
		binding.sessionId,
		binding.createIdempotencyKey,
		fence?.runnerPrincipal,
		fence?.runnerInstance,
		fence?.channelEpoch,
		fence?.hostInstanceId,
		fence?.terminalEpoch,
		conversationId,
		credentialId,
		agent.worktreePath,
	].join("\0");
	const suffix =
		shortManagedRuntimeDigest(seed) +
		shortManagedRuntimeDigest(`managed-exact-resume-target\0${seed}`);
	return `managed_resume_${suffix}`;
}

function exactCreateReceipt(
	resolution: Awaited<ReturnType<typeof hmux.advanceManagedCreate>>,
): HmuxExactManagedCreateReceipt {
	switch (resolution.state) {
		case "current":
		case "advanced":
			return resolution.receipt;
		case "retry_same":
			throw new ManagedCreateRetrySameError(
				resolution.reason,
				resolution.code,
				resolution.message,
			);
		case "rejected":
			throw new ManagedCreateRejectedError(resolution.code, resolution.message);
		default:
			return assertNeverManagedCreateAdvanceResolution(resolution);
	}
}

async function launchExactResume(
	request: Parameters<typeof hmux.advanceManagedCreate>[0],
	diagnostics?: Parameters<typeof hmux.advanceManagedCreate>[1],
): Promise<HmuxExactManagedCreateReceipt> {
	diagnostics?.timing?.mark("launch.ready");
	let resolution = await hmux.advanceManagedCreate(request, diagnostics);
	if (resolution.state === "retry_same") {
		// The broker explicitly promises that replaying this exact source identity
		// is safe. One in-action replay absorbs response-loss/pending boundaries
		// without ever inventing another target.
		resolution = await hmux.advanceManagedCreate(request, diagnostics);
	}
	return exactCreateReceipt(resolution);
}

function exactResumePayload(input: {
	agent: Agent;
	binding: HmuxManagedPaneBindingV1;
	panelId: string;
	conversationId: string;
	permissionMode: "default" | "bypass_approvals";
	credentialId?: string;
	receipt: HmuxExactManagedCreateReceipt;
	operationId: string;
	desktopId: string;
}): ManagedAgentRehostSyncPayload {
	return {
		schemaVersion: 2,
		operationId: input.operationId,
		launchKind: "resume_new_host",
		agentId: input.agent.id,
		agentName: input.agent.displayName?.trim() || input.agent.name,
		projectId: input.agent.projectId,
		providerId: input.agent.provider,
		sourceBinding: { ...input.binding },
		sourceConversationId: input.agent.conversationId?.trim() ?? null,
		sourcePaneState: "present",
		cwd: input.agent.worktreePath,
		conversationId: input.conversationId,
		permissionMode: input.permissionMode,
		desktopId: input.desktopId,
		panelId: input.panelId,
		binding: {
			...hmuxManagedBinding(
				input.receipt.session.sessionId,
				input.receipt.session.workspaceId,
				input.credentialId,
				undefined,
				input.receipt.session.stopFence,
				input.binding.backendProfileId,
			),
			createIdempotencyKey: input.receipt.idempotencyKey,
		},
		targetCredentialId: input.credentialId ?? null,
	};
}

/** Start a new current-runtime Host for one exact provider conversation.
 * Historical Host state is absent from launch admission. Adapter capability
 * reads precede the idempotent managed create without inspecting that Host. */
export async function resumeExactManagedAgentPane(
	agentId: string,
	panelId: string,
	conversationId: string,
	diagnostics?: Parameters<typeof hmux.advanceManagedCreate>[1],
): Promise<ManagedAgentRehostCommitReceipt> {
	diagnostics?.timing?.mark("resume.prepare");
	const exactConversationId = conversationId.trim();
	const state = useStore.getState();
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	const binding = agent?.runtimeBinding;
	if (
		!exactConversationId ||
		!agent ||
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "local"
	) {
		throw new Error("managed exact resume launch target is unavailable");
	}
	const launch = exactResumeLaunchSelection(agent, binding, state.accounts);
	const inFlightKey = exactResumeInFlightKey(
		agent,
		binding,
		exactConversationId,
		launch.credentialId,
	);
	const existing = inFlight.get(inFlightKey);
	if (existing) {
		diagnostics?.timing?.mark("resume.join");
		return existing;
	}
	// Pre-field local bindings used sessionId as their create key; the binding
	// parser preserves that compatibility normalization.
	const sourceCreateIdempotencyKey =
		binding.createIdempotencyKey?.trim() || binding.sessionId;

	const operation = (async () => {
		const bypassApprovals = effectiveAgentSkipPermissions(
			agent,
			state.skipPermissions,
		);
		const exactAgent = {
			...agent,
			// An earlier launch command must never replace this explicit resume.
			pendingCmd: undefined,
			conversationId: exactConversationId,
			conversationIdentity: undefined,
		};
		const receipt = await launchExactResume(
			{
				replaceCurrent: true,
				idempotencyKey: sourceCreateIdempotencyKey,
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
				providerId: agent.provider,
				conversationId: exactConversationId,
				permissionMode: bypassApprovals ? "bypass_approvals" : "default",
				...launch,
				cwd: agent.worktreePath,
				command: managedProviderCommand(exactAgent, undefined, bypassApprovals),
				columns: MANAGED_BOOTSTRAP_GEOMETRY.columns,
				rows: MANAGED_BOOTSTRAP_GEOMETRY.rows,
				terminalEnv: agent.terminalEnv,
				terminalDefaultColors: currentTerminalDefaultColors(),
			},
			diagnostics,
		);
		diagnostics?.timing?.mark("projection.start");
		const payload = exactResumePayload({
			agent,
			binding,
			panelId,
			conversationId: exactConversationId,
			permissionMode: bypassApprovals ? "bypass_approvals" : "default",
			credentialId: receipt.credentialId,
			receipt,
			operationId: receipt.idempotencyKey,
			desktopId: state.activeSpaceId,
		});
		try {
			// Seed Ready before Agent projection starts observers or awaits a pane.
			// Completion must not overwrite a newer Hmux observation.
			useStore.getState().setHmuxSessionMetadata(receipt.session);
		} catch {
			// A later Hmux census can rebuild this local projection.
		}
		// Ready is the Resume commit point. Frontend projection and event fan-out
		// are replaceable views of that fact, so neither may turn a running Host
		// back into a failed user action.
		const committed =
			(await commitManagedAgentRehostReceipt(payload).catch(() => null)) ??
			({
				projection: "pending",
				presentation: "pending",
				pane: null,
				payload,
			} satisfies ManagedAgentRehostCommitReceipt);
		diagnostics?.timing?.mark("projection.ready");
		publishManagedAgentRehostProjection(committed.payload);
		diagnostics?.timing?.mark("resume.publish");
		return committed;
	})();
	inFlight.set(inFlightKey, operation);
	try {
		return await operation;
	} finally {
		if (inFlight.get(inFlightKey) === operation) {
			inFlight.delete(inFlightKey);
		}
	}
}
