// Hmux background smoke의 capability fingerprint — 1단계(파생 manifest).
//
// 목표: smoke 유효성의 입력을 commit SHA가 아니라 "행동을 결정하는 실제
// 입력"으로 서술한다. 2단계에서 receipt가 이 fingerprint를 키로 smoke
// 재사용을 활성화한다(이 파일은 아직 어떤 게이트 동작도 바꾸지 않는다).
//
// 설계 원칙 (2026-08-01 lib 재배치에서 실측된 드리프트 사고 기반):
// - 손 목록은 드리프트한다 → 소스 폐포는 dependency-cruiser 도달성으로
//   "파생"한다. 분류기의 경로 목록은 entrypoint 정의로만 쓰고, 그 각
//   항목이 실존하지 않으면(=드리프트) 즉시 throw한다 — false green의
//   원천을 파생 시점에 차단한다(fail-closed).
// - smoke가 검증하는 것은 소스가 아니라 조합된 런타임이다 → staged hmux
//   runtime 바이너리 해시, node 메이저, coarse OS를 fingerprint에 포함한다.
// - 바이너리가 스테이징돼 있지 않으면 fingerprint는 계산을 거부한다 —
//   모르는 입력으로 만든 키는 재사용 근거가 될 수 없다.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { cruise } from "dependency-cruiser";
// 컴포넌트 키의 단일 출처는 receipt 모듈이다(빌트인 전용이라 이 방향의
// import만 안전하다 — 역방향은 dependency-cruiser를 no-install classify에
// 끌어들인다). 정합은 계약 테스트가 강제한다.
import { FINGERPRINT_COMPONENT_KEYS } from "./ci-verification-receipt.mjs";
import {
  FRONTEND_RUNTIME_PATHS,
  FRONTEND_RUNTIME_PREFIXES,
} from "./hmux-background-smoke-scope.mjs";
import { isHmuxTestOnlyPath } from "./hmux-test-only-path.mjs";

// v2: smoke가 컴파일·실행하는 src-tauri 어댑터 소스를 manifest에 포함.
// v1은 frontend 폐포+staged 바이너리만 봐서 어댑터 전용 변경이 재사용을
// 잘못 승인받을 수 있었다(2026-08-01 리뷰 패널 실측).
// v3: staged 바이너리 "해시"를 hmux 런타임 소스 트리 해시 + rustc 버전으로
// 대체. cargo clean 재빌드가 같은 머신에서도 다른 바이트를 내는 것이
// 실측돼(2026-08-01), 산출물 해시는 캐시 축출·러너 인스턴스 경계마다
// 재사용을 헛되이 무산시킨다. frontend와 같은 철학 — 산출물이 아니라
// 입력을 서술한다. 바이너리 존재 검사는 전제조건으로 유지된다.
// v4: smoke가 실제로 실행하는 QA shell/JS 폐포, isolated Dure CLI 설치 입력,
// stage 명령과 privacy-safe build-path 입력을 harness 컴포넌트로 포함한다.
// v3는 installer나 CARGO_TARGET_DIR 해석이 바뀌어도 같은 receipt를 재사용할
// 수 있었다(2026-08-04 control-plane canary 수동 복구에서 실측).
// 버전 불일치 영수증은 판정기가 제외하므로 구 영수증은 자연 은퇴한다.
export const HMUX_SMOKE_FINGERPRINT_SCHEMA_VERSION = 4;

const STAGED_RUNTIME_DIR = "src-tauri/binaries";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
// 폐포가 이보다 작으면 그래프 해석이 조용히 죽은 것이다(빈 폐포 false pass 방지).
const MINIMUM_CLOSURE_SIZE = 60;

const HARNESS_SHELL_ENTRYPOINTS = [
  "scripts/qa/hmux-window-background-smoke.sh",
  "scripts/qa/lib/hmux-window-focus-runner.sh",
  "scripts/qa/lib/tauri-app-runner.sh",
  // tauri-app-runner reaches this through the package-script indirection below.
  "scripts/stage-hmux-runtime.sh",
];
const HARNESS_JAVASCRIPT_ENTRYPOINTS = [
  "scripts/guard-hmux-app-stage.mjs",
  // The supervisor launches these files as processes, not module imports.
  "scripts/run-dev-launch-child.mjs",
  "scripts/run-process-group-witness.mjs",
];
const HARNESS_PACKAGE_SCRIPTS = [
  "test:hmux-window-background",
  "hmux:runtime:stage:dev",
];
const CLI_INSTALL_INPUTS = [
  "cli/package.json",
  "cli/dure.mjs",
  "cli/lib",
  "cli/skills",
];
const HARNESS_RESOURCE_INPUTS = ["scripts/native/atomic-directory-move.py"];
const SHELL_SCRIPT_REFERENCE = /scripts\/[A-Za-z0-9_./-]+\.(?:mjs|sh)/g;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function portablePathDigest(root, pathname) {
  const resolved = path.resolve(root, pathname);
  const relative = path.relative(root, resolved);
  const portable =
    relative === ""
      ? "$REPOSITORY_ROOT"
      : relative === ".." || relative.startsWith(`..${path.sep}`)
        ? `external:${resolved}`
        : `$REPOSITORY_ROOT/${relative.split(path.sep).join("/")}`;
  return sha256(portable);
}

function fileArtifact(root, relative) {
  const full = path.join(root, relative);
  const stat = lstatSync(full);
  if (stat.isSymbolicLink()) {
    return {
      path: relative,
      sha256: sha256(`link\0${readlinkSync(full)}`),
    };
  }
  if (!stat.isFile()) {
    throw new Error(
      `hmux smoke fingerprint refused: harness input is not a file (${relative})`,
    );
  }
  const hash = createHash("sha256");
  hash.update(`file\0${stat.mode & 0o111}\0`);
  hash.update(readFileSync(full));
  return { path: relative, sha256: hash.digest("hex") };
}

function filesUnder(root, inputs) {
  const files = new Set();
  for (const input of inputs) {
    const base = path.join(root, input);
    if (!existsSync(base)) {
      throw new Error(
        `hmux smoke fingerprint refused: harness input missing (${input})`,
      );
    }
    const stack = [base];
    while (stack.length > 0) {
      const current = stack.pop();
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        files.add(path.relative(root, current));
        continue;
      }
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        stack.push(path.join(current, entry.name));
      }
    }
  }
  return files;
}

async function harnessSourceArtifacts(root) {
  const shellFiles = new Set();
  const javascriptEntrypoints = new Set(HARNESS_JAVASCRIPT_ENTRYPOINTS);
  const queue = [...HARNESS_SHELL_ENTRYPOINTS];
  while (queue.length > 0) {
    const relative = queue.pop();
    if (shellFiles.has(relative)) continue;
    const full = path.join(root, relative);
    if (!existsSync(full)) {
      throw new Error(
        `hmux smoke fingerprint refused: harness script missing (${relative})`,
      );
    }
    shellFiles.add(relative);
    const source = readFileSync(full, "utf8");
    for (const match of source.matchAll(SHELL_SCRIPT_REFERENCE)) {
      const dependency = match[0];
      if (dependency.endsWith(".sh")) queue.push(dependency);
      else javascriptEntrypoints.add(dependency);
    }
  }
  if (javascriptEntrypoints.size === 0) {
    throw new Error(
      "hmux smoke fingerprint refused: harness script closure found no JavaScript entrypoints",
    );
  }

  const result = await cruise([...javascriptEntrypoints].sort(), {
    doNotFollow: { path: "node_modules" },
    baseDir: root,
  });
  const modules = result.output?.modules;
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error(
      "hmux smoke fingerprint refused: harness JavaScript closure returned no modules",
    );
  }
  const files = new Set(shellFiles);
  for (const module of modules) {
    if (module.coreModule || module.source.includes("node_modules")) continue;
    const relative = path.isAbsolute(module.source)
      ? path.relative(root, module.source)
      : module.source;
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error(
        `hmux smoke fingerprint refused: harness dependency escaped repository (${module.source})`,
      );
    }
    files.add(relative);
  }
  for (const file of filesUnder(root, [
    ...CLI_INSTALL_INPUTS,
    ...HARNESS_RESOURCE_INPUTS,
  ])) {
    files.add(file);
  }
  return [...files]
    .sort((left, right) => left.localeCompare(right))
    .map((relative) => fileArtifact(root, relative));
}

function harnessPackageScripts(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  return Object.fromEntries(
    HARNESS_PACKAGE_SCRIPTS.map((name) => {
      const command = manifest.scripts?.[name];
      if (typeof command !== "string" || command === "") {
        throw new Error(
          `hmux smoke fingerprint refused: package script missing (${name})`,
        );
      }
      return [name, command];
    }),
  );
}

function binaryOverride(root, value) {
  if (!value) return { mode: "source-build" };
  const resolved = path.resolve(root, value);
  if (!existsSync(resolved) || !lstatSync(resolved).isFile()) {
    throw new Error(
      "hmux smoke fingerprint refused: DURE_CONTROL_PLANE_BIN is unavailable",
    );
  }
  return { mode: "override", sha256: sha256(readFileSync(resolved)) };
}

function harnessExecutionInputs(root, environment) {
  const cargoTargetDirectory = environment.CARGO_TARGET_DIR;
  const targetMode = cargoTargetDirectory
    ? path.isAbsolute(cargoTargetDirectory)
      ? "absolute"
      : "repository-relative"
    : "default";
  const controlPlaneTarget = cargoTargetDirectory || "crates/dure-app/target";
  const hmuxTarget = cargoTargetDirectory || "hmux/target";
  const cargoBuildTarget = environment.CARGO_BUILD_TARGET;
  return {
    cargoTargetDirectory: {
      mode: targetMode,
      controlPlaneDigest: portablePathDigest(root, controlPlaneTarget),
      hmuxDigest: portablePathDigest(root, hmuxTarget),
    },
    cargoBuildTarget: cargoBuildTarget
      ? { mode: "explicit", sha256: sha256(cargoBuildTarget) }
      : { mode: "rustc-host" },
    controlPlaneBinary: binaryOverride(
      root,
      environment.DURE_CONTROL_PLANE_BIN,
    ),
  };
}

export async function deriveHmuxSmokeHarness(
  root,
  environment = process.env,
) {
  return {
    sources: await harnessSourceArtifacts(root),
    packageScripts: harnessPackageScripts(root),
    executionInputs: harnessExecutionInputs(root, environment),
  };
}

function listFilesUnder(root, prefix) {
  // prefix는 디렉토리("src/lib/terminal") 또는 파일명 접두("src/components/Terminal")다.
  const results = [];
  const dir = path.join(root, prefix);
  if (existsSync(dir)) {
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
          results.push(path.relative(root, full));
        }
      }
    }
    return results;
  }
  const parent = path.join(root, path.dirname(prefix));
  const base = path.basename(prefix);
  if (!existsSync(parent)) return [];
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(base)) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
    results.push(path.join(path.dirname(prefix), entry.name));
  }
  return results;
}

/** 분류기의 경로 정의를 실존하는 entrypoint 파일 목록으로 확장한다.
 *  목록의 죽은 경로(파일 없음)나 아무것도 매치하지 않는 접두는 드리프트다 —
 *  조용히 건너뛰지 않고 throw한다. */
export function expandHmuxSmokeEntrypoints(root) {
  const entrypoints = new Set();
  for (const exact of FRONTEND_RUNTIME_PATHS) {
    if (!existsSync(path.join(root, exact))) {
      throw new Error(
        `hmux smoke entrypoint drift: ${exact} does not exist — update scripts/lib/hmux-background-smoke-scope.mjs`,
      );
    }
    entrypoints.add(exact);
  }
  for (const prefix of FRONTEND_RUNTIME_PREFIXES) {
    const matches = listFilesUnder(root, prefix).filter(
      (candidate) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(candidate),
    );
    if (matches.length === 0) {
      throw new Error(
        `hmux smoke entrypoint drift: prefix ${prefix} matches no files — update scripts/lib/hmux-background-smoke-scope.mjs`,
      );
    }
    for (const match of matches) entrypoints.add(match);
  }
  return [...entrypoints].sort();
}

async function deriveSourceClosure(root, entrypoints) {
  const result = await cruise(entrypoints, {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: path.join(root, "tsconfig.json") },
    baseDir: root,
  });
  const modules = result.output?.modules;
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error("hmux smoke closure derivation returned no modules");
  }
  const closure = new Set();
  for (const module of modules) {
    if (module.coreModule) continue;
    if (module.source.includes("node_modules")) continue;
    if (!module.source.startsWith("src/")) continue;
    closure.add(module.source);
  }
  if (closure.size < MINIMUM_CLOSURE_SIZE) {
    throw new Error(
      `hmux smoke closure suspiciously small (${closure.size} < ${MINIMUM_CLOSURE_SIZE}) — graph resolution is broken`,
    );
  }
  return [...closure].sort();
}

/* 전제조건 검사만 — 해시는 하지 않는다(재빌드 비결정성으로 v3에서 제거).
 * smoke는 staged 바이너리 없이 돌 수 없으므로 부재는 여전히 거부다. */
function assertStagedRuntimePresent(root) {
  const dir = path.join(root, STAGED_RUNTIME_DIR);
  const staged = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.startsWith("hmux"))
    : [];
  if (staged.length === 0) {
    throw new Error(
      `hmux smoke fingerprint refused: no staged hmux runtime binaries (${STAGED_RUNTIME_DIR}) — run pnpm hmux:runtime:stage:dev`,
    );
  }
}

// staged 바이너리를 결정하는 입력: hmux 워크스페이스 + 경로 의존 crates/.
// 테스트 전용 경로는 smoke 분류기와 같은 기준(isHmuxTestOnlyPath)으로
// 제외해 테스트-only 변경이 재사용을 불필요하게 무산시키지 않게 한다.
const RUNTIME_SOURCE_ROOTS = ["hmux", "crates"];
const RUNTIME_SOURCE_EXTENSIONS = new Set([".rs", ".toml", ".lock"]);
const RUNTIME_EXCLUDED_DIR_NAMES = new Set(["target", "node_modules"]);

function runtimeSourceArtifacts(root) {
  const results = [];
  for (const sourceRoot of RUNTIME_SOURCE_ROOTS) {
    const base = path.join(root, sourceRoot);
    if (!existsSync(base)) {
      throw new Error(
        `hmux smoke fingerprint refused: runtime source root missing (${sourceRoot})`,
      );
    }
    const stack = [base];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (RUNTIME_EXCLUDED_DIR_NAMES.has(entry.name)) continue;
          stack.push(full);
          continue;
        }
        if (!RUNTIME_SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
        const relative = path.relative(root, full);
        if (isHmuxTestOnlyPath(relative)) continue;
        results.push({ path: relative, sha256: sha256(readFileSync(full)) });
      }
    }
  }
  if (results.length === 0) {
    throw new Error(
      "hmux smoke fingerprint refused: runtime source walk found nothing — layout drift",
    );
  }
  return results.sort((left, right) => left.path.localeCompare(right.path));
}

function rustcVersion() {
  const result = spawnSync("rustc", ["--version"], { encoding: "utf8" });
  const version = (result.stdout ?? "").trim();
  if (result.status !== 0 || version === "") {
    throw new Error(
      "hmux smoke fingerprint refused: rustc version unavailable — the smoke cannot run without a Rust toolchain either",
    );
  }
  return version;
}

const ADAPTER_SOURCE_ROOT = "src-tauri";
// 어댑터 트리에서 smoke 행동에 기여하는 파일만: Rust 소스·매니페스트·설정.
// target/(빌드 산출물), binaries/(stagedRuntimes로 별도 해시), icons 등
// 자산은 제외한다.
const ADAPTER_SOURCE_EXTENSIONS = new Set([".rs", ".toml", ".lock", ".json"]);
const ADAPTER_EXCLUDED_DIRS = new Set(["target", "binaries", "icons", "gen"]);

function adapterSourceArtifacts(root) {
  const base = path.join(root, ADAPTER_SOURCE_ROOT);
  if (!existsSync(base)) {
    throw new Error(
      `hmux smoke fingerprint refused: adapter source root missing (${ADAPTER_SOURCE_ROOT})`,
    );
  }
  const results = [];
  const stack = [base];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (current === base && ADAPTER_EXCLUDED_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!ADAPTER_SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      results.push({
        path: path.relative(root, full),
        sha256: sha256(readFileSync(full)),
      });
    }
  }
  if (results.length === 0) {
    throw new Error(
      "hmux smoke fingerprint refused: adapter source walk found nothing — layout drift",
    );
  }
  return results.sort((left, right) => left.path.localeCompare(right.path));
}

/** smoke 행동을 결정하는 입력 전체의 서술. 2단계 receipt의 재사용 키 원료다. */
export async function computeHmuxSmokeFingerprintManifest(
  root,
  { environment = process.env } = {},
) {
  const entrypoints = expandHmuxSmokeEntrypoints(root);
  const closure = await deriveSourceClosure(root, entrypoints);
  const sources = closure.map((source) => ({
    path: source,
    sha256: sha256(readFileSync(path.join(root, source))),
  }));
  return {
    schemaVersion: HMUX_SMOKE_FINGERPRINT_SCHEMA_VERSION,
    entrypoints,
    sources,
    adapterSources: adapterSourceArtifacts(root),
    runtimeSources: (assertStagedRuntimePresent(root), runtimeSourceArtifacts(root)),
    harness: await deriveHmuxSmokeHarness(root, environment),
    toolchain: {
      nodeMajor: Number(process.versions.node.split(".")[0]),
      rustc: rustcVersion(),
    },
    os: { platform: os.platform(), releaseMajor: os.release().split(".")[0] },
  };
}

export function hmuxSmokeFingerprint(manifest) {
  return sha256(JSON.stringify(manifest));
}

/** manifest의 컴포넌트별 해시 — 판정 키는 여전히 전체 fingerprint 하나지만,
 *  "왜 재사용이 안 됐나"를 진단하려면 어느 입력군이 달라졌는지가 필요하다.
 *  (v3에서 stagedRuntimes 해시를 runtimeSources로 대체 — 재빌드
 *  비결정성이 실측돼 산출물 대신 입력을 서술한다.)
 *  키 목록은 receipt 모듈의 단일 출처에서 파생한다 — manifest에 해당 필드가
 *  없으면 스키마 정합이 깨진 것이므로 throw(조용한 부분 breakdown 금지). */
export function hmuxSmokeFingerprintComponents(manifest) {
  const components = {};
  for (const key of FINGERPRINT_COMPONENT_KEYS) {
    if (manifest[key] === undefined) {
      throw new Error(
        `hmux smoke fingerprint component missing from manifest: ${key}`,
      );
    }
    components[key] = sha256(JSON.stringify(manifest[key]));
  }
  return components;
}
