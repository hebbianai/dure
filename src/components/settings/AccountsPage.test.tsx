// @vitest-environment jsdom
// 시안 2496:59514 레이아웃 잠금 — "계정 추가"가 제공업체 헤더 줄로 올라오고,
// 그 아래에 있던 "계정 / 새 계정은 여기에 추가됩니다." 안내 줄은 사라진다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UsageRecentReport } from "@/lib/ipc";

const { addPanel, openCommandTerminalOn, useRecentUsageMock } = vi.hoisted(() => {
	const addPanel = vi.fn();
	return {
		addPanel,
		useRecentUsageMock: vi.fn(() => ({
			u5: null as UsageRecentReport | null,
			u24: null as UsageRecentReport | null,
			collector: null,
			setCollector: vi.fn(),
		})),
		openCommandTerminalOn: vi.fn(
			(api: { addPanel: typeof addPanel }, options: unknown) =>
				api.addPanel(options),
		),
	};
});

// 배럴 전체를 대체하면 store가 쓰는 다른 export까지 조용히 사라진다 — 이 파일과
// 무관한 "No export is defined on the mock"으로 터지므로 원본 위에 얹는다.
vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	createAccountDir: vi.fn(async () => "/tmp/claude-work"),
}));
vi.mock("@/lib/agents/accountProfilePreflight", () => ({
	preflightAccountProfileCreation: vi.fn(async () => {}),
}));
vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock/dockRegistry")>()),
	getDockview: () => ({ addPanel }),
}));
vi.mock("@/lib/workspace/dock/openCommandTerminal", () => ({
	openCommandTerminalOn,
}));
vi.mock("@/components/usage/useRecentUsage", () => ({
	useRecentUsage: useRecentUsageMock,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(async () => false) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

import { AccountsPage } from "@/components/settings/AccountsPage";
import { availableProviders } from "@/lib/agents/agentInstalls";
import { preflightAccountProfileCreation } from "@/lib/agents/accountProfilePreflight";
import { accountProviders } from "@/lib/agents/providers";
import { createAccountDir } from "@/lib/ipc";
import { useStore } from "@/store";
import { PROVIDERS, type Provider } from "@/types";

const createAccountDirMock = vi.mocked(createAccountDir);
const preflightAccountProfileCreationMock = vi.mocked(
	preflightAccountProfileCreation,
);

/** 첫 제공업체의 폼을 열고 이름을 채운 뒤 "추가"를 누른다. */
function submitFirstProvider(name = "work") {
	fireEvent.click(screen.getAllByRole("button", { name: /계정 추가/ })[0]);
	fireEvent.change(screen.getByPlaceholderText(/계정 이름/), { target: { value: name } });
	fireEvent.click(screen.getByRole("button", { name: "추가" }));
}

/** 설치 감지 결과를 고정한다 — 이 페이지는 이제 설치된 제공업체를 전부 싣는다. */
const setInstalled = (providers: Provider[]) => {
	useStore.setState({ installedAgents: providers });
};

const emptyUsage = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
	usedPercent: null,
	usedPercentWeekly: null,
	resetsAt: null,
	weeklyResetsAt: null,
	usedPercentCapturedAt: null,
	rateLimits: [],
});

beforeEach(() => {
	useStore.setState({
		uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "pro" },
	});
});

afterEach(() => {
	cleanup();
	useStore.setState({ accounts: [], activeAccounts: {}, installedAgents: [] });
	addPanel.mockReset();
	openCommandTerminalOn.mockClear();
	preflightAccountProfileCreationMock.mockReset();
	preflightAccountProfileCreationMock.mockResolvedValue();
	createAccountDirMock.mockReset();
	createAccountDirMock.mockResolvedValue("/tmp/claude-work");
	useRecentUsageMock.mockReset();
	useRecentUsageMock.mockReturnValue({
		u5: null,
		u24: null,
		collector: null,
		setCollector: vi.fn(),
	});
});

describe("AccountsPage", () => {
	it("opens a new account login with success-only auto-close", async () => {
		const onClose = vi.fn();
		render(<AccountsPage onClose={onClose} />);
		submitFirstProvider("login-close");
		await waitFor(() =>
			expect(openCommandTerminalOn).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ closeOnSuccess: true }),
			),
		);
		expect(useStore.getState().accounts).toHaveLength(1);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("제공업체마다 헤더 줄에 계정 추가 버튼을 둔다", () => {
		render(<AccountsPage onClose={() => {}} />);
		const providers = accountProviders();
		expect(providers.length).toBeGreaterThan(0);
		expect(screen.getAllByRole("button", { name: /계정 추가/ })).toHaveLength(
			providers.length,
		);
		for (const provider of providers) {
			expect(screen.getByText(PROVIDERS[provider].label)).toBeTruthy();
		}
	});

	// The 24px slot contains only the official provider mark. A tinted tile
	// would make the mark read as an application icon instead.
	it("제공업체 심볼 뒤에 틴트 면을 깔지 않는다", () => {
		setInstalled(accountProviders());
		render(<AccountsPage onClose={() => {}} />);
		for (const provider of accountProviders()) {
			const label = screen.getByText(PROVIDERS[provider].label);
			// Inline marks render as SVG while image-backed providers render as img.
			const glyph = label.parentElement?.querySelector("svg, img");
			expect(glyph, provider).toBeTruthy();
			expect(glyph?.getAttribute("class") ?? "", provider).toContain("size-5");
			// A background utility on the wrapper would reintroduce the tinted tile.
			expect(glyph?.parentElement?.className ?? "", provider).not.toMatch(/\bbg-/);
		}
	});

	it("계정 목록 위의 중복 안내 줄을 더 이상 그리지 않는다", () => {
		render(<AccountsPage onClose={() => {}} />);
		expect(screen.queryByText("새 계정은 여기에 추가됩니다.")).toBeNull();
	});

	it("관리 계정이 없으면 시스템 기본값 카드를 활성으로 보여준다", () => {
		render(<AccountsPage onClose={() => {}} />);
		const providers = accountProviders();
		expect(screen.getAllByText("시스템 기본값")).toHaveLength(providers.length);
		expect(screen.getAllByText("활성")).toHaveLength(providers.length);
	});

	it("각 계정 행에서 provider가 관측한 사용률과 reset을 바로 보여준다", () => {
		const nowSec = Math.floor(Date.now() / 1000);
		useStore.setState({
			accounts: [
				{
					id: "acc-hebbian98",
					provider: "codex",
					name: "hebbian98",
					dir: "/Users/test/.dure/accounts/codex-hebbian98",
				},
			],
			activeAccounts: { codex: "acc-hebbian98" },
		});
		useRecentUsageMock.mockReturnValue({
			u5: {
				claude: emptyUsage(),
				codex: emptyUsage(),
				claudeAccounts: [],
				codexAccounts: [],
				codexAccountSnapshots: [
					{
						credentialId: null,
						capturedAt: nowSec,
						attemptedAt: nowSec,
						error: null,
						rateLimits: [
							{
								limitId: "codex",
								limitName: null,
								usedPercent: 7,
								usedPercentWeekly: null,
								resetsAt: nowSec + 2 * 60 * 60,
								weeklyResetsAt: null,
							},
						],
					},
					{
						credentialId: "acc-hebbian98",
						capturedAt: nowSec,
						attemptedAt: nowSec,
						error: null,
						rateLimits: [
							{
								limitId: "codex",
								limitName: null,
								usedPercent: null,
								usedPercentWeekly: 18,
								resetsAt: null,
								weeklyResetsAt: nowSec + 3 * 24 * 60 * 60,
							},
						],
					},
				],
			},
			u24: null,
			collector: null,
			setCollector: vi.fn(),
		});

		render(<AccountsPage onClose={() => {}} />);
		const codexSection = screen.getByText(PROVIDERS.codex.label).closest("section");
		const scope = within(codexSection as HTMLElement);
		expect(scope.getByText("7%")).toBeTruthy();
		expect(scope.getByText("18%")).toBeTruthy();
		expect(scope.getByText(/3일 후 리셋|resets in 3d/i)).toBeTruthy();
	});

	it("계정 추가를 누르면 이름 입력이 같은 섹션에서 열린다", () => {
		render(<AccountsPage onClose={() => {}} />);
		const [first] = screen.getAllByRole("button", { name: /계정 추가/ });
		expect(screen.queryByPlaceholderText(/계정 이름/)).toBeNull();
		fireEvent.click(first);
		expect(screen.getByPlaceholderText(/계정 이름/)).toBeTruthy();
		fireEvent.click(first);
		expect(screen.queryByPlaceholderText(/계정 이름/)).toBeNull();
	});

	it("복구 요청은 기존 프로필을 보존하고 대체 계정 폼을 미리 연다", () => {
		const provider = accountProviders()[0];
		render(
			<AccountsPage
				onClose={() => {}}
				recovery={{
					kind: "create_replacement_profile",
					accountId: "account-1",
					provider,
					accountName: "work",
					profileDirectory: "/tmp/work",
					suggestedName: "work-new",
					errorCode: "credential_directory_untrusted",
				}}
			/>,
		);

		expect(screen.getByRole("alert").textContent).toContain(
			"기존 프로필은 변경하지 않았습니다",
		);
		const input = screen.getByDisplayValue("work-new");
		expect(input.closest("section")?.textContent).toContain(
			PROVIDERS[provider].label,
		);
	});

	// 폼 안에 오류를 두면 이 경로에서 통째로 사라진다: 디렉터리는 만들어졌고
	// setAdding(null)로 폼이 닫힌 뒤에 로그인 pane 생성이 실패한다.
	it("폼이 닫힌 뒤에 난 실패도 그 제공업체 섹션에 남는다", async () => {
		addPanel.mockImplementation(() => {
			throw new Error("panel id collision");
		});
		render(<AccountsPage onClose={() => {}} />);
		submitFirstProvider();

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("panel id collision");
		expect(screen.queryByPlaceholderText(/계정 이름/)).toBeNull();

		// 실패한 제공업체 섹션 안에 있어야 한다 — 남의 섹션에 붙으면 오독된다.
		const section = alert.closest("section");
		expect(section?.textContent).toContain(PROVIDERS[accountProviders()[0]].label);
		expect(screen.getAllByRole("alert")).toHaveLength(1);
	});

	// create_account_dir는 같은 이름에 같은 디렉터리를 되돌려 준다 — 두 번 통과하면
	// 같은 자격 증명을 가리키는 계정이 둘 생긴다.
	it("왕복이 끝나기 전 재제출을 막는다", async () => {
		let release = (_: string) => {};
		createAccountDirMock.mockReturnValue(
			new Promise<string>((resolve) => {
				release = resolve;
			}),
		);
		render(<AccountsPage onClose={() => {}} />);
		submitFirstProvider();

		fireEvent.click(screen.getByRole("button", { name: "추가" }));
		await waitFor(() => expect(createAccountDirMock).toHaveBeenCalledTimes(1));

		release("/tmp/claude-work");
		await waitFor(() => expect(useStore.getState().accounts).toHaveLength(1));
		expect(createAccountDirMock).toHaveBeenCalledTimes(1);
	});

	it("이름 입력의 Escape는 폼만 닫고 위로 새지 않는다", () => {
		render(<AccountsPage onClose={() => {}} />);
		fireEvent.click(screen.getAllByRole("button", { name: /계정 추가/ })[0]);
		const input = screen.getByPlaceholderText(/계정 이름/);
		const seenAtRoot = vi.fn();
		document.addEventListener("keydown", seenAtRoot);
		fireEvent.keyDown(input, { key: "Escape" });
		document.removeEventListener("keydown", seenAtRoot);

		expect(screen.queryByPlaceholderText(/계정 이름/)).toBeNull();
		expect(seenAtRoot).not.toHaveBeenCalled();
	});

	// WKWebView는 한글 조합을 확정하는 Enter도 keydown "Enter"로 보낸다.
	it("IME 조합을 확정하는 Enter로는 제출하지 않는다", async () => {
		render(<AccountsPage onClose={() => {}} />);
		fireEvent.click(screen.getAllByRole("button", { name: /계정 추가/ })[0]);
		const input = screen.getByPlaceholderText(/계정 이름/);
		fireEvent.change(input, { target: { value: "회사" } });
		fireEvent.keyDown(input, { key: "Enter", isComposing: true });
		expect(createAccountDirMock).not.toHaveBeenCalled();

		fireEvent.keyDown(input, { key: "Enter" });
		await waitFor(() => expect(createAccountDirMock).toHaveBeenCalledTimes(1));
		expect(preflightAccountProfileCreationMock).toHaveBeenCalledWith(
			accountProviders()[0],
		);
	});
});

describe("AccountsPage 제공업체 열거", () => {
	// 계정 분리를 지원하는 셋(= core 셋)만 싣던 시절에는 설치해 둔 나머지가 이
	// 화면에서 아예 사라져 "인식이 안 된다"로 읽혔다.
	it("설치가 감지된 제공업체를 계정 지원 여부와 무관하게 싣는다", () => {
		setInstalled(["gemini", "opencode"]);
		render(<AccountsPage onClose={() => {}} />);
		for (const provider of [...accountProviders(), "gemini", "opencode"] as Provider[]) {
			expect(screen.getByText(PROVIDERS[provider].label)).toBeTruthy();
		}
		// 설치가 감지되지 않은 비-core 제공업체는 싣지 않는다.
		expect(screen.queryByText(PROVIDERS.cursor.label)).toBeNull();
	});

	it("계정 분리를 지원하지 않는 제공업체는 버튼 대신 시스템 기본값 알약만 준다", () => {
		setInstalled(["gemini"]);
		render(<AccountsPage onClose={() => {}} />);
		const section = screen.getByText(PROVIDERS.gemini.label).closest("section");
		expect(section).toBeTruthy();
		const scope = within(section as HTMLElement);
		expect(scope.queryByRole("button", { name: /계정 추가/ })).toBeNull();
		expect(scope.getByText("시스템 기본값")).toBeTruthy();
		// 고를 계정이 없으므로 활성 배지가 달린 계정 카드도 그리지 않는다.
		expect(scope.queryByText("활성")).toBeNull();
	});

	// 이 화면은 이제 useAvailableProviders가 열거 권위다. 계정을 가질 수 있는
	// 제공업체가 그 결과에서 빠지면, 이름 변경·전환·제거가 가능한 유일한 화면에서
	// 사라지면서 store와 실행 명령에는 살아 있는 계정이 생긴다.
	it("계정을 가질 수 있는 제공업체는 감지 결과가 비어도 열거된다", () => {
		setInstalled([]);
		const enumerated = availableProviders();
		for (const provider of accountProviders()) {
			expect(enumerated).toContain(provider);
		}
	});

	it("계정을 지원하는 제공업체는 같은 화면에서 버튼을 그대로 갖는다", () => {
		setInstalled(["gemini"]);
		render(<AccountsPage onClose={() => {}} />);
		const section = screen
			.getByText(PROVIDERS[accountProviders()[0]].label)
			.closest("section") as HTMLElement;
		expect(within(section).getByRole("button", { name: /계정 추가/ })).toBeTruthy();
		expect(within(section).getByText("활성")).toBeTruthy();
	});
});
