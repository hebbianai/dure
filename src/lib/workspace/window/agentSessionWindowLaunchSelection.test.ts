import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AgentLaunchSelectionPresentationV1,
	AgentLaunchSelectionSurface,
} from "@/lib/agents/agentLaunchSelectionSurface";
import {
	type AgentSessionLaunchSelectionBackend,
	type AgentSessionLaunchSelectionCommand,
	type AgentSessionLaunchSelectionPublication,
	agentSessionLaunchSelectionMirror,
	executeAgentSessionLaunchSelectionStep,
	publishAgentSessionLaunchSelection,
} from "./agentSessionWindowLaunchSelection";

const SOURCE_WINDOW = "win-workspace-2";
const LARGE_WINDOW = "win-large-view";
const PANE = "agent:agent-1";

function presentation(
	model: string | null = "gpt-5.5",
): AgentLaunchSelectionPresentationV1 {
	return {
		loaded: true,
		hydrationError: false,
		model,
		effort: null,
		permissionMode: "default",
		switching: false,
		error: null,
		observedModel: null,
		catalog: { offered: true, status: "idle" },
		modelOptions: [
			{ value: "gpt-5.5", label: "GPT-5.5" },
			{ value: "gpt-5.5-mini", label: "GPT-5.5 mini" },
		],
		effortOptions: [],
		permissionOptions: [{ value: "default", label: "Default" }],
	};
}

function surface(
	model: string | null = "gpt-5.5",
): AgentLaunchSelectionSurface & { run: ReturnType<typeof vi.fn> } {
	return { presentation: presentation(model), run: vi.fn(async () => {}) };
}

/** Two windows: the source that publishes, and the large window that
 * listens. Presentations reach the large window only when addressed to it. */
function windows() {
	let listener: ((payload: unknown) => void) | undefined;
	const backend: AgentSessionLaunchSelectionBackend = {
		currentWindowLabel: () => SOURCE_WINDOW,
		emitPresentation: vi.fn(async (target, payload) => {
			if (target === LARGE_WINDOW) listener?.(payload);
		}),
		listenPresentation: vi.fn(async (next) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		}),
	};
	return {
		backend,
		deliver: (payload: unknown) => listener?.(payload),
	};
}

/** The bridge's source side, as the source window's executor receives it. */
const sendToSource = (command: AgentSessionLaunchSelectionCommand) =>
	executeAgentSessionLaunchSelectionStep({
		...command,
		panelId: PANE,
		replyWindowLabel: LARGE_WINDOW,
	});

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const cleanups: (() => void)[] = [];
function track(publication: AgentSessionLaunchSelectionPublication) {
	cleanups.push(() => publication.dispose());
	return publication;
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	await sendToSource({ action: "launch_selection", step: "unwatch" });
});

describe("large window launch pills", () => {
	it("follow the source pane's presentation and run their commands there", async () => {
		const { backend } = windows();
		const first = surface("gpt-5.5");
		const publication = track(
			publishAgentSessionLaunchSelection(PANE, first, backend),
		);
		// Nobody watches yet, so nothing is sent anywhere.
		expect(backend.emitPresentation).not.toHaveBeenCalled();

		const onPresentation = vi.fn();
		const mirror = agentSessionLaunchSelectionMirror(
			{ sourceWindowLabel: SOURCE_WINDOW, paneId: PANE },
			sendToSource,
			backend,
		);
		const stop = mirror.watch(onPresentation);
		await vi.waitFor(() =>
			expect(onPresentation).toHaveBeenLastCalledWith(presentation("gpt-5.5")),
		);

		const second = surface("gpt-5.5-mini");
		publication.update(second);
		await vi.waitFor(() =>
			expect(onPresentation).toHaveBeenLastCalledWith(
				presentation("gpt-5.5-mini"),
			),
		);
		// A re-render with the same presentation sends nothing new, but the
		// newest handlers are the ones a command runs on.
		const rerendered = surface("gpt-5.5-mini");
		publication.update(rerendered);
		await settled();
		expect(onPresentation).toHaveBeenCalledTimes(2);
		expect(backend.emitPresentation).toHaveBeenCalledOnce();

		const command = {
			kind: "select",
			field: "model",
			value: "gpt-5.5",
		} as const;
		await mirror.run(command);
		expect(rerendered.run).toHaveBeenCalledWith(command);
		expect(first.run).not.toHaveBeenCalled();
		expect(second.run).not.toHaveBeenCalled();

		// Once the large window stops watching, nothing more is sent to it.
		stop();
		publication.update(surface(null));
		await settled();
		expect(onPresentation).toHaveBeenCalledTimes(2);
	});

	it("tell the large window when the source pane stops publishing", async () => {
		const { backend } = windows();
		const publication = publishAgentSessionLaunchSelection(
			PANE,
			surface(),
			backend,
		);
		const onPresentation = vi.fn();
		const stop = agentSessionLaunchSelectionMirror(
			{ sourceWindowLabel: SOURCE_WINDOW, paneId: PANE },
			sendToSource,
			backend,
		).watch(onPresentation);
		await vi.waitFor(() => expect(onPresentation).toHaveBeenCalledOnce());

		publication.dispose();

		await vi.waitFor(() =>
			expect(onPresentation).toHaveBeenLastCalledWith(null),
		);
		stop();
	});

	it("refuse a command while the source pane publishes nothing, starting nothing", async () => {
		await expect(
			sendToSource({
				action: "launch_selection",
				step: "run",
				command: { kind: "apply_pending" },
			}),
		).rejects.toMatchObject({
			code: "client_launch_selection_unavailable",
			submitted: false,
		});
	});

	it("never replace a newer presentation with an older one that arrives late", async () => {
		const { backend, deliver } = windows();
		let answerWatch: ((result: { kind: string }) => void) | undefined;
		const send = vi.fn(
			(command: AgentSessionLaunchSelectionCommand) =>
				new Promise<{ kind: string }>((resolve) => {
					if (command.step === "watch") answerWatch = resolve;
					else resolve({ kind: "launch_selection_unwatched" });
				}),
		);
		const onPresentation = vi.fn();
		const stop = agentSessionLaunchSelectionMirror(
			{ sourceWindowLabel: SOURCE_WINDOW, paneId: PANE },
			send,
			backend,
		).watch(onPresentation);
		await vi.waitFor(() => expect(answerWatch).toBeTypeOf("function"));

		// Another window's pane, another pane and a malformed copy are ignored.
		deliver({
			sourceWindowLabel: "win-other",
			paneId: PANE,
			sequence: 9,
			presentation: presentation("other-window"),
		});
		deliver({
			sourceWindowLabel: SOURCE_WINDOW,
			paneId: "agent:agent-2",
			sequence: 9,
			presentation: presentation("other-pane"),
		});
		deliver({
			sourceWindowLabel: SOURCE_WINDOW,
			paneId: PANE,
			sequence: 9,
			presentation: { model: "partial" },
		});
		deliver({
			sourceWindowLabel: SOURCE_WINDOW,
			paneId: PANE,
			sequence: 7,
			presentation: presentation("gpt-5.5-mini"),
		});
		answerWatch?.({
			kind: "launch_selection_watched",
			sequence: 5,
			presentation: presentation("gpt-5.5"),
		} as { kind: string });
		await settled();

		expect(onPresentation.mock.calls).toEqual([[presentation("gpt-5.5-mini")]]);
		stop();
		expect(send).toHaveBeenLastCalledWith({
			action: "launch_selection",
			step: "unwatch",
		});
	});

	it("reject a run receipt of the wrong kind as uncertain", async () => {
		const mirror = agentSessionLaunchSelectionMirror(
			{ sourceWindowLabel: SOURCE_WINDOW, paneId: PANE },
			async () => ({ kind: "launch_selection_unwatched" }),
			windows().backend,
		);

		await expect(mirror.run({ kind: "cancel_pending" })).rejects.toThrow(
			"The launch selection receipt is invalid; the outcome is uncertain.",
		);
	});
});
