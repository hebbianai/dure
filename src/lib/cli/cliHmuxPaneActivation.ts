import { HmuxPaneAttachmentTimeoutError } from "@/lib/hmux/hmuxPaneAttachment";
import {
	HmuxAttachRequestError,
	hmuxAttachTargetFromRequest,
} from "@/lib/hmux/identity/hmuxAttachRequest";
import type { HmuxPaneAttachmentStatus, HmuxSessionSummary } from "@/lib/ipc";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";

export interface CliHmuxPaneIdentity {
	desktopId: string;
	panelId: string;
	sessionId: string;
	workspaceId: string;
}

interface CliHmuxPaneStatusIdentity {
	ownerId: string;
	sessionId: string;
	workspaceId: string;
}

type AttachmentWait = (
	identity: CliHmuxPaneIdentity,
	windowLabels: readonly [string, ...string[]],
	status: (
		identity: CliHmuxPaneStatusIdentity,
	) => Promise<HmuxPaneAttachmentStatus>,
) => Promise<HmuxPaneAttachmentStatus>;

export interface CliHmuxPaneActivationDependencies {
	windowLabels(): Promise<readonly [string, ...string[]]>;
	waitForAnyExact: AttachmentWait;
	attachmentStatus(
		identity: CliHmuxPaneStatusIdentity,
	): Promise<HmuxPaneAttachmentStatus>;
}

class CliHmuxPaneRequestError extends Error {
	constructor(
		readonly code: "invalid_request" | "pane_not_found",
		message: string,
	) {
		super(message);
		this.name = "CliHmuxPaneRequestError";
	}
}

interface CliHmuxSessionResolutionDependencies<
	Session extends HmuxSessionSummary,
> {
	resolveNamedSession(name: string): Promise<Session | undefined>;
	inspectSession(target: {
		sessionId: string;
		workspaceId: string;
	}): Promise<Session | undefined>;
}

export async function resolveCliStandaloneHmuxSession<
	Session extends HmuxSessionSummary,
>(
	params: Record<string, unknown>,
	dependencies: CliHmuxSessionResolutionDependencies<Session>,
): Promise<Session> {
	const target = hmuxAttachTargetFromRequest(params);
	const discovered =
		target.kind === "name"
			? await dependencies.resolveNamedSession(target.name)
			: await dependencies.inspectSession({
					sessionId: target.sessionId,
					workspaceId: target.workspaceId,
				});
	if (!discovered) {
		throw new CliHmuxPaneRequestError(
			"pane_not_found",
			target.kind === "exact"
				? `Hmux session ${target.sessionId} was not found in workspace ${target.workspaceId}`
				: `Hmux session named ${target.name} was not found`,
		);
	}
	const isStandalone =
		discovered.sessionClass === "standalone" ||
		(discovered.sessionClass === undefined &&
			discovered.sessionId.startsWith("standalone_"));
	if (!isStandalone) {
		throw new CliHmuxPaneRequestError(
			"invalid_request",
			`Hmux session ${discovered.sessionId} is managed and cannot use standalone attach`,
		);
	}
	if (discovered.lifecycle !== "ready") {
		throw new CliHmuxPaneRequestError(
			"invalid_request",
			`Hmux session ${discovered.sessionId} is not running`,
		);
	}
	return discovered;
}

interface CliHmuxPlacementReference {
	panelId: string;
}

type CliHmuxPlacementDirection = "right" | "below";

export async function resolveCliHmuxPlacement<
	Reference extends CliHmuxPlacementReference,
>(
	params: Record<string, unknown>,
	resolveReference: (sessionId: string, panelId?: string) => Promise<Reference>,
) {
	const raw = params.placement as Record<string, unknown> | undefined;
	if (!raw || typeof raw !== "object") return undefined;
	const direction = String(
		raw.direction ?? "below",
	) as CliHmuxPlacementDirection;
	if (direction !== "right" && direction !== "below") {
		throw new CliHmuxPaneRequestError(
			"invalid_request",
			"placement.direction must be right or below",
		);
	}
	const referenceSessionId = String(raw.referenceSessionId ?? "");
	if (!referenceSessionId) {
		throw new CliHmuxPaneRequestError(
			"invalid_request",
			"placement.referenceSessionId is required",
		);
	}
	const resolved = await resolveReference(
		referenceSessionId,
		raw.referencePanelId ? String(raw.referencePanelId) : undefined,
	);
	return {
		...resolved,
		direction,
		position: { referencePanel: resolved.panelId, direction },
	};
}

export async function waitForCliHmuxPaneActivation(
	identity: CliHmuxPaneIdentity,
	dependencies: CliHmuxPaneActivationDependencies,
): Promise<HmuxPaneAttachmentStatus> {
	return dependencies.waitForAnyExact(
		identity,
		await dependencies.windowLabels(),
		dependencies.attachmentStatus,
	);
}

export function cliHmuxPaneActivationErrorCode(
	error: unknown,
): string | undefined {
	return error instanceof HmuxPaneAttachmentTimeoutError ||
		error instanceof HmuxAttachRequestError ||
		error instanceof CliHmuxPaneRequestError
		? error.code
		: undefined;
}

interface StandalonePaneBase extends CliHmuxPaneIdentity {
	cwd?: string;
	referencePanelId?: string;
	direction?: string;
	sessionOwnership?: string;
	paneOwnership?: string;
}

export function projectStandalonePaneReceipt<T extends StandalonePaneBase>(
	pane: T,
	attachment?: HmuxPaneAttachmentStatus,
) {
	return {
		...pane,
		runtime: "hmux_standalone_v1" as const,
		source: "local" as const,
		hostId: "local" as const,
		mode: "controller" as const,
		binding: hmuxStandaloneBinding(pane.sessionId, pane.workspaceId),
		...(attachment ? { attachment } : {}),
	};
}
