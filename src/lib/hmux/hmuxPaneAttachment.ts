import {
	type HmuxPaneRetirementPlan,
	hmuxPaneOwnerId,
} from "@/lib/hmux/hmuxPaneRetirement";
import type { HmuxPaneAttachmentStatus } from "@/lib/ipc";

const DEFAULT_ATTACHMENT_ACK_TIMEOUT_MS = 10_000;
const DEFAULT_ATTACHMENT_ACK_POLL_MS = 25;

export interface HmuxPaneAttachmentTarget {
	windowLabel: string;
	desktopId: string;
	panelId: string;
	sessionId: string;
	workspaceId: string;
}

export class HmuxPaneAttachmentTimeoutError extends Error {
	readonly code = "hmux_pane_attachment_timeout";

	constructor(
		target: HmuxPaneRetirementPlan,
		ownerIds: readonly string[] = [target.ownerId],
	) {
		const owners = ownerIds.join(" or ");
		super(
			`native attachment for ${owners} did not acknowledge ` +
				`${target.workspaceId}/${target.sessionId}`,
		);
		this.name = "HmuxPaneAttachmentTimeoutError";
	}
}

export function exactHmuxPaneAttachmentIdentity(
	target: HmuxPaneAttachmentTarget,
): HmuxPaneRetirementPlan {
	return {
		ownerId: hmuxPaneOwnerId(
			target.windowLabel,
			target.desktopId,
			target.panelId,
		),
		sessionId: target.sessionId,
		workspaceId: target.workspaceId,
	};
}

function isExactAttached(
	expected: HmuxPaneRetirementPlan,
	status: HmuxPaneAttachmentStatus,
): boolean {
	return (
		status.state === "attached" &&
		status.ownerId === expected.ownerId &&
		status.sessionId === expected.sessionId &&
		status.workspaceId === expected.workspaceId
	);
}

type AttachmentStatusRead = (
	identity: HmuxPaneRetirementPlan,
) => Promise<HmuxPaneAttachmentStatus>;

interface AttachmentWaitOptions {
	timeoutMs?: number;
	pollMs?: number;
	now?: () => number;
	sleep?: (milliseconds: number) => Promise<void>;
}

async function waitForExactHmuxPaneAttachmentTargets(
	targets: readonly [HmuxPaneRetirementPlan, ...HmuxPaneRetirementPlan[]],
	read: AttachmentStatusRead,
	options: AttachmentWaitOptions,
): Promise<HmuxPaneAttachmentStatus> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_ATTACHMENT_ACK_TIMEOUT_MS;
	const pollMs = options.pollMs ?? DEFAULT_ATTACHMENT_ACK_POLL_MS;
	const now = options.now ?? Date.now;
	const sleep =
		options.sleep ??
		((milliseconds: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
	const deadline = now() + timeoutMs;

	do {
		for (const expected of targets) {
			const status = await read(expected);
			if (
				status.ownerId !== expected.ownerId ||
				status.sessionId !== expected.sessionId ||
				status.workspaceId !== expected.workspaceId
			) {
				throw new Error(
					"native pane attachment status returned the wrong identity",
				);
			}
			if (isExactAttached(expected, status)) return status;
		}
		await sleep(pollMs);
	} while (now() < deadline);

	throw new HmuxPaneAttachmentTimeoutError(
		targets[0],
		targets.map((target) => target.ownerId),
	);
}

export function waitForExactHmuxPaneAttachment(
	target: HmuxPaneAttachmentTarget,
	read: (identity: HmuxPaneRetirementPlan) => Promise<HmuxPaneAttachmentStatus>,
	options: AttachmentWaitOptions = {},
): Promise<HmuxPaneAttachmentStatus> {
	const expected = exactHmuxPaneAttachmentIdentity(target);
	return waitForExactHmuxPaneAttachmentTargets([expected], read, options);
}

/** Wait for the exact pane/session projection in whichever live WebView owns
 * it. Window identity remains part of the native owner; only the claimant's
 * incorrect assumption about that identity is removed. */
export function waitForExactHmuxPaneAttachmentAcrossWindows(
	target: Omit<HmuxPaneAttachmentTarget, "windowLabel">,
	windowLabels: readonly [string, ...string[]],
	read: AttachmentStatusRead,
	options: AttachmentWaitOptions = {},
): Promise<HmuxPaneAttachmentStatus> {
	const [firstLabel, ...remainingLabels] = windowLabels;
	const first = exactHmuxPaneAttachmentIdentity({
		...target,
		windowLabel: firstLabel,
	});
	const rest = [...new Set(remainingLabels)]
		.filter((windowLabel) => windowLabel !== firstLabel)
		.map((windowLabel) =>
			exactHmuxPaneAttachmentIdentity({ ...target, windowLabel }),
		);
	return waitForExactHmuxPaneAttachmentTargets([first, ...rest], read, options);
}
