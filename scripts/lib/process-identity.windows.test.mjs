import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";
import {
  isProcessAlive,
  parseWindowsProcessIdentity,
  processIdentity,
  processLiveness,
  processMemberSnapshots,
} from "./process-identity.mjs";
import { requireWindowsProcessIdentitySupport } from "./windows-process-identity-support.mjs";

it.runIf(process.platform !== "win32")(
  "routes Windows point observations through the shared native boundary",
  () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "dure-windows-identity-"));
    const boundary = join(fixtureRoot, "cscript.exe");
    writeFileSync(
      boundary,
      `#!${process.execPath}\n` +
        "process.stdout.write(" +
        '"M 4242 live windows:4242:1788220800123456 1788220800\\n"' +
        ");\n",
    );
    chmodSync(boundary, 0o700);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${fixtureRoot}${delimiter}${originalPath ?? ""}`;
      expect(processMemberSnapshots([4242], "win32")).toEqual({
        status: "complete",
        scope: { kind: "point", requestedPids: [4242] },
        members: [
          {
            pid: 4242,
            state: "live",
            processIdentity: "windows:4242:1788220800123456",
            startedAtUnixSeconds: 1788220800,
          },
        ],
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  },
);

it.runIf(process.platform === "win32")(
  "binds current and child generations for Windows launch supervision",
  async () => {
    const support = await requireWindowsProcessIdentitySupport();
    expect(parseWindowsProcessIdentity(support.current.processIdentity)).toMatchObject({
      pid: support.current.pid,
      processIdentity: support.current.processIdentity,
    });
    expect(parseWindowsProcessIdentity(support.child.processIdentity)).toMatchObject({
      pid: support.child.pid,
      processIdentity: support.child.processIdentity,
    });
    expect(
      processLiveness(
        {
          pid: support.current.pid,
          processIdentity: `${support.current.processIdentity}-reused`,
        },
        isProcessAlive,
        processIdentity,
      ),
    ).toBe("stale");
  },
  30_000,
);
