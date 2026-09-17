// capability fingerprint 1단계 계약 테스트 — false green의 원천을 막는다.
//
// 보증하는 불변식:
// 1) 분류기 경로 목록의 드리프트(죽은 경로·빈 접두)는 파생 시점에 throw.
// 2) 소스 폐포는 손 목록이 아니라 그래프에서 나오고, 알려진 심층 모듈을
//    반드시 포함하며, 빈/축소 폐포는 실패다.
// 3) staged 런타임 바이너리가 없으면 fingerprint 계산을 거부한다.
// 4) 결정적이며, 입력이 달라지면 fingerprint가 달라진다.

import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FRONTEND_RUNTIME_PATHS,
} from "./hmux-background-smoke-scope.mjs";
import { FINGERPRINT_COMPONENT_KEYS } from "./ci-verification-receipt.mjs";
import {
  computeHmuxSmokeFingerprintManifest,
  deriveHmuxSmokeHarness,
  expandHmuxSmokeEntrypoints,
  hmuxSmokeFingerprint,
  hmuxSmokeFingerprintComponents,
  HMUX_SMOKE_FINGERPRINT_SCHEMA_VERSION,
} from "./hmux-smoke-fingerprint.mjs";
import { createHmuxSmokeTestRepository } from "./hmux-smoke-test-runtime-fixture.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const temporaryRoots = [];
let fingerprintFixture;
beforeAll(() => {
  fingerprintFixture = createHmuxSmokeTestRepository(repoRoot, [
    "hmux-smoke-fingerprint.mjs",
  ]);
});
afterAll(() => {
  fingerprintFixture?.cleanup();
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

describe("hmux smoke fingerprint (phase 1)", () => {
  it("분류기 목록의 모든 경로가 실존하는 entrypoint로 확장된다", () => {
    const entrypoints = expandHmuxSmokeEntrypoints(repoRoot);
    for (const exact of FRONTEND_RUNTIME_PATHS) {
      expect(entrypoints).toContain(exact);
    }
    // 접두 확장이 실제 파일을 찾았는지 — 대표 표면 하나씩.
    expect(entrypoints.some((p) => p.startsWith("src/lib/terminal/"))).toBe(true);
    expect(entrypoints.some((p) => p.startsWith("src/components/terminal/Terminal"))).toBe(true);
  });

  it("드리프트(존재하지 않는 목록 경로)는 조용히 넘어가지 않고 throw한다", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "hmux-fp-drift-"));
    temporaryRoots.push(fixture);
    // 빈 픽스처 루트 — 분류기 목록의 어떤 경로도 없다.
    expect(() => expandHmuxSmokeEntrypoints(fixture)).toThrow(/entrypoint drift/);
  });

  it("manifest: 폐포가 그래프에서 파생되고 심층 모듈을 포함한다", async () => {
    const manifest = await computeHmuxSmokeFingerprintManifest(
      fingerprintFixture.root,
    );
    expect(manifest.schemaVersion).toBe(HMUX_SMOKE_FINGERPRINT_SCHEMA_VERSION);
    const paths = manifest.sources.map((s) => s.path);
    // 손 목록엔 없지만 행동에 필수인 심층 모듈 — 그래프만이 찾을 수 있다.
    expect(paths).toContain(
      "src/lib/terminal/protocol/terminalStateProtocol.ts",
    );
    expect(paths).toContain("src/lib/ipc/hmux.ts");
    // 폐포 하한은 모듈이 보증하지만, 스키마 소비자를 위해 재확인.
    expect(paths.length).toBeGreaterThan(60);
    // v3: 산출물 해시 대신 런타임 소스 서술 — 워크스페이스와 경로 의존
    // crates가 들어오고 빌드 산출물은 제외된다. rustc 버전도 입력이다.
    const runtimePaths = manifest.runtimeSources.map((s) => s.path);
    expect(runtimePaths).toContain("hmux/crates/hmux-runtime/src/main.rs");
    expect(runtimePaths).toContain("hmux/Cargo.lock");
    expect(
      runtimePaths.some((p) => p.startsWith("crates/hebbian-process-sampler/")),
    ).toBe(true);
    expect(runtimePaths).toContain("crates/dure-app/control-plane/src/main.rs");
    expect(runtimePaths.some((p) => p.includes("/target/"))).toBe(false);
    expect(manifest.toolchain.rustc).toMatch(/^rustc /);
  }, 120_000);

  it("staged 런타임이 없으면 fingerprint 계산을 거부한다", async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "hmux-fp-nobin-"));
    temporaryRoots.push(fixture);
    // 소스 폐포는 통과 가능하되 바이너리만 없는 루트를 흉내내기엔 전체 복사가
    // 과하다 — entrypoint 확장 전에 바이너리 검사가 걸리도록 최소 구조만 복사.
    for (const seed of ["src/main.tsx", "tsconfig.json", "package.json"]) {
      cpSync(path.join(repoRoot, seed), path.join(fixture, seed), {
        recursive: true,
      });
    }
    await expect(
      computeHmuxSmokeFingerprintManifest(fixture),
    ).rejects.toThrow(/drift|staged runtime/);
  });

  it("결정적이고 입력에 민감하다", async () => {
    const manifest = await computeHmuxSmokeFingerprintManifest(
      fingerprintFixture.root,
    );
    const first = hmuxSmokeFingerprint(manifest);
    const second = hmuxSmokeFingerprint(
      JSON.parse(JSON.stringify(manifest)),
    );
    expect(second).toBe(first);
    const mutated = {
      ...manifest,
      sources: manifest.sources.map((s, i) =>
        i === 0 ? { ...s, sha256: "0".repeat(64) } : s,
      ),
    };
    expect(hmuxSmokeFingerprint(mutated)).not.toBe(first);
    const runtimeMutated = {
      ...manifest,
      runtimeSources: manifest.runtimeSources.map((b, i) =>
        i === 0 ? { ...b, sha256: "f".repeat(64) } : b,
      ),
    };
    expect(hmuxSmokeFingerprint(runtimeMutated)).not.toBe(first);
  }, 120_000);
});

describe("v2: adapter sources + 컴포넌트 정합", () => {
  it("컴포넌트 키는 receipt 모듈의 단일 출처와 정합한다 (파생+검증)", () => {
    const fake = {
      entrypoints: [],
      sources: [],
      adapterSources: [],
      runtimeSources: [],
      harness: {},
      toolchain: {},
      os: {},
    };
    expect(Object.keys(hmuxSmokeFingerprintComponents(fake))).toEqual([
      ...FINGERPRINT_COMPONENT_KEYS,
    ]);
    // manifest 필드 누락 = 스키마 정합 붕괴 — 조용한 부분 breakdown 금지.
    const { adapterSources: _dropped, ...missing } = fake;
    expect(() => hmuxSmokeFingerprintComponents(missing)).toThrow(
      /component missing/,
    );
  });

  it("manifest가 어댑터 소스를 포함하고 빌드 산출물은 제외한다", async () => {
    const manifest = await computeHmuxSmokeFingerprintManifest(
      fingerprintFixture.root,
    );
    const adapterPaths = manifest.adapterSources.map((s) => s.path);
    expect(adapterPaths).toContain("src-tauri/src/lib.rs");
    expect(adapterPaths).toContain("src-tauri/Cargo.lock");
    expect(adapterPaths).toContain("src-tauri/tauri.conf.json");
    expect(
      adapterPaths.some(
        (p) =>
          p.startsWith("src-tauri/target/") || p.startsWith("src-tauri/binaries/"),
      ),
    ).toBe(false);
    // 어댑터 소스 변경은 fingerprint를 바꾼다 — v1의 사각지대 회귀 방지.
    const first = hmuxSmokeFingerprint(manifest);
    const mutated = {
      ...manifest,
      adapterSources: manifest.adapterSources.map((s, i) =>
        i === 0 ? { ...s, sha256: "0".repeat(64) } : s,
      ),
    };
    expect(hmuxSmokeFingerprint(mutated)).not.toBe(first);
  }, 120_000);
});

describe("v4: smoke harness + installer execution inputs", () => {
  it("실제 shell/JS 폐포와 isolated CLI 설치 입력만 파생한다", async () => {
    const harness = await deriveHmuxSmokeHarness(fingerprintFixture.root, {});
    const paths = harness.sources.map((source) => source.path);
    expect(paths).toContain("scripts/qa/hmux-window-background-smoke.sh");
    expect(paths).toContain("scripts/qa/lib/tauri-app-runner.sh");
    expect(paths).toContain("scripts/qa/lib/tauri-app-launch.mjs");
    expect(paths).toContain("scripts/lib/dev-launch-supervisor.mjs");
    expect(paths).toContain("scripts/install-dure-cli.mjs");
    expect(paths).toContain("scripts/lib/dure-cli-install-paths.mjs");
    expect(paths).toContain("cli/lib/dure-cli-promotion.mjs");
    expect(paths).toContain("scripts/stage-hmux-runtime.sh");
    expect(paths).toContain("scripts/guard-hmux-app-stage.mjs");
    expect(paths).toContain("scripts/lib/hmux-app-stage-admission.mjs");
    expect(paths).toContain("scripts/hmux-dev-build-id.mjs");
    expect(paths).toContain("scripts/native/atomic-directory-move.py");
    expect(paths).toContain("cli/dure.mjs");
    // The installer copies all cli/lib bytes, including test-named payloads.
    expect(paths).toContain("cli/lib/provider-launch-selection.test.mjs");
    // Unreachable tests outside the installed payload remain excluded.
    expect(paths).not.toContain("scripts/lib/hmux-smoke-fingerprint.test.mjs");
    expect(paths).not.toContain("scripts/lib/dev-deploy-executor.test.mjs");
    expect(harness.packageScripts).toEqual({
      "test:hmux-window-background":
        "sh scripts/qa/hmux-window-background-smoke.sh",
      "hmux:runtime:stage:dev": "sh scripts/stage-hmux-runtime.sh debug",
    });
  });

  it("installer source 변경은 harness fingerprint를 바꾼다", async () => {
    const fixture = createHmuxSmokeTestRepository(repoRoot);
    try {
      const first = await deriveHmuxSmokeHarness(fixture.root, {});
      appendFileSync(
        path.join(fixture.root, "scripts/install-dure-cli.mjs"),
        "\n// fingerprint mutation witness\n",
      );
      const second = await deriveHmuxSmokeHarness(fixture.root, {});
      expect(hmuxSmokeFingerprint({ harness: second })).not.toBe(
        hmuxSmokeFingerprint({ harness: first }),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it.each(["run-dev-launch-child.mjs", "run-process-group-witness.mjs"])(
    "includes the executed restart child %s in the harness fingerprint",
    async (entry) => {
      const fixture = createHmuxSmokeTestRepository(repoRoot);
      try {
        const first = await deriveHmuxSmokeHarness(fixture.root, {});
        appendFileSync(
          path.join(fixture.root, "scripts", entry),
          "\n// Restart child input mutation witness.\n",
        );
        const second = await deriveHmuxSmokeHarness(fixture.root, {});
        expect(hmuxSmokeFingerprint({ harness: second })).not.toBe(
          hmuxSmokeFingerprint({ harness: first }),
        );
      } finally {
        fixture.cleanup();
      }
    },
  );

  it("native harness resources change the harness fingerprint", async () => {
    const fixture = createHmuxSmokeTestRepository(repoRoot);
    try {
      const first = await deriveHmuxSmokeHarness(fixture.root, {});
      appendFileSync(
        path.join(fixture.root, "scripts/native/atomic-directory-move.py"),
        "\n# fingerprint mutation witness\n",
      );
      const second = await deriveHmuxSmokeHarness(fixture.root, {});
      expect(hmuxSmokeFingerprint({ harness: second })).not.toBe(
        hmuxSmokeFingerprint({ harness: first }),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("CARGO_TARGET_DIR 해석은 raw host path 없이 fingerprint에 결합된다", async () => {
    const first = await deriveHmuxSmokeHarness(fingerprintFixture.root, {});
    const privateTarget = path.join(
      os.tmpdir(),
      "private-hmux-smoke-cargo-target",
    );
    const second = await deriveHmuxSmokeHarness(fingerprintFixture.root, {
      CARGO_TARGET_DIR: privateTarget,
    });
    expect(second.executionInputs.cargoTargetDirectory.mode).toBe("absolute");
    expect(second.executionInputs.cargoTargetDirectory).not.toEqual(
      first.executionInputs.cargoTargetDirectory,
    );
    expect(hmuxSmokeFingerprint({ harness: second })).not.toBe(
      hmuxSmokeFingerprint({ harness: first }),
    );
    const serialized = JSON.stringify(second);
    expect(serialized).not.toContain(privateTarget);
    expect(serialized).not.toContain(fingerprintFixture.root);
  });
});

// 관측 CLI가 manifest 스키마 변경에서 뒤처지지 않게 실제로 실행해 본다 —
// v3 랜딩 때 CLI가 제거된 stagedRuntimes 필드를 읽다 죽은 실측 회귀.
import { execFileSync } from "node:child_process";
describe("관측 CLI 스키마 정합", () => {
  it("hmux-smoke-fingerprint CLI가 현재 manifest로 실행된다", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(fingerprintFixture.root, "scripts/hmux-smoke-fingerprint.mjs")],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe(HMUX_SMOKE_FINGERPRINT_SCHEMA_VERSION);
    expect(parsed.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.runtimeSources).toBeGreaterThan(0);
  }, 120_000);
});
