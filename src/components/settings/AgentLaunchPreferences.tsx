import { ProviderGlyph } from "@/components/agents/ProviderLogo";
import { useAgentLaunchPreferences } from "@/components/settings/useAgentLaunchPreferences";
import { SettingRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { ErrorText } from "@/components/ui/error-text";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { PROVIDERS, type Provider } from "@/types";

/** The same persisted launch preferences in Settings and first-run setup. */
export function AgentLaunchPreferences({
	className,
	disabled = false,
}: {
	className?: string;
	disabled?: boolean;
}) {
	const {
		availableProviders,
		defaultProvider,
		setDefaultProvider,
		skipPermissions,
		permissionsReady,
		providerDefaultsError,
		updating,
		retryPermissions,
		updatePermissions,
	} = useAgentLaunchPreferences();
	return (
		<fieldset
			disabled={disabled}
			aria-label={t("common.agent")}
			className={cn("m-0 flex min-w-0 flex-col gap-6 border-0 p-0", className)}
		>
			<SettingRow
				title={t("settings.general.defaultProvider.title")}
				desc={t("settings.general.defaultProvider.desc")}
			/>
			{/* Chips wrap, so they sit under the row text rather than in the
              row's right-hand control slot. Auto = preference unset. */}
			<Segmented<"auto" | Provider>
				variant="chips"
				value={defaultProvider ?? "auto"}
				onChange={setDefaultProvider}
				options={[
					{ value: "auto", label: t("settings.general.defaultProvider.auto") },
					...availableProviders.map((p) => ({
						value: p,
						label: PROVIDERS[p].label,
						icon: <ProviderGlyph provider={p} className="size-3.5" />,
					})),
				]}
			/>

			{availableProviders
				.filter((p) => PROVIDERS[p].skipPermFlag)
				.map((p) => (
					<SettingRow
						key={p}
						leading={<ProviderGlyph provider={p} className="size-5" />}
						title={t("settings.general.providerSkipPermissions", {
							label: PROVIDERS[p].label,
						})}
						desc={PROVIDERS[p].skipPermFlag}
					>
						<Switch
							checked={!!skipPermissions[p]}
							disabled={updating || !permissionsReady}
							aria-label={t("settings.general.providerSkipPermissions", {
								label: PROVIDERS[p].label,
							})}
							onCheckedChange={(value) => updatePermissions(p, value)}
						/>
					</SettingRow>
				))}
			{providerDefaultsError && (
				<div className="flex flex-wrap items-center gap-3 py-2">
					<ErrorText>{t("settings.general.providerDefaults.failed")}</ErrorText>
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={updating}
						onClick={retryPermissions}
					>
						{t("common.retry")}
					</Button>
				</div>
			)}
		</fieldset>
	);
}
