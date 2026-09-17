// @vitest-environment jsdom

import { create } from "@bufbuild/protobuf";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	type InputReceipt,
	InputReceiptSchema,
	InputWrittenToPtySchema,
} from "@/contracts/terminalStateProtocol";
import {
	type CliPaneActionDependencies,
	dispatchCliPaneActionRequest,
} from "@/lib/cli/cliPaneActions";
import {
	invokePaneAction,
	registerPaneActions,
} from "@/lib/workspace/pane/paneActionRegistry";
import { capturePaneQuickCommandTarget } from "@/lib/workspace/pane/paneQuickCommandTarget";
import { useStructuredTerminalQuickCommands } from "./useStructuredTerminalQuickCommands";

describe("ordinary terminal pane input", () => {
	it.each([false, true])(
		"keeps input on its admitted attachment (replaced=%s)",
		async (replaced) => {
			const paneId = "pane-attachment-claim";
			const removeStatus = registerPaneActions({
				owner: {},
				paneId,
				status: "attached",
				actions: {},
			});
			const receiptObserverRef = {
				current: undefined as ((receipt: InputReceipt) => void) | undefined,
			};
			const sendUserInput = vi.fn(() => {
				queueMicrotask(() =>
					receiptObserverRef.current?.(
						create(InputReceiptSchema, {
							inReplyToRecordId: 1n,
							outcome: {
								case: "writtenToPty",
								value: create(InputWrittenToPtySchema),
							},
						}),
					),
				);
				return 1n;
			});
			const options = {
				paneId,
				surfaceId: "fixture-surface",
				attachmentId: "attachment-original",
				terminalEpoch: "epoch-original",
				inputReady: true,
				observerIdRef: { current: "attachment-original" },
				receiptObserverRef,
				readLatestCompleteFrame: () => null,
				sendUserInput,
				focus: vi.fn(),
			};
			const view = renderHook(
				(props) => useStructuredTerminalQuickCommands(props),
				{ initialProps: options },
			);
			const complete = vi.fn<CliPaneActionDependencies["complete"]>(
				async () => {},
			);
			try {
				await dispatchCliPaneActionRequest(
					{
						reqId: "attachment-request",
						action: "pane.act",
						params: {
							targetPanelId: paneId,
							actionId: "terminal.input",
							arguments: { text: "original input", appendEnter: false },
						},
					},
					{
						claim: async () => {
							act(() =>
								view.rerender(
									replaced
										? {
												...options,
												attachmentId: "attachment-new",
												terminalEpoch: "epoch-new",
												observerIdRef: { current: "attachment-new" },
											}
										: { ...options, focus: vi.fn() },
								),
							);
							return true;
						},
						complete,
						isFallbackWindow: () => false,
						delay: async () => {},
					},
				);
				expect(sendUserInput).toHaveBeenCalledTimes(replaced ? 0 : 1);
				expect(complete.mock.calls[0][1]).toMatchObject(
					replaced
						? { ok: false, error: { code: "pane_changed" } }
						: { ok: true, pane: { result: { outcome: "applied" } } },
				);
			} finally {
				view.unmount();
				removeStatus();
			}
		},
	);

	it.each([false, true])(
		"preserves editor focus during PTY delivery with appendEnter=%s",
		async (appendEnter) => {
			const paneId = "term:ssh-test";
			const removeStatus = registerPaneActions({
				owner: {},
				paneId,
				status: "attached",
				actions: {},
			});
			let recordId = 40n;
			const editor = document.createElement("textarea");
			const terminal = document.createElement("textarea");
			editor.value = "unfinished draft";
			document.body.append(editor, terminal);
			editor.focus();
			editor.setSelectionRange(3, 7);
			const options = {
				paneId,
				surfaceId: "main:space:term:ssh-test",
				attachmentId: "attachment-1",
				terminalEpoch: "terminal-1",
				inputReady: true,
				observerIdRef: { current: "attachment-1" },
				receiptObserverRef: {
					current: undefined as ((receipt: InputReceipt) => void) | undefined,
				},
				readLatestCompleteFrame: () => null,
				sendUserInput: vi.fn(() => ++recordId),
				focus: vi.fn(() => terminal.focus()),
			};
			const view = renderHook(() =>
				useStructuredTerminalQuickCommands(options),
			);
			try {
				let settled = false;
				const result = invokePaneAction(paneId, "terminal.input", {
					text: "hostname",
					appendEnter,
				}).then((value) => {
					settled = true;
					return value;
				});
				await Promise.resolve();
				expect(options.sendUserInput).toHaveBeenCalledOnce();
				expect(document.activeElement).toBe(editor);
				expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 7]);
				expect(settled).toBe(false);
				const deliver = (id: bigint) =>
					options.receiptObserverRef.current?.(
						create(InputReceiptSchema, {
							inReplyToRecordId: id,
							outcome: {
								case: "writtenToPty",
								value: create(InputWrittenToPtySchema),
							},
						}),
					);
				deliver(99n);
				expect(options.sendUserInput).toHaveBeenCalledOnce();
				deliver(41n);
				if (appendEnter) {
					expect(options.sendUserInput).toHaveBeenCalledTimes(2);
					expect(settled).toBe(false);
					deliver(42n);
				}
				expect(await result).toMatchObject({
					ok: true,
					result: { outcome: "applied" },
				});
				expect(document.activeElement).toBe(editor);
				expect(options.focus).not.toHaveBeenCalled();
				const menuTarget = capturePaneQuickCommandTarget(options.surfaceId);
				expect(menuTarget).toBeDefined();
				const menuInput = menuTarget?.({
					id: "menu",
					label: "Status",
					text: "hostname",
					appendEnter: false,
				});
				expect(document.activeElement).toBe(terminal);
				deliver(recordId);
				await menuInput;
				const interrupted = invokePaneAction(paneId, "terminal.input", {
					text: "hostname",
					appendEnter: true,
				});
				view.unmount();
				expect(await interrupted).toMatchObject({
					ok: true,
					result: { outcome: "failed", error: { retryable: false } },
				});
				expect(options.sendUserInput).toHaveBeenCalledTimes(
					appendEnter ? 4 : 3,
				);
				expect(
					await invokePaneAction(paneId, "terminal.input", {
						text: "hostname",
					}),
				).toMatchObject({
					ok: false,
					error: { code: "pane_action_unavailable" },
				});
			} finally {
				view.unmount();
				removeStatus();
				editor.remove();
				terminal.remove();
			}
		},
	);
});
