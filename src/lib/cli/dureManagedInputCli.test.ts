import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cliPath = fileURLToPath(
	new URL("../../../cli/dure.mjs", import.meta.url),
);
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "dure-managed-input-"));
	temporaryRoots.push(root);
	const hmuxLog = join(root, "hmux-argv.jsonl");
	const hmux = join(root, "hmux-fixture.mjs");
	writeFileSync(
		hmux,
		`#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.HMUX_FIXTURE_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "capabilities") {
  const delayMs = Number(process.env.HMUX_FIXTURE_CAPABILITY_DELAY_MS || 0);
  if (Number.isFinite(delayMs) && delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  process.stdout.write(JSON.stringify({ schemaVersion: 2, capabilities: ["managed_screen_read_v1", "semantic_command_input_v1"] }));
} else if (args[0] === "--version") {
  process.stdout.write("hmux 0.1.4\\n");
} else if (args.includes("command-input")) {
  if (process.env.HMUX_FIXTURE_MODE === "semantic-refused") {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: "hmux_terminal_input_refused", message: "Host refused semantic input", deliveryState: "not_written" } }));
    process.stderr.write("hmux: managed input refused\\n");
    process.exitCode = 1;
  } else if (process.env.HMUX_FIXTURE_MODE === "pty-write-failed") {
    process.stdout.write(JSON.stringify({ ok: false, error: { code: "hmux_pty_write_failed", message: "the PTY may contain a written prefix", deliveryState: "unknown" } }));
    process.stderr.write("hmux: managed input delivery is unknown\\n");
    process.exitCode = 1;
  } else {
    const text = args[args.indexOf("--text") + 1];
    const submit = args.includes("--submit");
    const submitRecordId = process.env.HMUX_FIXTURE_MODE === "nonsequential-receipt" ? "3" : text ? "2" : "1";
    process.stdout.write(JSON.stringify({ ok: true, receipt: { terminalEpoch: "terminal-epoch-1", text: text ? { recordId: "1", state: "written_to_pty" } : null, submit: submit ? { recordId: submitRecordId, state: "written_to_pty" } : null } }));
  }
} else {
  process.stderr.write("unexpected fixture command: " + JSON.stringify(args));
  process.exitCode = 2;
}
`,
	);
	chmodSync(hmux, 0o700);
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "agents.json"),
		JSON.stringify({
			version: 4,
			agents: [
				{
					id: "agent-1",
					name: "backend",
					project: "Dure",
					provider: "codex",
					sessionId: "managed-session-1",
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "hmux_managed_v1",
						source: "local",
						hostId: "local",
						sessionId: "managed-session-1",
						workspaceId: "workspace-1",
						stopFence: {
							runnerPrincipal: "runner-principal-1",
							runnerInstance: "runner-instance-1",
							channelEpoch: "18446744073709551615",
							hostInstanceId: "host-instance-1",
							terminalEpoch: "terminal-epoch-1",
						},
					},
				},
			],
		}),
	);
	return { root, hmux, hmuxLog };
}

// Shared spawn options wiring the CLI to the fixture; test-specific fixture
// modes stay explicit at the call site via extraEnv.
function spawnOptions(
	{ root, hmux, hmuxLog }: ReturnType<typeof fixture>,
	extraEnv: Record<string, string> = {},
) {
	return {
		encoding: "utf8" as const,
		env: {
			...process.env,
			DURE_APP_CHANNEL: "stable",
			DURE_HMUX_BIN: hmux,
			DURE_HOME: root,
			HMUX_FIXTURE_LOG: hmuxLog,
			HOME: root,
			...extraEnv,
		},
		timeout: 10_000,
	};
}

describe.skipIf(process.platform === "win32")(
	"dure managed input without the app daemon",
	() => {
		it("sends through the generation-fenced Hmux CLI and preserves a u64 channel epoch", () => {
			const fx = fixture();
			const { hmuxLog } = fx;
			const result = spawnSync(
				process.execPath,
				[cliPath, "send", "backend", "status"],
				spawnOptions(fx, { HMUX_FIXTURE_CAPABILITY_DELAY_MS: "900" }),
			);

			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain("receipt 2");
			const calls = readFileSync(hmuxLog, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]);
			const send = calls.find((args) => args.includes("command-input"));
			expect(send).toBeDefined();
			expect(calls.some((args) => args[0] === "--version")).toBe(false);
			expect(send).toContain("managed-session-1");
			expect(send).toContain("workspace-1");
			expect(send?.[send.indexOf("--text") + 1]).toBe("status");
			expect(send?.filter((argument) => argument === "--submit")).toHaveLength(
				1,
			);
			const fence = send?.[send.indexOf("--expected-fence-json") + 1];
			expect(fence).toContain('"channel_epoch":"18446744073709551615"');
			expect(fence).toContain('"host_instance_id":"host-instance-1"');
			expect(fence).toContain('"terminal_epoch":"terminal-epoch-1"');
		});

		it("sends Enter-only as one semantic submit operation", () => {
			const fx = fixture();
			const { hmuxLog } = fx;
			const result = spawnSync(
				process.execPath,
				[cliPath, "enter", "backend"],
				spawnOptions(fx),
			);

			expect(result.status).toBe(0);
			const calls = readFileSync(hmuxLog, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]);
			const send = calls.find((args) => args.includes("command-input"));
			expect(send?.[send.indexOf("--text") + 1]).toBe("");
			expect(send?.filter((argument) => argument === "--submit")).toHaveLength(
				1,
			);
		});

		it("keeps --no-enter as a semantic draft", () => {
			const fx = fixture();
			const { hmuxLog } = fx;
			const result = spawnSync(
				process.execPath,
				[cliPath, "send", "backend", "first\nsecond", "--no-enter"],
				spawnOptions(fx),
			);

			expect(result.status).toBe(0);
			const calls = readFileSync(hmuxLog, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]);
			const send = calls.find((args) => args.includes("command-input"));
			expect(send?.[send.indexOf("--text") + 1]).toBe("first\nsecond");
			expect(send).not.toContain("--submit");
		});

		it("reports a semantic refusal without fallback or automatic retry", () => {
			const fx = fixture();
			const { hmuxLog } = fx;
			const result = spawnSync(
				process.execPath,
				[cliPath, "send", "backend", "status"],
				spawnOptions(fx, { HMUX_FIXTURE_MODE: "semantic-refused" }),
			);

			expect(result.status).toBe(1);
			expect(result.stderr).toContain("hmux_terminal_input_refused");
			expect(result.stderr).not.toContain("앱 서버");
			const calls = readFileSync(hmuxLog, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]);
			expect(
				calls.filter((args) => args.includes("command-input")),
			).toHaveLength(1);
		});

		it("does not retry or fall back after an outcome-unknown PTY write", () => {
			const fx = fixture();
			const { hmuxLog } = fx;
			const result = spawnSync(
				process.execPath,
				[cliPath, "send", "backend", "status"],
				spawnOptions(fx, { HMUX_FIXTURE_MODE: "pty-write-failed" }),
			);

			expect(result.status).toBe(1);
			expect(result.stderr).toContain("hmux_pty_write_failed");
			const calls = readFileSync(hmuxLog, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]);
			expect(
				calls.filter((args) => args.includes("command-input")),
			).toHaveLength(1);
		});

		it("rejects a nonsequential text and submit receipt", () => {
			const fx = fixture();
			const { hmuxLog } = fx;
			const result = spawnSync(
				process.execPath,
				[cliPath, "send", "backend", "status"],
				spawnOptions(fx, { HMUX_FIXTURE_MODE: "nonsequential-receipt" }),
			);

			expect(result.status).toBe(1);
			expect(result.stderr).toContain("written_to_pty");
			const calls = readFileSync(hmuxLog, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]);
			expect(
				calls.filter((args) => args.includes("command-input")),
			).toHaveLength(1);
		});
	},
);
