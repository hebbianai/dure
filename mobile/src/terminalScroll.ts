import { terminalScrollSensitivity } from "./terminalAppearance";
import { hasTerminalTextSelection } from "./terminalTextSelection";

/** Scroll the visible grid first, then ask the Host for rows beyond its edge.
 * The browser owns horizontal panning; hold-drag owns cancelled touch moves. */
export function attachTerminalScroll(
	scroller: HTMLElement,
	viewport: {
		rowHeight: () => number;
		scrollRows: (rows: number, touch: Pick<Touch, "clientX" | "clientY">) => void;
		onScroll?: () => void;
	},
): () => void {
	const sensitivity = terminalScrollSensitivity();
	let previous: Touch | undefined;
	let remainder = 0;
	const end = () => {
		previous = undefined;
		remainder = 0;
	};
	const start = (event: TouchEvent) => {
		end();
		if (hasTerminalTextSelection(scroller)) return;
		if (event.touches.length === 1) previous = event.touches[0];
	};
	const move = (event: TouchEvent) => {
		if (!previous || hasTerminalTextSelection(scroller)) {
			end();
			return;
		}
		if (event.touches.length !== 1) {
			end();
			return;
		}
		const current = event.touches[0];
		const from = previous;
		previous = current;
		if (
			!from ||
			from.identifier !== current.identifier ||
			event.defaultPrevented ||
			!event.cancelable
		) {
			remainder = 0;
			return;
		}
		const delta = from.clientY - current.clientY;
		if (
			Math.abs(current.clientX - from.clientX) > Math.abs(delta) ||
			delta === 0
		)
			return;
		event.preventDefault();
		const limit = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
		const before = Math.max(0, Math.min(limit, scroller.scrollTop));
		const pixels = delta * sensitivity;
		const after = Math.max(0, Math.min(limit, before + pixels));
		scroller.scrollTop = after;
		// A new frame can arrive before WebKit dispatches its scroll event.
		// Give the surface its manual position before output can follow the tail.
		viewport.onScroll?.();
		const beyond = pixels - (after - before);
		if (beyond === 0) {
			remainder = 0;
			return;
		}
		remainder += beyond / viewport.rowHeight();
		const rows = Math.trunc(remainder);
		remainder -= rows;
		if (rows !== 0) viewport.scrollRows(-rows, current);
	};
	scroller.addEventListener("touchstart", start, { passive: true });
	scroller.addEventListener("touchmove", move, { passive: false });
	scroller.addEventListener("touchend", end, { passive: true });
	scroller.addEventListener("touchcancel", end, { passive: true });
	return () => {
		end();
		scroller.removeEventListener("touchstart", start);
		scroller.removeEventListener("touchmove", move);
		scroller.removeEventListener("touchend", end);
		scroller.removeEventListener("touchcancel", end);
	};
}
