import { BackendServerSelect } from "@/components/common/BackendServerSelect";
import { SettingRow } from "@/components/settings/SettingsSection";
import { useAccountRecoverySettings } from "@/components/settings/useAccountRecoverySettings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { t } from "@/lib/i18n";
import { PROVIDERS, type Provider } from "@/types";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";

export function AccountRecoverySettings({
	authority,
}: {
	authority?: DureBackendRouteAuthorityV1;
} = {}) {
	const pro = useInterfaceMode() === "pro";
	return pro || authority ? (
		<RecoverySettings key={JSON.stringify(authority)} authority={authority} />
	) : null;
}

function RecoverySettings({
	authority: initialAuthority,
}: {
	authority?: DureBackendRouteAuthorityV1;
}) {
	// The parent keys this editor by the complete route. Polling an unchanged
	// route must not reload the policy and discard unsaved account choices.
	const [authority] = useState(initialAuthority);
	const state = useAccountRecoverySettings(authority);
	const busy = state.loading || state.saving;
	const options = [...state.options].sort((a, b) => {
		const position = (id: string) =>
			state.selected.includes(id)
				? state.selected.indexOf(id)
				: state.selected.length;
		return position(a.id) - position(b.id);
	});
	function move(id: string, offset: number) {
		state.setSelected((current) => {
			const next = [...current];
			const index = next.indexOf(id);
			if (index < 0 || index + offset < 0 || index + offset >= next.length)
				return current;
			[next[index], next[index + offset]] = [next[index + offset], next[index]];
			return next;
		});
	}
	return (
		<div className="space-y-3">
			{authority && (
				<p className="text-xs text-muted-foreground">
					{t("plugins.slack.recoveryScope", { server: authority.profileId })}
				</p>
			)}
			<SettingRow
				title={t("settings.recovery.title")}
				desc={t("settings.recovery.description")}
			>
				<Switch
					checked={state.enabled}
					disabled={busy || !state.ready}
					onCheckedChange={state.setEnabled}
					aria-label={t("settings.recovery.title")}
				/>
			</SettingRow>
			<div className="flex flex-wrap items-end gap-3">
				{!authority && (
					<BackendServerSelect
						profiles={state.profiles}
						value={state.backendId}
						label={t("settings.recovery.server")}
						onChange={state.setBackendId}
						disabled={busy}
					/>
				)}
				<SelectField
					value={state.provider}
					disabled={busy}
					onValueChange={(value) => state.setProvider(value as Provider)}
					aria-label={t("settings.recovery.provider")}
					className="w-40"
				>
					{(["codex", "claude"] as const).map((provider) => (
						<SelectOption key={provider} value={provider}>
							{PROVIDERS[provider].label}
						</SelectOption>
					))}
				</SelectField>
			</div>
			{state.ready && (
				<div className="space-y-2">
					<p className="text-xs text-muted-foreground">
						{t("settings.recovery.accounts")}
					</p>
					{state.options.length === 0 && (
						<p className="text-xs text-muted-foreground">
							{t("settings.recovery.empty")}
						</p>
					)}
					{options.map((account) => (
						<div key={account.id} className="flex items-center gap-2 text-sm">
							<label className="flex min-w-0 flex-1 items-center gap-2">
								<input
									type="checkbox"
									checked={state.selected.includes(account.id)}
									disabled={busy}
									onChange={(event) =>
										state.setSelected((current) =>
											event.target.checked
												? [...current, account.id]
												: current.filter((id) => id !== account.id),
										)
									}
								/>
								<span className="truncate">{account.name}</span>
							</label>
							{state.selected.includes(account.id) && (
								<>
									<Button
										variant="ghost"
										size="icon-xs"
										disabled={busy || state.selected.indexOf(account.id) === 0}
										aria-label={t("settings.recovery.moveUp", {
											account: account.name,
										})}
										onClick={() => move(account.id, -1)}
									>
										<ArrowUp />
									</Button>
									<Button
										variant="ghost"
										size="icon-xs"
										disabled={
											busy ||
											state.selected.indexOf(account.id) ===
												state.selected.length - 1
										}
										aria-label={t("settings.recovery.moveDown", {
											account: account.name,
										})}
										onClick={() => move(account.id, 1)}
									>
										<ArrowDown />
									</Button>
								</>
							)}
						</div>
					))}
				</div>
			)}
			<p className="text-xs text-muted-foreground">
				{t("settings.recovery.orderHint")}
			</p>
			{state.error && <Alert>{state.error}</Alert>}
			<div className="flex gap-2">
				<Button
					size="sm"
					disabled={busy || !state.ready}
					onClick={() => void state.save()}
				>
					{t("common.save")}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					disabled={busy}
					onClick={state.refresh}
				>
					{t("common.refresh")}
				</Button>
			</div>
		</div>
	);
}
