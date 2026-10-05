import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { runShell } from "@/lib/ipc/process";
import { providerExecutable } from "@/lib/agents/providerPreflight";
import { t } from "@/lib/i18n";
import { type ProviderPreflight, providerPreflight } from "@/lib/ipc";
import {
	type ProviderCliUpdateRunResult,
	providerCliUpdateException,
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
		setResult(null);
	}, [provider]);

	useEffect(() => {
		let stale = false;
		setUpdate(null);
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
		setResult(null);
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
				outcome.kind === "updated_with_warning" ||
				(outcome.kind === "plan_changed" && !outcome.fresh);
			if (updateResolved) {
				// Refresh both projections from their existing authorities: this page's
				// exact preflight and the aggregate maintenance notice's full probe.
				await refreshPreflight(provider);
				await refreshProviderCliUpdateNotice();
			}
		} catch (error) {
			setResult(providerCliUpdateException(error));
		} finally {
			setRunning(false);
		}
	}, [provider, update, running, refreshPreflight]);

	if (
		!update &&
		result?.kind !== "command_failed" &&
		result?.kind !== "updated_with_warning"
	)
		return null;

	return (
		<div className="flex flex-col gap-1 pt-2">
			{update?.plan ? (
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
			) : update ? (
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
			) : null}
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
			{result && <ProviderCliUpdateFeedback result={result} />}
			{result?.kind === "plan_changed" && (
				<p className="max-w-[600px] text-xs text-muted-foreground">
					{t("settings.providers.cliUpdate.planChanged")}
				</p>
			)}
		</div>
	);
}

export function ProviderCliUpdateFeedback({
	result,
}: {
	result: ProviderCliUpdateRunResult;
}) {
	if (
		result.kind !== "command_failed" &&
		result.kind !== "updated_with_warning"
	)
		return null;
	const guidance =
		result.guidance === "command_line_tools"
			? t("settings.providers.cliUpdate.commandLineTools")
			: result.guidance === "homebrew_pkgconf"
				? t("settings.providers.cliUpdate.homebrewPkgconf")
				: t("settings.providers.cliUpdate.reviewDetails");
	return (
		<div className="max-w-[600px] space-y-2 text-xs" role="status">
			<p
				className={
					result.kind === "command_failed"
						? "text-destructive"
						: "text-foreground"
				}
			>
				{result.kind === "updated_with_warning"
					? t("settings.providers.cliUpdate.updatedWithWarning", {
							version: result.toVersion,
						})
					: t("settings.providers.cliUpdate.failed")}
			</p>
			<p className="text-muted-foreground">{guidance}</p>
			{result.detail && (
				<details className="text-muted-foreground">
					<summary className="cursor-pointer">{t("common.details")}</summary>
					<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-meta">
						{result.detail}
					</pre>
				</details>
			)}
		</div>
	);
}
