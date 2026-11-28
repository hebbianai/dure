// Keep a derived arrangement still while a person is at it.
import {
	type FocusEvent,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";
import { lastInputWasKeyboard } from "@/lib/ui/inputModality";

/** The handlers of the region a person can be at. */
export interface PresenceHandlers {
	onPointerEnter(): void;
	onPointerLeave(): void;
	onFocus(): void;
	onBlur(event: FocusEvent<HTMLElement>): void;
}

/** Whether a person is at `region`: the pointer is in it, or keyboard focus
 * is. Focus a click left behind does not count (some engines focus a button
 * on click), and focus is read from the document each time, so a focused row
 * that is removed holds nothing. */
function personAt(region: HTMLElement | null, pointer: boolean): boolean {
	if (!region) return false;
	if (pointer) return true;
	const doc = region.ownerDocument;
	return region.contains(doc.activeElement) && lastInputWasKeyboard(doc);
}

/**
 * What a region shows: the latest value, except while a person points into
 * the region or has keyboard focus inside it. Then it is the value they
 * arrived to, so a change made elsewhere (an agent ending, a new wait) never
 * moves a row under the pointer or away from the focused row; it applies
 * once they leave. Hold only the arrangement: each row still reads its own
 * facts live.
 */
export function useHeldWhilePresent<T, E extends HTMLElement = HTMLDivElement>(
	latest: T,
): {
	readonly value: T;
	readonly region: RefObject<E | null>;
	readonly presence: PresenceHandlers;
} {
	const region = useRef<E>(null);
	const pointer = useRef(false);
	const [held, setHeld] = useState<{ readonly value: T } | null>(null);
	const settle = () => {
		const present = personAt(region.current, pointer.current);
		setHeld((current) => (present ? (current ?? { value: latest }) : null));
	};
	// No event says a focused row was removed: check again on every change.
	useEffect(() => {
		if (held && !personAt(region.current, pointer.current)) setHeld(null);
	});
	return {
		value: held ? held.value : latest,
		region,
		presence: {
			onPointerEnter: () => {
				pointer.current = true;
				settle();
			},
			onPointerLeave: () => {
				pointer.current = false;
				settle();
			},
			onFocus: settle,
			onBlur: (event) => {
				// Focus moving between rows stays inside the region.
				if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
					return;
				}
				settle();
			},
		},
	};
}
