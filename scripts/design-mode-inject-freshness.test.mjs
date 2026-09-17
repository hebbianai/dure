// 주입 번들(src/generated/designModeInject.js)이 소스와 어긋나지 않는지 검사한다.
//
// 왜 필요한가: 생성물을 저장소에 커밋하는 방식(이 저장소는 src/contracts/generated
// 도 그렇게 다룬다)의 유일한 위험은 **조용한 드리프트**다. 픽커나 수집기를 고치고
// 번들을 다시 만들지 않으면, 우리 창(A단계)은 새 코드로 돌고 사용자 앱 창(B단계)은
// 옛 코드로 돈다 — 그러면 "창마다 다른 결과"가 되고, 그것을 막으려고 판정을 공유
// 모듈로 만든 노력이 무의미해진다.
//
// 검사 방식: 번들을 다시 만들어 바이트가 같은지 본다. 해시를 파일에 심는 방식보다
// 정직하다 — 심은 해시는 갱신을 잊으면 통과하지만, 재빌드 비교는 못 속인다.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const committed = join(repoRoot, "src", "generated", "designModeInject.js");
const viteCli = join(
  dirname(fileURLToPath(import.meta.resolve("vite/package.json"))),
  "bin",
  "vite.js",
);

describe("design mode 주입 번들", () => {
  it("커밋된 번들이 소스와 일치한다", () => {
    const output = mkdtempSync(join(tmpdir(), "dure-inject-"));
    try {
      execFileSync(
        process.execPath,
        [
          viteCli,
          "build",
          "--config",
          "vite.inject.config.ts",
          "--outDir",
          output,
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: withoutLocalGitOverrides(process.env),
          timeout: 180_000,
        },
      );
      const rebuilt = readFileSync(join(output, "designModeInject.js"), "utf8");
      const onDisk = readFileSync(committed, "utf8");
      if (rebuilt !== onDisk) {
        throw new Error(
          "주입 번들이 소스와 다릅니다 — `pnpm design-mode:bundle`을 실행해 커밋하세요.",
        );
      }
      expect(rebuilt).toBe(onDisk);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("번들이 IIFE이고 앱 모듈 시스템에 기대지 않는다", () => {
    const bundle = readFileSync(committed, "utf8");
    // import/export가 남아 있으면 임의 페이지에서 실행되지 않는다.
    expect(bundle).not.toMatch(/^\s*import\s/m);
    expect(bundle).not.toMatch(/^\s*export\s/m);
    expect(bundle).toContain("__DURE_DESIGN_MODE__");
  });
});
