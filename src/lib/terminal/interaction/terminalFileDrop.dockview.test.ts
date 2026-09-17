// @vitest-environment jsdom
import { createDockview, getPanelData } from "dockview-react";
import { describe, expect, it, vi } from "vitest";
import { installTerminalFileDrop } from "./terminalFileDrop";

describe("terminal file hover during an installed Dockview drag", () => {
	it.each(["cancel", "move"])(
		"avoids native hover type reads, then accepts files after %s",
		async (retirement) => {
			const container = document.createElement("div");
			document.body.append(container);
			const api = createDockview(container, {
				createComponent: () => ({
					element: document.createElement("div"),
					init() {},
				}),
			});
			api.layout(1000, 600);
			const target = api.addPanel({ id: "target", component: "test" });
			const source = api.addPanel({
				id: "source",
				component: "test",
				position: { referencePanel: target, direction: "right" },
			});
			const host = document.createElement("div");
			const child = document.createElement("span");
			host.append(child);
			// The terminal surface is separate so only its capture handler decides
			// whether to prevent default, independently of Dockview's drop targets.
			document.body.append(host);
			const options = {
				prepareFiles: vi.fn(async () => ["/tmp/a b.txt"]),
				activateInputTarget: vi.fn(),
				forwardUserInput: vi.fn(),
				onError: vi.fn(),
			};
			const stop = installTerminalFileDrop(host, options);
			const bubbles = vi.fn();
			child.addEventListener("dragover", bubbles);
			const readTypes = vi.fn(() => ["application/x-dure-pane"]);
			const transfer = {
				get types() {
					return readTypes();
				},
				items: [],
				files: [
					{
						name: "a b.txt",
						size: 1,
						arrayBuffer: async () => new Uint8Array([104]).buffer,
					},
				],
				setData: vi.fn(),
				setDragImage: vi.fn(),
			};
			const event = (name: string, dataTransfer: unknown = transfer) => {
				const e = new MouseEvent(name, { bubbles: true, cancelable: true });
				Object.defineProperty(e, "dataTransfer", { value: dataTransfer });
				return e;
			};
			const tab = source.group.element.querySelector<HTMLElement>(".dv-tab")!;
			try {
				expect(getPanelData()).toBeUndefined();
				const foreign = event("dragover");
				child.dispatchEvent(foreign);
				expect(readTypes).toHaveBeenCalledOnce();
				expect(foreign.defaultPrevented).toBe(false);
				readTypes.mockClear();
				child.dispatchEvent(event("dragover", null));
				expect(readTypes).not.toHaveBeenCalled();

				tab.dispatchEvent(event("dragstart"));
				expect(getPanelData()).toMatchObject({
					viewId: api.id,
					panelId: source.id,
				});
				readTypes.mockClear();
				bubbles.mockClear();
				const hover = event("dragover");
				child.dispatchEvent(hover);
				expect(hover.defaultPrevented).toBe(false);
				expect(bubbles).toHaveBeenCalledOnce();
				expect(readTypes).not.toHaveBeenCalled();
				expect(options.prepareFiles).not.toHaveBeenCalled();
				expect(options.activateInputTarget).not.toHaveBeenCalled();

				// Drop still validates the payload even with a local transfer active.
				child.dispatchEvent(event("drop"));
				expect(readTypes).toHaveBeenCalledOnce();
				expect(options.forwardUserInput).not.toHaveBeenCalled();
				if (retirement === "move") {
					const before = api.toJSON().grid;
					source.api.moveTo({ group: target.group, position: "bottom" });
					expect(api.toJSON().grid).not.toEqual(before);
				}
				tab.dispatchEvent(event("dragend"));
				expect(getPanelData()).toBeUndefined();

				readTypes.mockReturnValue(["Files"]).mockClear();
				const files = event("dragover");
				child.dispatchEvent(files);
				expect(files.defaultPrevented).toBe(true);
				expect(readTypes).toHaveBeenCalledOnce();
				const drop = event("drop");
				child.dispatchEvent(drop);
				expect(drop.defaultPrevented).toBe(true);
				await vi.waitFor(() =>
					expect(options.forwardUserInput).toHaveBeenCalledExactlyOnceWith(
						"'/tmp/a b.txt' ",
					),
				);
				expect(options.prepareFiles).toHaveBeenCalledExactlyOnceWith([
					{ fileName: "a b.txt", dataB64: "aA==" },
				]);
				expect(options.activateInputTarget).toHaveBeenCalledOnce();
				expect(options.onError).not.toHaveBeenCalled();

				stop();
				readTypes.mockClear();
				child.dispatchEvent(event("dragover"));
				child.dispatchEvent(event("drop"));
				expect(readTypes).not.toHaveBeenCalled();
				expect(options.forwardUserInput).toHaveBeenCalledOnce();
			} finally {
				tab.dispatchEvent(event("dragend"));
				await new Promise((resolve) => setTimeout(resolve, 0));
				stop();
				api.dispose();
				container.remove();
				host.remove();
			}
			expect(getPanelData()).toBeUndefined();
		},
	);
});
