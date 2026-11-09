import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	FindStep,
	type ViewportFrame,
} from "@/contracts/terminalStateProtocol";
import {
	TERMINAL_FIND_DEBOUNCE_MS,
	type TerminalFindSummary,
	terminalFindSummary,
} from "@/lib/terminal/interaction/terminalFind";
import { TERMINAL_HISTORY_FIND_CAPABILITY } from "@/lib/terminal/protocol/terminalStateProtocol";
import { encodeTerminalFindIntent } from "@/lib/terminal/state/terminalViewportIntent";
import type { StructuredTerminalViewportTransport } from "./structuredTerminalViewportTransportContract";

/** UTF-16 units; at most 768 UTF-8 bytes, under the Host's 1 KiB bound. */
export const TERMINAL_FIND_MAX_QUERY_LENGTH = 256;

type StructuredTerminalFindTransport = Pick<
	StructuredTerminalViewportTransport,
	"replica" | "sendViewportIntent" | "supportsCapability"
>;

export interface StructuredTerminalFind {
	readonly open: boolean;
	readonly query: string;
	readonly caseSensitive: boolean;
	readonly regex: boolean;
	readonly summary: TerminalFindSummary;
	readonly inputRef: RefObject<HTMLInputElement | null>;
	readonly show: () => void;
	readonly close: () => void;
	readonly setQuery: (query: string) => void;
	readonly toggleCaseSensitive: () => void;
	readonly toggleRegex: () => void;
	readonly step: (step: FindStep.OLDER | FindStep.NEWER) => void;
}

/**
 * Owns the find bar's local state and turns it into Host find intents. The
 * Host searches and answers on the attachment's frames; this hook never holds
 * a competing match list. Edits restart the search after a short pause; a
 * step applies at once and continues from the Host's current match.
 */
export function useStructuredTerminalFind(
	transport: StructuredTerminalFindTransport,
	/** The presented frame of the current attachment, or null before one. */
	frame: ViewportFrame | null,
	focusTerminal: () => void,
): StructuredTerminalFind {
	const { sendViewportIntent, supportsCapability } = transport;
	const attachmentId = transport.replica.attachmentId;
	const [open, setOpen] = useState(false);
	const [query, setQueryState] = useState("");
	const [caseSensitive, setCaseSensitive] = useState(false);
	const [regex, setRegex] = useState(false);
	const [debouncing, setDebouncing] = useState(false);
	const [awaitingSeq, setAwaitingSeq] = useState<bigint | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const hostFindActiveRef = useRef(false);
	const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const supported = supportsCapability(TERMINAL_HISTORY_FIND_CAPABILITY);
	const canSend = supported && frame !== null;

	const send = useCallback(
		(text: string, matchCase: boolean, useRegex: boolean, step: FindStep) => {
			if (!canSend) return;
			const seq = sendViewportIntent((recordId, inputFence, viewportFence) =>
				encodeTerminalFindIntent(recordId, inputFence, viewportFence, {
					query: text,
					caseSensitive: matchCase,
					regex: useRegex,
					step,
				}),
			);
			if (seq === undefined) return;
			hostFindActiveRef.current = text !== "";
			setAwaitingSeq(text === "" ? null : seq);
		},
		[canSend, sendViewportIntent],
	);

	const cancelRestart = useCallback(() => {
		if (restartTimerRef.current !== null) {
			clearTimeout(restartTimerRef.current);
			restartTimerRef.current = null;
		}
		setDebouncing(false);
	}, []);

	const searchedAttachmentRef = useRef(attachmentId);

	useEffect(() => {
		// A new attachment starts without a Host find, so it is searched again.
		if (searchedAttachmentRef.current !== attachmentId) {
			searchedAttachmentRef.current = attachmentId;
			hostFindActiveRef.current = false;
		}
		if (!open || !canSend) return;
		if (query === "") {
			cancelRestart();
			if (hostFindActiveRef.current) send("", false, false, FindStep.RESTART);
			return;
		}
		setDebouncing(true);
		restartTimerRef.current = setTimeout(() => {
			restartTimerRef.current = null;
			setDebouncing(false);
			send(query, caseSensitive, regex, FindStep.RESTART);
		}, TERMINAL_FIND_DEBOUNCE_MS);
		return () => {
			if (restartTimerRef.current !== null) {
				clearTimeout(restartTimerRef.current);
				restartTimerRef.current = null;
			}
		};
	}, [
		open,
		canSend,
		query,
		caseSensitive,
		regex,
		attachmentId,
		send,
		cancelRestart,
	]);

	const show = useCallback(() => {
		setOpen(true);
		const input = inputRef.current;
		if (input) {
			input.focus();
			input.select();
		}
	}, []);

	useEffect(() => {
		if (!open) return;
		const input = inputRef.current;
		input?.focus();
		input?.select();
	}, [open]);

	const close = useCallback(() => {
		cancelRestart();
		setOpen(false);
		if (hostFindActiveRef.current) send("", false, false, FindStep.RESTART);
		setAwaitingSeq(null);
		focusTerminal();
	}, [cancelRestart, focusTerminal, send]);

	const step = useCallback(
		(direction: FindStep.OLDER | FindStep.NEWER) => {
			if (query === "") return;
			// An edit the Host has not seen yet restarts instead of stepping.
			const pendingEdit =
				restartTimerRef.current !== null || !hostFindActiveRef.current;
			cancelRestart();
			send(
				query,
				caseSensitive,
				regex,
				pendingEdit ? FindStep.RESTART : direction,
			);
		},
		[cancelRestart, caseSensitive, query, regex, send],
	);

	const answered =
		awaitingSeq === null ||
		(frame?.find !== undefined && frame.find.findIntentSeq >= awaitingSeq);
	const summary = terminalFindSummary({
		supported,
		query,
		pending: debouncing || !answered,
		find: frame?.find,
	});

	return {
		open,
		query,
		caseSensitive,
		regex,
		summary,
		inputRef,
		show,
		close,
		setQuery: (next) =>
			setQueryState(
				next.replace(/\0/g, "").slice(0, TERMINAL_FIND_MAX_QUERY_LENGTH),
			),
		toggleCaseSensitive: () => setCaseSensitive((value) => !value),
		toggleRegex: () => setRegex((value) => !value),
		step,
	};
}
