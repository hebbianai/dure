import { type Ref, useImperativeHandle, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import { deliverCaptureToAgent } from "@/lib/agents/captureDraftDelivery";
import { t } from "@/lib/i18n";
import {
	type MobileDeviceTarget,
	type MobileFrame,
	mobileSimulator,
} from "@/lib/ipc/mobileSimulator";
import { saveTempImage } from "@/lib/ipc/system";
import type { MobileReportControls } from "@/lib/mobileSimulator/controlActions";
import { usePaneAgentChoices } from "../usePaneAgentChoices";

export function MobileSimulatorReport({
	target,
	busy,
	ref,
	onWorkingChange,
	capture,
}: {
	target: MobileDeviceTarget;
	busy: boolean;
	ref?: Ref<MobileReportControls>;
	onWorkingChange?: (working: boolean) => void;
	capture: () => Promise<MobileFrame>;
}) {
	const agents = usePaneAgentChoices();
	const [appId, setAppId] = useState("");
	const [agentId, setAgentId] = useState("");
	const [pending, setPending] = useState<{
		reportId: string;
		text: string;
		image: string;
	}>();
	const [working, setWorking] = useState(false);
	const [error, setError] = useState("");
	const [sent, setSent] = useState(false);
	const operation = useRef(false);
	const details = useRef<HTMLDetailsElement>(null);
	async function prepare(selectedAppId: string) {
		if (busy || operation.current) throw new Error(t("panels.mobile.working"));
		operation.current = true;
		setAppId(selectedAppId);
		if (details.current) details.current.open = true;
		setWorking(true);
		onWorkingChange?.(true);
		setError("");
		setPending(undefined);
		setSent(false);
		try {
			const report = await mobileSimulator.report(target, selectedAppId);
			const frame = await capture();
			const packet = {
				reportId: crypto.randomUUID(),
				text: JSON.stringify(
					{ capturedAt: new Date().toISOString(), ...report },
					null,
					2,
				),
				image: frame.dataUrl,
			};
			const path = await saveTempImage({
				dataB64: frame.dataUrl.split(",")[1],
				ext: "png",
			});
			setPending(packet);
			return {
				reportId: packet.reportId,
				text: packet.text,
				screenshot: { path, width: frame.width, height: frame.height },
			};
		} catch (cause) {
			setError(String(cause));
			throw cause;
		} finally {
			operation.current = false;
			setWorking(false);
			onWorkingChange?.(false);
		}
	}
	async function deliver(reportId: string, recipient: string, text?: string) {
		if (busy || operation.current) throw new Error(t("panels.mobile.working"));
		if (!pending || pending.reportId !== reportId)
			throw new Error(t("panels.mobile.reportChanged"));
		if (!agents.some((agent) => agent.id === recipient))
			throw new Error(t("common.sendToAgent"));
		operation.current = true;
		setAgentId(recipient);
		setWorking(true);
		onWorkingChange?.(true);
		setError("");
		try {
			await deliverCaptureToAgent(recipient, text ?? pending.text, [
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
			throw cause;
		} finally {
			operation.current = false;
			setWorking(false);
			onWorkingChange?.(false);
		}
	}
	useImperativeHandle(ref, () => ({
		prepare,
		draft: deliver,
		busy: () => operation.current,
	}));
	return (
		<details
			ref={details}
			className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground"
		>
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
					onClick={() => void prepare(appId).catch(() => {})}
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
							onClick={() =>
								void deliver(pending.reportId, agentId).catch(() => {})
							}
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
