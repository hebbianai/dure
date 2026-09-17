import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("legacy orchestration mailbox", () => {
  test("is retired without creating an alternate authority", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-orch-retired-"));
    roots.push(root);

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "orch",
        "send",
        "--from",
        "worker-1",
        "--to",
        "coordinator-1",
        "--body",
        "legacy write must fail",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DURE_APP_CHANNEL: "stable",
          DURE_HOME: root,
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("retired with the file mailbox");
    expect(fs.existsSync(path.join(root, "orchestration.json"))).toBe(false);
  });
});
