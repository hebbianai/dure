import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CellStyleSchema,
	GraphemeSchema,
	HyperlinkSchema,
	RowTermination,
	TerminalCellSchema,
	TerminalRowSchema,
	TerminalTablesSchema,
} from "@/contracts/terminalStateProtocol";
import {
	isTerminalLinkGesture,
	resolveTerminalLinkPath,
	type TerminalLinkContext,
	terminalLinkDestination,
	terminalTextLinkAt,
	terminalViewportLinkAt,
} from "./terminalLinks";

/** The link under the first occurrence of `needle` in `text`. */
function linkAt(text: string, needle: string, offset = 0) {
	const index = text.indexOf(needle);
	if (index < 0) throw new Error(`${needle} not in ${text}`);
	return terminalTextLinkAt(text, index + offset);
}

describe("terminal text links", () => {
	it("finds an http(s) URL under the pointer and drops sentence punctuation", () => {
		const text = "Local: http://localhost:5173/app. Ready";
		expect(linkAt(text, "localhost")).toEqual({
			kind: "url",
			url: "http://localhost:5173/app",
			start: 7,
			end: 32,
		});
		expect(linkAt(text, "Ready")).toBeNull();
	});

	it("keeps balanced brackets in a URL and drops the ones that close prose", () => {
		expect(
			linkAt("see https://en.wikipedia.org/wiki/Tree_(graph)", "wiki"),
		).toMatchObject({ url: "https://en.wikipedia.org/wiki/Tree_(graph)" });
		expect(
			linkAt("[docs](https://example.com/guide)", "example"),
		).toMatchObject({ url: "https://example.com/guide" });
	});

	it("reads path:line:col, path:line and the TypeScript path(line,col) form", () => {
		expect(linkAt("  --> src/main.rs:12:5", "main")).toEqual({
			kind: "path",
			path: "src/main.rs",
			line: 12,
			column: 5,
			start: 6,
			end: 22,
		});
		expect(linkAt("./main.go:7: undefined: x", "main")).toMatchObject({
			path: "./main.go",
			line: 7,
		});
		expect(linkAt("src/app.ts(41,9): error TS2322", "app")).toMatchObject({
			path: "src/app.ts",
			line: 41,
			column: 9,
		});
	});

	it("ends the link at grep's line number, before the matched text", () => {
		const text = "src/lib/a.ts:30:const value = 1";
		expect(linkAt(text, "a.ts")).toMatchObject({
			path: "src/lib/a.ts",
			line: 30,
			end: 15,
		});
		expect(linkAt(text, "const")).toBeNull();
	});

	it("strips the brackets and quotes around a path", () => {
		expect(linkAt("(see src/a.ts:3).", "src")).toMatchObject({
			path: "src/a.ts",
			line: 3,
		});
		expect(linkAt('File "/srv/app/main.py", line 4', "main")).toMatchObject({
			path: "/srv/app/main.py",
		});
		expect(linkAt("app/(marketing)/page.tsx:2", "page")).toMatchObject({
			path: "app/(marketing)/page.tsx",
			line: 2,
		});
	});

	it("accepts file names, rooted paths and Windows paths", () => {
		expect(linkAt("edit README.md first", "README")).toMatchObject({
			path: "README.md",
		});
		expect(linkAt("cat /etc/hosts", "hosts")).toMatchObject({
			path: "/etc/hosts",
		});
		expect(linkAt("saved ~/Desktop/shot.png", "shot")).toMatchObject({
			path: "~/Desktop/shot.png",
		});
		expect(linkAt("C:\\work\\app\\main.ts:3:1 error", "main")).toMatchObject({
			path: "C:\\work\\app\\main.ts",
			line: 3,
			column: 1,
		});
	});

	it("does not treat words, numbers, hosts or addresses as paths", () => {
		for (const [text, needle] of [
			["read and/or write", "and"],
			["took 1/2 of the time", "1/2"],
			["listening on localhost:3000", "localhost"],
			["bound to 127.0.0.1:8080", "127"],
			["version v1.2.3", "v1"],
			["mail me@example.com", "me@"],
			["config --out=", "out"],
			["dir src/components/", "components"],
		] as const) {
			expect(linkAt(text, needle), text).toBeNull();
		}
	});

	it("ignores line zero and keeps a path without a column", () => {
		expect(linkAt("src/a.ts:0", "src")).toBeNull();
		expect(linkAt("src/a.ts:4:0", "src")).toEqual({
			kind: "path",
			path: "src/a.ts",
			line: 4,
			start: 0,
			end: 12,
		});
	});
});

const graphemes = [..."ab src/x.ts:3 cd界"].map((text) =>
	create(GraphemeSchema, { text, displayWidth: text === "界" ? 2 : 1 }),
);
const tables = create(TerminalTablesSchema, {
	graphemes,
	styles: [
		create(CellStyleSchema),
		create(CellStyleSchema, { hyperlinkIndex: 1 }),
	],
	hyperlinks: [create(HyperlinkSchema, { uri: "https://example.com/" })],
});
const cells = (from: number, to: number, styleIndex = 0) =>
	Array.from({ length: to - from }, (_, offset) =>
		create(TerminalCellSchema, { graphemeIndex: from + offset, styleIndex }),
	);

describe("terminal viewport links", () => {
	// "ab src/x.ts:3 cd界" soft-wrapped after "ab src/x", then a second line.
	const rows = [
		create(TerminalRowSchema, {
			rowId: 1n,
			logicalLineId: 5n,
			logicalCellOffset: 0,
			logicalCellSpan: 8,
			cells: cells(0, 8),
			termination: RowTermination.SOFT_WRAP,
		}),
		create(TerminalRowSchema, {
			rowId: 2n,
			logicalLineId: 5n,
			logicalCellOffset: 8,
			logicalCellSpan: 10,
			continuesFromPrevious: true,
			cells: cells(8, 17),
			termination: RowTermination.HARD_BREAK,
		}),
		create(TerminalRowSchema, {
			rowId: 3n,
			logicalLineId: 6n,
			logicalCellOffset: 0,
			logicalCellSpan: 2,
			cells: cells(0, 2, 1),
			termination: RowTermination.HARD_BREAK,
		}),
	];

	it("joins a soft-wrapped path and finds it from either physical row", () => {
		const expected = { kind: "path", path: "src/x.ts", line: 3 };
		expect(terminalViewportLinkAt(rows, tables, 0, 4)).toMatchObject(expected);
		expect(terminalViewportLinkAt(rows, tables, 1, 2)).toMatchObject(expected);
	});

	it("maps columns past a wide grapheme and outside the text to nothing", () => {
		expect(terminalViewportLinkAt(rows, tables, 1, 7)).toBeNull();
		expect(terminalViewportLinkAt(rows, tables, 1, 9)).toBeNull();
		expect(terminalViewportLinkAt(rows, tables, 1, 40)).toBeNull();
		expect(terminalViewportLinkAt(rows, tables, 9, 0)).toBeNull();
	});

	it("leaves a cell with an OSC 8 hyperlink to its anchor", () => {
		expect(terminalViewportLinkAt(rows, tables, 2, 0)).toBeNull();
	});
});

describe("terminal link gestures", () => {
	const pointer = {
		button: 0,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
	};

	it("uses Cmd on macOS and Ctrl elsewhere", () => {
		expect(isTerminalLinkGesture({ ...pointer, metaKey: true }, "macos")).toBe(
			true,
		);
		expect(isTerminalLinkGesture({ ...pointer, ctrlKey: true }, "macos")).toBe(
			false,
		);
		for (const platform of ["windows", "linux"] as const) {
			expect(
				isTerminalLinkGesture({ ...pointer, ctrlKey: true }, platform),
			).toBe(true);
			expect(
				isTerminalLinkGesture({ ...pointer, metaKey: true }, platform),
			).toBe(false);
		}
	});

	it("ignores plain, secondary-button and Alt clicks", () => {
		expect(isTerminalLinkGesture(pointer, "macos")).toBe(false);
		expect(
			isTerminalLinkGesture({ ...pointer, metaKey: true, button: 2 }, "macos"),
		).toBe(false);
		expect(
			isTerminalLinkGesture(
				{ ...pointer, metaKey: true, altKey: true },
				"macos",
			),
		).toBe(false);
	});
});

describe("terminal link paths", () => {
	const local = { backend: { source: "local" as const } };
	const remote = { backend: { source: "ssh" as const, hostId: "h1" } };

	it("resolves relative paths against the working folder", () => {
		expect(
			resolveTerminalLinkPath("../lib/a.ts", {
				...local,
				workingDirectory: "/repo/src/app/",
			}),
		).toBe("/repo/src/lib/a.ts");
		expect(
			resolveTerminalLinkPath("./a.ts", {
				...local,
				workingDirectory: "C:\\repo",
			}),
		).toBe("C:\\repo\\a.ts");
		expect(resolveTerminalLinkPath("a.ts", local)).toBeNull();
		expect(resolveTerminalLinkPath("/a/./b//c.ts", local)).toBe("/a/b/c.ts");
	});

	it("expands ~/ with the local home and leaves it to an SSH Host's shell", () => {
		expect(
			resolveTerminalLinkPath("~/n.md", {
				...local,
				homeDirectory: "/Users/me",
			}),
		).toBe("/Users/me/n.md");
		expect(resolveTerminalLinkPath("~/n.md", local)).toBeNull();
		expect(resolveTerminalLinkPath("~/n.md", remote)).toBe("~/n.md");
	});
});

describe("terminal link destinations", () => {
	const path = { kind: "path", path: "src/a.ts", start: 0, end: 8 } as const;
	const context: TerminalLinkContext = {
		backend: { source: "local" },
		nestedRemote: false,
		workingDirectory: "/repo",
	};
	const opened = { external: false };

	it("opens a path in the file viewer on the pane's backend at its line", () => {
		expect(
			terminalLinkDestination({ ...path, line: 9, column: 2 }, context, opened),
		).toEqual({
			kind: "file",
			target: { path: "/repo/src/a.ts", source: "local" },
			reveal: { line: 9, column: 2 },
		});
		expect(
			terminalLinkDestination(
				path,
				{ ...context, backend: { source: "ssh", hostId: "h1" } },
				opened,
			),
		).toEqual({
			kind: "file",
			target: { path: "/repo/src/a.ts", source: "ssh", hostId: "h1" },
		});
	});

	it("sends URLs, and local paths with Shift, to the operating system", () => {
		expect(
			terminalLinkDestination(
				{ kind: "url", url: "https://example.com/", start: 0, end: 20 },
				context,
				opened,
			),
		).toEqual({ kind: "external_url", url: "https://example.com/" });
		expect(terminalLinkDestination(path, context, { external: true })).toEqual({
			kind: "external_path",
			path: "/repo/src/a.ts",
		});
		expect(
			terminalLinkDestination(
				path,
				{ ...context, backend: { source: "ssh", hostId: "h1" } },
				{ external: true },
			),
		).toMatchObject({ kind: "file" });
	});

	it("does not open paths printed inside a nested ssh hop or without a folder", () => {
		expect(
			terminalLinkDestination(path, { ...context, nestedRemote: true }, opened),
		).toBeNull();
		expect(
			terminalLinkDestination(
				path,
				{ ...context, workingDirectory: undefined },
				opened,
			),
		).toBeNull();
	});
});
