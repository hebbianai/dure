#!/usr/bin/env node
// 릴리스 첫 게이트: 태그(vX.Y.Z)와 5개 버전 파일이 정확히 일치하는지 검증한다.
// 사용: node scripts/verify-release-state.mjs v0.2.0
import { readUnifiedVersion } from "./lib/release-version.mjs";

const tag = process.argv[2] ?? "";
const match = tag.match(/^v(\d+\.\d+\.\d+)$/);
if (!match) {
  console.error(`usage: verify-release-state.mjs v<semver> (got: ${tag || "<none>"})`);
  process.exit(2);
}

const version = readUnifiedVersion();
if (version !== match[1]) {
  console.error(`태그 ${tag} ≠ 소스 버전 ${version}`);
  process.exit(1);
}
console.log(`release state ok: ${tag} == ${version} (5 files)`);
