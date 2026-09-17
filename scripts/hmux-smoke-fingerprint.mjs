#!/usr/bin/env node
// Hmux smoke capability fingerprint CLI — 1단계는 관측 전용이다.
// 사용: node scripts/hmux-smoke-fingerprint.mjs [--manifest]
// 2단계에서 receipt finalizer가 이 출력을 재사용 키로 소비한다.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeHmuxSmokeFingerprintManifest,
  hmuxSmokeFingerprint,
} from "./lib/hmux-smoke-fingerprint.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await computeHmuxSmokeFingerprintManifest(root);
const fingerprint = hmuxSmokeFingerprint(manifest);

if (process.argv.includes("--manifest")) {
  process.stdout.write(`${JSON.stringify({ fingerprint, manifest }, null, 2)}\n`);
} else {
  process.stdout.write(
    `${JSON.stringify({
      fingerprint,
      schemaVersion: manifest.schemaVersion,
      sources: manifest.sources.length,
      adapterSources: manifest.adapterSources.length,
      runtimeSources: manifest.runtimeSources.length,
      harnessSources: manifest.harness.sources.length,
      entrypoints: manifest.entrypoints.length,
    })}\n`,
  );
}
