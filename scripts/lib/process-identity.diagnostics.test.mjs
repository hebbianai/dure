import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileFaultInjectableMacosObserver } from "../qa/lib/owned-process-observer-fixture.mjs";

describe.runIf(process.platform === "darwin")("native observation diagnostics", () => {
  let root;
  let cache;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-observation-diagnostic-"));
    cache = path.join(root, `dure-process-boundary-${process.getuid()}`);
    fs.mkdirSync(cache, { mode: 0o700 });
    const digest = createHash("sha256")
      .update(fs.readFileSync(path.join(
        import.meta.dirname,
        "../native/owned-process-observer.c",
      )))
      .digest("hex")
      .slice(0, 20);
    compileFaultInjectableMacosObserver(path.join(cache, digest));
  });
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function observe(mode, fault = "") {
    const module = pathToFileURL(
      path.join(import.meta.dirname, "process-identity.mjs"),
    ).href;
    const result = spawnSync(process.execPath, [
      "--input-type=module", "-e", `
        const {observeProcessMembers, processMemberSnapshots, processLivenessFromObservation} = await import(${JSON.stringify(module)});
        const pids = [process.pid, ...Array.from({length: 256}, (_, i) => 2_000_000_000 + i)];
        const observation = process.argv[1] === "async"
          ? await observeProcessMembers({kind: "point", pids})
          : processMemberSnapshots(pids);
        console.log(JSON.stringify({pid: process.pid, observation,
          liveness: processLivenessFromObservation({pid: process.pid, processIdentity: "unobserved"}, observation)}));
      `, mode,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: root,
        DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT: fault,
      },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  it.each(["async", "sync"])("preserves the %s native permission failure across point batches", (mode) => {
    const { pid, observation, liveness } = observe(mode, "bsd-eperm");
    expect(observation).toMatchObject({
      status: "incomplete",
      reason: "process_member_observation_failed",
    });
    expect(observation.scope.requestedPids).toHaveLength(257);
    expect(observation.members).toBeUndefined();
    expect(liveness).toBe("unknown");
    expect(observation.diagnostic).toContain("status=15");
    expect(observation.diagnostic).toContain(`proc_bsdinfo pid=${pid} errno=1`);
    expect(observation.diagnostic.length).toBeLessThanOrEqual(256);
    expect(observation.diagnostic).not.toMatch(/[\r\n]/u);
  });

  it.each(["async", "sync"])("preserves the %s preparation failure without executing an unsafe cache", (mode) => {
    fs.chmodSync(cache, 0o777);
    try {
      const { observation, liveness } = observe(mode);
      expect(observation.status).toBe("incomplete");
      expect(liveness).toBe("unknown");
      expect(observation.diagnostic).toContain(
        "native process boundary cache is unsafe",
      );
    } finally {
      fs.chmodSync(cache, 0o700);
    }
  });

  it.each(["async", "sync"])("keeps successful %s observations free of failure diagnostics", (mode) => {
    const { pid, observation } = observe(mode);
    expect(observation.status).toBe("complete");
    expect(observation.scope.requestedPids).toHaveLength(257);
    expect(observation.members.map((member) => member.pid)).toEqual([pid]);
    expect(observation.diagnostic).toBeUndefined();
  });

  it("skips native metadata for a stale captured generation before its first detailed read", () => {
    const identityModule = pathToFileURL(
      path.join(import.meta.dirname, "process-identity.mjs"),
    ).href;
    const snapshotModule = pathToFileURL(
      path.join(import.meta.dirname, "../qa/lib/owned-process-snapshot.mjs"),
    ).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const {observeProcessMembers, processMemberSnapshots} = await import(${JSON.stringify(identityModule)});
      const {observeOwnedProcessSnapshot} = await import(${JSON.stringify(snapshotModule)});
      const current = processMemberSnapshots([process.pid]);
      if (current.status !== "complete" || current.members.length !== 1) throw Error(JSON.stringify(current));
      const identity = current.members[0].processIdentity;
      const split = identity.lastIndexOf(":");
      // Represent a retained ledger generation without forcing kernel PID reuse.
      const staleIdentity = identity.slice(0, split + 1) + (BigInt(identity.slice(split + 1)) + 1n);
      const expected = Object.freeze({pid: process.pid, kernelStartMarker: staleIdentity});
      const snapshot = Object.freeze({
        candidates: Object.freeze([Object.freeze({expected,
          exact: Object.freeze({pid: process.pid, processIdentity: staleIdentity})})]),
        ledger: Object.freeze([expected]), platform: "darwin",
      });
      process.env.DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT = "bsd-eperm";
      let metadataReads = 0;
      const observation = await observeOwnedProcessSnapshot(snapshot, {
        observeMembers: async (...args) => {
          metadataReads += 1;
          return observeProcessMembers(...args);
        }, timeoutMs: 2000,
      });
      const control = await observeProcessMembers({kind: "point", pids: [process.pid]});
      console.log(JSON.stringify({observation, metadataReads, control}));
    `], {
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: root,
        DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT: "",
      },
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const { observation, metadataReads, control } = JSON.parse(result.stdout);
    expect(observation).toEqual({
      members: [],
      scope: { kind: "point", requestedPids: [] },
      status: "complete",
    });
    expect(metadataReads).toBe(0);
    expect(control).toMatchObject({
      status: "incomplete",
      diagnostic: expect.stringContaining("proc_bsdinfo"),
    });
  });

  function observeLeader(mode, generation, fault) {
    const identityModule = pathToFileURL(
      path.join(import.meta.dirname, "process-identity.mjs"),
    ).href;
    const groupModule = pathToFileURL(
      path.join(import.meta.dirname, "../qa/lib/owned-process-group.mjs"),
    ).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs";
      import path from "node:path";
      const {observeProcessMembers} = await import(${JSON.stringify(identityModule)});
      const {observeExactProcessGeneration, freezeOwnedProcessTree, startOwnershipLedgerSampler} = await import(${JSON.stringify(groupModule)});
      const [mode, generation, fault, root] = process.argv.slice(1);
      const actual = observeExactProcessGeneration(process.pid);
      const supervisor = observeExactProcessGeneration(process.ppid);
      const split = actual.kernelStartMarker.lastIndexOf(":");
      // This retained-ledger fixture does not force OS PID reuse or a reboot.
      const stale = actual.kernelStartMarker.slice(0, split + 1) + (BigInt(actual.kernelStartMarker.slice(split + 1)) + 1n);
      const otherBoot = actual.kernelStartMarker.replace(/:macos:[^:]+:/u, ":macos:00000000-0000-0000-0000-000000000001:");
      const owned = {...actual, groupId: actual.pid, sessionId: actual.pid,
        kernelStartMarker: generation.includes("other-boot") ? otherBoot
          : generation === "reused" ? stale : actual.kernelStartMarker};
      const descriptor = {
        descriptorPath: path.join(root, "leader-" + process.pid + ".json"),
        groupId: owned.pid, leaderPid: owned.pid,
        leaderKernelStartMarker: owned.kernelStartMarker,
        leaderStartMarker: owned.startMarker,
        supervisorPid: supervisor.pid, supervisorKernelStartMarker: supervisor.kernelStartMarker,
        supervisorStartMarker: supervisor.startMarker, livenessWitnessVersion: "inherited-fd-v1",
      };
      let signals = 0;
      let publications = 0;
      let requests = 0;
      const observeMembers = async (...args) => {
        requests += 1;
        process.env.DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT = fault;
        try { return await observeProcessMembers(...args); }
        finally { delete process.env.DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT; }
      };
      const options = {
        observeMembers, processController: {signalGeneration() { signals += 1; throw Error("unexpected signal"); }},
        publishFrozen() { publications += 1; }, readLedger: () => [owned],
      };
      let observation;
      let error;
      try {
        if (mode === "freeze") await freezeOwnedProcessTree(descriptor, options);
        else if (mode === "sampler") {
          const monitor = await startOwnershipLedgerSampler(descriptor, [owned], false, options);
          await monitor.stop();
        } else observation = await observeMembers({kind: "user_census", expectedProcess: {
          pid: generation.startsWith("absent") ? 2_000_000_000 : owned.pid,
          processIdentity: owned.kernelStartMarker,
        }});
      } catch (cause) { error = cause.message; }
      const ledgerPath = descriptor.descriptorPath + ".ownership-ledger.json";
      const ledger = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : undefined;
      console.log(JSON.stringify({observation, error, signals, publications, requests, healthy: ledger?.healthy}));
    `, mode, generation, fault, root], {
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: root,
        DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT: "",
      },
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  it.each(["freeze", "sampler"])("refuses a reused leader before BSD metadata in the native %s path", (mode) => {
    const result = observeLeader(mode, "reused", "bsd-eperm");
    expect(result.error).toContain("process group leader generation changed");
    expect(result.error).not.toContain("proc_bsdinfo");
    expect(result).toMatchObject({ signals: 0, publications: 0, requests: 1 });
    if (mode === "sampler") expect(result.healthy).toBe(false);
  });

  it.each(["reused", "other-boot"])("reports a proven %s census precondition mismatch before BSD metadata", (generation) => {
    const { observation } = observeLeader("census", generation, "bsd-eperm");
    expect(observation).toMatchObject({
      status: "incomplete",
      reason: "process_generation_changed",
      diagnostic: expect.stringContaining("process generation changed"),
    });
    expect(observation.diagnostic).not.toContain("proc_bsdinfo");
    expect(observation.members).toBeUndefined();
  });

  it.each(["current", "absent", "absent-other-boot"])("preserves the full census with a %s precondition generation", (generation) => {
    const { observation } = observeLeader("census", generation, "");
    expect(observation.status).toBe("complete");
    expect(observation.scope.expectedProcess).toMatchObject({
      pid: expect.any(Number),
      processIdentity: expect.any(String),
    });
    expect(observation.members.length).toBeGreaterThan(0);
  });

  it.each(["bsd-eperm", "identity-eperm", "identity-eio"])("keeps %s unknown when the expected census generation is unproven", (fault) => {
    const { observation } = observeLeader("census", "current", fault);
    expect(observation).toMatchObject({
      status: "incomplete",
      reason: "process_member_observation_failed",
    });
    expect(observation.members).toBeUndefined();
  });
});
