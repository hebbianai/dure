// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RefreshButton } from "@/components/ui/refresh-button";
import { t } from "@/lib/i18n";
import { focusByKeyboard } from "@/test/keyboardFocus";

describe("RefreshButton", () => {
	afterEach(cleanup);

	it("keeps its name but shows no hint for the plain refresh label", () => {
		render(<RefreshButton />);
		const button = screen.getByRole("button", { name: t("common.refresh") });

		focusByKeyboard(button);
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("drops the hint when a caller resolves its title to the plain label", () => {
		render(<RefreshButton title={t("common.refresh")} />);

		focusByKeyboard(screen.getByRole("button"));
		expect(screen.queryByRole("tooltip")).toBeNull();
	});

	it("shows the hint for a sharper title", () => {
		render(<RefreshButton title="Reload and discard edits" />);

		focusByKeyboard(screen.getByRole("button"));
		expect(screen.getByRole("tooltip").textContent).toBe(
			"Reload and discard edits",
		);
	});

	it("lets a caller ask for the hint back", () => {
		render(<RefreshButton showTooltip />);

		focusByKeyboard(screen.getByRole("button"));
		expect(screen.getByRole("tooltip").textContent).toBe(t("common.refresh"));
	});
});
