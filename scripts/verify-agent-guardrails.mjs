#!/usr/bin/env node
// CI checks release-owned versions, application identity and updater settings.
// This detects accidental edits; it is not repository access control.
//
// 사용: node scripts/verify-agent-guardrails.mjs <base-sha> <head-sha>
// base가 없거나 도달 불가면(force push·첫 push) HEAD^..HEAD로 폴백한다.
import { execFileSync } from "node:child_process";

const VERSION_FILES = [
  "package.json",
  "cli/package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "hmux/Cargo.toml",
];
// 박제 값·updater 설정 — 변경 자체가 사고로 간주되는 tauri.conf 키
const IDENTITY_KEYS = ["identifier", "productName", "pubkey", "endpoints", "createUpdaterArtifacts"];

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function tryGit(...args) {
  try {
    return git(...args);
  } catch {
    return null;
  }
}

let [base, head] = process.argv.slice(2);
if (!head) head = "HEAD";
if (!base || /^0+$/.test(base) || tryGit("cat-file", "-e", `${base}^{commit}`) === null) {
  base = `${head}^`;
}

const range = `${base}..${head}`;
const changed = (tryGit("diff", "--name-only", base, head) ?? "")
  .split("\n")
  .filter(Boolean);
const subjects = (tryGit("log", "--format=%s", range) ?? "").split("\n").filter(Boolean);
const isReleasePush = subjects.some((s) => /^release: v\d+\.\d+\.\d+/.test(s));
const allowsIdentityChange = subjects.some((s) => s.includes("[allow-identity-change]"));

let failed = false;

// 1) 버전 필드 변경은 release 커밋에서만
for (const file of VERSION_FILES) {
  if (!changed.includes(file)) continue;
  const diff = tryGit("diff", base, head, "--", file) ?? "";
  const versionTouched = /^[+-]\s*"?version"?\s*[:=]/m.test(diff);
  if (versionTouched && !isReleasePush) {
    console.error(
      `::error file=${file}::버전 필드는 release 워크플로만 변경한다 (release: vX.Y.Z 커밋 없이 변경됨)`,
    );
    failed = true;
  }
}

// 2) 앱 정체성·updater 설정은 박제 값
if (changed.includes("src-tauri/tauri.conf.json") && !isReleasePush && !allowsIdentityChange) {
  const diff = tryGit("diff", base, head, "--", "src-tauri/tauri.conf.json") ?? "";
  for (const key of IDENTITY_KEYS) {
    if (new RegExp(`^[+-]\\s*"${key}"`, "m").test(diff)) {
      console.error(
        `::error file=src-tauri/tauri.conf.json::"${key}"는 박제/updater 설정 — 의도된 변경이면 커밋 제목에 [allow-identity-change]를 명시`,
      );
      failed = true;
    }
  }
}

// 3) 워크플로 변경은 경고만 — 정당한 에이전트 작업이 많아 차단하지 않는다
const workflowChanges = changed.filter((f) => f.startsWith(".github/workflows/"));
if (workflowChanges.length > 0) {
  console.log(
    `::warning::workflow 변경 감지 (${workflowChanges.join(", ")}) — 시크릿 접근 표면이니 리뷰 대상`,
  );
}

if (failed) process.exit(1);
console.log(`agent guardrails ok (${range}, ${changed.length} files)`);
