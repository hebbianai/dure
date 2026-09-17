// @vitest-environment jsdom

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/sidebar/Sidebar";
import type { DurePluginViewContainer } from "@/lib/plugins/durePlugins";
import type { PluginCatalogResourceSnapshot } from "@/lib/plugins/pluginCatalogResource";
import { pluginSidebarContainerKey } from "@/lib/plugins/pluginSidebarSelection";
import { t } from "@/lib/i18n";
import {
	createWindowSidebarStore,
	useWindowSidebarStore,
} from "@/lib/sidebar/windowSidebarStore";
import {
	initialWindowSidebarState,
	MAIN_WINDOW_SIDEBAR_DEFAULT,
	serializeWindowSidebarState,
} from "@/lib/sidebar/windowSidebarState";
import { useStore } from "@/store";

interface CatalogMockState {
	containers: DurePluginViewContainer[];
	loadState: PluginCatalogResourceSnapshot["loadState"];
}

const mocks = vi.hoisted(() => ({
	pluginEnabled: true,
	catalogState: {
		containers: [],
		loadState: "idle",
	} as CatalogMockState,
	refresh: vi.fn(),
}));

// Permission transitions are covered by ActivityRail and the shared resource.
vi.mock("@/components/plugins/usePluginPermissionWorkspace", () => ({
	usePluginPermissionWorkspace: () => ({
		permission: {
			enabled: mocks.pluginEnabled,
			plan_comparison: "matches_reviewed_plan",
		},
		permissionLoaded: true,
		permissionError: null,
	}),
}));

vi.mock("@/components/plugins/usePluginViewCatalog", () => ({
	refreshPluginViewCatalog: mocks.refresh,
	usePluginViewCatalog: () => ({
		snapshot: null,
		catalog: null,
		error: null,
		...mocks.catalogState,
	}),
}));

vi.mock("@/components/plugins/PluginViewHost", () => ({
	PluginViewHost: ({
		contribution,
	}: {
		contribution: DurePluginViewContainer;
	}) => (
		<div
			data-testid="plugin-host"
			data-view-contribution={contribution.contributionId}
		>
			plugin host: {contribution.container.id}
		</div>
	),
}));

vi.mock("@/components/sidebar/DurePluginsPane", () => ({
	DurePluginsPane: () => <div>plugin catalog</div>,
}));

vi.mock("@/components/spaces/SpacesPane", () => ({
	SpacesPane: () => <div>spaces</div>,
}));

const contribution = {
	plugin: { manifest: { id: "dure.beads" } },
	contributionId: "dure.beads.views",
	container: {
		id: "dure.beads.issues",
		location: "primary_sidebar",
		title: { default: "Beads" },
		icon: "list_todo",
	},
	views: [{ id: "dure.beads.issues.list" }],
} as DurePluginViewContainer;

const fallbackContribution = {
	...contribution,
	container: {
		...contribution.container,
		id: "dure.beads.inbox",
		title: { default: "Inbox" },
		icon: "inbox",
	},
} as DurePluginViewContainer;

const duplicateContainerContribution = {
	...contribution,
	contributionId: "dure.beads.alternate-views",
	container: {
		...contribution.container,
		title: { default: "Beads alternate" },
	},
} as DurePluginViewContainer;

const githubContribution = {
	...contribution,
	plugin: { manifest: { id: "dure.github" } },
	contributionId: "dure.github.views",
	container: {
		...contribution.container,
		id: "dure.github.issues",
		title: { default: "GitHub" },
	},
} as DurePluginViewContainer;

function setCatalog(
	loadState: PluginCatalogResourceSnapshot["loadState"],
	containers: DurePluginViewContainer[] = [],
) {
	mocks.catalogState = { containers, loadState };
}

beforeEach(() => {
	// Shared plugin flows run in Pro; Basic and production are covered below.
	useStore.setState((state) => ({
		uiPrefs: { ...state.uiPrefs, interfaceMode: "pro" as const },
	}));
	setCatalog("idle");
	mocks.pluginEnabled = true;
	useWindowSidebarStore.setState({
		open: true,
		tab: "plugin",
		pluginSelection: {
			containerKey: pluginSidebarContainerKey(contribution),
			viewId: null,
		},
	});
});

it("opens an exact container from pane navigation even while the sidebar is collapsed", async () => {
	setCatalog("ready", [fallbackContribution, contribution]);
	useWindowSidebarStore.setState({ open: false, tab: "spaces" });
	render(<Sidebar />);
	await act(async () => {
		useWindowSidebarStore.getState().openPluginView({
			containerKey: pluginSidebarContainerKey(contribution),
			viewId: contribution.views[0].id,
		});
		await import("@/components/plugins/PluginSidebarContent");
	});
	expect(
		await screen.findByText("plugin host: dure.beads.issues"),
	).toBeTruthy();
	expect(
		screen.getByRole("button", { name: "Beads" }).getAttribute("aria-pressed"),
	).toBe("true");
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.unstubAllEnvs();
	useWindowSidebarStore.setState({ open: true, tab: "spaces" });
});

it.each(["basic", "production"])("opens and toggles Plugins without contributed views under %s policy", async (policy) => {
	if (policy === "production") vi.stubEnv("PROD", true);
	useStore.setState((state) => ({
		uiPrefs: { ...state.uiPrefs, interfaceMode: policy === "production" ? "pro" : "basic" },
	}));
	setCatalog("ready", []);
	useWindowSidebarStore.setState({ open: false, tab: "spaces", pluginSelection: null });
	render(<Sidebar />);
	const plugins = screen.getByRole("button", { name: t("common.plugin") });
	await act(async () => plugins.click());
	expect(await screen.findByText("plugin catalog")).toBeTruthy();
	expect(plugins.getAttribute("aria-pressed")).toBe("true");
	expect(plugins.getAttribute("aria-expanded")).toBe("true");
	act(() => plugins.click());
	expect(screen.queryByText("plugin catalog")).toBeNull();
	expect(plugins.getAttribute("aria-pressed")).toBe("true");
	expect(plugins.getAttribute("aria-expanded")).toBe("false");
});

it.each([true, false])(
	"restores GitHub after a fresh store starts with Beads first in the catalog (enabled=%s)",
	async (enabled) => {
		mocks.pluginEnabled = enabled;
		let saved: string | null = null;
		const previous = createWindowSidebarStore(
			MAIN_WINDOW_SIDEBAR_DEFAULT,
			(snapshot) => {
				saved = serializeWindowSidebarState(snapshot);
			},
		);
		previous.getState().openPluginView({
			containerKey: pluginSidebarContainerKey(githubContribution),
			viewId: null,
		});
		const restored = createWindowSidebarStore(
			initialWindowSidebarState("main", saved, null),
		);
		useWindowSidebarStore.setState({
			open: restored.getState().open,
			tab: restored.getState().tab,
			pluginSelection: restored.getState().pluginSelection,
		});
		setCatalog("ready", [contribution, githubContribution]);
		render(<Sidebar />);

		expect((await screen.findByTestId("plugin-host")).textContent).toBe(
			"plugin host: dure.github.issues",
		);
		expect(
			screen
				.getByRole("button", { name: "GitHub" })
				.getAttribute("aria-pressed"),
		).toBe("true");
	},
);

it("keeps an exact plugin route through loading and error, then retires it on confirmed removal", async () => {
	const { rerender } = render(<Sidebar />);

	expect((await screen.findByRole("status")).textContent).toContain(
		"불러오는 중…",
	);
	expect(useWindowSidebarStore.getState().tab).toBe("plugin");

	setCatalog("error");
	rerender(<Sidebar />);
	expect((await screen.findByRole("alert")).textContent).toContain(
		"플러그인 보기를 불러오지 못했습니다.",
	);
	expect(useWindowSidebarStore.getState().tab).toBe("plugin");

	setCatalog("ready", [contribution]);
	rerender(<Sidebar />);

	expect(
		await screen.findByText("plugin host: dure.beads.issues"),
	).toBeTruthy();
	expect(
		screen.getByRole("button", { name: "Beads" }).getAttribute("aria-pressed"),
	).toBe("true");
	expect(useWindowSidebarStore.getState().tab).toBe("plugin");

	setCatalog("loading", [contribution]);
	rerender(<Sidebar />);
	expect(
		await screen.findByText("plugin host: dure.beads.issues"),
	).toBeTruthy();
	expect(screen.queryByRole("status")).toBeNull();

	setCatalog("error", [contribution]);
	rerender(<Sidebar />);
	expect(
		await screen.findByText("plugin host: dure.beads.issues"),
	).toBeTruthy();
	expect(screen.queryByRole("alert")).toBeNull();

	setCatalog("ready");
	rerender(<Sidebar />);
	expect(await screen.findByText("spaces")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Beads" })).toBeNull();
	expect(useWindowSidebarStore.getState()).toMatchObject({
		tab: "spaces",
		pluginSelection: null,
	});

	setCatalog("ready", [contribution]);
	rerender(<Sidebar />);
	expect(screen.queryByTestId("plugin-host")).toBeNull();
	expect(useWindowSidebarStore.getState().tab).toBe("spaces");
	fireEvent.click(screen.getByRole("button", { name: "Beads" }));
	expect(
		await screen.findByText("plugin host: dure.beads.issues"),
	).toBeTruthy();
});

it("returns to Space rather than opening another plugin when the selected container disappears", async () => {
	setCatalog("ready", [contribution, fallbackContribution]);
	const { rerender } = render(<Sidebar />);
	expect(
		await screen.findByText("plugin host: dure.beads.issues"),
	).toBeTruthy();

	setCatalog("ready", [fallbackContribution]);
	rerender(<Sidebar />);
	expect(await screen.findByText("spaces")).toBeTruthy();
	expect(screen.queryByTestId("plugin-host")).toBeNull();
	expect(screen.queryByRole("status")).toBeNull();
	expect(screen.queryByRole("button", { name: "Beads" })).toBeNull();
	expect(
		screen.getByRole("button", { name: "Inbox" }).getAttribute("aria-pressed"),
	).toBe("false");
	expect(
		screen.getByRole("button", { name: "Inbox" }).getAttribute("aria-expanded"),
	).toBe("false");
	expect(
		screen
			.getByRole("button", { name: "플러그인" })
			.getAttribute("aria-pressed"),
	).toBe("false");
	expect(useWindowSidebarStore.getState().tab).toBe("spaces");

	setCatalog("ready", [contribution, fallbackContribution]);
	rerender(<Sidebar />);
	expect(screen.queryByTestId("plugin-host")).toBeNull();
	expect(
		screen.getByRole("button", { name: "Inbox" }).getAttribute("aria-pressed"),
	).toBe("false");
	expect(
		screen.getByRole("button", { name: "Beads" }).getAttribute("aria-pressed"),
	).toBe("false");
	expect(useWindowSidebarStore.getState().tab).toBe("spaces");
});

it("selects the exact view contribution when container ids are equal", async () => {
	setCatalog("ready", [contribution, duplicateContainerContribution]);
	render(<Sidebar />);
	await screen.findByText("plugin host: dure.beads.issues");

	fireEvent.click(screen.getByRole("button", { name: "Beads alternate" }));
	expect(
		screen.getByTestId("plugin-host").getAttribute("data-view-contribution"),
	).toBe("dure.beads.alternate-views");
});

it("retries an initial error or opens the plugin catalog explicitly", async () => {
	setCatalog("error");
	render(<Sidebar />);

	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("플러그인 보기를 불러오지 못했습니다.");
	fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
	expect(mocks.refresh).toHaveBeenCalledTimes(1);
	expect(useWindowSidebarStore.getState().tab).toBe("plugin");

	fireEvent.click(screen.getByRole("button", { name: "플러그인 목록 열기" }));
	expect(useWindowSidebarStore.getState().tab).toBe("extension");
	expect(await screen.findByText("plugin catalog")).toBeTruthy();
});
