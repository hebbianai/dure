import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	FindHighlightSchema,
	FindStatus,
	ViewportFindSchema,
} from "@/contracts/terminalStateProtocol";
import {
	isTerminalFindShortcut,
	terminalFindBarKeyAction,
	terminalFindHighlightBoxes,
	terminalFindSummary,
} from "./terminalFind";

function key(
	keyName: string,
	modifiers: Partial<{
		metaKey: boolean;
		ctrlKey: boolean;
		shiftKey: boolean;
		altKey: boolean;
	}> = {},
) {
	return {
		key: keyName,
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		...modifiers,
	};
}

describe("isTerminalFindShortcut", () => {
	it("opens on Command+F on macOS and leaves Ctrl+F to the shell", () => {
		expect(
			isTerminalFindShortcut(key("f", { metaKey: true }), {}, "macos"),
		).toBe(true);
		expect(
			isTerminalFindShortcut(key("f", { ctrlKey: true }), {}, "macos"),
		).toBe(false);
	});

	it("opens on Ctrl+Shift+F elsewhere so readline keeps Ctrl+F", () => {
		for (const platform of ["windows", "linux", "unknown"] as const) {
			expect(
				isTerminalFindShortcut(
					key("F", { ctrlKey: true, shiftKey: true }),
					{},
					platform,
				),
			).toBe(true);
			expect(
				isTerminalFindShortcut(key("f", { ctrlKey: true }), {}, platform),
			).toBe(false);
			expect(
				isTerminalFindShortcut(key("f", { metaKey: true }), {}, platform),
			).toBe(false);
		}
	});

	it("follows a rebound or unassigned shortcut", () => {
		const rebound = {
			"term-find": { mod: true, shift: false, alt: true, key: "f" },
		};
		expect(
			isTerminalFindShortcut(
				key("f", { metaKey: true, altKey: true }),
				rebound,
				"macos",
			),
		).toBe(true);
		expect(
			isTerminalFindShortcut(key("f", { metaKey: true }), rebound, "macos"),
		).toBe(false);
		expect(
			isTerminalFindShortcut(
				key("f", { metaKey: true }),
				{ "term-find": null },
				"macos",
			),
		).toBe(false);
	});
});

describe("terminalFindBarKeyAction", () => {
	it("walks older on Enter, newer on Shift+Enter and closes on Escape", () => {
		expect(terminalFindBarKeyAction({ key: "Enter", shiftKey: false })).toBe(
			"older",
		);
		expect(terminalFindBarKeyAction({ key: "Enter", shiftKey: true })).toBe(
			"newer",
		);
		expect(terminalFindBarKeyAction({ key: "Escape", shiftKey: false })).toBe(
			"close",
		);
		expect(terminalFindBarKeyAction({ key: "a", shiftKey: false })).toBeNull();
	});

	it("leaves Enter to an input method that is still composing", () => {
		expect(
			terminalFindBarKeyAction({
				key: "Enter",
				shiftKey: false,
				isComposing: true,
			}),
		).toBeNull();
	});
});

describe("terminalFindSummary", () => {
	const matched = create(ViewportFindSchema, {
		findIntentSeq: 3n,
		status: FindStatus.MATCHED,
		matchCount: 17,
		matchCountComplete: false,
		currentMatch: 2,
	});

	it("reads the Host's count and position for an answered query", () => {
		expect(
			terminalFindSummary({
				supported: true,
				query: "err",
				pending: false,
				find: matched,
			}),
		).toEqual({ kind: "matched", current: 2, total: 17, complete: false });
	});

	it("never shows a stale count while a new query is pending", () => {
		expect(
			terminalFindSummary({
				supported: true,
				query: "erro",
				pending: true,
				find: matched,
			}),
		).toEqual({ kind: "searching" });
		expect(
			terminalFindSummary({
				supported: true,
				query: "erro",
				pending: false,
				find: undefined,
			}),
		).toEqual({ kind: "searching" });
	});

	it("distinguishes no match, an invalid pattern, an empty query and an old Host", () => {
		const none = create(ViewportFindSchema, {
			findIntentSeq: 4n,
			status: FindStatus.NO_MATCH,
			matchCountComplete: true,
		});
		const invalid = create(ViewportFindSchema, {
			findIntentSeq: 5n,
			status: FindStatus.INVALID_PATTERN,
			matchCountComplete: true,
		});
		expect(
			terminalFindSummary({
				supported: true,
				query: "x",
				pending: false,
				find: none,
			}),
		).toEqual({ kind: "none", complete: true });
		expect(
			terminalFindSummary({
				supported: true,
				query: "(",
				pending: false,
				find: invalid,
			}),
		).toEqual({ kind: "invalid" });
		expect(
			terminalFindSummary({
				supported: true,
				query: "",
				pending: false,
				find: none,
			}),
		).toEqual({
			kind: "idle",
		});
		expect(
			terminalFindSummary({
				supported: false,
				query: "x",
				pending: false,
				find: undefined,
			}),
		).toEqual({ kind: "unsupported" });
	});
});

describe("terminalFindHighlightBoxes", () => {
	it("places each segment on the painted cell grid", () => {
		const find = create(ViewportFindSchema, {
			findIntentSeq: 3n,
			status: FindStatus.MATCHED,
			matchCount: 1,
			matchCountComplete: true,
			currentMatch: 1,
			highlights: [
				create(FindHighlightSchema, {
					row: 2,
					startColumn: 4,
					endColumn: 9,
					current: true,
				}),
			],
		});
		expect(
			terminalFindHighlightBoxes(find, { cellWidth: 8, rowHeight: 18 }),
		).toEqual([
			{ key: "2:4", left: 32, top: 36, width: 40, height: 18, current: true },
		]);
		expect(terminalFindHighlightBoxes(find, null)).toEqual([]);
		expect(
			terminalFindHighlightBoxes(undefined, { cellWidth: 8, rowHeight: 18 }),
		).toEqual([]);
	});
});
