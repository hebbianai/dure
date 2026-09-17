import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  CI_HMUX_BACKGROUND_SMOKE_CAPABILITY,
  FINGERPRINT_COMPONENT_KEYS,
  parseBehaviorReceipt,
} from "./lib/ci-verification-receipt.mjs";
import { createHmuxSmokeTestRepository } from "./lib/hmux-smoke-test-runtime-fixture.mjs";

const CLI = fileURLToPath(
  new URL("./ci-verification-receipt.mjs", import.meta.url),
);
const temporaryDirectories = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let behaviorFixture;

beforeAll(() => {
  behaviorFixture = createHmuxSmokeTestRepository(repoRoot, [
    "ci-verification-receipt.mjs",
  ]);
});

afterAll(() => behaviorFixture?.cleanup());

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("CI verification receipt CLI", () => {
  test("writes behavior capability proof independently of product scopes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ci-behavior-cli-"));
    temporaryDirectories.push(root);
    const receiptPath = path.join(root, "receipt", "receipt.json");
    const result = spawnSync(
      process.execPath,
      [
        path.join(
          behaviorFixture.root,
          "scripts",
          "ci-verification-receipt.mjs",
        ),
        "write-behavior",
        receiptPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_RUN_ID: "43",
          GITHUB_SHA: "c".repeat(40),
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const receipt = parseBehaviorReceipt(fs.readFileSync(receiptPath, "utf8"));
    // capability fingerprint는 실행 시점의 실측값 — 형태만 계약으로 고정한다.
    expect(receipt.capabilityFingerprint.schemaVersion).toBe(4);
    // v2: 컴포넌트 breakdown이 항상 함께 내장된다(전 키 64-hex).
    expect(Object.keys(receipt.capabilityFingerprint.components).sort()).toEqual(
      [...FINGERPRINT_COMPONENT_KEYS].sort(),
    );
    expect(receipt.capabilityFingerprint.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt).toEqual({
      capabilities: [CI_HMUX_BACKGROUND_SMOKE_CAPABILITY],
      capabilityFingerprint: receipt.capabilityFingerprint,
      runId: "43",
      schema: "dure-ci-behavior/v1",
      verifiedHead: "c".repeat(40),
    });
  });

  test("재사용 승인·근거 불일치 상태의 영수증 기록은 거부된다 (fail-closed)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-reuse-pair-"));
    temporaryDirectories.push(root);
    const result = spawnSync(
      process.execPath,
      [CLI, "write-behavior", path.join(root, "receipt.json")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DURE_CI_BEHAVIOR_SMOKE_REUSE: "true",
          DURE_CI_BEHAVIOR_REUSED_FROM_RUN: "",
          GITHUB_RUN_ID: "43",
          GITHUB_SHA: "c".repeat(40),
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to mint");
    expect(fs.existsSync(path.join(root, "receipt.json"))).toBe(false);
  });
});

describe("CLI import closure (node_modules 없는 환경 계약)", () => {
  // fingerprint 모듈은 dependency-cruiser(서드파티)를 끌어온다. CLI의 static
  // import 폐포에 서드파티가 들어오면 node_modules 없는 환경에서 CLI 전체가
  // ERR_MODULE_NOT_FOUND로 죽는다(2026-08-01 76906c0a 실측). 서드파티가
  // 필요한 경로는 서브커맨드 안의 lazy `await import(...)`로만 접근한다.
  test("CLI 진입 폐포의 static import는 node 빌트인과 저장소 파일만 허용", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
    const staticImportPattern =
      /^(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|^import\s+["']([^"']+)["']/gm;
    const seen = new Set();
    const queue = [path.join(root, "ci-verification-receipt.mjs")];
    const bareViolations = [];
    while (queue.length > 0) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(staticImportPattern)) {
        const specifier = match[1] ?? match[2];
        if (specifier.startsWith("node:")) continue;
        if (specifier.startsWith(".")) {
          queue.push(path.resolve(path.dirname(file), specifier));
          continue;
        }
        bareViolations.push(`${path.relative(root, file)} -> ${specifier}`);
      }
    }
    expect(bareViolations).toEqual([]);
    // 폐포가 실제로 걸어졌는지 — 진입 파일만 보고 통과하는 false green 방지.
    expect(seen.size).toBeGreaterThan(3);
  });
});
