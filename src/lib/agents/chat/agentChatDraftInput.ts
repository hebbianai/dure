import { parseAgentChatInput } from "@/lib/agents/chat/agentChatActionRequests";
import type { PreparedAgentChatDraftTarget } from "./agentChatDraftTypes";

export type { PreparedAgentChatDraftTarget } from "./agentChatDraftTypes";

import { PROVIDERS } from "@/lib/agents/providerCatalog";
import type { DroppedFilePayload } from "@/lib/files/externalFileDrop";
import { isRecord, nonEmptyString } from "@/lib/payloadGuards";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import {
	paneAgentId,
	type PaneOwner,
} from "@/lib/workspace/pane/paneOwnership";
import { useStore } from "@/store";
import type { Agent, Project } from "@/types";

export function agentForChatPane(owner: PaneOwner): Agent | undefined {
	const id = paneAgentId(owner);
	const agent = useStore
		.getState()
		.agents.find((candidate) => candidate.id === id);
	return agent?.interactionProfile?.kind === "structured_protocol"
		? agent
		: undefined;
}

/** Decode the captured recipient when it crosses a window boundary. The
 * values are equality fences; only the current Agent can authorize delivery. */
export function parseAgentChatDraftTarget(
	value: unknown,
): PreparedAgentChatDraftTarget | undefined {
	if (!isRecord(value) || !isRecord(value.identity)) return undefined;
	const identity = value.identity;
	const fields = [
		identity.agentId,
		identity.backendProfileId,
		identity.interactionSessionId,
		value.sessionId,
		value.projectId,
		value.worktreePath,
	];
	if (
		!fields.every(
			(field) =>
				typeof field === "string" && field.length > 0 && field.length <= 4096,
		) ||
		!nonEmptyString(value.provider) ||
		!Object.keys(PROVIDERS).includes(value.provider)
	)
		return undefined;
	const project = value.project;
	if (
		project !== undefined &&
		(!isRecord(project) ||
			(project.kind !== "local" && project.kind !== "ssh") ||
			typeof project.path !== "string" ||
			(project.sshHostId !== undefined &&
				typeof project.sshHostId !== "string"))
	)
		return undefined;
	// Copy the validated values; an asynchronous sender cannot revise this fence.
	return {
		identity: {
			agentId: identity.agentId as string,
			backendProfileId: identity.backendProfileId as string,
			interactionSessionId: identity.interactionSessionId as string,
		},
		sessionId: value.sessionId as string,
		projectId: value.projectId as string,
		provider: value.provider as Agent["provider"],
		worktreePath: value.worktreePath as string,
		project: project
			? {
					kind: project.kind as Project["kind"],
					path: project.path as string,
					sshHostId: project.sshHostId as string | undefined,
				}
			: undefined,
	};
}

export function prepareAgentChatDraftTarget(
	agent: Agent,
): PreparedAgentChatDraftTarget {
	const profile = agent.interactionProfile;
	if (profile?.kind !== "structured_protocol")
		throw new PaneCommandError(
			"pane_changed",
			"The agent is no longer a structured chat.",
		);
	const project = useStore
		.getState()
		.projects.find((candidate) => candidate.id === agent.projectId);
	return {
		identity: {
			agentId: agent.id,
			backendProfileId: profile.backendProfileId,
			interactionSessionId: profile.interactionSessionId,
		},
		sessionId: agent.sessionId,
		projectId: agent.projectId,
		provider: agent.provider,
		worktreePath: agent.worktreePath,
		project: project
			? { kind: project.kind, path: project.path, sshHostId: project.sshHostId }
			: undefined,
	};
}

export function revalidateAgentChatDraftTarget(
	target: PreparedAgentChatDraftTarget,
	pane?: PaneOwner,
): Agent {
	const agent = useStore
		.getState()
		.agents.find((candidate) => candidate.id === target.identity.agentId);
	const profile = agent?.interactionProfile;
	const project = useStore
		.getState()
		.projects.find((candidate) => candidate.id === target.projectId);
	if (
		!agent ||
		(pane !== undefined && paneAgentId(pane) !== agent.id) ||
		profile?.kind !== "structured_protocol" ||
		profile.backendProfileId !== target.identity.backendProfileId ||
		profile.interactionSessionId !== target.identity.interactionSessionId ||
		agent.sessionId !== target.sessionId ||
		agent.projectId !== target.projectId ||
		agent.provider !== target.provider ||
		agent.worktreePath !== target.worktreePath ||
		project?.kind !== target.project?.kind ||
		project?.path !== target.project?.path ||
		project?.sshHostId !== target.project?.sshHostId
	) {
		throw new PaneCommandError(
			"pane_changed",
			"The chat draft recipient changed before delivery.",
		);
	}
	return agent;
}

export function appendAgentChatDraft(
	target: PreparedAgentChatDraftTarget,
	text: string,
	attachments: readonly DroppedFilePayload[] = [],
	pane?: PaneOwner,
): Agent {
	const agent = revalidateAgentChatDraftTarget(target, pane);
	if (attachments.length && target.project?.kind !== "local")
		throw new Error("capture_chat_attachments_unavailable");
	useStore.getState().updateChatDraft(target.identity, (current) => ({
		text: parseAgentChatInput(
			current.text ? `${current.text}\n\n${text}` : text,
		),
		attachments: [
			...current.attachments,
			...attachments.map((file) => ({ ...file })),
		],
	}));
	return agent;
}
