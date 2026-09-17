import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import {
	currentWindowIsFocused,
	currentWindowIsInputReady,
} from "@/lib/workspace/window/currentWindowFocus";
import { runPaneFocusHistoryScenario } from "./paneFocusHistoryScenario";
import "dockview-react/dist/styles/dockview.css";

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export function PaneFocusHistoryQaRoot() {
	const container = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let disposed = false;
		const runId = import.meta.env.VITE_DURE_PANE_FOCUS_HISTORY_QA_RUN_ID;
		const nativeWindow = getCurrentWindow();
		const run = async () => {
			if (typeof runId !== "string" || !/^[a-f0-9-]{36}$/.test(runId)) {
				throw new Error("pane focus QA requires an isolated run identity");
			}
			// The client is launched only after the runner's final idle preflight.
			// Its flag lives inside DURE_QA_STATE_ROOT, never the user's workspace.
			const deadline = performance.now() + 180_000;
			let admitted = false;
			while (!disposed && performance.now() < deadline) {
				const response = await fetch("/__qa_flag", {
					cache: "no-store",
					signal: AbortSignal.timeout(2_000),
				});
				if (
					response.ok &&
					(await response.text()) === `pane-focus-history:${runId}`
				) {
					admitted = true;
					break;
				}
				await sleep(250);
			}
			if (disposed) return;
			if (!admitted || !container.current)
				throw new Error("pane focus QA admission timed out");
			await nativeWindow.show();
			await nativeWindow.setFocus();
			const focusDeadline = performance.now() + 3_000;
			while (!document.hasFocus() && performance.now() < focusDeadline)
				await sleep(25);
			let nativeFocusChecks = 0;
			let activation: object | undefined;
			const observations = await runPaneFocusHistoryScenario(
				container.current,
				async () => {
					await sleep(0);
					if (
						disposed ||
						!document.hasFocus() ||
						!(await nativeWindow.isFocused())
					) {
						throw new Error(
							"native window focus was lost during the pane journey",
						);
					}
					nativeFocusChecks += 1;
				},
				async (requestFocus, input) => {
					const sibling = await WebviewWindow.getByLabel("win-focus-sibling");
					if (!sibling) throw new Error("missing isolated sibling window");
					await sibling.show();
					await sibling.setFocus();
					await waitFor(
						() => !document.hasFocus() && !currentWindowIsFocused(),
						"inactive source window",
					);
					let focusedAt: number | undefined;
					let trustedInput = false;
					let inputEvents = 0;
					let keydowns = 0;
					let composing = false;
					const documentEvents: object[] = [];
					const onDocumentKey = (event: KeyboardEvent) => {
						documentEvents.push({
							type: event.type,
							target:
								event.target instanceof Element ? event.target.tagName : null,
							trusted: event.isTrusted,
						});
					};
					const onFocus = () => {
						focusedAt = performance.now();
					};
					const onKeydown = () => {
						keydowns += 1;
					};
					const onInput = (event: Event) => {
						inputEvents += 1;
						trustedInput = event.isTrusted;
						if (event instanceof InputEvent) composing = event.isComposing;
					};
					input.addEventListener("focus", onFocus);
					input.addEventListener("keydown", onKeydown);
					input.addEventListener("input", onInput);
					document.addEventListener("keydown", onDocumentKey, true);
					document.addEventListener("keyup", onDocumentKey, true);
					const startedAt = performance.now();
					try {
						requestFocus();
						await nativeWindow.setFocus();
						await waitFor(
							() =>
								currentWindowIsInputReady() && document.activeElement === input,
							"single activation input focus",
						);
						await fetch("/__qa_log", {
							method: "POST",
							body: JSON.stringify(["pane-focus-activation-ready", { runId }]),
							signal: AbortSignal.timeout(2_000),
						});
						await waitFor(() => input.value === "x", "native first character");
						if (focusedAt === undefined || !trustedInput)
							throw new Error("missing native activation input evidence");
						activation = {
							focusRequests: 1,
							firstInput: input.value,
							trustedInput,
							focusMs: focusedAt - startedAt,
						};
					} catch (error) {
						throw new Error(
							`${String(error)}; native input observation: ${JSON.stringify({
								focused: document.activeElement === input,
								focusMs: focusedAt === undefined ? null : focusedAt - startedAt,
								inputEvents,
								keydowns,
								trustedInput,
								composing,
								documentFocused: document.hasFocus(),
								nativeFocused: currentWindowIsFocused(),
								documentEvents,
								valueCodePoints: Array.from(input.value, (character) =>
									character.codePointAt(0),
								),
							})}`,
						);
					} finally {
						input.removeEventListener("focus", onFocus);
						input.removeEventListener("keydown", onKeydown);
						input.removeEventListener("input", onInput);
						document.removeEventListener("keydown", onDocumentKey, true);
						document.removeEventListener("keyup", onDocumentKey, true);
						await sibling.hide();
					}
				},
			);
			await publish({
				pass: true,
				nativeFocusChecks,
				observations,
				activation,
			});
		};
		const publish = async (result: object) => {
			const response = await fetch("/__qa_log", {
				method: "POST",
				body: JSON.stringify([
					"pane-focus-history",
					{
						schemaVersion: 1,
						runId,
						nativeWindowLabel: nativeWindow.label,
						keyboardSource: "synthetic-dom",
						...result,
					},
				]),
				signal: AbortSignal.timeout(2_000),
			});
			if (!response.ok)
				throw new Error("pane focus QA result publication failed");
		};
		void run()
			.catch((error) => publish({ pass: false, error: String(error) }))
			.catch((error) => console.error("[pane-focus-history-qa]", error))
			.finally(() =>
				nativeWindow
					.hide()
					.catch((error) =>
						console.error("[pane-focus-history-qa:hide]", error),
					),
			);
		return () => {
			disposed = true;
		};
	}, []);
	return (
		<div
			ref={container}
			className="dockview-theme-dark"
			style={{ width: 900, height: 600 }}
		/>
	);
}

async function waitFor(ready: () => boolean, label: string): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (!ready()) {
		if (performance.now() >= deadline)
			throw new Error(`timed out waiting for ${label}`);
		await sleep(25);
	}
}
