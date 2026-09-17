import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const pathname = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(pathname) : [pathname];
  });
}

function relative(root, pathname) {
  return path.relative(root, pathname).split(path.sep).join("/");
}

function countMatches(source, expressions) {
  return expressions.reduce((total, expression) => {
    const matches = source.match(expression);
    return total + (matches?.length ?? 0);
  }, 0);
}

function countByFile(root, expressions, isExcluded = () => false) {
  const counts = {};
  for (const pathname of walk(path.join(root, "src")).sort()) {
    if (!SOURCE_EXTENSIONS.has(path.extname(pathname))) continue;
    const filename = relative(root, pathname);
    if (isExcluded(filename) || filename.endsWith(".test.ts")) continue;
    const count = countMatches(fs.readFileSync(pathname, "utf8"), expressions);
    if (count > 0) counts[filename] = count;
  }
  return counts;
}

const DIRECT_INVOKE = [
  /\binvoke\s*(?:<[^;\n()]*>)?\s*\(/g,
];

const PROVIDER_LITERAL_BRANCH = [
  /\b(?:[A-Za-z_$][\w$]*)?[Pp]rovider\s*(?:===|!==|==|!=)\s*["'`][a-z][a-z0-9_-]*["'`]/g,
  /["'`][a-z][a-z0-9_-]*["'`]\s*(?:===|!==|==|!=)\s*(?:[A-Za-z_$][\w$]*)?[Pp]rovider\b/g,
  /\bswitch\s*\(\s*(?:[A-Za-z_$][\w$]*)?[Pp]rovider\s*\)/g,
];

const RUNTIME_LITERAL_BRANCH = [
  /\b(?:[A-Za-z_$][\w$]*)?(?:sessionKind|runtimeKind)\s*(?:===|!==|==|!=)\s*["'`][a-z][a-z0-9_-]*["'`]/g,
  /["'`][a-z][a-z0-9_-]*["'`]\s*(?:===|!==|==|!=)\s*(?:[A-Za-z_$][\w$]*)?(?:sessionKind|runtimeKind)\b/g,
  /\bswitch\s*\(\s*(?:[A-Za-z_$][\w$]*)?(?:sessionKind|runtimeKind)\s*\)/g,
];

// 사고로 태어나는 배럴 차단(2026-08-17): 한 모듈이 다른 모듈들의 표면을
// 무료 예산(2)을 넘어 재수출하면 dock.ts처럼 사실상의 배럴이 된다 — 소비자
// 수십 곳이 허브 하나에 fan-in 하고, 하위 모듈 수정마다 잠재 영향권이 허브
// 전체로 넓어진다(2026-08-17 dock 탈배럴의 원인). 지정 배럴 둘만 면제:
// invoke 파사드(src/lib/ipc.ts)와 생성 계약 표면
// (src/contracts/terminalStateProtocol.ts). 기록값은 예산을 뺀 초과분이라
// baseline 없이 0-비교로 동작하고, 국소 호환 재노출 1~2개는 자유다.
const BARREL_REEXPORT = [
  /export\s+(?:type\s+)?\{[^}]*\}\s+from\s+["']/gs,
  /export\s+\*\s+from\s+["']/g,
];
const BARREL_FREE_BUDGET = 2;
const DESIGNATED_BARRELS = new Set([
  "src/lib/ipc.ts",
  "src/contracts/terminalStateProtocol.ts",
]);

function barrelReexportExcessByFile(root) {
  const excess = {};
  const counts = countByFile(root, BARREL_REEXPORT, (filename) =>
    DESIGNATED_BARRELS.has(filename),
  );
  for (const [filename, count] of Object.entries(counts)) {
    if (count > BARREL_FREE_BUDGET) {
      excess[filename] = count - BARREL_FREE_BUDGET;
    }
  }
  return excess;
}

// 컴포넌트의 전역 store 직접 결합 동결(2026-08-17): src/components/ 아래
// 새 파일은 useStore를 직접 읽는 대신 클러스터 훅/셀렉터를 경유한다. 기존
// 73개 파일은 baseline 부채로 등재되어 자유롭게 수정되지만, 목록 밖의 새
// 결합 파일은 이 게이트가 막는다 — 전역 store fan-in(286)이 컴포넌트 재사용
// 성과 테스트 격리를 갉아먹는 것을 파일 단위에서 멈춘다. 줄이는 것은 자유.
function componentStoreCouplingByFile(root) {
  const coupled = {};
  // Value imports only — `import type`은 런타임 결합이 아니다. 테스트는
  // store 시딩이 정당하고, `use*` 배선 훅 파일은 클러스터의 **지정 결합
  // 지점**이다(AGENTS: React 훅은 lib 금지 → store 배선은 components의
  // use* 훅이 소유). 컴포넌트 본체는 그 훅을 소비해 렌더링만 남긴다.
  const VALUE_IMPORT = [/import\s+(?!type\s)[^;]*?from\s+["']@\/store["']/gs];
  for (const [filename] of Object.entries(
    countByFile(root, VALUE_IMPORT, (filename) =>
      !filename.startsWith("src/components/") ||
      /\.test\.tsx?$/.test(filename) ||
      /\/use[A-Z][A-Za-z0-9]*\.tsx?$/.test(filename),
    ),
  )) {
    coupled[filename] = 1;
  }
  return coupled;
}

// god-file 다이어트 ratchet: 이 줄 수를 넘는 src/ 파일은 baseline에 등재된
// 기존 부채만 허용된다. push/CI에서는 exact base와도 비교해 이번 변경의
// 순증가를 막는다 — AGENTS.md "만진 부분은 슬라이스로 추출" 규칙의 기계적
// 강제. baseline 감소는 일상 변경과 분리된 명시적 debt milestone에서만 한다.
//
// src/lib/ipc/ 면제: directTauriInvoke 규칙이 invoke 래퍼를 이 디렉토리로
// 강제한다 — 여기서 성장까지 막으면 에이전트가 invoke를 컴포넌트에
// 흩뿌리는 더 나쁜 우회를 하게 된다. 2026-08-01 도메인 분할(1단계)로 구
// ipc.ts 단일 파일 면제가 디렉토리 면제로 승계됐다. 주의: 이 승계는 invoke
// 면제와 달리 엄밀한 동일 강도가 아니다 — 래퍼가 아닌 파일을 이 디렉토리에
// 두면 900줄 라쳇을 피할 수 있다(commandOwnership 테스트는 중복만 잡는다).
// "디렉토리 내 파일은 invoke 래퍼(또는 그 계약)여야 한다" 규칙 강화가
// 남은 부채다. (hmux.ts 1069줄은 2026-08-01 contracts 분리로 493+615 해소.)
const GOD_FILE_LINE_THRESHOLD = 900;
export const GOD_FILE_RATCHET_MINIMUM_REDUCTION = 25;
const GOD_FILE_EXEMPT = new Set([
  "src/lib/ipc.ts",
  // 변환 스크립트(scripts/themes/convert-schemes.mjs) 산출물 — 손으로 편집하지
  // 않는 데이터라 "쪼개서 줄여라" 라쳇의 대상이 아니다. 스킴 큐레이션이 늘면
  // 900줄을 자연스럽게 넘는다.
  "src/lib/theme/bundledThemes.ts",
]);

// i18n 사전(src/locales/*) — 문자열이 늘 때마다 기계적으로 자라는 데이터
// 파일이라 "쪼개서 줄여라" 라쳇의 대상이 아니다. 정합성은 i18nCoverage
// vitest 게이트가 맡는다.
function isGodFileExempt(filename) {
  if (GOD_FILE_EXEMPT.has(filename)) return true;
  if (filename.startsWith("src/lib/ipc/")) return true;
  return filename.startsWith("src/locales/") && filename.endsWith(".ts");
}

function godFileLinesByFile(root) {
  const counts = {};
  for (const pathname of walk(path.join(root, "src")).sort()) {
    if (!SOURCE_EXTENSIONS.has(path.extname(pathname))) continue;
    const filename = relative(root, pathname);
    if (isGodFileExempt(filename)) continue;
    if (filename.endsWith(".test.ts") || filename.endsWith(".test.tsx")) continue;
    const lines = fs.readFileSync(pathname, "utf8").split(/\r?\n/).length;
    if (lines > GOD_FILE_LINE_THRESHOLD) counts[filename] = lines;
  }
  return counts;
}

function godFileLineCount(root, filename) {
  const sourceRoot = path.resolve(root, "src");
  const pathname = path.resolve(root, filename);
  const isInsideSource =
    pathname.startsWith(`${sourceRoot}${path.sep}`) &&
    SOURCE_EXTENSIONS.has(path.extname(pathname));
  if (!isInsideSource || !fs.existsSync(pathname)) return 0;
  return fs.readFileSync(pathname, "utf8").split(/\r?\n/).length;
}

// Root-level source files may only shrink relative to the frozen baseline.
// New code belongs beside its domain consumers, under the existing clusters.
const FLAT_ROOT_DIRS = ["src/components", "src/lib"];

function flatRootFileCounts(root) {
  const counts = {};
  for (const dir of FLAT_ROOT_DIRS) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    let count = 0;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      count += 1;
    }
    if (count > 0) counts[dir] = count;
  }
  return counts;
}

export function scanArchitecture(root) {
  return {
    flatRootFiles: flatRootFileCounts(root),
    // invoke 래퍼의 유일한 집(2026-08-01 도메인 분할 후 barrel + src/lib/ipc/
    // 디렉토리). 그 밖의 모든 파일은 여전히 직접 invoke가 차단된다 — invoke
    // 면제는 파일→디렉토리로 범위만 옮긴 동일 강도다. (900줄 god-file 면제의
    // 디렉토리 승계는 isGodFileExempt 주석 참조 — 그쪽은 2단계 부채가 남는다.)
    directTauriInvoke: countByFile(root, DIRECT_INVOKE, (filename) =>
      filename === "src/lib/ipc.ts" || filename.startsWith("src/lib/ipc/"),
    ),
    concreteProviderBranch: countByFile(root, PROVIDER_LITERAL_BRANCH),
    concreteRuntimeBranch: countByFile(root, RUNTIME_LITERAL_BRANCH),
    godFileLines: godFileLinesByFile(root),
    barrelReexportExcess: barrelReexportExcessByFile(root),
    componentStoreCoupling: componentStoreCouplingByFile(root),
  };
}

function compareBaseline(rule, current, baseline, unit = "site(s)") {
  const violations = [];
  for (const [filename, count] of Object.entries(current)) {
    const allowed = baseline?.[filename] ?? 0;
    if (count > allowed) {
      violations.push(
        `${rule}: ${filename} has ${count} ${unit}, baseline allows ${allowed}`,
      );
    }
  }
  return violations;
}

function versionlessDtoViolations(root) {
  const violations = [];
  const dtoRoots = [
    "crates/dure-app/src",
    "crates/dure-app/protocol/src",
  ];
  for (const pathname of dtoRoots.flatMap((dtoRoot) => walk(path.join(root, dtoRoot)))
    .filter((candidate) => candidate.endsWith(".rs"))
    .sort()) {
    const filename = relative(root, pathname);
    const lines = fs.readFileSync(pathname, "utf8").split(/\r?\n/);
    let derive = "";
    let collectingDerive = false;
    let serializable = false;
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = lines[index].trim();
      if (trimmed.startsWith("#[derive(")) {
        collectingDerive = true;
        derive = trimmed;
      } else if (collectingDerive) {
        derive += trimmed;
      }
      if (collectingDerive && trimmed.endsWith(")]")) {
        collectingDerive = false;
        serializable = /\bSerialize\b/.test(derive);
        continue;
      }
      if (collectingDerive || !serializable) continue;
      if (trimmed.startsWith("#[") || trimmed.startsWith("///") || trimmed === "") {
        continue;
      }
      const item = trimmed.match(/^pub\s+(?:struct|enum)\s+([A-Za-z0-9_]+)/);
      if (item && !/V[1-9][0-9]*$/.test(item[1])) {
        violations.push(
          `versionedExtensionDto: ${filename}:${index + 1} ${item[1]} must carry a V<number> suffix`,
        );
      }
      serializable = false;
      derive = "";
    }
  }
  return violations;
}

export function evaluateArchitectureFitness(
  root,
  baseline,
  current = scanArchitecture(root),
) {
  if (baseline.schemaVersion !== 1) {
    return [`baseline: unsupported schemaVersion ${baseline.schemaVersion}`];
  }
  return [
    ...compareBaseline(
      "directTauriInvoke",
      current.directTauriInvoke,
      baseline.directTauriInvoke,
    ),
    ...compareBaseline(
      "concreteProviderBranch",
      current.concreteProviderBranch,
      baseline.concreteProviderBranch,
    ),
    ...compareBaseline(
      "concreteRuntimeBranch",
      current.concreteRuntimeBranch,
      baseline.concreteRuntimeBranch,
    ),
    ...compareBaseline(
      "godFileLines",
      current.godFileLines,
      baseline.godFileLines,
      "line(s)",
    ),
    ...compareBaseline(
      "barrelReexportExcess",
      current.barrelReexportExcess,
      baseline.barrelReexportExcess,
      "re-export(s) beyond the free budget of 2 — split the module instead of growing a barrel",
    ),
    ...compareBaseline(
      "componentStoreCoupling",
      current.componentStoreCoupling,
      baseline.componentStoreCoupling,
      "direct @/store import — new components read through cluster hooks/selectors",
    ),
    ...compareBaseline(
      "flatRootFiles",
      current.flatRootFiles,
      baseline.flatRootFiles,
      "file(s) — new files belong in existing src/components/ or src/lib/ domain folders",
    ),
    ...versionlessDtoViolations(root),
  ];
}

export function godFileGrowthViolations(current, base) {
  const violations = [];
  // 순수 이동(폴더 재배치) 무해화: base에 같은 경로가 없으면 같은 basename의
  // base 항목을 승계한다 — 경로 키만 보면 이동이 "0에서 성장"으로 오탐돼
  // 재배치 경계를 넘는 모든 push가 막힌다(2026-08-01 lib 재배치에서 실측).
  // basename이 base에 여러 개면 가장 큰 값을 쓴다(성장은 여전히 잡힌다).
  const baseByBasename = new Map();
  for (const [filename, count] of Object.entries(base ?? {})) {
    const name = filename.split("/").pop();
    const prior = baseByBasename.get(name);
    if (prior === undefined || count > prior) baseByBasename.set(name, count);
  }
  for (const [filename, count] of Object.entries(current ?? {})) {
    let baseCount = base?.[filename];
    if (baseCount === undefined) {
      baseCount = baseByBasename.get(filename.split("/").pop()) ?? 0;
    }
    if (count > baseCount) {
      violations.push(
        `godFileGrowth: ${filename} grew from ${baseCount} to ${count} line(s) in this change — extract the added responsibility instead`,
      );
    }
  }
  return violations;
}

export function planArchitectureRatchet(root, baseline) {
  if (baseline.schemaVersion !== 1) {
    throw new Error(
      `unsupported architecture baseline schemaVersion ${baseline.schemaVersion}`,
    );
  }

  const nextBaseline = JSON.parse(JSON.stringify(baseline));
  const changes = [];
  for (const [filename, allowed] of Object.entries(
    baseline.godFileLines ?? {},
  ).sort(([left], [right]) => left.localeCompare(right))) {
    const count = godFileLineCount(root, filename);
    const reduction = allowed - count;
    if (reduction < GOD_FILE_RATCHET_MINIMUM_REDUCTION) continue;

    const nextAllowed = count > GOD_FILE_LINE_THRESHOLD ? count : null;
    if (nextAllowed === null) {
      delete nextBaseline.godFileLines[filename];
    } else {
      nextBaseline.godFileLines[filename] = nextAllowed;
    }
    changes.push({ filename, previousAllowed: allowed, nextAllowed, count });
  }
  return { baseline: nextBaseline, changes };
}

export function readArchitectureBaseline(root) {
  return JSON.parse(
    fs.readFileSync(
      path.join(root, "scripts/architecture-fitness-baseline.json"),
      "utf8",
    ),
  );
}
