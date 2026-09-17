import { describe, expect, it } from "vitest";
import { supportsCanonicalAgentName } from "@/lib/agents/agentName";
import {
	deterministicQuickDispatchName,
	fallbackAgentSlug,
	repoClaimedAgentNames,
	sanitizeAgentNameCandidate,
	suggestQuickDispatchName,
	uniqueAgentName,
} from "@/lib/agents/quickDispatch/quickDispatchNaming";

describe("fallbackAgentSlug", () => {
	it("builds a kebab slug from the first meaningful words", () => {
		expect(
			fallbackAgentSlug("Fix the sidebar flicker when resizing panes"),
		).toBe("fix-the-sidebar-flicker");
	});
	it("returns null for korean-only prompts", () => {
		expect(fallbackAgentSlug("사이드바 깜빡임 고쳐줘")).toBeNull();
	});
	it("always yields a canonical agent name", () => {
		for (const prompt of [
			"Fix THE bug!!",
			"a b",
			"update    README.md   badges now",
			"12 rewrite the 34 parser",
		]) {
			const slug = fallbackAgentSlug(prompt);
			if (slug !== null) expect(supportsCanonicalAgentName(slug)).toBe(true);
		}
	});
});

describe("repoClaimedAgentNames", () => {
	const repo = {
		branches: [
			{ name: "main" },
			{ name: "agent/fix" },
			{ name: "agent/fix-2", checkedOutAt: "/repo/p/.worktrees/fix-2" },
			{ name: "codex/fix-3" },
		],
		worktrees: [
			{ path: "/repo/p", branch: "main", isMain: true },
			{ path: "/repo/p/.worktrees/fix-2", branch: "agent/fix-2", isMain: false },
			{ path: "/repo/p/.worktrees/fix-3", branch: "codex/fix-3", isMain: false },
			{ path: "/elsewhere/fix-4", branch: "agent/fix-4", isMain: false },
		],
	};

	it("claims agent branches and default-root worktree directories once", () => {
		expect(repoClaimedAgentNames(repo, "/repo/p/")).toEqual([
			"fix",
			"fix-2",
			"fix-3",
		]);
	});

	it("skips the name a deleted agent left behind in the repository", () => {
		// 2026-09-11: prompt "Fix" re-picked an agent/fix-N branch that still
		// existed and the spawn saga refused it as workspace_identity_conflict.
		const takenNames = repoClaimedAgentNames(repo, "/repo/p");
		expect(
			deterministicQuickDispatchName({
				prompt: "Fix",
				providerId: "codex",
				takenNames: [],
			}),
		).toBe("fix");
		expect(
			deterministicQuickDispatchName({
				prompt: "Fix",
				providerId: "codex",
				takenNames,
			}),
		).toBe("fix-4");
	});
});

describe("sanitizeAgentNameCandidate", () => {
	it("normalizes an AI answer to a canonical name", () => {
		expect(sanitizeAgentNameCandidate("  Fix-Sidebar-Flicker.\n")).toBe(
			"fix-sidebar-flicker",
		);
	});
	it("rejects candidates with no usable characters", () => {
		expect(sanitizeAgentNameCandidate("한국어만")).toBeNull();
		expect(sanitizeAgentNameCandidate("---")).toBeNull();
	});
	it("caps length at 64 and keeps alnum boundaries", () => {
		const out = sanitizeAgentNameCandidate(`${"a".repeat(80)}-`);
		expect(out).toBe("a".repeat(64));
	});
});

describe("uniqueAgentName", () => {
	it("returns the base when free", () => {
		expect(uniqueAgentName("fix-x", ["other"])).toBe("fix-x");
	});
	it("suffixes -2, -3… on collision", () => {
		expect(uniqueAgentName("fix-x", ["fix-x", "fix-x-2"])).toBe("fix-x-3");
	});
	it("stays canonical when suffixing near the length cap", () => {
		const base = "a".repeat(64);
		const out = uniqueAgentName(base, [base]);
		expect(supportsCanonicalAgentName(out)).toBe(true);
	});
});

describe("suggestQuickDispatchName", () => {
	const base = {
		prompt: "Fix the sidebar flicker",
		providerId: "claude" as const,
		projectPath: "/tmp/p",
		takenNames: [] as string[],
	};

	it("uses the sanitized AI suggestion when it arrives in time", async () => {
		const name = await suggestQuickDispatchName(base, {
			suggest: async () => "Fix-Sidebar-Flicker\n",
			timeoutMs: 50,
		});
		expect(name).toBe("fix-sidebar-flicker");
	});

	it("falls back to the heuristic slug on timeout", async () => {
		const name = await suggestQuickDispatchName(base, {
			suggest: () => new Promise(() => {}),
			timeoutMs: 10,
		});
		expect(name).toBe("fix-the-sidebar-flicker");
	});

	it("falls back to provider-count naming when nothing is derivable", async () => {
		const name = await suggestQuickDispatchName(
			{ ...base, prompt: "사이드바 깜빡임", takenNames: ["claude-1"] },
			{ suggest: async () => "한국어만", timeoutMs: 50 },
		);
		expect(name).toBe("claude-2");
	});

	it("dedupes against taken names", async () => {
		const name = await suggestQuickDispatchName(
			{ ...base, takenNames: ["fix-sidebar-flicker"] },
			{ suggest: async () => "fix-sidebar-flicker", timeoutMs: 50 },
		);
		expect(name).toBe("fix-sidebar-flicker-2");
	});

	it("rejects a slugified error sentence and falls back to the heuristic", async () => {
		// The naming CLI runs in the project cwd and initializes its MCP servers;
		// an MCP error printed to stdout would otherwise slugify into the name.
		const name = await suggestQuickDispatchName(base, {
			suggest: async () =>
				"client.listTools called but server does not advertise a tools capability",
			timeoutMs: 50,
		});
		expect(name).toBe("fix-the-sidebar-flicker");
	});

	it("rejects a name candidate carrying a dotted identity token", async () => {
		const name = await suggestQuickDispatchName(base, {
			suggest: async () => "mcp.server.error",
			timeoutMs: 50,
		});
		expect(name).toBe("fix-the-sidebar-flicker");
	});

	it("accepts a legitimate four-word AI name", async () => {
		const name = await suggestQuickDispatchName(base, {
			suggest: async () => "align-login-button-styles\n",
			timeoutMs: 50,
		});
		expect(name).toBe("align-login-button-styles");
	});
});
