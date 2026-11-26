// Links a person can open from plain terminal text: http(s) URLs and file
// paths with an optional line. Detection reads one logical line of the Host's
// viewport frame; routing decides where the link opens from the pane's own
// backend. Kept pure so vitest can drive real terminal output.

import type {
	TerminalRow,
	TerminalTables,
} from "@/contracts/terminalStateProtocol";
import { isMachineLocalUrl } from "@/lib/browser/browserAddress";
import type { FileTarget } from "@/lib/files/fileTarget";
import type { DesktopPlatform } from "@/lib/workspace/desktop/desktopPlatform";

/** `start` and `end` are UTF-16 offsets into the logical line, end exclusive. */
export type TerminalTextLink =
	| {
			readonly kind: "url";
			readonly url: string;
			readonly start: number;
			readonly end: number;
	  }
	| {
			readonly kind: "path";
			readonly path: string;
			readonly line?: number;
			readonly column?: number;
			readonly start: number;
			readonly end: number;
	  };

/** Where an activated link goes. A file opens in the file viewer on the
 * pane's backend, and an address that names the machine an SSH-backed pane
 * runs on opens in the Browser on that Host. Everything else goes to the
 * operating system. */
export type TerminalLinkDestination =
	| { readonly kind: "external_url"; readonly url: string }
	| {
			readonly kind: "host_browser";
			readonly url: string;
			readonly hostId: string;
	  }
	| { readonly kind: "external_path"; readonly path: string }
	| {
			readonly kind: "file";
			readonly target: FileTarget;
			readonly reveal?: { readonly line: number; readonly column?: number };
	  };

export interface TerminalLinkContext {
	/** The backend the pane's session runs on. */
	readonly backend:
		| { readonly source: "local" }
		| { readonly source: "ssh"; readonly hostId: string };
	/** The session is inside an `ssh` hop it started itself: the paths it
	 * prints name files on that other machine, not on the pane's backend. */
	readonly nestedRemote: boolean;
	/** The session's working folder, against which relative paths resolve. */
	readonly workingDirectory?: string;
	/** The local home folder, for `~/` in a local pane. An SSH Host's shell
	 * expands a leading `~/` itself, so remote paths keep it. */
	readonly homeDirectory?: string;
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/gi;
/** Characters that end a path token: whitespace, quotes, angle brackets,
 * pipes and `=` (as in `--config=path`). */
const PATH_BOUNDARY = /[\s"'`<>|=]/;
const TRAILING_PUNCTUATION = ".,;:!?";
const CLOSERS: Readonly<Record<string, string>> = {
	")": "(",
	"]": "[",
	"}": "{",
};
const LEADING_OPENERS = "([{";
/** `path:line[:col]` or the `path(line[,col])` form TypeScript prints. The
 * suffix must end the token or precede another `:` (grep's `path:12:text`). */
const LOCATION_SUFFIX =
	/^(.+?)(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\))(?=$|:)/;
const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const FILE_EXTENSION = /\.[A-Za-z0-9_-]*[A-Za-z][A-Za-z0-9_-]*$/;
const EMAIL = /^[^/\\@]+@[^/\\@]+\.[A-Za-z]+$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** The link in `text` that covers the UTF-16 offset `index`, if any. */
export function terminalTextLinkAt(
	text: string,
	index: number,
): TerminalTextLink | null {
	if (index < 0 || index >= text.length) return null;
	for (const match of text.matchAll(URL_PATTERN)) {
		const start = match.index ?? 0;
		const url = match[0].slice(0, trimmedEnd(match[0]));
		if (index >= start && index < start + url.length) {
			return { kind: "url", url, start, end: start + url.length };
		}
	}
	return pathLinkAt(text, index);
}

/** Reads the logical line under one viewport cell and returns the link it
 * covers. A cell that carries an OSC 8 hyperlink belongs to that anchor, so
 * plain-text detection never competes with it. */
export function terminalViewportLinkAt(
	rows: readonly TerminalRow[],
	tables: TerminalTables,
	rowIndex: number,
	column: number,
): TerminalTextLink | null {
	const row = rows[rowIndex];
	if (!row || column < 0) return null;
	let first = rowIndex;
	while (first > 0 && rows[first - 1]?.logicalLineId === row.logicalLineId) {
		first -= 1;
	}
	let text = "";
	let clicked: number | undefined;
	for (let index = first; index < rows.length; index += 1) {
		const current = rows[index];
		if (!current || current.logicalLineId !== row.logicalLineId) break;
		let cellColumn = 0;
		for (const cell of current.cells) {
			const grapheme = tables.graphemes[cell.graphemeIndex];
			if (!grapheme || grapheme.displayWidth === 0) continue;
			if (
				index === rowIndex &&
				column >= cellColumn &&
				column < cellColumn + grapheme.displayWidth
			) {
				if ((tables.styles[cell.styleIndex]?.hyperlinkIndex ?? 0) !== 0) {
					return null;
				}
				clicked = text.length;
			}
			text += grapheme.text || " ".repeat(grapheme.displayWidth);
			cellColumn += grapheme.displayWidth;
		}
	}
	return clicked === undefined ? null : terminalTextLinkAt(text, clicked);
}

/** Cmd-click on macOS, Ctrl-click on Windows and Linux. Shift may be held to
 * send the link to the operating system instead. */
export function isTerminalLinkGesture(
	event: {
		readonly button: number;
		readonly metaKey: boolean;
		readonly ctrlKey: boolean;
		readonly altKey: boolean;
	},
	platform: DesktopPlatform,
): boolean {
	if (event.button !== 0 || event.altKey) return false;
	return platform === "macos"
		? event.metaKey && !event.ctrlKey
		: event.ctrlKey && !event.metaKey;
}

/** The absolute path a link names on the pane's backend, or null when a
 * relative path has no working folder to resolve against. */
export function resolveTerminalLinkPath(
	path: string,
	context: Pick<
		TerminalLinkContext,
		"backend" | "workingDirectory" | "homeDirectory"
	>,
): string | null {
	if (path.startsWith("~/")) {
		if (context.backend.source === "ssh") return path;
		return context.homeDirectory
			? joinPath(context.homeDirectory, path.slice(2))
			: null;
	}
	if (path.startsWith("/") || WINDOWS_ROOT.test(path)) {
		return normalizePath(path);
	}
	return context.workingDirectory
		? joinPath(context.workingDirectory, path)
		: null;
}

/** Routes one activated link. Shift sends it to the operating system where
 * the operating system can open it: URLs and local files. */
export function terminalLinkDestination(
	link: TerminalTextLink,
	context: TerminalLinkContext,
	options: { readonly external: boolean },
): TerminalLinkDestination | null {
	if (link.kind === "url") {
		if (!isHttpUrl(link.url)) return null;
		// `localhost` printed on an SSH Host names that Host, not this computer.
		return context.backend.source === "ssh" &&
			!context.nestedRemote &&
			!options.external &&
			isMachineLocalUrl(link.url)
			? {
					kind: "host_browser",
					url: link.url,
					hostId: context.backend.hostId,
				}
			: { kind: "external_url", url: link.url };
	}
	if (context.nestedRemote) return null;
	const path = resolveTerminalLinkPath(link.path, context);
	if (!path) return null;
	if (options.external && context.backend.source === "local") {
		return { kind: "external_path", path };
	}
	const target: FileTarget =
		context.backend.source === "ssh"
			? { path, source: "ssh", hostId: context.backend.hostId }
			: { path, source: "local" };
	return link.line === undefined
		? { kind: "file", target }
		: {
				kind: "file",
				target,
				reveal:
					link.column === undefined
						? { line: link.line }
						: { line: link.line, column: link.column },
			};
}

function pathLinkAt(text: string, index: number): TerminalTextLink | null {
	if (PATH_BOUNDARY.test(text[index] ?? " ")) return null;
	let tokenStart = index;
	while (tokenStart > 0 && !PATH_BOUNDARY.test(text[tokenStart - 1] ?? " ")) {
		tokenStart -= 1;
	}
	let tokenEnd = index + 1;
	while (tokenEnd < text.length && !PATH_BOUNDARY.test(text[tokenEnd] ?? " ")) {
		tokenEnd += 1;
	}
	let token = text.slice(tokenStart, tokenEnd);
	while (token && LEADING_OPENERS.includes(token[0] ?? "")) {
		token = token.slice(1);
		tokenStart += 1;
	}
	token = token.slice(0, trimmedEnd(token));
	if (!token) return null;
	const located = LOCATION_SUFFIX.exec(token);
	const path = located ? (located[1] ?? "") : token;
	const lineText = located?.[2] ?? located?.[4];
	const columnText = located?.[3] ?? located?.[5];
	const end = tokenStart + (located ? located[0].length : token.length);
	if (index < tokenStart || index >= end) return null;
	const line = lineText === undefined ? undefined : Number(lineText);
	const column = columnText === undefined ? undefined : Number(columnText);
	if (line === 0 || !looksLikePath(path, line !== undefined)) return null;
	return {
		kind: "path",
		path,
		...(line === undefined ? {} : { line }),
		...(column === undefined || column === 0 ? {} : { column }),
		start: tokenStart,
		end,
	};
}

/** A bare word is not a path. A token with a line suffix needs a folder or a
 * file extension; without one it needs an extension or an explicit root. */
function looksLikePath(path: string, hasLine: boolean): boolean {
	if (!path || SCHEME.test(path) || EMAIL.test(path)) return false;
	const segments = path.split(/[\\/]/).filter(Boolean);
	const last = segments[segments.length - 1];
	if (!last || /^\.+$/.test(last)) return false;
	const extension = FILE_EXTENSION.test(last);
	if (extension) return true;
	if (hasLine) return segments.length > 1;
	return (
		segments.length > 1 &&
		(path.startsWith("/") ||
			path.startsWith("./") ||
			path.startsWith("../") ||
			path.startsWith("~/") ||
			WINDOWS_ROOT.test(path))
	);
}

/** Drops trailing sentence punctuation and closing brackets the link does not
 * open itself, as in `(see src/a.ts:3).` */
function trimmedEnd(text: string): number {
	let end = text.length;
	while (end > 0) {
		const last = text[end - 1] ?? "";
		if (TRAILING_PUNCTUATION.includes(last)) {
			end -= 1;
			continue;
		}
		const opener = CLOSERS[last];
		if (opener) {
			const head = text.slice(0, end);
			if (count(head, opener) < count(head, last)) {
				end -= 1;
				continue;
			}
		}
		break;
	}
	return end;
}

function count(text: string, character: string): number {
	let total = 0;
	for (const current of text) if (current === character) total += 1;
	return total;
}

function isHttpUrl(value: string): boolean {
	try {
		const protocol = new URL(value).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

function joinPath(base: string, relative: string): string {
	const separator = WINDOWS_ROOT.test(base) ? "\\" : "/";
	return normalizePath(`${base}${separator}${relative}`);
}

/** Resolves `.` and `..` so one file keeps one document identity. */
function normalizePath(path: string): string {
	const windows = WINDOWS_ROOT.test(path);
	const separator = windows ? "\\" : "/";
	const parts = path.split(windows ? /[\\/]+/ : /\/+/);
	const root = windows
		? path.startsWith("\\\\")
			? "\\\\"
			: `${parts.shift() ?? ""}\\`
		: "/";
	const resolved: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") resolved.pop();
		else resolved.push(part);
	}
	return root + resolved.join(separator);
}
