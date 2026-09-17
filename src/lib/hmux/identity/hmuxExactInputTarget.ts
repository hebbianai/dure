import { sameSshHostOperationalIdentity } from "@/lib/agents/resourceOperationalIdentity";
import {
	type HmuxAgentBinding,
	requireHmuxAgentBinding,
} from "@/lib/hmux/identity/hmuxAgentTarget";
import { sameRemoteManagedBinding } from "@/lib/sessions/managed/remoteManagedBindingEquality";
import { sameHmuxManagedLaunchBinding } from "@/lib/terminal/terminalBinding";
import {
	type AgentPaneSelection,
	resolveAgentPaneSelection,
	resolveNamedAgentPaneSelection,
	revalidateAgentPaneSelection,
} from "@/lib/workspace/pane/agentPaneSelection";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";
import type { Agent, SshHostConfig } from "@/types";

interface HmuxExactInputIdentityV1 {
	schemaVersion: 1;
	targetPanelId: string;
	hostId: string;
	sessionId: string;
	workspaceId: string;
}

export interface HmuxExactInputTarget {
	identity: HmuxExactInputIdentityV1;
	selection: AgentPaneSelection;
	agent: Agent;
	binding: HmuxAgentBinding;
	sshHost: SshHostConfig | undefined;
}

const IDENTITY_KEYS = new Set([
	"schemaVersion",
	"targetPanelId",
	"hostId",
	"sessionId",
	"workspaceId",
]);

function requiredIdentityString(
	identity: Record<string, unknown>,
	key: keyof Omit<HmuxExactInputIdentityV1, "schemaVersion">,
): string {
	const value = identity[key];
	if (typeof value !== "string" || !value || value.length > 256) {
		throw new PaneCommandError("invalid_request", `target.${key} is invalid`);
	}
	return value;
}

function parseHmuxExactInputIdentity(value: unknown): HmuxExactInputIdentityV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new PaneCommandError("invalid_request", "target is required");
	}
	const identity = value as Record<string, unknown>;
	if (
		identity.schemaVersion !== 1 ||
		Object.keys(identity).some((key) => !IDENTITY_KEYS.has(key)) ||
		Object.keys(identity).length !== IDENTITY_KEYS.size
	) {
		throw new PaneCommandError(
			"invalid_request",
			"target must be an exact Hmux pane identity v1",
		);
	}
	return {
		schemaVersion: 1,
		targetPanelId: requiredIdentityString(identity, "targetPanelId"),
		hostId: requiredIdentityString(identity, "hostId"),
		sessionId: requiredIdentityString(identity, "sessionId"),
		workspaceId: requiredIdentityString(identity, "workspaceId"),
	};
}

function captureHmuxInputTarget(
	selection: AgentPaneSelection,
	panelId: string,
	expected?: HmuxExactInputIdentityV1,
): HmuxExactInputTarget {
	const state = useStore.getState();
	const agent = state.agents.find(
		(candidate) => candidate.id === selection.agentId,
	);
	if (!agent) {
		throw new PaneCommandError(
			"pane_not_found",
			`Hmux Agent ${selection.agentId} was not found`,
		);
	}
	let binding: HmuxAgentBinding;
	try {
		binding = requireHmuxAgentBinding(agent);
	} catch (error) {
		if (
			expected &&
			error instanceof PaneCommandError &&
			error.code === "invalid_request"
		) {
			throw new PaneCommandError("pane_changed", error.message);
		}
		throw error;
	}
	if (
		expected &&
		(binding.hostId !== expected.hostId ||
			binding.sessionId !== expected.sessionId ||
			binding.workspaceId !== expected.workspaceId)
	) {
		throw new PaneCommandError(
			"pane_changed",
			"exact Hmux pane identity is stale or mismatched",
		);
	}
	const host =
		binding.source === "ssh"
			? state.sshHosts.find((candidate) => candidate.id === binding.hostId)
			: undefined;
	return {
		identity: {
			schemaVersion: 1,
			targetPanelId: panelId,
			hostId: binding.hostId,
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
		},
		selection,
		agent,
		binding:
			binding.runtime === "hmux_managed_v1"
				? {
						...binding,
						stopFence: binding.stopFence ? { ...binding.stopFence } : undefined,
					}
				: { ...binding },
		sshHost: host
			? {
					...host,
					credential: host.credential ? { ...host.credential } : undefined,
				}
			: undefined,
	};
}

export function resolveHmuxExactInputTarget(
	value: unknown,
): HmuxExactInputTarget {
	const identity = parseHmuxExactInputIdentity(value);
	return captureHmuxInputTarget(
		resolveAgentPaneSelection(identity.targetPanelId),
		identity.targetPanelId,
		identity,
	);
}

/** Named Agent commands address the registry directly, even without a view. */
export function resolveHmuxAgentInputTarget(
	agentId: string,
	panelId?: string,
): HmuxExactInputTarget {
	const selection = resolveNamedAgentPaneSelection(agentId, panelId);
	return captureHmuxInputTarget(selection, panelId ?? `agent:${agentId}`);
}

/** Recheck the prepared recipient after an asynchronous boundary. Display
 * names and advancing conversation projections do not replace a recipient. */
export function revalidateHmuxExactInputTarget(
	expected: HmuxExactInputTarget,
): HmuxExactInputTarget {
	const { selection } = expected;
	revalidateAgentPaneSelection(selection);
	const current = captureHmuxInputTarget(
		selection,
		expected.identity.targetPanelId,
		expected.identity,
	);
	const binding = expected.binding;
	const sameBinding =
		binding.runtime === "hmux_managed_v1"
			? binding.source === "ssh"
				? sameRemoteManagedBinding(current.binding, binding)
				: sameHmuxManagedLaunchBinding(current.binding, binding)
			: current.binding.runtime === binding.runtime &&
				current.binding.source === binding.source &&
				(binding.source !== "ssh" ||
					(current.binding.source === "ssh" &&
						current.binding.commandBridgeNonce === binding.commandBridgeNonce));
	if (
		!sameBinding ||
		(binding.runtime === "hmux_managed_v1" && !binding.stopFence) ||
		(binding.source === "ssh" &&
			!sameSshHostOperationalIdentity(current.sshHost, expected.sshHost))
	) {
		throw new PaneCommandError(
			"pane_changed",
			"prepared Hmux input recipient changed",
		);
	}
	return current;
}
