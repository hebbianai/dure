import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { runShell } from "@/lib/ipc/process";
import { providerExecutable } from "@/lib/agents/providerPreflight";
import { t } from "@/lib/i18n";
import { type ProviderPreflight, providerPreflight } from "@/lib/ipc";
import {
	type ProviderCliUpdateRunResult,
	runProviderCliUpdate,
} from "@/lib/updates/providerCliUpdateRun";
import {
	evaluateProviderCliUpdate,
	refreshProviderCliUpdateNotice,
	type ProviderCliUpdate,
} from "@/lib/updates/providerCliUpdateSource";
import type { Provider } from "@/types";

interface ProviderCliUpdateRowProps {
	provider: Provider;
	preflight: ProviderPreflight;
	/** Re-probe the page-owned preflight so the version badge stays current. */
	refreshPreflight: (provider: Provider) => Promise<void>;
}

function probeProvider(provider: Provider): Promise<ProviderPreflight> {
	return providerPreflight({
		provider,
		command: providerExecutable(provider),
		cwd: "/",
	});
}

/** The one mutating action on the otherwise read-only Providers page —
 * the provider update command runs
 * only when a fresh detection still matches what the user is looking at. */
export function ProviderCliUpdateRow({
	provider,
	preflight,
	refreshPreflight,
}: ProviderCliUpdateRowProps) {
	const [update, setUpdate] = useState<ProviderCliUpdate | null>(null);
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<ProviderCliUpdateRunResult | null>(null);

	useEffect(() => {
		let stale = false;
		setUpdate(null);
		setResult(null);
		void evaluateProviderCliUpdate(provider, preflight).then((value) => {
			if (!stale) setUpdate(value);
		});
		return () => {
			stale = true;
		};
	}, [provider, preflight]);

	const run = useCallback(async () => {
		if (!update?.plan || running) return;
		setRunning(true);
		try {
			const outcome = await runProviderCliUpdate(
				provider,
				update.plan.command,
				{
					preflight: probeProvider,
					evaluate: evaluateProviderCliUpdate,
					runCommand: runShell,
				},
			);
			setResult(outcome);
			if (outcome.kind === "plan_changed") {
				setUpdate(outcome.fresh);
			}
			const updateResolved =
				outcome.kind === "updated" ||
				(outcome.kind === "plan_changed" && !outcome.fresh);
			if (updateResolved) {
				// Refresh both projections from their existing authorities: this page's
				// exact preflight and the aggregate maintenance notice's full probe.
				await refreshPreflight(provider);
				await refreshProviderCliUpdateNotice();
			}
		} finally {
			setRunning(false);
		}
	}, [provider, update, running, refreshPreflight]);

	if (!update) return null;

	return (
		<div className="flex flex-col gap-1 pt-2">
			{update.plan ? (
				<div className="flex flex-wrap items-center gap-2">
					<Badge size="sm" variant="secondary" className="font-mono">
						{update.installedVersion} → {update.latestVersion}
					</Badge>
					<code className="text-meta text-muted-foreground">
						{update.plan.command}
					</code>
					<Button
						size="sm"
						variant="outline"
						disabled={running}
						onClick={() => void run()}
					>
						{running ? t("common.updating") : t("common.update")}
					</Button>
				</div>
			) : (
				<p className="max-w-[600px] text-xs text-muted-foreground">
					{t("settings.providers.cliUpdate.unknownChannel", {
						version: update.latestVersion,
					})}{" "}
					<a
						className="underline"
						href={update.docsUrl}
						target="_blank"
						rel="noreferrer"
					>
						{update.docsUrl}
					</a>
					{update.resolvedPath && (
						<>
							{" "}
							<code className="text-meta">{update.resolvedPath}</code>
						</>
					)}
				</p>
			)}
			{result?.kind === "unchanged" && (
				<p className="max-w-[600px] text-xs text-muted-foreground">
					{t("settings.providers.cliUpdate.unchanged", {
						version: result.version,
					})}{" "}
					{result.resolvedPath && (
						<code className="text-meta">{result.resolvedPath}</code>
					)}
				</p>
			)}
			{result?.kind === "command_failed" && (
				<p className="max-w-[600px] text-xs text-destructive">
					{t("settings.providers.cliUpdate.failed")}{" "}
					<code className="text-meta">{result.detail}</code>
				</p>
			)}
			{result?.kind === "plan_changed" && (
				<p className="max-w-[600px] text-xs text-muted-foreground">
					{t("settings.providers.cliUpdate.planChanged")}
				</p>
			)}
		</div>
	);
}
