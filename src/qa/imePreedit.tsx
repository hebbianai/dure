import { useEffect, useState } from "react";
import { TerminalView } from "@/components/terminal/TerminalView";
import { hmux } from "@/lib/ipc";
import { qaLog } from "@/lib/qa/qaLog";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import type {
	TerminalWindowFocusControlState,
	TerminalWindowFocusProbe,
	TerminalWindowFocusProbeSurface,
} from "@/lib/terminal/terminalWindowFocusProbe";
import {
	currentTerminalDefaultColors,
	useRootDarkClass,
} from "@/lib/theme/themePreference";
import { useStore } from "@/store";

interface ImeQaSession {
	readonly sessionId: string;
	readonly workspaceId: string;
}

interface Point {
	readonly left: number;
	readonly top: number;
}

interface ProjectionSnapshot {
	readonly cursor: Point;
	readonly input: Point;
	readonly overlay:
		| null
		| (Point & { readonly text: string; readonly right: number });
	readonly presentationRight: number;
	readonly terminalText: string;
}

interface EventTraceEntry {
	readonly type: string;
	readonly data: string | null;
	readonly inputType: string;
	readonly isComposing: boolean;
	readonly isTrusted: boolean;
	readonly value: string;
}

let connectedProbeSurface: TerminalWindowFocusProbeSurface | undefined;
let probeControlState: TerminalWindowFocusControlState = "viewing";
let probeError: unknown;

const imePreeditProbe: TerminalWindowFocusProbe = {
	connect(surface) {
		connectedProbeSurface = surface;
		probeError = undefined;
		return () => {
			if (connectedProbeSurface === surface) connectedProbeSurface = undefined;
		};
	},
	onSurfaceAttachmentStarted() {
		probeControlState = "viewing";
	},
	onHydrationChange() {},
	onSynchronized() {},
	onPresented() {},
	onError(error) {
		probeError = error;
	},
};

const qaSurfaceSelector = "[data-qa-ime-preedit-surface]";

function traceText(value: string | null) {
	if (value === null || value.length <= 80) return value;
	return `${value.slice(0, 40)}…[${[...value].length} code points]`;
}

function sleep(milliseconds: number) {
	return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitFor<T>(
	description: string,
	read: () => T | undefined,
	timeoutMs = 30_000,
): Promise<T> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await sleep(25);
	}
	throw new Error(`timed out waiting for ${description}`);
}

async function nextPaint() {
	// A hidden non-focusable WKWebView intentionally suspends animation frames.
	// Two browser tasks still let React commit and a subsequent layout read below
	// forces WebKit to materialize the updated geometry without showing a window.
	await sleep(0);
	await sleep(0);
}

function relativePoint(element: Element, origin: DOMRect): Point {
	const rect = element.getBoundingClientRect();
	return {
		left: Math.round((rect.left - origin.left) * 100) / 100,
		top: Math.round((rect.top - origin.top) * 100) / 100,
	};
}

function setBrowserInputValue(input: HTMLTextAreaElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	if (!setter) throw new Error("textarea native value setter is unavailable");
	setter.call(input, value);
}

function readProjection(): ProjectionSnapshot | undefined {
	const surface = document.querySelector(qaSurfaceSelector);
	const presentation = surface?.querySelector(
		'[data-testid="structured-terminal-presentation"]',
	);
	const cursor = surface?.querySelector(".terminal-viewport-cursor");
	// Language-independent selector: this QA root mounts without the app-level
	// language bootstrap, so the t()-routed aria-label is locale-dependent.
	const input = surface?.querySelector<HTMLTextAreaElement>(
		'[data-testid="structured-terminal-presentation"] textarea',
	);
	if (!surface || !presentation || !cursor || !input || input.disabled) {
		return undefined;
	}
	const origin = presentation.getBoundingClientRect();
	const overlay = surface.querySelector(
		'[data-testid="structured-terminal-composition"]',
	);
	const overlayRect = overlay?.getBoundingClientRect();
	return {
		cursor: relativePoint(cursor, origin),
		input: relativePoint(input, origin),
		overlay:
			overlay && overlayRect
				? {
						...relativePoint(overlay, origin),
						text: overlay.textContent ?? "",
						right: Math.round((overlayRect.right - origin.left) * 100) / 100,
					}
				: null,
		presentationRight: Math.round(origin.width * 100) / 100,
		terminalText: [...surface.querySelectorAll(".terminal-viewport-row")]
			.map((row) => row.textContent ?? "")
			.join("\n"),
	};
}

function composition(
	input: HTMLTextAreaElement,
	type: "compositionstart" | "compositionupdate" | "compositionend",
	data: string,
	value?: string,
) {
	if (value !== undefined) setBrowserInputValue(input, value);
	input.dispatchEvent(
		new CompositionEvent(type, { bubbles: true, composed: true, data }),
	);
}

function compositionInput(
	input: HTMLTextAreaElement,
	value: string,
	data: string,
	isComposing: boolean,
) {
	setBrowserInputValue(input, value);
	input.dispatchEvent(
		new InputEvent("input", {
			bubbles: true,
			composed: true,
			data,
			inputType: isComposing ? "insertCompositionText" : "insertText",
			isComposing,
		}),
	);
}

function replacementInput(
	input: HTMLTextAreaElement,
	value: string,
	data: string,
	inputType: "insertText" | "insertReplacementText",
) {
	input.dispatchEvent(
		new InputEvent("beforeinput", {
			bubbles: true,
			cancelable: true,
			composed: true,
			data,
			inputType,
			isComposing: false,
		}),
	);
	setBrowserInputValue(input, value);
	input.dispatchEvent(
		new InputEvent("input", {
			bubbles: true,
			composed: true,
			data,
			inputType,
			isComposing: false,
		}),
	);
}

function key(
	input: HTMLTextAreaElement,
	value: string,
	code: string,
	ctrlKey = false,
) {
	return input.dispatchEvent(
		new KeyboardEvent("keydown", {
			bubbles: true,
			cancelable: true,
			key: value,
			code,
			ctrlKey,
		}),
	);
}

function samePoint(left: Point, right: Point) {
	return (
		Math.abs(left.left - right.left) <= 0.75 &&
		Math.abs(left.top - right.top) <= 0.75
	);
}

function occurrences(value: string, needle: string) {
	return value.split(needle).length - 1;
}

async function clearShellLine(input: HTMLTextAreaElement, previous: Point) {
	key(input, "c", "KeyC", true);
	return waitFor("a fresh canonical shell cursor", () => {
		const snapshot = readProjection();
		return snapshot && !samePoint(snapshot.cursor, previous)
			? snapshot
			: undefined;
	});
}

async function runImePreeditEvidence() {
	const input = await waitFor("the structured terminal input surface", () => {
		const candidate = document.querySelector<HTMLTextAreaElement>(
			`${qaSurfaceSelector} [data-testid="structured-terminal-presentation"] textarea`,
		);
		return candidate && !candidate.disabled ? candidate : undefined;
	});
	const probeSurface = await waitFor(
		"the structured terminal QA focus surface",
		() => connectedProbeSurface,
	);
	await probeSurface.focus();
	if (connectedProbeSurface !== probeSurface) {
		throw new Error("terminal surface changed during focus");
	}
	probeControlState = "controlling";
	if (probeError) throw probeError;
	if (probeControlState !== "controlling") {
		throw new Error(`unexpected terminal control state: ${probeControlState}`);
	}
	if (input.ownerDocument.activeElement !== input) {
		throw new Error(
			"structured terminal textarea did not become keyboard owner",
		);
	}
	// Let React commit the focus ownership update before WebKit begins the next
	// browser input task. Dispatching from the same passive-effect task bypasses
	// the product event boundary and is not representative of native delivery.
	await nextPaint();
	if (!input.isConnected || input.ownerDocument.activeElement !== input) {
		throw new Error("structured terminal textarea lost keyboard ownership");
	}
	const eventTrace: EventTraceEntry[] = [];
	let inputEventHandled = false;
	const trace = (event: Event) => {
		if (event.type === "input") {
			queueMicrotask(() => {
				inputEventHandled ||= input.value === "";
			});
		}
		const inputEvent = event as InputEvent;
		const compositionEvent = event as CompositionEvent;
		eventTrace.push({
			type: event.type,
			data: traceText(compositionEvent.data ?? inputEvent.data ?? null),
			inputType: inputEvent.inputType ?? "",
			isComposing: inputEvent.isComposing ?? false,
			isTrusted: event.isTrusted,
			value: traceText(input.value) ?? "",
		});
	};
	for (const type of [
		"keydown",
		"beforeinput",
		"compositionstart",
		"compositionupdate",
		"compositionend",
		"input",
	]) {
		input.addEventListener(type, trace, true);
	}

	const errors: string[] = [];
	const initial = await waitFor("the first canonical cursor", readProjection);
	compositionInput(input, "x", "x", false);
	let asciiEcho: ProjectionSnapshot;
	try {
		asciiEcho = await waitFor(
			"an ASCII Host echo through the structured input path",
			() => {
				const snapshot = readProjection();
				return snapshot?.terminalText.includes("x") &&
					!samePoint(snapshot.cursor, initial.cursor)
					? snapshot
					: undefined;
			},
			5_000,
		);
	} catch (error) {
		for (const type of [
			"keydown",
			"beforeinput",
			"compositionstart",
			"compositionupdate",
			"compositionend",
			"input",
		]) {
			input.removeEventListener(type, trace, true);
		}
		return {
			schemaVersion: 1,
			userAgent: navigator.userAgent,
			initial,
			current: readProjection(),
			inputEventHandled,
			controlState: probeControlState,
			probeError: probeError ? String(probeError) : null,
			eventTrace,
			errors: [String(error)],
			pass: false,
		};
	}
	const replacementInitial = await clearShellLine(input, asciiEcho.cursor);
	const replacementSyllable = "하";
	replacementInput(input, "ㅎ", "ㅎ", "insertText");
	replacementInput(
		input,
		replacementSyllable,
		replacementSyllable,
		"insertReplacementText",
	);
	await nextPaint();
	const replacementPending = readProjection();
	if (replacementPending?.overlay !== null) {
		errors.push(
			`replacement input created a second local projection: ${JSON.stringify(replacementPending?.overlay)}`,
		);
	}
	if (input.value !== replacementSyllable) {
		errors.push(`replacement helper lost its diff baseline: ${input.value}`);
	}
	const replacementCommitted = await waitFor(
		"one canonical replacement-only Korean Host echo",
		() => {
			const snapshot = readProjection();
			return snapshot?.terminalText.includes(replacementSyllable) &&
				!samePoint(snapshot.cursor, replacementInitial.cursor)
				? snapshot
				: undefined;
		},
	);
	if (occurrences(replacementCommitted.terminalText, replacementSyllable) !== 1) {
		errors.push(
			`replacement Korean text was not canonical exactly once: ${replacementCommitted.terminalText}`,
		);
	}
	if (replacementCommitted.overlay !== null) {
		errors.push(
			`replacement overlay survived its canonical Host echo: ${JSON.stringify(replacementCommitted.overlay)}`,
		);
	}
	if (!samePoint(replacementCommitted.input, replacementCommitted.cursor)) {
		errors.push(
			`replacement helper did not follow the canonical cursor: ${JSON.stringify(replacementCommitted)}`,
		);
	}

	const koreanInitial = await clearShellLine(
		input,
		replacementCommitted.cursor,
	);
	composition(input, "compositionstart", "", "");
	composition(input, "compositionupdate", "ㅈ", "ㅈ");
	compositionInput(input, "ㅈ", "ㅈ", true);
	composition(input, "compositionupdate", "지", "지");
	compositionInput(input, "지", "지", true);
	composition(input, "compositionend", "지", "지");
	compositionInput(input, "지", "지", false);
	composition(input, "compositionstart", "", "");
	composition(input, "compositionupdate", "ㄱ", "ㄱ");
	compositionInput(input, "ㄱ", "ㄱ", true);
	composition(input, "compositionupdate", "금", "금");
	compositionInput(input, "금", "금", true);
	composition(input, "compositionend", "금", "금");
	compositionInput(input, "금", "금", false);
	const koreanThirdJamo = "\u3134";
	const koreanThirdSyllable = "\ub098";
	const rapidKoreanText = "\uc9c0\uae08\ub098";
	composition(input, "compositionstart", "", "");
	composition(input, "compositionupdate", koreanThirdJamo, koreanThirdJamo);
	compositionInput(input, koreanThirdJamo, koreanThirdJamo, true);
	composition(
		input,
		"compositionupdate",
		koreanThirdSyllable,
		koreanThirdSyllable,
	);
	compositionInput(input, koreanThirdSyllable, koreanThirdSyllable, true);
	// All three compositions are dispatched in one browser task, so no Host
	// receipt or canonical paint can run between them. This is the continuous
	// Korean input ordering that the user exercises in a real WKWebView.
	const rapidPreedit = readProjection();
	if (rapidPreedit?.overlay?.text !== rapidKoreanText) {
		errors.push(
			`rapid Korean preedit lost its committed prefix: ${JSON.stringify(rapidPreedit?.overlay?.text)}`,
		);
	}
	if (
		!rapidPreedit?.overlay ||
		!samePoint(rapidPreedit.overlay, koreanInitial.cursor) ||
		!samePoint(rapidPreedit.input, koreanInitial.cursor)
	) {
		errors.push(
			`rapid Korean preedit/input left its canonical origin: ${JSON.stringify(rapidPreedit)}`,
		);
	}
	composition(
		input,
		"compositionend",
		koreanThirdSyllable,
		koreanThirdSyllable,
	);
	compositionInput(input, koreanThirdSyllable, koreanThirdSyllable, false);
	const koreanCommitted = await waitFor(
		"one canonical rapid Korean Host echo",
		() => {
			const snapshot = readProjection();
			return snapshot?.terminalText.includes(rapidKoreanText)
				? snapshot
				: undefined;
		},
	);
	if (occurrences(koreanCommitted.terminalText, rapidKoreanText) !== 1) {
		errors.push(
			`Korean committed text was not canonical exactly once: ${koreanCommitted.terminalText}`,
		);
	}
	if (koreanCommitted.overlay !== null) {
		errors.push(
			`Korean handoff survived its canonical Host echo: ${JSON.stringify(koreanCommitted.overlay)}`,
		);
	}

	await clearShellLine(input, koreanCommitted.cursor);
	composition(input, "compositionstart", "", "");
	composition(input, "compositionupdate", "に", "に");
	compositionInput(input, "に", "に", true);
	composition(input, "compositionupdate", "日本語", "日本語");
	compositionInput(input, "日本語", "日本語", true);
	await nextPaint();
	const japanesePreedit = readProjection();
	if (japanesePreedit?.overlay?.text !== "日本語") {
		errors.push(
			`Japanese conversion preedit was not singular: ${JSON.stringify(japanesePreedit?.overlay?.text)}`,
		);
	}
	composition(input, "compositionend", "日本語", "日本語");
	compositionInput(input, "日本語", "日本語", false);
	const japaneseCommitted = await waitFor(
		"one canonical Japanese Host echo",
		() => {
			const snapshot = readProjection();
			return snapshot?.terminalText.includes("日本語") ? snapshot : undefined;
		},
	);
	if (occurrences(japaneseCommitted.terminalText, "日本語") !== 1) {
		errors.push(
			`Japanese committed text was not canonical exactly once: ${japaneseCommitted.terminalText}`,
		);
	}

	await clearShellLine(input, japaneseCommitted.cursor);
	const generic = "A🙂界";
	composition(input, "compositionstart", "", "");
	composition(input, "compositionupdate", generic, generic);
	compositionInput(input, generic, generic, true);
	await nextPaint();
	const genericPreedit = readProjection();
	if (genericPreedit?.overlay?.text !== generic) {
		errors.push(
			`generic multi-codepoint preedit changed: ${JSON.stringify(genericPreedit?.overlay?.text)}`,
		);
	}
	composition(input, "compositionend", generic, generic);
	compositionInput(input, generic, generic, false);
	const genericCommitted = await waitFor(
		"one canonical generic Host echo",
		() => {
			const snapshot = readProjection();
			return snapshot?.terminalText.includes(generic) ? snapshot : undefined;
		},
	);
	if (occurrences(genericCommitted.terminalText, generic) !== 1) {
		errors.push(
			`generic committed text was not canonical exactly once: ${genericCommitted.terminalText}`,
		);
	}

	await clearShellLine(input, genericCommitted.cursor);
	const longPreedit = "한글日本語你好🙂".repeat(16);
	composition(input, "compositionstart", "", "");
	composition(input, "compositionupdate", longPreedit, longPreedit);
	compositionInput(input, longPreedit, longPreedit, true);
	await nextPaint();
	const bounded = readProjection();
	if (
		!bounded?.overlay ||
		bounded.overlay.right > bounded.presentationRight + 0.75
	) {
		errors.push(`long preedit escaped the pane: ${JSON.stringify(bounded)}`);
	}
	if (bounded && !samePoint(bounded.input, bounded.cursor)) {
		errors.push(
			`long preedit moved the native input surface off cursor: ${JSON.stringify(bounded)}`,
		);
	}
	composition(input, "compositionend", "", "");
	compositionInput(input, "", "", false);
	await nextPaint();
	const cancelled = readProjection();
	if (cancelled?.overlay !== null) {
		errors.push(
			`cancelled preedit remained visible: ${JSON.stringify(cancelled?.overlay)}`,
		);
	}

	const interruptedInitial = await waitFor(
		"the cursor after cancellation",
		readProjection,
	);
	await clearShellLine(input, interruptedInitial.cursor);
	replacementInput(input, "ime-keyX", "ime-keyX", "insertText");
	await waitFor("the interrupted composition deletion baseline", () => {
		const snapshot = readProjection();
		return snapshot?.terminalText.includes("ime-keyX") ? snapshot : undefined;
	});
	composition(input, "compositionstart", "", "");
	compositionInput(input, "한", "한", true);
	// Omit compositionend: Backspace must still reach the Host, and the next
	// ordinary edit must retire stale preedit without any focus repair.
	key(input, "Backspace", "Backspace");
	const interruptedBackspace = await waitFor(
		"Backspace during stale preedit",
		() => {
			const snapshot = readProjection();
			return snapshot?.terminalText.includes("ime-key") &&
				!snapshot.terminalText.includes("ime-keyX")
				? snapshot
				: undefined;
		},
	);
	for (const [text, code] of [
		["a", "KeyA"],
		[" ", "Space"],
		["b", "KeyB"],
	]) {
		key(input, text, code);
		replacementInput(input, text, text, "insertText");
	}
	const interruptedRecovered = await waitFor(
		"text and Space after stale preedit",
		() => {
			const snapshot = readProjection();
			return snapshot?.terminalText.includes("ime-keya b")
				? snapshot
				: undefined;
		},
		5_000,
	);
	if (input.ownerDocument.activeElement !== input) {
		errors.push("interrupted composition recovery changed keyboard owner");
	}
	if (
		interruptedRecovered.overlay !== null ||
		occurrences(interruptedRecovered.terminalText, "ime-keya b") !== 1
	) {
		errors.push(
			`interrupted composition did not converge exactly once: ${JSON.stringify(interruptedRecovered)}`,
		);
	}
	composition(input, "compositionend", "한");
	await nextPaint();
	if (input.ownerDocument.activeElement !== input) {
		errors.push("late compositionend changed keyboard owner");
	}

	await clearShellLine(input, interruptedRecovered.cursor);
	const viewport = document.querySelector<HTMLElement>(
		`${qaSurfaceSelector} [data-testid="structured-terminal-viewport"]`,
	);
	if (!viewport) throw new Error("click input viewport is unavailable");
	const bounds = viewport.getBoundingClientRect();
	const click = {
		bubbles: true, cancelable: true, button: 0, pointerId: 91,
		clientX: bounds.left + 10, clientY: bounds.top + 10,
	};
	viewport.dispatchEvent(new PointerEvent("pointerdown", { ...click, buttons: 1 }));
	viewport.dispatchEvent(new MouseEvent("mousedown", { ...click, buttons: 1, detail: 1 }));
	viewport.dispatchEvent(new PointerEvent("pointerup", { ...click, buttons: 0 }));
	await nextPaint();
	// Ask WebKit to perform the edit itself: a synthetic input event would
	// bypass the missing native caret and falsely pass this regression.
	const clickFocused = input.ownerDocument.activeElement === input;
	const clickCaretRanges = input.ownerDocument.getSelection()?.rangeCount;
	const clickInserted = input.ownerDocument.execCommand("insertText", false, "click a b");
	if (!clickFocused || !clickInserted) {
		throw new Error(`focused click lost native text editing: ${JSON.stringify({ clickFocused, clickCaretRanges, clickInserted })}`);
	}
	const clickRecovered = await waitFor("native text and Space after a focused click", () => {
		const snapshot = readProjection();
		return snapshot?.terminalText.includes("click a b") ? snapshot : undefined;
	});
	if (occurrences(clickRecovered.terminalText, "click a b") !== 1) {
		errors.push("focused click text did not reach the Host exactly once");
	}
	// A drag can also move the document selection into output while the
	// textarea stays active. Clicking back must reclaim its native edit range.
	input.ownerDocument.getSelection()?.selectAllChildren(viewport);
	viewport.dispatchEvent(new PointerEvent("pointerdown", { ...click, buttons: 1 }));
	viewport.dispatchEvent(new MouseEvent("mousedown", { ...click, buttons: 1, detail: 1 }));
	viewport.dispatchEvent(new PointerEvent("pointerup", { ...click, buttons: 0 }));
	if (!input.ownerDocument.execCommand("insertText", false, " selected")) {
		throw new Error("click did not reclaim native editing from output selection");
	}
	const selectionRecovered = await waitFor("native text after selecting terminal output", () => {
		const snapshot = readProjection();
		return snapshot?.terminalText.includes("click a b selected") ? snapshot : undefined;
	});
	if (input.ownerDocument.activeElement !== input ||
		occurrences(selectionRecovered.terminalText, "click a b selected") !== 1) {
		errors.push("selection return did not retain the input owner and exactly-once text");
	}

	for (const type of [
		"keydown",
		"beforeinput",
		"compositionstart",
		"compositionupdate",
		"compositionend",
		"input",
	]) {
		input.removeEventListener(type, trace, true);
	}

	return {
		schemaVersion: 1,
		userAgent: navigator.userAgent,
		initial,
		replacementPending,
		replacementCommitted,
		rapidPreedit,
		koreanCommitted,
		japanesePreedit,
		japaneseCommitted,
		genericPreedit,
		genericCommitted,
		bounded,
		cancelled,
		interruptedBackspace,
		interruptedRecovered,
		clickRecovered,
		selectionRecovered,
		eventTrace,
		errors,
		pass: errors.length === 0,
	};
}

export function ImePreeditQaRoot() {
	useRootDarkClass();
	const [session, setSession] = useState<ImeQaSession>();
	const [painted, setPainted] = useState(false);
	const [status, setStatus] = useState("creating isolated Hmux session");

	useEffect(() => {
		let cancelled = false;
		void hmux
			.createStandalone({
				operationId: "ime-preedit-qa",
				cwd: "/tmp",
				columns: 40,
				rows: 10,
				terminalDefaultColors: currentTerminalDefaultColors(),
			})
			.then((created) => {
				if (cancelled) return;
				useStore.getState().setHmuxSessionMetadata(created);
				setSession({
					sessionId: created.sessionId,
					workspaceId: created.workspaceId,
				});
				setStatus("waiting for canonical terminal paint");
			})
			.catch((error) => {
				const result = {
					schemaVersion: 1,
					pass: false,
					errors: [`isolated session creation failed: ${String(error)}`],
				};
				qaLog("imepreedit", result);
				setStatus(result.errors[0] ?? "IME QA failed");
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!session || !painted) return;
		let cancelled = false;
		setStatus("running WebKit composition trace");
		void runImePreeditEvidence()
			.then((result) => {
				if (cancelled) return;
				qaLog("imepreedit", result);
				setStatus(result.pass ? "IME QA passed" : result.errors.join(" | "));
			})
			.catch((error) => {
				if (cancelled) return;
				const result = {
					schemaVersion: 1,
					pass: false,
					userAgent: navigator.userAgent,
					errors: [String(error)],
				};
				qaLog("imepreedit", result);
				setStatus(result.errors[0] ?? "IME QA failed");
			});
		return () => {
			cancelled = true;
		};
	}, [painted, session]);

	return (
		<main className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
			<div
				className="h-6 shrink-0 px-2 font-mono text-[10px] leading-6"
				data-qa-ime-status=""
			>
				{status}
			</div>
			<section className="min-h-0 flex-1" data-qa-ime-preedit-surface="">
				{session && (
					<TerminalView
						sessionId={session.sessionId}
						surfaceId="ime-preedit-qa"
						kind="pty"
						binding={hmuxStandaloneBinding(
							session.sessionId,
							session.workspaceId,
						)}
						windowFocusProbe={imePreeditProbe}
						onFirstPaint={() => setPainted(true)}
					/>
				)}
			</section>
		</main>
	);
}
