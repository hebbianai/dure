// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCredentialSwitcher } from "@/components/agents/AgentCredentialSwitcher";
import type { UsageRecentReport } from "@/lib/ipc";

const { usageRecentMock } = vi.hoisted(() => ({ usageRecentMock: vi.fn() }));
vi.mock("@/lib/ipc", async (original) => ({
	...(await original<typeof import("@/lib/ipc")>()),
	usageRecent: usageRecentMock,
}));

const accounts = ["work", "personal", "unknown"].map((id) => ({
	id,
	name: id,
	provider: "codex" as const,
	dir: `/fixture/${id}`,
}));
const props = {
	provider: "codex" as const,
	accounts,
	currentAccount: accounts[0],
	followsGlobal: false,
	accountBusy: false,
	disabled: false,
	disabledTitle: "Pane account",
	onSwitch: vi.fn(),
	onApplyNow: vi.fn(),
	onCancel: vi.fn(),
	onRemoteLogin: vi.fn(),
	onCopyToHost: vi.fn(),
	onManageAccounts: vi.fn(),
};
const emptyUsage = {
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
};
const report = (workPercent = 41): UsageRecentReport => ({
	claude: emptyUsage,
	codex: { ...emptyUsage, usedPercent: 99 },
	claudeAccounts: [],
	codexAccounts: [],
	codexAccountSnapshots: accounts.slice(0, 2).map((a, i) => ({
		credentialId: a.id,
		capturedAt: Date.now() / 1000,
		attemptedAt: Date.now() / 1000,
		error: null,
		rateLimits: [
			{
				limitId: "codex",
				limitName: null,
				usedPercent: null,
				usedPercentWeekly: i ? 0 : workPercent,
				resetsAt: null,
				weeklyResetsAt: Math.floor(Date.now() / 1000) + 5 * 86400,
			},
		],
	})),
});
const openMenu = () =>
	fireEvent.pointerDown(screen.getByRole("button", { name: "Pane account" }), {
		button: 0,
		ctrlKey: false,
	});
beforeEach(() => {
	usageRecentMock.mockResolvedValue(report());
	props.onSwitch.mockClear();
});
afterEach(() => {
	cleanup();
	usageRecentMock.mockReset();
});

describe("pane account usage", () => {
	it("reads once on open and keeps exact account limits distinct from aggregate usage", async () => {
		render(<AgentCredentialSwitcher {...props} />);
		expect(usageRecentMock).not.toHaveBeenCalled();
		openMenu();
		const work = await screen.findByRole("menuitem", { name: /work/ });
		expect(await within(work).findByText("41%")).toBeTruthy();
		expect(
			within(screen.getByRole("menuitem", { name: /personal/ })).getByText(
				"0%",
			),
		).toBeTruthy();
		expect(
			screen.getByRole("menuitem", { name: /unknown/ }).textContent,
		).not.toContain("%");
		expect(screen.queryByText("99%")).toBeNull();
		expect(usageRecentMock).toHaveBeenCalledExactlyOnceWith(5);
		fireEvent.click(screen.getByRole("menuitem", { name: /personal/ }));
		expect(props.onSwitch).toHaveBeenCalledExactlyOnceWith("personal");
	});

	it.each([{ hostName: "Remote" }, { provider: "gemini" as const }])(
		"does not query local limits outside the supported local scope: %j",
		async (scope) => {
			render(<AgentCredentialSwitcher {...props} {...scope} />);
			openMenu();
			await screen.findByRole("menuitem", { name: /personal/ });
			expect(usageRecentMock).not.toHaveBeenCalled();
		},
	);

	it("leaves account selection usable when usage cannot be loaded", async () => {
		usageRecentMock.mockRejectedValue(new Error("usage unavailable"));
		render(<AgentCredentialSwitcher {...props} />);
		openMenu();
		fireEvent.click(await screen.findByRole("menuitem", { name: /personal/ }));
		await act(async () => {});
		expect(props.onSwitch).toHaveBeenCalledExactlyOnceWith("personal");
	});

	it("ignores an earlier menu's late response after reopening", async () => {
		let resolveEarlier!: (value: UsageRecentReport) => void;
		usageRecentMock.mockReturnValueOnce(
			new Promise<UsageRecentReport>((resolve) => {
				resolveEarlier = resolve;
			}),
		);
		render(<AgentCredentialSwitcher {...props} />);
		openMenu();
		fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
		openMenu();
		expect(await screen.findByText("41%")).toBeTruthy();
		await act(async () => resolveEarlier(report(73)));
		expect(screen.getByText("41%")).toBeTruthy();
		expect(screen.queryByText("73%")).toBeNull();
		expect(usageRecentMock).toHaveBeenCalledTimes(2);
	});
});
