import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createPublicReleaseFixture } from "./fixtures/public-release-cli.mjs";

const script = path.resolve("scripts/release-public.mjs"),
  roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture(options) {
  const value = createPublicReleaseFixture(options);
  roots.push(value.root);
  return value;
}
function stage(value) {
  return value.run(
    script,
    "stage",
    "v0.2.29",
    value.original,
    value.sourceSha,
    "full",
  );
}
function success(result) {
  expect(result.status, result.stdout + result.stderr).toBe(0);
}
const writes = (value) =>
  value
    .calls()
    .filter(
      (args) =>
        (args[0] === "release" &&
          ["create", "upload", "edit"].includes(args[1])) ||
        args.includes("PUT"),
    );

test("stages exactly four immutable assets once and observes a repeated stage without writes", () => {
  const value = fixture();
  success(stage(value));
  const assets = value.state().release.assets;
  expect(assets).toHaveLength(4);
  expect(writes(value).filter((args) => args[1] === "upload")).toHaveLength(4);
  success(stage(value));
  expect(value.state().release.assets).toEqual(assets);
  expect(writes(value)).toHaveLength(5);
});

test("reconciles lost create and upload responses without duplicate or clobber writes", () => {
  const value = fixture();
  value.change({ lostCreateResponse: true, lostUpload: "Dure.app.tar.gz" });
  success(stage(value));
  expect(value.state().release.assets).toHaveLength(4);
  expect(writes(value).filter((args) => args[1] === "create")).toHaveLength(1);
  expect(writes(value).filter((args) => args[1] === "upload")).toHaveLength(4);
  expect(writes(value).flat()).not.toContain("--clobber");
});

test("an unaccepted upload stops, and a later stage uploads only names still missing", () => {
  const value = fixture();
  value.change({ failedUpload: "Dure_0.2.29_aarch64.dmg" });
  expect(stage(value).status).toBe(1);
  const existing = value.state().release.assets;
  expect(existing.map((asset) => asset.name)).toEqual([
    "Dure.app.tar.gz",
    "Dure.app.tar.gz.sig",
  ]);
  value.change({ failedUpload: null });
  success(stage(value));
  for (const asset of existing)
    expect(
      value.state().release.assets.find((item) => item.id === asset.id),
    ).toEqual(asset);
  expect(
    writes(value).filter(
      (args) => args[1] === "upload" && args.at(-1).endsWith("Dure.app.tar.gz"),
    ),
  ).toHaveLength(1);
});

test.each([403, 500])(
  "a release read HTTP %s is not treated as an absent draft",
  (status) => {
    const value = fixture();
    value.change({ releaseReadError: status });
    expect(stage(value).status).toBe(1);
    expect(writes(value)).toEqual([]);
  },
);

test("refuses a changed existing asset without deleting or overwriting it", () => {
  const value = fixture();
  success(stage(value));
  const released = value.state().release;
  released.assets[0].digest = "sha256:changed";
  value.change({ release: released });
  const before = writes(value).length;
  expect(stage(value).stderr).toContain("release_asset_mismatch");
  expect(writes(value)).toHaveLength(before);
});

test("read-only verification compares the successful run bytes and does not publish", () => {
  const value = fixture();
  success(stage(value));
  const before = writes(value).length;
  success(value.run(script, "verify", "v0.2.29"));
  expect(writes(value)).toHaveLength(before);
  expect(value.state().release.draft).toBe(true);
});

test.each([
  { runConclusion: "failure" },
  { ciConclusion: "failure" },
  { actualVerification: "skipped" },
  { tamperDownload: true },
  { headBranch: "topic" },
])("refuses publication when independent evidence disagrees: %j", (failure) => {
  const value = fixture();
  success(stage(value));
  value.change(failure);
  const before = writes(value).length;
  expect(value.run(script, "publish", "v0.2.29").status).toBe(1);
  expect(writes(value)).toHaveLength(before);
  expect(value.state().release.draft).toBe(true);
});

test("publishes nonlatest beta, independently downloads it, and conditionally migrates the existing feed", () => {
  const value = fixture();
  success(stage(value));
  const before = value.state();
  success(value.run(script, "publish", "v0.2.29"));
  const after = value.state();
  expect(after.release.draft).toBe(false);
  expect(after.release.assets).toEqual(before.release.assets);
  const manifest = JSON.parse(Buffer.from(after.previous.content, "base64"));
  expect(manifest.version).toBe("0.2.29");
  expect(manifest.platforms["darwin-aarch64"].url).toBe(
    "https://github.com/hebbianai/dure/releases/download/v0.2.29/Dure.app.tar.gz",
  );
  expect(writes(value).filter((args) => args[1] === "edit")[0]).toEqual(
    expect.arrayContaining(["--latest=false", "--prerelease"]),
  );
  const downloads = fs
    .readFileSync(value.env.RELEASE_TEST_CURL, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(downloads.filter((args) => args.includes("--output"))).toHaveLength(4);
  expect(downloads.every((args) => args[0] === "--disable")).toBe(true);
});

test("recovers lost publish and feed responses from exact committed readback", () => {
  const value = fixture();
  success(stage(value));
  value.change({ lostPublishResponse: true, lostMetadataResponse: true });
  success(value.run(script, "publish", "v0.2.29"));
  expect(writes(value).filter((args) => args[1] === "edit")).toHaveLength(1);
  expect(writes(value).filter((args) => args.includes("PUT"))).toHaveLength(1);
});

test("raw-cache disagreement stays nongreen; metadata-only resumes without touching assets", () => {
  const value = fixture();
  success(stage(value));
  value.change({ staleReadback: true });
  expect(value.run(script, "publish", "v0.2.29").stderr).toContain(
    "beta_metadata_anonymous_readback_mismatch",
  );
  const assets = value.state().release.assets,
    count = writes(value).length;
  value.change({ staleReadback: false });
  success(value.run(script, "metadata-only", "v0.2.29"));
  expect(value.state().release.assets).toEqual(assets);
  expect(writes(value)).toHaveLength(count);
});

test("a concurrently newer compatibility feed is never replaced", () => {
  const value = fixture();
  success(stage(value));
  value.change({ metadataConflict: true });
  expect(value.run(script, "publish", "v0.2.29").stderr).toContain(
    "beta_metadata_downgrade_refused",
  );
  expect(
    JSON.parse(Buffer.from(value.state().previous.content, "base64")).version,
  ).toBe("0.2.30");
  expect(writes(value).filter((args) => args.includes("PUT"))).toHaveLength(1);
});

test("a successful publish response without observed publication stays nongreen", () => {
  const value = fixture();
  success(stage(value));
  value.change({ publishStillDraft: true });
  const result = value.run(script, "publish", "v0.2.29");
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain("release_publication_unconfirmed");
  expect(value.state().release.draft).toBe(true);
  expect(writes(value).filter((args) => args.includes("PUT"))).toHaveLength(0);
});

test("metadata-only refuses an unpublished draft and stage refuses an already public version", () => {
  const value = fixture();
  success(stage(value));
  expect(value.run(script, "metadata-only", "v0.2.29").stderr).toContain(
    "metadata_only_requires_public_release",
  );
  success(value.run(script, "publish", "v0.2.29"));
  const before = writes(value).length;
  expect(stage(value).stderr).toContain("release_already_public");
  expect(value.run(script, "publish", "v0.2.29").stderr).toContain(
    "release_already_public",
  );
  expect(writes(value)).toHaveLength(before);
});

test("the privileged version writer rejects a patch with an extra runtime change", () => {
  const value = fixture({ remoteVersion: false });
  const patchFile = path.join(value.candidate, "version.patch");
  fs.appendFileSync(
    patchFile,
    "\ndiff --git a/unreviewed b/unreviewed\nnew file mode 100644\n--- /dev/null\n+++ b/unreviewed\n@@ -0,0 +1 @@\n+unexpected\n",
  );
  const manifestFile = path.join(value.candidate, "candidate.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  manifest.patchSha256 = createHash("sha256")
    .update(fs.readFileSync(patchFile))
    .digest("hex");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  expect(value.run(script, "version", value.candidate).status).toBe(1);
  expect(value.git("rev-parse", "HEAD")).toBe(value.sourceSha);
  expect(
    value.git(
      "ls-remote",
      "--refs",
      "origin",
      "refs/tags/v0.2.29",
      "refs/heads/release/v0.2.29",
    ),
  ).toBe("");
  expect(writes(value)).toEqual([]);
});

test("independently reconstructs a version-only commit and atomically pushes only its branch and tag", () => {
  const value = fixture({ remoteVersion: false });
  success(value.run(script, "version", value.candidate));
  const sha = value.git("rev-parse", "HEAD");
  expect(value.git("show", "-s", "--format=%P", sha)).toBe(value.sourceSha);
  expect(value.git("ls-remote", "--refs", "origin", "refs/heads/main")).toBe(
    `${value.sourceSha}\trefs/heads/main`,
  );
  expect(
    value
      .git(
        "ls-remote",
        "--refs",
        "origin",
        "refs/tags/v0.2.29",
        "refs/heads/release/v0.2.29",
      )
      .split("\n"),
  ).toEqual([
    `${sha}\trefs/heads/release/v0.2.29`,
    `${sha}\trefs/tags/v0.2.29`,
  ]);
  value.git("switch", "--detach", value.sourceSha);
  value.change({ hasRemoteTag: true, tagSha: sha });
  success(value.run(script, "version", value.candidate));
  expect(value.git("rev-parse", "HEAD")).toBe(value.sourceSha);
  expect(value.git("rev-parse", "refs/tags/v0.2.29")).toBe(sha);
});

test("preflight requires an unused next version and exact public source CI", () => {
  const value = fixture({ remoteVersion: false });
  success(value.run(script, "preflight"));
  value.change({ ciConclusion: "failure" });
  expect(value.run(script, "preflight").stderr).toContain(
    "release_exact_ci_required",
  );
  value.change({ ciConclusion: "success", hasRemoteTag: true });
  expect(value.run(script, "preflight").stderr).toContain(
    "release_version_already_reserved",
  );
  expect(writes(value)).toEqual([]);
});

test("freezes default main without a manually copied source SHA", () => {
  const value = fixture({ remoteVersion: false });
  delete value.env.REQUESTED_SOURCE_SHA;
  delete value.env.RELEASE_SOURCE_SHA;
  delete value.env.REQUESTED_SOURCE_REF;
  const result = value.run(script, "preflight");
  success(result);
  expect(JSON.parse(result.stdout)).toMatchObject({
    sourceSha: value.sourceSha, workflowSha: value.sourceSha, sourceRef: "main",
  });
  expect(value.calls().some((args) => args[1]?.includes("/commits/"))).toBe(false);
  expect(writes(value)).toEqual([]);
});

test.each(["release-candidate", "refs/tags/reviewed-candidate", "sha"])(
  "freezes %s once while privileged versioning uses the selected parent",
  (input) => {
    const value = fixture({ remoteVersion: false });
    value.git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "new workflow main");
    const workflowSha = value.git("rev-parse", "HEAD");
    const sourceRef = input === "sha" ? value.sourceSha : input;
    value.env.GITHUB_SHA = workflowSha;
    value.env.REQUESTED_SOURCE_REF = sourceRef;
    delete value.env.REQUESTED_SOURCE_SHA;
    delete value.env.RELEASE_SOURCE_SHA;
    value.change({ workflowSha, refs: { [sourceRef]: value.sourceSha } });
    const result = value.run(script, "preflight", path.join(value.root, "selection.json"));
    success(result);
    expect(JSON.parse(result.stdout)).toMatchObject({ sourceSha: value.sourceSha, workflowSha, sourceRef });
    const selection = JSON.parse(fs.readFileSync(path.join(value.root, "selection.json")));
    expect(selection).toMatchObject({ sourceSha: value.sourceSha, workflowSha, sourceRef, tag: "v0.2.29" });
    value.change({ refs: { [sourceRef]: workflowSha } });
    value.git("switch", "--detach", value.sourceSha);
    value.env.RELEASE_SOURCE_SHA = value.sourceSha;
    success(value.run(script, "version", value.candidate));
    expect(value.git("show", "-s", "--format=%P", "HEAD")).toBe(value.sourceSha);
    expect(value.calls().filter((args) => args[1]?.includes("/commits/"))).toHaveLength(1);
  },
);

test("rejects non-admin dispatch and rerun actors before source resolution or writes", () => {
  const value = fixture({ remoteVersion: false });
  value.change({ permissions: { "release-admin": "write" } });
  expect(value.run(script, "preflight").stderr).toContain("release_admin_required");
  value.env.GITHUB_TRIGGERING_ACTOR = "reader";
  value.change({ permissions: { reader: "read" } });
  expect(value.run(script, "preflight").stderr).toContain("release_admin_required");
  expect(value.calls().some((args) => args[1]?.includes("/commits/"))).toBe(false);
  expect(writes(value)).toEqual([]);
});

test("binds publication to the workflow SHA and its frozen selection artifact, not mutable main", () => {
  const value = fixture();
  const workflowSha = "b".repeat(40);
  value.env.GITHUB_SHA = workflowSha;
  value.change({ workflowSha });
  success(stage(value));
  success(value.run(script, "verify", "v0.2.29"));
  value.change({ selection: {
    schemaVersion: 1, runId: "239", sourceRef: "main", workflowSha,
    sourceSha: "c".repeat(40), tag: "v0.2.29", verification: "full",
  } });
  const before = writes(value).length;
  expect(value.run(script, "publish", "v0.2.29").stderr).toContain("release_selection_mismatch");
  expect(writes(value)).toHaveLength(before);
});

test.each(["refs/pull/1/head", "https://github.com/other/fork", "main~1", "--help", "main\nforged=value"])(
  "refuses non-source input %j before resolving it",
  (ref) => {
    const value = fixture({ remoteVersion: false });
    value.env.REQUESTED_SOURCE_REF = ref;
    expect(value.run(script, "preflight").status).toBe(1);
    expect(value.calls().some((args) => args[1]?.includes("/commits/"))).toBe(false);
    expect(writes(value)).toEqual([]);
  },
);

test("does not reselect a moving branch when rerunning the source job", () => {
  const value = fixture({ remoteVersion: false });
  value.env.GITHUB_RUN_ATTEMPT = "2";
  value.env.REQUESTED_SOURCE_REF = "candidate";
  expect(value.run(script, "preflight").stderr).toContain("release_selection_rerun_forbidden");
  expect(value.calls().some((args) => args[1]?.includes("/commits/"))).toBe(false);
  expect(writes(value)).toEqual([]);
});

test("checks both the protected workflow CI and selected source CI", () => {
  const value = fixture({ remoteVersion: false });
  value.git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "workflow main");
  const workflowSha = value.git("rev-parse", "HEAD");
  value.env.GITHUB_SHA = workflowSha;
  value.env.REQUESTED_SOURCE_REF = "candidate";
  value.change({ refs: { candidate: value.sourceSha }, ciConclusions: { [workflowSha]: "failure" } });
  expect(value.run(script, "preflight").stderr).toContain(`release_exact_ci_required: ${workflowSha}`);
  value.change({ ciConclusions: { [value.sourceSha]: "failure" } });
  expect(value.run(script, "preflight").stderr).toContain(`release_exact_ci_required: ${value.sourceSha}`);
  expect(writes(value)).toEqual([]);
});

test("refuses a successful build run from a different protected workflow commit", () => {
  const value = fixture();
  success(stage(value));
  value.change({ workflowSha: "d".repeat(40) });
  const before = writes(value).length;
  expect(value.run(script, "publish", "v0.2.29").stderr).toContain("release_workflow_source_mismatch");
  expect(writes(value)).toHaveLength(before);
});

test.each(["version", "stage"])("refuses a non-admin rerun of privileged %s", (command) => {
  const value = fixture({ remoteVersion: command === "stage" });
  value.env.GITHUB_TRIGGERING_ACTOR = "reader";
  value.change({ permissions: { reader: "read" } });
  const result = command === "stage" ? stage(value) : value.run(script, "version", value.candidate);
  expect(result.stderr).toContain("release_admin_required");
  expect(value.git("rev-parse", "HEAD")).toBe(command === "stage" ? value.tagSha : value.sourceSha);
  expect(writes(value)).toEqual([]);
});
