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
	| ({ kind: "command_failed"; exitCode: number | null } & UpdateDiagnostic)
	| { kind: "updated"; fromVersion: string; toVersion: string }
	| ({
			kind: "updated_with_warning";
			fromVersion: string;
			toVersion: string;
	  } & UpdateDiagnostic)
	| { kind: "unchanged"; version: string; resolvedPath: string | null };

interface UpdateDiagnostic {
	detail: string;
	guidance?: "command_line_tools" | "homebrew_pkgconf";
}

export interface ProviderCliUpdateRunDeps {
	preflight: (provider: Provider) => Promise<ProviderPreflight>;
	evaluate: (
		provider: Provider,
		preflight: ProviderPreflight,
	) => Promise<ProviderCliUpdate | null>;
	runCommand: (cmd: string) => Promise<ExecResult>;
}

const DETAIL_TAIL_CHARS = 2048;

function diagnostic(output: string, brew: boolean): UpdateDiagnostic {
	// Classify before bounding output: package-manager remediation can push the
	// actual cause out of the tail. Never execute suggestions from diagnostic text.
	const guidance =
		brew &&
		/(?:Command Line Tools(?: \(CLT\))?.{0,60}(?:outdated|too old|does not support)|No developer tools installed)/i.test(
			output,
		)
			? "command_line_tools"
			: brew && /pkgconf installed that was built on macOS/i.test(output)
				? "homebrew_pkgconf"
				: undefined;
	return {
		detail: output.trim().slice(-DETAIL_TAIL_CHARS),
		...(guidance ? { guidance } : {}),
	};
}

export function providerCliUpdateException(
	error: unknown,
): ProviderCliUpdateRunResult {
	return {
		kind: "command_failed",
		exitCode: null,
		...diagnostic(
			error instanceof Error ? error.message : String(error),
			false,
		),
	};
}

export async function runProviderCliUpdate(
	provider: Provider,
	displayedCommand: string,
	deps: ProviderCliUpdateRunDeps,
): Promise<ProviderCliUpdateRunResult> {
	const fresh = await deps.evaluate(provider, await deps.preflight(provider));
	if (!fresh?.plan || fresh.plan.command !== displayedCommand) {
		return { kind: "plan_changed", fresh };
	}
	let result: ExecResult;
	try {
		result = await deps.runCommand(fresh.plan.command);
	} catch (error) {
		// A transport rejection does not prove the command finished. Do not retry it.
		return providerCliUpdateException(error);
	}
	const failure =
		result.code !== 0
			? {
					kind: "command_failed" as const,
					exitCode: result.code,
					...diagnostic(
						[result.stdout.trim(), result.stderr.trim()]
							.filter(Boolean)
							.join("\n"),
						fresh.plan.channel === "brew-cask",
					),
				}
			: null;
	let after: ProviderPreflight;
	try {
		after = await deps.preflight(provider);
	} catch (error) {
		return failure ?? providerCliUpdateException(error);
	}
	const afterVersion = extractCliVersion(after.version);
	const before = extractCliVersion(fresh.installedVersion);
	if (
		after.ready &&
		afterVersion &&
		before &&
		compareCliVersions(afterVersion, before) > 0
	) {
		if (failure) {
			return {
				...failure,
				kind: "updated_with_warning",
				fromVersion: fresh.installedVersion,
				toVersion: afterVersion.raw,
			};
		}
		return {
			kind: "updated",
			fromVersion: fresh.installedVersion,
			toVersion: afterVersion.raw,
		};
	}
	if (failure) return failure;
	return {
		kind: "unchanged",
		version: afterVersion?.raw ?? fresh.installedVersion,
		resolvedPath: providerCliInstallPath(after),
	};
}
