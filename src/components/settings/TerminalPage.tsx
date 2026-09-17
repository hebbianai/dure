import { PageTitle } from "@/components/settings/PageTitle";
import {
	SettingRow,
	SettingsSection,
} from "@/components/settings/SettingsSection";
import { Switch } from "@/components/ui/switch";
import { useInterfaceMode } from "@/components/workspace/useInterfaceMode";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";

/** Terminal settings backed by active structured-surface behavior. */
export function TerminalPage() {
	const prefs = useStore((state) => state.terminalPrefs);
	const set = useStore((state) => state.setTerminalPrefs);
	const mode = useInterfaceMode();
	const finalResponseOnly = useStore(
		(state) => state.uiPrefs.agentFinalResponseOnly,
	);
	const setUiPrefs = useStore((state) => state.setUiPrefs);

	return (
		<>
			<PageTitle title={t("common.terminal")} />
			<div className="flex w-full flex-col">
				{mode === "pro" && (
					<SettingsSection
						first
						label={t("settings.terminal.section.agentResponses")}
					>
						<SettingRow
							title={t("settings.terminal.finalResponseOnly.title")}
							desc={t("settings.terminal.finalResponseOnly.desc")}
						>
							<Switch
								checked={finalResponseOnly === true}
								aria-label={t("settings.terminal.finalResponseOnly.title")}
								onCheckedChange={(agentFinalResponseOnly) =>
									setUiPrefs({ agentFinalResponseOnly })
								}
							/>
						</SettingRow>
					</SettingsSection>
				)}
				<SettingsSection
					label={t("settings.terminal.section.interaction")}
					first={mode !== "pro"}
				>
					<SettingRow
						title={t("settings.terminal.copyOnSelect.title")}
						desc={t("settings.terminal.copyOnSelect.desc")}
					>
						<Switch
							checked={prefs.copyOnSelect}
							aria-label={t("settings.terminal.copyOnSelect.title")}
							onCheckedChange={(copyOnSelect) => set({ copyOnSelect })}
						/>
					</SettingRow>

					<SettingRow
						title={t("settings.terminal.osc52.title")}
						desc={t("settings.terminal.osc52.desc")}
					>
						<Switch
							checked={prefs.osc52}
							aria-label={t("settings.terminal.osc52.title")}
							onCheckedChange={(osc52) => set({ osc52 })}
						/>
					</SettingRow>
				</SettingsSection>
			</div>
		</>
	);
}
