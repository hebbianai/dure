import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installHmuxStub,
  runSessionCli,
  writeRegistry,
} from "./lib/dure-session-test-fixture.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dure-send-help-"));
  roots.push(root);
  const marker = join(root, "hmux-executed");
  const hmux = installHmuxStub(root, [], { markerPath: marker });
  return { root, marker, hmux };
}

describe("dure send help", () => {
  it.each([
    ["send", "--help"],
    ["send", "-h"],
    ["help", "send"],
  ])("prints command help before reading the registry: %s %s", (...args) => {
    const { root, marker, hmux } = fixture();
    const registry = join(root, "agents.json");
    writeFileSync(registry, "invalid registry", { mode: 0o600 });

    const result = runSessionCli(root, hmux, args);

    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(result.stdout).toContain("Usage: dure send <name> <text...>");
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(registry, "utf8")).toBe("invalid registry");
  });

  it.each(["hello", "--help", "-h"])(
    "preserves unknown-recipient errors with message %s",
    (message) => {
      const { root, marker, hmux } = fixture();
      writeRegistry(root, []);

      const result = runSessionCli(root, hmux, [
        "send", "missing-recipient", message,
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("missing-recipient");
      expect(result.stdout).toBe("");
      expect(existsSync(marker)).toBe(false);
    },
  );
});
