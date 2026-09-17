import { useEffect } from "react";
import { terminalDefaultColors } from "@/lib/terminal/state/terminalDefaultColors";
import { TERMINAL_DEFAULT_COLORS_CAPABILITY } from "@/lib/terminal/protocol/terminalStateProtocol";
import { encodeTerminalDefaultColorsIntent } from "@/lib/terminal/state/terminalViewportIntent";
import type { TerminalPalette } from "@/lib/theme/terminalTheme";
import type { StructuredTerminalViewportTransport } from "./structuredTerminalViewportTransportContract";

/** Keeps the Host's OSC 10/11 defaults aligned with the rendered surface. */
export function useStructuredTerminalDefaultColorSync(
	palette: Pick<TerminalPalette, "background" | "foreground">,
	transport: Pick<
		StructuredTerminalViewportTransport,
		"replica" | "sendViewportIntent" | "supportsCapability"
	>,
): void {
	const { replica, sendViewportIntent, supportsCapability } = transport;
	const projectionReady = replica.projectionRevision !== 0n;
	useEffect(() => {
		if (
			replica.terminalEpoch === null ||
			!projectionReady ||
			!supportsCapability(TERMINAL_DEFAULT_COLORS_CAPABILITY)
		) {
			return;
		}
		sendViewportIntent((recordId, inputFence, viewportFence) =>
			encodeTerminalDefaultColorsIntent(
				recordId,
				inputFence,
				viewportFence,
				terminalDefaultColors(palette),
			),
		);
	}, [
		palette.background,
		palette.foreground,
		replica.attachmentId,
		projectionReady,
		replica.terminalEpoch,
		sendViewportIntent,
		supportsCapability,
	]);
}
