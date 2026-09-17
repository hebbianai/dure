import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  recoverRetirementJournal,
  recoverRetirementJournals,
  retireIsolatedRoot,
  retirementCompleted,
  verifiedRetirementIdentityFromReceipts,
} from "./isolated-root-retirement.mjs";
import { ownedProcessGenerationDigestV1 } from "./owned-process-persistence-v1.mjs";

const temporaryPaths = [];

function temporaryRoot(prefix = "dure-root-retirement-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(root);
  return root;
}

function verifiedIdentity(root) {
  const stat = fs.lstatSync(root);
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function expectImmutableIntent(journal) {
  const intent = JSON.parse(fs.readFileSync(journal, "utf8"));
  expect(intent).toMatchObject({ schema: "dure-qa-root-retirement/v2" });
  expect(intent).not.toHaveProperty("state");
  return intent;
}

function rewriteAsLegacyJournal(journal, state, dropBoundary = false) {
  const legacy = {
    ...expectImmutableIntent(journal),
    schema: "dure-qa-root-retirement/v1",
    state,
  };
  if (dropBoundary) delete legacy.temporaryBoundary;
  fs.writeFileSync(journal, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
  return legacy;
}

function expectUnreachable(operation) {
  let failure;
  try {
    operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    code: "DURE_QA_ROOT_RETIREMENT_UNREACHABLE",
  });
  expect(failure.message).toContain("exact root generation is unreachable");
}

function retireVerifiedRoot(root, journals, options = {}) {
  return retireIsolatedRoot(root, journals, verifiedIdentity(root), options);
}

function interruptRetirement(root, journals, injectedBoundary, options = {}) {
  const states = {
    after_delete: "deleted",
    after_journal: "prepared",
    after_move: "renaming",
    after_remove: "deleting",
    after_rename: "renamed",
  };
  let paths;
  expect(() =>
    retireVerifiedRoot(root, journals, {
      ...options,
      onBoundary(boundary, current) {
        paths = current;
        if (boundary === injectedBoundary) throw new Error("injected stop");
      },
    }),
  ).toThrow(`retirement stopped in ${states[injectedBoundary]}`);
  return paths;
}

function interruptedExplicitBoundaryRetirement() {
  const boundary = temporaryRoot("dure-retirement-boundary-");
  const root = fs.mkdtempSync(path.join(boundary, "dure-retired-root-"));
  const journals = path.join(boundary, "journals");
  fs.writeFileSync(path.join(root, "owned-state"), "state\n");
  const { journal, quarantine } = interruptRetirement(
    root,
    journals,
    "after_rename",
    { temporaryBoundary: boundary },
  );
  return { boundary: fs.realpathSync(boundary), journal, quarantine, root };
}

function cleanupReceipt(root) {
  return JSON.stringify({
    schema: "dure-qa-hmux-reap/v1",
    stateRootIdentity: verifiedIdentity(root),
  });
}

function processExitReceipt(root, descriptorName, overrides = {}) {
  const { kernelMarkers, ...receiptOverrides } = overrides;
  const platform = receiptOverrides.platform ?? "linux";
  const hardContainmentKind =
    platform === "linux" ? "linux-pidfd-subreaper-v1" : undefined;
  const leaderKernelStartMarker = kernelMarkers?.leader ??
    (platform === "linux"
      ? "kernel-start-v2:linux:test-boot:4200"
      : "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:4200");
  const supervisorKernelStartMarker = kernelMarkers?.supervisor ??
    (platform === "linux"
      ? "kernel-start-v2:linux:test-boot:4300"
      : "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:4300");
  const descriptorPath = path.join(root, descriptorName);
  fs.writeFileSync(
    descriptorPath,
    `${JSON.stringify({
      groupId: 42,
      ...(hardContainmentKind ? { hardContainmentKind } : {}),
      leaderKernelStartMarker,
      leaderPid: 42,
      leaderStartMarker: "ps-lstart-v1:leader",
      livenessWitnessVersion: "inherited-fd-v1",
      schemaVersion: 1,
      supervisorKernelStartMarker,
      supervisorPid: 43,
      supervisorStartMarker: "ps-lstart-v1:supervisor",
      terminateDetachedOwnedGenerations: true,
    })}\n`,
    { mode: 0o600 },
  );
  const descriptorIdentity = verifiedIdentity(descriptorPath);
  const processGeneration = {
    groupId: 42,
    kernelStartMarker: leaderKernelStartMarker,
    parentPid: 43,
    pid: 42,
    sessionId: 42,
    startMarker: "ps-lstart-v1:leader",
  };
  const ledgerPath = `${descriptorPath}.ownership-ledger.json`;
  fs.writeFileSync(
    ledgerPath,
    `${JSON.stringify({
      groupId: 42,
      ...(hardContainmentKind ? { hardContainmentKind } : {}),
      healthy: true,
      leaderKernelStartMarker,
      leaderStartMarker: "ps-lstart-v1:leader",
      livenessWitnessVersion: "inherited-fd-v1",
      processes: [processGeneration],
      schemaVersion: 1,
      supervisorKernelStartMarker,
      supervisorPid: 43,
      supervisorStartMarker: "ps-lstart-v1:supervisor",
      terminateDetachedOwnedGenerations: true,
    })}\n`,
    { mode: 0o600 },
  );
  return JSON.stringify({
    capability: "hard_process_containment_v2",
    descriptor: {
      groupId: 42,
      identity: descriptorIdentity,
      leader: {
        kernelStartMarker: leaderKernelStartMarker,
        pid: 42,
        startMarker: "ps-lstart-v1:leader",
      },
      name: descriptorName,
      supervisor: {
        kernelStartMarker: supervisorKernelStartMarker,
        pid: 43,
        startMarker: "ps-lstart-v1:supervisor",
      },
    },
    ...(hardContainmentKind
      ? {
          hardContainment: {
            generationAtomicSignals: true,
            kind: hardContainmentKind,
          },
        }
      : {}),
    ownedGenerations: {
      count: 1,
      digest: ownedProcessGenerationDigestV1([processGeneration]),
      ledgerIdentity: verifiedIdentity(ledgerPath),
    },
    platform,
    schema: "dure-qa-owned-process-exit/v1",
    stateRootIdentity: verifiedIdentity(root),
    ...receiptOverrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const target of temporaryPaths.splice(0)) {
    fs.rmSync(target, { force: true, recursive: true });
  }
});

describe("isolated QA root retirement", () => {
  test("classifies only completed retirement outcomes as successful", () => {
    expect(retirementCompleted({ state: "retired" })).toBe(true);
    expect(retirementCompleted({ state: "already_retired" })).toBe(true);
    expect(retirementCompleted({ state: "reserved" })).toBe(false);
    expect(retirementCompleted({ state: "future_state" })).toBe(false);
  });

  test("CLI rejects a legacy reservation without reporting retirement", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const cleanup = cleanupReceipt(root);
    const processReceipts = [
      processExitReceipt(root, "app-process-group.json"),
      processExitReceipt(root, "client-process-group.json"),
    ];
    const { journal } = interruptRetirement(root, journals, "after_journal");
    rewriteAsLegacyJournal(journal, "prepared");

    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./isolated-root-retirement.mjs", import.meta.url)),
        "retire",
        root,
        journals,
        cleanup,
        ...processReceipts,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "isolated_root_retirement_incomplete: outcome=reserved",
    );
    expect(fs.lstatSync(root).isDirectory()).toBe(true);
    expect(fs.lstatSync(journal).isFile()).toBe(true);
  });

  test("preserves the typed unsupported-move result for retire and recovery", () => {
    const emptyPath = temporaryRoot("dure-no-python-");
    const retirementRoot = temporaryRoot();
    const retirementJournals = temporaryRoot("dure-cleanup-journals-");
    const previousPath = process.env.PATH;
    let retirementFailure;
    try {
      process.env.PATH = emptyPath;
      retireVerifiedRoot(retirementRoot, retirementJournals);
    } catch (error) {
      retirementFailure = error;
    } finally {
      process.env.PATH = previousPath;
    }

    expect(retirementFailure).toMatchObject({
      code: "DURE_QA_ROOT_RETIREMENT_UNSUPPORTED_MOVE",
    });
    expect(fs.lstatSync(retirementRoot).isDirectory()).toBe(true);
    expect(fs.readdirSync(retirementJournals)).toHaveLength(1);

    const recoveryRoot = temporaryRoot();
    const recoveryJournals = temporaryRoot("dure-cleanup-journals-");
    const { journal } = interruptRetirement(
      recoveryRoot,
      recoveryJournals,
      "after_journal",
    );
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./isolated-root-retirement.mjs", import.meta.url)),
        "recover",
        recoveryJournals,
      ],
      { encoding: "utf8", env: { ...process.env, PATH: emptyPath } },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("spawnSync python3 ENOENT");
    expect(fs.lstatSync(recoveryRoot).isDirectory()).toBe(true);
    expect(fs.lstatSync(journal).isFile()).toBe(true);
  });

  test("authorizes the exact root from Hmux and both contained owner receipts", () => {
    const root = temporaryRoot();
    const receipts = [
      processExitReceipt(root, "app-process-group.json"),
      processExitReceipt(root, "client-process-group.json"),
    ];

    expect(
      verifiedRetirementIdentityFromReceipts(
        root,
        cleanupReceipt(root),
        receipts,
      ),
    ).toEqual(verifiedIdentity(root));
  });

  test("rejects bootless Linux receipts before recursive retirement", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const kernelMarkers = {
      leader: "kernel-start-v1:linux:4200",
      supervisor: "kernel-start-v1:linux:4300",
    };
    const receipts = [
      processExitReceipt(root, "app-process-group.json", { kernelMarkers }),
      processExitReceipt(root, "client-process-group.json", { kernelMarkers }),
    ];

    expect(() =>
      retireIsolatedRoot(
        root,
        journals,
        verifiedRetirementIdentityFromReceipts(
          root,
          cleanupReceipt(root),
          receipts,
        ),
      )
    ).toThrow(
      "boot-bound Linux process generation is required",
    );
    expect(fs.lstatSync(root).isDirectory()).toBe(true);
  });

  test("rejects macOS observation as a hard-containment receipt", () => {
    const root = temporaryRoot();
    const receipts = [
      processExitReceipt(root, "app-process-group.json", {
        platform: "darwin",
      }),
      processExitReceipt(root, "client-process-group.json", {
        platform: "darwin",
      }),
    ];

    expect(() =>
      verifiedRetirementIdentityFromReceipts(
        root,
        cleanupReceipt(root),
        receipts,
      ),
    ).toThrow("process containment is not generation-atomic");
  });

  test("rejects the legacy v1 capability that overstated polling containment", () => {
    const root = temporaryRoot();
    const receipts = [
      processExitReceipt(root, "app-process-group.json", {
        capability: "hard_process_containment_v1",
      }),
      processExitReceipt(root, "client-process-group.json"),
    ];

    expect(() =>
      verifiedRetirementIdentityFromReceipts(
        root,
        cleanupReceipt(root),
        receipts,
      ),
    ).toThrow("process containment is not generation-atomic");
  });

  test("refuses ambient-style authorization without an atomic owner receipt", () => {
    const root = temporaryRoot();
    const receipts = [
      processExitReceipt(root, "app-process-group.json", {
        capability: "exact_process_observation_v1",
      }),
      processExitReceipt(root, "client-process-group.json"),
    ];

    expect(() =>
      verifiedRetirementIdentityFromReceipts(
        root,
        cleanupReceipt(root),
        receipts,
      ),
    ).toThrow("process containment is not generation-atomic");
  });

  test("requires distinct receipts for both QA process owners", () => {
    const root = temporaryRoot();
    const app = processExitReceipt(root, "app-process-group.json");

    expect(() =>
      verifiedRetirementIdentityFromReceipts(
        root,
        cleanupReceipt(root),
        [app, app],
      ),
    ).toThrow("do not cover the QA owners");
  });

  test("refuses a ledger changed in place after its exit receipt", () => {
    const root = temporaryRoot();
    const app = processExitReceipt(root, "app-process-group.json");
    const client = processExitReceipt(root, "client-process-group.json");
    fs.writeFileSync(
      path.join(root, "app-process-group.json.ownership-ledger.json"),
      `${JSON.stringify({ healthy: true, processes: [], schemaVersion: 1 })}\n`,
    );

    expect(() =>
      verifiedRetirementIdentityFromReceipts(
        root,
        cleanupReceipt(root),
        [app, client],
      ),
    ).toThrow("ownership ledger no longer matches its exit receipt");
  });

  test("refuses a descriptor downgraded after its exit receipt", () => {
    const root = temporaryRoot();
    const app = processExitReceipt(root, "app-process-group.json");
    const client = processExitReceipt(root, "client-process-group.json");
    const descriptorPath = path.join(root, "app-process-group.json");
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    fs.writeFileSync(
      descriptorPath,
      `${JSON.stringify({
        ...descriptor,
        terminateDetachedOwnedGenerations: false,
      })}\n`,
    );

    expect(() =>
      verifiedRetirementIdentityFromReceipts(
        root,
        cleanupReceipt(root),
        [app, client],
      ),
    ).toThrow("process descriptor no longer matches its exit receipt");
  });

  test("refuses an ownership header changed in place after its exit receipt", () => {
    const root = temporaryRoot();
    const app = processExitReceipt(root, "app-process-group.json");
    const client = processExitReceipt(root, "client-process-group.json");
    const ledgerPath = path.join(
      root,
      "app-process-group.json.ownership-ledger.json",
    );
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    fs.writeFileSync(
      ledgerPath,
      `${JSON.stringify({ ...ledger, supervisorPid: 44 })}\n`,
    );

    expect(() =>
      verifiedRetirementIdentityFromReceipts(
        root,
        cleanupReceipt(root),
        [app, client],
      ),
    ).toThrow("ownership ledger no longer matches its exit receipt");
  });

  test("deletes verified state and removes its completed journal", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    fs.writeFileSync(path.join(root, "owned-state"), "state\n");

    const result = retireVerifiedRoot(root, journals);

    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(result.quarantine)).toBe(false);
    expect(fs.existsSync(result.journal)).toBe(false);
  });

  test("serializes interleaved retirement attempts through one target journal", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    fs.writeFileSync(path.join(root, "owned-state"), "state\n");
    let ownerJournal;
    let contender;

    const result = retireVerifiedRoot(root, journals, {
      onBoundary(boundary, paths) {
        if (boundary !== "before_rename") return;
        ownerJournal = paths.journal;
        contender = retireVerifiedRoot(root, journals);
      },
    });

    expect(contender).toMatchObject({
      journal: ownerJournal,
      state: "retired",
    });
    expect(result.journal).toBe(ownerJournal);
    expect(result.state).toBe("already_retired");
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.readdirSync(journals)).toEqual([]);
    expect(recoverRetirementJournals(journals)).toEqual([]);
  });

  test("converges when recovery completes the intent before owner rename", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    let recovery;

    const owner = retireVerifiedRoot(root, journals, {
      onBoundary(boundary, paths) {
        if (boundary === "before_rename") {
          recovery = recoverRetirementJournal(paths.journal);
        }
      },
    });

    expect(recovery).toMatchObject({ state: "recovered" });
    expect(owner).toMatchObject({ state: "already_retired" });
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.readdirSync(journals)).toEqual([]);
  });

  test("converges when recovery completes the intent before owner deletion", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    let recovery;

    const owner = retireVerifiedRoot(root, journals, {
      onBoundary(boundary, paths) {
        if (boundary === "before_delete") {
          recovery = recoverRetirementJournal(paths.journal);
        }
      },
    });

    expect(recovery).toMatchObject({ state: "recovered" });
    expect(owner).toMatchObject({ state: "retired" });
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.readdirSync(journals)).toEqual([]);
  });

  test("retries when a listed intent is removed before it is read", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    let journal;

    expect(() =>
      retireVerifiedRoot(root, journals, {
        onBoundary(boundary, paths) {
          journal = paths.journal;
          if (boundary === "after_journal") throw new Error("injected stop");
        },
      }),
    ).toThrow("retirement stopped in prepared");

    const lstatSync = fs.lstatSync.bind(fs);
    let removed = false;
    vi.spyOn(fs, "lstatSync").mockImplementation((target, options) => {
      if (!removed && path.resolve(String(target)) === journal) {
        removed = true;
        fs.rmSync(journal);
      }
      return lstatSync(target, options);
    });

    expect(retireVerifiedRoot(root, journals)).toMatchObject({ state: "retired" });
    expect(removed).toBe(true);
    expect(fs.readdirSync(journals)).toEqual([]);
  });

  test("releases a stale reservation acquired after its target was retired", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const identity = verifiedIdentity(root);
    let winner;

    const contender = retireIsolatedRoot(root, journals, identity, {
      onBoundary(boundary) {
        if (boundary === "before_journal") {
          winner = retireIsolatedRoot(root, journals, identity);
        }
      },
    });

    expect(winner).toMatchObject({ state: "retired" });
    expect(contender).toMatchObject({ state: "already_retired" });
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.readdirSync(journals)).toEqual([]);
    expect(recoverRetirementJournals(journals)).toEqual([]);
  });

  test("recovers a stale reservation interrupted after peer retirement", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const identity = verifiedIdentity(root);
    let journal;

    expect(() =>
      retireIsolatedRoot(root, journals, identity, {
        onBoundary(boundary, paths) {
          if (boundary === "before_journal") {
            retireIsolatedRoot(root, journals, identity);
          }
          if (boundary === "after_journal") {
            journal = paths.journal;
            throw new Error("injected stale contender stop");
          }
        },
      }),
    ).toThrow("retirement stopped in prepared");

    expect(fs.existsSync(root)).toBe(false);
    expectImmutableIntent(journal);
    expect(recoverRetirementJournals(journals)).toEqual([
      { journal, state: "recovered" },
    ]);
    expect(fs.readdirSync(journals)).toEqual([]);
  });

  test("adopts the intent that owns an exact quarantine", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const { journal, quarantine } = interruptRetirement(
      root,
      journals,
      "after_rename",
    );

    expect(retireVerifiedRoot(quarantine, journals)).toMatchObject({
      journal,
      state: "retired",
    });
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
  });

  test("recovers an interrupted retirement within its recorded temporary boundary", () => {
    const { boundary, journal, quarantine, root } =
      interruptedExplicitBoundaryRetirement();

    expect(JSON.parse(fs.readFileSync(journal, "utf8"))).toMatchObject({
      temporaryBoundary: boundary,
    });
    expect(recoverRetirementJournal(journal)).toEqual({
      journal,
      state: "recovered",
    });
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
  });

  test("rejects a v2 journal whose target reservation identity changed", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const { journal } = interruptRetirement(root, journals, "after_journal");
    const record = JSON.parse(fs.readFileSync(journal, "utf8"));
    fs.writeFileSync(
      journal,
      `${JSON.stringify({
        ...record,
        target: {
          ...record.target,
          inode: String(BigInt(record.target.inode) + 1n),
        },
      })}\n`,
      { mode: 0o600 },
    );

    expect(() => recoverRetirementJournal(journal)).toThrow(
      "malformed target reservation",
    );
    expect(fs.lstatSync(root).isDirectory()).toBe(true);
    expect(fs.lstatSync(journal).isFile()).toBe(true);
  });

  test("rejects a v2 intent without its explicit temporary boundary", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const { journal } = interruptRetirement(root, journals, "after_journal");
    const record = expectImmutableIntent(journal);
    delete record.temporaryBoundary;
    fs.writeFileSync(journal, `${JSON.stringify(record)}\n`, { mode: 0o600 });

    expect(() => recoverRetirementJournal(journal)).toThrow(
      "malformed recovery journal",
    );
    expect(fs.lstatSync(root).isDirectory()).toBe(true);
    expect(fs.lstatSync(journal).isFile()).toBe(true);
  });

  test("refuses a recovery journal whose recorded temporary boundary changed", () => {
    const { journal, quarantine } =
      interruptedExplicitBoundaryRetirement();
    const record = JSON.parse(fs.readFileSync(journal, "utf8"));
    fs.writeFileSync(
      journal,
      `${JSON.stringify({
        ...record,
        temporaryBoundary: fs.realpathSync(os.tmpdir()),
      })}\n`,
      { mode: 0o600 },
    );

    expect(() => recoverRetirementJournal(journal)).toThrow(
      "unsafe recovery boundary",
    );
    expect(fs.lstatSync(quarantine).isDirectory()).toBe(true);
    expect(fs.lstatSync(journal).isFile()).toBe(true);
  });

  test("refuses a journal outside the explicit temporary boundary", () => {
    const boundary = temporaryRoot("dure-retirement-boundary-");
    const outside = temporaryRoot("dure-retirement-outside-");
    const root = fs.mkdtempSync(path.join(boundary, "dure-retired-root-"));
    const journals = path.join(outside, "journals");

    expect(() =>
      retireIsolatedRoot(
        root,
        journals,
        verifiedIdentity(root),
        { temporaryBoundary: boundary },
      ),
    ).toThrow("inside its temporary boundary");
    expect(fs.lstatSync(root).isDirectory()).toBe(true);
    expect(fs.existsSync(journals)).toBe(false);
  });

  test("recovers an immutable intent interrupted before rename", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    fs.writeFileSync(path.join(root, "owned-state"), "state\n");
    const { journal } = interruptRetirement(root, journals, "after_journal");

    expect(fs.lstatSync(root).isDirectory()).toBe(true);
    expectImmutableIntent(journal);
    expect(recoverRetirementJournal(journal)).toEqual({
      journal,
      state: "recovered",
    });
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
  });

  test("releases an old intent without protecting a lexical replacement", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const original = `${root}.original`;
    fs.writeFileSync(path.join(root, "owned-state"), "original\n");
    let oldJournal;

    expectUnreachable(() =>
      retireVerifiedRoot(root, journals, {
        onBoundary(boundary, paths) {
          if (boundary !== "after_journal") return;
          oldJournal = paths.journal;
          fs.renameSync(root, original);
          fs.mkdirSync(root, { mode: 0o700 });
          fs.writeFileSync(path.join(root, "owned-state"), "replacement\n");
        },
      }),
    );

    expect(fs.readFileSync(path.join(root, "owned-state"), "utf8")).toBe(
      "replacement\n",
    );
    expect(fs.readFileSync(path.join(original, "owned-state"), "utf8")).toBe(
      "original\n",
    );
    expect(fs.existsSync(oldJournal)).toBe(false);
    expect(retireVerifiedRoot(root, journals).state).toBe("retired");
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.readdirSync(journals)).toEqual([]);
    temporaryPaths.push(original);
  });

  test("does not accumulate intents for unreachable generations", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");

    for (let attempt = 0; attempt < 129; attempt += 1) {
      const displaced = `${root}.displaced-${attempt}`;
      temporaryPaths.push(displaced);
      expectUnreachable(() =>
        retireVerifiedRoot(root, journals, {
          onBoundary(boundary) {
            if (boundary !== "after_journal") return;
            fs.renameSync(root, displaced);
            fs.mkdirSync(root, { mode: 0o700 });
          },
        }),
      );
      expect(fs.readdirSync(journals)).toEqual([]);
    }
  });

  test("recovers every valid intent beyond the former directory cap", () => {
    const journals = temporaryRoot("dure-cleanup-journals-");
    const roots = Array.from({ length: 129 }, () => temporaryRoot());

    for (const root of roots) {
      interruptRetirement(root, journals, "after_journal");
    }

    expect(fs.readdirSync(journals)).toHaveLength(129);
    expect(recoverRetirementJournals(journals)).toHaveLength(129);
    expect(roots.some((root) => fs.existsSync(root))).toBe(false);
    expect(fs.readdirSync(journals)).toEqual([]);
  });

  test("refuses a root replaced after cleanup verification", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const verified = verifiedIdentity(root);
    const original = `${root}.original`;
    fs.writeFileSync(path.join(root, "owned-state"), "original\n");
    fs.renameSync(root, original);
    fs.mkdirSync(root, { mode: 0o700 });
    fs.writeFileSync(path.join(root, "owned-state"), "replacement\n");
    temporaryPaths.push(original);

    expect(() => retireIsolatedRoot(root, journals, verified)).toThrow(
      "root generation changed since cleanup verification",
    );
    expect(fs.readFileSync(path.join(root, "owned-state"), "utf8")).toBe(
      "replacement\n",
    );
    expect(fs.readFileSync(path.join(original, "owned-state"), "utf8")).toBe(
      "original\n",
    );
  });

  test("deletes the exact quarantine while preserving a replacement target", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const { journal, quarantine } = interruptRetirement(
      root,
      journals,
      "after_rename",
    );
    fs.mkdirSync(root, { mode: 0o700 });
    fs.writeFileSync(path.join(root, "replacement"), "replacement\n");

    expect(recoverRetirementJournal(journal)).toEqual({
      journal,
      state: "recovered",
    });
    expect(fs.readFileSync(path.join(root, "replacement"), "utf8")).toBe(
      "replacement\n",
    );
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
  });

  test("fails closed on a pre-existing foreign quarantine", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    let journal;
    let quarantine;

    expect(() =>
      retireVerifiedRoot(root, journals, {
        onBoundary(boundary, paths) {
          journal = paths.journal;
          quarantine = paths.quarantine;
          if (boundary === "before_journal") {
            fs.mkdirSync(quarantine, { mode: 0o700 });
            fs.writeFileSync(path.join(quarantine, "foreign"), "foreign\n");
          }
        },
      }),
    ).toThrow("target and quarantine both exist");

    expect(() => recoverRetirementJournal(journal)).toThrow(
      "target and quarantine both exist",
    );
    expect(fs.lstatSync(root).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(quarantine, "foreign"), "utf8")).toBe(
      "foreign\n",
    );
    expect(fs.lstatSync(journal).isFile()).toBe(true);
    temporaryPaths.push(quarantine);
  });

  test("preserves an empty quarantine created at the rename boundary", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const targetIdentity = verifiedIdentity(root);
    let foreignIdentity;
    let journal;
    let quarantine;

    expect(() =>
      retireVerifiedRoot(root, journals, {
        onBoundary(boundary, paths) {
          if (boundary !== "before_rename") return;
          ({ journal, quarantine } = paths);
          fs.mkdirSync(quarantine, { mode: 0o700 });
          foreignIdentity = verifiedIdentity(quarantine);
        },
      }),
    ).toThrow("atomic no-replace move refused");

    expect(() => recoverRetirementJournal(journal)).toThrow(
      "target and quarantine both exist",
    );
    expect(verifiedIdentity(root)).toEqual(targetIdentity);
    expect(verifiedIdentity(quarantine)).toEqual(foreignIdentity);
    expect(fs.readdirSync(quarantine)).toEqual([]);
    expect(fs.lstatSync(journal).isFile()).toBe(true);
    temporaryPaths.push(quarantine);
  });

  test("recovers a legacy v1 journal under the default temporary boundary", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    fs.writeFileSync(path.join(root, "owned-state"), "state\n");
    let { journal, quarantine } = interruptRetirement(
      root,
      journals,
      "after_rename",
    );

    rewriteAsLegacyJournal(journal, "renamed", true);
    const legacyJournal = path.join(
      fs.realpathSync(os.tmpdir()),
      path.basename(journal),
    );
    fs.renameSync(journal, legacyJournal);
    journal = legacyJournal;
    temporaryPaths.push(journal);

    expect(() =>
      recoverRetirementJournal(journal, {
        onBoundary(step) {
          if (step === "after_deleting_journal") {
            throw new Error("injected recovery stop");
          }
        },
      }),
    ).toThrow("injected recovery stop");
    expect(JSON.parse(fs.readFileSync(journal, "utf8"))).toMatchObject({
      state: "deleting",
    });
    expect(JSON.parse(fs.readFileSync(journal, "utf8"))).not.toHaveProperty(
      "temporaryBoundary",
    );

    expect(recoverRetirementJournal(journal)).toEqual({
      journal,
      state: "recovered",
    });
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(quarantine)).toBe(false);
    expect(fs.existsSync(journal)).toBe(false);
  });

  test("preserves a legacy prepared target and its journal", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const { journal } = interruptRetirement(root, journals, "after_journal");
    rewriteAsLegacyJournal(journal, "prepared");

    expect(recoverRetirementJournal(journal)).toEqual({
      journal,
      state: "preserved",
    });
    expect(fs.lstatSync(root).isDirectory()).toBe(true);
    expect(fs.lstatSync(journal).isFile()).toBe(true);
  });

  test("keeps an ambiguous legacy renamed journal when both paths are absent", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const { journal, quarantine } = interruptRetirement(
      root,
      journals,
      "after_rename",
    );
    rewriteAsLegacyJournal(journal, "renamed");
    fs.rmSync(quarantine, { recursive: true });

    expect(() => recoverRetirementJournal(journal)).toThrow(
      "journal cannot prove the root was deleted",
    );
    expect(fs.lstatSync(journal).isFile()).toBe(true);
  });

  test.each([
    ["prepared", "after_journal"],
    ["renaming", "after_move"],
  ])("releases a poisoned legacy v1 %s journal", (state, injectedBoundary) => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const { journal, quarantine } = interruptRetirement(
      root,
      journals,
      injectedBoundary,
    );
    rewriteAsLegacyJournal(journal, state);
    fs.rmSync(root, { force: true, recursive: true });
    fs.rmSync(quarantine, { force: true, recursive: true });

    expect(recoverRetirementJournal(journal)).toEqual({
      journal,
      state: "recovered",
    });
    expect(fs.existsSync(journal)).toBe(false);
  });

  test("clears a completed journal after deletion", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const { journal } = interruptRetirement(root, journals, "after_remove");

    expect(recoverRetirementJournals(journals)).toEqual([
      { journal, state: "recovered" },
    ]);
    expect(fs.existsSync(journal)).toBe(false);
  });

  test("releases intent when a foreign quarantine hides the exact generation", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const { journal, quarantine } = interruptRetirement(
      root,
      journals,
      "after_move",
    );

    const original = `${quarantine}.original`;
    fs.renameSync(quarantine, original);
    fs.mkdirSync(quarantine);
    fs.writeFileSync(path.join(quarantine, "replacement"), "replacement\n");
    temporaryPaths.push(original, quarantine);

    expectUnreachable(() => recoverRetirementJournal(journal));
    expect(fs.readFileSync(path.join(quarantine, "replacement"), "utf8")).toBe(
      "replacement\n",
    );
    expect(fs.lstatSync(original).isDirectory()).toBe(true);
    expect(fs.existsSync(journal)).toBe(false);
  });

  test("releases intent when a failed delete leaves a foreign quarantine", () => {
    const root = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const { journal, quarantine } = interruptRetirement(
      root,
      journals,
      "after_rename",
    );

    const original = `${quarantine}.original`;
    const rmSync = fs.rmSync.bind(fs);
    vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (path.resolve(String(target)) === quarantine) {
        fs.renameSync(quarantine, original);
        fs.mkdirSync(quarantine);
        fs.writeFileSync(path.join(quarantine, "replacement"), "replacement\n");
        throw new Error("injected delete failure");
      }
      return rmSync(target, options);
    });

    expectUnreachable(() => recoverRetirementJournal(journal));
    vi.restoreAllMocks();
    expect(fs.readFileSync(path.join(quarantine, "replacement"), "utf8")).toBe(
      "replacement\n",
    );
    expect(fs.lstatSync(original).isDirectory()).toBe(true);
    expect(fs.existsSync(journal)).toBe(false);
    temporaryPaths.push(original, quarantine);
  });

  test("refuses symlink roots without changing their targets", () => {
    const target = temporaryRoot();
    const journals = temporaryRoot("dure-cleanup-journals-");
    const link = `${target}-link`;
    fs.symlinkSync(target, link);
    temporaryPaths.push(link);

    expect(() => retireVerifiedRoot(link, journals)).toThrow(
      "root is not a direct directory",
    );
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(target).isDirectory()).toBe(true);
  });
});
