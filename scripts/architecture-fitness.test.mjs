import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import {
  evaluateArchitectureFitness,
  godFileGrowthViolations,
  GOD_FILE_RATCHET_MINIMUM_REDUCTION,
  planArchitectureRatchet,
  scanArchitecture,
} from "./lib/architecture-fitness.mjs";

const temporaryDirectories = [];
const RATCHET_SCRIPT = path.resolve(
  "scripts/ratchet-architecture-fitness.mjs",
);

function temporaryDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "architecture-fitness-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function write(root, filename, content) {
  const pathname = path.join(root, filename);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, content);
}

function baseline(root) {
  return { schemaVersion: 1, ...scanArchitecture(root) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("architecture fitness baseline", () => {
  test("permits existing debt but rejects a new direct Tauri invoke file", () => {
    const root = temporaryDirectory();
    write(
      root,
      "src/existing.ts",
      'import { invoke } from "@tauri-apps/api/core";\ninvoke("existing");\n',
    );
    const committed = baseline(root);
    expect(evaluateArchitectureFitness(root, committed)).toEqual([]);

    write(
      root,
      "src/newFeature.ts",
      'import { invoke } from "@tauri-apps/api/core";\ninvoke("new");\n',
    );
    expect(evaluateArchitectureFitness(root, committed)).toContain(
      "directTauriInvoke: src/newFeature.ts has 1 site(s), baseline allows 0",
    );
  });

  test("rejects growth in concrete provider and runtime branches", () => {
    const root = temporaryDirectory();
    write(root, "src/feature.ts", "export const clean = true;\n");
    const committed = baseline(root);
    write(
      root,
      "src/feature.ts",
      [
        'if (provider === "fixture") throw new Error();',
        'if (agent.sessionKind === "fixture") throw new Error();',
      ].join("\n"),
    );
    const violations = evaluateArchitectureFitness(root, committed);
    expect(violations).toContain(
      "concreteProviderBranch: src/feature.ts has 1 site(s), baseline allows 0",
    );
    expect(violations).toContain(
      "concreteRuntimeBranch: src/feature.ts has 1 site(s), baseline allows 0",
    );
  });

  test("permits an existing god file at its baseline but rejects growth", () => {
    const root = temporaryDirectory();
    const lines = Array.from({ length: 950 }, (_, i) => `export const v${i} = ${i};`);
    write(root, "src/bigFeature.ts", `${lines.join("\n")}\n`);
    const committed = baseline(root);
    expect(evaluateArchitectureFitness(root, committed)).toEqual([]);

    write(root, "src/bigFeature.ts", `${lines.join("\n")}\nexport const grown = true;\n`);
    expect(evaluateArchitectureFitness(root, committed)).toContain(
      "godFileLines: src/bigFeature.ts has 952 line(s), baseline allows 951",
    );
  });

  test("rejects a brand-new file over the god-file threshold", () => {
    const root = temporaryDirectory();
    write(root, "src/small.ts", "export const ok = true;\n");
    const committed = baseline(root);
    const lines = Array.from({ length: 950 }, (_, i) => `export const v${i} = ${i};`);
    write(root, "src/newGod.ts", `${lines.join("\n")}\n`);
    expect(evaluateArchitectureFitness(root, committed)).toContain(
      "godFileLines: src/newGod.ts has 951 line(s), baseline allows 0",
    );
  });

  test("permits god-file shrinkage below the ratchet hysteresis", () => {
    const root = temporaryDirectory();
    const lines = Array.from({ length: 950 }, (_, i) => `export const v${i} = ${i};`);
    write(root, "src/bigFeature.ts", `${lines.join("\n")}\n`);
    const committed = baseline(root);

    const retainedLines =
      lines.length - (GOD_FILE_RATCHET_MINIMUM_REDUCTION - 1);
    write(
      root,
      "src/bigFeature.ts",
      `${lines.slice(0, retainedLines).join("\n")}\n`,
    );
    expect(evaluateArchitectureFitness(root, committed)).toEqual([]);
    expect(planArchitectureRatchet(root, committed).changes).toEqual([]);
  });

  test("keeps ratcheting an explicit milestone instead of a shrink-time gate", () => {
    const root = temporaryDirectory();
    const lines = Array.from({ length: 950 }, (_, i) => `export const v${i} = ${i};`);
    write(root, "src/bigFeature.ts", `${lines.join("\n")}\n`);
    const committed = baseline(root);

    const retainedLines =
      lines.length - GOD_FILE_RATCHET_MINIMUM_REDUCTION;
    write(
      root,
      "src/bigFeature.ts",
      `${lines.slice(0, retainedLines).join("\n")}\n`,
    );
    expect(evaluateArchitectureFitness(root, committed)).toEqual([]);

    const plan = planArchitectureRatchet(root, committed);
    expect(plan.changes).toEqual([
      {
        filename: "src/bigFeature.ts",
        previousAllowed: 951,
        nextAllowed: 926,
        count: 926,
      },
    ]);
    expect(evaluateArchitectureFitness(root, plan.baseline)).toEqual([]);
  });

  test("rejects god-file growth relative to the exact change base", () => {
    expect(
      godFileGrowthViolations(
        {
          "src/grew.ts": 952,
          "src/shrank.ts": 925,
        },
        {
          "src/grew.ts": 951,
          "src/shrank.ts": 950,
        },
      ),
    ).toEqual([
      "godFileGrowth: src/grew.ts grew from 951 to 952 line(s) in this change — extract the added responsibility instead",
    ]);
    expect(
      godFileGrowthViolations({ "src/newGod.ts": 901 }, {}),
    ).toEqual([
      "godFileGrowth: src/newGod.ts grew from 0 to 901 line(s) in this change — extract the added responsibility instead",
    ]);
  });

  test("순수 이동은 성장이 아니다 — basename으로 base 상한을 승계한다", () => {
    // 폴더 재배치: base의 src/lib/dock.ts가 workspace/로 이동 — 위반 아님.
    expect(
      godFileGrowthViolations(
        { "src/lib/workspace/dock.ts": 1227 },
        { "src/lib/dock.ts": 1227 },
      ),
    ).toEqual([]);
    // 이동 + 실제 성장은 여전히 잡힌다.
    expect(
      godFileGrowthViolations(
        { "src/lib/workspace/dock.ts": 1230 },
        { "src/lib/dock.ts": 1227 },
      ),
    ).toEqual([
      "godFileGrowth: src/lib/workspace/dock.ts grew from 1227 to 1230 line(s) in this change — extract the added responsibility instead",
    ]);
    // 같은 basename이 base에 여럿이면 최대값 승계(보수적) — 초과만 위반.
    expect(
      godFileGrowthViolations(
        { "src/b/x.ts": 950 },
        { "src/a/x.ts": 940, "src/c/x.ts": 960 },
      ),
    ).toEqual([]);
  });

  test("removes a baseline entry after a meaningful reduction to 900 lines", () => {
    const root = temporaryDirectory();
    const lines = Array.from({ length: 950 }, (_, i) => `export const v${i} = ${i};`);
    write(root, "src/bigFeature.ts", `${lines.join("\n")}\n`);
    const committed = baseline(root);

    write(root, "src/bigFeature.ts", `${lines.slice(0, 899).join("\n")}\n`);
    const plan = planArchitectureRatchet(root, committed);
    expect(plan.changes).toEqual([
      {
        filename: "src/bigFeature.ts",
        previousAllowed: 951,
        nextAllowed: null,
        count: 900,
      },
    ]);
    expect(plan.baseline.godFileLines).toEqual({});
    expect(evaluateArchitectureFitness(root, plan.baseline)).toEqual([]);
  });

  test("retains a 901-line file as explicit debt after ratcheting", () => {
    const root = temporaryDirectory();
    const lines = Array.from({ length: 950 }, (_, i) => `export const v${i} = ${i};`);
    write(root, "src/bigFeature.ts", `${lines.join("\n")}\n`);
    const committed = baseline(root);

    write(root, "src/bigFeature.ts", `${lines.slice(0, 900).join("\n")}\n`);
    const plan = planArchitectureRatchet(root, committed);
    expect(plan.changes[0]).toEqual({
      filename: "src/bigFeature.ts",
      previousAllowed: 951,
      nextAllowed: 901,
      count: 901,
    });
    expect(plan.baseline.godFileLines).toEqual({
      "src/bigFeature.ts": 901,
    });
  });

  test("removes the baseline entry when a tracked file is deleted", () => {
    const root = temporaryDirectory();
    const lines = Array.from({ length: 950 }, (_, i) => `export const v${i} = ${i};`);
    write(root, "src/bigFeature.ts", `${lines.join("\n")}\n`);
    const committed = baseline(root);
    fs.unlinkSync(path.join(root, "src/bigFeature.ts"));

    const plan = planArchitectureRatchet(root, committed);
    expect(plan.changes[0]).toEqual({
      filename: "src/bigFeature.ts",
      previousAllowed: 951,
      nextAllowed: null,
      count: 0,
    });
    expect(plan.baseline.godFileLines).toEqual({});
  });

  test("orders multi-file ratchet changes by repository path", () => {
    const root = temporaryDirectory();
    const lines = Array.from({ length: 950 }, (_, i) => `export const v${i} = ${i};`);
    write(root, "src/a.ts", `${lines.slice(0, 925).join("\n")}\n`);
    write(root, "src/z.ts", `${lines.slice(0, 925).join("\n")}\n`);
    const committed = {
      ...baseline(root),
      godFileLines: {
        "src/z.ts": 951,
        "src/a.ts": 951,
      },
    };

    expect(
      planArchitectureRatchet(root, committed).changes.map(
        (change) => change.filename,
      ),
    ).toEqual(["src/a.ts", "src/z.ts"]);
  });

  test("ratchet command writes each eligible reduction exactly once", () => {
    const root = temporaryDirectory();
    const lines = Array.from({ length: 950 }, (_, i) => `export const v${i} = ${i};`);
    write(root, "src/bigFeature.ts", `${lines.join("\n")}\n`);
    const committed = baseline(root);
    write(
      root,
      "scripts/architecture-fitness-baseline.json",
      `${JSON.stringify(committed, null, 2)}\n`,
    );
    write(root, "src/bigFeature.ts", `${lines.slice(0, 925).join("\n")}\n`);

    const first = spawnSync(process.execPath, [RATCHET_SCRIPT], {
      cwd: root,
      encoding: "utf8",
    });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(
      "src/bigFeature.ts: 951 -> 926 (current 926)",
    );
    const ratcheted = fs.readFileSync(
      path.join(root, "scripts/architecture-fitness-baseline.json"),
      "utf8",
    );
    expect(JSON.parse(ratcheted).godFileLines).toEqual({
      "src/bigFeature.ts": 926,
    });

    const second = spawnSync(process.execPath, [RATCHET_SCRIPT], {
      cwd: root,
      encoding: "utf8",
    });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("has no eligible reductions");
    expect(
      fs.readFileSync(
        path.join(root, "scripts/architecture-fitness-baseline.json"),
        "utf8",
      ),
    ).toBe(ratcheted);
  });

  test("ratchet command refuses growth without rewriting the baseline", () => {
    const root = temporaryDirectory();
    const lines = Array.from({ length: 950 }, (_, i) => `export const v${i} = ${i};`);
    write(root, "src/bigFeature.ts", `${lines.join("\n")}\n`);
    const committed = `${JSON.stringify(baseline(root), null, 2)}\n`;
    write(root, "scripts/architecture-fitness-baseline.json", committed);
    write(
      root,
      "src/bigFeature.ts",
      `${lines.join("\n")}\nexport const grown = true;\n`,
    );

    const result = spawnSync(process.execPath, [RATCHET_SCRIPT], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "godFileLines: src/bigFeature.ts has 952 line(s), baseline allows 951",
    );
    expect(
      fs.readFileSync(
        path.join(root, "scripts/architecture-fitness-baseline.json"),
        "utf8",
      ),
    ).toBe(committed);
  });

  test("ignores test files and the ipc wrapper home (barrel + directory)", () => {
    const root = temporaryDirectory();
    const lines = Array.from({ length: 950 }, (_, i) => `export const v${i} = ${i};`);
    write(root, "src/lib/ipc.ts", `${lines.join("\n")}\n`);
    // 도메인 분할(2026-08-01) 후 래퍼의 집은 src/lib/ipc/ 디렉토리다 —
    // invoke 호출과 900줄 초과 모두 이 디렉토리 안에서만 면제된다.
    write(root, "src/lib/ipc/hmux.ts", `${lines.join("\n")}\ninvoke("x");\n`);
    write(root, "src/huge.test.ts", `${lines.join("\n")}\n`);
    write(root, "src/Huge.test.tsx", `${lines.join("\n")}\n`);
    expect(evaluateArchitectureFitness(root, baseline(root))).toEqual([]);
    expect(scanArchitecture(root).godFileLines).toEqual({});
    expect(scanArchitecture(root).directTauriInvoke).toEqual({});
  });

  test("still flags direct invoke outside the ipc directory", () => {
    const root = temporaryDirectory();
    write(root, "src/lib/other.ts", 'invoke("x");\n');
    expect(scanArchitecture(root).directTauriInvoke).toEqual({
      "src/lib/other.ts": 1,
    });
  });

  test("flat-root freeze: components·lib 루트의 새 파일을 막는다", () => {
    const root = temporaryDirectory();
    // 테스트 파일과 하위 폴더 파일은 세지 않는다 — 클러스터가 정답 위치다.
    write(root, "src/lib/utils.ts", "export {};\n");
    write(root, "src/lib/utils.test.ts", "export {};\n");
    write(root, "src/lib/spaces/anything.ts", "export {};\n");
    write(root, "src/components/Toaster.tsx", "export {};\n");
    expect(scanArchitecture(root).flatRootFiles).toEqual({
      "src/components": 1,
      "src/lib": 1,
    });
    const allowed = {
      schemaVersion: 1,
      flatRootFiles: { "src/components": 1, "src/lib": 1 },
    };
    expect(evaluateArchitectureFitness(root, allowed)).toEqual([]);
    write(root, "src/lib/newFlatModule.ts", "export {};\n");
    const violations = evaluateArchitectureFitness(root, allowed);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("flatRootFiles: src/lib");
  });

  test("blocks a new accidental barrel while sparing designated ones and small compat re-exports", () => {
    const root = temporaryDirectory();
    const reexports = (count) =>
      Array.from({ length: count }, (_, i) => `export { a${i} } from "./m${i}";`).join("\n") + "\n";
    // free budget: two compat re-exports stay silent.
    write(root, "src/lib/compat.ts", reexports(2));
    // designated barrels are exempt at any size.
    write(root, "src/lib/ipc.ts", reexports(9));
    write(root, "src/contracts/terminalStateProtocol.ts", reexports(7));
    expect(scanArchitecture(root).barrelReexportExcess).toEqual({});

    // a third re-export makes an accidental barrel — one excess unit.
    write(root, "src/lib/hub.ts", reexports(3));
    expect(scanArchitecture(root).barrelReexportExcess).toEqual({
      "src/lib/hub.ts": 1,
    });
    const violations = evaluateArchitectureFitness(root, {
      schemaVersion: 1,
    });
    expect(
      violations.some(
        (violation) =>
          violation.includes("barrelReexportExcess: src/lib/hub.ts") &&
          violation.includes("split the module"),
      ),
    ).toBe(true);

    // multiline specifier lists and `export *` count too.
    write(
      root,
      "src/lib/hub.ts",
      'export {\n  one,\n  two,\n} from "./a";\nexport * from "./b";\nexport { three } from "./c";\n',
    );
    expect(scanArchitecture(root).barrelReexportExcess).toEqual({
      "src/lib/hub.ts": 1,
    });
  });

  test("freezes new component store coupling while keeping baseline files and tests free", () => {
    const root = temporaryDirectory();
    write(
      root,
      "src/components/spaces/Existing.tsx",
      'import { useStore } from "@/store";\nexport {};\n',
    );
    write(
      root,
      "src/components/spaces/Existing.test.tsx",
      'import { useStore } from "@/store";\nexport {};\n',
    );
    write(
      root,
      "src/components/spaces/TypesOnly.tsx",
      'import type { AppState } from "@/store";\nexport {};\n',
    );
    write(root, "src/lib/spaces/logic.ts", 'import { useStore } from "@/store";\nexport {};\n');
    // Cluster wiring hooks are the designated coupling point — exempt.
    write(
      root,
      "src/components/spaces/useSpacesWiring.ts",
      'import { useStore } from "@/store";\nexport {};\n',
    );
    expect(scanArchitecture(root).componentStoreCoupling).toEqual({
      "src/components/spaces/Existing.tsx": 1,
    });

    const allowed = {
      schemaVersion: 1,
      componentStoreCoupling: { "src/components/spaces/Existing.tsx": 1 },
    };
    expect(evaluateArchitectureFitness(root, allowed)).toEqual([]);

    write(
      root,
      "src/components/spaces/Fresh.tsx",
      'import { useStore } from "@/store";\nexport {};\n',
    );
    const violations = evaluateArchitectureFitness(root, allowed);
    expect(
      violations.some(
        (violation) =>
          violation.includes("componentStoreCoupling: src/components/spaces/Fresh.tsx") &&
          violation.includes("cluster hooks/selectors"),
      ),
    ).toBe(true);
  });

  test("rejects versionless serializable extension DTOs", () => {
    const root = temporaryDirectory();
    write(
      root,
      "crates/dure-app/src/contract.rs",
      "#[derive(Clone, Serialize)]\npub struct ExtensionDescriptor {\n}\n",
    );
    expect(evaluateArchitectureFitness(root, baseline(root))).toContain(
      "versionedExtensionDto: crates/dure-app/src/contract.rs:2 ExtensionDescriptor must carry a V<number> suffix",
    );
  });

  test("accepts explicitly versioned serializable extension DTOs", () => {
    const root = temporaryDirectory();
    write(
      root,
      "crates/dure-app/src/contract.rs",
      "#[derive(Clone, Serialize)]\npub struct ExtensionDescriptorV1 {\n}\n",
    );
    expect(evaluateArchitectureFitness(root, baseline(root))).toEqual([]);
  });

  test("rejects versionless serializable DTOs in the protocol leaf", () => {
    const root = temporaryDirectory();
    write(
      root,
      "crates/dure-app/protocol/src/git_checkout.rs",
      "#[derive(Clone, Serialize)]\npub struct GitCheckoutRequest {\n}\n",
    );
    expect(evaluateArchitectureFitness(root, baseline(root))).toContain(
      "versionedExtensionDto: crates/dure-app/protocol/src/git_checkout.rs:2 GitCheckoutRequest must carry a V<number> suffix",
    );
  });
});
