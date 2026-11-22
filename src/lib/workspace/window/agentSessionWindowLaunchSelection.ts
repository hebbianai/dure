import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
	type AgentLaunchSelectionCommand,
	type AgentLaunchSelectionPresentationV1,
	type AgentLaunchSelectionSurface,
	parseAgentLaunchSelectionCommand,
	parseAgentLaunchSelectionPresentation,
} from "@/lib/agents/agentLaunchSelectionSurface";
import { isRecord } from "@/lib/payloadGuards";
import { listenWhenReady } from "@/lib/platform/tauriBridge";

const PRESENTATION_EVENT = "dure://agent-session/launch-selection";
const RECEIPT_INVALID =
	"The launch selection receipt is invalid; the outcome is uncertain.";

/** The launch pills' steps, sent by a large window to the window that owns
 * its source pane. `watch` asks for the pane's presentation now and on every
 * change until `unwatch`; `run` runs one pill command there. */
export type AgentSessionLaunchSelectionCommand =
	| { action: "launch_selection"; step: "watch" | "unwatch" }
	| {
			action: "launch_selection";
			step: "run";
			command: AgentLaunchSelectionCommand;
	  };

/** A source pane's launch presentation at one point in its sequence; null
 * while the pane publishes none (unmounted, or not on a managed Host). */
interface AgentSessionLaunchSelectionSnapshot {
	sequence: number;
	presentation: AgentLaunchSelectionPresentationV1 | null;
}

export type AgentSessionLaunchSelectionResult =
	| ({ kind: "launch_selection_watched" } & AgentSessionLaunchSelectionSnapshot)
	| { kind: "launch_selection_unwatched" }
	| { kind: "launch_selection_ran" };

/** Whether an untrusted bridge payload is a well-formed launch pill step. */
export function agentSessionLaunchSelectionStepValid(
	payload: Record<string, unknown>,
): boolean {
	if (payload.step === "watch" || payload.step === "unwatch") return true;
	return (
		payload.step === "run" &&
		parseAgentLaunchSelectionCommand(payload.command) !== undefined
	);
}

/** Only the fields a launch pill step defines; nothing else the sender put on
 * the payload reaches the source window's executor. */
export function agentSessionLaunchSelectionStep(
	command: AgentSessionLaunchSelectionCommand,
): AgentSessionLaunchSelectionCommand {
	if (command.step !== "run")
		return { action: "launch_selection", step: command.step };
	const parsed = parseAgentLaunchSelectionCommand(command.command);
	if (!parsed) throw new Error("The launch selection command is invalid.");
	return { action: "launch_selection", step: "run", command: parsed };
}

interface PresentationPayload extends AgentSessionLaunchSelectionSnapshot {
	sourceWindowLabel: string;
	paneId: string;
}

export interface AgentSessionLaunchSelectionBackend {
	currentWindowLabel(): string;
	emitPresentation(
		targetWindowLabel: string,
		payload: PresentationPayload,
	): Promise<void>;
	listenPresentation(listener: (payload: unknown) => void): Promise<() => void>;
}

const backend: AgentSessionLaunchSelectionBackend = {
	currentWindowLabel: () => getCurrentWebviewWindow().label,
	emitPresentation: (targetWindowLabel, payload) =>
		emitTo(
			{ kind: "WebviewWindow", label: targetWindowLabel },
			PRESENTATION_EVENT,
			payload,
		),
	listenPresentation: (listener) =>
		listenWhenReady<unknown>(
			PRESENTATION_EVENT,
			(event) => listener(event.payload),
			{
				target: {
					kind: "WebviewWindow",
					label: getCurrentWebviewWindow().label,
				},
			},
		),
};

// --- Source window: the panes' published launch pills ---

interface Publication {
	surface: AgentLaunchSelectionSurface;
}

/** Launch pills of this window's mounted panes, newest first per pane, as
 * the pane action registry orders its entries. */
const publications = new Map<string, Publication[]>();
/** The windows watching a pane: its large window, while it shows the pane. */
const watchers = new Map<string, Set<string>>();
const announced = new Map<
	string,
	AgentSessionLaunchSelectionSnapshot & { serialized: string }
>();
let lastSequence = 0;

/** Ordered across a reload of this window too, so a watcher never mistakes a
 * fresh window's first presentation for an old one. */
function nextSequence(): number {
	lastSequence = Math.max(lastSequence + 1, Date.now());
	return lastSequence;
}

function currentSnapshot(paneId: string): AgentSessionLaunchSelectionSnapshot {
	const snapshot = announced.get(paneId);
	return snapshot
		? { sequence: snapshot.sequence, presentation: snapshot.presentation }
		: { sequence: 0, presentation: null };
}

/** Sends a pane's newest presentation to its watchers when it changed. */
function announce(
	paneId: string,
	transport: AgentSessionLaunchSelectionBackend,
): void {
	const presentation = publications.get(paneId)?.[0]?.surface.presentation;
	const serialized = JSON.stringify(presentation ?? null);
	if (announced.get(paneId)?.serialized === serialized) return;
	const snapshot = {
		sequence: nextSequence(),
		presentation: presentation ?? null,
	};
	const paneWatchers = watchers.get(paneId);
	if (presentation || paneWatchers) {
		announced.set(paneId, { ...snapshot, serialized });
	} else {
		announced.delete(paneId);
	}
	// Delivery is best effort and never fails the pane's render: a watcher
	// that missed a presentation catches up on its next `watch`.
	for (const label of paneWatchers ?? []) {
		void Promise.resolve()
			.then(() =>
				transport.emitPresentation(label, {
					...snapshot,
					sourceWindowLabel: transport.currentWindowLabel(),
					paneId,
				}),
			)
			.catch(() => {});
	}
}

export interface AgentSessionLaunchSelectionPublication {
	update(surface: AgentLaunchSelectionSurface): void;
	dispose(): void;
}

/** Publishes a pane's launch pills to the large window that shows the pane.
 * The pane keeps owning them: the large window renders the presentation
 * published here and sends its commands back to run on `surface.run`. */
export function publishAgentSessionLaunchSelection(
	paneId: string,
	initial: AgentLaunchSelectionSurface,
	transport: AgentSessionLaunchSelectionBackend = backend,
): AgentSessionLaunchSelectionPublication {
	const publication: Publication = { surface: initial };
	publications.set(paneId, [publication, ...(publications.get(paneId) ?? [])]);
	announce(paneId, transport);
	return {
		update: (surface) => {
			publication.surface = surface;
			announce(paneId, transport);
		},
		dispose: () => {
			const remaining = (publications.get(paneId) ?? []).filter(
				(candidate) => candidate !== publication,
			);
			if (remaining.length) publications.set(paneId, remaining);
			else publications.delete(paneId);
			announce(paneId, transport);
		},
	};
}

class LaunchSelectionRefusal extends Error {
	readonly submitted = false;
	constructor(readonly code: string) {
		super(code);
	}
}

/** Runs one launch pill step inside the window that owns the source pane. */
export async function executeAgentSessionLaunchSelectionStep(
	command: AgentSessionLaunchSelectionCommand & {
		panelId: string;
		replyWindowLabel: string;
	},
): Promise<AgentSessionLaunchSelectionResult> {
	const { panelId, replyWindowLabel } = command;
	switch (command.step) {
		case "watch": {
			const paneWatchers = watchers.get(panelId) ?? new Set<string>();
			paneWatchers.add(replyWindowLabel);
			watchers.set(panelId, paneWatchers);
			return { kind: "launch_selection_watched", ...currentSnapshot(panelId) };
		}
		case "unwatch": {
			const paneWatchers = watchers.get(panelId);
			paneWatchers?.delete(replyWindowLabel);
			if (paneWatchers?.size === 0) watchers.delete(panelId);
			if (!publications.has(panelId) && !watchers.has(panelId))
				announced.delete(panelId);
			return { kind: "launch_selection_unwatched" };
		}
		case "run": {
			const publication = publications.get(panelId)?.[0];
			if (!publication)
				throw new LaunchSelectionRefusal("client_launch_selection_unavailable");
			await publication.surface.run(command.command);
			return { kind: "launch_selection_ran" };
		}
	}
}

// --- Large window: the source pane's launch pills ---

function parseSnapshot(
	value: Record<string, unknown>,
): AgentSessionLaunchSelectionSnapshot | undefined {
	if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0)
		return undefined;
	if (value.presentation === null)
		return { sequence: value.sequence as number, presentation: null };
	const presentation = parseAgentLaunchSelectionPresentation(
		value.presentation,
	);
	return presentation
		? { sequence: value.sequence as number, presentation }
		: undefined;
}

export interface AgentSessionLaunchSelectionMirror {
	/** Follows the source pane's presentation; returns the stop. */
	watch(
		onPresentation: (
			presentation: AgentLaunchSelectionPresentationV1 | null,
		) => void,
	): () => void;
	run(command: AgentLaunchSelectionCommand): Promise<void>;
}

/** A large window's view of its source pane's launch pills. `send` delivers
 * each step to the window that owns the source pane; presentations arrive
 * from there in sequence, and an older one never replaces a newer one. */
export function agentSessionLaunchSelectionMirror(
	source: { sourceWindowLabel: string; paneId: string },
	send: (
		command: AgentSessionLaunchSelectionCommand,
	) => Promise<{ readonly kind: string }>,
	transport: AgentSessionLaunchSelectionBackend = backend,
): AgentSessionLaunchSelectionMirror {
	return {
		watch: (onPresentation) => {
			let disposed = false;
			let lastAccepted = -1;
			let stop: (() => void) | undefined;
			const accept = (snapshot: AgentSessionLaunchSelectionSnapshot) => {
				if (disposed || snapshot.sequence <= lastAccepted) return;
				lastAccepted = snapshot.sequence;
				onPresentation(snapshot.presentation);
			};
			void transport
				.listenPresentation((candidate) => {
					if (
						!isRecord(candidate) ||
						candidate.sourceWindowLabel !== source.sourceWindowLabel ||
						candidate.paneId !== source.paneId
					)
						return;
					const snapshot = parseSnapshot(candidate);
					if (snapshot) accept(snapshot);
				})
				.then((unlisten) => {
					if (disposed) {
						unlisten();
						return;
					}
					stop = unlisten;
					return send({ action: "launch_selection", step: "watch" });
				})
				.then((result) => {
					if (!result) return;
					const snapshot =
						result.kind === "launch_selection_watched"
							? parseSnapshot(result as unknown as Record<string, unknown>)
							: undefined;
					if (snapshot) accept(snapshot);
				})
				.catch(() => {});
			return () => {
				disposed = true;
				stop?.();
				void send({ action: "launch_selection", step: "unwatch" }).catch(
					() => {},
				);
			};
		},
		run: async (command) => {
			const result = await send({
				action: "launch_selection",
				step: "run",
				command,
			});
			if (result.kind !== "launch_selection_ran")
				throw new Error(RECEIPT_INVALID);
		},
	};
}
