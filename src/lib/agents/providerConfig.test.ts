import { beforeEach, describe, expect, it } from "vitest";
import { configDir, envPrefix } from "@/lib/agents/providerConfig";
import { useStore } from "@/store";

beforeEach(() => {
	useStore.setState({
		accounts: [
			{
				id: "codex-work",
				provider: "codex",
				name: "work",
				dir: "/tmp/unsafe-codex-alias",
			},
			{
				id: "claude-work",
				provider: "claude",
				name: "work",
				dir: "/tmp/claude-work",
			},
			{
				id: "kimi-work",
				provider: "kimi",
				name: "work",
				dir: "/tmp/kimi-work",
			},
		],
		activeAccounts: {
			codex: "codex-work",
			claude: "claude-work",
			kimi: "kimi-work",
		},
	});
});

describe("provider configuration roots", () => {
	it("keeps Codex on one runtime-user canonical state/session root", async () => {
		expect(await configDir("codex", "/Users/runtime")).toBe(
			"/Users/runtime/.codex",
		);
		expect(envPrefix("codex", "/tmp/unsafe-codex-alias")).toBe("");
	});

	it("edits shared Claude state canonically while Kimi keeps its account root", async () => {
		expect(await configDir("claude", "/Users/runtime")).toBe(
			"/Users/runtime/.claude",
		);
		expect(envPrefix("claude", "/Users/runtime/.claude")).toBe("");
		expect(await configDir("kimi", "/Users/runtime")).toBe("/tmp/kimi-work");
		expect(envPrefix("claude", "/tmp/claude-work")).toBe(
			"CLAUDE_CONFIG_DIR='/tmp/claude-work' ",
		);
		expect(envPrefix("kimi", "/tmp/kimi-work")).toBe(
			"KIMI_CODE_HOME='/tmp/kimi-work' ",
		);
	});
});
