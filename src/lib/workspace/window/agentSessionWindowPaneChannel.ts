import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isRecord } from "@/lib/payloadGuards";
import { listenWhenReady } from "@/lib/platform/tauriBridge";

/** A surface a source pane owns and its Agent's large window mirrors: a plain
 * JSON presentation the pane computes, and commands that run on the pane's
 * own handlers. */
export interface AgentSessionPaneSurface<Presentation, Command, Outcome = void> {
	readonly presentation: Presentation;
	run(command: Command): Promise<Outcome>;
}

/** A channel's steps, sent by a large window to the window that owns its
 * source pane. `watch` asks for the pane's presentation now and on every
 * change until `unwatch`; `run` runs one command there. */
export type AgentSessionPaneChannelCommand<Action extends string, Command> =
	| { action: Action; step: "watch" | "unwatch" }
	| { action: Action; step: "run"; command: Command };

/** A source pane's presentation at one point in its sequence; null while the
 * pane publishes none (unmounted, or nothing to offer). */
interface AgentSessionPaneSnapshot<Presentation> {
	sequence: number;
	presentation: Presentation | null;
}

export type AgentSessionPaneChannelResult<
	Action extends string,
	Presentation,
	Outcome = void,
> =
	| ({ kind: `${Action}_watched` } & AgentSessionPaneSnapshot<Presentation>)
	| { kind: `${Action}_unwatched` }
	| { kind: `${Action}_ran`; outcome?: Outcome };

interface PresentationPayload<Presentation>
	extends AgentSessionPaneSnapshot<Presentation> {
	sourceWindowLabel: string;
	paneId: string;
}

export interface AgentSessionPaneChannelBackend {
	currentWindowLabel(): string;
	emitPresentation(
		targetWindowLabel: string,
		payload: PresentationPayload<unknown>,
	): Promise<void>;
	listenPresentation(listener: (payload: unknown) => void): Promise<() => void>;
}

export interface AgentSessionPaneChannelPublication<Surface> {
	update(surface: Surface): void;
	dispose(): void;
}

export interface AgentSessionPaneChannelMirror<Presentation, Command, Outcome> {
	/** Follows the source pane's presentation; returns the stop. */
	watch(onPresentation: (presentation: Presentation | null) => void): () => void;
	run(command: Command): Promise<Outcome | undefined>;
}

class AgentSessionPaneChannelRefusal extends Error {
	readonly submitted = false;
	constructor(readonly code: string) {
		super(code);
	}
}

export interface AgentSessionPaneChannelSpec<
	Action extends string,
	Presentation,
	Command,
	Outcome,
> {
	readonly action: Action;
	/** The Tauri event the source window addresses presentations with. */
	readonly event: string;
	parsePresentation(value: unknown): Presentation | undefined;
	parseCommand(value: unknown): Command | undefined;
	/** Validates a run receipt's outcome; channels whose runs report nothing
	 * omit it. */
	parseOutcome?(value: unknown): Outcome | undefined;
	/** Refusal code for a run while the source pane publishes nothing. */
	readonly unavailableCode: string;
	readonly invalidCommand: string;
	readonly receiptInvalid: string;
}

/** One pane-owned surface mirrored into large windows. The source window
 * keeps each mounted pane's publications and the windows that watch them;
 * a large window follows the newest presentation and sends commands back. */
export function createAgentSessionPaneChannel<
	Action extends string,
	Presentation,
	Command,
	Outcome = void,
>(spec: AgentSessionPaneChannelSpec<Action, Presentation, Command, Outcome>) {
	// A surface's run reports its outcome, or nothing for channels whose runs
	// report nothing; the mirror validates it with `parseOutcome`.
	type Surface = AgentSessionPaneSurface<Presentation, Command, unknown>;
	type ChannelCommand = AgentSessionPaneChannelCommand<Action, Command>;
	type ChannelResult = AgentSessionPaneChannelResult<
		Action,
		Presentation,
		Outcome
	>;
	type Snapshot = AgentSessionPaneSnapshot<Presentation>;

	const backend: AgentSessionPaneChannelBackend = {
		currentWindowLabel: () => getCurrentWebviewWindow().label,
		emitPresentation: (targetWindowLabel, payload) =>
			emitTo(
				{ kind: "WebviewWindow", label: targetWindowLabel },
				spec.event,
				payload,
			),
		listenPresentation: (listener) =>
			listenWhenReady<unknown>(
				spec.event,
				(event) => listener(event.payload),
				{
					target: {
						kind: "WebviewWindow",
						label: getCurrentWebviewWindow().label,
					},
				},
			),
	};

	// --- Source window: the panes' published surfaces ---

	/** Surfaces of this window's mounted panes, newest first per pane, as
	 * the pane action registry orders its entries. */
	const publications = new Map<string, { surface: Surface }[]>();
	/** The windows watching a pane: its large window, while it shows it. */
	const watchers = new Map<string, Set<string>>();
	const announced = new Map<string, Snapshot & { serialized: string }>();
	let lastSequence = 0;

	/** Ordered across a reload of this window too, so a watcher never
	 * mistakes a fresh window's first presentation for an old one. */
	function nextSequence(): number {
		lastSequence = Math.max(lastSequence + 1, Date.now());
		return lastSequence;
	}

	function currentSnapshot(paneId: string): Snapshot {
		const snapshot = announced.get(paneId);
		return snapshot
			? { sequence: snapshot.sequence, presentation: snapshot.presentation }
			: { sequence: 0, presentation: null };
	}

	/** Sends a pane's newest presentation to its watchers when it changed. */
	function announce(
		paneId: string,
		transport: AgentSessionPaneChannelBackend,
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
		// Delivery is best effort and never fails the pane's render: a
		// watcher that missed a presentation catches up on its next `watch`.
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

	function parseSnapshot(value: Record<string, unknown>): Snapshot | undefined {
		if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0)
			return undefined;
		if (value.presentation === null)
			return { sequence: value.sequence as number, presentation: null };
		const presentation = spec.parsePresentation(value.presentation);
		return presentation
			? { sequence: value.sequence as number, presentation }
			: undefined;
	}

	return {
		/** Whether an untrusted bridge payload is a well-formed step. */
		stepValid(payload: Record<string, unknown>): boolean {
			if (payload.step === "watch" || payload.step === "unwatch") return true;
			return (
				payload.step === "run" && spec.parseCommand(payload.command) !== undefined
			);
		},

		/** Only the fields a step defines; nothing else the sender put on the
		 * payload reaches the source window's executor. */
		step(command: ChannelCommand): ChannelCommand {
			if (command.step !== "run")
				return { action: spec.action, step: command.step };
			const parsed = spec.parseCommand(command.command);
			if (parsed === undefined) throw new Error(spec.invalidCommand);
			return { action: spec.action, step: "run", command: parsed };
		},

		/** Publishes a pane's surface to the large window that shows the pane.
		 * The pane keeps owning it: the large window renders the presentation
		 * published here and sends its commands back to run on `surface.run`. */
		publish(
			paneId: string,
			initial: Surface,
			transport: AgentSessionPaneChannelBackend = backend,
		): AgentSessionPaneChannelPublication<Surface> {
			const publication = { surface: initial };
			publications.set(paneId, [
				publication,
				...(publications.get(paneId) ?? []),
			]);
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
		},

		/** Runs one step inside the window that owns the source pane. */
		async execute(
			command: ChannelCommand & { panelId: string; replyWindowLabel: string },
		): Promise<ChannelResult> {
			const { panelId, replyWindowLabel } = command;
			switch (command.step) {
				case "watch": {
					const paneWatchers = watchers.get(panelId) ?? new Set<string>();
					paneWatchers.add(replyWindowLabel);
					watchers.set(panelId, paneWatchers);
					return {
						kind: `${spec.action}_watched`,
						...currentSnapshot(panelId),
					} as ChannelResult;
				}
				case "unwatch": {
					const paneWatchers = watchers.get(panelId);
					paneWatchers?.delete(replyWindowLabel);
					if (paneWatchers?.size === 0) watchers.delete(panelId);
					if (!publications.has(panelId) && !watchers.has(panelId))
						announced.delete(panelId);
					return { kind: `${spec.action}_unwatched` } as ChannelResult;
				}
				case "run": {
					const publication = publications.get(panelId)?.[0];
					if (!publication)
						throw new AgentSessionPaneChannelRefusal(spec.unavailableCode);
					const outcome = await publication.surface.run(command.command);
					return {
						kind: `${spec.action}_ran`,
						...(outcome !== undefined ? { outcome } : {}),
					} as ChannelResult;
				}
			}
		},

		/** A large window's view of its source pane's surface. `send` delivers
		 * each step to the window that owns the source pane; presentations
		 * arrive from there in sequence, and an older one never replaces a
		 * newer one. */
		mirror(
			source: { sourceWindowLabel: string; paneId: string },
			send: (command: ChannelCommand) => Promise<{ readonly kind: string }>,
			transport: AgentSessionPaneChannelBackend = backend,
		): AgentSessionPaneChannelMirror<Presentation, Command, Outcome> {
			return {
				watch: (onPresentation) => {
					let disposed = false;
					let lastAccepted = -1;
					let stop: (() => void) | undefined;
					const accept = (snapshot: Snapshot) => {
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
							return send({ action: spec.action, step: "watch" });
						})
						.then((result) => {
							if (!result) return;
							const snapshot =
								result.kind === `${spec.action}_watched`
									? parseSnapshot(result as unknown as Record<string, unknown>)
									: undefined;
							if (snapshot) accept(snapshot);
						})
						.catch(() => {});
					return () => {
						disposed = true;
						stop?.();
						void send({ action: spec.action, step: "unwatch" }).catch(
							() => {},
						);
					};
				},
				run: async (command) => {
					const result = await send({
						action: spec.action,
						step: "run",
						command,
					});
					if (result.kind !== `${spec.action}_ran`)
						throw new Error(spec.receiptInvalid);
					const outcome = (result as { outcome?: unknown }).outcome;
					if (outcome === undefined) return undefined;
					const parsed = spec.parseOutcome?.(outcome);
					if (parsed === undefined) throw new Error(spec.receiptInvalid);
					return parsed;
				},
			};
		},
	};
}
