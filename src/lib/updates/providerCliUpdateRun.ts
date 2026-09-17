/** The Update click transaction. The rendered plan is never executed
 * directly: re-detect, compare against what the user saw, then run — closes
 * the render-to-click TOCTOU gap. */

import { providerCliInstallPath } from "@/lib/agents/providerCliChannels";
import {
	compareCliVersions,
	extractCliVersion,
} from "@/lib/agents/providerCliVersion";
import type { ProviderPreflight } from "@/lib/ipc";
import type { ExecResult } from "@/lib/ipc/hmuxContracts";
import type { ProviderCliUpdate } from "@/lib/updates/providerCliUpdateSource";
import type { Provider } from "@/types";

export type ProviderCliUpdateRunResult =
	| { kind: "plan_changed"; fresh: ProviderCliUpdate | null }
	| { kind: "command_failed"; exitCode: number; detail: string }
	| { kind: "updated"; fromVersion: string; toVersion: string }
	| { kind: "unchanged"; version: string; resolvedPath: string | null };

export interface ProviderCliUpdateRunDeps {
	preflight: (provider: Provider) => Promise<ProviderPreflight>;
	evaluate: (
		provider: Provider,
		preflight: ProviderPreflight,
	) => Promise<ProviderCliUpdate | null>;
	runCommand: (cmd: string) => Promise<ExecResult>;
}

const DETAIL_TAIL_CHARS = 400;

export async function runProviderCliUpdate(
	provider: Provider,
	displayedCommand: string,
	deps: ProviderCliUpdateRunDeps,
): Promise<ProviderCliUpdateRunResult> {
	const fresh = await deps.evaluate(provider, await deps.preflight(provider));
	if (!fresh?.plan || fresh.plan.command !== displayedCommand) {
		return { kind: "plan_changed", fresh };
	}
	const result = await deps.runCommand(fresh.plan.command);
	if (result.code !== 0) {
		const detail = (result.stderr.trim() || result.stdout.trim()).slice(
			-DETAIL_TAIL_CHARS,
		);
		return { kind: "command_failed", exitCode: result.code, detail };
	}
	const after = await deps.preflight(provider);
	const afterVersion = extractCliVersion(after.version);
	const before = extractCliVersion(fresh.installedVersion);
	if (afterVersion && before && compareCliVersions(afterVersion, before) > 0) {
		return {
			kind: "updated",
			fromVersion: fresh.installedVersion,
			toVersion: afterVersion.raw,
		};
	}
	return {
		kind: "unchanged",
		version: afterVersion?.raw ?? fresh.installedVersion,
		resolvedPath: providerCliInstallPath(after),
	};
}
