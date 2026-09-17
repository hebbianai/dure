import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appRoot, appRootUnder } from "./dure-home.mjs";

describe("appRootUnder", () => {
  const roots = [];
  afterEach(() => {
    while (roots.length > 0)
      rmSync(roots.pop(), { recursive: true, force: true });
  });
  const fixtureHome = () => {
    const home = mkdtempSync(join(tmpdir(), "dure-home-"));
    roots.push(home);
    return home;
  };

  it("selects the canonical directory for a fresh home", () => {
    const home = fixtureHome();
    expect(appRootUnder(home)).toBe(join(home, ".dure"));
  });

  it("prefers a renamed directory once it exists", () => {
    // 마이그레이션(P2)을 마친 머신 — env 없이도 새 경로를 찾는다.
    const home = fixtureHome();
    mkdirSync(join(home, ".dure"));
    expect(appRootUnder(home)).toBe(join(home, ".dure"));
  });

  it("never falls back to a legacy writable root when .dure is unsafe", () => {
    const home = fixtureHome();
    writeFileSync(join(home, ".dure"), "x");
    expect(appRootUnder(home)).toBe(join(home, ".dure"));
  });
});

describe("appRoot", () => {
  it("honors DURE_HOME and treats an empty value as unset", () => {
    expect(appRoot({ DURE_HOME: "/tmp/portable" })).toBe("/tmp/portable");
    expect(appRoot({ DURE_HOME: "" })).not.toBe("");
    expect(appRoot({})).toMatch(/\.dure$/);
  });
});
