import { Copy } from "lucide-react";
import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { t } from "@/lib/i18n";
import type { MobileFrame } from "@/lib/ipc/mobileSimulator";
import { saveTempImage } from "@/lib/ipc/system";
import { copyTextToClipboard } from "@/lib/platform/clipboardWrite";

export function MobileSimulatorCaptureButton({
	frame,
	paneId,
}: {
	frame: MobileFrame | undefined;
	paneId: string;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	async function copy() {
		if (!frame || busy) return;
		setBusy(true);
		setError(undefined);
		try {
			const path = await saveTempImage({
				dataB64: frame.dataUrl.split(",")[1],
				ext: frame.dataUrl.startsWith("data:image/jpeg;") ? "jpg" : "png",
			});
			await copyTextToClipboard(path, {
				paneId,
				successMessage: t("panels.mobile.screenCopied"),
			});
		} catch (cause) {
			setError(String(cause));
		} finally {
			setBusy(false);
		}
	}
	return (
		<>
			<IconButton
				disabled={!frame || busy}
				title={t("panels.mobile.copyScreen")}
				onClick={() => void copy()}
			>
				<Copy />
			</IconButton>
			{error && (
				<span role="alert" className="text-xs text-destructive">
					{error}
				</span>
			)}
		</>
	);
}
