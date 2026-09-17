// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import {
	DockviewReact,
	type DockviewApi,
	type IDockviewPanelProps,
} from "dockview-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateOnPointerDown } from "./Workspace";

afterEach(cleanup);

describe("workspace pointer activation", () => {
	it.each(["onlyWhenVisible", "always"] as const)(
		"keeps %s pane content mounted through the first pointer press",
		async (renderer) => {
			const clicked = vi.fn();
			const Content = activateOnPointerDown(({ api }: IDockviewPanelProps) => (
				<button
					type="button"
					onPointerDown={(event) => event.stopPropagation()}
					onClick={clicked}
				>
					{api.id}
				</button>
			));
			let dock!: DockviewApi;
			const { container } = render(
				<DockviewReact
					components={{ content: Content }}
					onReady={({ api }) => {
						dock = api;
					}}
				/>,
			);
			act(() => {
				dock.layout(800, 600);
				dock.addPanel({ id: "left", component: "content", renderer });
				dock.addPanel({
					id: "right",
					component: "content",
					renderer,
					position: { referencePanel: "left", direction: "right" },
				});
			});
			const button = await screen.findByRole("button", { name: "left" });
			const observer = new MutationObserver(() => {});
			observer.observe(container, { childList: true, subtree: true });
			expect(dock.activePanel?.id).toBe("right");
			fireEvent.pointerDown(button, { button: 0 });
			const detached = observer
				.takeRecords()
				.flatMap((record) => [...record.removedNodes])
				.some((node) => node.contains(button));
			observer.disconnect();
			expect(dock.activePanel?.id).toBe("left");
			// Detaching even the same DOM node during pointerdown cancels WebKit's click.
			expect(detached).toBe(false);
			fireEvent.pointerUp(button, { button: 0 });
			fireEvent.click(button);
			expect(clicked).toHaveBeenCalledOnce();
		},
	);
});
