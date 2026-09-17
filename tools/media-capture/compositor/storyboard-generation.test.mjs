import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSafeOutputDirectory } from "./secure-output.mjs";
import {
  acquireStoryboardGenerationLock,
  releaseStoryboardGenerationLock,
  withAtomicStoryboardGeneration,
} from "./storyboard-generation.mjs";

const fixtureRoots = [];

async function fixture() {
  const allowedRoot = await mkdtemp(resolve(tmpdir(), "dure-generation-test-"));
  fixtureRoots.push(allowedRoot);
  return {
    allowedRoot,
    outputParent: resolve(allowedRoot, "storyboards", "onboarding", "en"),
  };
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("atomic storyboard output generations", () => {
  it("creates missing output ancestors below a canonical existing root", async () => {
    const paths = await fixture();
    const result = await ensureSafeOutputDirectory({
      ...paths,
      directory: paths.outputParent,
    });
    expect(result.outputDirectory).toBe(await realpath(paths.outputParent));
  });

  it("rejects symlinked and non-directory ancestors before creating descendants", async () => {
    const paths = await fixture();
    const outside = await mkdtemp(resolve(tmpdir(), "dure-generation-outside-"));
    fixtureRoots.push(outside);
    await symlink(outside, resolve(paths.allowedRoot, "linked"));
    await expect(
      ensureSafeOutputDirectory({
        allowedRoot: paths.allowedRoot,
        directory: resolve(paths.allowedRoot, "linked", "must-not-exist"),
      }),
    ).rejects.toThrow("symbolic link");
    await expect(readFile(resolve(outside, "must-not-exist"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeFile(resolve(paths.allowedRoot, "file"), "not a directory");
    await expect(
      ensureSafeOutputDirectory({
        allowedRoot: paths.allowedRoot,
        directory: resolve(paths.allowedRoot, "file", "child"),
      }),
    ).rejects.toThrow("non-directory ancestor");
  });

  it("rejects a symlink used as the allowed root itself", async () => {
    const realRoot = await mkdtemp(resolve(tmpdir(), "dure-generation-real-root-"));
    const linkParent = await mkdtemp(resolve(tmpdir(), "dure-generation-link-root-"));
    fixtureRoots.push(realRoot, linkParent);
    const linkedRoot = resolve(linkParent, "linked");
    await symlink(realRoot, linkedRoot);
    await expect(
      ensureSafeOutputDirectory({
        allowedRoot: linkedRoot,
        directory: resolve(linkedRoot, "child"),
      }),
    ).rejects.toThrow("not a real directory");
  });

  it("publishes a complete generation atomically and can seed the next one", async () => {
    const paths = await fixture();
    await withAtomicStoryboardGeneration(
      { ...paths, targetId: "mintlify" },
      async ({ stagingDirectory }) => {
        await mkdir(resolve(stagingDirectory, "frames"));
        await writeFile(resolve(stagingDirectory, "frames", "first.txt"), "one");
      },
    );

    const result = await withAtomicStoryboardGeneration(
      { ...paths, targetId: "mintlify", seedExisting: true },
      async ({ stagingDirectory }) => {
        expect(
          await readFile(resolve(stagingDirectory, "frames", "first.txt"), "utf8"),
        ).toBe("one");
        await writeFile(resolve(stagingDirectory, "second.txt"), "two");
        return "built";
      },
    );

    expect(result.value).toBe("built");
    expect(await readFile(resolve(result.finalDirectory, "second.txt"), "utf8")).toBe(
      "two",
    );
    expect(
      await readFile(resolve(result.finalDirectory, "frames", "first.txt"), "utf8"),
    ).toBe("one");
  });

  it("keeps the previous generation when a build fails", async () => {
    const paths = await fixture();
    await withAtomicStoryboardGeneration(
      { ...paths, targetId: "mintlify" },
      ({ stagingDirectory }) => writeFile(resolve(stagingDirectory, "media.webm"), "old"),
    );
    await expect(
      withAtomicStoryboardGeneration(
        { ...paths, targetId: "mintlify", seedExisting: true },
        async ({ stagingDirectory }) => {
          await writeFile(resolve(stagingDirectory, "media.webm"), "new");
          throw new Error("render failed");
        },
      ),
    ).rejects.toThrow("render failed");
    expect(
      await readFile(resolve(paths.outputParent, "mintlify", "media.webm"), "utf8"),
    ).toBe("old");
  });

  it("fails closed on a live owner and reclaims only a proven-dead owner", async () => {
    const paths = await fixture();
    const first = await acquireStoryboardGenerationLock({
      ...paths,
      targetId: "mintlify",
      isProcessAlive: async () => true,
    });
    await expect(
      acquireStoryboardGenerationLock({
        ...paths,
        targetId: "mintlify",
        isProcessAlive: async () => true,
      }),
    ).rejects.toThrow("already owned");
    await expect(
      acquireStoryboardGenerationLock({
        ...paths,
        targetId: "mintlify",
        isProcessAlive: async () => {
          throw new Error("EPERM");
        },
      }),
    ).rejects.toThrow("liveness is unknown");

    const reclaimed = await acquireStoryboardGenerationLock({
      ...paths,
      targetId: "mintlify",
      isProcessAlive: async () => false,
    });
    expect(reclaimed.owner.token).not.toBe(first.owner.token);
    await releaseStoryboardGenerationLock(reclaimed);
  });

  it("does not let two target generations run concurrently", async () => {
    const paths = await fixture();
    let releaseFirst;
    const firstMayFinish = new Promise((resolvePromise) => {
      releaseFirst = resolvePromise;
    });
    let announceStarted;
    const firstStarted = new Promise((resolvePromise) => {
      announceStarted = resolvePromise;
    });
    const first = withAtomicStoryboardGeneration(
      { ...paths, targetId: "mintlify" },
      async ({ stagingDirectory }) => {
        announceStarted();
        await firstMayFinish;
        await writeFile(resolve(stagingDirectory, "media.webm"), "first");
      },
    );
    await firstStarted;
    await expect(
      withAtomicStoryboardGeneration(
        { ...paths, targetId: "mintlify" },
        async () => {},
      ),
    ).rejects.toThrow("already owned");
    releaseFirst();
    await first;
  });

  it("rejects symlinks in an existing generation instead of seeding them", async () => {
    const paths = await fixture();
    await withAtomicStoryboardGeneration(
      { ...paths, targetId: "mintlify" },
      ({ stagingDirectory }) => writeFile(resolve(stagingDirectory, "safe.txt"), "safe"),
    );
    const outside = resolve(paths.allowedRoot, "outside.txt");
    await writeFile(outside, "private");
    await symlink(
      outside,
      resolve(paths.outputParent, "mintlify", "unsafe-link"),
    );

    await expect(
      withAtomicStoryboardGeneration(
        { ...paths, targetId: "mintlify", seedExisting: true },
        async () => {},
      ),
    ).rejects.toThrow("symbolic link");
    expect(
      await readFile(resolve(paths.outputParent, "mintlify", "safe.txt"), "utf8"),
    ).toBe("safe");
    expect((await readdir(paths.outputParent)).some((name) => name.endsWith(".partial"))).toBe(
      false,
    );
  });

  it("rejects a symlinked final target without mutating its destination", async () => {
    const paths = await fixture();
    await ensureSafeOutputDirectory({
      ...paths,
      directory: paths.outputParent,
    });
    const outside = await mkdtemp(resolve(tmpdir(), "dure-generation-target-"));
    fixtureRoots.push(outside);
    await symlink(outside, resolve(paths.outputParent, "mintlify"));

    await expect(
      withAtomicStoryboardGeneration(
        { ...paths, targetId: "mintlify" },
        ({ stagingDirectory }) =>
          writeFile(resolve(stagingDirectory, "must-not-exist"), "unsafe"),
      ),
    ).rejects.toThrow("final generation is not a directory");
    await expect(readFile(resolve(outside, "must-not-exist"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fences a replaced output parent and never cleans through its symlink", async () => {
    const paths = await fixture();
    const outside = await mkdtemp(resolve(tmpdir(), "dure-generation-swap-"));
    fixtureRoots.push(outside);
    await expect(
      withAtomicStoryboardGeneration(
        { ...paths, targetId: "mintlify" },
        async () => {
          await rename(paths.outputParent, `${paths.outputParent}.moved`);
          await symlink(outside, paths.outputParent);
        },
      ),
    ).rejects.toThrow(/symbolic link|real directory|changed during the generation/u);
    expect(await readdir(outside)).toEqual([]);
  });

  it("fails closed when an existing lock has no valid owner record", async () => {
    const paths = await fixture();
    await ensureSafeOutputDirectory({
      ...paths,
      directory: paths.outputParent,
    });
    const lockDirectory = resolve(paths.outputParent, ".mintlify.generation.lock");
    await mkdir(lockDirectory);
    await writeFile(resolve(lockDirectory, "owner.json"), "{}\n");
    await expect(
      acquireStoryboardGenerationLock({
        ...paths,
        targetId: "mintlify",
        isProcessAlive: async () => false,
      }),
    ).rejects.toThrow("invalid owner metadata");
  });

  it("rejects a malicious recovery journal before existing promotion code runs", async () => {
    const paths = await fixture();
    await ensureSafeOutputDirectory({
      ...paths,
      directory: paths.outputParent,
    });
    await writeFile(
      resolve(paths.outputParent, ".mintlify.promotion.json"),
      JSON.stringify({
        schemaVersion: 1,
        scenarioId: "mintlify",
        finalName: "mintlify",
        stagingName: "another-target",
        backupName: "another-target",
      }),
    );
    await expect(
      withAtomicStoryboardGeneration(
        { ...paths, targetId: "mintlify" },
        async () => {},
      ),
    ).rejects.toThrow("promotion journal is invalid");
  });
});
