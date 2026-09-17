// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalPage } from "@/components/settings/TerminalPage";
import { t } from "@/lib/i18n";
import { DEFAULT_TERMINAL_PREFS } from "@/lib/terminal/terminalPrefs";
import { useStore } from "@/store";

afterEach(() => {
	cleanup();
	useStore.setState({ terminalPrefs: { ...DEFAULT_TERMINAL_PREFS } });
});

describe("TerminalPage", () => {
	it("shows only settings backed by the structured terminal", () => {
		render(<TerminalPage />);

		expect(screen.getAllByRole("switch")).toHaveLength(2);
		expect(
			screen.getByRole("switch", {
				name: t("settings.terminal.copyOnSelect.title"),
			}),
		).toBeTruthy();
		expect(
			screen.getByRole("switch", {
				name: t("settings.terminal.osc52.title"),
			}),
		).toBeTruthy();
	});

	it("updates each active terminal preference independently", () => {
		render(<TerminalPage />);

		fireEvent.click(
			screen.getByRole("switch", {
				name: t("settings.terminal.copyOnSelect.title"),
			}),
		);
		expect(useStore.getState().terminalPrefs).toEqual({
			copyOnSelect: false,
			osc52: true,
		});

		fireEvent.click(
			screen.getByRole("switch", {
				name: t("settings.terminal.osc52.title"),
			}),
		);
		expect(useStore.getState().terminalPrefs).toEqual({
			copyOnSelect: false,
			osc52: false,
		});
	});
});
