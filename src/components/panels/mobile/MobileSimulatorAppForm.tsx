import { open } from "@tauri-apps/plugin-dialog";
import { Play, Upload } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import type {
	MobileDeviceAction,
	MobileDeviceTarget,
} from "@/lib/ipc/mobileSimulator";

export function MobileSimulatorAppForm({
	platform,
	busy,
	act,
}: {
	platform: MobileDeviceTarget["platform"];
	busy: boolean;
	act: (action: MobileDeviceAction) => Promise<void>;
}) {
	const [appId, setAppId] = useState("");
	const [error, setError] = useState<string>();
	async function install() {
		setError(undefined);
		try {
			const path = await open({
				multiple: false,
				directory: false,
				title: t("panels.mobile.install"),
				filters: [
					{
						name: platform === "ios" ? "iOS" : "Android",
						extensions: [platform === "ios" ? "app" : "apk"],
					},
				],
			});
			if (typeof path === "string") await act({ kind: "install", path });
		} catch (cause) {
			setError(String(cause));
		}
	}
	return (
		<details className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">
			<summary>{t("panels.mobile.app")}</summary>
			<form
				className="mt-2 flex flex-wrap gap-1"
				onSubmit={(event) => {
					event.preventDefault();
					void act({ kind: "launch", appId });
				}}
			>
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={busy}
					onClick={() => void install()}
				>
					<Upload />
					{t("panels.mobile.install")}
				</Button>
				<Input
					aria-label={t("panels.mobile.appId")}
					placeholder={t("panels.mobile.appId")}
					value={appId}
					onChange={(event) => setAppId(event.target.value)}
					disabled={busy}
					className="h-7 min-w-24 flex-1"
				/>
				<Button size="sm" variant="outline" disabled={busy || !appId.trim()}>
					<Play />
					{t("panels.mobile.launch")}
				</Button>
			</form>
			{error && (
				<p role="alert" className="pt-1 text-destructive">
					{error}
				</p>
			)}
		</details>
	);
}
