import type { HmuxSessionSummary } from "@/lib/ipc";
import type { SessionKindExecutionProfile } from "@/lib/terminal/sessionKindExecutionProfile";
import type { TerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import type { TerminalExecutionLocation } from "@/lib/terminal/terminalExecutionLocation";
import type {
	HmuxPaneHealth,
	HmuxPaneHealthState,
} from "@/lib/terminal/terminalHealth";
import type { Agent, Project, Provider, SshState } from "@/types";

export type PaneInfoSectionKey =
	| "pane"
	| "location"
	| "session"
	| "health"
	| "generation";

export type PaneInfoFieldKey =
	| "title"
	| "paneId"
	| "paneKind"
	| "agentId"
	| "spaceId"
	| "pinned"
	| "project"
	| "projectId"
	| "executionLocation"
	| "workingDirectory"
	| "branch"
	| "runtime"
	| "hostId"
	| "provider"
	| "sessionName"
	| "sessionId"
	| "workspaceId"
	| "conversationId"
	| "sessionClass"
	| "lifecycle"
	| "controlHealth"
	| "paneHealth"
	| "sshState"
	| "diagnostic"
	| "healthReason"
	| "runtimeHost"
	| "hostBuild"
	| "outputSequence"
	| "capabilities"
	| "lastObserved"
	| "terminalEpoch"
	| "receivedSequence"
	| "presentedSequence"
	| "runnerPrincipal"
	| "runnerInstance"
	| "channelEpoch"
	| "hostInstanceId";

type PaneInfoValueKind =
	| "text"
	| "pane-kind"
	| "boolean"
	| "execution-location"
	| "runtime"
	| "provider"
	| "session-class"
	| "lifecycle"
	| "control-health"
	| "pane-health"
	| "ssh-state"
	| "timestamp";

export interface PaneInfoField {
	key: PaneInfoFieldKey;
	value: string;
	valueKind?: PaneInfoValueKind;
}

interface PaneInfoSection {
	key: PaneInfoSectionKey;
	fields: PaneInfoField[];
}

export interface PaneInfoModel {
	title: string;
	sections: PaneInfoSection[];
}

interface PaneInfoAgent
	extends Pick<
		Agent,
		| "id"
		| "provider"
		| "worktreePath"
		| "branch"
		| "sessionId"
		| "sessionKind"
		| "conversationId"
	> {}

interface PaneInfoProject
	extends Pick<Project, "id" | "name" | "path" | "kind"> {}

export interface BuildPaneInfoModelInput {
	paneId: string;
	component: string;
	title: string;
	spaceId?: string;
	pinned: boolean;
	agent?: PaneInfoAgent;
	project?: PaneInfoProject;
	binding?: TerminalPaneBindingV1;
	sessionId?: string;
	cwd?: string;
	executionLocation: TerminalExecutionLocation;
	provider?: Provider | null;
	sessionMetadata?: HmuxSessionSummary | null;
	paneHealth?: HmuxPaneHealth;
	effectivePaneHealth?: HmuxPaneHealthState;
	sshState?: SshState;
}

function field(
	key: PaneInfoFieldKey,
	value: string | number | boolean | null | undefined,
	valueKind?: PaneInfoValueKind,
): PaneInfoField | null {
	if (value === null || value === undefined || value === "") return null;
	return { key, value: String(value), valueKind };
}

function compactFields(fields: Array<PaneInfoField | null>): PaneInfoField[] {
	return fields.filter(
		(candidate): candidate is PaneInfoField => candidate !== null,
	);
}

function paneKind(component: string): string {
	if (component === "fileviewer") return "file";
	if (component === "githubissue") return "github";
	if (
		["agent", "terminal", "ssh", "git", "github", "browser"].includes(component)
	) {
		return component;
	}
	return "other";
}

function bindingConversationId(binding: TerminalPaneBindingV1 | undefined) {
	return binding && "conversationIdentity" in binding
		? binding.conversationIdentity?.conversationId
		: undefined;
}

function bindingStopFence(binding: TerminalPaneBindingV1 | undefined) {
	return binding && "stopFence" in binding ? binding.stopFence : undefined;
}

/** Where Pane Info says the pane runs. An Agent's session kind decides
 *  first (an SSH Agent runs on its host whatever the shell reports), then a
 *  shell nested inside an SSH session, then an SSH pane or SSH-sourced binding
 *  names the best host it knows, and a local shell reports what the terminal
 *  observed. */
export function resolvePaneInfoExecutionLocation(input: {
	agentProfile?: Pick<SessionKindExecutionProfile, "locationOverride">;
	agentSshHostName?: string;
	nestedSsh?: TerminalExecutionLocation;
	component: string;
	binding?: TerminalPaneBindingV1;
	sshHostName?: string;
	paramsHostId?: string;
	observed: TerminalExecutionLocation;
}): TerminalExecutionLocation {
	return (
		input.agentProfile?.locationOverride(input.agentSshHostName) ??
		input.nestedSsh ??
		(input.component === "ssh" || input.binding?.source === "ssh"
			? {
					kind: "ssh",
					target:
						input.agentSshHostName ??
						input.sshHostName ??
						input.binding?.hostId ??
						input.paramsHostId ??
						"ssh",
				}
			: input.observed)
	);
}

/**
 * Builds a read-only, deliberately allowlisted projection for Pane information.
 * Binding secrets and transport-only values (for example commandBridgeNonce)
 * never enter the returned model.
 */
export function buildPaneInfoModel(
	input: BuildPaneInfoModelInput,
): PaneInfoModel {
	const metadata = input.sessionMetadata ?? undefined;
	const stopFence = metadata?.stopFence ?? bindingStopFence(input.binding);
	const sessionId =
		input.binding?.sessionId ?? metadata?.sessionId ?? input.sessionId;
	const workspaceId =
		input.binding && "workspaceId" in input.binding
			? input.binding.workspaceId
			: metadata?.workspaceId;
	// A pane without an hmux binding is a retired pre-migration pane — report
	// the retired legacy runtime by pane family instead of inventing one.
	const runtime =
		input.binding?.runtime ??
		(sessionId
			? input.component === "ssh"
				? "legacy_ssh_session_v1"
				: "legacy_session_v1"
			: undefined);

	const sections: PaneInfoSection[] = [
		{
			key: "pane",
			fields: compactFields([
				field("title", input.title),
				field("paneId", input.paneId),
				field("paneKind", paneKind(input.component), "pane-kind"),
				field("agentId", input.agent?.id),
				field("spaceId", input.spaceId ?? "detached"),
				field("pinned", input.pinned, "boolean"),
			]),
		},
	];

	const locationFields = compactFields([
		field("project", input.project?.name),
		field("projectId", input.project?.id),
		field(
			"executionLocation",
			input.executionLocation.kind === "ssh"
				? input.executionLocation.target
				: input.executionLocation.kind,
			"execution-location",
		),
		field(
			"workingDirectory",
			input.cwd ?? input.agent?.worktreePath ?? input.project?.path,
		),
		field("branch", input.agent?.branch),
	]);
	if (locationFields.length > 0) {
		sections.push({ key: "location", fields: locationFields });
	}

	const sessionFields = compactFields([
		field("runtime", runtime, "runtime"),
		field("hostId", input.binding?.hostId),
		field("provider", input.agent?.provider ?? input.provider, "provider"),
		field("sessionName", metadata?.sessionName),
		field("sessionId", sessionId),
		field("workspaceId", workspaceId),
		field(
			"conversationId",
			input.agent?.conversationId ?? bindingConversationId(input.binding),
		),
		field("sessionClass", metadata?.sessionClass, "session-class"),
		field("lifecycle", metadata?.lifecycle, "lifecycle"),
	]);
	if (sessionFields.length > 0) {
		sections.push({ key: "session", fields: sessionFields });
	}

	const healthFields = compactFields([
		field("controlHealth", metadata?.health, "control-health"),
		field(
			"paneHealth",
			input.effectivePaneHealth ?? input.paneHealth?.state,
			"pane-health",
		),
		field("sshState", input.sshState, "ssh-state"),
		field(
			"diagnostic",
			metadata?.diagnostic
				? `${metadata.diagnostic.code} · ${metadata.diagnostic.message} · ${metadata.diagnostic.retry}`
				: undefined,
		),
		field("healthReason", input.paneHealth?.reason),
		field("runtimeHost", metadata?.runtimeHost),
		field("hostBuild", metadata?.hostBuildVersion),
		field("outputSequence", metadata?.outputSeq),
		field("capabilities", metadata?.capabilities.join(" · ")),
		field("lastObserved", input.paneHealth?.updatedAt, "timestamp"),
	]);
	if (healthFields.length > 0) {
		sections.push({ key: "health", fields: healthFields });
	}

	const generationFields = compactFields([
		field(
			"terminalEpoch",
			metadata?.terminalEpoch ??
				input.paneHealth?.terminalEpoch ??
				stopFence?.terminalEpoch,
		),
		field("receivedSequence", input.paneHealth?.receivedSequence),
		field("presentedSequence", input.paneHealth?.presentedSequence),
		field("runnerPrincipal", stopFence?.runnerPrincipal),
		field("runnerInstance", stopFence?.runnerInstance),
		field("channelEpoch", stopFence?.channelEpoch),
		field("hostInstanceId", stopFence?.hostInstanceId),
	]);
	if (generationFields.length > 0) {
		sections.push({ key: "generation", fields: generationFields });
	}

	return { title: input.title, sections };
}
