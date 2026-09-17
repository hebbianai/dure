import type {
	PaneActionDefinition,
	PaneActionExecution,
	PaneActionHandler,
	PaneActionRefusal,
} from "./paneAction";

/** One shared registry of live pane actions. A mounted pane surface registers
 * its current status plus the exact handlers its UI buttons call; UI clicks,
 * the CLI, and the authenticated local HTTP surface all invoke the same
 * handler through here (one authority, three transports). Entries live only
 * while the pane presentation is mounted in this window. */

/** Closed union: it is what `dure client pane state` prints, so a new value
 * is a contract change. Terminal-family panes report attach state; structured
 * chat panes report the turn lifecycle. */
type TerminalPaneStatus = "attached" | "attach_failed";
export type ChatPaneStatus =
	| "idle"
	| "turn_active"
	| "connecting"
	| "detached"
	| "error";
type PaneActionStatus = TerminalPaneStatus | ChatPaneStatus;

export interface PaneActionSnapshot {
	readonly paneId: string;
	readonly status: PaneActionStatus;
	readonly error?: string;
	/** Identity text the copy-details button assembles (agent/pane/session). */
	readonly context?: string;
	readonly actions: readonly string[];
	readonly actionDefinitions?: Readonly<Record<string, PaneActionDefinition>>;
}

export type PaneActionResult =
	| {
			readonly ok: true;
			readonly paneId: string;
			readonly action: string;
			readonly result?: PaneActionExecution;
	  }
	| { readonly ok: false; readonly error: PaneActionRefusal };

interface PaneActionContribution {
	readonly paneId: string;
	readonly actions: Readonly<Record<string, PaneActionHandler>>;
	/** Ephemeral action lifetime; never replaces the surface's runtime status. */
	readonly pendingAction?: string;
}

export type PaneActionEntry = PaneActionContribution &
	(
		| {
				readonly status: PaneActionStatus;
				readonly error?: string;
				readonly context?: string;
		  }
		| {
				readonly status?: never;
				readonly error?: never;
				readonly context?: never;
		  }
	);

export type OwnedPaneActionEntry = PaneActionEntry & {
	/** A mounted recipient occurrence, not a callback or runtime capability. */
	readonly owner: object;
};

const entries = new Map<string, OwnedPaneActionEntry[]>();
const progressListeners = new Set<() => void>();

export function subscribePaneActionProgress(listener: () => void): () => void {
	progressListeners.add(listener);
	return () => {
		progressListeners.delete(listener);
	};
}

export function paneActionPending(paneId: string, action: string): boolean {
	return (
		entries.get(paneId)?.some((entry) => entry.pendingAction === action) ??
		false
	);
}

/** The action owns this contribution until its promise settles, even if its
 * menu or body remounts. Readers only project it; they never restart a session. */
export function beginPaneActionProgress(
	paneId: string,
	action: string,
): () => void {
	return registerPaneActions({
		paneId,
		actions: {},
		pendingAction: action,
		owner: {},
	});
}

export function registerPaneActions(entry: OwnedPaneActionEntry): () => void {
	const list = entries.get(entry.paneId) ?? [];
	entries.set(entry.paneId, [entry, ...list]);
	if (entry.pendingAction) for (const listener of progressListeners) listener();
	return () => {
		const current = entries.get(entry.paneId);
		if (!current) return;
		const remaining = current.filter((candidate) => candidate !== entry);
		if (remaining.length === 0) entries.delete(entry.paneId);
		else entries.set(entry.paneId, remaining);
		if (entry.pendingAction)
			for (const listener of progressListeners) listener();
	};
}

/** Status comes from the failing surface first, then the newest healthy one.
 * Named actions compose across mounted surfaces without becoming status. */
type PaneStatusEntry = OwnedPaneActionEntry & {
	readonly status: PaneActionStatus;
};

function selectedEntry(paneId: string): PaneStatusEntry | undefined {
	const list = entries.get(paneId);
	if (!list || list.length === 0) return undefined;
	return (
		list.find(
			(entry): entry is PaneStatusEntry =>
				entry.status !== undefined && entry.error !== undefined,
		) ??
		list.find((entry): entry is PaneStatusEntry => entry.status !== undefined)
	);
}

function orderedEntries(paneId: string): readonly OwnedPaneActionEntry[] {
	const list = entries.get(paneId) ?? [];
	const selected = selectedEntry(paneId);
	return selected
		? [selected, ...list.filter((entry) => entry !== selected)]
		: list;
}

function actionNames(list: readonly PaneActionEntry[]): string[] {
	return [...new Set(list.flatMap((entry) => Object.keys(entry.actions)))];
}

export function paneActionSnapshot(
	paneId: string,
): PaneActionSnapshot | undefined {
	const entry = selectedEntry(paneId);
	if (!entry) return undefined;
	const ordered = orderedEntries(paneId);
	const actions = actionNames(ordered);
	const definitions = Object.fromEntries(
		actions.flatMap((action) => {
			const definition = ordered.find((candidate) => candidate.actions[action])
				?.actions[action].definition;
			return definition ? [[action, definition]] : [];
		}),
	);
	return {
		paneId: entry.paneId,
		status: entry.status,
		...(entry.error !== undefined ? { error: entry.error } : {}),
		...(entry.context !== undefined ? { context: entry.context } : {}),
		actions,
		...(Object.keys(definitions).length
			? { actionDefinitions: definitions }
			: {}),
	};
}

function actionEntry(
	paneId: string,
	action: string,
): OwnedPaneActionEntry | undefined {
	return orderedEntries(paneId).find((entry) =>
		Object.keys(entry.actions).includes(action),
	);
}

/** Claim the request for this recipient, while allowing its committed handlers to refresh. */
export function preparePaneAction(
	paneId: string,
	action: string,
	input?: unknown,
): () => Promise<PaneActionResult> {
	const owner = actionEntry(paneId, action)?.owner;
	return async () => {
		if (actionEntry(paneId, action)?.owner !== owner) {
			return {
				ok: false,
				error: {
					code: "pane_changed",
					message:
						"The pane action target changed before this request was admitted.",
					retryable: false,
					nextAction: `inspect \`dure client pane state ${paneId}\` before issuing a new command`,
				},
			};
		}
		return invokePaneAction(paneId, action, input);
	};
}

export async function invokePaneAction(
	paneId: string,
	action: string,
	input?: unknown,
): Promise<PaneActionResult> {
	const ordered = orderedEntries(paneId);
	if (ordered.length === 0) {
		return {
			ok: false,
			error: {
				code: "pane_not_found",
				message: `pane ${paneId} is not mounted in this client`,
				retryable: false,
				nextAction:
					"open the pane in a window, or inspect sessions with `dure ls`",
			},
		};
	}
	const handler = actionEntry(paneId, action)?.actions[action];
	if (!handler) {
		const available = actionNames(ordered);
		return {
			ok: false,
			error: {
				code: "pane_action_unavailable",
				message: `pane ${paneId} does not offer action ${action}`,
				retryable: false,
				nextAction: available.length
					? `available actions: ${available.join(", ")}`
					: "the pane currently offers no actions",
			},
		};
	}
	try {
		if (
			!handler.definition &&
			input !== undefined &&
			(!input ||
				typeof input !== "object" ||
				Array.isArray(input) ||
				Object.keys(input).length > 0)
		) {
			return {
				ok: false,
				error: {
					code: "pane_action_arguments_invalid",
					message: "This legacy action accepts no arguments.",
					retryable: false,
				},
			};
		}
		const result = handler.definition ? await handler(input) : await handler();
		return {
			ok: true,
			paneId,
			action,
			...(handler.definition ? { result: result as PaneActionExecution } : {}),
		};
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "pane_action_failed",
				message: error instanceof Error ? error.message : String(error),
				retryable: true,
				nextAction: `re-run \`dure client pane state ${paneId}\` and retry`,
			},
		};
	}
}
