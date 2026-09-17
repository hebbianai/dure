import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  assertProviderSourceStable,
  assertSingleSessionLedger,
  createStateRoot,
  macosSandboxProfile,
  parseEmbeddedPackageEvidence,
  parseCargoTestExecutable,
  persistAndReplayOutput,
  providerEvidence,
  providerConformanceSourceHash,
  readProviderConformanceReceipt,
  requireSupportedProviderConformanceHost,
  retireStateRoot,
  validateProviderBinary,
  validateProviderConformanceReceipt,
  writeInvocationManifest,
} from "./plugin-native-provider-conformance.mjs";
import { ownedProcessGenerationDigestV1 } from "./lib/owned-process-persistence-v1.mjs";

const roots = [];
const hash = (character) => `sha256:${character.repeat(64)}`;
const operations = [
  "list_marketplaces",
  "add_marketplace",
  "install_plugin",
  "list_plugins",
  "remove_plugin",
  "list_plugins",
  "remove_marketplace",
  "list_marketplaces",
];
const mutations = [
  "add_marketplace",
  "install_plugin",
  "remove_plugin",
  "remove_marketplace",
];
const requiredCases = [
  {
    id: "codex_managed",
    provider: "codex",
    registration_target: "managed_profile",
    route_generation:
      "macos_codex_volume_file_id_exec_fchdir_relative_home_package_sealed_lexical_anchor_v3",
    scope: "managed",
  },
  {
    id: "claude_user",
    provider: "claude",
    registration_target: "user",
    route_generation:
      "macos_claude_volume_file_id_exec_home_package_sealed_lexical_anchor_v3",
    scope: "user",
  },
];

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-conformance-test-"));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function executable(root, name = "fixture") {
  const file = path.join(root, name);
  fs.writeFileSync(file, "fixture", { mode: 0o700 });
  return file;
}

function processFixture() {
  const descriptor = {
    groupId: 40,
    leaderKernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:40",
    leaderPid: 40,
    leaderStartMarker: "ps-lstart-v1:leader",
    terminateDetachedOwnedGenerations: true,
  };
  const ledger = [
    {
      groupId: 40,
      kernelStartMarker: descriptor.leaderKernelStartMarker,
      parentPid: 1,
      pid: 40,
      sessionId: 0,
      startMarker: descriptor.leaderStartMarker,
    },
    {
      groupId: 51,
      kernelStartMarker: "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:51",
      parentPid: 40,
      pid: 51,
      sessionId: 40,
      startMarker: "ps-lstart-v1:child",
    },
  ];
  const receipt = {
    descriptor: {
      groupId: descriptor.groupId,
      leader: {
        kernelStartMarker: descriptor.leaderKernelStartMarker,
        pid: descriptor.leaderPid,
        startMarker: descriptor.leaderStartMarker,
      },
    },
    ownedGenerations: {
      count: ledger.length,
      digest: ownedProcessGenerationDigestV1(ledger),
    },
    platform: process.platform,
    schema: "dure-qa-owned-process-exit/v1",
  };
  return { descriptor, ledger, receipt };
}

function receiptFixture() {
  const expected = {
    host: { arch: "aarch64", os: "macos" },
    package_materialization: {
      embedded_authority_sha256: hash("d"),
      file_manifest_sha256: hash("e"),
      plugin_id: "dure.beads",
      plugin_version: "0.2.0",
      root_device: "16777234",
      root_inode: "4815162342",
      schema_version: 1,
    },
    providers: {
      claude: { executable_sha256: hash("b"), version: "1.2.3" },
      codex: { executable_sha256: hash("a"), version: "4.5.6-beta.1" },
    },
    source_sha256: hash("c"),
  };
  const receipt = {
    cases: requiredCases.map((entry) => ({
      ...entry,
      inode_swap_mutations: [...mutations],
      lifecycle_operations: [...operations],
      status: "passed",
    })),
    host: { ...expected.host },
    package_materialization: { ...expected.package_materialization },
    providers: {
      claude: {
        executable_sha256: expected.providers.claude.executable_sha256,
        status: "passed",
        version: expected.providers.claude.version,
      },
      codex: {
        executable_sha256: expected.providers.codex.executable_sha256,
        status: "passed",
        version: expected.providers.codex.version,
      },
    },
    schema_version: 2,
    source_sha256: expected.source_sha256,
    status: "passed",
  };
  return { expected, receipt };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("plugin native provider conformance runner", () => {
  test("selects one exact compiled library test binary", () => {
    const file = executable(temporaryRoot());
    const output = [
      "ordinary diagnostic",
      JSON.stringify({
        executable: file,
        profile: { test: true },
        reason: "compiler-artifact",
        target: { name: "agent_ide_lib" },
      }),
    ].join("\n");

    expect(parseCargoTestExecutable(output)).toBe(fs.realpathSync(file));
  });

  test("rejects ambiguous test artifacts and unsafe provider files", () => {
    const root = temporaryRoot();
    const first = executable(root, "first");
    const second = executable(root, "second");
    const artifact = (file) =>
      JSON.stringify({
        executable: file,
        profile: { test: true },
        reason: "compiler-artifact",
        target: { name: "agent_ide_lib" },
      });
    expect(() => parseCargoTestExecutable(`${artifact(first)}\n${artifact(second)}`)).toThrow(
      "expected one",
    );

    fs.chmodSync(first, 0o722);
    expect(() => validateProviderBinary(first, "provider")).toThrow(
      "trusted direct executable",
    );

    const link = path.join(root, "provider-link");
    fs.symlinkSync(second, link);
    expect(() => validateProviderBinary(link, "provider")).toThrow(
      "trusted direct executable",
    );
  });

  test("binds the final detached-generation ledger to its exact exit receipt", () => {
    const { descriptor, ledger, receipt } = processFixture();
    expect(() => assertSingleSessionLedger(descriptor, ledger, receipt)).not.toThrow();

    const differentSessions = ledger.map((record) => ({ ...record }));
    differentSessions[1].sessionId = 51;
    const differentSessionsReceipt = structuredClone(receipt);
    differentSessionsReceipt.ownedGenerations.digest =
      ownedProcessGenerationDigestV1(differentSessions);
    expect(() =>
      assertSingleSessionLedger(descriptor, differentSessions, differentSessionsReceipt),
    ).not.toThrow();

    expect(() => assertSingleSessionLedger(descriptor, ledger, {
      ...receipt,
      ownedGenerations: { ...receipt.ownedGenerations, digest: "stale" },
    })).toThrow("exact final ledger");

    expect(() => assertSingleSessionLedger(descriptor, [ledger[0]], receipt)).toThrow(
      "did not observe a bounded provider process group",
    );
    const leaderOnlyReceipt = structuredClone(receipt);
    leaderOnlyReceipt.ownedGenerations = {
      count: 1,
      digest: ownedProcessGenerationDigestV1([ledger[0]]),
    };
    expect(() =>
      assertSingleSessionLedger(descriptor, [ledger[0]], leaderOnlyReceipt, {
        requireBoundedProviderGroup: false,
      }),
    ).not.toThrow();

    const invalid = ledger.map((record) => ({ ...record }));
    delete invalid[1].sessionId;
    expect(() => assertSingleSessionLedger(descriptor, invalid, receipt)).toThrow(
      "exact numeric identity",
    );

    expect(() =>
      assertSingleSessionLedger(
        { ...descriptor, terminateDetachedOwnedGenerations: false },
        ledger,
        receipt,
      ),
    ).toThrow("does not terminate detached generations");
  });

  test("rejects Linux and unknown architectures before a conformance launch", () => {
    expect(() => requireSupportedProviderConformanceHost("linux", "x64")).toThrowError(
      expect.objectContaining({ code: "plugin_native_provider_conformance_unsupported" }),
    );
    expect(() => requireSupportedProviderConformanceHost("darwin", "riscv64")).toThrowError(
      expect.objectContaining({ code: "plugin_native_provider_conformance_unsupported" }),
    );
    expect(requireSupportedProviderConformanceHost("darwin", "arm64")).toEqual({
      arch: "aarch64",
      os: "macos",
    });
    expect(() => requireSupportedProviderConformanceHost("darwin", "x64")).toThrowError(
      expect.objectContaining({ code: "plugin_native_provider_conformance_unsupported" }),
    );
  });

  test("macOS profile denies network and narrows reads and writes", () => {
    const profile = macosSandboxProfile({
      providerRoots: ["/trusted/codex", "/trusted/claude"],
      stateRoot: "/private/tmp/conformance-root",
      testBinaryRoot: "/workspace/repository/src-tauri/target/debug/deps",
    });
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(allow signal (target children))");
    expect(profile).toContain('(subpath "/trusted/codex")');
    expect(profile).toContain('(subpath "/trusted/claude")');
    expect(profile).toContain(
      '(subpath "/workspace/repository/src-tauri/target/debug/deps")',
    );
    expect(profile).not.toContain('(subpath "/workspace/repository")');
    expect(profile).toContain('(subpath "/private/tmp/conformance-root/state")');
    const writePolicy = profile.slice(
      profile.indexOf("(allow file-write*"),
      profile.indexOf("(allow mach-lookup"),
    );
    expect(writePolicy).not.toContain("/private/tmp/conformance-root/package");
    expect(profile).not.toContain('(allow file-write*\n  (subpath "/private/tmp/conformance-root")');
    expect(profile).not.toContain('(subpath "/opt")');
    expect(profile).not.toContain('(subpath "/")');
    expect(profile).not.toContain('(subpath "/etc")');
    expect(profile).toContain('(literal "/etc/codex/requirements.toml")');
    expect(profile).not.toContain(os.homedir());
    expect(profile).not.toContain("securityd");
  });

  test("macOS can start a process under the generated profile", () => {
    if (process.platform !== "darwin") return;
    const root = temporaryRoot();
    const profile = macosSandboxProfile({
      providerRoots: ["/usr/bin"],
      stateRoot: root,
      testBinaryRoot: "/bin",
    });
    const result = spawnSync("/usr/bin/sandbox-exec", [
      "-p",
      profile,
      "/bin/echo",
      "profile-started",
    ], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("profile-started\n");
  });

  test("requires an exact passed receipt for the pinned host, sources, and case matrix", () => {
    const { expected, receipt } = receiptFixture();
    expect(validateProviderConformanceReceipt(receipt, expected)).toBe(receipt);

    const omitted = structuredClone(receipt);
    omitted.cases.pop();
    expect(() => validateProviderConformanceReceipt(omitted, expected)).toThrow(
      "full case matrix",
    );

    const unpinned = structuredClone(receipt);
    unpinned.providers.codex.version = "latest";
    expect(() => validateProviderConformanceReceipt(unpinned, expected)).toThrow(
      "not pinned",
    );

    const wrongVersion = structuredClone(receipt);
    wrongVersion.providers.codex.version = "4.5.7";
    expect(() => validateProviderConformanceReceipt(wrongVersion, expected)).toThrow(
      "version does not match",
    );

    const extra = structuredClone(receipt);
    extra.cases[0].unverified = true;
    expect(() => validateProviderConformanceReceipt(extra, expected)).toThrow(
      "fields do not match",
    );

    const wrongSource = structuredClone(receipt);
    wrongSource.source_sha256 = hash("d");
    expect(() => validateProviderConformanceReceipt(wrongSource, expected)).toThrow(
      "source hash",
    );

    const unboundPackage = structuredClone(receipt);
    unboundPackage.package_materialization.root_inode = "0";
    expect(() => validateProviderConformanceReceipt(unboundPackage, expected)).toThrow(
      "package materialization",
    );

    const wrongEmbeddedAuthority = structuredClone(receipt);
    wrongEmbeddedAuthority.package_materialization.embedded_authority_sha256 = hash("f");
    expect(() =>
      validateProviderConformanceReceipt(wrongEmbeddedAuthority, expected),
    ).toThrow("build-embedded evidence");
  });

  test("parses build-embedded evidence from the Rust harness status line", () => {
    const sourceSha256 = hash("c");
    const record = {
      embedded_authority_sha256: hash("d"),
      file_manifest_sha256: hash("e"),
      plugin_id: "dure.beads",
      plugin_version: "0.2.0",
      root_device: "16777234",
      root_inode: "4815162342",
      schema_version: 1,
      source_sha256: sourceSha256,
    };
    const output = `running 1 test\ntest package ... DURE_QA_EMBEDDED_PACKAGE_EVIDENCE:${JSON.stringify(record)}\nok\n`;
    expect(parseEmbeddedPackageEvidence(output, sourceSha256)).toEqual({
      package_materialization: {
        embedded_authority_sha256: record.embedded_authority_sha256,
        file_manifest_sha256: record.file_manifest_sha256,
        plugin_id: record.plugin_id,
        plugin_version: record.plugin_version,
        root_device: record.root_device,
        root_inode: record.root_inode,
        schema_version: record.schema_version,
      },
      source_sha256: sourceSha256,
    });
    expect(() => parseEmbeddedPackageEvidence(output, hash("f"))).toThrow(
      "checkout freshness hash",
    );
  });

  test("reads receipts only from direct owner-only files", () => {
    const root = temporaryRoot();
    const { expected, receipt } = receiptFixture();
    const file = path.join(root, "receipt.json");
    fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 });
    expect(readProviderConformanceReceipt(file, expected)).toEqual(receipt);

    fs.chmodSync(file, 0o644);
    expect(() => readProviderConformanceReceipt(file, expected)).toThrow("owner-only");
    fs.chmodSync(file, 0o600);
    const link = path.join(root, "receipt-link.json");
    fs.symlinkSync(file, link);
    expect(() => readProviderConformanceReceipt(link, expected)).toThrow("owner-only");
  });

  test("hashes the complete trusted provider sources and rejects symlinks", () => {
    const root = temporaryRoot();
    const claude = path.join(root, "claude");
    const codex = path.join(root, "codex");
    fs.mkdirSync(claude, { mode: 0o700 });
    fs.mkdirSync(codex, { mode: 0o700 });
    fs.writeFileSync(path.join(claude, "SKILL.md"), "claude");
    fs.writeFileSync(path.join(codex, "SKILL.md"), "codex");
    const first = providerConformanceSourceHash(root);
    expect(first).toBe(
      "sha256:1c448555af15f992e986949a601418aa009caabbad4444fd577079f8280941a8",
    );
    expect(providerConformanceSourceHash(root)).toBe(first);
    fs.appendFileSync(path.join(codex, "SKILL.md"), " changed");
    expect(providerConformanceSourceHash(root)).not.toBe(first);

    fs.symlinkSync(path.join(claude, "SKILL.md"), path.join(codex, "linked.md"));
    expect(() => providerConformanceSourceHash(root)).toThrow("contains a symlink");
  });

  test("rejects source mutation across the Rust execution boundary", () => {
    const root = temporaryRoot();
    const source = path.join(root, "plugin.json");
    fs.writeFileSync(source, "before");
    const initialSourceSha256 = providerConformanceSourceHash(root);
    const receipt = { source_sha256: initialSourceSha256 };
    expect(() =>
      assertProviderSourceStable({
        finalSourceSha256: providerConformanceSourceHash(root),
        initialSourceSha256,
        receipt,
      }),
    ).not.toThrow();

    fs.writeFileSync(source, "after");
    const finalSourceSha256 = providerConformanceSourceHash(root);
    expect(() =>
      assertProviderSourceStable({
        finalSourceSha256,
        initialSourceSha256,
        receipt,
      }),
    ).toThrow("changed across the Rust execution boundary");
    expect(() =>
      assertProviderSourceStable({
        finalSourceSha256,
        initialSourceSha256: finalSourceSha256,
        receipt,
      }),
    ).toThrow("changed across the Rust execution boundary");
  });

  test("requires an explicit valid pin and binds it to the streamed executable hash", () => {
    const root = temporaryRoot();
    const file = executable(root);
    expect(() => providerEvidence(file, "provider")).toThrow("pin must be an object");
    const executableSha256 = `sha256:${crypto
      .createHash("sha256")
      .update("fixture")
      .digest("hex")}`;
    expect(
      providerEvidence(file, "provider", {
        executable_sha256: executableSha256,
        version: "1.2.3",
      }),
    ).toEqual(
      expect.objectContaining({
        executable: fs.realpathSync(file),
        executable_sha256: executableSha256,
        version: "1.2.3",
      }),
    );
    expect(() =>
      providerEvidence(file, "provider", {
        executable_sha256: hash("f"),
        version: "1.2.3",
      }),
    ).toThrow("pinned executable hash");
  });

  test("quarantines the exact state-root inode before trashing it", () => {
    const parent = temporaryRoot();
    const authority = createStateRoot(parent);
    let quarantined;
    retireStateRoot(authority, {
      platform: "darwin",
      trash(target) {
        quarantined = target;
        expect(path.dirname(target)).toBe(authority.parent);
        expect(fs.lstatSync(target).ino).toBe(Number(authority.inode));
        fs.rmSync(target, { recursive: true });
        return { status: 0 };
      },
    });
    expect(quarantined).toContain("dure-plugin-provider-conformance-quarantine-");
    expect(fs.existsSync(authority.lexicalPath)).toBe(false);
  });

  test("retains evidence when cleanup identity changes or trash fails", () => {
    const parent = temporaryRoot();
    const replaced = createStateRoot(parent);
    const original = `${replaced.lexicalPath}-original`;
    fs.renameSync(replaced.lexicalPath, original);
    fs.mkdirSync(replaced.lexicalPath, { mode: 0o700 });
    expect(() => retireStateRoot(replaced, { platform: "darwin" })).toThrow(
      "changed before cleanup",
    );
    expect(fs.existsSync(replaced.lexicalPath)).toBe(true);
    expect(fs.existsSync(original)).toBe(true);

    const linked = createStateRoot(parent);
    const linkedOriginal = `${linked.lexicalPath}-original`;
    const symlinkTarget = path.join(parent, "symlink-target");
    fs.renameSync(linked.lexicalPath, linkedOriginal);
    fs.mkdirSync(symlinkTarget, { mode: 0o700 });
    fs.symlinkSync(symlinkTarget, linked.lexicalPath);
    expect(() => retireStateRoot(linked, { platform: "darwin" })).toThrow(
      "changed before cleanup",
    );
    expect(fs.lstatSync(linked.lexicalPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(symlinkTarget)).toBe(true);

    const retained = createStateRoot(parent);
    let quarantined;
    let error;
    try {
      retireStateRoot(retained, {
        platform: "darwin",
        trash(target) {
          quarantined = target;
          return { status: 1, stderr: "denied" };
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error?.retainedEvidencePath).toBe(quarantined);
    expect(fs.existsSync(quarantined)).toBe(true);
    expect(fs.lstatSync(quarantined).ino).toBe(Number(retained.inode));
  });

  test("persists bounded owner-only output and a create-new redacted manifest", () => {
    const root = temporaryRoot();
    expect(
      persistAndReplayOutput(root, {
        error: Object.assign(new Error("overflow"), { code: "ENOBUFS" }),
        stderr: Buffer.from(""),
        stdout: Buffer.from(""),
      }),
    ).toBe(true);
    writeInvocationManifest(root, { command: "/usr/bin/env", token: "[redacted]" });

    for (const name of ["stdout.log", "stderr.log", "invocation-manifest.json"]) {
      expect(fs.lstatSync(path.join(root, name)).mode & 0o777).toBe(0o600);
    }
    expect(() => writeInvocationManifest(root, { command: "replacement" })).toThrow(
      /EEXIST/u,
    );
    expect(JSON.parse(fs.readFileSync(path.join(root, "invocation-manifest.json"), "utf8"))).toEqual(
      expect.objectContaining({ schema_version: 1, status: "prepared", token: "[redacted]" }),
    );
  });
});
