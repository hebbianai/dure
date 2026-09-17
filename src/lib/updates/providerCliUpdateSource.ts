/** Update detection for seeded provider CLIs: the npm registry answers
 * "what is latest" (channel-independent), channel detection answers "how to
 * update this install". */

import {
	buildProviderCliUpdatePlan,
	PROVIDER_CLI_UPDATE_TARGETS,
	type ProviderCliUpdatePlan,
	providerCliInstallPath,
} from "@/lib/agents/providerCliChannels";
import {
	compareCliVersions,
	extractCliVersion,
} from "@/lib/agents/providerCliVersion";
import { runShell } from "@/lib/ipc/process";
import { providerExecutable } from "@/lib/agents/providerPreflight";
import { t } from "@/lib/i18n";
import { type ProviderPreflight, providerPreflight } from "@/lib/ipc";
import {
	clearMaintenanceLaneInterval,
	setMaintenanceLaneInterval,
} from "@/lib/scheduling/maintenanceLaneInterval";
import { openSettingsPage } from "@/lib/settings/settingsBus";
import {
	clearUpdateNotice,
	upsertUpdateNotice,
} from "@/lib/updates/updateNotice";
import type { DesktopPlatform } from "@/lib/workspace/desktop/desktopPlatform";
import { PROVIDERS, type Provider } from "@/types";

export interface ProviderCliUpdate {
	readonly provider: Provider;
	/** Clean matched versions (e.g. "2.1.252"). */
	readonly installedVersion: string;
	readonly latestVersion: string;
	/** Null means the install channel is unknown — inform, never execute. */
	readonly plan: ProviderCliUpdatePlan | null;
	readonly resolvedPath: string | null;
	readonly docsUrl: string;
}

export interface ProviderCliUpdateDeps {
	fetcher?: typeof fetch;
	runCommand?: typeof runShell;
	now?: () => number;
	platform?: DesktopPlatform;
}

interface ProviderCliProbeDeps extends ProviderCliUpdateDeps {
	preflight?: (provider: Provider) => Promise<ProviderPreflight>;
}

const CACHE_TTL_MS = 55 * 60 * 1000;
const latestVersionCache = new Map<
	string,
	{ value: string | null; at: number }
>();
let npmPrefixCache: { value: string | null; at: number } | null = null;

export function resetProviderCliUpdateCaches(): void {
	latestVersionCache.clear();
	npmPrefixCache = null;
}

export async function fetchLatestCliVersion(
	npmPackage: string,
	deps: ProviderCliUpdateDeps = {},
): Promise<string | null> {
	const now = deps.now ?? Date.now;
	const cached = latestVersionCache.get(npmPackage);
	if (cached && now() - cached.at < CACHE_TTL_MS) return cached.value;
	try {
		const fetcher = deps.fetcher ?? fetch;
		const response = await fetcher(
			`https://registry.npmjs.org/${npmPackage}/latest`,
		);
		if (response.ok) {
			const body: unknown = await response.json();
			const version = (body as { version?: unknown }).version;
			if (typeof version === "string") {
				latestVersionCache.set(npmPackage, { value: version, at: now() });
				return version;
			}
		}
	} catch {
		// fall through to the stale value
	}
	// Failure/unparseable: do not refresh the TTL — negative-caching a
	// transient failure for the full 55 minutes would take the feature dark
	// for an offline launch with no recovery. Serve the stale value (or null
	// if there never was one) and let the next call retry immediately.
	return cached?.value ?? null;
}

async function npmGlobalPrefix(
	deps: ProviderCliUpdateDeps,
): Promise<string | null> {
	const now = deps.now ?? Date.now;
	if (npmPrefixCache && now() - npmPrefixCache.at < CACHE_TTL_MS) {
		return npmPrefixCache.value;
	}
	try {
		const result = await (deps.runCommand ?? runShell)("npm prefix -g");
		if (result.code === 0) {
			const value = result.stdout.trim() || null;
			npmPrefixCache = { value, at: now() };
			return value;
		}
	} catch {
		// fall through to the stale value
	}
	// Non-zero exit or a thrown command: do not refresh the TTL — same
	// stale-on-error/no-negative-cache principle as fetchLatestCliVersion.
	return npmPrefixCache?.value ?? null;
}

/** Null when the provider is unseeded, a version is unknown, or already latest. */
export async function evaluateProviderCliUpdate(
	provider: Provider,
	preflight: ProviderPreflight,
	deps: ProviderCliUpdateDeps = {},
): Promise<ProviderCliUpdate | null> {
	const target = PROVIDER_CLI_UPDATE_TARGETS[provider];
	if (!target) return null;
	const installed = extractCliVersion(preflight.version);
	if (!installed) return null;
	const latest = extractCliVersion(
		await fetchLatestCliVersion(target.npmPackage, deps),
	);
	if (!latest) return null;
	if (compareCliVersions(installed, latest) >= 0) return null;
	const plan = buildProviderCliUpdatePlan({
		provider,
		preflight,
		npmGlobalPrefix: await npmGlobalPrefix(deps),
		...(deps.platform ? { platform: deps.platform } : {}),
	});
	return {
		provider,
		installedVersion: installed.raw,
		latestVersion: latest.raw,
		plan,
		resolvedPath: providerCliInstallPath(preflight),
		docsUrl: target.docsUrl,
	};
}

const PROVIDER_CLI_UPDATE_SOURCE_REF = "dure.provider-cli";

export interface ProviderCliProbeResult {
	readonly updates: readonly ProviderCliUpdate[];
	/** Providers whose probe rejected — no answer, not "no update". */
	readonly indeterminate: readonly Provider[];
}

export async function probeProviderCliUpdates(
	deps: ProviderCliProbeDeps = {},
): Promise<ProviderCliProbeResult> {
	const preflight =
		deps.preflight ??
		((provider: Provider) =>
			providerPreflight({
				provider,
				command: providerExecutable(provider),
				cwd: "/",
			}));
	const updates: ProviderCliUpdate[] = [];
	const indeterminate: Provider[] = [];
	for (const provider of Object.keys(
		PROVIDER_CLI_UPDATE_TARGETS,
	) as Provider[]) {
		try {
			const update = await evaluateProviderCliUpdate(
				provider,
				await preflight(provider),
				deps,
			);
			if (update) updates.push(update);
		} catch {
			// A rejected probe is no answer, not "no update" — the caller must
			// not treat this provider as up to date.
			indeterminate.push(provider);
		}
	}
	return { updates, indeterminate };
}

export function projectProviderCliUpdateNotice(
	result: ProviderCliProbeResult,
): void {
	if (result.updates.length === 0 && result.indeterminate.length > 0) {
		// An incomplete snapshot with nothing to report never replaces the
		// projection — a transient probe failure leaves the last known notice
		// intact. A known update from another provider is still reported below,
		// even while this poll couldn't reach every provider.
		return;
	}
	if (result.updates.length === 0) {
		clearUpdateNotice(PROVIDER_CLI_UPDATE_SOURCE_REF);
		return;
	}
	upsertUpdateNotice({
		sourceRef: PROVIDER_CLI_UPDATE_SOURCE_REF,
		revision: JSON.stringify(
			result.updates.map((update) => [
				update.provider,
				update.installedVersion,
				update.latestVersion,
			]),
		),
		title: t("updates.providerCli.title"),
		description: result.updates
			.map(
				(update) =>
					`${PROVIDERS[update.provider].label} ${update.installedVersion} → ${update.latestVersion}`,
			)
			.join(" · "),
		impact: t("updates.providerCli.impact"),
		primaryAction: {
			label: t("common.openSettings"),
			progressLabel: t("updates.agentTooling.openingSettings"),
			completion: "retain",
			run: () => openSettingsPage("providers"),
		},
	});
}

let noticeProbeGeneration = 0;

async function reconcileProviderCliUpdateNotice(
	deps: ProviderCliProbeDeps,
	active: () => boolean,
): Promise<void> {
	const generation = ++noticeProbeGeneration;
	const result = await probeProviderCliUpdates(deps);
	if (active() && generation === noticeProbeGeneration) {
		projectProviderCliUpdateNotice(result);
	}
}

/** Re-observe every seeded provider and replace the notice from one complete
 * source-owned result. A later request fences an older in-flight poll so a
 * pre-install snapshot cannot restore a notice after an update completes. */
export function refreshProviderCliUpdateNotice(
	deps: ProviderCliProbeDeps = {},
): Promise<void> {
	return reconcileProviderCliUpdateNotice(deps, () => true);
}

export function startProviderCliUpdateChecks(): () => void {
	let disposed = false;
	let checking = false;
	const checkOnce = async () => {
		if (disposed || checking) return;
		checking = true;
		try {
			await reconcileProviderCliUpdateNotice({}, () => !disposed);
		} catch {
			// A transient poll failure leaves the last known notice intact.
		} finally {
			checking = false;
		}
	};
	// 15s initial (agent tooling uses 10s) so the two login-shell bursts
	// do not land at the same moment on startup.
	const initial = window.setTimeout(() => void checkOnce(), 15_000);
	const interval = setMaintenanceLaneInterval(
		() => void checkOnce(),
		60 * 60 * 1000,
		"provider-cli-update-check",
	);
	return () => {
		disposed = true;
		window.clearTimeout(initial);
		clearMaintenanceLaneInterval(interval);
	};
}
