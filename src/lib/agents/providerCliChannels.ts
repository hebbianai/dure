/** Install-channel detection for provider CLI updates. Evidence rule: every
 * pattern here was checked against a real install of that shape; anything
 * else stays unknown so a guessed command is never offered — the wrong
 * channel is what creates PATH double-installs. */

import type { ProviderPreflight } from "@/lib/ipc";
import {
	type DesktopPlatform,
	detectDesktopPlatform,
} from "@/lib/workspace/desktop/desktopPlatform";
import type { Provider } from "@/types";

type ProviderCliChannelKind = "brew-cask" | "codex-standalone" | "npm-global";

export interface ProviderCliUpdatePlan {
	readonly provider: Provider;
	readonly channel: ProviderCliChannelKind;
	/** Executed exactly as displayed; self-updaters bake the absolute path in. */
	readonly command: string;
}

export interface ProviderCliUpdateTarget {
	readonly npmPackage: string;
	readonly caskTokens: readonly string[];
	readonly docsUrl: string;
	readonly standalone?: {
		readonly channel: ProviderCliChannelKind;
		readonly homePattern: RegExp;
		readonly homeEnvironmentVariable: string;
	};
}

export const PROVIDER_CLI_UPDATE_TARGETS: Partial<
	Record<Provider, ProviderCliUpdateTarget>
> = {
	claude: {
		npmPackage: "@anthropic-ai/claude-code",
		caskTokens: ["claude-code", "claude-code@latest"],
		docsUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
	},
	codex: {
		npmPackage: "@openai/codex",
		caskTokens: ["codex"],
		docsUrl: "https://developers.openai.com/codex/cli/",
		standalone: {
			channel: "codex-standalone",
			homePattern:
				/^(\/.+)\/packages\/standalone\/(?:current|releases\/[^/]+)\/bin\/codex$/,
			homeEnvironmentVariable: "CODEX_HOME",
		},
	},
};

export function providerCliInstallPath(
	preflight: ProviderPreflight,
): string | null {
	return (
		preflight.resolvedPath ??
		preflight.symlinkChain[preflight.symlinkChain.length - 1] ??
		preflight.commandPath ??
		null
	);
}

function shellQuotePath(path: string): string {
	return `'${path.replace(/'/g, "'\\''")}'`;
}

const CASKROOM_TOKEN = /\/Caskroom\/([^/]+)\//;

export function buildProviderCliUpdatePlan(input: {
	provider: Provider;
	preflight: ProviderPreflight;
	/** Current login-shell `npm prefix -g`, or null when the probe failed. */
	npmGlobalPrefix: string | null;
	platform?: DesktopPlatform;
}): ProviderCliUpdatePlan | null {
	const target = PROVIDER_CLI_UPDATE_TARGETS[input.provider];
	if (!target) return null;
	const platform = input.platform ?? detectDesktopPlatform();
	if (platform !== "macos" && platform !== "linux") return null;
	const path = providerCliInstallPath(input.preflight);
	if (!path) return null;

	const cask = CASKROOM_TOKEN.exec(path);
	if (cask) {
		const token = cask[1];
		if (!token || !target.caskTokens.includes(token)) return null;
		return {
			provider: input.provider,
			channel: "brew-cask",
			command: `brew upgrade --cask ${token}`,
		};
	}
	const standalone = target.standalone;
	const installHome = standalone?.homePattern.exec(path)?.[1];
	if (standalone && installHome) {
		// Standalone installers locate their release through their home variable.
		// A desktop launched from an agent can inherit an account-specific home;
		// scope this override to the updater, never the account/session environment.
		return {
			provider: input.provider,
			channel: standalone.channel,
			command: `env ${standalone.homeEnvironmentVariable}=${shellQuotePath(installHome)} ${shellQuotePath(path)} update`,
		};
	}
	if (path.includes("/node_modules/")) {
		const prefix = input.npmGlobalPrefix?.replace(/\/+$/, "");
		if (!prefix || !path.startsWith(`${prefix}/`)) return null;
		return {
			provider: input.provider,
			channel: "npm-global",
			command: `npm install -g ${target.npmPackage}@latest`,
		};
	}
	return null;
}
