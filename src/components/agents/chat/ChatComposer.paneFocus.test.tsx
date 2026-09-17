// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createDockview } from "dockview-react";
import { afterEach, describe, expect, it } from "vitest";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { installPaneShortcuts } from "@/lib/workspace/pane/paneShortcuts";
import { useStore } from "@/store";
import { chatComposerSessionFixture as session } from "@/test/chatComposerSessionFixture";
import { ChatComposer } from "./ChatComposer";
import { StructuredAgentChatSurface } from "./StructuredAgentChatSurface";

afterEach(cleanup);

describe("ChatComposer directional pane input", () => {
	it.each([
		["ArrowRight", "right", 400, 0],
		["ArrowLeft", "left", -400, 0],
		["ArrowDown", "below", 0, 400],
		["ArrowUp", "above", 0, -400],
	] as const)(
		"accepts input immediately after Command+Option+%s",
		(key, direction, x, y) => {
			const desktopId = `qa-chat-input-${key}`;
			const previous = useStore.getState();
			const container = document.createElement("div");
			document.body.append(container);
			const dock = createDockview(container, {
				createComponent: () => ({
					element: document.createElement("div"),
					init() {},
					dispose() {},
				}),
			});
			dock.layout(800, 800);
			const first = dock.addPanel({ id: "qa:source", component: "chat" });
			const target = dock.addPanel({
				id: "qa:target",
				component: "chat",
				position: { referencePanel: first, direction },
			});
			first.group.element.getBoundingClientRect = () =>
				new DOMRect(0, 0, 300, 300);
			target.group.element.getBoundingClientRect = () =>
				new DOMRect(x, y, 300, 300);
			const source = document.createElement("textarea");
			first.group.element.append(source);
			const view = render(
				<ChatComposer
					paneApi={target.api}
					session={session("codex")}
					disabled={false}
				/>,
				{
					container: target.group.element.querySelector(
						".dv-content-container > div",
					) as HTMLElement,
				},
			);
			const input = view.getByRole("textbox");
			registerDockview(desktopId, dock);
			useStore.setState({ activeSpaceId: desktopId, shortcutOverrides: {} });
			const stop = installPaneShortcuts(desktopId);
			const navigate = () =>
				act(() => {
					source.dispatchEvent(
						new KeyboardEvent("keydown", {
							key,
							altKey: true,
							metaKey: true,
							bubbles: true,
							cancelable: true,
						}),
					);
				});
			try {
				first.api.setActive();
				source.focus();
				window.dispatchEvent(new Event("focus"));
				expect(dock.activePanel?.id).toBe(first.id);
				navigate();
				expect(dock.activePanel?.id).toBe(target.id);
				expect(input.isConnected).toBe(true);
				expect(document.activeElement).toBe(input);
				fireEvent.change(document.activeElement as HTMLElement, {
					target: { value: "immediate input" },
				});
				expect((input as HTMLTextAreaElement).value).toBe("immediate input");
				for (const interrupted of [false, true]) {
					act(() => first.api.setActive());
					source.focus();
					view.rerender(
						<ChatComposer
							paneApi={target.api}
							session={session("codex")}
							disabled
						/>,
					);
					navigate();
					expect(document.activeElement).not.toBe(input);
					if (interrupted) {
						fireEvent.pointerDown(source);
						source.focus();
					}
					view.rerender(
						<ChatComposer
							paneApi={target.api}
							session={session("codex")}
							disabled={false}
						/>,
					);
					expect(document.activeElement).toBe(interrupted ? source : input);
				}
				for (const interrupted of [false, true]) {
					act(() => first.api.setActive());
					source.focus();
					const connecting = {
						...session("codex"),
						phase: "connecting" as const,
						page: undefined,
					};
					view.rerender(
						<StructuredAgentChatSurface
							session={connecting}
							paneApi={target.api}
						/>,
					);
					navigate();
					expect(view.queryByRole("textbox")).toBeNull();
					if (interrupted) {
						fireEvent.pointerDown(source);
						source.focus();
					}
					view.rerender(
						<StructuredAgentChatSurface
							session={session("codex")}
							paneApi={target.api}
						/>,
					);
					expect(document.activeElement).toBe(
						interrupted ? source : view.getByRole("textbox"),
					);
				}
			} finally {
				stop();
				view.unmount();
				unregisterDockview(desktopId, dock);
				dock.dispose();
				container.remove();
				useStore.setState({
					activeSpaceId: previous.activeSpaceId,
					shortcutOverrides: previous.shortcutOverrides,
				});
			}
		},
	);
});
