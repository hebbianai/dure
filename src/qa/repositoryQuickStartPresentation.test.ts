// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { afterEach, expect, it, vi } from "vitest";
import { hmuxPaneOwnerId } from "@/lib/hmux/hmuxPaneRetirement";
import {
	registerDockview,
	unregisterDockview,
} from "@/lib/workspace/dock/dockRegistry";
import { openAgentPanelOnDockview } from "@/lib/workspace/dock/openAgentPanel";
import { useStore } from "@/store";
import { agentFixture } from "@/test/agentFixtures";
import { observeQuickStartPresentation } from "./repositoryQuickStartPresentation";

const { register, release, dispose } = vi.hoisted(() => ({
	register: vi.fn(),
	release: vi.fn(),
	dispose: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("@/lib/terminal/qa/structuredTerminalQaProbe", () => ({
	StructuredTerminalQaProbe: class {
		dispose = dispose;
	},
}));
vi.mock("@/lib/terminal/qa/terminalWindowFocusProbeRegistry", () => ({
	registerTerminalWindowFocusProbe: register,
}));

const cleanup: (() => void)[] = [];
const initial = {
	agents: useStore.getState().agents,
	layouts: useStore.getState().layouts,
};
afterEach(() => {
	for (const stop of cleanup.splice(0).reverse()) stop();
	useStore.setState(initial);
	vi.clearAllMocks();
});

it.each([false, true])(
	"observes the actual opened Agent pane, not its guessed alias (occupied=%s)",
	(occupied) => {
		const desktopId = "quick-start-presentation";
		const element = document.createElement("div");
		document.body.append(element);
		const api = createDockview(element, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
			}),
		});
		api.layout(1000, 700);
		registerDockview(desktopId, api);
		cleanup.push(() => {
			unregisterDockview(desktopId, api);
			api.dispose();
			element.remove();
		});
		const agent = agentFixture({ id: "current" });
		if (occupied) api.addPanel({ id: "agent:current", component: "terminal" });
		useStore.setState({ agents: [], layouts: {} });
		register.mockReturnValue(release);
		const observer = observeQuickStartPresentation(desktopId);
		cleanup.push(() => observer.dispose());
		useStore.setState({ agents: [agent] });
		expect(register).not.toHaveBeenCalled();
		const panelId = openAgentPanelOnDockview({ desktopId, api, agent });
		expect(panelId).not.toBe(false);
		expect(register).toHaveBeenCalledExactlyOnceWith(
			hmuxPaneOwnerId("main", desktopId, String(panelId)),
			expect.anything(),
		);
		useStore.setState({ agents: [{ ...agent, name: "renamed" }] });
		expect(register).toHaveBeenCalledOnce();
	},
);
