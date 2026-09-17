import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	detectQuarantine,
	type QuarantineState,
	quarantineApproveCommand,
} from "@/lib/agents/providerCliQuarantine";
import { runShell } from "@/lib/ipc/process";
import { t } from "@/lib/i18n";
import type { ProviderPreflight } from "@/lib/ipc";
import {
	type DesktopPlatform,
	detectDesktopPlatform,
} from "@/lib/workspace/desktop/desktopPlatform";
import type { Provider } from "@/types";

interface ProviderCliQuarantineNoticeProps {
	provider: Provider;
	preflight: ProviderPreflight;
	/** Re-probe the page-owned preflight so the row clears once approved. */
	refreshPreflight: (provider: Provider) => Promise<void>;
	platform?: DesktopPlatform;
}

// The Gatekeeper SIGKILL of a quarantined binary surfaces as one of these.
const KILLED_STATUSES = new Set<ProviderPreflight["status"]>([
	"version_timeout",
	"version_failed",
]);

/** After an update leaves a bare, notarized CLI binary quarantined, macOS
 * blocks the app's spawn and the `--version` probe is SIGKILLed. When that
 * happens on macOS and the binary is quarantined, Apple-anchor trusted
 * (Developer ID / Apple, not ad-hoc), and carries a named signing identity,
 * offer a user-consented Approve that clears the quarantine attribute. Any
 * quarantined binary we cannot vouch for that way gets a warning only — never a
 * one-click Gatekeeper bypass. */
export function ProviderCliQuarantineNotice({
	provider,
	preflight,
	refreshPreflight,
	platform = detectDesktopPlatform(),
}: ProviderCliQuarantineNoticeProps) {
	const [state, setState] = useState<QuarantineState | null>(null);
	const [running, setRunning] = useState(false);
	const [failed, setFailed] = useState<string | null>(null);

	const path = preflight.resolvedPath ?? null;
	const applicable =
		platform === "macos" &&
		!preflight.ready &&
		KILLED_STATUSES.has(preflight.status) &&
		path !== null;

	useEffect(() => {
		let stale = false;
		setState(null);
		setFailed(null);
		if (!applicable || !path) return;
		void detectQuarantine(path).then((value) => {
			if (!stale) setState(value);
		});
		return () => {
			stale = true;
		};
	}, [applicable, path]);

	const approve = useCallback(async () => {
		if (!path || running) return;
		setRunning(true);
		setFailed(null);
		try {
			const result = await runShell(quarantineApproveCommand(path));
			if (result.code !== 0) {
				setFailed(result.stderr.trim() || result.stdout.trim());
				return;
			}
			await refreshPreflight(provider);
		} catch (cause) {
			setFailed(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setRunning(false);
		}
	}, [path, provider, running, refreshPreflight]);

	if (!applicable || !path || !state?.quarantined) return null;

	// Offer the one-click strip only for an Apple-anchored (Gatekeeper-trusted)
	// binary with a named identity; a quarantined binary we cannot vouch for
	// gets a warning, never a bypass.
	if (!state.signatureTrusted || !state.signingIdentity) {
		return (
			<p className="max-w-[600px] pt-2 text-xs text-destructive">
				{t("settings.providers.cliQuarantine.unsigned")}
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-1 pt-2">
			<p className="max-w-[600px] text-xs text-muted-foreground">
				{t("settings.providers.cliQuarantine.explain", {
					identity: state.signingIdentity,
				})}
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<code className="text-meta text-muted-foreground">
					{quarantineApproveCommand(path)}
				</code>
				<Button
					size="sm"
					variant="outline"
					disabled={running}
					onClick={() => void approve()}
				>
					{running
						? t("settings.providers.cliQuarantine.approving")
						: t("settings.providers.cliQuarantine.approve")}
				</Button>
			</div>
			{failed !== null && (
				<p className="max-w-[600px] text-xs text-destructive">
					{t("settings.providers.cliQuarantine.failed")}{" "}
					<code className="text-meta">{failed}</code>
				</p>
			)}
		</div>
	);
}
