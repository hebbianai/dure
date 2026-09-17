import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { deliverCaptureToAgent } from "@/lib/agents/captureDraftDelivery";
import { t } from "@/lib/i18n";
import {
	type MobileDeviceTarget,
	mobileSimulator,
} from "@/lib/ipc/mobileSimulator";
import { usePaneAgentChoices } from "../usePaneAgentChoices";

export function MobileSimulatorReport({
	target,
	busy,
}: {
	target: MobileDeviceTarget;
	busy: boolean;
}) {
	const agents = usePaneAgentChoices();
	const [appId, setAppId] = useState("");
	const [agentId, setAgentId] = useState("");
	const [pending, setPending] = useState<{ text: string; image: string }>();
	const [working, setWorking] = useState(false);
	const [error, setError] = useState("");
	const [sent, setSent] = useState(false);
	async function prepare() {
		setWorking(true);
		setError("");
		setPending(undefined);
		setSent(false);
		try {
			const report = await mobileSimulator.report(target, appId);
			const frame = await mobileSimulator.capture(target);
			setPending({
				text: JSON.stringify(
					{ capturedAt: new Date().toISOString(), ...report },
					null,
					2,
				),
				image: frame.dataUrl,
			});
		} catch (cause) {
			setError(String(cause));
		} finally {
			setWorking(false);
		}
	}
	async function deliver() {
		if (!pending || !agentId || working) return;
		setWorking(true);
		setError("");
		try {
			await deliverCaptureToAgent(agentId, pending.text, [
				{
					kind: "bytes",
					file: {
						fileName: "mobile-screen.png",
						dataB64: pending.image.split(",")[1],
					},
				},
			]);
			setPending(undefined);
			setSent(true);
		} catch (cause) {
			setError(String(cause));
		} finally {
			setWorking(false);
		}
	}
	return (
		<details className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">
			<summary>{t("panels.mobile.report")}</summary>
			<div className="mt-2 flex flex-col gap-2">
				<Input
					value={appId}
					aria-label={t("panels.mobile.appId")}
					placeholder={t("panels.mobile.appId")}
					onChange={(event) => setAppId(event.target.value)}
					disabled={working}
				/>
				<p>{t("panels.mobile.reportHint")}</p>
				<Button
					size="sm"
					variant="outline"
					disabled={busy || working || !appId.trim()}
					onClick={() => void prepare()}
				>
					{t("panels.mobile.prepareReport")}
				</Button>
				{pending && (
					<>
						<img
							src={pending.image}
							alt={t("panels.mobile.screen", { name: appId })}
							className="max-h-32 object-contain"
						/>
						<textarea
							aria-label={t("panels.mobile.report")}
							className="h-32 w-full resize-y rounded border bg-background p-2 font-mono text-xs text-foreground"
							value={pending.text}
							disabled={working}
							onChange={(event) =>
								setPending({ ...pending, text: event.target.value })
							}
						/>
						<SelectField
							value={agentId}
							aria-label={t("common.sendToAgent")}
							disabled={working}
							onValueChange={setAgentId}
						>
							<SelectOption value="">{t("common.sendToAgent")}</SelectOption>
							{agents.map((agent) => (
								<SelectOption key={agent.id} value={agent.id}>
									{agentDisplayName(agent)}
								</SelectOption>
							))}
						</SelectField>
						<Button
							size="sm"
							disabled={!agentId || working}
							onClick={() => void deliver()}
						>
							{t("common.typeIntoPrompt")}
						</Button>
					</>
				)}
				{sent && <p role="status">{t("common.typedIntoPromptPressEnter")}</p>}
				{error && (
					<p role="alert" className="text-destructive">
						{error}
					</p>
				)}
			</div>
		</details>
	);
}
