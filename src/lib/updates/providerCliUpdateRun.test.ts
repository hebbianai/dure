import { describe, expect, it, vi } from "vitest";
import type { ProviderPreflight } from "@/lib/ipc";
import { runProviderCliUpdate } from "@/lib/updates/providerCliUpdateRun";
import type { ProviderCliUpdate } from "@/lib/updates/providerCliUpdateSource";

function preflight(version: string, resolvedPath: string): ProviderPreflight {
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
		version,
		resolvedPath,
	};
}

const CASK_PATH = "/opt/homebrew/Caskroom/claude-code@latest/2.1.252/claude";
const COMMAND = "brew upgrade --cask claude-code@latest";

function update(command: string | null): ProviderCliUpdate {
	return {
		provider: "claude",
		installedVersion: "2.1.252",
		latestVersion: "2.1.258",
		plan: command
			? { provider: "claude", channel: "brew-cask", command }
			: null,
		resolvedPath: CASK_PATH,
		docsUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
	};
}

describe("runProviderCliUpdate", () => {
	it("verifies an advanced CLI version even when Homebrew fails afterwards", async () => {
		const versions = ["2.1.252 (Claude Code)", "2.1.258 (Claude Code)"];
		const result = await runProviderCliUpdate("claude", COMMAND, {
			preflight: async () => preflight(versions.shift() ?? "", CASK_PATH),
			evaluate: async () => update(COMMAND),
			runCommand: async () => ({
				stdout: "CLI installed",
				stderr:
					"Error: Your Command Line Tools are too outdated.\nUpdate them from Software Update.",
				code: 1,
			}),
		});
		expect(result).toMatchObject({
			kind: "updated_with_warning",
			fromVersion: "2.1.252",
			toVersion: "2.1.258",
			guidance: "command_line_tools",
		});
	});

	it("classifies the full diagnostic before truncating it", async () => {
		const result = await runProviderCliUpdate("claude", COMMAND, {
			preflight: async () => preflight("2.1.252 (Claude Code)", CASK_PATH),
			evaluate: async () => update(COMMAND),
			runCommand: async () => ({
				stdout: "",
				stderr: `Error: Your Command Line Tools are too outdated.\n${"more diagnostics\n".repeat(300)}`,
				code: 1,
			}),
		});
		expect(result).toMatchObject({
			kind: "command_failed",
			guidance: "command_line_tools",
		});
	});

	it("retains the original failure when the follow-up version probe fails", async () => {
		let count = 0;
		const result = await runProviderCliUpdate("claude", COMMAND, {
			preflight: async () => {
				if (count++ > 0) throw new Error("probe unavailable");
				return preflight("2.1.252", CASK_PATH);
			},
			evaluate: async () => update(COMMAND),
			runCommand: async () => ({
				stdout: "",
				stderr: "package download failed",
				code: 1,
			}),
		});
		expect(result).toMatchObject({
			kind: "command_failed",
			detail: "package download failed",
			exitCode: 1,
		});
	});

	it("reports command transport failures without an unhandled rejection", async () => {
		const result = await runProviderCliUpdate("claude", COMMAND, {
			preflight: async () => preflight("2.1.252", CASK_PATH),
			evaluate: async () => update(COMMAND),
			runCommand: async () => {
				throw new Error("connection lost");
			},
		});
		expect(result).toMatchObject({
			kind: "command_failed",
			detail: "connection lost",
			exitCode: null,
		});
	});
	it("refuses to run when the fresh plan differs from the displayed one", async () => {
		const fresh = update("npm install -g @anthropic-ai/claude-code@latest");
		const runCommand = vi.fn();
		const result = await runProviderCliUpdate("claude", COMMAND, {
			preflight: async () => preflight("2.1.252 (Claude Code)", CASK_PATH),
			evaluate: async () => fresh,
			runCommand,
		});
		expect(result).toEqual({ kind: "plan_changed", fresh });
		expect(runCommand).not.toHaveBeenCalled();
	});

	it("reports command failure with the stderr tail", async () => {
		const result = await runProviderCliUpdate("claude", COMMAND, {
			preflight: async () => preflight("2.1.252 (Claude Code)", CASK_PATH),
			evaluate: async () => update(COMMAND),
			runCommand: async () => ({
				stdout: "",
				stderr: "Error: no cask\n",
				code: 1,
			}),
		});
		expect(result).toEqual({
			kind: "command_failed",
			exitCode: 1,
			detail: "Error: no cask",
		});
	});

	it("reports updated when the re-probed version advanced", async () => {
		const versions = ["2.1.252 (Claude Code)", "2.1.258 (Claude Code)"];
		const result = await runProviderCliUpdate("claude", COMMAND, {
			preflight: async () => preflight(versions.shift() ?? "", CASK_PATH),
			evaluate: async () => update(COMMAND),
			runCommand: async () => ({ stdout: "ok", stderr: "", code: 0 }),
		});
		expect(result).toEqual({
			kind: "updated",
			fromVersion: "2.1.252",
			toVersion: "2.1.258",
		});
	});

	it("reports unchanged with the resolved path when the version did not move", async () => {
		const result = await runProviderCliUpdate("claude", COMMAND, {
			preflight: async () => preflight("2.1.252 (Claude Code)", CASK_PATH),
			evaluate: async () => update(COMMAND),
			runCommand: async () => ({ stdout: "ok", stderr: "", code: 0 }),
		});
		expect(result).toEqual({
			kind: "unchanged",
			version: "2.1.252",
			resolvedPath: CASK_PATH,
		});
	});
});
