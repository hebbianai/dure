import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderPreflight } from "@/lib/ipc";
import {
	evaluateProviderCliUpdate,
	fetchLatestCliVersion,
	probeProviderCliUpdates,
	projectProviderCliUpdateNotice,
	refreshProviderCliUpdateNotice,
	resetProviderCliUpdateCaches,
} from "@/lib/updates/providerCliUpdateSource";
import {
	resetUpdateNotices,
	updateNoticeSnapshot,
} from "@/lib/updates/updateNotice";

function preflight(overrides: Partial<ProviderPreflight>): ProviderPreflight {
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
		...overrides,
	};
}

function registryFetcher(version: string) {
	return vi.fn(async () => ({
		ok: true,
		json: async () => ({ version }),
	})) as unknown as typeof fetch;
}

beforeEach(() => {
	resetProviderCliUpdateCaches();
	resetUpdateNotices();
});

describe("fetchLatestCliVersion", () => {
	it("returns the registry version and caches it", async () => {
		const fetcher = registryFetcher("2.1.258");
		expect(
			await fetchLatestCliVersion("@anthropic-ai/claude-code", { fetcher }),
		).toBe("2.1.258");
		expect(
			await fetchLatestCliVersion("@anthropic-ai/claude-code", { fetcher }),
		).toBe("2.1.258");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("expires the cache after the TTL", async () => {
		const fetcher = registryFetcher("2.1.258");
		let clock = 0;
		const now = () => clock;
		await fetchLatestCliVersion("@anthropic-ai/claude-code", { fetcher, now });
		clock = 56 * 60 * 1000;
		await fetchLatestCliVersion("@anthropic-ai/claude-code", { fetcher, now });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it("returns null on network failure or non-ok responses", async () => {
		const failing = vi.fn(async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		expect(
			await fetchLatestCliVersion("@openai/codex", { fetcher: failing }),
		).toBeNull();
		resetProviderCliUpdateCaches();
		const notOk = vi.fn(async () => ({
			ok: false,
			json: async () => ({}),
		})) as unknown as typeof fetch;
		expect(
			await fetchLatestCliVersion("@openai/codex", { fetcher: notOk }),
		).toBeNull();
	});
	it("keeps the last known version when a later fetch fails (stale-on-error)", async () => {
		let clock = 0;
		const now = () => clock;
		await fetchLatestCliVersion("@openai/codex", {
			fetcher: registryFetcher("0.152.1"),
			now,
		});
		clock = 56 * 60 * 1000;
		const failing = vi.fn(async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		// The spec's "registry failure keeps the last known state" lands here:
		// a failed refresh serves the stale value instead of erasing it, so an
		// offline hour never clears an existing update notice.
		expect(
			await fetchLatestCliVersion("@openai/codex", { fetcher: failing, now }),
		).toBe("0.152.1");
	});
	it("re-attempts the fetch after a failure instead of negative-caching", async () => {
		const now = () => 0;
		const failing = vi.fn(async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		expect(
			await fetchLatestCliVersion("@anthropic-ai/claude-code", {
				fetcher: failing,
				now,
			}),
		).toBeNull();
		// Same clock as the failed call: under a negative cache this would be
		// served the stale (null) value without ever calling `working`.
		const working = registryFetcher("2.1.258");
		expect(
			await fetchLatestCliVersion("@anthropic-ai/claude-code", {
				fetcher: working,
				now,
			}),
		).toBe("2.1.258");
		expect(working).toHaveBeenCalled();
	});
});

describe("evaluateProviderCliUpdate", () => {
	const runCommand = vi.fn(async () => ({
		stdout: "/opt/homebrew\n",
		stderr: "",
		code: 0,
	}));

	it("returns an update with a brew plan when the registry is newer", async () => {
		const update = await evaluateProviderCliUpdate("claude", preflight({}), {
			fetcher: registryFetcher("2.1.258"),
			runCommand,
			platform: "macos",
		});
		expect(update).toMatchObject({
			provider: "claude",
			installedVersion: "2.1.252",
			latestVersion: "2.1.258",
			resolvedPath: "/opt/homebrew/Caskroom/claude-code@latest/2.1.252/claude",
		});
		expect(update?.plan?.command).toBe(
			"brew upgrade --cask claude-code@latest",
		);
	});

	it("returns null when already latest, unseeded, or versions are unknown", async () => {
		expect(
			await evaluateProviderCliUpdate("claude", preflight({}), {
				fetcher: registryFetcher("2.1.252"),
				runCommand,
				platform: "macos",
			}),
		).toBeNull();
		expect(
			await evaluateProviderCliUpdate(
				"gemini",
				preflight({ provider: "gemini" }),
				{
					fetcher: registryFetcher("9.9.9"),
					runCommand,
					platform: "macos",
				},
			),
		).toBeNull();
		expect(
			await evaluateProviderCliUpdate(
				"claude",
				preflight({ version: undefined }),
				{
					fetcher: registryFetcher("2.1.258"),
					runCommand,
					platform: "macos",
				},
			),
		).toBeNull();
	});

	it("keeps the update visible with a null plan when the channel is unknown", async () => {
		const update = await evaluateProviderCliUpdate(
			"claude",
			preflight({ resolvedPath: "/somewhere/odd/claude" }),
			{ fetcher: registryFetcher("2.1.258"), runCommand, platform: "macos" },
		);
		expect(update?.plan).toBeNull();
		expect(update?.latestVersion).toBe("2.1.258");
	});

	it("resolves the npm prefix through runCommand for npm installs", async () => {
		const update = await evaluateProviderCliUpdate(
			"claude",
			preflight({
				resolvedPath:
					"/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
			}),
			{ fetcher: registryFetcher("2.1.258"), runCommand, platform: "macos" },
		);
		expect(runCommand).toHaveBeenCalledWith("npm prefix -g");
		expect(update?.plan?.command).toBe(
			"npm install -g @anthropic-ai/claude-code@latest",
		);
	});
});

describe("projectProviderCliUpdateNotice", () => {
	const sample = {
		provider: "claude" as const,
		installedVersion: "2.1.252",
		latestVersion: "2.1.258",
		plan: {
			provider: "claude" as const,
			channel: "brew-cask" as const,
			command: "brew upgrade --cask claude-code@latest",
		},
		resolvedPath: "/opt/homebrew/Caskroom/claude-code@latest/2.1.252/claude",
		docsUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
	};

	it("upserts one aggregated notice keyed by provider version pairs", () => {
		projectProviderCliUpdateNotice({ updates: [sample], indeterminate: [] });
		const snapshot = updateNoticeSnapshot();
		expect(snapshot.notices).toHaveLength(1);
		expect(snapshot.notices[0]?.sourceRef).toBe("dure.provider-cli");
		expect(snapshot.notices[0]?.revision).toBe(
			JSON.stringify([["claude", "2.1.252", "2.1.258"]]),
		);
		expect(snapshot.notices[0]?.description).toContain("2.1.252 → 2.1.258");
	});

	it("clears the notice when no updates remain", () => {
		projectProviderCliUpdateNotice({ updates: [sample], indeterminate: [] });
		projectProviderCliUpdateNotice({ updates: [], indeterminate: [] });
		expect(updateNoticeSnapshot().notices).toHaveLength(0);
	});

	it("a partially indeterminate result leaves the existing notice untouched", () => {
		projectProviderCliUpdateNotice({ updates: [sample], indeterminate: [] });
		projectProviderCliUpdateNotice({ updates: [], indeterminate: ["codex"] });
		const snapshot = updateNoticeSnapshot();
		expect(snapshot.notices).toHaveLength(1);
		expect(snapshot.notices[0]?.revision).toBe(
			JSON.stringify([["claude", "2.1.252", "2.1.258"]]),
		);
		projectProviderCliUpdateNotice({ updates: [], indeterminate: [] });
		expect(updateNoticeSnapshot().notices).toHaveLength(0);
	});

	it("reports a known update even when another provider is indeterminate", () => {
		projectProviderCliUpdateNotice({
			updates: [sample],
			indeterminate: ["codex"],
		});
		const snapshot = updateNoticeSnapshot();
		expect(snapshot.notices).toHaveLength(1);
		expect(snapshot.notices[0]?.revision).toBe(
			JSON.stringify([["claude", "2.1.252", "2.1.258"]]),
		);
	});

	it("keeps a completed update clear when an older poll finishes later", async () => {
		projectProviderCliUpdateNotice({ updates: [sample], indeterminate: [] });
		let releaseOlderProbe: (() => void) | undefined;
		const olderProbeBlocked = new Promise<void>((resolve) => {
			releaseOlderProbe = resolve;
		});
		const older = refreshProviderCliUpdateNotice({
			fetcher: registryFetcher("2.1.258"),
			preflight: async (provider) => {
				await olderProbeBlocked;
				return preflight({ provider, version: "2.1.252" });
			},
		});

		await refreshProviderCliUpdateNotice({
			fetcher: registryFetcher("2.1.258"),
			preflight: async (provider) =>
				preflight({ provider, version: "2.1.258" }),
		});
		expect(updateNoticeSnapshot().notices).toHaveLength(0);

		releaseOlderProbe?.();
		await older;
		expect(updateNoticeSnapshot().notices).toHaveLength(0);
	});
});

describe("probeProviderCliUpdates", () => {
	it("evaluates every seeded provider and marks failed probes indeterminate", async () => {
		const preflightByProvider = vi.fn(async (provider: "claude" | "codex") => {
			if (provider === "codex") throw new Error("probe failed");
			return preflight({});
		});
		const result = await probeProviderCliUpdates({
			fetcher: registryFetcher("2.1.258"),
			runCommand: vi.fn(async () => ({ stdout: "", stderr: "", code: 1 })),
			platform: "macos",
			preflight: preflightByProvider as never,
		});
		expect(preflightByProvider).toHaveBeenCalledTimes(2);
		expect(result.updates).toHaveLength(1);
		expect(result.updates[0]?.provider).toBe("claude");
		expect(result.indeterminate).toEqual(["codex"]);
	});
});
