import { ScrollToLatestButton } from "@/components/common/ScrollToLatestButton";
import type { ViewportFrame } from "@/contracts/terminalStateProtocol";
import { t } from "@/lib/i18n";
import { showTerminalScrollToBottom } from "@/lib/terminal/presentation/terminalScrollToBottom";
import { encodeTerminalViewportFollowTailIntent } from "@/lib/terminal/state/terminalViewportIntent";
import type { StructuredTerminalViewportTransport } from "./structuredTerminalViewportTransportContract";

export function StructuredTerminalScrollToBottom({
	frame,
	sendViewportIntent,
}: {
	frame: ViewportFrame | null;
	sendViewportIntent: StructuredTerminalViewportTransport["sendViewportIntent"];
}) {
	return (
		<div className="pointer-events-none absolute bottom-3 right-3 z-20">
			<ScrollToLatestButton
				visible={showTerminalScrollToBottom(frame)}
				label={t("terminal.chrome.scrollToBottom")}
				onClick={() => {
					sendViewportIntent(encodeTerminalViewportFollowTailIntent);
				}}
			/>
		</div>
	);
}
