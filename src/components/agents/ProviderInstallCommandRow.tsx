import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { Button } from "@/components/ui/button";
import type { ProviderInstallCommand } from "@/lib/agents/providerInstallCommand";
import { Disclosure } from "@/components/ui/disclosure";
import { t } from "@/lib/i18n";
import { PROVIDERS } from "@/types";

export interface ProviderSetupFailure {
	cause: unknown;
	guide?: ProviderInstallCommand;
}

export function ProviderInstallGuidance({
	failure,
}: {
	failure: ProviderSetupFailure | null;
}) {
	if (!failure) return null;
	return (
		<div className="space-y-2">
			<p className="text-meta break-all text-destructive">
				{String(failure.cause)}
			</p>
			{failure.guide && (
				<Disclosure
					size="meta"
					label={t("agents.add.installationGuide")}
					bodyClassName="mt-1.5 space-y-2"
				>
					<p className="text-muted-foreground">
						{t("agents.add.installationGuideHint")}
					</p>
					<ProviderInstallCommandRow entry={failure.guide} />
				</Disclosure>
			)}
		</div>
	);
}

/** The same command can be copied in a retained form or executed by onboarding. */
export function ProviderInstallCommandRow({
	entry,
	onInstall,
}: {
	entry: ProviderInstallCommand;
	onInstall?: (entry: ProviderInstallCommand) => void;
}) {
	const [copied, setCopied] = useState(false);
	const label = (
		<>
			<ProviderGlyph provider={entry.provider} className="size-3.5" />
			<span>{PROVIDERS[entry.provider].label}</span>
		</>
	);
	return (
		<div className="flex w-full min-w-0 items-center gap-1.5">
			{onInstall ? (
				<Button
					type="button"
					variant="outline"
					aria-label={`${PROVIDERS[entry.provider].label} ${t("common.install")}`}
					className="h-8 shrink-0 gap-1.5 rounded-sm px-2.5 text-xs"
					onClick={() => onInstall(entry)}
				>
					{label}
					<span className="text-muted-foreground">{t("common.install")}</span>
				</Button>
			) : (
				<span className="flex shrink-0 items-center gap-1.5 text-xs">
					{label}
				</span>
			)}
			<button
				type="button"
				aria-label={t("onboarding.checklist.copyCommand", {
					command: entry.command,
				})}
				className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-sm bg-surface-sunken px-2.5 text-left transition-colors hover:bg-glass-tint-hover"
				onClick={() => {
					void navigator.clipboard
						.writeText(entry.command)
						.then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 1500);
						})
						// The visible command remains available for manual copying.
						.catch(() => undefined);
				}}
			>
				<span className="min-w-0 flex-1 truncate font-mono text-[11px]/5 text-muted-foreground">
					{entry.command}
				</span>
				{copied ? (
					<Check className="size-3 shrink-0 text-status-done" />
				) : (
					<Copy className="size-3 shrink-0 text-muted-foreground" />
				)}
			</button>
		</div>
	);
}
