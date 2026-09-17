import { describe, expect, it } from "vitest";
import {
	providerCapabilities,
	providerCapabilitiesFor,
	providerCapabilityScore,
	type ProviderCapabilityKey,
} from "@/lib/settings/providerCapabilities";
import { PROVIDER_IDS } from "@/lib/agents/providers";
import { PROVIDERS, type ProviderSpec } from "@/types";

const base: ProviderSpec = { label: "T", cmd: "t", credentialFiles: [] };
const find = (rows: ReturnType<typeof providerCapabilitiesFor>, key: ProviderCapabilityKey) =>
	rows.find((row) => row.key === key);

describe("providerCapabilitiesFor", () => {
	it("선언이 없으면 전부 미지원으로 둔다", () => {
		const rows = providerCapabilitiesFor(base);
		expect(rows.every((row) => !row.supported)).toBe(true);
		expect(rows.every((row) => row.detail === undefined)).toBe(true);
	});

	it("선언된 능력은 그것을 수행하는 문자열을 근거로 단다", () => {
		const rows = providerCapabilitiesFor({
			...base,
			resumeCmd: "t --continue",
			resumeId: (id) => `t --resume ${id}`,
			forkFlag: "--fork-session",
			skipPermFlag: "--yolo",
			configEnv: "T_CONFIG_DIR",
			accountUrl: "https://example.com/account",
		});
		expect(find(rows, "resume")).toMatchObject({ supported: true, detail: "t --continue" });
		expect(find(rows, "resumeById")?.detail).toContain("<id>");
		expect(find(rows, "fork")).toMatchObject({ supported: true, detail: "--fork-session" });
		expect(find(rows, "skipPermissions")?.detail).toBe("--yolo");
		expect(find(rows, "accountIsolation")?.detail).toBe("T_CONFIG_DIR");
		expect(find(rows, "accountPage")?.detail).toBe("https://example.com/account");
	});

	// 매니페스트에 ""가 들어가면 화면이 근거 없는 지원을 주장하게 된다.
	it("빈 문자열은 지원으로 세지 않는다", () => {
		const rows = providerCapabilitiesFor({ ...base, resumeCmd: "", skipPermFlag: "   " });
		expect(find(rows, "resume")?.supported).toBe(false);
		expect(find(rows, "skipPermissions")?.supported).toBe(false);
	});

	// loginCmd가 없어도 계정 분리를 지원하면 cmd 실행이 곧 로그인 경로다.
	it("로그인 명령이 없어도 계정 분리를 지원하면 실행 명령을 로그인 경로로 본다", () => {
		const rows = providerCapabilitiesFor({ ...base, configEnv: "T_CONFIG_DIR" });
		expect(find(rows, "login")).toMatchObject({ supported: true, detail: "t" });
	});

	it("계정 분리도 로그인 명령도 없으면 로그인 경로를 주장하지 않는다", () => {
		expect(find(providerCapabilitiesFor(base), "login")?.supported).toBe(false);
	});
});

describe("매니페스트 위생", () => {
	// 칩에 그대로 실려 사용자가 터미널에 옮겨 적는 값이다 — 산문이 섞이면
	// 복사해서 쓸 수 없고, "지원함"이라는 주장만 남는다.
	const COMMAND_FIELDS = ["resumeCmd", "loginCmd", "mcpSetup", "headlessFlag"] as const;

	it("명령 문자열에 산문을 섞지 않는다", () => {
		for (const provider of PROVIDER_IDS) {
			const spec = PROVIDERS[provider];
			for (const field of COMMAND_FIELDS) {
				const value = spec[field];
				if (typeof value !== "string") continue;
				expect(value, `${provider}.${field}`).not.toMatch(/[가-힣]/);
				expect(value, `${provider}.${field}`).not.toMatch(/[;→]|\.\s/);
			}
		}
	});

	// forkFlag는 이름 그대로 플래그다 — copy_and_flag 모드에서 실행 명령에 그대로
	// 덧붙으므로, 명령 문자열을 넣으면 "codex -C . fork <id> codex fork {id}"처럼
	// 명령이 두 번 붙어 깨진다(2026-08-11 실측).
	it("플래그 자리에는 플래그만 들어간다", () => {
		for (const provider of PROVIDER_IDS) {
			const spec = PROVIDERS[provider];
			for (const field of ["forkFlag", "skipPermFlag"] as const) {
				const value = spec[field];
				if (typeof value !== "string") continue;
				expect(value, `${provider}.${field}`).toMatch(/^-/);
			}
		}
	});

	// 실행에 쓰이는 명령이 다른 실행 파일로 시작하면 그 명령은 그냥 실패한다.
	it("실행 명령은 그 provider의 실행 파일로 시작한다", () => {
		for (const provider of PROVIDER_IDS) {
			const spec = PROVIDERS[provider];
			const binary = spec.cmd.split(" ")[0];
			for (const value of [spec.resumeCmd, spec.loginCmd, spec.resumeId?.("X")]) {
				if (typeof value !== "string" || value.startsWith("-")) continue;
				expect(value.split(" ")[0], `${provider}: ${value}`).toBe(binary);
			}
		}
	});
});

describe("providerCapabilities", () => {
	it("모든 provider가 같은 축을 같은 순서로 답한다", () => {
		const shape = providerCapabilities(PROVIDER_IDS[0]).map((row) => row.key);
		for (const provider of PROVIDER_IDS) {
			expect(providerCapabilities(provider).map((row) => row.key)).toEqual(shape);
		}
	});

	// 이 화면의 존재 이유가 "설치된 CLI 전부"라, 매니페스트의 모든 provider가
	// 답할 수 있어야 한다 — 던지거나 빈 배열이 나오면 그 provider만 빈칸이 된다.
	it("매니페스트의 모든 provider가 능력 표를 낸다", () => {
		for (const provider of PROVIDER_IDS) {
			const rows = providerCapabilities(provider);
			expect(rows.length).toBeGreaterThan(0);
			const score = providerCapabilityScore(provider);
			expect(score.total).toBe(rows.length);
			expect(score.supported).toBeLessThanOrEqual(score.total);
		}
	});

	it("core provider는 최소한 이어가기와 계정 분리를 선언한다", () => {
		for (const provider of PROVIDER_IDS.filter((id) => PROVIDERS[id].core)) {
			const rows = providerCapabilities(provider);
			expect(find(rows, "resume")?.supported).toBe(true);
			expect(find(rows, "accountIsolation")?.supported).toBe(true);
		}
	});
});
