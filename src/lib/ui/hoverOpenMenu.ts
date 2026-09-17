// Hover-opening menus — the sidebar idiom where a row's action menu appears
// under the pointer instead of after a click.
//
// Why a controller and not two inline handlers: opening and closing are both
// deferred, and the two timers are the same timer. A pointer that crosses a
// row on its way somewhere else must never flash a menu (open is delayed),
// and the 4px gap between the trigger and the menu surface must not count as
// leaving it (close is delayed, and the menu content re-enters the same
// controller). One pending handle makes those two rules a single state.
//
// The controller owns *hover* intent only. Click, Escape, item selection, and
// outside-press stay Radix's, arriving through `setOpen` — which cancels any
// pending hover transition so an explicit action always wins.

import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

/** Long enough that a pointer travelling across the row does not open it. */
export const HOVER_MENU_OPEN_DELAY_MS = 140;
/** Long enough to cross the trigger→surface gap without the menu vanishing. */
export const HOVER_MENU_CLOSE_DELAY_MS = 220;

export interface HoverOpenMenuTimers {
	setTimeout(handler: () => void, ms: number): number;
	clearTimeout(handle: number): void;
}

const browserTimers: HoverOpenMenuTimers = {
	setTimeout: (handler, ms) => window.setTimeout(handler, ms),
	clearTimeout: (handle) => window.clearTimeout(handle),
};

export interface HoverOpenMenuController {
	/** Pointer entered the trigger or the open menu surface. */
	pointerEnter(): void;
	/** Pointer left the trigger or the open menu surface. */
	pointerLeave(): void;
	/** Radix `onOpenChange` — an explicit open/close cancels pending hover. */
	setOpen(open: boolean): void;
	/**
	 * The trigger was pressed. Returns true when the press must be swallowed:
	 * the menu is already open *because the pointer arrived*, and the trigger's
	 * own toggle would shut the menu the user just came to use.
	 *
	 * A press always pins the menu — it survives the pointer leaving, the way a
	 * clicked menu does everywhere else. Pressing a pinned menu unpins and
	 * closes it, so the trigger still toggles.
	 */
	press(): boolean;
	dispose(): void;
}

export function createHoverOpenMenu(input: {
	isOpen(): boolean;
	setOpen(open: boolean): void;
	openDelayMs?: number;
	closeDelayMs?: number;
	timers?: HoverOpenMenuTimers;
}): HoverOpenMenuController {
	const timers = input.timers ?? browserTimers;
	const openDelayMs = input.openDelayMs ?? HOVER_MENU_OPEN_DELAY_MS;
	const closeDelayMs = input.closeDelayMs ?? HOVER_MENU_CLOSE_DELAY_MS;
	let pending: number | null = null;
	// A pressed menu is the user's, not the pointer's: it stays until they
	// choose, press again, or dismiss it.
	let pinned = false;

	const cancel = () => {
		if (pending === null) return;
		timers.clearTimeout(pending);
		pending = null;
	};
	const schedule = (open: boolean, ms: number) => {
		cancel();
		pending = timers.setTimeout(() => {
			pending = null;
			input.setOpen(open);
		}, ms);
	};

	return {
		pointerEnter() {
			// Already open: the pointer moved trigger→surface (or back). Only the
			// pending close needs dropping.
			if (input.isOpen()) {
				cancel();
				return;
			}
			schedule(true, openDelayMs);
		},
		pointerLeave() {
			// Left before the open fired — the menu was never wanted.
			if (!input.isOpen()) {
				cancel();
				return;
			}
			// Pressed menus ignore the pointer leaving.
			if (pinned) return;
			schedule(false, closeDelayMs);
		},
		setOpen(open) {
			cancel();
			// Any close — Escape, outside press, item select — releases the pin.
			if (!open) pinned = false;
			input.setOpen(open);
		},
		press() {
			cancel();
			if (!input.isOpen()) {
				// The press itself opens it (Radix); pin so it behaves like every
				// other clicked menu afterwards.
				pinned = true;
				return false;
			}
			if (pinned) {
				// Second press on a menu the user pinned — let the trigger toggle.
				pinned = false;
				return false;
			}
			// Open because the pointer arrived. Pressing it is how a user says
			// "yes, this one" — the trigger's toggle would take it away instead.
			pinned = true;
			return true;
		},
		dispose: cancel,
	};
}

export interface HoverOpenMenuBinding {
	/** Radix `open` */
	open: boolean;
	/** Radix `onOpenChange` */
	onOpenChange(open: boolean): void;
	/** Spread onto both the trigger and the menu content. */
	hoverProps: {
		onPointerEnter(event: ReactPointerEvent<HTMLElement>): void;
		onPointerLeave(event: ReactPointerEvent<HTMLElement>): void;
	};
	/** Spread onto the Radix *Trigger* (not the child): preventing the default
	 *  there is what stops the trigger's own toggle from closing a menu the
	 *  pointer just opened. */
	triggerProps: {
		onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
	};
}

/** Hover-open binding for a Radix menu. Touch pointers are ignored — a tap
 *  has no hover phase, so those users get the plain click-to-open trigger. */
export function useHoverOpenMenu(options?: {
	openDelayMs?: number;
	closeDelayMs?: number;
}): HoverOpenMenuBinding {
	const [open, setOpen] = useState(false);
	// The controller must read the *current* open state at event time without
	// being rebuilt (and losing its pending timer) on every state change.
	const openRef = useRef(open);
	openRef.current = open;
	const openDelayMs = options?.openDelayMs;
	const closeDelayMs = options?.closeDelayMs;
	const controller = useMemo(
		() =>
			createHoverOpenMenu({
				isOpen: () => openRef.current,
				setOpen,
				openDelayMs,
				closeDelayMs,
			}),
		[openDelayMs, closeDelayMs],
	);
	useEffect(() => () => controller.dispose(), [controller]);
	const hoverProps = useMemo(
		() => ({
			onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
				if (event.pointerType === "touch") return;
				controller.pointerEnter();
			},
			onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
				if (event.pointerType === "touch") return;
				controller.pointerLeave();
			},
		}),
		[controller],
	);
	const triggerProps = useMemo(
		() => ({
			onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
				// Only the primary button toggles a Radix trigger; leave the rest
				// (context menu, middle click) to their own handlers.
				if (event.button !== 0 || event.ctrlKey) return;
				if (controller.press()) event.preventDefault();
			},
		}),
		[controller],
	);
	return { open, onOpenChange: controller.setOpen, hoverProps, triggerProps };
}
