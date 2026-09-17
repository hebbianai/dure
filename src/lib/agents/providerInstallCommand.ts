/** Verified provider installers for onboarding; unknown targets stay unset. */

import { t } from "@/lib/i18n";
import { asRecord } from "@/lib/payloadGuards";
import {
	type DesktopPlatform,
	detectDesktopPlatform,
} from "@/lib/workspace/desktop/desktopPlatform";
import type { Provider } from "@/types";

export interface ProviderInstallCommand {
	provider: Provider;
	command: string;
}

/** Project a confirmed failure using the original Run's provider and host.
 * Reading the guide neither probes nor executes an installer. */
export function providerInstallGuidanceForRun(
	cause: unknown,
	context: { provider: Provider; source: "local" | "ssh" } | undefined,
	platform: DesktopPlatform = detectDesktopPlatform(),
): ProviderInstallCommand | undefined {
	const failure = asRecord(cause);
	if (
		context?.source !== "local" ||
		platform === "unknown" ||
		failure?.code !== "agent_spawn_provider_unavailable" ||
		asRecord(failure.details)?.reasonCode !== "provider_executable_not_found"
	)
		return undefined;
	const provider = context.provider;
	const command = providerInstallCommand(provider, platform);
	return command ? { provider, command } : undefined;
}

type ProviderInstallCommands = (
	| {
			readonly npmPackage: string;
			readonly platforms?: never;
			readonly posixScript?: never;
		}
	| {
			readonly npmPackage?: never;
			readonly platforms: Partial<Record<DesktopPlatform, string>>;
			readonly posixScript?: {
				readonly url: string;
				readonly shell: "sh" | "bash";
			};
		}
) & {
	readonly executionPlatforms?: Partial<Record<DesktopPlatform, string>>;
	readonly verificationPlatforms?: Partial<Record<DesktopPlatform, string>>;
};

export const NODE_NPM_INSTALL_GUIDE =
	"https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/";

/** Providers with a verified first-party install path. Onboarding derives its
 * rows from this catalog instead of maintaining a Claude/Codex special case. */
export const INSTALLABLE_PROVIDER_IDS = [
	"claude",
	"codex",
	"kimi",
	"gemini",
	"pi",
	"hermes",
	"qwen-code",
] as const satisfies readonly Provider[];

/** Some Windows execution policies allow an exact uv-managed Python binary but
 * reject uv's minor-version directory junction. Pin the current Hermes Python
 * patch release and retry once because the first pass may replace an incomplete
 * checkout after provisioning Python beneath it. Optional setup stays outside
 * the download action so its terminal can close deterministically. */
const HERMES_WINDOWS_INSTALL_EXECUTION =
	`powershell -NoProfile -ExecutionPolicy Bypass -Command "$source = irm 'https://hermes-agent.nousresearch.com/install.ps1'; $needle = '$PythonVersion = ' + [char]34 + '3.11' + [char]34; $replacement = '$PythonVersion = ' + [char]34 + '3.11.16' + [char]34; $patched = $source.Replace($needle, $replacement); if ($patched -eq $source) { throw 'Hermes installer Python compatibility point changed' }; $installer = [scriptblock]::Create($patched); & $installer -SkipSetup -SkipComputerUse -NonInteractive; $launcher = Join-Path $env:LOCALAPPDATA 'hermes\\bin\\hermes.exe'; if (-not (Test-Path -LiteralPath $launcher)) { & $installer -SkipSetup -SkipComputerUse -NonInteractive }"`;

/** Matches the first-party installer's public launcher layout (#744). Code and
 * data directories do not identify the public command. Keep lookup failures in
 * a subshell so the shared wrapper still preserves its exit/attachment receipt.
 */
const HERMES_POSIX_INSTALL_VERIFICATION = [
	"(",
	'_dure_hermes_bin="$HOME/.local/bin";',
	`case "\${TERMUX_VERSION:+termux}:\${PREFIX:-}" in`,
	`termux:*|*com.termux/files/usr*) _dure_hermes_bin="\${PREFIX:-$HOME/.local}/bin" ;;`,
	`*) if [ -z "\${HERMES_INSTALL_DIR:-}" ] && [ ! -d "\${HERMES_HOME:-$HOME/.hermes}/hermes-agent/.git" ]; then`,
	'_dure_hermes_os=$(uname -s) || exit "$?";',
	'if [ "$_dure_hermes_os" = Linux ]; then',
	'_dure_hermes_uid=$(id -u) || exit "$?";',
	'if [ "$_dure_hermes_uid" = 0 ]; then _dure_hermes_bin=/usr/local/bin; fi;',
	"fi; fi ;;",
	"esac;",
	'"$_dure_hermes_bin/hermes" --version',
	")",
].join(" ");

const COMMANDS: Partial<Record<Provider, ProviderInstallCommands>> = {
	claude: {
		posixScript: { url: "https://claude.ai/install.sh", shell: "bash" },
		platforms: {
			windows:
				'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"',
		},
		executionPlatforms: {
			windows:
				`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; iex (irm 'https://claude.ai/install.ps1')"`,
		},
		verificationPlatforms: {
			macos: '"$HOME/.local/bin/claude" --version',
			linux: '"$HOME/.local/bin/claude" --version',
			windows: '"%USERPROFILE%\\.local\\bin\\claude.exe" --version',
		},
	},
	codex: {
		posixScript: { url: "https://chatgpt.com/codex/install.sh", shell: "sh" },
		platforms: {
			windows:
				'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
		},
		verificationPlatforms: {
			windows:
				'where.exe /Q "%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin:codex.exe"',
		},
	},
	kimi: {
		posixScript: {
			url: "https://code.kimi.com/kimi-code/install.sh",
			shell: "bash",
		},
		platforms: {
			windows:
				'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm \'https://code.kimi.com/kimi-code/install.ps1\' | iex"',
		},
		executionPlatforms: {
			windows:
				'powershell -NoProfile -ExecutionPolicy Bypass -Command "$script = irm \'https://code.kimi.com/kimi-code/install.ps1\'; iex $script"',
		},
		verificationPlatforms: {
			macos: `"\${KIMI_INSTALL_DIR:-$HOME/.kimi-code}/bin/kimi" --version`,
			linux: `"\${KIMI_INSTALL_DIR:-$HOME/.kimi-code}/bin/kimi" --version`,
			windows:
				'where.exe /Q "%USERPROFILE%\\.kimi-code\\bin:kimi.exe"',
		},
	},
	gemini: {
		npmPackage: "@google/gemini-cli",
		verificationPlatforms: { windows: "where.exe /Q gemini" },
	},
	pi: { npmPackage: "@earendil-works/pi-coding-agent" },
	hermes: {
		posixScript: {
			url: "https://hermes-agent.nousresearch.com/install.sh",
			shell: "bash",
		},
		platforms: {
			windows:
				'powershell -NoProfile -ExecutionPolicy Bypass -Command "iex (irm \'https://hermes-agent.nousresearch.com/install.ps1\')"',
		},
		executionPlatforms: {
			windows: HERMES_WINDOWS_INSTALL_EXECUTION,
		},
		verificationPlatforms: {
			macos: HERMES_POSIX_INSTALL_VERIFICATION,
			linux: HERMES_POSIX_INSTALL_VERIFICATION,
			windows:
				'"%LOCALAPPDATA%\\hermes\\bin\\hermes.exe" --version ^>nul',
		},
	},
	"qwen-code": { npmPackage: "@qwen-code/qwen-code@latest" },
};

export function providerInstallUsesNpm(provider: Provider): boolean {
	return COMMANDS[provider]?.npmPackage !== undefined;
}

export function providerInstallCommand(
	provider: Provider,
	platform: DesktopPlatform = detectDesktopPlatform(),
): string | undefined {
	const commands = COMMANDS[provider];
	if (commands?.posixScript && (platform === "macos" || platform === "linux")) {
		const { url, shell } = commands.posixScript;
		return `curl -fsSL ${url} | ${shell}`;
	}
	return commands?.npmPackage
		? `npm install -g ${commands.npmPackage}`
		: commands?.platforms?.[platform];
}

const INSTALLER_EXIT_RECEIPT_GRACE_SECONDS = 2;

function shellSingleQuote(value: string): string {
	return `'${value.split("'").join(`'"'"'`)}'`;
}

/** Keep a fast installer alive just long enough for its newly-added terminal
 * pane to attach. The official command shown/copied by onboarding stays
 * untouched; only execution receives this wrapper. The wrapper preserves the
 * installer or configured post-install verification status for closeOnSuccess.
 * Prerequisites are checked in this same shell, so a separate environment probe
 * cannot veto an installer.
 */
export function providerInstallExecutionCommand(
	provider: Provider,
	command: string,
	platform: DesktopPlatform = detectDesktopPlatform(),
): string {
	const providerCommands = COMMANDS[provider];
	const executionCommand =
		providerCommands?.executionPlatforms?.[platform] ?? command;
	const verificationCommand =
		providerCommands?.verificationPlatforms?.[platform];
	const usesNpm = providerInstallUsesNpm(provider);
	const missingMessage = usesNpm
		? t("onboarding.install.npmUnavailable", { url: NODE_NPM_INSTALL_GUIDE })
		: "";
	if (platform === "windows") {
		// Encode copy as data: cmd metacharacters and localized text must not
		// become commands. PowerShell runs only when a prerequisite is missing.
		const encodedMessage = btoa(
			String.fromCharCode(...new TextEncoder().encode(missingMessage)),
		);
		return [
			"cmd.exe /D /Q /V:ON /C",
			usesNpm
				? `where.exe /Q node ^&^& where.exe /Q npm ^|^| powershell.exe -NoProfile -Command "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); [Console]::Error.WriteLine([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedMessage}'))); exit 127" ^&^&`
				: undefined,
			executionCommand,
			verificationCommand ? `^&^& ${verificationCommand}` : undefined,
			'^& set "_dure_exit=!errorlevel!"',
			`^& ^>nul ping.exe -n ${INSTALLER_EXIT_RECEIPT_GRACE_SECONDS + 1} 127.0.0.1`,
			"^& exit /B !_dure_exit!",
		]
			.filter((part): part is string => part !== undefined)
			.join(" ");
	}
	if (platform === "macos" || platform === "linux") {
		const script = providerCommands?.posixScript;
		// Receive the complete script before starting its interpreter. A failed
		// curl must not execute a partial installer or become an empty success.
		const installCommand = script
			? `_dure_script=$(curl -fsSL ${shellSingleQuote(script.url)}) && printf '%s\\n' "$_dure_script" | ${script.shell}`
			: executionCommand;
		const verifiedCommand = verificationCommand
			? `${installCommand} && ${verificationCommand}`
			: installCommand;
		const installation = usesNpm
			? `if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then ${verifiedCommand}; _dure_exit=$?; else printf '%s\\n' ${shellSingleQuote(missingMessage)} >&2; _dure_exit=127; fi`
			: `${verifiedCommand}; _dure_exit=$?`;
		return `sh -c ${shellSingleQuote(`${installation}; sleep ${INSTALLER_EXIT_RECEIPT_GRACE_SECONDS}; exit "$_dure_exit"`)}`;
	}
	return command;
}
