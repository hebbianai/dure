// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginSidebarContent } from "@/components/plugins/PluginSidebarContent";
import { setLang } from "@/lib/i18n";
import type { DurePluginViewContainer } from "@/lib/plugins/durePlugins";

vi.mock("@/components/plugins/PluginViewHost", () => ({
	PluginViewHost: ({
		contribution,
	}: {
		contribution: DurePluginViewContainer;
	}) => <div>plugin host: {contribution.container.id}</div>,
}));

const contribution = {
	container: { id: "dure.beads.issues" },
} as DurePluginViewContainer;

afterEach(() => {
	cleanup();
	setLang("ko");
});

it("keeps the last-good plugin view mounted during refresh or failure", () => {
	const { rerender } = render(
		<PluginSidebarContent
			contribution={contribution}
			loadState="loading"
			onOpenCatalog={vi.fn()}
			onRetry={vi.fn()}
		/>,
	);
	expect(screen.getByText("plugin host: dure.beads.issues")).toBeTruthy();

	rerender(
		<PluginSidebarContent
			contribution={contribution}
			loadState="error"
			onOpenCatalog={vi.fn()}
			onRetry={vi.fn()}
		/>,
	);
	expect(screen.getByText("plugin host: dure.beads.issues")).toBeTruthy();
	expect(screen.queryByRole("alert")).toBeNull();
});

it("distinguishes loading, failure, and unavailable states", () => {
	const onOpenCatalog = vi.fn();
	const onRetry = vi.fn();
	const { rerender } = render(
		<PluginSidebarContent
			contribution={undefined}
			loadState="loading"
			onOpenCatalog={onOpenCatalog}
			onRetry={onRetry}
		/>,
	);
	expect(screen.getByRole("status").textContent).toContain("불러오는 중…");

	rerender(
		<PluginSidebarContent
			contribution={undefined}
			loadState="error"
			onOpenCatalog={onOpenCatalog}
			onRetry={onRetry}
		/>,
	);
	expect(screen.getByRole("alert").textContent).toContain(
		"플러그인 보기를 불러오지 못했습니다.",
	);
	fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
	fireEvent.click(screen.getByRole("button", { name: "플러그인 목록 열기" }));
	expect(onRetry).toHaveBeenCalledTimes(1);
	expect(onOpenCatalog).toHaveBeenCalledTimes(1);

	rerender(
		<PluginSidebarContent
			contribution={undefined}
			loadState="ready"
			onOpenCatalog={onOpenCatalog}
			onRetry={onRetry}
		/>,
	);
	expect(screen.getByRole("status").textContent).toContain(
		"사용할 수 있는 플러그인 보기가 없습니다.",
	);
	expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
});

it("translates the unavailable state and catalog action", () => {
	setLang("en");
	render(
		<PluginSidebarContent
			contribution={undefined}
			loadState="ready"
			onOpenCatalog={vi.fn()}
			onRetry={vi.fn()}
		/>,
	);

	expect(screen.getByRole("status").textContent).toContain(
		"No plugin views are available.",
	);
	expect(
		screen.getByRole("button", { name: "Open plugin catalog" }),
	).toBeTruthy();
});
