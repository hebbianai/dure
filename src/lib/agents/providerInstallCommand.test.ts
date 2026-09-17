import { describe, expect, it } from "vitest";
import {
	INSTALLABLE_PROVIDER_IDS,
	providerInstallCommand,
	providerInstallExecutionCommand,
	providerInstallGuidanceForRun,
} from "@/lib/agents/providerInstallCommand";

describe("providerInstallGuidanceForRun", () => {
	const prepared = { provider: "claude", source: "local" } as const;
	const missing = {
		code: "agent_spawn_provider_unavailable",
		details: { reasonCode: "provider_executable_not_found" },
	};

	it("reuses the catalog for the failed Run's provider without launching or probing", () => {
		expect(providerInstallGuidanceForRun(missing, prepared, "macos")).toEqual({
			provider: "claude",
			command: providerInstallCommand("claude", "macos"),
		});
	});

	it.each([
		"provider_executable_lookup_failed",
		"provider_executable_not_executable",
		"provider_executable_path_missing",
		"credential_unavailable",
		"future_reason",
	])("does not turn %s into installation advice", (reasonCode) => {
		expect(
			providerInstallGuidanceForRun(
				{ ...missing, details: { reasonCode } },
				prepared,
				"macos",
			),
		).toBeUndefined();
	});

	it("does not infer a local installer from missing context, a remote host, or an unsupported target", () => {
		expect(
			providerInstallGuidanceForRun(missing, undefined, "macos"),
		).toBeUndefined();
		expect(
			providerInstallGuidanceForRun(missing, prepared, "unknown"),
		).toBeUndefined();
		expect(
			providerInstallGuidanceForRun(
				{ ...missing, code: "authentication_failed" },
				prepared,
				"macos",
			),
		).toBeUndefined();
		expect(
			providerInstallGuidanceForRun(
				"provider_executable_not_found",
				prepared,
				"macos",
			),
		).toBeUndefined();
		expect(
			providerInstallGuidanceForRun(
				missing,
				{
					...prepared,
					source: "ssh",
				},
				"macos",
			),
		).toBeUndefined();
		expect(
			providerInstallGuidanceForRun(
				missing,
				{
					...prepared,
					provider: "opencode",
				},
				"macos",
			),
		).toBeUndefined();
	});
});

describe("providerInstallCommand", () => {
	it.each(["macos", "linux"] as const)(
		"uses the official Claude native installer on %s",
		(platform) => {
			expect(providerInstallCommand("claude", platform)).toBe(
				"curl -fsSL https://claude.ai/install.sh | bash",
			);
		},
	);

	it("uses Claude's native PowerShell installer on Windows", () => {
		expect(providerInstallCommand("claude", "windows")).toBe(
			'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"',
		);
	});

	it("uses the Codex standalone installer on macOS and Linux", () => {
		expect(providerInstallCommand("codex", "macos")).toBe(
			"curl -fsSL https://chatgpt.com/codex/install.sh | sh",
		);
		expect(providerInstallCommand("codex", "linux")).toBe(
			"curl -fsSL https://chatgpt.com/codex/install.sh | sh",
		);
	});

	it("uses the Codex standalone installer for Windows", () => {
		expect(providerInstallCommand("codex", "windows")).toBe(
			'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
		);
	});

	it("does not guess an installer for an unknown desktop", () => {
		expect(providerInstallCommand("codex", "unknown")).toBeUndefined();
		expect(providerInstallCommand("claude", "unknown")).toBeUndefined();
	});

	it("offers every provider in the verified onboarding catalog", () => {
		expect(INSTALLABLE_PROVIDER_IDS).toEqual([
			"claude",
			"codex",
			"kimi",
			"gemini",
			"pi",
			"hermes",
			"qwen-code",
		]);
		for (const provider of INSTALLABLE_PROVIDER_IDS) {
			expect(providerInstallCommand(provider, "windows")).toBeDefined();
			expect(providerInstallCommand(provider, "macos")).toBeDefined();
			expect(providerInstallCommand(provider, "linux")).toBeDefined();
		}
	});

	it("uses the first-party Pi and Hermes installers", () => {
		expect(providerInstallCommand("pi", "windows")).toBe(
			"npm install -g @earendil-works/pi-coding-agent",
		);
		expect(providerInstallCommand("hermes", "windows")).toContain(
			"https://hermes-agent.nousresearch.com/install.ps1",
		);
		expect(providerInstallCommand("hermes", "linux")).toBe(
			"curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
		);
	});

	it("keeps the displayed command unchanged and preserves the Windows exit receipt", () => {
		const command = providerInstallCommand("pi", "windows");
		expect(command).toBe("npm install -g @earendil-works/pi-coding-agent");
		expect(providerInstallExecutionCommand("pi", command ?? "", "windows")).toContain(
			'npm install -g @earendil-works/pi-coding-agent ^& set "_dure_exit=!errorlevel!" ^& ^>nul ping.exe -n 3 127.0.0.1 ^& exit /B !_dure_exit!',
		);
	});

	it("preserves an uncataloged command and its status across the POSIX attach grace period", () => {
		expect(
			providerInstallExecutionCommand(
				"opencode",
				"curl -fsSL 'https://example.test/install.sh' | sh",
				"linux",
			),
		).toBe(
			`sh -c 'curl -fsSL '"'"'https://example.test/install.sh'"'"' | sh; _dure_exit=$?; sleep 2; exit "$_dure_exit"'`,
		);
	});

	it("does not guess a wrapper for an unknown desktop", () => {
		expect(providerInstallExecutionCommand("claude", "install-agent", "unknown")).toBe(
			"install-agent",
		);
	});

	it("uses a multiline-safe Kimi installer on Windows", () => {
		const command = providerInstallCommand("kimi", "windows") ?? "";
		expect(providerInstallExecutionCommand("kimi", command, "windows")).toContain(
			'$script = irm \'https://code.kimi.com/kimi-code/install.ps1\'',
		);
	});

	it("uses a junction-safe noninteractive Hermes installer on Windows", () => {
		const command = providerInstallCommand("hermes", "windows") ?? "";
		const execution = providerInstallExecutionCommand(
			"hermes",
			command,
			"windows",
		);
		expect(execution).toContain("$PythonVersion = ");
		expect(execution).toContain("3.11.16");
		expect(execution).toContain(
			"-SkipSetup -SkipComputerUse -NonInteractive",
		);
		expect(execution.match(/& \$installer/g)).toHaveLength(2);
	});

	it.each([
		["claude", '"%USERPROFILE%\\.local\\bin\\claude.exe" --version'],
		[
			"codex",
			'where.exe /Q "%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin:codex.exe"',
		],
		["kimi", 'where.exe /Q "%USERPROFILE%\\.kimi-code\\bin:kimi.exe"'],
		["gemini", "where.exe /Q gemini"],
		[
			"hermes",
			'"%LOCALAPPDATA%\\hermes\\bin\\hermes.exe" --version ^>nul',
		],
	] as const)("verifies %s before treating its Windows install as successful", (provider, verification) => {
		const command = providerInstallCommand(provider, "windows") ?? "";
		expect(providerInstallExecutionCommand(provider, command, "windows")).toContain(
			`^&^& ${verification}`,
		);
	});
});
