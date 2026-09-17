// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderPreflight } from "@/lib/ipc";
import type { ProviderCliUpdate } from "@/lib/updates/providerCliUpdateSource";

const evaluateProviderCliUpdate = vi.fn();
const refreshProviderCliUpdateNotice = vi.fn();
const runProviderCliUpdate = vi.fn();

vi.mock("@/lib/updates/providerCliUpdateSource", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/updates/providerCliUpdateSource")
	>()),
	evaluateProviderCliUpdate: (...args: unknown[]) =>
		evaluateProviderCliUpdate(...args),
	refreshProviderCliUpdateNotice: (...args: unknown[]) =>
		refreshProviderCliUpdateNotice(...args),
}));
vi.mock("@/lib/updates/providerCliUpdateRun", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/updates/providerCliUpdateRun")
	>()),
	runProviderCliUpdate: (...args: unknown[]) => runProviderCliUpdate(...args),
}));

import { ProviderCliUpdateRow } from "@/components/settings/ProviderCliUpdateRow";
import { projectProviderCliUpdateNotice } from "@/lib/updates/providerCliUpdateSource";
import {
	resetUpdateNotices,
	updateNoticeSnapshot,
} from "@/lib/updates/updateNotice";

function preflight(): ProviderPreflight {
	return {
		provider: "claude",
		command: "claude",
		ready: true,
		status: "ready",
		message: "",
		shell: "/bin/zsh",
		cwd: "/",
		environmentSource: "login_shell",
		symlinkChain: [],
		executable: true,
		versionTimeoutMs: 10_000,
		recoveryRequiresUserApproval: false,
		suggestedRecovery: [],
		version: "2.1.252 (Claude Code)",
		resolvedPath: "/opt/homebrew/Caskroom/claude-code@latest/2.1.252/claude",
	};
}

const COMMAND = "brew upgrade --cask claude-code@latest";

function update(overrides: Partial<ProviderCliUpdate> = {}): ProviderCliUpdate {
	return {
		provider: "claude",
		installedVersion: "2.1.252",
		latestVersion: "2.1.258",
		plan: { provider: "claude", channel: "brew-cask", command: COMMAND },
		resolvedPath: "/opt/homebrew/Caskroom/claude-code@latest/2.1.252/claude",
		docsUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
		...overrides,
	};
}

beforeEach(() => {
	evaluateProviderCliUpdate.mockReset();
	refreshProviderCliUpdateNotice.mockReset();
	runProviderCliUpdate.mockReset();
	resetUpdateNotices();
});
afterEach(() => {
	cleanup();
	resetUpdateNotices();
});

// t() resolves against the ko catalog by default in jsdom tests
// (src/test/setup.ts loads "ko" and src/lib/i18n.ts defaults `current` to
// "ko"), so user-visible copy assertions below match the Korean strings this
// task adds, the same way AgentToolingPage.test.tsx asserts "업데이트"/"설치"
// rather than the English source strings.
describe("ProviderCliUpdateRow", () => {
	it("renders nothing when no update is available", async () => {
		evaluateProviderCliUpdate.mockResolvedValue(null);
		const { container } = render(
			<ProviderCliUpdateRow
				provider="claude"
				preflight={preflight()}
				refreshPreflight={vi.fn()}
			/>,
		);
		await waitFor(() => expect(evaluateProviderCliUpdate).toHaveBeenCalled());
		expect(container.innerHTML).toBe("");
	});

	it("shows the version pair, the verbatim command, and an Update button", async () => {
		evaluateProviderCliUpdate.mockResolvedValue(update());
		render(
			<ProviderCliUpdateRow
				provider="claude"
				preflight={preflight()}
				refreshPreflight={vi.fn()}
			/>,
		);
		expect(await screen.findByText("2.1.252 → 2.1.258")).toBeTruthy();
		expect(screen.getByText(COMMAND)).toBeTruthy();
		expect(screen.getByRole("button", { name: "업데이트" })).toBeTruthy();
	});

	it("shows guidance without a button when the channel is unknown", async () => {
		evaluateProviderCliUpdate.mockResolvedValue(update({ plan: null }));
		render(
			<ProviderCliUpdateRow
				provider="claude"
				preflight={preflight()}
				refreshPreflight={vi.fn()}
			/>,
		);
		expect(await screen.findByText(/2\.1\.258/)).toBeTruthy();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("refreshes the page and aggregate notice after a successful update", async () => {
		evaluateProviderCliUpdate.mockResolvedValue(update());
		runProviderCliUpdate.mockResolvedValue({
			kind: "updated",
			fromVersion: "2.1.252",
			toVersion: "2.1.258",
		});
		projectProviderCliUpdateNotice({ updates: [update()], indeterminate: [] });
		refreshProviderCliUpdateNotice.mockImplementation(async () => {
			projectProviderCliUpdateNotice({ updates: [], indeterminate: [] });
		});
		const refreshPreflight = vi.fn(async () => {});
		render(
			<ProviderCliUpdateRow
				provider="claude"
				preflight={preflight()}
				refreshPreflight={refreshPreflight}
			/>,
		);
		fireEvent.click(await screen.findByRole("button", { name: "업데이트" }));
		await waitFor(() =>
			expect(refreshPreflight).toHaveBeenCalledWith("claude"),
		);
		await waitFor(() => expect(updateNoticeSnapshot().unresolvedCount).toBe(0));
		expect(refreshProviderCliUpdateNotice).toHaveBeenCalledOnce();
	});

	it("surfaces the unchanged warning with the resolved path", async () => {
		evaluateProviderCliUpdate.mockResolvedValue(update());
		runProviderCliUpdate.mockResolvedValue({
			kind: "unchanged",
			version: "2.1.252",
			resolvedPath: "/opt/homebrew/Caskroom/claude-code@latest/2.1.252/claude",
		});
		render(
			<ProviderCliUpdateRow
				provider="claude"
				preflight={preflight()}
				refreshPreflight={vi.fn()}
			/>,
		);
		fireEvent.click(await screen.findByRole("button", { name: "업데이트" }));
		expect(await screen.findByText(/여전히 2\.1\.252/)).toBeTruthy();
	});

	it("shows the resolved path when the channel is unknown", async () => {
		evaluateProviderCliUpdate.mockResolvedValue(update({ plan: null }));
		render(
			<ProviderCliUpdateRow
				provider="claude"
				preflight={preflight()}
				refreshPreflight={vi.fn()}
			/>,
		);
		expect(
			await screen.findByText(
				"/opt/homebrew/Caskroom/claude-code@latest/2.1.252/claude",
			),
		).toBeTruthy();
	});

	it("refreshes the page preflight when a fresh check finds no update left", async () => {
		evaluateProviderCliUpdate.mockResolvedValue(update());
		runProviderCliUpdate.mockResolvedValue({
			kind: "plan_changed",
			fresh: null,
		});
		const refreshPreflight = vi.fn(async () => {});
		render(
			<ProviderCliUpdateRow
				provider="claude"
				preflight={preflight()}
				refreshPreflight={refreshPreflight}
			/>,
		);
		fireEvent.click(await screen.findByRole("button", { name: "업데이트" }));
		await waitFor(() =>
			expect(refreshPreflight).toHaveBeenCalledWith("claude"),
		);
		expect(refreshProviderCliUpdateNotice).toHaveBeenCalledOnce();
	});

	it("shows the refreshed command when the plan changed but an update remains", async () => {
		evaluateProviderCliUpdate.mockResolvedValue(update());
		const NEW_COMMAND = "npm install -g @anthropic-ai/claude-code@latest";
		runProviderCliUpdate.mockResolvedValue({
			kind: "plan_changed",
			fresh: update({
				plan: {
					provider: "claude",
					channel: "npm-global",
					command: NEW_COMMAND,
				},
			}),
		});
		const refreshPreflight = vi.fn(async () => {});
		render(
			<ProviderCliUpdateRow
				provider="claude"
				preflight={preflight()}
				refreshPreflight={refreshPreflight}
			/>,
		);
		fireEvent.click(await screen.findByRole("button", { name: "업데이트" }));
		expect(await screen.findByText(NEW_COMMAND)).toBeTruthy();
		expect(refreshPreflight).not.toHaveBeenCalled();
	});
});
