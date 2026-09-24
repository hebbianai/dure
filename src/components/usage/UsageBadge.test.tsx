// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexUsageSnapshot } from "@/lib/ipc";
import type {
	ClaudeAccountRateLimit,
	CodexAccountUsage,
} from "@/lib/usage/usageAccounts";
import type { ProviderUsage } from "@/lib/usage/usageMeter";
import type { AccountProfile } from "@/types";

const usageRecentMock = vi.fn();
const usageRefreshMock = vi.fn();
const collectorStatusMock = vi.fn();
const collectorInstallMock = vi.fn();
const accountLoginIdentityMock = vi.fn();
const getDockviewMock = vi.fn();
const openCommandTerminalOnMock = vi.fn();
const createAccountDirMock = vi.fn();
const accountPreflightMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn() }));
vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	createAccountDir: (...args: unknown[]) => createAccountDirMock(...args),
	usageRecent: (hours: number) => usageRecentMock(hours),
	usageRefresh: (provider: string) => usageRefreshMock(provider),
	claudeCollectorStatus: () => collectorStatusMock(),
	claudeCollectorInstall: () => collectorInstallMock(),
	codexUsageProfilesSync: () => Promise.resolve(),
	accountLoginIdentity: (...args: unknown[]) =>
		accountLoginIdentityMock(...args),
}));
vi.mock("@/lib/agents/accountProfilePreflight", () => ({
	preflightAccountProfileCreation: (...args: unknown[]) =>
		accountPreflightMock(...args),
}));

vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/dock/dockRegistry")
	>()),
	getDockview: (...args: unknown[]) => getDockviewMock(...args),
}));
vi.mock("@/lib/workspace/dock/openCommandTerminal", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/dock/openCommandTerminal")
	>()),
	openCommandTerminalOn: (...args: unknown[]) =>
		openCommandTerminalOnMock(...args),
}));

import { ClaudeUsageDetail } from "@/components/usage/ProviderUsageDetail";
import { UsageBadge } from "@/components/usage/UsageBadge";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";

/** provider별 팝오버 트리거의 접근성 이름 (PROVIDERS 라벨 기준). */
const CLAUDE_METER = "Claude Code 사용량 상세 보기";
const CODEX_METER = "Codex 사용량 상세 보기";

function meterRing(label: string): HTMLElement {
	const ring = screen
		.getByRole("button", { name: label })
		.querySelector<HTMLElement>('[data-slot="usage-meter-ring"]');
	expect(ring).not.toBeNull();
	return ring as HTMLElement;
}

async function openAccountMenu(provider: "Claude" | "Codex") {
	const trigger = await screen.findByRole("button", {
		name: `${provider} 계정 전환`,
	});
	fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

function provider(over: Partial<ProviderUsage> = {}): ProviderUsage {
	return {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 523_800,
		total: 523_950,
		usedPercent: null,
		usedPercentWeekly: null,
		resetsAt: null,
		weeklyResetsAt: null,
		usedPercentCapturedAt: null,
		rateLimits: [],
		...over,
	};
}

function mockUsage(
	claude: Partial<ProviderUsage>,
	codex: Partial<ProviderUsage> = {},
	accounts: {
		claudeAccounts?: ClaudeAccountRateLimit[];
		codexAccounts?: CodexAccountUsage[];
		codexSnapshots?: CodexUsageSnapshot[];
	} = {},
) {
	usageRecentMock.mockResolvedValue({
		claude: provider(claude),
		codex: provider(codex),
		claudeAccounts: accounts.claudeAccounts ?? [],
		codexAccounts: accounts.codexAccounts ?? [],
		codexAccountSnapshots: accounts.codexSnapshots ?? [],
	});
}

function claudeLimit(
	profileKey: string,
	usedPercent: number | null,
	over: Partial<ClaudeAccountRateLimit> = {},
): ClaudeAccountRateLimit {
	return {
		profileKey,
		usedPercent,
		usedPercentWeekly: null,
		resetsAt: null,
		weeklyResetsAt: null,
		usedPercentCapturedAt: null,
		...over,
	};
}

/** 계정 목록·활성 지정을 시드한다 — dir은 `/accounts/<name>` 규칙을 따른다. */
function seedAccounts(
	accounts: Array<Omit<AccountProfile, "dir">>,
	activeAccounts: Partial<Record<AccountProfile["provider"], string>> = {},
) {
	useStore.setState({
		accounts: accounts.map((account) => ({
			...account,
			dir: `/accounts/${account.name}`,
		})),
		activeAccounts,
	});
}

beforeEach(() => {
	createAccountDirMock.mockResolvedValue("/accounts/new-work");
	accountPreflightMock.mockResolvedValue(undefined);
	collectorStatusMock.mockResolvedValue("not_installed");
	accountLoginIdentityMock.mockResolvedValue({
		status: "authenticated",
		email: null,
		plan: null,
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	useStore.setState({
		accounts: [],
		activeAccounts: {},
		uiPrefs: {
			...useStore.getState().uiPrefs,
			showClaudeUsage: true,
			showCodexUsage: true,
		},
	});
});

describe("UsageBadge", () => {
	it.each([
		["claude", CLAUDE_METER],
		["codex", CODEX_METER],
	] as const)(
		"adds a %s account from its usage popover",
		async (providerId, meter) => {
			mockUsage({});
			const dockview = {};
			getDockviewMock.mockReturnValue(dockview);
			seedAccounts([{ id: "existing", provider: providerId, name: "work" }], {
				[providerId]: "existing",
			});
			render(<UsageBadge />);
			const trigger = await screen.findByRole("button", { name: meter });
			fireEvent.click(trigger);
			fireEvent.click(
				screen.getByRole("button", { name: t("settings.accounts.add") }),
			);
			const dialog = await screen.findByRole("dialog");
			const input = within(dialog).getByRole("textbox");
			await waitFor(() => expect(document.activeElement).toBe(input));
			expect(
				document.querySelector('[data-slot="provider-usage-popover-content"]'),
			).toBeNull();
			expect(useStore.getState().activeAccounts[providerId]).toBe("existing");
			expect(createAccountDirMock).not.toHaveBeenCalled();
			fireEvent.change(input, { target: { value: "new-work" } });
			fireEvent.click(
				within(dialog).getByRole("button", { name: t("common.add") }),
			);
			await waitFor(() =>
				expect(openCommandTerminalOnMock).toHaveBeenCalledWith(
					dockview,
					expect.objectContaining({
						closeOnSuccess: true,
						command: expect.any(String),
					}),
				),
			);
			expect(accountPreflightMock).toHaveBeenCalledWith(providerId);
			expect(createAccountDirMock).toHaveBeenCalledWith(providerId, "new-work");
			expect(useStore.getState().accounts).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						provider: providerId,
						name: "new-work",
						dir: "/accounts/new-work",
					}),
				]),
			);
			await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(document.activeElement).not.toBe(trigger);
		},
	);

	it.each([CLAUDE_METER, CODEX_METER])(
		"returns focus to %s when account creation is dismissed",
		async (meter) => {
			mockUsage({});
			render(<UsageBadge />);
			const trigger = await screen.findByRole("button", { name: meter });
			fireEvent.click(trigger);
			fireEvent.click(
				screen.getByRole("button", { name: t("settings.accounts.add") }),
			);
			const dialog = await screen.findByRole("dialog");
			fireEvent.click(
				within(dialog).getByRole("button", { name: t("common.close") }),
			);
			await waitFor(() => expect(document.activeElement).toBe(trigger));
			expect(createAccountDirMock).not.toHaveBeenCalled();
			expect(useStore.getState().accounts).toEqual([]);
		},
	);

	it.each([
		["codex", CODEX_METER],
		["claude", CLAUDE_METER],
	] as const)(
		"refreshes %s without switching accounts and retains data on failure",
		async (providerId, meter) => {
			mockUsage({ usedPercent: 10 }, { usedPercent: 20 });
			render(<UsageBadge />);
			fireEvent.click(await screen.findByLabelText(meter));
			const refresh = await screen.findByRole("button", { name: "새로고침" });
			let fail!: (error: Error) => void;
			usageRefreshMock.mockImplementationOnce(
				() =>
					new Promise((_, reject) => {
						fail = reject;
					}),
			);
			fireEvent.click(refresh);
			await waitFor(() =>
				expect(usageRefreshMock).toHaveBeenCalledWith(providerId),
			);
			expect(refresh.getAttribute("aria-busy")).toBe("true");
			expect((refresh as HTMLButtonElement).disabled).toBe(true);
			fireEvent.click(refresh);
			expect(usageRefreshMock).toHaveBeenCalledTimes(1);
			fail(new Error("offline"));
			await screen.findByRole("alert");
			expect(meterRing(meter).dataset.pct).toBe(
				providerId === "claude" ? "10" : "20",
			);
			expect((refresh as HTMLButtonElement).disabled).toBe(false);
			const updated = {
				claude: provider({ usedPercent: 33 }),
				codex: provider({ usedPercent: 44 }),
			};
			usageRefreshMock.mockResolvedValueOnce({
				fiveHours: updated,
				twentyFourHours: updated,
			});
			fireEvent.click(refresh);
			await waitFor(() =>
				expect(meterRing(meter).dataset.pct).toBe(
					providerId === "claude" ? "33" : "44",
				),
			);
			expect(screen.queryByRole("alert")).toBeNull();
			expect(screen.getByRole("button", { name: "새로고침" })).toBe(refresh);
			expect(useStore.getState().activeAccounts).toEqual({});
		},
	);

	it("실측 %가 없으면 compact ring을 unknown으로 두고 상단 토큰 폴백을 숨긴다", async () => {
		mockUsage({});
		render(<UsageBadge />);
		await screen.findByLabelText(CLAUDE_METER);
		expect(meterRing(CLAUDE_METER).dataset.level).toBe("unknown");
		expect(screen.queryByText("150")).toBeNull();
		expect(screen.queryByText(/%/)).toBeNull();
	});

	it("60% 미만 실측치는 ring에 반영하되 상단 숫자는 숨긴다", async () => {
		const now = Math.floor(Date.now() / 1000);
		mockUsage({
			usedPercent: 23.4,
			resetsAt: now + 3600,
			usedPercentCapturedAt: now - 120,
		});
		render(<UsageBadge />);
		await screen.findByLabelText(CLAUDE_METER);
		expect(meterRing(CLAUDE_METER).dataset.pct).toBe("23.4");
		expect(meterRing(CLAUDE_METER).dataset.level).toBe("normal");
		expect(
			screen
				.getByLabelText(CLAUDE_METER)
				.querySelector('[data-slot="usage-meter-label"]'),
		).toBeNull();
	});

	it("60%부터 숫자를 표시하고 85%부터 위험 상태로 올린다", async () => {
		const now = Math.floor(Date.now() / 1000);
		mockUsage(
			{ usedPercent: 60, resetsAt: now + 7200 },
			{ usedPercent: 85, resetsAt: now + 7200 },
		);
		const { container } = render(<UsageBadge />);
		expect(await screen.findByText("60%")).toBeTruthy();
		expect(screen.getByText("85%")).toBeTruthy();
		expect(meterRing(CLAUDE_METER).dataset.level).toBe("warning");
		expect(meterRing(CODEX_METER).dataset.level).toBe("danger");
		expect(
			screen
				.queryAllByText(/2h/)
				.every((element) => element.classList.contains("sr-only")),
		).toBe(true);
		expect(
			container.querySelector('[data-slot="usage-meter-track"]'),
		).toBeNull();
		expect(container.querySelector(".lucide-chevron-up")).toBeNull();
		expect(
			screen.getByLabelText(CLAUDE_METER).querySelector(".sr-only")
				?.textContent,
		).toContain("2h");
	});

	it("compact ring의 빈 트랙은 패널 배경과 구분되는 테마 전경 중간톤을 쓴다", async () => {
		mockUsage({ usedPercent: 23 }, { usedPercent: 41 });
		const { container } = render(<UsageBadge />);
		await screen.findByLabelText(CLAUDE_METER);

		const tracks = container.querySelectorAll(
			'[data-slot="usage-meter-ring-track"]',
		);
		expect(tracks).toHaveLength(2);
		for (const track of tracks) {
			expect(track.getAttribute("class")).toContain(
				"stroke-muted-foreground/30",
			);
		}
	});

	it("수집기 미설치면 팝오버에 설치 버튼이 뜨고, 클릭하면 설치를 호출한다", async () => {
		mockUsage({});
		collectorInstallMock.mockResolvedValue("installed");
		render(<UsageBadge />);
		fireEvent.click(await screen.findByLabelText(CLAUDE_METER));
		const install = await screen.findByText("실측 % 수집기 설치");
		fireEvent.click(install);
		await waitFor(() => expect(collectorInstallMock).toHaveBeenCalledTimes(1));
		expect(await screen.findByText(/수집기 설치됨/)).toBeTruthy();
	});

	it("직접 설정한 statusLine(foreign)이면 설치 버튼 대신 안내만 보여준다", async () => {
		mockUsage({});
		collectorStatusMock.mockResolvedValue("foreign");
		render(<UsageBadge />);
		fireEvent.click(await screen.findByLabelText(CLAUDE_METER));
		expect(await screen.findByText(/직접 설정한 statusLine/)).toBeTruthy();
		expect(screen.queryByText("실측 % 수집기 설치")).toBeNull();
	});

	it("usage_recent 실패 시 배지를 그리지 않는다 (에러 침묵)", async () => {
		usageRecentMock.mockRejectedValue(new Error("backend missing"));
		const { container } = render(<UsageBadge />);
		// 마이크로태스크 소진 후에도 아무것도 렌더되지 않아야 한다
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(container.innerHTML).toBe("");
	});

	it("CL/CX 텍스트 코드 대신 provider 로고를 쓴다", async () => {
		mockUsage({});
		render(<UsageBadge />);
		await screen.findByLabelText(CLAUDE_METER);
		expect(screen.queryByText("CL")).toBeNull();
		expect(screen.queryByText("CX")).toBeNull();
	});

	it("provider ring을 좁은 간격으로 묶고 상시 세로 구분선을 제거한다", async () => {
		mockUsage({});
		const { container } = render(<UsageBadge />);
		await screen.findByLabelText(CLAUDE_METER);

		const meters = container.querySelectorAll(
			'[data-slot="usage-provider-meter"]',
		);
		expect(meters).toHaveLength(2);
		for (const meter of meters) {
			expect(meter.className).not.toMatch(/\bbg-/);
			expect(meter.className).not.toMatch(/\bborder\b/);
		}

		expect(
			container.querySelector('[data-slot="usage-provider-divider"]'),
		).toBeNull();
	});

	it("provider 하나만 표시할 때는 세로 구분선을 남기지 않는다", async () => {
		mockUsage({});
		useStore.setState({
			uiPrefs: {
				...useStore.getState().uiPrefs,
				showCodexUsage: false,
			},
		});
		const { container } = render(<UsageBadge />);
		await screen.findByLabelText(CLAUDE_METER);

		expect(screen.queryByLabelText(CODEX_METER)).toBeNull();
		expect(
			container.querySelector('[data-slot="usage-provider-divider"]'),
		).toBeNull();
	});

	// 사용자 요청(2026-07-29): codex를 누르면 codex dropdown, claude를 누르면 claude dropdown.
	it("미터마다 자기 provider 팝오버만 연다", async () => {
		mockUsage({});
		seedAccounts(
			[
				{ id: "acc-cl", provider: "claude", name: "claude-work" },
				{ id: "acc-cx", provider: "codex", name: "codex-work" },
			],
			{ claude: "acc-cl", codex: "acc-cx" },
		);
		render(<UsageBadge />);

		fireEvent.click(await screen.findByLabelText(CLAUDE_METER));
		expect(await screen.findAllByText("claude-work")).toHaveLength(1);
		expect(screen.queryByText("codex-work")).toBeNull();
		expect(screen.queryByText("Codex · rate limit")).toBeNull();

		fireEvent.click(screen.getByLabelText(CODEX_METER));
		expect(await screen.findAllByText("codex-work")).toHaveLength(1);
		expect(screen.queryByText("claude-work")).toBeNull();
	});

	it("Claude와 Codex가 테마 표면·헤더·액션 구조를 공유한다", async () => {
		mockUsage({ usedPercent: 21 }, { usedPercent: 34 });
		render(<UsageBadge />);

		fireEvent.click(await screen.findByLabelText(CLAUDE_METER));
		const claudePopover = document.querySelector<HTMLElement>(
			'[data-slot="claude-usage-popover"]',
		);
		expect(claudePopover).not.toBeNull();
		expect(claudePopover?.className).toContain("bg-glass-menu");
		expect(claudePopover?.className).toContain("ring-glass-menu-hairline");
		expect(
			claudePopover?.querySelector(
				'[data-slot="provider-usage-popover-content"]',
			),
		).not.toBeNull();
		expect(
			claudePopover?.querySelector(
				'[data-slot="provider-usage-popover-header"]',
			),
		).not.toBeNull();
		expect(
			within(claudePopover as HTMLElement).getByRole("button", {
				name: "통계 · 사용량",
			}),
		).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: CLAUDE_METER }));
		fireEvent.click(screen.getByRole("button", { name: CODEX_METER }));
		const codexPopover = await waitFor(() => {
			const element = document.querySelector<HTMLElement>(
				'[data-slot="codex-usage-popover"]',
			);
			expect(element).not.toBeNull();
			return element as HTMLElement;
		});
		// 메뉴와 같은 유리 재질을 쓴다 — 두 provider가 같은 표면을 공유한다는
		// 계약은 그대로고, 그 표면이 불투명 pane에서 메뉴 유리로 바뀌었다.
		expect(codexPopover.className).toContain("bg-glass-menu");
		expect(codexPopover.className).toContain("ring-glass-menu-hairline");
		expect(codexPopover.className).not.toContain("bg-glass-pane");
		expect(
			codexPopover.querySelector(
				'[data-slot="provider-usage-popover-content"]',
			),
		).not.toBeNull();
		expect(
			codexPopover.querySelector('[data-slot="provider-usage-popover-header"]'),
		).not.toBeNull();
		expect(
			within(codexPopover).getByRole("button", { name: "통계 · 사용량" }),
		).toBeTruthy();
	});

	it("수집 전 Claude 팝오버를 계정 헤더·간결한 사용량·설치 액션으로 그린다", async () => {
		mockUsage({});
		render(<UsageBadge />);
		fireEvent.click(await screen.findByLabelText(CLAUDE_METER));

		const popover = document.querySelector<HTMLElement>(
			'[data-slot="claude-usage-popover"]',
		);
		expect(popover).not.toBeNull();
		const view = within(popover as HTMLElement);
		expect(view.getByText("Claude")).toBeTruthy();
		expect(view.getByText("5시간 토큰")).toBeTruthy();
		expect(
			view.getByText(
				"한도 %는 로컬 로그에 없습니다. 수집기를 설치하면 실측 %가 표시됩니다.",
			),
		).toBeTruthy();
		expect(view.getByRole("button", { name: "통계 · 사용량" })).toBeTruthy();
		expect(
			view.getByRole("button", { name: "실측 % 수집기 설치" }),
		).toBeTruthy();
	});

	it("수집 후 Claude 팝오버를 주간 전체 모델 한도·세부 토큰·측정 시각 상태로 그린다", async () => {
		const now = Math.floor(Date.now() / 1000);
		mockUsage({
			usedPercentWeekly: 42,
			weeklyResetsAt: now + 5 * 86400,
			usedPercentCapturedAt: now - 300,
		});
		render(<UsageBadge />);
		fireEvent.click(await screen.findByLabelText(CLAUDE_METER));

		const popover = document.querySelector<HTMLElement>(
			'[data-slot="claude-usage-popover"]',
		);
		expect(popover).not.toBeNull();
		const view = within(popover as HTMLElement);
		expect(view.getByText("주간 · 전체 모델")).toBeTruthy();
		// statusLine은 모델별 주간 창을 주지 않는다 — 값 없는 자리표시 행을 그리지 않는다.
		const limitRows = (popover as HTMLElement).querySelectorAll(
			'[data-slot="usage-popover-limit"]',
		);
		expect(limitRows).toHaveLength(1);
		expect(limitRows[0]?.textContent).not.toContain("—");
		expect(view.getByText(/에 재설정/)).toBeTruthy();
		expect(view.getByText("42%", { exact: false })).toBeTruthy();
		expect(view.getByText("입력 · 출력 · 캐시 쓰기")).toBeTruthy();
		expect(view.getByText("24h 총 토큰")).toBeTruthy();
		expect(view.getByText("작업 중 에이전트")).toBeTruthy();
		expect(
			view.getByText(
				t("usage.source.statusLineCapturedDetail", { ago: "5분" }),
			),
		).toBeTruthy();
	});

	it("일반 Codex와 별도 모델 한도를 섞지 않고 함께 표시한다", async () => {
		const now = Math.floor(Date.now() / 1000);
		mockUsage(
			{},
			{
				usedPercent: 12,
				usedPercentWeekly: 34,
				resetsAt: now + 3600,
				weeklyResetsAt: now + 86400,
				rateLimits: [
					{
						limitId: "codex",
						limitName: null,
						usedPercent: 12,
						usedPercentWeekly: 34,
						resetsAt: now + 3600,
						weeklyResetsAt: now + 86400,
					},
					{
						limitId: "codex_bengalfox",
						limitName: "GPT-5.3-Codex-Spark",
						usedPercent: 77,
						usedPercentWeekly: 81,
						resetsAt: now + 7200,
						weeklyResetsAt: now + 2 * 86400,
					},
				],
			},
		);
		render(<UsageBadge />);

		await screen.findByLabelText(CODEX_METER);
		expect(meterRing(CODEX_METER).dataset.pct).toBe("77");
		fireEvent.click(screen.getByLabelText(CODEX_METER));

		expect(await screen.findByText("주간 · 전체 모델")).toBeTruthy();
		expect(screen.getByText("주간 · GPT-5.3-Codex-Spark")).toBeTruthy();
		expect(screen.getByText("34%")).toBeTruthy();
		const modelLimits = document.querySelectorAll(
			'[data-slot="codex-model-limit"]',
		);
		expect(modelLimits).toHaveLength(1);
		expect(modelLimits[0]?.textContent).toContain("81%");
	});

	it("계정 행을 클릭하면 그 provider의 활성 계정이 바뀌고, 활성 행은 클릭할 수 없다", async () => {
		mockUsage({});
		seedAccounts(
			[
				{ id: "acc-a", provider: "codex", name: "codex-a" },
				{ id: "acc-b", provider: "codex", name: "codex-b" },
			],
			{ codex: "acc-a" },
		);
		render(<UsageBadge />);
		fireEvent.click(await screen.findByLabelText(CODEX_METER));
		await openAccountMenu("Codex");

		const activeRow = await screen.findByRole("menuitemradio", {
			name: /codex-a/,
		});
		expect(activeRow.getAttribute("aria-checked")).toBe("true");

		const otherRow = screen.getByRole("menuitemradio", { name: /codex-b/ });
		fireEvent.click(otherRow);
		expect(useStore.getState().activeAccounts.codex).toBe("acc-b");
	});

	it("로그아웃이 확인된 계정은 기존 provider 로그인 pane을 열 수 있다", async () => {
		mockUsage({});
		accountLoginIdentityMock.mockImplementation(
			(_provider: string, dir?: string) =>
				Promise.resolve({
					status:
						dir === "/accounts/logged-out"
							? "unauthenticated"
							: "authenticated",
					email: null,
					plan: null,
				}),
		);
		const dockview = {};
		getDockviewMock.mockReturnValue(dockview);
		seedAccounts(
			[{ id: "acc-logged-out", provider: "codex", name: "logged-out" }],
			{ codex: "acc-logged-out" },
		);
		render(<UsageBadge />);
		fireEvent.click(await screen.findByLabelText(CODEX_METER));
		await openAccountMenu("Codex");

		const login = await screen.findByRole("menuitem", {
			name: "로그인 · logged-out",
		});
		fireEvent.click(login);
		expect(openCommandTerminalOnMock).toHaveBeenCalledWith(
			dockview,
			expect.objectContaining({
				title: "로그인 · logged-out",
				command:
					"env CODEX_HOME='/accounts/logged-out' CODEX_SQLITE_HOME=\"$HOME/.codex\" codex login",
				closeOnSuccess: true,
			}),
		);
	});

	it("opens usage-detail account login with success-only auto-close", async () => {
		accountLoginIdentityMock.mockResolvedValue({
			status: "unauthenticated",
			email: null,
			plan: null,
		});
		const dockview = {};
		getDockviewMock.mockReturnValue(dockview);
		seedAccounts([
			{ id: "detail-login", provider: "claude", name: "detail-login" },
		]);
		render(
			<ClaudeUsageDetail
				u5={{
					claude: provider(),
					codex: provider(),
					claudeAccounts: [],
					codexAccounts: [],
					codexAccountSnapshots: [],
				}}
				u24={null}
				nowSec={Date.now() / 1000}
				collector={null}
				installing={false}
				onInstall={vi.fn()}
			/>,
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "로그인 · detail-login" }),
		);
		expect(openCommandTerminalOnMock).toHaveBeenCalledWith(
			dockview,
			expect.objectContaining({
				command:
					"env CLAUDE_CONFIG_DIR='/accounts/detail-login' claude auth login",
				closeOnSuccess: true,
			}),
		);
	});

	it("Claude 팝오버 헤더의 계정 메뉴에서 활성 계정을 바꾼다", async () => {
		const now = Math.floor(Date.now() / 1000);
		accountLoginIdentityMock.mockImplementation(
			(_provider: string, dir?: string) =>
				Promise.resolve({
					status: "authenticated",
					email: dir?.endsWith("claude-a")
						? "a@example.com"
						: dir?.endsWith("claude-b")
							? "b@example.com"
							: null,
					plan: null,
				}),
		);
		mockUsage(
			{},
			{},
			{
				claudeAccounts: [
					claudeLimit("claude-a", 22, {
						usedPercentWeekly: 35,
						resetsAt: now + 5400,
						weeklyResetsAt: now + 86400,
						usedPercentCapturedAt: now - 60,
					}),
					claudeLimit("claude-b", 81, {
						usedPercentWeekly: 90,
						resetsAt: now + 1800,
						weeklyResetsAt: now + 43200,
						usedPercentCapturedAt: now - 7200,
					}),
				],
			},
		);
		seedAccounts(
			[
				{ id: "acc-a", provider: "claude", name: "claude-a" },
				{ id: "acc-b", provider: "claude", name: "claude-b" },
			],
			{ claude: "acc-a" },
		);
		render(<UsageBadge />);
		fireEvent.click(await screen.findByLabelText(CLAUDE_METER));
		fireEvent.pointerDown(
			await screen.findByRole("button", { name: "Claude 계정 전환" }),
			{ button: 0, ctrlKey: false },
		);

		const activeRow = await screen.findByRole("menuitemradio", {
			name: "Claude Code a@example.com",
		});
		expect(activeRow.getAttribute("aria-checked")).toBe("true");
		expect(activeRow.textContent).toContain("22%");
		expect(activeRow.textContent).toContain("1시간 30분 후 재설정");

		const otherRow = screen.getByRole("menuitemradio", {
			name: "Claude Code b@example.com",
		});
		expect(otherRow.textContent).toContain("81%");
		expect(otherRow.textContent).toContain("30분 후 재설정");
		expect(
			screen.getByRole("menuitemradio", { name: "Claude Code 기본" })
				.textContent,
		).not.toContain("%");
		fireEvent.click(otherRow);
		expect(useStore.getState().activeAccounts.claude).toBe("acc-b");
	});

	it("shows each account's own reset credits separately from workspace credits", async () => {
		const now = Math.floor(Date.now() / 1000);
		const snapshots = [
			{ id: "acc-a", balance: "1250.5", resets: 0 },
			{ id: "acc-b", balance: "0", resets: 3 },
		].map(({ id, balance, resets }) => ({
			credentialId: id,
			capturedAt: now,
			attemptedAt: now,
			error: null,
			rateLimitResetsAvailable: resets,
			rateLimits: [
				{
					limitId: "codex",
					limitName: null,
					usedPercent: 22,
					usedPercentWeekly: null,
					resetsAt: now + 3600,
					weeklyResetsAt: null,
					credits: { hasCredits: balance !== "0", unlimited: false, balance },
				},
			],
		}));
		mockUsage({}, {}, { codexSnapshots: snapshots });
		seedAccounts(
			[
				{ id: "acc-a", provider: "codex", name: "codex-a" },
				{ id: "acc-b", provider: "codex", name: "codex-b" },
			],
			{ codex: "acc-a" },
		);
		render(<UsageBadge />);
		fireEvent.click(await screen.findByLabelText(CODEX_METER));
		await openAccountMenu("Codex");
		const current = screen.getByRole("menuitemradio", {
			name: "Codex codex-a",
		});
		const other = screen.getByRole("menuitemradio", { name: "Codex codex-b" });
		expect(current.textContent).toContain("1,250.5");
		expect(other.textContent).toContain("크레딧 0");
		expect(current.textContent).toContain("한도 초기화 0회");
		expect(other.textContent).toContain("한도 초기화 3회");
		expect(
			screen.getByRole("menuitemradio", { name: "Codex 기본" }).textContent,
		).not.toContain("한도 초기화 3회");
		expect(
			screen.getByRole("menuitemradio", { name: "Codex 기본" }).textContent,
		).not.toContain("1,250.5");
		expect(current.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(other);
		expect(useStore.getState().activeAccounts.codex).toBe("acc-b");
	});

	it("사용하지 않은 Codex 계정도 마지막 snapshot을 한 목록에 보존해 표시한다", async () => {
		const now = Math.floor(Date.now() / 1000);
		mockUsage(
			{},
			{ usedPercent: 67 },
			{
				codexSnapshots: [
					{
						credentialId: "acc-a",
						capturedAt: now - 60,
						attemptedAt: now - 60,
						error: null,
						rateLimits: [
							{
								limitId: "codex",
								limitName: null,
								usedPercent: 22,
								usedPercentWeekly: 35,
								resetsAt: now + 5400,
								weeklyResetsAt: now + 86400,
							},
						],
					},
					{
						credentialId: "acc-b",
						capturedAt: now - 7200,
						attemptedAt: now - 60,
						error: "codex_usage_unavailable",
						rateLimits: [
							{
								limitId: "codex",
								limitName: null,
								usedPercent: 81,
								usedPercentWeekly: 90,
								resetsAt: now + 1800,
								weeklyResetsAt: now + 43200,
							},
						],
					},
				],
			},
		);
		seedAccounts(
			[
				{ id: "acc-a", provider: "codex", name: "codex-a" },
				{ id: "acc-b", provider: "codex", name: "codex-b" },
			],
			{ codex: "acc-a" },
		);
		render(<UsageBadge />);
		fireEvent.click(await screen.findByLabelText(CODEX_METER));
		await openAccountMenu("Codex");

		const rows = document.querySelectorAll(
			'[data-slot="codex-subscription-usage"]',
		);
		expect(rows).toHaveLength(3);
		expect(
			screen.getByRole("menuitemradio", { name: "Codex 기본" }).textContent,
		).not.toContain("67%");
		const current = screen.getByRole("menuitemradio", {
			name: "Codex codex-a",
		});
		expect(current.textContent).toContain("22%");
		expect(current.textContent).toContain("1시간 30분 후 재설정");
		const retained = screen.getByRole("menuitemradio", {
			name: "Codex codex-b",
		});
		expect(retained.textContent).toContain("81%");
		expect(retained.textContent).toContain("30분 후 재설정");
	});

	it("'기본' 행의 접근성 이름은 provider로 한정된다", async () => {
		mockUsage({});
		seedAccounts([{ id: "acc-cx", provider: "codex", name: "codex-work" }]);
		render(<UsageBadge />);
		fireEvent.click(await screen.findByLabelText(CODEX_METER));
		await openAccountMenu("Codex");
		const row = await screen.findByRole("menuitemradio", { name: /기본$/ });
		expect(row.getAttribute("aria-label")).toBe("Codex 기본");
	});

	it("기본(계정 미지정) 행을 클릭하면 활성 계정 지정이 해제된다", async () => {
		mockUsage({});
		seedAccounts([{ id: "acc-a", provider: "codex", name: "codex-a" }], {
			codex: "acc-a",
		});
		render(<UsageBadge />);
		fireEvent.click(await screen.findByLabelText(CODEX_METER));
		await openAccountMenu("Codex");
		fireEvent.click(screen.getByRole("menuitemradio", { name: /기본/ }));
		expect(useStore.getState().activeAccounts.codex).toBeUndefined();
	});

	// 사용자 보고(2026-07-29): 계정을 바꿔도 사용량이 그대로였다.
	it("활성 Claude 계정을 바꾸면 그 계정의 실측 한도가 표시된다", async () => {
		const now = Math.floor(Date.now() / 1000);
		mockUsage(
			{ usedPercent: 63 },
			{},
			{
				claudeAccounts: [
					claudeLimit("default", 7, { resetsAt: now + 3600 }),
					claudeLimit("claude-work", 61, { resetsAt: now + 3600 }),
				],
			},
		);
		seedAccounts([{ id: "acc-cl", provider: "claude", name: "claude-work" }]);
		render(<UsageBadge />);
		await screen.findByLabelText(CLAUDE_METER);
		expect(meterRing(CLAUDE_METER).dataset.pct).toBe("7");
		expect(
			screen
				.getByLabelText(CLAUDE_METER)
				.querySelector('[data-slot="usage-meter-label"]'),
		).toBeNull();

		useStore.setState({ activeAccounts: { claude: "acc-cl" } });
		await waitFor(() => expect(meterRing(CLAUDE_METER).dataset.pct).toBe("61"));
		expect(
			screen
				.getByLabelText(CLAUDE_METER)
				.querySelector('[data-slot="usage-meter-label"]')?.textContent,
		).toBe("61%");
	});

	it("수집 이력이 없는 Claude 계정은 다른 계정 %를 빌려오지 않는다", async () => {
		const now = Math.floor(Date.now() / 1000);
		mockUsage(
			{ usedPercent: 63 },
			{},
			{ claudeAccounts: [claudeLimit("default", 7, { resetsAt: now + 3600 })] },
		);
		seedAccounts([{ id: "acc-cl", provider: "claude", name: "claude-work" }], {
			claude: "acc-cl",
		});
		render(<UsageBadge />);
		// unknown ring만 뜨고 다른 계정의 %나 토큰을 상단에 빌려오지 않는다.
		await screen.findByLabelText(CLAUDE_METER);
		expect(meterRing(CLAUDE_METER).dataset.level).toBe("unknown");
		expect(screen.queryByText("150")).toBeNull();
		expect(screen.queryByText(/%/)).toBeNull();
	});

	it("활성 Codex 계정을 바꾸면 저널로 귀속된 그 계정 세션만 센다", async () => {
		const now = Math.floor(Date.now() / 1000);
		mockUsage(
			{},
			{ usedPercent: 78 },
			{
				codexAccounts: [
					{
						credentialId: "acc-a",
						attributed: true,
						observedOnly: false,
						usage: provider({ usedPercent: 12, resetsAt: now + 3600 }),
					},
					{
						credentialId: "acc-b",
						attributed: true,
						observedOnly: false,
						usage: provider({ usedPercent: 90, resetsAt: now + 3600 }),
					},
				],
			},
		);
		seedAccounts(
			[
				{ id: "acc-a", provider: "codex", name: "codex-a" },
				{ id: "acc-b", provider: "codex", name: "codex-b" },
			],
			{ codex: "acc-a" },
		);
		render(<UsageBadge />);
		await screen.findByLabelText(CODEX_METER);
		expect(meterRing(CODEX_METER).dataset.pct).toBe("12");
		expect(
			screen
				.getByLabelText(CODEX_METER)
				.querySelector('[data-slot="usage-meter-label"]'),
		).toBeNull();

		useStore.setState({ activeAccounts: { codex: "acc-b" } });
		await waitFor(() => expect(meterRing(CODEX_METER).dataset.pct).toBe("90"));
		expect(
			screen
				.getByLabelText(CODEX_METER)
				.querySelector('[data-slot="usage-meter-label"]')?.textContent,
		).toBe("90%");
		// 전체 합계(78%)는 계정 값인 척 나타나지 않는다
		expect(screen.queryByText(/78%/)).toBeNull();
	});

	it("귀속 기록이 하나도 없으면 전체 합계를 쓰되 그 사실을 밝힌다", async () => {
		const now = Math.floor(Date.now() / 1000);
		mockUsage(
			{},
			{ usedPercent: 78, resetsAt: now + 3600 },
			{
				codexAccounts: [
					{
						credentialId: null,
						attributed: false,
						observedOnly: false,
						usage: provider({}),
					},
				],
			},
		);
		render(<UsageBadge />);
		fireEvent.click(await screen.findByLabelText(CODEX_METER));
		expect(
			await screen.findByText(/계정 귀속 기록이 없어 지금 값은 합계/),
		).toBeTruthy();
	});

	// codex-crispy 사례: 재부착만 있는 장수 세션. 숫자는 보이되 근거 등급을 밝힌다.
	it("관측 전용 계정은 숫자를 보여주되 근거가 재부착 관측임을 밝힌다", async () => {
		const now = Math.floor(Date.now() / 1000);
		mockUsage(
			{},
			{ usedPercent: 78 },
			{
				codexAccounts: [
					{
						credentialId: "acc-crispy",
						attributed: true,
						observedOnly: true,
						usage: provider({ usedPercent: 21, resetsAt: now + 3600 }),
					},
				],
			},
		);
		seedAccounts(
			[{ id: "acc-crispy", provider: "codex", name: "codex-crispy" }],
			{ codex: "acc-crispy" },
		);
		render(<UsageBadge />);
		await screen.findByLabelText(CODEX_METER);
		expect(meterRing(CODEX_METER).dataset.pct).toBe("21");
		expect(
			screen
				.getByLabelText(CODEX_METER)
				.querySelector('[data-slot="usage-meter-label"]'),
		).toBeNull();
		fireEvent.click(screen.getByLabelText(CODEX_METER));
		const popover = await screen.findByRole("dialog", {
			name: CODEX_METER,
		});
		expect(within(popover).getAllByText(/21%/)).toHaveLength(1);
		expect(await screen.findByText(/재부착 관측 기준/)).toBeTruthy();
		expect(screen.queryByText(/계정 귀속 기록이 없어/)).toBeNull();
	});
});
