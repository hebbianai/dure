import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
test("release verification reports a failure reason before a later case completes", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "release-reporter-"));
  const reason = "release-reporter-first-failure";
  const marker = "release-reporter-later-completed";
  try {
    const config = path.join(fixture, "vitest.config.mts");
    const rootConfig = pathToFileURL(
      path.join(repositoryRoot, "vitest.config.ts"),
    );
    const vitest = pathToFileURL(
      path.join(repositoryRoot, "node_modules/vitest/dist/index.js"),
    );
    // Nonzero groups preserve this order with the release's single worker too.
    fs.writeFileSync(config, `
      import original from ${JSON.stringify(rootConfig.href)};
      export default {
        ...original,
        root: ${JSON.stringify(fixture)},
        test: {
          ...original.test,
          projects: [
            { test: { name: "first", include: ["first.test.mjs"], sequence: { groupOrder: 1 } } },
            { test: { name: "later", include: ["later.test.mjs"], sequence: { groupOrder: 2 } } },
          ],
        },
      };
    `);
    fs.writeFileSync(path.join(fixture, "first.test.mjs"), `
      import { test } from ${JSON.stringify(vitest.href)};
      test("first case fails", () => { throw new Error(${JSON.stringify(reason)}); });
    `);
    fs.writeFileSync(path.join(fixture, "later.test.mjs"), `
      import { test, expect } from ${JSON.stringify(vitest.href)};
      import { writeSync } from "node:fs";
      test("later case completes", () => {
        expect(true).toBe(true);
        // Bypass console capture to record the actual case completion.
        writeSync(1, ${JSON.stringify(`${marker}\n`)});
      });
    `);
    for (const release of [false, true]) {
      const environment = {
        ...process.env, CI: "true", GITHUB_ACTIONS: "true", NO_COLOR: "1",
      };
      delete environment.FORCE_COLOR;
      delete environment.DURE_RELEASE_VERIFICATION_ROOT;
      if (release) environment.DURE_RELEASE_VERIFICATION_ROOT = fixture;
      const log = path.join(fixture, release ? "release.log" : "ordinary.log");
      const output = fs.openSync(log, "w");
      let result;
      try {
        // One file offset preserves the order of stdout and stderr writes.
        result = spawnSync(process.execPath, [
          path.join(repositoryRoot, "node_modules/vitest/vitest.mjs"),
          "run", "--config", config,
        ], {
          cwd: fixture,
          env: environment,
          stdio: ["ignore", output, output],
          // Two children leave 20s for cleanup within the script project's 60s.
          timeout: 20_000,
          killSignal: "SIGKILL",
        });
      } finally {
        fs.closeSync(output);
      }
      const transcript = fs.readFileSync(log, "utf8");
      expect(result.error).toBeUndefined();
      expect(result.status, transcript).toBe(1);
      expect(transcript).toMatch(/Tests\s+1 failed \| 1 passed \(2\)/u);
      expect(transcript).toContain("::error file=");
      const failureOffset = transcript.indexOf(reason);
      const completionOffset = transcript.indexOf(marker);
      expect(failureOffset, transcript).toBeGreaterThanOrEqual(0);
      expect(completionOffset, transcript).toBeGreaterThanOrEqual(0);
      if (release) {
        expect(failureOffset, transcript).toBeLessThan(completionOffset);
      } else {
        expect(failureOffset, transcript).toBeGreaterThan(completionOffset);
      }
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
