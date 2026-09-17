import { getCurrentWindow } from "@tauri-apps/api/window";
import { hmuxPaneOwnerId } from "@/lib/hmux/hmuxPaneRetirement";
import {
	type TerminalInputLatencySample,
	terminalInputLatency,
} from "@/lib/terminal/interaction/terminalInputLatency";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import type { WorkspacePerformanceFixture } from "./fixture";
import type { WorkspacePerformanceStructuredTerminalLease } from "./structuredTerminalSurface";

export interface NativePaneFocusSample {
	panelId: string;
	surfaceId: string;
	pointerDowns: number;
	keyDowns: number;
	inputEvents: number;
	text: string;
	trusted: boolean;
	focusMs: number | null;
	inputMs: number | null;
	focusedAfterInput: boolean;
	trace?: TerminalInputLatencySample;
}

export interface NativePaneFocusEvidence {
	target?: { ordinal: number; x: number; y: number };
	samples: NativePaneFocusSample[];
}

/** Observe the production terminal body path. No focus request repairs a measured click. */
export async function runNativePaneFocus(
	fixture: WorkspacePerformanceFixture,
	terminals: WorkspacePerformanceStructuredTerminalLease,
	waitFor: (description: string, predicate: () => boolean) => Promise<void>,
) {
	const api = getDockview(fixture.activeSpaceId);
	const panelIds = fixture.panelIdsByDesktop[fixture.activeSpaceId];
	if (!api || panelIds.length < 2)
		throw new Error("native focus needs neighboring terminal panes");
	const nativeWindow = getCurrentWindow();
	const evidence: NativePaneFocusEvidence = { samples: [] };
	const publish = () => {
		const status = window.__DURE_WORKSPACE_PERFORMANCE_QA__;
		if (!status) throw new Error("workspace QA status missing");
		window.__DURE_WORKSPACE_PERFORMANCE_QA__ = {
			...status,
			phase: "native_focus",
			nativeFocus: evidence,
		};
	};
	terminalInputLatency.resetMeasurements();
	for (let index = 0; index < fixture.scenario.focusInputSamples; index += 1) {
		const panelId = panelIds[(index + 1) % panelIds.length];
		const panel = api.getPanel(panelId);
		if (!panel) throw new Error(`native focus pane missing: ${panelId}`);
		await waitFor(
			"native focus terminal readiness",
			() => terminals.surface(panelId)?.connected === true,
		);
		const viewport = panel.group.element.querySelector<HTMLElement>(
			'[data-testid="structured-terminal-viewport"]',
		);
		const input = panel.group.element.querySelector("textarea");
		if (
			!viewport ||
			!input ||
			input.disabled ||
			api.activePanel?.id === panelId ||
			document.activeElement === input
		) {
			throw new Error(
				`native focus precondition must be a ready, unfocused pane: ${panelId}`,
			);
		}
		const surfaceId = hmuxPaneOwnerId(
			nativeWindow.label,
			fixture.activeSpaceId,
			panelId,
		);
		const bounds = viewport.getBoundingClientRect();
		const x = bounds.left + bounds.width / 2;
		const y = bounds.top + bounds.height / 2;
		if (!viewport.contains(document.elementFromPoint(x, y)))
			throw new Error("native focus body target is occluded");
		const origin = (await nativeWindow.innerPosition()).toLogical(
			await nativeWindow.scaleFactor(),
		);
		const sample: NativePaneFocusSample = {
			panelId,
			surfaceId,
			pointerDowns: 0,
			keyDowns: 0,
			inputEvents: 0,
			text: "",
			trusted: true,
			focusMs: null,
			inputMs: null,
			focusedAfterInput: false,
		};
		let clickedAt: number | undefined;
		const pointer = (event: PointerEvent) => {
			clickedAt ??= performance.now();
			sample.pointerDowns += 1;
			sample.trusted &&= event.isTrusted;
		};
		const focus = () => {
			sample.focusMs =
				clickedAt === undefined ? null : performance.now() - clickedAt;
		};
		const key = (event: KeyboardEvent) => {
			sample.keyDowns += 1;
			sample.trusted &&= event.isTrusted;
		};
		const text = (event: Event) => {
			sample.inputEvents += 1;
			sample.text += input.value;
			sample.trusted &&= event.isTrusted;
			sample.inputMs =
				clickedAt === undefined ? null : performance.now() - clickedAt;
		};
		viewport.addEventListener("pointerdown", pointer, true);
		input.addEventListener("focus", focus);
		input.addEventListener("keydown", key, true);
		input.addEventListener("input", text, true);
		evidence.samples.push(sample);
		evidence.target = { ordinal: index + 1, x: origin.x + x, y: origin.y + y };
		publish();
		try {
			await waitFor(
				"native click, first character, Host receipt and echo paint",
				() => {
					sample.trace = terminalInputLatency
						.snapshot()
						.samples.find(
							(value) =>
								value.terminalId === surfaceId &&
								clickedAt !== undefined &&
								value.startedAt >= clickedAt,
						);
					return sample.trace?.outcome === "complete";
				},
			);
			sample.focusedAfterInput =
				document.activeElement === input && api.activePanel?.id === panelId;
			if (
				sample.pointerDowns !== 1 ||
				sample.keyDowns !== 1 ||
				sample.inputEvents !== 1 ||
				sample.text !== "x" ||
				!sample.trusted ||
				sample.focusMs === null ||
				!sample.focusedAfterInput
			) {
				throw new Error(
					`native first-click input failed: ${JSON.stringify(sample)}`,
				);
			}
		} finally {
			viewport.removeEventListener("pointerdown", pointer, true);
			input.removeEventListener("focus", focus);
			input.removeEventListener("keydown", key, true);
			input.removeEventListener("input", text, true);
			evidence.target = undefined;
			publish();
		}
	}
}
