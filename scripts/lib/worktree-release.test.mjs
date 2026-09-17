import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appControlDirectory, worktreeDevIdentity } from "./app-channel.mjs";
import { prepareWorktreePresentation, readWorktreeReleaseReceipt, stageWorktreeReleaseBundle, worktreeReleasePlan } from "./worktree-release.mjs";

const roots = [];
const base = { app: { macOSPrivateApi: true, windows: [{ title: "Dure", width: 1480 }] } };
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "dure-worktree-release-"));
  roots.push(home);
  const plan = worktreeReleasePlan("/projects/task", "qa", base);
  const sourceDirectory = appControlDirectory(home, plan.profile.sourceChannel);
  mkdirSync(sourceDirectory, { recursive: true, mode: 0o700 });
  const descriptor = { channel: plan.profile.sourceChannel, capabilities: ["worktree.presentation_export_v1"] };
  writeFileSync(join(sourceDirectory, "server.json"), JSON.stringify(descriptor), { mode: 0o600 });
  const raw = JSON.stringify({ version: 8, state: { spaces: [{ id: "space-a" }], agents: [{ id: "agent-a", hmuxSessionId: "session-a" }] } });
  const request = vi.fn(async () => ({ ok: true, schemaVersion: 1, sourceChannel: plan.profile.sourceChannel, serializedValue: raw }));
  return { home, plan, sourceDirectory, descriptor, raw, request };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("worktree release launcher contract", () => {
  it("preserves dev identity and isolates release control, bundle and storage identities", () => {
    const before = structuredClone(base);
    const first = worktreeReleasePlan("/projects/task", "qa", base);
    const second = worktreeReleasePlan("/projects/task", "other", base);
    expect(base).toEqual(before);
    expect(first.source).toEqual(worktreeDevIdentity("/projects/task", "qa"));
    expect(first.profile.targetChannel).not.toBe(first.source.channel);
    expect(first.profile.identifier).not.toBe(first.source.identifier);
    expect(first.profile.identifier).not.toBe("io.hebbian.ade");
    expect(first.profile.dataStoreIdentifier).not.toEqual(second.profile.dataStoreIdentifier);
    expect(first.config.build).toEqual({ devUrl: null, beforeDevCommand: null });
    expect(first.config.app.macOSPrivateApi).toBe(true);
    expect(first.config.app.windows[0].width).toBe(1480);
  });

  it("writes one private, complete envelope and reuses it without contacting the dev app", async () => {
    const f = fixture();
    const descriptorBefore = readFileSync(join(f.sourceDirectory, "server.json"), "utf8");
    const first = await prepareWorktreePresentation({ home: f.home, profile: f.plan.profile, request: f.request });
    const saved = readFileSync(first.pathname, "utf8");
    expect(JSON.parse(saved).serializedValue).toBe(f.raw);
    if (process.platform !== "win32") expect(statSync(first.pathname).mode & 0o777).toBe(0o600);
    f.request.mockRejectedValue(new Error("source offline"));
    expect(await prepareWorktreePresentation({ home: f.home, profile: f.plan.profile, request: f.request })).toEqual({ pathname: first.pathname, reused: true });
    expect(f.request).toHaveBeenCalledOnce();
    expect(readFileSync(first.pathname, "utf8")).toBe(saved);
    expect(readFileSync(join(f.sourceDirectory, "server.json"), "utf8")).toBe(descriptorBefore);
    renameSync(first.pathname, `${first.pathname}.imported`);
    expect((await prepareWorktreePresentation({ home: f.home, profile: f.plan.profile, request: f.request })).pathname).toBe(`${first.pathname}.imported`);
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("refuses unsupported or mismatched source apps before transport", async () => {
    for (const patch of [{ capabilities: [] }, { channel: "stable" }]) {
      const f = fixture();
      writeFileSync(join(f.sourceDirectory, "server.json"), JSON.stringify({ ...f.descriptor, ...patch }));
      await expect(prepareWorktreePresentation({ home: f.home, profile: f.plan.profile, request: f.request })).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
    }
  });

  it("retains a damaged or conflicting archive instead of replacing it from the source", async () => {
    const f = fixture();
    const first = await prepareWorktreePresentation({ home: f.home, profile: f.plan.profile, request: f.request });
    const original = readFileSync(first.pathname, "utf8");
    writeFileSync(`${first.pathname}.imported`, original, { mode: 0o600 });
    await expect(prepareWorktreePresentation({ home: f.home, profile: f.plan.profile, request: f.request })).rejects.toThrow("conflicts");
    rmSync(`${first.pathname}.imported`);
    const damaged = original.replace("session-a", "session-b");
    writeFileSync(first.pathname, damaged);
    await expect(prepareWorktreePresentation({ home: f.home, profile: f.plan.profile, request: f.request })).rejects.toThrow("checksum_mismatch");
    expect(readFileSync(first.pathname, "utf8")).toBe(damaged);
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("keeps the running bundle intact when a rebuilt artifact is staged", () => {
    const f = fixture();
    const sourceBundle = join(f.home, "build.app");
    const sourceExecutable = join(sourceBundle, "Contents/MacOS/dure");
    const artifactRoot = join(f.home, "artifacts");
    mkdirSync(join(sourceBundle, "Contents/MacOS"), { recursive: true });
    writeFileSync(sourceExecutable, "build-a", { mode: 0o755 });
    symlinkSync("MacOS/dure", join(sourceBundle, "Contents/alias"));
    const first = stageWorktreeReleaseBundle(sourceBundle, artifactRoot, f.plan.productName);
    expect(stageWorktreeReleaseBundle(sourceBundle, artifactRoot, f.plan.productName)).toEqual(first);
    expect(readlinkSync(join(first.bundle, "Contents/alias"))).toBe("MacOS/dure");
    writeFileSync(sourceExecutable, "build-b");
    const second = stageWorktreeReleaseBundle(sourceBundle, artifactRoot, f.plan.productName);
    expect(second.bundle).not.toBe(first.bundle);
    expect(readFileSync(join(first.bundle, "Contents/MacOS/dure"), "utf8")).toBe("build-a");
    expect(readFileSync(join(second.bundle, "Contents/MacOS/dure"), "utf8")).toBe("build-b");
  });

  it("rejects changed bundle resources and mismatched CLI identity before launch", () => {
    const f = fixture();
    const sourceBundle = join(f.home, "build.app");
    const artifactRoot = join(f.home, "artifacts");
    const cliRoot = join(f.home, "cli");
    const cliVersion = join(cliRoot, "versions/build-a");
    mkdirSync(join(sourceBundle, "Contents/MacOS"), { recursive: true });
    writeFileSync(join(sourceBundle, "Contents/MacOS/dure"), "build-a", { mode: 0o755 });
    writeFileSync(join(sourceBundle, "Contents/Info.plist"), "original resources");
    mkdirSync(cliVersion, { recursive: true });
    symlinkSync("versions/build-a", join(cliRoot, "current"));
    const staged = stageWorktreeReleaseBundle(sourceBundle, artifactRoot, f.plan.productName);
    const receiptPath = join(f.home, "build.json");
    const sourceRevision = "a".repeat(40);
    const cliArtifactDigest = "b".repeat(64);
    writeFileSync(receiptPath, JSON.stringify({ schemaVersion: 1, profile: f.plan.profile,
      bundleDigest: staged.bundleDigest, cliArtifactDigest, sourceRevision }));
    const metadata = { bundle: { artifactDigest: cliArtifactDigest,
      app: { channel: f.plan.profile.targetChannel, sourceRevision } } };
    const readCliMetadata = vi.fn(() => structuredClone(metadata));
    const options = { artifactRoot, productName: f.plan.productName, cliRoot, readCliMetadata };
    const read = () => readWorktreeReleaseReceipt(receiptPath, f.plan.profile, options);
    expect(read().executable).toBe(join(staged.bundle, "Contents/MacOS/dure"));
    expect(readCliMetadata).toHaveBeenCalledWith(realpathSync(cliVersion));
    for (const app of [{ ...metadata.bundle.app, channel: "stable" },
      { ...metadata.bundle.app, sourceRevision: "c".repeat(40) }]) {
      readCliMetadata.mockReturnValueOnce({ bundle: { ...metadata.bundle, app } });
      expect(read).toThrow("CLI no longer matches");
    }
    readCliMetadata.mockReturnValueOnce({ bundle: { ...metadata.bundle, artifactDigest: "c".repeat(64) } });
    expect(read).toThrow("CLI no longer matches");
    writeFileSync(join(staged.bundle, "Contents/Info.plist"), "changed resources");
    expect(read).toThrow("bundle changed");
  });
});
