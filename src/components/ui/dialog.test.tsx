// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { focusByKeyboard, pressKey, pressPointer } from "@/test/keyboardFocus";

function renderDialog(children?: React.ReactNode) {
	render(
		<Dialog open>
			<DialogContent aria-describedby={undefined}>
				<DialogTitle>Connections</DialogTitle>
				{children}
			</DialogContent>
		</Dialog>,
	);
	return screen.getByRole("dialog");
}

describe("DialogContent", () => {
	afterEach(() => {
		cleanup();
		pressKey();
	});

	it("names its close button for assistive tech but shows no hint — the glyph says it", () => {
		renderDialog();

		focusByKeyboard(screen.getByRole("button", { name: t("common.close") }));
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("opened by a click, takes focus itself instead of lighting up its first icon button", () => {
		pressPointer();
		const dialog = renderDialog(<IconButton title="Pin to repo" />);

		expect(document.activeElement).toBe(dialog);
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("opened by a click onto a form, is ready to type into", () => {
		pressPointer();
		renderDialog(<Input aria-label="Host" />);

		expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Host" }));
	});

	it("opened from the keyboard, focuses its first control without announcing it in a hint", () => {
		pressKey(document, "Enter");
		renderDialog(<IconButton title="Pin to repo" />);

		const pin = screen.getByRole("button", { name: "Pin to repo" });
		expect(document.activeElement).toBe(pin);
		expect(screen.queryByRole("tooltip")).toBeNull();

		// Walking back onto it is what asks for the hint.
		focusByKeyboard(screen.getByRole("button", { name: t("common.close") }));
		focusByKeyboard(pin);
		expect(screen.getByRole("tooltip").textContent).toBe("Pin to repo");
	});

	it("still lets a caller decide where focus goes", () => {
		pressPointer();
		render(
			<Dialog open>
				<DialogContent
					aria-describedby={undefined}
					onOpenAutoFocus={(event) => event.preventDefault()}
				>
					<DialogTitle>Connections</DialogTitle>
				</DialogContent>
			</Dialog>,
		);

		expect(document.activeElement).not.toBe(screen.getByRole("dialog"));
	});
});
