import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function directory(path) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	return path;
}

function source(path, records) {
	writeFileSync(path, `${records.map(JSON.stringify).join("\n")}\n`, {
		mode: 0o600,
	});
	const modified = new Date(Date.now() - 60 * 60 * 1000);
	utimesSync(path, modified, modified);
}

describe("snapshot-first-run-provider-sessions", () => {
	it("writes bounded synthetic records without copying transcript content", () => {
		const root = mkdtempSync(join(tmpdir(), "dure-onboarding-snapshot-test-"));
		roots.push(root);
		const claude = directory(join(root, "source-claude"));
		const codex = directory(join(root, "source-codex"));
		const cwd = join(root, "repo");
		directory(cwd);
		source(join(claude, "claude-session.jsonl"), [
			{ type: "assistant", cwd, message: { content: "CLAUDE_SECRET_BODY" } },
			{ type: "user", cwd, message: { content: "safe claude title" } },
		]);
		source(join(codex, "codex-session.jsonl"), [
			{ type: "session_meta", payload: { id: "codex-session", cwd } },
			{
				type: "response_item",
				payload: { type: "message", role: "assistant", content: "CODEX_SECRET_BODY" },
			},
			{
				type: "response_item",
				payload: { type: "message", role: "user", content: "safe codex title" },
			},
		]);

		const result = JSON.parse(
			execFileSync(
				process.execPath,
				[
					"scripts/qa/snapshot-first-run-provider-sessions.mjs",
					"--root",
					root,
					"--claude-projects",
					claude,
					"--codex-sessions",
					codex,
					"--cwd-prefix",
					cwd,
					"--min-age-hours",
					"0",
					"--max-claude",
					"1",
					"--max-codex",
					"1",
				],
				{ encoding: "utf8" },
			),
		);
		expect(result).toMatchObject({ claude: 1, codex: 1 });

		const claudeOutput = readFileSync(
			join(root, "home", ".claude", "projects", "snapshot", "claude-session.jsonl"),
			"utf8",
		);
		const codexDirectory = join(root, "home", ".codex", "sessions", "snapshot");
		const codexOutput = readFileSync(
			join(codexDirectory, readdirSync(codexDirectory)[0]),
			"utf8",
		);
		expect(claudeOutput).toContain("safe claude title");
		expect(codexOutput).toContain("safe codex title");
		expect(claudeOutput).not.toContain("CLAUDE_SECRET_BODY");
		expect(codexOutput).not.toContain("CODEX_SECRET_BODY");
	});

	it("supports a filesystem-root scan beyond the small smoke-fixture limit", () => {
		const root = mkdtempSync(join(tmpdir(), "dure-onboarding-snapshot-test-"));
		roots.push(root);
		const claude = directory(join(root, "source-claude"));
		const codex = directory(join(root, "source-codex"));
		const cwd = join(root, "repo");
		directory(cwd);
		for (let index = 0; index < 11; index += 1) {
			source(join(claude, `claude-session-${index}.jsonl`), [
				{
					type: "user",
					cwd,
					message: { content: `safe claude title ${index}` },
				},
			]);
		}

		const result = JSON.parse(
			execFileSync(
				process.execPath,
				[
					"scripts/qa/snapshot-first-run-provider-sessions.mjs",
					"--root",
					root,
					"--claude-projects",
					claude,
					"--codex-sessions",
					codex,
					"--cwd-prefix",
					"/",
					"--min-age-hours",
					"0",
					"--max-claude",
					"11",
					"--max-codex",
					"0",
				],
				{ encoding: "utf8" },
			),
		);
		expect(result).toMatchObject({ claude: 11, codex: 0 });
		expect(
			readdirSync(join(root, "home", ".claude", "projects", "snapshot")),
		).toHaveLength(11);
	});
});
