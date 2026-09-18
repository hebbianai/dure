// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IconButton } from "@/components/ui/icon-button";
import { UsageMeterPopover } from "@/components/usage/UsageMeterPopover";
import { pressKey, pressPointer } from "@/test/keyboardFocus";

function open() {
	render(
		<UsageMeterPopover provider="codex" pct={46} tip="Codex usage">
			<IconButton title="Refresh usage" />
		</UsageMeterPopover>,
	);
	fireEvent.click(screen.getByRole("button"));
	return screen.getByRole("dialog");
}

describe("UsageMeterPopover", () => {
	afterEach(() => {
		cleanup();
		pressKey();
	});

	it("opened by a click, takes focus itself instead of lighting up its refresh button", () => {
		pressPointer();
		const popover = open();

		expect(document.activeElement).toBe(popover);
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("opened from the keyboard, focuses its first control", () => {
		pressKey(document, "Enter");
		open();

		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Refresh usage" }),
		);
	});
});
