// `dure feedback` — the I/O half. Envelope assembly and the wire's caps live
// in ./contracts/feedback-envelope.mjs (pure, no I/O); everything here reads
// argv, the environment, stdin/stdout, the filesystem or the network, and
// every one of those reads is an injectable parameter with a real default so
// this module is exercised in tests without a subprocess.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, release as osRelease, tmpdir, type as osType } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
	buildFeedbackEnvelope,
	FEEDBACK_ENDPOINT_DEFAULT,
	isValidFeedbackDevice,
} from "./contracts/feedback-envelope.mjs";
import { parseOpts } from "./cli-options.mjs";
import { cliPackageVersion } from "./runtime-diagnostics.mjs";
import { readUtf8Input } from "./text-input.mjs";

/** The values `dure feedback --kind` accepts. Narrower than the wire's own
 *  `FEEDBACK_KINDS` (which also has "crash") — a crash report is meant to
 *  come from automated reporting with its own attachment, not a value a
 *  person picks by hand on this path. */
export const FEEDBACK_CLI_KINDS = Object.freeze(["bug", "idea", "other"]);

/** A token that reads as a flag rather than a word — one or two leading
 *  dashes followed by a letter. Narrow on purpose: a bare "-" and "-5" (as
 *  in "dropped to -5 fps") do not match, and must pass through as ordinary
 *  text, never as something this command second-guesses. */
const FEEDBACK_FLAG_SHAPE = /^--?[A-Za-z]/;

/** The complete, closed set of options `dure feedback` accepts. Nothing
 *  else is ever an option, regardless of where it appears — see
 *  `classifyFeedbackArgs`'s doc comment for why this had to become a
 *  closed set rather than a positional rule. */
const FEEDBACK_OWN_FLAGS = new Set(["--kind", "--contact", "--json", "--yes", "--help", "-h"]);

/** The two of `FEEDBACK_OWN_FLAGS` that consume the next argv token as
 *  their value. That next token is never re-examined — it is skipped
 *  whole, whatever it looks like (`--contact -x` takes `-x` as the
 *  contact verbatim, matching `parseOpts` exactly). */
const FEEDBACK_VALUE_TAKING_FLAGS = new Set(["--kind", "--contact"]);

/**
 * History of this function, because the same class of bug reached it three
 * times:
 *
 * Round 1 allow-listed nothing — it rejected any `--`-prefixed token not in
 * a fixed list of feedback's own flags, checked anywhere in the sentence.
 * Round 2 replaced that with a purely positional rule ("options before the
 * text") because the allow-list let feedback's *own* flags — `--contact`,
 * `--kind` — through unconditionally, and `parseOpts` does not care where a
 * recognized flag sits: "the --contact flag doesnt work" had `--contact`
 * consume "flag" as its value mid-sentence, no error, silently truncating
 * the body. But round 2's positional rule then trusted *any* flag-shaped
 * token before the first positional word as an option — including one
 * `parseOpts` itself recognizes as *value-taking* for some other command
 * (`--branch`, `--app`, `--title`, `-p`, `-a`, …). `["--branch", "is",
 * "broken"]` classified as `ok`, while the real `parseOpts` silently
 * consumed "is" as `--branch`'s value, sending just "broken".
 *
 * Both rounds were reconciling two independently-maintained grammars — this
 * hand-written scan, and the shared `parseOpts` — by hand, one failing case
 * at a time. That is structural, not a series of unrelated bugs, so this
 * version closes it two ways instead of adding a third case:
 *
 * 1. The only options `dure feedback` accepts are `FEEDBACK_OWN_FLAGS` —
 *    a closed set, not "anything flag-shaped". Before the first literal
 *    `--`, any flag-shaped token that is *not* in that set is an error
 *    wherever it appears, first word included — there is no more "before
 *    the first positional word is automatically safe". An own flag found
 *    *after* the first positional word remains an error too, exactly as
 *    round 2 established (`--contact` mid-sentence is still rejected).
 * 2. A backstop, for whatever divergence neither round anticipated: the
 *    tokens this scan believes are the feedback text must exactly equal
 *    `parseOpts(rawArgs).rest` — the real answer, from the real shared
 *    parser. Any disagreement fails loudly (`{outcome: "error"}`, no
 *    specific token to blame) instead of silently sending a shortened
 *    report. This makes a *future* divergence between the two grammars a
 *    visible error the day it's introduced, not a fourth silent-corruption
 *    incident to be found by reproducing a support report.
 *
 * A literal `--` always ends option scanning from that point on, whether
 * or not a positional word has already appeared — the rest of the argv is
 * unconditionally text, exactly as `parseOpts` itself already treats it
 * (including a second literal `--`, which becomes ordinary text too).
 *
 * This must run against the RAW pre-parse argv tokens for the scan itself:
 * by the time `parseOpts` has produced `opts.rest`, the evidence (the
 * swallowed flag and its value) is already gone. The agreement check calls
 * `parseOpts` separately, on the same raw tokens, specifically to compare
 * against what the scan concluded.
 *
 * Returns `{outcome: "help"}` (`--help`/`-h` found while still in the
 * options region), `{outcome: "error", token}` (a disallowed or misplaced
 * flag-shaped token — `token` is the offending one), `{outcome: "error"}`
 * with no `token` (the agreement backstop tripped), or `{outcome: "ok"}`.
 */
export function classifyFeedbackArgs(rawArgs, { parseOptsImpl = parseOpts } = {}) {
	const separatorIndex = rawArgs.indexOf("--");
	const scanned = separatorIndex === -1 ? rawArgs : rawArgs.slice(0, separatorIndex);
	const afterSeparator = separatorIndex === -1 ? [] : rawArgs.slice(separatorIndex + 1);
	let sawPositionalWord = false;
	const text = [];
	for (let i = 0; i < scanned.length; i++) {
		const token = scanned[i];
		if (FEEDBACK_FLAG_SHAPE.test(token)) {
			if (!FEEDBACK_OWN_FLAGS.has(token) || sawPositionalWord) {
				return { outcome: "error", token };
			}
			if (token === "--help" || token === "-h") {
				return { outcome: "help" };
			}
			if (FEEDBACK_VALUE_TAKING_FLAGS.has(token)) {
				i++; // Skip the value whole — never re-examined, never text.
			}
			continue;
		}
		sawPositionalWord = true;
		text.push(token);
	}
	const scannedText = [...text, ...afterSeparator];
	const parsedRest = parseOptsImpl(rawArgs).rest;
	const agrees =
		scannedText.length === parsedRest.length &&
		scannedText.every((value, index) => value === parsedRest[index]);
	if (!agrees) {
		return { outcome: "error" };
	}
	return { outcome: "ok" };
}

/** The one place the `--json` decision is made for every failure exit —
 *  every non-zero return path routes its message through this. */
export function formatFeedbackError(message, json) {
	return json ? `${JSON.stringify({ error: message })}\n` : `${message}\n`;
}

// The CLI entry script, which is what identifies the running build: an
// installed channel keeps `install.json` a level above it, a source checkout
// keeps `cli/package.json` beside it.
const CLI_ENTRY_PATH = fileURLToPath(new URL("../dure.mjs", import.meta.url));
const FEEDBACK_DEVICE_ID_FILE = "feedback-device-id";
// Sized well above the wire's 8000-character body cap (worst case ~32 KiB
// of UTF-8) with headroom, matching the default readUtf8Input already uses
// for `dure send --stdin`.
const STDIN_MAX_BYTES = 64 * 1024;

export class FeedbackUsageError extends Error {
	constructor(message) {
		super(message);
		this.name = "FeedbackUsageError";
	}
}

/** This CLI's own version — the value sent as `env.app` on a feedback report
 *  and recorded as `cliVersion` on a skill receipt.
 *
 *  This used to read `cli/package.json` directly, on the reasoning that the
 *  install/source identity resolution `dure version` uses was heavier than
 *  needed. That was wrong, and silently so: the manifest is not shipped into
 *  an installed channel, so every real install reported "unknown" while the
 *  repository and every test reported the true version. Resolving both
 *  layouts is not an extra; it is the only way to answer at all. See #923. */
export function readCliVersion(scriptPath = CLI_ENTRY_PATH) {
	return cliPackageVersion(scriptPath);
}

/** Node-only, so this never matches the app's own native OS string (which
 *  reads the real macOS/Windows version). `os.type()` already reads better
 *  than `process.platform`'s bare "darwin"/"win32"; pairing it with
 *  `os.release()` (the kernel version) gives a human a specific string to
 *  triage against without shelling out. */
export function humanOperatingSystem(platform = process.platform, release = osRelease()) {
	const names = { darwin: "macOS", linux: "Linux", win32: "Windows" };
	const label = names[platform] ?? osType();
	return release ? `${label} ${release}` : label;
}

/** Reads the OS locale the way a terminal environment actually carries it —
 *  `LC_ALL` first (POSIX's own override order), then `LC_MESSAGES`, then
 *  `LANG`/`LANGUAGE`. Falls back to a stable literal rather than "" so a
 *  missing locale env var never renders as a blank table cell. */
export function resolveFeedbackLocale(environment = process.env) {
	const raw =
		environment.LC_ALL ||
		environment.LC_MESSAGES ||
		environment.LANG ||
		environment.LANGUAGE ||
		"";
	const normalized = raw.split(".")[0].replaceAll("_", "-").trim();
	return normalized.length > 0 ? normalized : "en-US";
}

/** `<columns>x<rows>` when the terminal reports a size, else the literal
 *  "headless" — there is no window to describe from a shell. */
export function resolveFeedbackWindow(columns, rows) {
	return Number.isInteger(columns) && Number.isInteger(rows) && columns > 0 && rows > 0
		? `${columns}x${rows}`
		: "headless";
}

function resolveDureHome(environment) {
	return environment.DURE_HOME || join(homedir(), ".dure");
}

/**
 * Reads the persisted device id, or generates and persists one. Generated
 * with `crypto.randomUUID()`, whose output (lowercase hex and hyphens) is
 * always within the wire's `[A-Za-z0-9._:-]` device charset.
 *
 * The persisted value is validated against that same charset/length rule
 * before being trusted: a corrupted file (truncated write, manual edit, a
 * stray byte) would otherwise be reused forever and get every single
 * submission rejected with a 400 "invalid device" — regenerating instead
 * self-heals on the next call.
 *
 * Persistence is best-effort: if `~/.dure` cannot be created or written (a
 * read-only home, for example), the generated id is still returned so
 * sending the report is never blocked on it — it simply will not be reused
 * next time.
 */
export function loadOrCreateFeedbackDeviceId({
	environment = process.env,
	randomUUIDImpl = randomUUID,
} = {}) {
	const dureHome = resolveDureHome(environment);
	const filePath = join(dureHome, FEEDBACK_DEVICE_ID_FILE);
	try {
		const existing = readFileSync(filePath, "utf8").trim();
		if (isValidFeedbackDevice(existing)) return existing;
	} catch {
		// No file yet (or unreadable) — generate one below.
	}
	const id = randomUUIDImpl();
	try {
		mkdirSync(dureHome, { recursive: true, mode: 0o700 });
		writeFileSync(filePath, `${id}\n`, { mode: 0o600 });
	} catch {
		// Best-effort persistence — see the doc comment above.
	}
	return id;
}

/**
 * One rule, no ambiguity: positional text wins; otherwise stdin when it is
 * not a TTY; otherwise `$EDITOR` when both stdin and stdout are TTYs;
 * otherwise a usage failure. The agent path (arguments or a pipe) is
 * therefore never interactive, and the editor path is only ever reached
 * when a person is actually at a terminal.
 */
export function resolveFeedbackText({
	positionalText,
	stdinIsTTY,
	stdoutIsTTY,
	readStdin,
	openEditor,
}) {
	if (typeof positionalText === "string" && positionalText.length > 0) {
		return { text: positionalText, source: "arguments" };
	}
	if (!stdinIsTTY) {
		return { text: readStdin(), source: "stdin" };
	}
	if (stdoutIsTTY) {
		return { text: openEditor(), source: "editor" };
	}
	throw new FeedbackUsageError(
		"No feedback text given. Pass it as arguments, pipe it via stdin, or run in an interactive terminal to compose it in $EDITOR.",
	);
}

export function readFeedbackStdin() {
	return readUtf8Input(0, STDIN_MAX_BYTES);
}

/** Opens `$EDITOR` on an empty temp file and returns what was saved.
 *  `$EDITOR` may itself carry arguments (e.g. "code --wait"), split on
 *  whitespace the same way a shell alias would. */
export function openFeedbackEditor({
	environment = process.env,
	spawnSyncImpl = spawnSync,
} = {}) {
	const editor = environment.EDITOR?.trim();
	if (!editor) {
		throw new FeedbackUsageError(
			"No $EDITOR is set. Pass feedback text as arguments, pipe it via stdin, or set $EDITOR.",
		);
	}
	const directory = mkdtempSync(join(tmpdir(), "dure-feedback-"));
	const file = join(directory, "FEEDBACK.txt");
	writeFileSync(file, "");
	try {
		const [command, ...editorArgs] = editor.split(/\s+/);
		const result = spawnSyncImpl(command, [...editorArgs, file], {
			stdio: "inherit",
		});
		if (result.error) {
			throw new FeedbackUsageError(
				`Could not launch $EDITOR (${editor}): ${result.error.message}`,
			);
		}
		// A killed editor (e.g. Ctrl+C) reports `status: null` and `signal` set
		// instead — without this check that falls through to reading whatever
		// partial content happened to be on disk and treating it as a
		// deliberate save.
		if (result.signal) {
			throw new FeedbackUsageError(`$EDITOR was interrupted by signal ${result.signal}.`);
		}
		if (typeof result.status === "number" && result.status !== 0) {
			throw new FeedbackUsageError(`$EDITOR exited with status ${result.status}.`);
		}
		return readFileSync(file, "utf8");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/**
 * Posts one envelope and maps the intake's response to a typed outcome,
 * mirroring src/lib/ipc/feedback.ts's own distinctions exactly: 400/413 are
 * permanent rejections (retrying the same payload cannot help — 413 also
 * carries the wire field that was too large), 429 is a rate limit, 503 (or
 * any other unexpected status) is temporary, and a transport failure is its
 * own case. The CLI collapses all four into one non-zero exit code, but the
 * message always says which one happened.
 */
export async function postFeedback(envelope, { fetchImpl = globalThis.fetch, endpoint } = {}) {
	let response;
	try {
		response = await fetchImpl(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(envelope),
		});
	} catch (error) {
		return {
			ok: false,
			kind: "network",
			message: `Feedback request failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	if (response.status === 201) {
		const data = await response.json().catch(() => null);
		if (typeof data?.id === "string" && data.id.length > 0) {
			return { ok: true, reference: data.id };
		}
		return {
			ok: false,
			kind: "temporary",
			message: "Feedback accepted but no reference was returned.",
		};
	}
	if (response.status === 400) {
		const data = await response.json().catch(() => null);
		const detail = typeof data?.message === "string" ? data.message : undefined;
		return {
			ok: false,
			kind: "rejected",
			message: detail ? `Feedback rejected: ${detail}` : "Feedback rejected (400).",
		};
	}
	if (response.status === 413) {
		const data = await response.json().catch(() => null);
		const field = typeof data?.field === "string" ? data.field : undefined;
		return {
			ok: false,
			kind: "rejected",
			field,
			message: field
				? `Feedback rejected: ${field} too large.`
				: "Feedback rejected (413).",
		};
	}
	if (response.status === 429) {
		return {
			ok: false,
			kind: "rate_limited",
			message: "Feedback rate limited. Try again later.",
		};
	}
	return {
		ok: false,
		kind: "temporary",
		message: `Feedback temporarily unavailable (${response.status}).`,
	};
}

/** Renders exactly what will travel with the report: the body, the device
 *  id (the one value that persists across submissions — the app's own
 *  preview, src/lib/feedback/feedbackPreview.ts, renders the whole
 *  envelope including it), and the six environment values, plus
 *  kind/contact for full disclosure. The app shows the user exactly what
 *  it will send, and this command must not be quieter about it. */
export function renderFeedbackPreview(envelope) {
	const envLines = ["app", "channel", "os", "arch", "locale", "window"]
		.map((name) => `  ${name}: ${envelope.env[name]}`)
		.join("\n");
	return [
		`Kind: ${envelope.kind}`,
		envelope.contact ? `Contact: ${envelope.contact}` : "Contact: (none)",
		`Device: ${envelope.device}`,
		"Body:",
		envelope.body,
		"",
		"Environment:",
		envLines,
	].join("\n");
}

export async function promptFeedbackConfirmation(
	input,
	output,
	question = "Send this feedback? [y/N] ",
) {
	const rl = createInterface({ input, output });
	try {
		const answer = await rl.question(question);
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

/**
 * Runs the full command: resolves input text, assembles the envelope,
 * confirms interactively when required, sends it, and returns the process
 * exit code (0 success, 2 usage error, 1 send failure) — it never calls
 * `process.exit` itself, so it can be exercised in-process in tests.
 *
 * Every dependency that touches the outside world is overridable through
 * `overrides`, defaulting to the real thing.
 */
export async function runFeedbackCommand(opts, overrides = {}) {
	const environment = overrides.environment ?? process.env;
	const fetchImpl = overrides.fetchImpl ?? globalThis.fetch;
	const stdout = overrides.stdout ?? process.stdout;
	const stderr = overrides.stderr ?? process.stderr;
	const stdin = overrides.stdin ?? process.stdin;
	const stdinIsTTY = overrides.stdinIsTTY ?? Boolean(stdin.isTTY);
	const stdoutIsTTY = overrides.stdoutIsTTY ?? Boolean(stdout.isTTY);
	const readStdin = overrides.readStdin ?? readFeedbackStdin;
	const openEditor = overrides.openEditor ?? (() => openFeedbackEditor({ environment }));
	const confirm =
		overrides.confirm ?? ((question) => promptFeedbackConfirmation(stdin, stdout, question));
	const randomUUIDImpl = overrides.randomUUIDImpl ?? randomUUID;
	const endpoint =
		overrides.endpoint ?? environment.DURE_FEEDBACK_ENDPOINT ?? FEEDBACK_ENDPOINT_DEFAULT;

	// Every failure exit routes through this one call so the --json decision
	// is made in exactly one place, not re-decided at each return site.
	const fail = (message) => stderr.write(formatFeedbackError(message, opts.json));

	const kind = opts.kind ?? "bug";
	if (!FEEDBACK_CLI_KINDS.includes(kind)) {
		fail(`Unknown --kind "${kind}". Use one of: ${FEEDBACK_CLI_KINDS.join(", ")}.`);
		return 2;
	}

	const positionalText = Array.isArray(opts.rest) ? opts.rest.join(" ") : "";
	let resolved;
	try {
		resolved = resolveFeedbackText({
			positionalText,
			stdinIsTTY,
			stdoutIsTTY,
			readStdin,
			openEditor,
		});
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
		return 2;
	}

	let envelope;
	try {
		envelope = buildFeedbackEnvelope({
			kind,
			body: resolved.text,
			contact: opts.contact,
			env: {
				app: readCliVersion(),
				channel: "cli",
				os: humanOperatingSystem(),
				arch: process.arch,
				locale: resolveFeedbackLocale(environment),
				window: resolveFeedbackWindow(stdout.columns, stdout.rows),
			},
			device: loadOrCreateFeedbackDeviceId({ environment, randomUUIDImpl }),
		});
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
		return 2;
	}

	// Only the editor path is ever interactive — arguments and stdin are
	// always the agent path (see resolveFeedbackText's doc comment) — so
	// `--yes` only ever needs to skip a prompt that would otherwise appear.
	const interactive = resolved.source === "editor";
	if (interactive && !opts.yes) {
		stdout.write(`${renderFeedbackPreview(envelope)}\n\n`);
		const confirmed = await confirm("Send this feedback? [y/N] ");
		if (!confirmed) {
			fail("Feedback not sent.");
			return 1;
		}
	}

	const outcome = await postFeedback(envelope, { fetchImpl, endpoint });
	if (!outcome.ok) {
		fail(outcome.message);
		return 1;
	}

	if (opts.json) {
		stdout.write(`${JSON.stringify({ reference: outcome.reference })}\n`);
	} else {
		stdout.write(`${outcome.reference}\n`);
	}
	return 0;
}
