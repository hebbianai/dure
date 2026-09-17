import { describe, expect, it } from "vitest";
import {
	buildProviderCliUpdatePlan,
	providerCliInstallPath,
} from "@/lib/agents/providerCliChannels";
import type { ProviderPreflight } from "@/lib/ipc";

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
		...overrides,
	};
}

describe("providerCliInstallPath", () => {
	it("prefers resolvedPath, then the symlink chain tail, then commandPath", () => {
		expect(
			providerCliInstallPath(
				preflight({
					resolvedPath: "/a",
					symlinkChain: ["/b"],
					commandPath: "/c",
				}),
			),
		).toBe("/a");
		expect(
			providerCliInstallPath(
				preflight({ symlinkChain: ["/x", "/b"], commandPath: "/c" }),
			),
		).toBe("/b");
		expect(providerCliInstallPath(preflight({ commandPath: "/c" }))).toBe("/c");
		expect(providerCliInstallPath(preflight({}))).toBeNull();
	});
});

describe("buildProviderCliUpdatePlan", () => {
	it("detects a brew cask install and targets its on-disk token", () => {
		const plan = buildProviderCliUpdatePlan({
			provider: "claude",
			preflight: preflight({
				resolvedPath:
					"/opt/homebrew/Caskroom/claude-code@latest/2.1.252/claude",
			}),
			npmGlobalPrefix: null,
			platform: "macos",
		});
		expect(plan).toEqual({
			provider: "claude",
			channel: "brew-cask",
			command: "brew upgrade --cask claude-code@latest",
		});
	});

	it("accepts the Intel brew prefix and the plain cask token", () => {
		const plan = buildProviderCliUpdatePlan({
			provider: "claude",
			preflight: preflight({
				resolvedPath: "/usr/local/Caskroom/claude-code/2.1.252/claude",
			}),
			npmGlobalPrefix: null,
			platform: "macos",
		});
		expect(plan?.command).toBe("brew upgrade --cask claude-code");
	});

	it("rejects a cask token outside the provider allowlist", () => {
		const plan = buildProviderCliUpdatePlan({
			provider: "claude",
			preflight: preflight({
				resolvedPath: "/opt/homebrew/Caskroom/evil-claude/1.0/claude",
			}),
			npmGlobalPrefix: null,
			platform: "macos",
		});
		expect(plan).toBeNull();
	});

	it("detects the codex standalone channel and invokes the exact executable", () => {
		const plan = buildProviderCliUpdatePlan({
			provider: "codex",
			preflight: preflight({
				provider: "codex",
				command: "codex",
				resolvedPath:
					"/Users/jwan/.codex/packages/standalone/current/bin/codex",
			}),
			npmGlobalPrefix: null,
			platform: "macos",
		});
		expect(plan).toEqual({
			provider: "codex",
			channel: "codex-standalone",
			command:
				"'/Users/jwan/.codex/packages/standalone/current/bin/codex' update",
		});
	});

	it("does not apply another provider's standalone channel", () => {
		const plan = buildProviderCliUpdatePlan({
			provider: "claude",
			preflight: preflight({
				resolvedPath:
					"/Users/jwan/.codex/packages/standalone/current/bin/codex",
			}),
			npmGlobalPrefix: null,
			platform: "macos",
		});
		expect(plan).toBeNull();
	});

	it("detects an npm global install only under the current npm prefix", () => {
		const plan = buildProviderCliUpdatePlan({
			provider: "claude",
			preflight: preflight({
				resolvedPath:
					"/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
			}),
			npmGlobalPrefix: "/opt/homebrew",
			platform: "macos",
		});
		expect(plan).toEqual({
			provider: "claude",
			channel: "npm-global",
			command: "npm install -g @anthropic-ai/claude-code@latest",
		});
	});

	it("refuses node_modules under a foreign prefix (stale nvm version)", () => {
		const plan = buildProviderCliUpdatePlan({
			provider: "claude",
			preflight: preflight({
				resolvedPath:
					"/Users/jwan/.nvm/versions/node/v20.11.0/lib/node_modules/@anthropic-ai/claude-code/cli.js",
			}),
			npmGlobalPrefix: "/Users/jwan/.nvm/versions/node/v22.6.0",
			platform: "macos",
		});
		expect(plan).toBeNull();
	});

	it("leaves native Claude updates to the provider even when npm is installed", () => {
		const plan = buildProviderCliUpdatePlan({
			provider: "claude",
			preflight: preflight({
				commandPath: "/Users/me/.local/bin/claude",
				resolvedPath: "/Users/me/.local/share/claude/versions/2.1.252",
			}),
			npmGlobalPrefix: "/Users/me/.local",
			platform: "macos",
		});
		expect(plan).toBeNull();
	});

	it("refuses node_modules when the npm prefix probe failed", () => {
		const plan = buildProviderCliUpdatePlan({
			provider: "claude",
			preflight: preflight({
				resolvedPath:
					"/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
			}),
			npmGlobalPrefix: null,
			platform: "macos",
		});
		expect(plan).toBeNull();
	});

	it("stays unknown for unrecognized layouts, providers, and platforms", () => {
		const volta = buildProviderCliUpdatePlan({
			provider: "claude",
			preflight: preflight({
				resolvedPath:
					"/Users/jwan/.volta/tools/image/packages/@anthropic-ai/claude-code/bin/claude",
			}),
			npmGlobalPrefix: "/opt/homebrew",
			platform: "macos",
		});
		expect(volta).toBeNull();
		const unseeded = buildProviderCliUpdatePlan({
			provider: "gemini",
			preflight: preflight({
				resolvedPath: "/opt/homebrew/Caskroom/gemini/1/g",
			}),
			npmGlobalPrefix: null,
			platform: "macos",
		});
		expect(unseeded).toBeNull();
		const windows = buildProviderCliUpdatePlan({
			provider: "claude",
			preflight: preflight({
				resolvedPath:
					"/opt/homebrew/Caskroom/claude-code@latest/2.1.252/claude",
			}),
			npmGlobalPrefix: null,
			platform: "windows",
		});
		expect(windows).toBeNull();
	});
});
