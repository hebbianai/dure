import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { t } from "@/lib/i18n";
import type { MobileDeviceTarget } from "@/lib/ipc/mobileSimulator";
import {
	type MobileRunProfile,
	mobileRunProfileKey,
} from "@/lib/mobileSimulator/profile";

const emptyDraft = {
	projectPath: "",
	buildCommand: "",
	artifactPath: "",
	appId: "",
	url: "",
};

export function MobileSimulatorProfiles({
	profiles,
	target,
	busy,
	save,
	run,
	select,
}: {
	profiles: MobileRunProfile[];
	target: MobileDeviceTarget;
	busy: boolean;
	save: (profile: MobileRunProfile) => void;
	run: (profile: MobileRunProfile) => Promise<void>;
	select: (target: MobileDeviceTarget) => void;
}) {
	const [draft, setDraft] = useState(emptyDraft);
	const [error, setError] = useState("");
	const profileKey = mobileRunProfileKey({
		projectPath: draft.projectPath,
		device: target,
	});
	function newProfile() {
		setDraft(emptyDraft);
		setError("");
	}
	const valid = Boolean(draft.projectPath.trim() && draft.appId.trim());
	async function directory() {
		try {
			const path = await open({ directory: true, multiple: false });
			if (typeof path === "string")
				setDraft((draft) => ({ ...draft, projectPath: path }));
		} catch (cause) {
			setError(String(cause));
		}
	}
	return (
		<details className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">
			<summary>{t("panels.mobile.profiles")}</summary>
			<div className="mt-2 flex flex-col gap-2">
				<SelectField
					value={
						profiles.some(
							(profile) => mobileRunProfileKey(profile) === profileKey,
						)
							? profileKey
							: ""
					}
					aria-label={t("panels.mobile.profiles")}
					disabled={busy}
					onValueChange={(key) => {
						const profile = profiles.find(
							(profile) => mobileRunProfileKey(profile) === key,
						);
						if (profile) {
							setDraft(profile);
							setError("");
							select(profile.device);
						}
					}}
				>
					<SelectOption value="">{t("panels.mobile.loadProfile")}</SelectOption>
					{profiles.map((profile) => (
						<SelectOption
							key={mobileRunProfileKey(profile)}
							value={mobileRunProfileKey(profile)}
						>
							{profile.projectPath} ·{" "}
							{profile.device.platform === "ios" ? "iOS" : "Android"} ·{" "}
							{profile.device.id}
						</SelectOption>
					))}
				</SelectField>
				<div className="flex gap-1">
					<Input
						value={draft.projectPath}
						aria-label={t("panels.mobile.projectPath")}
						placeholder={t("panels.mobile.projectPath")}
						disabled={busy}
						onChange={(event) =>
							setDraft({ ...draft, projectPath: event.target.value })
						}
					/>
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() => void directory()}
					>
						{t("panels.mobile.chooseFolder")}
					</Button>
				</div>
				{(["buildCommand", "artifactPath", "appId", "url"] as const).map(
					(key) => (
						<Input
							key={key}
							value={draft[key]}
							aria-label={t(`panels.mobile.${key}`)}
							placeholder={t(`panels.mobile.${key}`)}
							disabled={busy}
							onChange={(event) =>
								setDraft({ ...draft, [key]: event.target.value })
							}
						/>
					),
				)}
				<p>{t("panels.mobile.profileHint")}</p>
				<div className="flex flex-wrap gap-1">
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={newProfile}
					>
						{t("panels.mobile.newProfile")}
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={busy || !valid}
						onClick={() => save({ ...draft, device: target })}
					>
						{t("panels.mobile.saveProfile")}
					</Button>
					<Button
						size="sm"
						disabled={busy || !valid}
						onClick={() => {
							const profile = { ...draft, device: target };
							save(profile);
							void run(profile);
						}}
					>
						{t("panels.mobile.runProfile")}
					</Button>
				</div>
				{error && (
					<p role="alert" className="text-destructive">
						{error}
					</p>
				)}
			</div>
		</details>
	);
}
