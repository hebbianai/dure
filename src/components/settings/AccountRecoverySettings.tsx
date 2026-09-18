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

export function AccountRecoverySettings() {
	const pro = useInterfaceMode() === "pro";
	return pro ? <RecoverySettings /> : null;
}

function RecoverySettings() {
	const state = useAccountRecoverySettings();
	const busy = state.loading || state.saving;
	return (
		<div className="space-y-3">
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
				<BackendServerSelect
					profiles={state.profiles}
					value={state.backendId}
					label={t("settings.recovery.server")}
					onChange={state.setBackendId}
					disabled={busy}
				/>
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
					{state.options.map((account) => (
						<label key={account.id} className="flex items-center gap-2 text-sm">
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
							{account.name}
						</label>
					))}
				</div>
			)}
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
