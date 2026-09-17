import { beforeEach, describe, expect, it, vi } from "vitest";

const openSplitTerminalPanel = vi.fn();
const openSplitLauncherPanel = vi.fn();
const paneSplitTargetForPanel = vi.fn(() => ({
	kind: "ssh" as const,
	hostId: "inherited",
	cwd: "/srv",
}));

vi.mock("@/lib/workspace/pane/paneSplit", () => ({
	openSplitTerminalPanel,
	openSplitLauncherPanel,
	paneSplitTargetForPanel,
}));

const { paneSplitActions } = await import(
	"@/lib/workspace/pane/paneSplitActions"
);

const host = {
	id: "h1",
	name: "SSH 1",
	host: "h1.example",
	port: 22,
	user: "dure",
	auth: "auto" as const,
};

beforeEach(() => {
	openSplitTerminalPanel.mockClear();
	openSplitLauncherPanel.mockClear();
	paneSplitTargetForPanel.mockClear();
});

describe("paneSplitActions", () => {
	const actions = () =>
		paneSplitActions({
			desktopId: "space-1",
			panelId: "terminal:pane-1",
			component: "terminal",
			params: { cwd: "/srv" },
		});

	it("generic split opens a selector at the inherited location without starting a shell", () => {
		actions().splitPane("below");
		expect(paneSplitTargetForPanel).toHaveBeenCalledWith(
			{ id: "terminal:pane-1", component: "terminal" },
			{
				cwd: "/srv",
			},
		);
		expect(openSplitTerminalPanel).not.toHaveBeenCalled();
		expect(openSplitLauncherPanel).toHaveBeenCalledWith(
			"space-1",
			{ kind: "ssh", hostId: "inherited", cwd: "/srv" },
			{ referencePanel: "terminal:pane-1", direction: "below" },
		);
	});

	it("터미널은 원격 pane에서도 로컬 셸이다", () => {
		actions().splitTerminalPane("right");
		expect(paneSplitTargetForPanel).not.toHaveBeenCalled();
		expect(openSplitTerminalPanel).toHaveBeenCalledWith(
			"space-1",
			{ kind: "local" },
			{ referencePanel: "terminal:pane-1", direction: "right" },
		);
	});

	it("호스트는 고른 방향으로 열린다 — 예전 SSH 분할은 right로 박혀 있었다", () => {
		actions().splitSshPane("below", host);
		expect(openSplitTerminalPanel).toHaveBeenCalledWith(
			"space-1",
			{ kind: "ssh", hostId: "h1" },
			{ referencePanel: "terminal:pane-1", direction: "below" },
		);
	});

	it("데스크탑이 없으면 아무것도 열지 않는다", () => {
		const detached = paneSplitActions({
			desktopId: undefined,
			panelId: "terminal:pane-1",
			component: "terminal",
		});
		detached.splitPane("right");
		detached.splitTerminalPane("right");
		detached.splitSshPane("right", host);
		expect(openSplitTerminalPanel).not.toHaveBeenCalled();
		expect(openSplitLauncherPanel).not.toHaveBeenCalled();
	});
});
