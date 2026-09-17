// dure hooks — SessionStart 훅 등록/해제의 계약.
// 불변식: (1) additive — 타 훅(bd prime 등)을 절대 건드리지 않는다,
// (2) 설치/삭제 대칭, (3) idempotent, (4) 깨진 settings.json은 손대지 않고
// 실패, (5) --hook-json은 Dure pane 밖(세션 env 없음)에서 침묵한다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CLI = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../cli/dure.mjs",
);
const temporaryDirectories = [];
afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

function run(cwd, args, env = {}) {
	return spawnSync(process.execPath, [CLI, ...args], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			HOME: cwd,
			DURE_HOME: path.join(cwd, "app-home"),
			DURE_APP_CHANNEL: "stable",
			DURE_INVOKED_AS: "dure",
			HEBBIAN_AGENT: "",
			HEBBIAN_SESSION: "",
			HMUX_SESSION_ID: "",
			...env,
		},
	});
}

function writeRegistry(root, value) {
	const appRoot = path.join(root, "app-home");
	fs.mkdirSync(appRoot, { recursive: true });
	fs.writeFileSync(
		path.join(appRoot, "agents.json"),
		typeof value === "string" ? value : JSON.stringify(value),
	);
}

function settingsIn(root) {
	return JSON.parse(
		fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"),
	);
}

describe("dure hooks", () => {
	it("gemini settings.json에 additive로 동거하고 타 도구 훅을 보존한다", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-hooks-"));
		temporaryDirectories.push(root);
		// gemini 설정은 훅 전용 파일이 아니다 — theme·타 도구 훅과 동거.
		fs.mkdirSync(path.join(root, ".gemini"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".gemini", "settings.json"),
			JSON.stringify({
				theme: "Default",
				hooks: {
					BeforeAgent: [{ hooks: [{ type: "command", command: "orca-hook" }] }],
				},
			}),
		);
		expect(run(root, ["hooks", "install"]).status).toBe(0);
		const gemini = JSON.parse(
			fs.readFileSync(path.join(root, ".gemini", "settings.json"), "utf8"),
		);
		expect(gemini.theme).toBe("Default");
		expect(gemini.hooks.BeforeAgent).toHaveLength(1);
		expect(gemini.hooks.SessionStart).toHaveLength(1);
		expect(run(root, ["hooks", "uninstall"]).status).toBe(0);
		const removed = JSON.parse(
			fs.readFileSync(path.join(root, ".gemini", "settings.json"), "utf8"),
		);
		expect(removed.hooks.SessionStart).toBeUndefined();
		expect(removed.hooks.BeforeAgent).toHaveLength(1);
	});

	it("설정 디렉터리가 없는 provider는 건너뛴다 — 없는 도구의 트리를 만들지 않는다", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-hooks-"));
		temporaryDirectories.push(root);
		const result = run(root, ["hooks", "install"]);
		expect(result.status).toBe(0);
		expect(fs.existsSync(path.join(root, ".codex"))).toBe(false);
		expect(fs.existsSync(path.join(root, ".gemini"))).toBe(false);
		// claude는 1차 provider라 항상 생성된다.
		expect(settingsIn(root).hooks.SessionStart).toHaveLength(1);
	});

	it("codex 훅도 함께 등록·해제되고 타 도구 훅(orca류)을 보존한다", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-hooks-"));
		temporaryDirectories.push(root);
		fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".codex", "hooks.json"),
			JSON.stringify({
				hooks: {
					Stop: [{ hooks: [{ type: "command", command: "other-tool stop" }] }],
				},
			}),
		);
		expect(run(root, ["hooks", "install"]).status).toBe(0);
		const codex = JSON.parse(
			fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf8"),
		);
		expect(codex.hooks.SessionStart).toHaveLength(1);
		expect(codex.hooks.SessionStart[0].matcher).toBe("startup|resume|clear");
		expect(codex.hooks.Stop).toHaveLength(1); // 타 도구 훅 불가침
		// claude 쪽도 같이 만들어졌다
		expect(settingsIn(root).hooks.SessionStart).toHaveLength(1);
		expect(run(root, ["hooks", "uninstall"]).status).toBe(0);
		const removed = JSON.parse(
			fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf8"),
		);
		expect(removed.hooks.SessionStart).toBeUndefined();
		expect(removed.hooks.Stop).toHaveLength(1);
	});

	it("등록·해제가 대칭이고 타 훅을 보존한다", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-hooks-"));
		temporaryDirectories.push(root);
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".claude", "settings.json"),
			JSON.stringify({
				hooks: {
					SessionStart: [
						{ matcher: "", hooks: [{ type: "command", command: "bd prime --hook-json" }] },
					],
				},
				enabledPlugins: { x: true },
			}),
		);
		expect(run(root, ["hooks", "install"]).status).toBe(0);
		const installed = settingsIn(root);
		expect(installed.hooks.SessionStart).toHaveLength(2);
		expect(installed.enabledPlugins).toEqual({ x: true });
		// idempotent
		expect(run(root, ["hooks", "install"]).status).toBe(0);
		expect(settingsIn(root).hooks.SessionStart).toHaveLength(2);
		// 대칭 제거 — bd prime은 그대로
		expect(run(root, ["hooks", "uninstall"]).status).toBe(0);
		const removed = settingsIn(root);
		expect(removed.hooks.SessionStart).toHaveLength(1);
		expect(removed.hooks.SessionStart[0].hooks[0].command).toContain("bd prime");
	});

	it("settings.json이 없으면 만들고, 깨져 있으면 손대지 않는다", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-hooks-"));
		temporaryDirectories.push(root);
		expect(run(root, ["hooks", "install"]).status).toBe(0);
		expect(
			settingsIn(root).hooks.SessionStart[0].hooks[0].command,
		).toBe("dure checkpoint --hook-json");
		fs.writeFileSync(path.join(root, ".claude", "settings.json"), "{broken");
		const result = run(root, ["hooks", "install"]);
		expect(result.status).not.toBe(0);
		expect(
			fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"),
		).toBe("{broken");
	});

	it("--hook-json은 Dure pane 밖에서 침묵한다 (전역 등록 안전성)", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-hooks-"));
		temporaryDirectories.push(root);
		const result = run(root, ["checkpoint", "--hook-json"]);
		expect(result.status).toBe(0);
		// no-op JSON — Gemini는 훅 stdout이 유효 JSON이어야 한다(빈 출력은 경고).
		expect(result.stdout).toBe("{}\n");
		expect(result.stderr).toBe("");
	});

	it.each([
		["없는 레지스트리", undefined],
		["깨진 레지스트리", "{broken"],
		["현재 세션이 없는 레지스트리", { agents: [] }],
		["원소가 깨진 레지스트리", { agents: [null] }],
	])("--hook-json은 %s에서도 침묵한다", (_label, registry) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-hooks-"));
		temporaryDirectories.push(root);
		if (registry !== undefined) writeRegistry(root, registry);
		const result = run(root, ["checkpoint", "--hook-json"], {
			HMUX_SESSION_ID: "session-1",
		});
		expect(result.status).toBe(0);
		// no-op JSON — Gemini는 훅 stdout이 유효 JSON이어야 한다(빈 출력은 경고).
		expect(result.stdout).toBe("{}\n");
		expect(result.stderr).toBe("");
	});

	it.each([
		["잘못된 app channel", { DURE_APP_CHANNEL: "../escape" }],
		["deprecated 호출 이름", { DURE_INVOKED_AS: "hebbian-ide" }],
	])("--hook-json은 %s 환경도 외부로 새지 않는다", (_label, env) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-hooks-"));
		temporaryDirectories.push(root);
		const result = run(root, ["checkpoint", "--hook-json"], env);
		expect(result.status).toBe(0);
		// no-op JSON — Gemini는 훅 stdout이 유효 JSON이어야 한다(빈 출력은 경고).
		expect(result.stdout).toBe("{}\n");
		expect(result.stderr).toBe("");
	});

	it("실제 parser가 소비한 --hook-json은 fail-open으로 오인하지 않는다", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-hooks-"));
		temporaryDirectories.push(root);
		const result = run(root, ["checkpoint", "--agent", "--hook-json"], {
			DURE_APP_CHANNEL: "../escape",
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("DURE_APP_CHANNEL");
	});

	it("빈 canonical channel도 legacy 값으로 대체하지 않는다", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-hooks-"));
		temporaryDirectories.push(root);
		const result = run(root, ["ls"], {
			DURE_APP_CHANNEL: "",
			HEBBIAN_APP_CHANNEL: "stable",
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("DURE_APP_CHANNEL");
	});

	it("--hook-json은 세션 안에서도 no-op JSON만 낸다 (체크포인트 폐기)", () => {
		// The checkpoint discipline retired 2026-08-27 — the line was never read
		// and agent self-narration duplicated the attention authority. Hooks
		// stay registered until uninstalled, so the command must keep emitting
		// valid no-op JSON (Gemini requires parseable stdout).
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-hooks-"));
		temporaryDirectories.push(root);
		writeRegistry(root, {
			agents: [
				{
					name: "agent-1",
					displayName: "Hmux agent",
					sessionId: "session-1",
				},
			],
		});
		const result = run(root, ["checkpoint", "--hook-json"], {
			HMUX_SESSION_ID: "session-1",
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({});
	});
});
