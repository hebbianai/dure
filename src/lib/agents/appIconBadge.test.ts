import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreApi } from "zustand";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { DEFAULT_NOTIFY_PREFS, type NotifyPrefs } from "@/lib/settings/notifyPrefs";

interface AppFacts {
	agents: { id: string }[];
	notifyPrefs: Partial<NotifyPrefs>;
}

const mocks = vi.hoisted(() => ({
	store: undefined as unknown as StoreApi<AppFacts>,
}));

vi.mock("@/store", async () => {
	const { create: createStore } = await import("zustand");
	mocks.store = createStore<AppFacts>(() => ({ agents: [], notifyPrefs: {} }));
	return { useStore: mocks.store };
});

import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import {
	appIconBadgeCount,
	installAppIconBadge,
	supportsAppIconBadge,
} from "@/lib/agents/appIconBadge";

function setDisplayStates(displayStates: Record<string, AgentDisplayState>) {
	useAgentAttention.setState({ displayStates });
}

function install() {
	const setBadge = vi.fn(async (_count: number | undefined) => undefined);
	const stop = installAppIconBadge({ setBadge, platform: "macos" });
	return { setBadge, stop };
}

beforeEach(() => {
	useAgentAttention.setState(useAgentAttention.getInitialState(), true);
	mocks.store.setState({
		agents: ["a", "b", "c"].map((id) => ({ id })),
		notifyPrefs: { ...DEFAULT_NOTIFY_PREFS },
	});
});

describe("appIconBadgeCount", () => {
	it("shows the Needs you count and clears at zero or when switched off", () => {
		expect(appIconBadgeCount(2, true)).toBe(2);
		expect(appIconBadgeCount(0, true)).toBeUndefined();
		expect(appIconBadgeCount(2, false)).toBeUndefined();
	});

	it("draws only on the Dock", () => {
		expect(supportsAppIconBadge("macos")).toBe(true);
		expect(supportsAppIconBadge("linux")).toBe(false);
		expect(supportsAppIconBadge("windows")).toBe(false);
		expect(supportsAppIconBadge("unknown")).toBe(false);
	});
});

describe("installAppIconBadge", () => {
	it("clears any earlier badge on install, then follows the Needs you count", () => {
		const { setBadge, stop } = install();
		expect(setBadge.mock.calls).toEqual([[undefined]]);

		setDisplayStates({ a: "blocked", b: "input", c: "working" });
		setDisplayStates({ a: "blocked", b: "error", c: "working" });
		setDisplayStates({ a: "working", b: "error", c: "waiting" });
		setDisplayStates({ a: "working", b: "working", c: "waiting" });

		// The same count is not sent twice; zero clears instead of drawing "0".
		expect(setBadge.mock.calls).toEqual([[undefined], [2], [1], [undefined]]);
		stop();
	});

	it("leaves finished turns off the badge", () => {
		const { setBadge, stop } = install();
		useAgentAttention.setState({
			displayStates: { a: "waiting" },
			episodes: { a: 1 },
			episodeKinds: { a: "done" },
		});
		expect(setBadge.mock.calls).toEqual([[undefined]]);
		stop();
	});

	it("drops an agent that is removed from the app", () => {
		const { setBadge, stop } = install();
		setDisplayStates({ a: "blocked", b: "input" });
		mocks.store.setState({ agents: [{ id: "b" }] });
		expect(setBadge.mock.calls).toEqual([[undefined], [2], [1]]);
		stop();
	});

	it("clears when the setting is switched off and returns when it is on", () => {
		const { setBadge, stop } = install();
		setDisplayStates({ a: "blocked" });
		mocks.store.setState({
			notifyPrefs: { ...DEFAULT_NOTIFY_PREFS, appIconBadge: false },
		});
		setDisplayStates({ a: "blocked", b: "input" });
		mocks.store.setState({ notifyPrefs: { ...DEFAULT_NOTIFY_PREFS } });
		expect(setBadge.mock.calls).toEqual([[undefined], [1], [undefined], [2]]);
		stop();
	});

	it("keeps the badge when notifications are off", () => {
		mocks.store.setState({
			notifyPrefs: { ...DEFAULT_NOTIFY_PREFS, enabled: false },
		});
		const { setBadge, stop } = install();
		setDisplayStates({ a: "blocked" });
		expect(setBadge.mock.calls).toEqual([[undefined], [1]]);
		stop();
	});

	it("clears the badge and stops following on cleanup", () => {
		const { setBadge, stop } = install();
		setDisplayStates({ a: "blocked" });
		stop();
		setDisplayStates({ a: "blocked", b: "input" });
		expect(setBadge.mock.calls).toEqual([[undefined], [1], [undefined]]);
	});

	it("does nothing where the platform draws no count", () => {
		const setBadge = vi.fn(async () => undefined);
		const stop = installAppIconBadge({ setBadge, platform: "windows" });
		setDisplayStates({ a: "blocked" });
		stop();
		expect(setBadge).not.toHaveBeenCalled();
	});

	it("keeps following after the native call fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const setBadge = vi
			.fn(async (_count: number | undefined) => undefined)
			.mockRejectedValueOnce(new Error("no window"));
		const stop = installAppIconBadge({ setBadge, platform: "macos" });
		await Promise.resolve();
		setDisplayStates({ a: "blocked" });
		expect(setBadge.mock.calls).toEqual([[undefined], [1]]);
		expect(warn).toHaveBeenCalledOnce();
		stop();
		warn.mockRestore();
	});
});
