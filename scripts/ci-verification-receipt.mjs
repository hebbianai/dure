#!/usr/bin/env node
// Behavior-receipt writer for the daily Hmux smoke canary
// (ci-hmux-smoke-canary.yml). The on-push detect/reuse/write/smoke-reuse
// subcommands died with the disabled CI verify job (2026-08-13 sweep);
// receipt READERS live in ./lib/ci-verification-receipt.mjs and are consumed
// by the artifact dispatcher and release product proof.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CI_HMUX_BACKGROUND_SMOKE_CAPABILITY,
  createBehaviorReceipt,
} from "./lib/ci-verification-receipt.mjs";

function repositoryRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

async function writeBehaviorReceipt(outputPath) {
  if (!outputPath) {
    throw new Error("behavior receipt output path is required");
  }
  // provenance 쌍 교차검증(fail-closed, 리뷰 발견 #3): 재사용으로 smoke를
  // 건너뛰었는데 근거 run id가 없으면, genuine처럼 보이는 영수증이 미래
  // 재사용 증거를 오염시킨다 — 그 상태는 기록 거부가 맞다.
  if (
    process.env.DURE_CI_BEHAVIOR_SMOKE_REUSE === "true" &&
    !process.env.DURE_CI_BEHAVIOR_REUSED_FROM_RUN
  ) {
    throw new Error(
      "smoke reuse was granted but no source run id was provided — refusing to mint a genuine-looking receipt",
    );
  }
  // smoke가 방금 실행됐다 = staged runtime이 존재한다 — fingerprint 계산이
  // 실패하면 인프라 결함이므로 조용히 생략하지 않고 실패시킨다(fail-closed).
  // lazy import 유지: fingerprint 모듈은 dependency-cruiser를 끌어온다.
  const {
    computeHmuxSmokeFingerprintManifest,
    hmuxSmokeFingerprint,
    hmuxSmokeFingerprintComponents,
  } = await import("./lib/hmux-smoke-fingerprint.mjs");
  const manifest = await computeHmuxSmokeFingerprintManifest(repositoryRoot());
  const receipt = createBehaviorReceipt({
    capabilities: [CI_HMUX_BACKGROUND_SMOKE_CAPABILITY],
    capabilityFingerprint: {
      schemaVersion: manifest.schemaVersion,
      fingerprint: hmuxSmokeFingerprint(manifest),
      components: hmuxSmokeFingerprintComponents(manifest),
    },
    reusedFromRunId: process.env.DURE_CI_BEHAVIOR_REUSED_FROM_RUN,
    runId: process.env.GITHUB_RUN_ID,
    verifiedHead: process.env.GITHUB_SHA,
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(
    `ci-verification-receipt: wrote ${receipt.capabilities.join(",")} behavior receipt to ${outputPath}\n`,
  );
}

async function main() {
  if (process.argv[2] === "write-behavior") {
    await writeBehaviorReceipt(process.argv[3]);
    return;
  }
  throw new Error("usage: ci-verification-receipt.mjs write-behavior <path>");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`ci-verification-receipt: ${error.message}\n`);
    process.exitCode = 1;
  });
}
