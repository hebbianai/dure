import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { publishArchitectureBaseline } from "./lib/architecture-baseline-publication.mjs";

const temporaryDirectories = [];

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "architecture-baseline-publication-"),
  );
  temporaryDirectories.push(root);
  const scripts = path.join(root, "scripts");
  fs.mkdirSync(scripts);
  const baselinePath = path.join(
    scripts,
    "architecture-fitness-baseline.json",
  );
  const baseline = {
    schemaVersion: 1,
    directTauriInvoke: {},
    concreteProviderBranch: {},
    concreteRuntimeBranch: {},
    godFileLines: { "src/big.ts": 951 },
  };
  const source = `${JSON.stringify(baseline, null, 2)}\n`;
  fs.writeFileSync(baselinePath, source, { mode: 0o600 });
  fs.chmodSync(baselinePath, 0o664);
  return { root, baselinePath, baseline, source };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("architecture baseline publication", () => {
  test("atomically publishes the planned baseline with the existing mode", () => {
    const { root, baselinePath, baseline, source } = fixture();
    const next = {
      ...baseline,
      godFileLines: { "src/big.ts": 926 },
    };

    expect(
      publishArchitectureBaseline({
        root,
        expectedSource: source,
        baseline: next,
        temporaryToken: "success",
      }),
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(baselinePath, "utf8"))).toEqual(next);
    expect(fs.statSync(baselinePath).mode & 0o777).toBe(0o664);
    expect(fs.readdirSync(path.dirname(baselinePath))).toEqual([
      "architecture-fitness-baseline.json",
    ]);
  });

  test("refuses a concurrently changed baseline without creating residue", () => {
    const { root, baselinePath, baseline, source } = fixture();
    fs.writeFileSync(baselinePath, `${source}\n`);

    expect(() =>
      publishArchitectureBaseline({
        root,
        expectedSource: source,
        baseline: { ...baseline, godFileLines: {} },
        temporaryToken: "changed",
      }),
    ).toThrow("architecture baseline changed while ratchet was planning");
    expect(fs.readFileSync(baselinePath, "utf8")).toBe(`${source}\n`);
    expect(fs.readdirSync(path.dirname(baselinePath))).toEqual([
      "architecture-fitness-baseline.json",
    ]);
  });

  test("keeps the original baseline when durable temporary write fails", () => {
    const { root, baselinePath, baseline, source } = fixture();
    let fsyncCalls = 0;
    const faultingFileSystem = {
      ...fs,
      fsyncSync(descriptor) {
        fsyncCalls += 1;
        if (fsyncCalls === 3) throw new Error("injected fsync failure");
        return fs.fsyncSync(descriptor);
      },
    };

    expect(() =>
      publishArchitectureBaseline({
        root,
        expectedSource: source,
        baseline: { ...baseline, godFileLines: {} },
        fileSystem: faultingFileSystem,
        temporaryToken: "fault",
      }),
    ).toThrow("injected fsync failure");
    expect(fs.readFileSync(baselinePath, "utf8")).toBe(source);
    expect(fs.readdirSync(path.dirname(baselinePath))).toEqual([
      "architecture-fitness-baseline.json",
    ]);
  });

  test("cleans its lock when durable lock acquisition fails", () => {
    const { root, baselinePath, baseline, source } = fixture();
    let fsyncCalls = 0;
    const faultingFileSystem = {
      ...fs,
      fsyncSync(descriptor) {
        fsyncCalls += 1;
        if (fsyncCalls === 2) throw new Error("injected lock fsync failure");
        return fs.fsyncSync(descriptor);
      },
    };

    expect(() =>
      publishArchitectureBaseline({
        root,
        expectedSource: source,
        baseline: { ...baseline, godFileLines: {} },
        fileSystem: faultingFileSystem,
        temporaryToken: "lock-fault",
      }),
    ).toThrow("injected lock fsync failure");
    expect(fs.readFileSync(baselinePath, "utf8")).toBe(source);
    expect(fs.readdirSync(path.dirname(baselinePath))).toEqual([
      "architecture-fitness-baseline.json",
    ]);
  });

  test("serializes a second publisher from lock acquisition through rename", () => {
    const { root, baselinePath, baseline, source } = fixture();
    const firstBaseline = {
      ...baseline,
      godFileLines: { "src/big.ts": 926 },
    };
    const secondBaseline = {
      ...baseline,
      godFileLines: { "src/big.ts": 901 },
    };
    let competingError;
    let crossedBarrier = false;
    const barrierFileSystem = {
      ...fs,
      linkSync(existingPath, newPath) {
        fs.linkSync(existingPath, newPath);
        if (newPath.endsWith(".ratchet.lock") && !crossedBarrier) {
          crossedBarrier = true;
          const previousEnvironment = {
            LANG: process.env.LANG,
            LC_ALL: process.env.LC_ALL,
            TZ: process.env.TZ,
          };
          try {
            process.env.LANG = "ko_KR.UTF-8";
            process.env.LC_ALL = "ko_KR.UTF-8";
            process.env.TZ = "Asia/Seoul";
            publishArchitectureBaseline({
              root,
              expectedSource: source,
              baseline: secondBaseline,
              temporaryToken: "second",
            });
          } catch (error) {
            competingError = error;
          } finally {
            for (const [name, value] of Object.entries(previousEnvironment)) {
              if (value === undefined) delete process.env[name];
              else process.env[name] = value;
            }
          }
        }
      },
    };

    expect(
      publishArchitectureBaseline({
        root,
        expectedSource: source,
        baseline: firstBaseline,
        fileSystem: barrierFileSystem,
        temporaryToken: "first",
      }),
    ).toBe(true);
    expect(competingError?.message).toContain("holds the publication lock");
    expect(JSON.parse(fs.readFileSync(baselinePath, "utf8"))).toEqual(
      firstBaseline,
    );
    expect(fs.readdirSync(path.dirname(baselinePath))).toEqual([
      "architecture-fitness-baseline.json",
    ]);
  });

  test("reclaims a dead owner's identity-verified lock", () => {
    const { root, baselinePath, baseline, source } = fixture();
    const lockPath = `${baselinePath}.ratchet.lock`;
    const staleOwner = {
      schemaVersion: 1,
      pid: 2_147_483_647,
      token: "stale",
      processIdentity: "stale-process",
    };
    const ownerPath =
      `${lockPath}.${staleOwner.pid}.${staleOwner.token}.owner`;
    fs.writeFileSync(ownerPath, `${JSON.stringify(staleOwner)}\n`, {
      mode: 0o600,
    });
    fs.linkSync(ownerPath, lockPath);

    const next = { ...baseline, godFileLines: {} };
    expect(
      publishArchitectureBaseline({
        root,
        expectedSource: source,
        baseline: next,
        isProcessAlive: () => false,
        temporaryToken: "replacement",
      }),
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(baselinePath, "utf8"))).toEqual(next);
    expect(fs.readdirSync(path.dirname(baselinePath))).toEqual([
      "architecture-fitness-baseline.json",
    ]);
  });

  test("does not reclaim a stale lock without matching file identity", () => {
    const { root, baselinePath, baseline, source } = fixture();
    const lockPath = `${baselinePath}.ratchet.lock`;
    const staleOwner = {
      schemaVersion: 1,
      pid: 2_147_483_647,
      token: "mismatch",
      processIdentity: "stale-process",
    };
    const ownerPath =
      `${lockPath}.${staleOwner.pid}.${staleOwner.token}.owner`;
    const lockSource = `${JSON.stringify(staleOwner)}\n`;
    fs.writeFileSync(ownerPath, lockSource, { mode: 0o600 });
    fs.writeFileSync(lockPath, lockSource, { mode: 0o600 });

    expect(() =>
      publishArchitectureBaseline({
        root,
        expectedSource: source,
        baseline: { ...baseline, godFileLines: {} },
        isProcessAlive: () => false,
        temporaryToken: "replacement",
      }),
    ).toThrow("publication lock owner does not match");
    expect(fs.readFileSync(baselinePath, "utf8")).toBe(source);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(ownerPath)).toBe(true);
  });

  test("reclaims a lock after its pid is reused by another process", () => {
    const { root, baselinePath, baseline, source } = fixture();
    const lockPath = `${baselinePath}.ratchet.lock`;
    const staleOwner = {
      schemaVersion: 1,
      pid: process.pid,
      token: "reused",
      processIdentity: "previous-process",
    };
    const ownerPath =
      `${lockPath}.${staleOwner.pid}.${staleOwner.token}.owner`;
    fs.writeFileSync(ownerPath, `${JSON.stringify(staleOwner)}\n`, {
      mode: 0o600,
    });
    fs.linkSync(ownerPath, lockPath);

    const next = { ...baseline, godFileLines: {} };
    expect(
      publishArchitectureBaseline({
        root,
        expectedSource: source,
        baseline: next,
        isProcessAlive: () => true,
        getProcessIdentity: () => "replacement-process",
        temporaryToken: "replacement",
      }),
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(baselinePath, "utf8"))).toEqual(next);
    expect(fs.readdirSync(path.dirname(baselinePath))).toEqual([
      "architecture-fitness-baseline.json",
    ]);
  });
});
