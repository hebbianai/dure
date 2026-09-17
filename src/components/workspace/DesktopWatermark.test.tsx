// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const openLocalTerminalPanel = vi.fn();
vi.mock("@/lib/workspace/dock", () => ({
	openLocalTerminalPanel: (...args: unknown[]) =>
		openLocalTerminalPanel(...args),
}));
vi.mock("@/components/workspace/WorkspaceRuntimeContext", () => ({
	useWorkspaceRuntimeDesktopId: () => "desk-1",
}));
const onAddRepositoryTerminal = vi.fn();
const onAddRepositoryAgent = vi.fn();
const onAddRepositoryAgentWithOptions = vi.fn();
vi.mock("@/components/spaces/useRepositoryQuickAdd", () => ({
	useRepositoryQuickAdd: () => ({
		onAddRepositoryTerminal,
		onAddRepositoryAgent,
		onAddRepositoryAgentWithOptions,
	}),
}));
vi.mock("@/components/agents/WorktreeAgentDialog", () => ({
	WorktreeAgentDialog: (props: {
		initialProvider?: string;
		initialPath?: string;
	}) => (
		<div
			data-testid="add-agent-dialog"
			data-provider={props.initialProvider ?? ""}
			data-initial-path={props.initialPath ?? ""}
		/>
	),
}));
vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
	listProviderConversations: async () => [],
}));
vi.mock("@/lib/ipc", () => ({
	homeDir: async () => "/Users/tester",
}));

import { DesktopWatermark } from "@/components/workspace/DesktopWatermark";
import { useStore } from "@/store";

const localFocus = {
	cwd: "/repo/x",
	source: "local" as const,
	label: "x",
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	useStore.setState({
		installedAgents: [],
		focusCtx: null,
		projects: [],
		skipPermissions: {},
	});
});

describe("DesktopWatermark", () => {
	// 온보딩 패턴 #3: 빈 상태는 설명이 아니라 실제 동작하는 액션이어야 한다.
	it("아는 디렉토리가 없으면 터미널 행이 홈에서 pane을 연다", () => {
		render(<DesktopWatermark />);
		fireEvent.click(screen.getByRole("button", { name: /^터미널$/ }));
		expect(openLocalTerminalPanel).toHaveBeenCalledWith("desk-1");
		expect(onAddRepositoryTerminal).not.toHaveBeenCalled();
	});

	it("포커스 컨텍스트가 있으면 터미널 행이 그 디렉토리에서 연다", () => {
		useStore.setState({ focusCtx: localFocus });
		render(<DesktopWatermark />);
		fireEvent.click(screen.getByRole("button", { name: /^터미널$/ }));
		expect(onAddRepositoryTerminal).toHaveBeenCalledWith("desk-1", {
			label: "x",
			path: "/repo/x",
		});
	});

	it("디렉토리가 잡혀 있으면 provider 행이 즉시 quick launch 한다", () => {
		useStore.setState({ focusCtx: localFocus, installedAgents: ["claude"] });
		render(<DesktopWatermark />);
		fireEvent.click(screen.getByRole("button", { name: /^claude$/ }));
		expect(onAddRepositoryAgent).toHaveBeenCalledWith(
			"desk-1",
			{ label: "x", path: "/repo/x" },
			"claude",
		);
	});

	// 홈 폴백에서 quick launch 하면 홈이 프로젝트로 등록돼 버린다 — 위치를
	// 물어보는 다이얼로그가 정직한 다음 단계다.
	it("홈 폴백에서는 provider 행이 add-agent 다이얼로그를 연다", () => {
		useStore.setState({ installedAgents: ["claude"] });
		render(<DesktopWatermark />);
		fireEvent.click(screen.getByRole("button", { name: /^claude$/ }));
		expect(onAddRepositoryAgent).not.toHaveBeenCalled();
		expect(screen.getByTestId("add-agent-dialog").dataset.provider).toBe(
			"claude",
		);
	});

	it("설치된 provider가 core보다 먼저 온다", () => {
		useStore.setState({ installedAgents: ["kimi"] });
		render(<DesktopWatermark />);
		const commands = screen
			.getAllByRole("button")
			.map((button) => button.textContent);
		const kimiIndex = commands.findIndex((text) => text === "kimi");
		const claudeIndex = commands.findIndex((text) => text === "claude");
		expect(kimiIndex).toBeGreaterThanOrEqual(0);
		expect(claudeIndex).toBeGreaterThanOrEqual(0);
		expect(kimiIndex).toBeLessThan(claudeIndex);
	});

	// 미리보기 커맨드는 실제 spawn이 읽는 것과 같은 projection을 읽는다 —
	// 행이 약속하는 권한 자세와 실행되는 권한 자세가 어긋나면 안 된다.
	it("권한 우회가 켜진 provider는 행에 플래그까지 보인다", () => {
		useStore.setState({ skipPermissions: { codex: true } });
		render(<DesktopWatermark />);
		expect(
			screen.getByText(
				"codex --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false",
			),
		).toBeTruthy();
	});

	// 패턴 #2 fail-open: provider가 없어도 막히지 않고, 없다고 단정하지도
	// 않는다 (감지 프로브가 아직 안 끝났을 수 있다).
	it("감지된 provider가 없으면 단정 없이 터미널 사용을 안내한다", () => {
		render(<DesktopWatermark />);
		expect(screen.getByText(/아직 감지되지 않았어요/)).toBeTruthy();
		expect(screen.queryByText(/설치되어 있지 않습니다/)).toBeNull();
	});

	it("옵션 풋터가 add-agent 다이얼로그를 연다", () => {
		render(<DesktopWatermark />);
		fireEvent.click(
			screen.getByRole("button", { name: /옵션을 정해 새 에이전트/ }),
		);
		expect(screen.getByTestId("add-agent-dialog")).toBeTruthy();
	});

	// 칩이 이 패널의 핵심 메커니즘이다: 메뉴에서 고른 위치가 이후 모든 행의
	// 실행 위치가 되어야 한다.
	it("칩 메뉴에서 고른 프로젝트가 provider 행과 풋터 프리필을 바꾼다", async () => {
		useStore.setState({
			installedAgents: ["claude"],
			projects: [
				{ id: "p1", name: "alpha", path: "/repo/alpha", kind: "local", isRepo: true },
				{ id: "p2", name: "beta", path: "/repo/beta", kind: "local", isRepo: true },
			],
		});
		render(<DesktopWatermark />);
		fireEvent.pointerDown(screen.getByRole("button", { name: "위치" }), {
			button: 0,
			ctrlKey: false,
		});
		await screen.findByRole("menu");
		fireEvent.click(screen.getByText("beta"));
		fireEvent.click(screen.getByRole("button", { name: /^claude$/ }));
		expect(onAddRepositoryAgent).toHaveBeenCalledWith(
			"desk-1",
			{ label: "beta", path: "/repo/beta" },
			"claude",
		);
		fireEvent.click(
			screen.getByRole("button", { name: /옵션을 정해 새 에이전트/ }),
		);
		expect(screen.getByTestId("add-agent-dialog").dataset.initialPath).toBe(
			"/repo/beta",
		);
	});

	// 포커스에서 온 기본값은 아무도 고른 위치가 아니다 — 다이얼로그를 여는
	// 것만으로 그 폴더가 프로젝트로 등록되면 안 되므로 프리필하지 않는다.
	it("포커스 기본값은 옵션 다이얼로그에 프리필되지 않는다", () => {
		useStore.setState({ focusCtx: localFocus });
		render(<DesktopWatermark />);
		fireEvent.click(
			screen.getByRole("button", { name: /옵션을 정해 새 에이전트/ }),
		);
		expect(screen.getByTestId("add-agent-dialog").dataset.initialPath).toBe("");
	});

	// 포커스가 홈에 앉아 있던 터미널에서 와도 홈은 홈이다 — quick launch가
	// $HOME을 프로젝트로 등록하는 우회로를 막는다.
	it("포커스 경로가 홈이면 provider 행이 다이얼로그로 간다", async () => {
		useStore.setState({
			focusCtx: { cwd: "/Users/tester", source: "local", label: "home" },
			installedAgents: ["claude"],
		});
		render(<DesktopWatermark />);
		await screen.findByText("~");
		fireEvent.click(screen.getByRole("button", { name: /^claude$/ }));
		expect(onAddRepositoryAgent).not.toHaveBeenCalled();
		expect(screen.getByTestId("add-agent-dialog").dataset.provider).toBe(
			"claude",
		);
	});

	// 칩의 기본값은 mount에 한 번 정해진다 — 읽는 중에 포커스가 바뀌어도
	// 칩과 실행 위치가 뒤집히지 않는다 (스펙의 예측 가능성 원칙).
	it("mount 후의 포커스 변화는 기본 위치를 바꾸지 않는다", () => {
		render(<DesktopWatermark />);
		useStore.setState({ focusCtx: localFocus });
		fireEvent.click(screen.getByRole("button", { name: /^터미널$/ }));
		expect(openLocalTerminalPanel).toHaveBeenCalledWith("desk-1");
		expect(onAddRepositoryTerminal).not.toHaveBeenCalled();
	});
});
