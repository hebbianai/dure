// @vitest-environment jsdom

import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { type ComponentProps, memo, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { openSplitLauncherPanel } from "@/lib/workspace/pane/paneSplit";
import { useStore } from "@/store";
import { Workspace } from "./Workspace";

const refresh = await vi.hoisted(async () => {
	const { createRequire } = await import("node:module");
	const require = createRequire(import.meta.url);
	const runtime = require("react-refresh/runtime");
	runtime.injectIntoGlobalHook(globalThis);
	return runtime;
});
const mocks = vi.hoisted(() => ({
	terminal: vi.fn(),
	agent: vi.fn(),
	folder: vi.fn(),
}));
vi.mock("@/lib/workspace/dock", async (original) => ({
	...(await original<typeof import("@/lib/workspace/dock")>()),
	createLocalTerminalOn: mocks.terminal,
}));
vi.mock("@/components/spaces/useRepositoryQuickAdd", () => ({
	useRepositoryQuickAdd: () => ({ onAddRepositoryAgent: mocks.agent }),
}));
const previous = useStore.getState();
beforeEach(() => {
	mockWindows("main");
	mockIPC((command) =>
		command === "plugin:dialog|open" ? mocks.folder() : null,
	);
	vi.spyOn(document, "hasFocus").mockReturnValue(true);
	useStore.setState({
		spaces: [{ id: "desk-launcher", name: "Fixture" }],
		activeSpaceId: "desk-launcher",
		agents: [],
		projects: [],
		installedAgents: ["codex"],
		uiPrefs: { ...previous.uiPrefs, onboardingDismissed: true },
		layouts: {
			"desk-launcher": {
				grid: {
					root: { type: "branch", data: [] },
					width: 1000,
					height: 700,
					orientation: "HORIZONTAL",
				},
				panels: {},
			},
		},
	});
});
afterEach(() => {
	cleanup();
	clearMocks();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	useStore.setState(previous);
});
it.each([false, true])(
	"routes launcher actions from the real workspace after restore=%s",
	async (restore) => {
		render(<Workspace desktopId="desk-launcher" active />);
		const api = getDockview("desk-launcher")!;
		expect(api).toBeDefined();
		act(() => {
			api.layout(1000, 700);
			openSplitLauncherPanel(
				"desk-launcher",
				{ kind: "local", cwd: "/chosen folder" },
				{ direction: "right" },
			);
		});
		if (restore)
			act(() => api.fromJSON(api.toJSON(), { reuseExistingPanels: true }));
		const panel = api.activePanel!;
		const terminal = await screen.findByRole("button", {
			name: t("common.terminal"),
		});
		await act(async () => fireEvent.click(terminal));
		expect(mocks.terminal).toHaveBeenCalledWith(api, "/chosen folder", {
			replacement: panel.api,
		});
		fireEvent.click(screen.getByRole("button", { name: /^codex/ }));
		expect(mocks.agent).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByRole("button", { name: t("common.close") }));
		await waitFor(() => expect(api.getPanel(panel.id)).toBeUndefined());
		expect(
			(useStore.getState().layouts["desk-launcher"] as { panels: object })
				.panels,
		).not.toHaveProperty(panel.id);
	},
);

it("reconnects the retained grid after Fast Refresh without restoring its panes", async () => {
	refresh.register(Workspace, "launcher-workspace");
	render(<Workspace desktopId="desk-launcher" active />);
	const api = getDockview("desk-launcher")!;
	act(() => {
		api.layout(1000, 700);
		openSplitLauncherPanel(
			"desk-launcher",
			{ kind: "local", cwd: "/retained directory" },
			{ direction: "right" },
		);
	});
	const source = api.activePanel!;
	act(() => source.api.setTitle("Source selector"));
	const draft = screen.getByRole("searchbox");
	fireEvent.change(draft, { target: { value: "codex" } });
	act(() =>
		openSplitLauncherPanel(
			"desk-launcher",
			{ kind: "local", cwd: "/retained directory" },
			{ referencePanel: source.id, direction: "right" },
		),
	);
	const panel = api.activePanel!;
	const original = (
		Workspace as unknown as {
			type: (props: ComponentProps<typeof Workspace>) => ReactNode;
		}
	).type;
	const Updated = memo(function RefreshedWorkspace(
		props: ComponentProps<typeof Workspace>,
	) {
		return original(props);
	});
	await act(async () => {
		refresh.register(Updated, "launcher-workspace");
		refresh.performReactRefresh();
	});
	expect(getDockview("desk-launcher") === api).toBe(true);
	expect(api.getPanel(panel.id) === panel).toBe(true);
	expect(api.getPanel(source.id) === source).toBe(true);
	expect(document.contains(draft)).toBe(true);
	expect((draft as HTMLInputElement).value).toBe("codex");
	const target = within(
		screen.getByRole("region", { name: t("workspace.launcher.title") }),
	);
	mocks.folder.mockReturnValueOnce("/chosen after refresh");
	await act(async () =>
		fireEvent.click(target.getByRole("button", { name: t("common.location") })),
	);
	expect(
		(
			useStore.getState().layouts["desk-launcher"] as {
				panels: Record<string, { params: { cwd: string } }>;
			}
		).panels[panel.id].params.cwd,
	).toBe("/chosen after refresh");
	await act(async () =>
		fireEvent.click(target.getByRole("button", { name: /^codex/ })),
	);
	expect(mocks.agent).toHaveBeenCalledWith(
		"desk-launcher",
		{ label: "chosen after refresh", path: "/chosen after refresh" },
		"codex",
	);
	fireEvent.click(target.getByRole("button", { name: t("common.terminal") }));
	expect(mocks.terminal).toHaveBeenCalledWith(api, "/chosen after refresh", {
		replacement: panel.api,
	});
	fireEvent.click(target.getByRole("button", { name: t("common.close") }));
	await waitFor(() => expect(api.getPanel(panel.id)).toBeUndefined());
	expect(api.getPanel(source.id) === source).toBe(true);
	act(() =>
		openSplitLauncherPanel(
			"desk-launcher",
			{ kind: "local", cwd: "/new after refresh" },
			{ referencePanel: source.id, direction: "right" },
		),
	);
	await waitFor(() =>
		expect(
			(useStore.getState().layouts["desk-launcher"] as { panels: object })
				.panels,
		).toHaveProperty(api.activePanel!.id),
	);
	cleanup();
	expect(getDockview("desk-launcher")).toBeUndefined();
});
