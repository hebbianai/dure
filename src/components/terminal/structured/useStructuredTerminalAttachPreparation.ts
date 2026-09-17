import { type RefObject, useCallback, useRef } from "react";
import type { TerminalBoxCache } from "@/lib/terminal/geometry/terminalBoxCache";
import { structuredTerminalAttachPreparationError } from "@/lib/terminal/structuredTerminalAttachPreparation";
import type { TerminalCanvasRenderer } from "./TerminalCanvasRenderer";

export function useStructuredTerminalAttachPreparation(options: {
	readonly ensure?: (columns: number, rows: number) => Promise<unknown>;
	readonly containerRef: RefObject<HTMLDivElement | null>;
	readonly surfaceBox: TerminalBoxCache;
	readonly renderer: TerminalCanvasRenderer;
	readonly fontFamily: string;
	readonly fontSize: number;
	readonly lineHeight: number;
}): () => Promise<unknown> {
	const ensureRef = useRef(options.ensure);
	ensureRef.current = options.ensure;
	return useCallback(async () => {
		if (!ensureRef.current) return undefined;
		await document.fonts?.ready;
		const container = options.containerRef.current;
		const ensure = ensureRef.current;
		if (!container || !ensure) return undefined;
		const bounds = options.surfaceBox.read();
		const metrics = options.renderer.measure(
			bounds.width,
			bounds.height,
			options.fontFamily,
			options.fontSize,
			options.lineHeight,
		);
		try {
			return await ensure(metrics.columns, metrics.rows);
		} catch (cause) {
			throw structuredTerminalAttachPreparationError(cause);
		}
	}, [
		options.containerRef,
		options.fontFamily,
		options.fontSize,
		options.lineHeight,
		options.renderer,
		options.surfaceBox,
	]);
}
