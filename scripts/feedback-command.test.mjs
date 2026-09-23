import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildFeedbackEnvelope,
	FEEDBACK_BODY_LIMIT,
	FEEDBACK_CONTACT_LIMIT,
	FEEDBACK_DEVICE_LIMIT,
	FEEDBACK_ENDPOINT_DEFAULT,
	FeedbackEnvelopeError,
} from "../cli/lib/contracts/feedback-envelope.mjs";
import { parseOpts } from "../cli/lib/cli-options.mjs";
import {
	classifyFeedbackArgs,
	FEEDBACK_CLI_KINDS,
	FeedbackUsageError,
	humanOperatingSystem,
	loadOrCreateFeedbackDeviceId,
	openFeedbackEditor,
	postFeedback,
	readCliVersion,
	renderFeedbackPreview,
	resolveFeedbackLocale,
	resolveFeedbackWindow,
	resolveFeedbackText,
	runFeedbackCommand,
} from "../cli/lib/feedback-command.mjs";

const cli = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const cliPackageJsonPath = fileURLToPath(new URL("../cli/package.json", import.meta.url));
const cliPackageVersion = JSON.parse(readFileSync(cliPackageJsonPath, "utf8")).version;

const cleanups = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeWritable() {
	const chunks = [];
	return {
		chunks,
		write(chunk) {
			chunks.push(chunk);
			return true;
		},
		text: () => chunks.join(""),
	};
}

function baseEnv() {
	return {
		app: "1.2.3",
		channel: "cli",
		os: "macOS 24.5.0",
		arch: "arm64",
		locale: "en-US",
		window: "120x40",
	};
}

async function startFixtureServer(handler) {
	const requests = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		const payload = body.length > 0 ? JSON.parse(body) : null;
		requests.push({
			method: request.method,
			path: request.url,
			contentType: request.headers["content-type"],
			payload,
		});
		handler(response, payload);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => new Promise((resolve) => server.close(resolve)));
	const port = server.address().port;
	return { requests, endpoint: `http://127.0.0.1:${port}/v1/feedback` };
}

function tempHome() {
	const root = mkdtempSync(join(tmpdir(), "dure-feedback-cmd-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

// A deliberately unreachable address (nothing listens on port 1) for tests
// that expect the command to fail before ever reaching the network, or that
// otherwise don't care about a real response. Real reachability is never
// required to prove "nothing was sent" — a connection refusal proves it.
const UNREACHABLE_FEEDBACK_ENDPOINT = "http://127.0.0.1:1/v1/feedback";

/** Hostnames this test file will ever point a live `fetch` or a spawned
 *  `dure feedback` subprocess at. An allow-list, not a deny-list: round 2's
 *  guard was `endpoint.startsWith(new URL(FEEDBACK_ENDPOINT_DEFAULT).origin)`,
 *  a deny-list of exactly one spelling of the production host — case
 *  changes it, a trailing dot changes it, an explicit default port changes
 *  it, and every one of those still resolves to the same production
 *  server. A deny-list of spellings can always be bypassed by a spelling
 *  nobody listed; an allow-list of the only hosts that are ever actually
 *  safe (loopback) cannot be, because there is nothing to enumerate past. */
const ALLOWED_TEST_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Refuses any endpoint whose host is not loopback. Parses with `new URL`
 * (which lowercases the hostname and leaves a trailing dot or an explicit
 * default port visible) and checks the *hostname* against a closed
 * allow-list, so no spelling of the production host — any casing, a
 * trailing dot, an explicit `:443` — can pass, and neither can any other
 * public host. An unparseable string is refused too (the `new URL` call
 * itself throws). Called from every place in this file that could
 * otherwise hand a live `fetch` or a spawned CLI process a real network
 * target: `runCli`, `overrides()`, and each direct `postFeedback` call in
 * the "feedback wire POST" block below.
 */
function assertTestEndpoint(endpoint) {
	let url;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error(`assertTestEndpoint: "${endpoint}" is not a valid URL.`);
	}
	if (!ALLOWED_TEST_HOSTNAMES.has(url.hostname)) {
		throw new Error(
			`assertTestEndpoint: refusing non-loopback test endpoint "${endpoint}" ` +
				`(host "${url.hostname}") — only 127.0.0.1, localhost and [::1] are allowed.`,
		);
	}
}

/**
 * Spawns the real `dure feedback` CLI as a subprocess.
 *
 * Refuses to run at all unless the caller has explicitly pointed
 * `DURE_FEEDBACK_ENDPOINT` somewhere loopback (see `assertTestEndpoint`). A
 * live incident (2026-09-16) traced real GitHub issues, Telegram pings and
 * Linear mirrors — created by this exact test file, during a RED-phase run
 * against deliberately unfixed code — to tests that assumed the CLI would
 * fail before reaching the network and therefore omitted the endpoint
 * override; when the code path they exercised did not fail as expected
 * (that is the nature of RED), the CLI fell back to its real
 * `FEEDBACK_ENDPOINT_DEFAULT` and `fetch` actually sent it. "The code
 * should reject this first" is exactly the assumption a RED phase or a
 * future regression breaks — so this guard does not trust it, ever.
 */
function runCli(args, { env = {}, input } = {}) {
	const endpoint = env.DURE_FEEDBACK_ENDPOINT;
	if (!endpoint) {
		throw new Error(
			"runCli: every dure feedback subprocess test must set env.DURE_FEEDBACK_ENDPOINT " +
				"(a local fixture server, or UNREACHABLE_FEEDBACK_ENDPOINT for tests that expect " +
				"no network call at all) — refusing to spawn a child that would fall back to the " +
				"real production intake.",
		);
	}
	assertTestEndpoint(endpoint);
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cli, "feedback", ...args], {
			env: { ...process.env, DURE_APP_CHANNEL: "stable", ...env },
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10_000,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.stdin.on("error", (error) => {
			if (error.code !== "EPIPE") reject(error);
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(input ?? "");
	});
}

describe("feedback envelope assembly", () => {
	it("carries all six environment fields and the literal cli channel", () => {
		const envelope = buildFeedbackEnvelope({
			kind: "bug",
			body: "the app crashed",
			contact: undefined,
			env: baseEnv(),
			device: "d-abc",
		});
		expect(envelope).toEqual({
			schema: 1,
			kind: "bug",
			body: "the app crashed",
			env: baseEnv(),
			device: "d-abc",
			attachments: [],
		});
		expect(envelope.env.channel).toBe("cli");
	});

	it("omits a blank or whitespace-only contact entirely rather than sending an empty string", () => {
		for (const contact of [undefined, "", "   ", "\t\n"]) {
			const envelope = buildFeedbackEnvelope({
				kind: "idea",
				body: "it would help if",
				contact,
				env: baseEnv(),
				device: "d-abc",
			});
			expect(envelope).not.toHaveProperty("contact");
		}
	});

	it("trims and keeps a real contact", () => {
		const envelope = buildFeedbackEnvelope({
			kind: "other",
			body: "body text",
			contact: "  a@b.com  ",
			env: baseEnv(),
			device: "d-abc",
		});
		expect(envelope.contact).toBe("a@b.com");
	});

	it("refuses a body over the wire's character cap before sending", () => {
		const over = "x".repeat(FEEDBACK_BODY_LIMIT + 1);
		expect(() =>
			buildFeedbackEnvelope({ kind: "bug", body: over, env: baseEnv(), device: "d-abc" }),
		).toThrow(FeedbackEnvelopeError);
		expect(() =>
			buildFeedbackEnvelope({ kind: "bug", body: over, env: baseEnv(), device: "d-abc" }),
		).toThrow(/8000/);
	});

	it("accepts a body exactly at the cap", () => {
		const atCap = "x".repeat(FEEDBACK_BODY_LIMIT);
		expect(() =>
			buildFeedbackEnvelope({ kind: "bug", body: atCap, env: baseEnv(), device: "d-abc" }),
		).not.toThrow();
	});

	it("refuses a contact over the wire's character cap, with the same message shape as the body cap", () => {
		const over = "x".repeat(FEEDBACK_CONTACT_LIMIT + 1);
		expect(() =>
			buildFeedbackEnvelope({
				kind: "bug",
				body: "x",
				contact: over,
				env: baseEnv(),
				device: "d-abc",
			}),
		).toThrow(FeedbackEnvelopeError);
		expect(() =>
			buildFeedbackEnvelope({
				kind: "bug",
				body: "x",
				contact: over,
				env: baseEnv(),
				device: "d-abc",
			}),
		).toThrow(/200/);
	});

	it("accepts a contact exactly at the cap", () => {
		const atCap = "x".repeat(FEEDBACK_CONTACT_LIMIT);
		expect(() =>
			buildFeedbackEnvelope({
				kind: "bug",
				body: "x",
				contact: atCap,
				env: baseEnv(),
				device: "d-abc",
			}),
		).not.toThrow();
	});

	it("counts Unicode scalar values, not UTF-16 code units, against the cap", () => {
		// Each of these is one Rust `char` (one Unicode scalar value) but two
		// UTF-16 code units in JS — 4001 of them must stay under the 8000 cap.
		const astral = "\u{1F600}".repeat(4001);
		expect(() =>
			buildFeedbackEnvelope({ kind: "bug", body: astral, env: baseEnv(), device: "d-abc" }),
		).not.toThrow();
	});

	it("rejects an empty or whitespace-only body", () => {
		for (const body of ["", "   ", "\n\t"]) {
			expect(() =>
				buildFeedbackEnvelope({ kind: "bug", body, env: baseEnv(), device: "d-abc" }),
			).toThrow(FeedbackEnvelopeError);
		}
	});

	it("rejects an unknown kind", () => {
		expect(() =>
			buildFeedbackEnvelope({ kind: "spam", body: "x", env: baseEnv(), device: "d-abc" }),
		).toThrow(FeedbackEnvelopeError);
	});

	it("the CLI's own --kind vocabulary excludes crash, reserved for automated reporting", () => {
		expect(FEEDBACK_CLI_KINDS).toEqual(["bug", "idea", "other"]);
	});
});

describe("feedback input resolution", () => {
	it("prefers positional text over stdin even when stdin is available", () => {
		const readStdin = vi.fn(() => "from stdin");
		const openEditor = vi.fn(() => "from editor");
		const result = resolveFeedbackText({
			positionalText: "from arguments",
			stdinIsTTY: false,
			stdoutIsTTY: false,
			readStdin,
			openEditor,
		});
		expect(result).toEqual({ text: "from arguments", source: "arguments" });
		expect(readStdin).not.toHaveBeenCalled();
		expect(openEditor).not.toHaveBeenCalled();
	});

	it("reads stdin when it is not a TTY and no positional text was given", () => {
		const readStdin = vi.fn(() => "piped text");
		const openEditor = vi.fn(() => "from editor");
		const result = resolveFeedbackText({
			positionalText: "",
			stdinIsTTY: false,
			stdoutIsTTY: true,
			readStdin,
			openEditor,
		});
		expect(result).toEqual({ text: "piped text", source: "stdin" });
		expect(openEditor).not.toHaveBeenCalled();
	});

	it("reaches the editor only when both positional text and a stdin pipe are absent and the session is interactive", () => {
		const readStdin = vi.fn(() => "piped text");
		const openEditor = vi.fn(() => "typed in editor");
		const result = resolveFeedbackText({
			positionalText: "",
			stdinIsTTY: true,
			stdoutIsTTY: true,
			readStdin,
			openEditor,
		});
		expect(result).toEqual({ text: "typed in editor", source: "editor" });
		expect(readStdin).not.toHaveBeenCalled();
		expect(openEditor).toHaveBeenCalledOnce();
	});

	it("fails with a usage error when stdin is a TTY but stdout is not (no editor to show)", () => {
		const openEditor = vi.fn();
		expect(() =>
			resolveFeedbackText({
				positionalText: "",
				stdinIsTTY: true,
				stdoutIsTTY: false,
				readStdin: vi.fn(),
				openEditor,
			}),
		).toThrow(FeedbackUsageError);
		expect(openEditor).not.toHaveBeenCalled();
	});
});

describe("feedback environment fields", () => {
	it("renders a human-readable OS label instead of a bare platform key", () => {
		expect(humanOperatingSystem("darwin", "24.5.0")).toBe("macOS 24.5.0");
		expect(humanOperatingSystem("linux", "6.6.0")).toBe("Linux 6.6.0");
		expect(humanOperatingSystem("win32", "10.0.19045")).toBe("Windows 10.0.19045");
	});

	it("resolves locale from the environment in POSIX override order, stripping any charset suffix", () => {
		expect(resolveFeedbackLocale({ LC_ALL: "ko_KR.UTF-8", LANG: "en_US.UTF-8" })).toBe("ko-KR");
		expect(resolveFeedbackLocale({ LANG: "en_US.UTF-8" })).toBe("en-US");
	});

	it("falls back to a stable literal locale rather than an empty string", () => {
		expect(resolveFeedbackLocale({})).toBe("en-US");
	});

	it("renders terminal size as <columns>x<rows>, else the literal headless", () => {
		expect(resolveFeedbackWindow(120, 40)).toBe("120x40");
		expect(resolveFeedbackWindow(undefined, undefined)).toBe("headless");
		expect(resolveFeedbackWindow(0, 0)).toBe("headless");
	});

	// The default argument is the only form production ever uses, and the old
	// test never exercised it — it passed cli/package.json explicitly, so it
	// only ever proved "given the manifest, it reads it". That is why #923
	// shipped: the manifest is absent from an installed channel, and no test
	// ran against that layout.
	it("reads the CLI's own version with no argument, from the source checkout", () => {
		expect(readCliVersion()).toBe(cliPackageVersion);
	});

	// The regression guard. An installed channel has no cli/package.json
	// anywhere in its tree; it identifies itself with install.json one level
	// above bin/. Reading the manifest answers "unknown" here — which is what
	// every real install reported.
	it("reads the version from an installed channel layout, which ships no manifest", () => {
		const channel = join(tempHome(), "channel");
		mkdirSync(join(channel, "bin"), { recursive: true });
		writeFileSync(join(channel, "bin", "dure.mjs"), "#!/usr/bin/env node\n");
		writeFileSync(
			join(channel, "install.json"),
			JSON.stringify({
				schemaVersion: 3,
				command: "dure",
				packageVersion: "9.9.9",
				buildId: "9.9.9+abcdef0123456789",
			}),
		);

		expect(readCliVersion(join(channel, "bin", "dure.mjs"))).toBe("9.9.9");
		expect(existsSync(join(channel, "bin", "package.json"))).toBe(false);
	});

	it("falls back to a stable literal when neither layout identifies the build", () => {
		expect(readCliVersion(join(tempHome(), "nowhere", "dure.mjs"))).toBe("unknown");
	});
});

describe("feedback device id", () => {
	it("creates a device id once under ~/.dure and reuses it on the next call", () => {
		const home = tempHome();
		const environment = { DURE_HOME: join(home, ".dure") };
		const first = loadOrCreateFeedbackDeviceId({ environment });
		const second = loadOrCreateFeedbackDeviceId({ environment });
		expect(first).toBe(second);
		expect(
			readFileSync(join(home, ".dure", "feedback-device-id"), "utf8").trim(),
		).toBe(first);
	});

	it("uses crypto.randomUUID, which satisfies the wire's device charset", () => {
		const home = tempHome();
		const environment = { DURE_HOME: join(home, ".dure") };
		const randomUUIDImpl = vi.fn(() => "11111111-2222-4333-8444-555555555555");
		const id = loadOrCreateFeedbackDeviceId({ environment, randomUUIDImpl });
		expect(id).toBe("11111111-2222-4333-8444-555555555555");
		expect(randomUUIDImpl).toHaveBeenCalledOnce();
	});

	it("regenerates the device id when the persisted file is garbage, instead of getting every submission rejected forever", () => {
		const home = tempHome();
		const dureHome = join(home, ".dure");
		mkdirSync(dureHome, { recursive: true });
		writeFileSync(join(dureHome, "feedback-device-id"), "not a valid device id!! éé\n");
		const randomUUIDImpl = vi.fn(() => "11111111-2222-4333-8444-555555555555");
		const id = loadOrCreateFeedbackDeviceId({
			environment: { DURE_HOME: dureHome },
			randomUUIDImpl,
		});
		expect(id).toBe("11111111-2222-4333-8444-555555555555");
		expect(readFileSync(join(dureHome, "feedback-device-id"), "utf8").trim()).toBe(id);
	});

	it("regenerates the device id when the persisted file is over the wire's length cap", () => {
		const home = tempHome();
		const dureHome = join(home, ".dure");
		mkdirSync(dureHome, { recursive: true });
		writeFileSync(
			join(dureHome, "feedback-device-id"),
			`${"a".repeat(FEEDBACK_DEVICE_LIMIT + 1)}\n`,
		);
		const randomUUIDImpl = vi.fn(() => "22222222-3333-4444-8555-666666666666");
		const id = loadOrCreateFeedbackDeviceId({
			environment: { DURE_HOME: dureHome },
			randomUUIDImpl,
		});
		expect(id).toBe("22222222-3333-4444-8555-666666666666");
	});
});

describe("feedback editor path", () => {
	it("fails with a usage error when $EDITOR is not set", () => {
		expect(() => openFeedbackEditor({ environment: {} })).toThrow(FeedbackUsageError);
	});

	it("writes the file the configured $EDITOR saved", () => {
		const spawnSyncImpl = vi.fn((_command, args) => {
			const file = args.at(-1);
			writeFileSync(file, "typed in the editor\n");
			return { status: 0, error: undefined };
		});
		const text = openFeedbackEditor({ environment: { EDITOR: "vim" }, spawnSyncImpl });
		expect(text).toBe("typed in the editor\n");
		expect(spawnSyncImpl).toHaveBeenCalledWith(
			"vim",
			[expect.stringContaining("FEEDBACK.txt")],
			expect.objectContaining({ stdio: "inherit" }),
		);
	});

	it("treats an editor killed by a signal as an abort, not a silent save of partial content", () => {
		const spawnSyncImpl = vi.fn((_command, args) => {
			const file = args.at(-1);
			writeFileSync(file, "partial content before Ctrl+C\n");
			return { status: null, signal: "SIGINT", error: undefined };
		});
		expect(() =>
			openFeedbackEditor({ environment: { EDITOR: "vim" }, spawnSyncImpl }),
		).toThrow(FeedbackUsageError);
		expect(() =>
			openFeedbackEditor({ environment: { EDITOR: "vim" }, spawnSyncImpl }),
		).toThrow(/SIGINT/);
	});
});

describe("feedback preview", () => {
	it("shows the body, the device id, and every environment value that will travel with the report", () => {
		const envelope = buildFeedbackEnvelope({
			kind: "bug",
			body: "it froze",
			env: baseEnv(),
			device: "d-abc",
		});
		const preview = renderFeedbackPreview(envelope);
		expect(preview).toContain("it froze");
		// device persists across submissions unlike anything else in the
		// envelope — the app's own preview shows it, so this must too.
		expect(preview).toContain("Device: d-abc");
		for (const [name, value] of Object.entries(baseEnv())) {
			expect(preview).toContain(`${name}: ${value}`);
		}
	});
});

describe("feedback wire POST", () => {
	// Every `postFeedback` call in this block already only ever receives an
	// `endpoint` from `startFixtureServer()` or `UNREACHABLE_FEEDBACK_ENDPOINT`
	// — there is no fallback path here the way there is in `runCli`/
	// `overrides()` (nothing is ever omitted). `assertTestEndpoint` is still
	// called at each site so that stays true by an enforced check, not by
	// nobody having made a mistake yet.
	it("sends the exact JSON body the wire expects", async () => {
		const { requests, endpoint } = await startFixtureServer((response) => {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "gh-42" }));
		});
		assertTestEndpoint(endpoint);
		const envelope = buildFeedbackEnvelope({
			kind: "bug",
			body: "exact wire body test",
			contact: "a@b.com",
			env: baseEnv(),
			device: "d-abc",
		});
		const outcome = await postFeedback(envelope, { fetchImpl: fetch, endpoint });
		expect(outcome).toEqual({ ok: true, reference: "gh-42" });
		expect(requests).toEqual([
			{
				method: "POST",
				path: "/v1/feedback",
				contentType: "application/json",
				payload: envelope,
			},
		]);
	});

	it("classifies a 429 as rate_limited", async () => {
		const { endpoint } = await startFixtureServer((response) => {
			response.writeHead(429, { "content-type": "application/json" });
			response.end(JSON.stringify({}));
		});
		assertTestEndpoint(endpoint);
		const outcome = await postFeedback(
			buildFeedbackEnvelope({ kind: "bug", body: "x", env: baseEnv(), device: "d-abc" }),
			{ fetchImpl: fetch, endpoint },
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.kind).toBe("rate_limited");
	});

	it("classifies a 413 as rejected and carries the offending field", async () => {
		const { endpoint } = await startFixtureServer((response) => {
			response.writeHead(413, { "content-type": "application/json" });
			response.end(JSON.stringify({ field: "body" }));
		});
		assertTestEndpoint(endpoint);
		const outcome = await postFeedback(
			buildFeedbackEnvelope({ kind: "bug", body: "x", env: baseEnv(), device: "d-abc" }),
			{ fetchImpl: fetch, endpoint },
		);
		expect(outcome).toEqual({
			ok: false,
			kind: "rejected",
			field: "body",
			message: "Feedback rejected: body too large.",
		});
	});

	it("classifies a 503 as temporary", async () => {
		const { endpoint } = await startFixtureServer((response) => {
			response.writeHead(503, { "content-type": "application/json" });
			response.end(JSON.stringify({}));
		});
		assertTestEndpoint(endpoint);
		const outcome = await postFeedback(
			buildFeedbackEnvelope({ kind: "bug", body: "x", env: baseEnv(), device: "d-abc" }),
			{ fetchImpl: fetch, endpoint },
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.kind).toBe("temporary");
	});

	it("classifies a fetch rejection as its own network case", async () => {
		assertTestEndpoint(UNREACHABLE_FEEDBACK_ENDPOINT);
		const outcome = await postFeedback(
			buildFeedbackEnvelope({ kind: "bug", body: "x", env: baseEnv(), device: "d-abc" }),
			{
				fetchImpl: async () => {
					throw new Error("ECONNREFUSED");
				},
				endpoint: UNREACHABLE_FEEDBACK_ENDPOINT,
			},
		);
		expect(outcome.ok).toBe(false);
		expect(outcome.kind).toBe("network");
		expect(outcome.message).toContain("ECONNREFUSED");
	});
});

describe("runFeedbackCommand exit codes and --json output", () => {
	// Same defense as runCli's guard (see assertTestEndpoint), for the
	// in-process path: `fetchImpl` here is the real global `fetch`, so a
	// missing or non-loopback `endpoint` would be a real live send just as
	// easily as a subprocess would be.
	function overrides({ endpoint, home, stdinIsTTY = false, stdoutIsTTY = false }) {
		if (!endpoint) {
			throw new Error(
				"overrides(): every call must pass a loopback endpoint (a local fixture " +
					"server, or UNREACHABLE_FEEDBACK_ENDPOINT) — this factory wires up the real fetch.",
			);
		}
		assertTestEndpoint(endpoint);
		const stdout = fakeWritable();
		const stderr = fakeWritable();
		return {
			overridesObject: {
				environment: { DURE_HOME: join(home, ".dure"), DURE_FEEDBACK_ENDPOINT: endpoint },
				fetchImpl: fetch,
				stdout,
				stderr,
				stdin: { isTTY: stdinIsTTY },
				stdinIsTTY,
				stdoutIsTTY,
				endpoint,
			},
			stdout,
			stderr,
		};
	}

	it("exits 0 and prints only the reference on success", async () => {
		const { endpoint } = await startFixtureServer((response) => {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "gh-100" }));
		});
		const { overridesObject, stdout, stderr } = overrides({ endpoint, home: tempHome() });
		const code = await runFeedbackCommand({ rest: ["it", "crashed"] }, overridesObject);
		expect(code).toBe(0);
		expect(stdout.text()).toBe("gh-100\n");
		expect(stderr.text()).toBe("");
	});

	it("prints {\"reference\":...} and nothing else with --json on success", async () => {
		const { endpoint } = await startFixtureServer((response) => {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "gh-101" }));
		});
		const { overridesObject, stdout } = overrides({ endpoint, home: tempHome() });
		const code = await runFeedbackCommand(
			{ rest: ["it", "crashed"], json: true },
			overridesObject,
		);
		expect(code).toBe(0);
		expect(stdout.text()).toBe(`${JSON.stringify({ reference: "gh-101" })}\n`);
	});

	it("exits 1 on a 429 rate limit, with --json giving a structured error", async () => {
		const { endpoint } = await startFixtureServer((response) => {
			response.writeHead(429, { "content-type": "application/json" });
			response.end(JSON.stringify({}));
		});
		const { overridesObject, stdout, stderr } = overrides({ endpoint, home: tempHome() });
		const code = await runFeedbackCommand(
			{ rest: ["it", "crashed"], json: true },
			overridesObject,
		);
		expect(code).toBe(1);
		expect(stdout.text()).toBe("");
		expect(JSON.parse(stderr.text())).toEqual({ error: expect.stringContaining("rate limited") });
	});

	it.each([false, true])("reports Retry-After without retrying the submission (json=%s)", async (json) => {
		const { endpoint, requests } = await startFixtureServer((response) => {
			response.writeHead(429, { "content-type": "application/json", "retry-after": "42" });
			response.end(JSON.stringify({ error: "RATE_LIMITED", retryAfterSeconds: 42 }));
		});
		const { overridesObject, stdout, stderr } = overrides({ endpoint, home: tempHome() });
		const code = await runFeedbackCommand({ rest: ["keep this report"], json }, overridesObject);
		expect(code).toBe(1);
		expect(stdout.text()).toBe("");
		expect(requests).toHaveLength(1);
		const error = "Feedback rate limited. Try again in 42 seconds.";
		expect(stderr.text()).toBe(json ? `${JSON.stringify({ error, retryAfterSeconds: 42 })}\n` : `${error}\n`);
	});

	it.each(["later", "-1", "1.5", "9007199254740992"])("ignores an invalid retry delay %s", async (retryAfter) => {
		const { endpoint } = await startFixtureServer((response) => {
			response.writeHead(429, { "retry-after": retryAfter });
			response.end();
		});
		const { overridesObject, stderr } = overrides({ endpoint, home: tempHome() });
		expect(await runFeedbackCommand({ rest: ["keep this report"], json: true }, overridesObject)).toBe(1);
		expect(JSON.parse(stderr.text())).toEqual({ error: "Feedback rate limited. Try again later." });
	});

	it("exits 1 on a 413 and names the oversized field", async () => {
		const { endpoint } = await startFixtureServer((response) => {
			response.writeHead(413, { "content-type": "application/json" });
			response.end(JSON.stringify({ field: "body" }));
		});
		const { overridesObject, stderr } = overrides({ endpoint, home: tempHome() });
		const code = await runFeedbackCommand({ rest: ["it", "crashed"] }, overridesObject);
		expect(code).toBe(1);
		expect(stderr.text()).toContain("body too large");
	});

	it("exits 1 on a transport failure", async () => {
		const { overridesObject, stderr } = overrides({
			endpoint: UNREACHABLE_FEEDBACK_ENDPOINT,
			home: tempHome(),
		});
		const code = await runFeedbackCommand({ rest: ["it", "crashed"] }, overridesObject);
		expect(code).toBe(1);
		expect(stderr.text()).toContain("Feedback request failed");
	});

	it("exits 2 on an unknown --kind before ever resolving input or sending", async () => {
		const { overridesObject, stderr } = overrides({
			endpoint: UNREACHABLE_FEEDBACK_ENDPOINT,
			home: tempHome(),
		});
		const code = await runFeedbackCommand(
			{ rest: ["it", "crashed"], kind: "spam" },
			overridesObject,
		);
		expect(code).toBe(2);
		expect(stderr.text()).toContain("spam");
	});

	it("gives a parseable {\"error\":...} for an unknown --kind, with --json", async () => {
		const { overridesObject, stdout, stderr } = overrides({
			endpoint: UNREACHABLE_FEEDBACK_ENDPOINT,
			home: tempHome(),
		});
		const code = await runFeedbackCommand(
			{ rest: ["it", "crashed"], kind: "spam", json: true },
			overridesObject,
		);
		expect(code).toBe(2);
		expect(stdout.text()).toBe("");
		expect(JSON.parse(stderr.text())).toEqual({ error: expect.stringContaining("spam") });
	});

	it("exits 2 when no input source is available", async () => {
		const { overridesObject, stderr } = overrides({
			endpoint: UNREACHABLE_FEEDBACK_ENDPOINT,
			home: tempHome(),
			stdinIsTTY: true,
			stdoutIsTTY: false,
		});
		const code = await runFeedbackCommand({ rest: [] }, overridesObject);
		expect(code).toBe(2);
		expect(stderr.text().length).toBeGreaterThan(0);
	});

	it("gives a parseable {\"error\":...} when no input source is available, with --json", async () => {
		const { overridesObject, stdout, stderr } = overrides({
			endpoint: UNREACHABLE_FEEDBACK_ENDPOINT,
			home: tempHome(),
			stdinIsTTY: true,
			stdoutIsTTY: false,
		});
		const code = await runFeedbackCommand({ rest: [], json: true }, overridesObject);
		expect(code).toBe(2);
		expect(stdout.text()).toBe("");
		expect(JSON.parse(stderr.text())).toEqual({ error: expect.any(String) });
	});

	it("exits 2 for a body over the local cap without ever sending it", async () => {
		let sent = false;
		const { overridesObject, stderr } = overrides({
			endpoint: UNREACHABLE_FEEDBACK_ENDPOINT,
			home: tempHome(),
		});
		overridesObject.fetchImpl = async () => {
			sent = true;
			throw new Error("must not be called");
		};
		const code = await runFeedbackCommand(
			{ rest: ["x".repeat(FEEDBACK_BODY_LIMIT + 1)] },
			overridesObject,
		);
		expect(code).toBe(2);
		expect(sent).toBe(false);
		expect(stderr.text()).toContain("8000");
	});

	it("gives a parseable {\"error\":...} for a body over the local cap, with --json", async () => {
		let sent = false;
		const { overridesObject, stdout, stderr } = overrides({
			endpoint: UNREACHABLE_FEEDBACK_ENDPOINT,
			home: tempHome(),
		});
		overridesObject.fetchImpl = async () => {
			sent = true;
			throw new Error("must not be called");
		};
		const code = await runFeedbackCommand(
			{ rest: ["x".repeat(FEEDBACK_BODY_LIMIT + 1)], json: true },
			overridesObject,
		);
		expect(code).toBe(2);
		expect(sent).toBe(false);
		expect(stdout.text()).toBe("");
		expect(JSON.parse(stderr.text())).toEqual({ error: expect.stringContaining("8000") });
	});

	it("skips the confirmation prompt with --yes even on an interactive session", async () => {
		const { endpoint } = await startFixtureServer((response) => {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "gh-200" }));
		});
		const { overridesObject } = overrides({
			endpoint,
			home: tempHome(),
			stdinIsTTY: true,
			stdoutIsTTY: true,
		});
		const confirm = vi.fn();
		overridesObject.confirm = confirm;
		overridesObject.openEditor = () => "typed in the editor";
		const code = await runFeedbackCommand({ rest: [], yes: true }, overridesObject);
		expect(code).toBe(0);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("prompts before sending on a genuinely interactive (editor) session and aborts on no", async () => {
		let sent = false;
		const { overridesObject, stdout } = overrides({
			endpoint: UNREACHABLE_FEEDBACK_ENDPOINT,
			home: tempHome(),
			stdinIsTTY: true,
			stdoutIsTTY: true,
		});
		overridesObject.fetchImpl = async () => {
			sent = true;
			throw new Error("must not be called");
		};
		overridesObject.openEditor = () => "typed in the editor";
		overridesObject.confirm = vi.fn(async () => false);
		const code = await runFeedbackCommand({ rest: [] }, overridesObject);
		expect(code).toBe(1);
		expect(sent).toBe(false);
		expect(overridesObject.confirm).toHaveBeenCalledOnce();
		expect(stdout.text()).toContain("typed in the editor");
	});

	it("gives a parseable {\"error\":\"Feedback not sent.\"} when the confirmation is declined, with --json", async () => {
		const { overridesObject, stdout, stderr } = overrides({
			endpoint: UNREACHABLE_FEEDBACK_ENDPOINT,
			home: tempHome(),
			stdinIsTTY: true,
			stdoutIsTTY: true,
		});
		overridesObject.fetchImpl = async () => {
			throw new Error("must not be called");
		};
		overridesObject.openEditor = () => "typed in the editor";
		overridesObject.confirm = vi.fn(async () => false);
		const code = await runFeedbackCommand({ rest: [], json: true }, overridesObject);
		expect(code).toBe(1);
		expect(JSON.parse(stderr.text())).toEqual({ error: "Feedback not sent." });
		// The preview itself still renders to stdout even with --json — only
		// the final machine-readable outcome (reference or error) is gated by
		// --json; the interactive preview is for the human at the prompt.
		expect(stdout.text()).toContain("typed in the editor");
	});

	it("never prompts on the agent path (arguments or a pipe), even on a TTY stdout", async () => {
		const { endpoint } = await startFixtureServer((response) => {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "gh-300" }));
		});
		const { overridesObject } = overrides({
			endpoint,
			home: tempHome(),
			stdinIsTTY: false,
			stdoutIsTTY: true,
		});
		const confirm = vi.fn();
		overridesObject.confirm = confirm;
		const code = await runFeedbackCommand({ rest: ["from", "arguments"] }, overridesObject);
		expect(code).toBe(0);
		expect(confirm).not.toHaveBeenCalled();
	});
});

describe("dure feedback (real subprocess)", () => {
	it("sends positional text end to end and prints the reference", async () => {
		const { requests, endpoint } = await startFixtureServer((response) => {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "gh-999" }));
		});
		const home = tempHome();
		const result = await runCli(["--kind", "bug", "--json", "It crashed on launch"], {
			env: { HOME: home, DURE_HOME: join(home, ".dure"), DURE_FEEDBACK_ENDPOINT: endpoint },
		});
		expect(result).toEqual({ code: 0, stdout: `${JSON.stringify({ reference: "gh-999" })}\n`, stderr: "" });
		expect(requests).toHaveLength(1);
		expect(requests[0].payload).toMatchObject({
			schema: 1,
			kind: "bug",
			body: "It crashed on launch",
			env: { channel: "cli" },
		});
		expect(requests[0].payload.env).toEqual({
			app: cliPackageVersion,
			channel: "cli",
			os: humanOperatingSystem(),
			arch: process.arch,
			locale: expect.any(String),
			window: expect.stringMatching(/^(\d+x\d+|headless)$/),
		});
		expect(requests[0].payload.device).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it("reads text from stdin when no positional text is given", async () => {
		const { requests, endpoint } = await startFixtureServer((response) => {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "gh-998" }));
		});
		const home = tempHome();
		const result = await runCli(["--json"], {
			env: { HOME: home, DURE_HOME: join(home, ".dure"), DURE_FEEDBACK_ENDPOINT: endpoint },
			input: "piped in from a script\n",
		});
		expect(result.code).toBe(0);
		expect(requests[0].payload.body).toBe("piped in from a script\n");
	});

	it("prints usage help for --help without attempting to send anything", async () => {
		const home = tempHome();
		const result = await runCli(["--help"], {
			env: {
				HOME: home,
				DURE_HOME: join(home, ".dure"),
				DURE_FEEDBACK_ENDPOINT: UNREACHABLE_FEEDBACK_ENDPOINT,
			},
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("dure feedback");
	});

	it("documents the literal -- / stdin rule for text containing a flag-like word", async () => {
		const home = tempHome();
		const result = await runCli(["--help"], {
			env: {
				HOME: home,
				DURE_HOME: join(home, ".dure"),
				DURE_FEEDBACK_ENDPOINT: UNREACHABLE_FEEDBACK_ENDPOINT,
			},
		});
		expect(result.stdout).toContain("needs a literal -- first, or use stdin");
	});

	it("exits 2 for an unknown --kind", async () => {
		const home = tempHome();
		const result = await runCli(["--kind", "spam", "text"], {
			env: {
				HOME: home,
				DURE_HOME: join(home, ".dure"),
				DURE_FEEDBACK_ENDPOINT: UNREACHABLE_FEEDBACK_ENDPOINT,
			},
		});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("spam");
	});

	it("delivers the whole sentence, dashes included, when it follows a literal --", async () => {
		const { requests, endpoint } = await startFixtureServer((response) => {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "gh-997" }));
		});
		const home = tempHome();
		const result = await runCli(["--", "the", "--app", "icon", "disappeared"], {
			env: { HOME: home, DURE_HOME: join(home, ".dure"), DURE_FEEDBACK_ENDPOINT: endpoint },
		});
		expect(result.code).toBe(0);
		expect(requests[0].payload.body).toBe("the --app icon disappeared");
	});

	it("fails loudly instead of silently losing text when an unrelated flag precedes it unquoted", async () => {
		const home = tempHome();
		const result = await runCli(["the", "--app", "icon", "disappeared"], {
			env: {
				HOME: home,
				DURE_HOME: join(home, ".dure"),
				DURE_FEEDBACK_ENDPOINT: UNREACHABLE_FEEDBACK_ENDPOINT,
			},
		});
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--app");
	});

	it("gives a parseable {\"error\":...} for a stray unrelated flag, with --json", async () => {
		const home = tempHome();
		const result = await runCli(["the", "--app", "icon", "disappeared", "--json"], {
			env: {
				HOME: home,
				DURE_HOME: join(home, ".dure"),
				DURE_FEEDBACK_ENDPOINT: UNREACHABLE_FEEDBACK_ENDPOINT,
			},
		});
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(JSON.parse(result.stderr)).toEqual({ error: expect.stringContaining("--app") });
	});

	it.each([
		[["--kind", "idea", "--contact", "a@b.com", "--json", "--yes", "a report"]],
		[["--yes", "--contact", "a@b.com", "--json", "--kind", "idea", "a report"]],
	])("allows feedback's own flags before the text, in any order among themselves (%#)", async (
		argv,
	) => {
		const { requests, endpoint } = await startFixtureServer((response) => {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "gh-996" }));
		});
		const home = tempHome();
		const result = await runCli(argv, {
			env: { HOME: home, DURE_HOME: join(home, ".dure"), DURE_FEEDBACK_ENDPOINT: endpoint },
		});
		expect(result.code).toBe(0);
		expect(requests[0].payload).toMatchObject({ kind: "idea", contact: "a@b.com" });
	});

	it.each([
		["--kind", ["idea"]],
		["--contact", ["a@b.com"]],
		["--json", []],
		["--yes", []],
	])(
		"fails once %s appears after the first word — reproduces the silent-corruption reports",
		async (flag, extra) => {
			const home = tempHome();
			// Leading --json guarantees a JSON-formatted error regardless of
			// which flag is under test (parseOpts recognizes --json wherever it
			// appears), matching the "fails ... with a JSON error" requirement.
			const result = await runCli(["--json", "my", "report", flag, ...extra], {
				env: {
					HOME: home,
					DURE_HOME: join(home, ".dure"),
					DURE_FEEDBACK_ENDPOINT: UNREACHABLE_FEEDBACK_ENDPOINT,
				},
			});
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(JSON.parse(result.stderr)).toEqual({ error: expect.stringContaining(flag) });
		},
	);

	it.each(["--help", "-h"])(
		"fails instead of printing help when %s appears after the first word",
		async (flag) => {
			const home = tempHome();
			const result = await runCli(["--json", "my", "report", flag], {
				env: {
					HOME: home,
					DURE_HOME: join(home, ".dure"),
					DURE_FEEDBACK_ENDPOINT: UNREACHABLE_FEEDBACK_ENDPOINT,
				},
			});
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(JSON.parse(result.stderr)).toEqual({ error: expect.stringContaining(flag) });
		},
	);

	it("reproduces the exact review report: '--contact flag' mid-sentence no longer silently truncates the body", async () => {
		const home = tempHome();
		const result = await runCli(
			["the", "--contact", "flag", "doesnt", "work", "--json", "--yes"],
			{
				env: {
					HOME: home,
					DURE_HOME: join(home, ".dure"),
					DURE_FEEDBACK_ENDPOINT: UNREACHABLE_FEEDBACK_ENDPOINT,
				},
			},
		);
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stderr)).toEqual({ error: expect.stringContaining("--contact") });
	});

	it("reproduces the exact review report: '--kind idea for a fix' mid-sentence no longer silently switches kind", async () => {
		const home = tempHome();
		const result = await runCli(
			["my", "--kind", "idea", "for", "a", "fix", "--json", "--yes"],
			{
				env: {
					HOME: home,
					DURE_HOME: join(home, ".dure"),
					DURE_FEEDBACK_ENDPOINT: UNREACHABLE_FEEDBACK_ENDPOINT,
				},
			},
		);
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stderr)).toEqual({ error: expect.stringContaining("--kind") });
	});

	it("pins the semantics of a literal -- appearing after text has already begun: everything (before and after) becomes one body, dashes included", async () => {
		const { requests, endpoint } = await startFixtureServer((response) => {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "gh-995" }));
		});
		const home = tempHome();
		const result = await runCli(["my", "text", "--", "with", "--kind", "inside"], {
			env: { HOME: home, DURE_HOME: join(home, ".dure"), DURE_FEEDBACK_ENDPOINT: endpoint },
		});
		expect(result.code).toBe(0);
		expect(requests[0].payload.body).toBe("my text with --kind inside");
		// The literal "--kind" after "--" was never parsed as a flag — the
		// envelope's kind still falls back to the "bug" default.
		expect(requests[0].payload.kind).toBe("bug");
	});

	it("passes a negative-number-shaped word through as ordinary text", async () => {
		const { requests, endpoint } = await startFixtureServer((response) => {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "gh-994" }));
		});
		const home = tempHome();
		const result = await runCli(["dropped", "to", "-5", "fps"], {
			env: { HOME: home, DURE_HOME: join(home, ".dure"), DURE_FEEDBACK_ENDPOINT: endpoint },
		});
		expect(result.code).toBe(0);
		expect(requests[0].payload.body).toBe("dropped to -5 fps");
	});

	it("passes a lone - through as ordinary text", async () => {
		const { requests, endpoint } = await startFixtureServer((response) => {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "gh-993" }));
		});
		const home = tempHome();
		const result = await runCli(["-", "means", "stdin", "sometimes"], {
			env: { HOME: home, DURE_HOME: join(home, ".dure"), DURE_FEEDBACK_ENDPOINT: endpoint },
		});
		expect(result.code).toBe(0);
		expect(requests[0].payload.body).toBe("- means stdin sometimes");
	});
});

describe("classifyFeedbackArgs (options-before-text rule)", () => {
	it("is ok when only feedback's own flags precede the text", () => {
		expect(
			classifyFeedbackArgs(["--kind", "bug", "--contact", "a@b.com", "--json", "--yes", "text"]),
		).toEqual({ outcome: "ok" });
	});

	it("is ok in any order among the leading flags", () => {
		expect(
			classifyFeedbackArgs(["--yes", "--json", "--contact", "a@b.com", "--kind", "bug", "text"]),
		).toEqual({ outcome: "ok" });
	});

	it("skips each value-taking flag's value so it is never mistaken for the first word", () => {
		expect(classifyFeedbackArgs(["--kind", "idea", "my", "text"])).toEqual({ outcome: "ok" });
		expect(classifyFeedbackArgs(["--contact", "a@b.com", "my", "text"])).toEqual({
			outcome: "ok",
		});
	});

	it("errors on a flag-shaped token once a positional word has appeared, regardless of which flag", () => {
		expect(classifyFeedbackArgs(["the", "--app", "icon", "disappeared"])).toEqual({
			outcome: "error",
			token: "--app",
		});
		expect(classifyFeedbackArgs(["the", "--contact", "flag"])).toEqual({
			outcome: "error",
			token: "--contact",
		});
		expect(classifyFeedbackArgs(["my", "--kind", "idea"])).toEqual({
			outcome: "error",
			token: "--kind",
		});
		expect(classifyFeedbackArgs(["my", "report", "--json"])).toEqual({
			outcome: "error",
			token: "--json",
		});
		expect(classifyFeedbackArgs(["my", "report", "--yes"])).toEqual({
			outcome: "error",
			token: "--yes",
		});
	});

	it("reports help only while still in the options region", () => {
		expect(classifyFeedbackArgs(["--help"])).toEqual({ outcome: "help" });
		expect(classifyFeedbackArgs(["-h"])).toEqual({ outcome: "help" });
		expect(classifyFeedbackArgs(["--kind", "bug", "--help"])).toEqual({ outcome: "help" });
	});

	it("errors on --help/-h once a positional word has appeared, instead of printing help", () => {
		expect(classifyFeedbackArgs(["the", "help", "text", "is", "confusing", "--help"])).toEqual({
			outcome: "error",
			token: "--help",
		});
		expect(classifyFeedbackArgs(["my", "report", "-h"])).toEqual({
			outcome: "error",
			token: "-h",
		});
	});

	it("treats everything from the first literal -- onward as text, unconditionally", () => {
		expect(
			classifyFeedbackArgs(["--", "the", "--app", "icon", "--help", "disappeared"]),
		).toEqual({ outcome: "ok" });
		expect(classifyFeedbackArgs(["my", "text", "--", "with", "--kind", "inside"])).toEqual({
			outcome: "ok",
		});
	});

	it("does not treat -5 or a lone - as flag-shaped", () => {
		expect(classifyFeedbackArgs(["dropped", "to", "-5", "fps"])).toEqual({ outcome: "ok" });
		expect(classifyFeedbackArgs(["-", "means", "stdin", "sometimes"])).toEqual({
			outcome: "ok",
		});
		// -5 as the very first token: still not flag-shaped, so it is itself
		// the first positional word, not an option.
		expect(classifyFeedbackArgs(["-5", "fps", "--kind", "bug"])).toEqual({
			outcome: "error",
			token: "--kind",
		});
	});

	it("is ok for ordinary text with no flag-like words at all", () => {
		expect(classifyFeedbackArgs(["it", "crashed", "on", "launch"])).toEqual({ outcome: "ok" });
	});

	it("is ok for no arguments at all", () => {
		expect(classifyFeedbackArgs([])).toEqual({ outcome: "ok" });
	});
});

describe("assertTestEndpoint (production-send guard)", () => {
	const productionHostname = new URL(FEEDBACK_ENDPOINT_DEFAULT).hostname;

	it.each([
		["uppercase production", `https://${productionHostname.toUpperCase()}/v1/feedback`],
		["trailing-dot production", `https://${productionHostname}./v1/feedback`],
		["production with an explicit default port", `https://${productionHostname}:443/v1/feedback`],
		["an unrelated public host", "https://example.com"],
	])("refuses %s", (_label, endpoint) => {
		expect(() => assertTestEndpoint(endpoint)).toThrow();
	});

	it("refuses an unparseable string", () => {
		expect(() => assertTestEndpoint("not a url")).toThrow();
	});

	it.each([
		["127.0.0.1", "http://127.0.0.1:1/v1/feedback"],
		["localhost", "http://localhost:1/v1/feedback"],
		["[::1]", "http://[::1]:1/v1/feedback"],
	])("accepts %s", (_label, endpoint) => {
		expect(() => assertTestEndpoint(endpoint)).not.toThrow();
	});
});

describe("classifyFeedbackArgs — options are a closed set, not a position (round 3)", () => {
	// Each row asserts two independent things: the classification itself,
	// and — for every "ok" row — that the real parseOpts() agrees with the
	// scan's own idea of "the text", proving the invariant the agreement
	// backstop enforces, not just trusting classifyFeedbackArgs to have
	// implemented it correctly.
	const rows = [
		{
			label: "leading foreign flag --branch is rejected wherever it appears, first word included",
			args: ["--branch", "is", "broken"],
			outcome: "error",
			token: "--branch",
		},
		{
			label: "leading foreign flag --app",
			args: ["--app", "crashed", "and", "burned"],
			outcome: "error",
			token: "--app",
		},
		{
			label: "leading foreign flag --title",
			args: ["--title", "my", "report"],
			outcome: "error",
			token: "--title",
		},
		{
			label: "leading foreign short flag -p",
			args: ["-p", "my", "report"],
			outcome: "error",
			token: "-p",
		},
		{
			label: "leading foreign short flag -a",
			args: ["-a", "my", "report"],
			outcome: "error",
			token: "-a",
		},
		{
			label: "--kind before text",
			args: ["--kind", "idea", "my", "text"],
			outcome: "ok",
			text: ["my", "text"],
		},
		{
			label: "--contact before text",
			args: ["--contact", "me@x", "my", "text"],
			outcome: "ok",
			text: ["my", "text"],
		},
		{ label: "--json before text", args: ["--json", "my", "text"], outcome: "ok", text: ["my", "text"] },
		{ label: "--yes before text", args: ["--yes", "my", "text"], outcome: "ok", text: ["my", "text"] },
		{ label: "--help before text", args: ["--help", "my", "text"], outcome: "help" },
		{ label: "-h before text", args: ["-h", "my", "text"], outcome: "help" },
		{
			label: "--kind after text",
			args: ["my", "text", "--kind", "idea"],
			outcome: "error",
			token: "--kind",
		},
		{
			label: "--contact after text",
			args: ["my", "text", "--contact", "me@x"],
			outcome: "error",
			token: "--contact",
		},
		{
			label: "--json after text",
			args: ["my", "text", "--json"],
			outcome: "error",
			token: "--json",
		},
		{
			label: "--yes after text",
			args: ["my", "text", "--yes"],
			outcome: "error",
			token: "--yes",
		},
		{
			label: "--help after text",
			args: ["my", "text", "--help"],
			outcome: "error",
			token: "--help",
		},
		{
			label: "-h after text",
			args: ["my", "text", "-h"],
			outcome: "error",
			token: "-h",
		},
		{
			label: "literal -- before any text",
			args: ["--", "my", "text"],
			outcome: "ok",
			text: ["my", "text"],
		},
		{
			label: "literal -- after text has begun",
			args: ["my", "text", "--", "with", "--kind", "inside"],
			outcome: "ok",
			text: ["my", "text", "with", "--kind", "inside"],
		},
		{
			label: "a second literal -- is itself just text",
			args: ["--", "a", "--", "b"],
			outcome: "ok",
			text: ["a", "--", "b"],
		},
		{
			label: "-5 passes through as text",
			args: ["dropped", "to", "-5", "fps"],
			outcome: "ok",
			text: ["dropped", "to", "-5", "fps"],
		},
		{
			label: "a bare - passes through as text",
			args: ["-", "means", "stdin"],
			outcome: "ok",
			text: ["-", "means", "stdin"],
		},
		{
			label: "an own value flag whose value itself starts with -",
			args: ["--contact", "-x", "my", "text"],
			outcome: "ok",
			text: ["my", "text"],
		},
	];

	it.each(rows)("$label", ({ args, outcome, token, text }) => {
		const result = classifyFeedbackArgs(args);
		expect(result.outcome).toBe(outcome);
		if (outcome === "error" && token !== undefined) {
			expect(result.token).toBe(token);
		}
		if (outcome === "ok") {
			// The agreement backstop's invariant, checked independently: what
			// the real shared parser considers "the text" must be exactly
			// what this table says it is.
			expect(parseOpts(args).rest).toEqual(text);
		}
	});

	it("fails the agreement backstop when the scan and parseOpts disagree, even though the scan alone would say ok", () => {
		// A deliberately wrong parseOptsImpl simulates a future divergence
		// between the two grammars — the exact class of bug this backstop
		// exists to catch before it becomes a fourth incident.
		const wrongParseOptsImpl = () => ({ rest: ["not", "what", "the", "scan", "saw"] });
		const result = classifyFeedbackArgs(["my", "text"], { parseOptsImpl: wrongParseOptsImpl });
		expect(result).toEqual({ outcome: "error" });
		expect(result.token).toBeUndefined();
	});

	it("agrees with the real parseOpts by default (no injected implementation needed for ordinary use)", () => {
		expect(classifyFeedbackArgs(["my", "text"])).toEqual({ outcome: "ok" });
	});
});

describe("dure feedback (real subprocess) — round 3 regressions", () => {
	it.each([
		["--branch", ["--branch", "is", "broken"]],
		["--app", ["--app", "crashed", "and", "burned"]],
		["--title", ["--title", "my", "report"]],
		["-p", ["-p", "my", "report"]],
		["-a", ["-a", "my", "report"]],
	])(
		"rejects a leading foreign flag (%s) instead of silently truncating the body",
		async (flagName, argv) => {
			const home = tempHome();
			const result = await runCli([...argv, "--json"], {
				env: {
					HOME: home,
					DURE_HOME: join(home, ".dure"),
					DURE_FEEDBACK_ENDPOINT: UNREACHABLE_FEEDBACK_ENDPOINT,
				},
			});
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(JSON.parse(result.stderr)).toEqual({ error: expect.stringContaining(flagName) });
		},
	);

	it("still delivers the correct body when feedback's own flags lead", async () => {
		const { requests, endpoint } = await startFixtureServer((response) => {
			response.writeHead(201, { "content-type": "application/json" });
			response.end(JSON.stringify({ id: "gh-992" }));
		});
		const home = tempHome();
		const result = await runCli(
			["--kind", "idea", "--contact", "me@x", "my", "text"],
			{ env: { HOME: home, DURE_HOME: join(home, ".dure"), DURE_FEEDBACK_ENDPOINT: endpoint } },
		);
		expect(result.code).toBe(0);
		expect(requests[0].payload).toMatchObject({
			kind: "idea",
			contact: "me@x",
			body: "my text",
		});
	});
});
