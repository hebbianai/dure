// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { t } from "@/lib/i18n";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { useStore } from "@/store";

vi.mock("@/components/spaces/SpacesPane", () => ({
	SpacesPane: () => <section aria-label="Spaces content" />,
}));

vi.mock("@/components/automations/AutomationsPane", () => ({
	AutomationsPane: () => <section aria-label="Automations content" />,
}));

beforeEach(() => {
	useWindowSidebarStore.setState({ open: true, tab: "automations" });
	useStore.setState((state) => ({
		uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" },
	}));
});

afterEach(() => {
	cleanup();
	vi.unstubAllEnvs();
	useWindowSidebarStore.setState({ open: true, tab: "spaces" });
});

it.each(["basic", "basic-only"])(
	"projects persisted Automations to Spaces under %s policy",
	async (policy) => {
		if (policy === "basic-only")
			vi.stubEnv("VITE_DURE_INTERFACE_MODE_POLICY", "basic-only");
		else
			useStore.setState((state) => ({
				uiPrefs: { ...state.uiPrefs, interfaceMode: "basic" },
			}));
		render(<Sidebar />);

		expect(
			await screen.findByRole("region", { name: "Spaces content" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("region", { name: "Automations content" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: t("automations.title") }),
		).toBeNull();
		expect(useWindowSidebarStore.getState().tab).toBe("automations");
	},
);

it("unmounts Automations in Basic and restores its selection in Pro", async () => {
	render(<Sidebar />);
	expect(
		await screen.findByRole("region", { name: "Automations content" }),
	).toBeTruthy();

	act(() => {
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, interfaceMode: "basic" },
		}));
	});
	expect(
		screen.queryByRole("button", { name: t("automations.title") }),
	).toBeNull();
	expect(
		screen.queryByRole("region", { name: "Automations content" }),
	).toBeNull();
	expect(screen.getByRole("region", { name: "Spaces content" })).toBeTruthy();
	expect(useWindowSidebarStore.getState().tab).toBe("automations");

	act(() => {
		useStore.setState((state) => ({
			uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" },
		}));
	});
	expect(
		await screen.findByRole("region", { name: "Automations content" }),
	).toBeTruthy();
	expect(screen.queryByRole("region", { name: "Spaces content" })).toBeNull();
	expect(
		screen
			.getByRole("button", { name: t("automations.title") })
			.getAttribute("aria-pressed"),
	).toBe("true");
});

it("shows Automations and Dure Tag in production Beta", async () => {
	vi.stubEnv("PROD", true);
	render(<Sidebar />);

	expect(
		await screen.findByRole("region", { name: "Automations content" }),
	).toBeTruthy();
	expect(
		screen.getByRole("button", { name: t("automations.title") }),
	).toBeTruthy();
	expect(screen.getByRole("button", { name: t("tag.title") })).toBeTruthy();
});
