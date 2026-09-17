// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/search/NativeSearchDialog", () => ({
	NativeSearchDialog: ({
		request,
	}: {
		request: { revision: number; initialQuery: string };
	}) => <div data-testid="native-search-loaded">{request.initialQuery}</div>,
}));

import { LazyNativeSearchDialog } from "@/components/search/LazyNativeSearchDialog";

afterEach(() => cleanup());

describe("LazyNativeSearchDialog", () => {
	it("does not load a surface before activation and preserves the first shortcut", async () => {
		render(<LazyNativeSearchDialog />);
		expect(screen.queryByTestId("native-search-loaded")).toBeNull();

		fireEvent.keyDown(window, { key: "p", metaKey: true });

		expect(await screen.findByTestId("native-search-loaded")).toBeTruthy();
	});

	it("preserves an event query while the dialog module activates", async () => {
		render(<LazyNativeSearchDialog />);

		window.dispatchEvent(
			new CustomEvent("dure:open-native-search", {
				detail: { initialQuery: "@ codex" },
			}),
		);

		expect(await screen.findByText("@ codex")).toBeTruthy();
	});
});
