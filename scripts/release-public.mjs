#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BETA_METADATA_PATH,
  BETA_UPDATER_URL,
  planBetaMetadataUpdate,
} from "./lib/beta-release-metadata.mjs";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";
import { RELEASE_CANDIDATE_FILES } from "./lib/release-candidate.mjs";
import {
  findExactSuccessfulCiRun,
  normalizeFullCommitSha,
} from "./lib/release-gate.mjs";
import {
  COMPATIBILITY_REPOSITORY,
  RELEASE_REPOSITORY,
  expectedVersionFiles,
  inspectReleaseFiles,
  missingReleaseAssets,
  releaseAdmission,
  releaseVersion,
} from "./lib/public-release-contract.mjs";
import {
  VERSION_FILES,
  readUnifiedVersion,
  readVersionText,
} from "./lib/release-version.mjs";

const [command, ...args] = process.argv.slice(2);
const environment = withoutLocalGitOverrides();
const run = (bin, argv, options = {}) =>
  execFileSync(bin, argv, {
    env: environment,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
const git = (...argv) => run("git", argv).trim();
const gh = (...argv) => run("gh", argv);
function api(route, { absent = false, input, compatibility = false } = {}) {
  try {
    const env =
      compatibility && process.env.DURE_BETA_FEED_TOKEN
        ? { ...environment, GH_TOKEN: process.env.DURE_BETA_FEED_TOKEN }
        : environment;
    const argv = [
      "api",
      route,
      ...(input ? ["--method", "PUT", "--input", "-"] : []),
    ];
    return JSON.parse(
      run("gh", argv, {
        env,
        input: input ? JSON.stringify(input) : undefined,
        stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    let response;
    try {
      response = JSON.parse(error.stdout?.toString() ?? "null");
    } catch {
      /* Preserve non-JSON transport errors. */
    }
    if (absent && String(response?.status) === "404") return null;
    throw error;
  }
}
const release = (tag) =>
  api(`repos/${RELEASE_REPOSITORY}/releases/tags/${tag}`, { absent: true });
const output = (values) => {
  console.log(JSON.stringify(values));
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
};

function admission(source, current) {
  return releaseAdmission({
    repository: process.env.GITHUB_REPOSITORY,
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    head: process.env.GITHUB_SHA,
    source,
    current,
    bumpKind: process.env.RELEASE_BUMP,
    verification: process.env.RELEASE_VERIFICATION,
  });
}

function sourceRef() {
  const ref = process.env.REQUESTED_SOURCE_REF || "main";
  assert(!/[\s\x00-\x1f\x7f]/.test(ref), "release_source_ref_invalid");
  assert(
    !ref.startsWith("refs/") || /^refs\/(heads|tags)\//.test(ref),
    "release_source_ref_invalid",
  );
  assert(!ref.includes("@{"), "release_source_ref_invalid");
  // Git owns ref syntax; never interpret shell expressions, revision ranges or PR refs.
  git("check-ref-format", "--branch", ref);
  return ref;
}

function requireReleaseAdmin() {
  const actors = new Set([
    process.env.GITHUB_ACTOR,
    process.env.GITHUB_TRIGGERING_ACTOR,
  ]);
  for (const actor of actors) {
    assert(actor && /^[a-z\d-]+$/i.test(actor), "release_admin_required");
    assert.equal(
      api(`repos/${RELEASE_REPOSITORY}/collaborators/${actor}/permission`).permission,
      "admin",
      "release_admin_required",
    );
  }
}

function selectionRecord(selected, tag, runId) {
  return {
    schemaVersion: 1,
    runId,
    sourceRef: selected.sourceRef,
    workflowSha: selected.workflowSha,
    sourceSha: selected.sourceSha,
    tag,
    verification: selected.verification,
  };
}

function exactCi(sha) {
  const runs = JSON.parse(
    gh(
      "run",
      "list",
      "--repo",
      RELEASE_REPOSITORY,
      "--commit",
      sha,
      "--workflow",
      "public-repository.yml",
      "--limit",
      "30",
      "--json",
      "headSha,status,conclusion,databaseId",
    ),
  );
  if (!findExactSuccessfulCiRun(sha, runs))
    throw new Error(`release_exact_ci_required: ${sha}`);
}

function checkVersionCommit(tagSha, sourceSha, tag) {
  const version = releaseVersion(tag);
  assert.equal(
    git("show", "-s", "--format=%P", tagSha),
    sourceSha,
    "release_single_parent_required",
  );
  const current = JSON.parse(
    run("git", ["show", `${sourceSha}:package.json`]),
  ).version;
  const expected = expectedVersionFiles(
    (file) => run("git", ["show", `${sourceSha}:${file}`]),
    current,
    version,
  );
  const changed = git("diff", "--name-only", sourceSha, tagSha)
    .split("\n")
    .sort();
  assert.deepEqual(
    changed,
    [...RELEASE_CANDIDATE_FILES].sort(),
    "release_version_only_required",
  );
  for (const [file, bytes] of expected) {
    assert.equal(
      run("git", ["show", `${tagSha}:${file}`]),
      bytes,
      `release_version_bytes_mismatch: ${file}`,
    );
    for (const sha of [sourceSha, tagSha])
      assert(
        git("ls-tree", sha, "--", file).startsWith("100644 blob "),
        "release_version_mode_changed",
      );
  }
}

function preflight() {
  assert(args.length <= 1, "preflight accepts an optional selection receipt path");
  assert.equal(process.env.GITHUB_REPOSITORY, RELEASE_REPOSITORY);
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  const workflowSha = normalizeFullCommitSha(process.env.GITHUB_SHA);
  assert.equal(
    git("rev-parse", "HEAD"), workflowSha, "release_checkout_mismatch",
  );
  requireReleaseAdmin();
  // A successful source job is never reselected. Resume failed downstream jobs instead.
  assert.equal(
    process.env.GITHUB_RUN_ATTEMPT || "1", "1",
    "release_selection_rerun_forbidden: rerun failed jobs or start a new unused version",
  );
  const ref = sourceRef();
  const sourceSha = ["main", "refs/heads/main"].includes(ref)
    ? workflowSha
    : normalizeFullCommitSha(
        api(`repos/${RELEASE_REPOSITORY}/commits/${encodeURIComponent(ref)}`).sha,
      );
  git(
    "fetch", "--no-tags", `https://github.com/${RELEASE_REPOSITORY}.git`, sourceSha,
  );
  const versions = VERSION_FILES.map((file) =>
    readVersionText(file, run("git", ["show", `${sourceSha}:${file.path}`])),
  );
  assert.equal(new Set(versions).size, 1, "release_source_inventory_mismatch");
  const selected = { ...admission(sourceSha, versions[0]), sourceRef: ref };
  assert.equal(
    git("status", "--porcelain", "--untracked-files=all"),
    "",
    "release_clean_source_required",
  );
  for (const sha of new Set([sourceSha, workflowSha])) exactCi(sha);
  for (const repository of [RELEASE_REPOSITORY, COMPATIBILITY_REPOSITORY]) {
    for (const route of [
      `git/ref/tags/${selected.tag}`,
      `releases/tags/${selected.tag}`,
    ]) {
      if (api(`repos/${repository}/${route}`, { absent: true }))
        throw new Error(
          `release_version_already_reserved: ${repository}/${selected.tag}`,
        );
    }
  }
  if (
    api(`repos/${RELEASE_REPOSITORY}/git/ref/heads/release/${selected.tag}`, {
      absent: true,
    })
  )
    throw new Error("release_branch_already_reserved");
  if (args[0])
    fs.writeFileSync(
      path.resolve(args[0]),
      JSON.stringify(selectionRecord(selected, selected.tag, process.env.GITHUB_RUN_ID)),
      { flag: "wx" },
    );
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Source ref: ${ref}\n\nFrozen source: ${sourceSha}\n\nProtected workflow: ${workflowSha}\n\nVersion: ${selected.tag}; verification: ${selected.verification}\n`,
    );
  output(selected);
}

function version() {
  assert.equal(args.length, 1, "version requires the candidate directory");
  requireReleaseAdmin();
  const selected = admission(process.env.RELEASE_SOURCE_SHA, readUnifiedVersion());
  assert.equal(
    git("rev-parse", "HEAD"), selected.sourceSha, "release_checkout_mismatch",
  );
  const directory = path.resolve(args[0]);
  assert.deepEqual(fs.readdirSync(directory).sort(), [
    "candidate.json",
    "version.patch",
  ]);
  const candidate = JSON.parse(
    fs.readFileSync(path.join(directory, "candidate.json")),
  );
  const patch = fs.readFileSync(path.join(directory, "version.patch"));
  assert.deepEqual(candidate, {
    schemaVersion: 1,
    baseSha: selected.sourceSha,
    bump: process.env.RELEASE_BUMP,
    currentVersion: selected.current,
    version: selected.version,
    tag: selected.tag,
    files: RELEASE_CANDIDATE_FILES,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
  });
  const existing = api(
    `repos/${RELEASE_REPOSITORY}/git/ref/tags/${selected.tag}`,
    { absent: true },
  );
  if (existing) {
    assert.equal(
      existing.object.type,
      "commit",
      "release_lightweight_tag_required",
    );
    const sha = normalizeFullCommitSha(existing.object.sha);
    git("fetch", "--no-tags", "origin", sha);
    checkVersionCommit(sha, selected.sourceSha, selected.tag);
    assert.equal(
      api(`repos/${RELEASE_REPOSITORY}/git/ref/heads/release/${selected.tag}`)
        .object.sha,
      sha,
    );
    output({
      tag: selected.tag,
      release_sha: sha,
      source_sha: selected.sourceSha,
    });
    return;
  }
  assert.equal(
    git("status", "--porcelain", "--untracked-files=all"),
    "",
    "release_clean_source_required",
  );
  git("apply", "--check", path.join(directory, "version.patch"));
  git("apply", path.join(directory, "version.patch"));
  const expected = expectedVersionFiles(
    (file) => run("git", ["show", `${selected.sourceSha}:${file}`]),
    selected.current,
    selected.version,
  );
  const changed = git("status", "--porcelain=v1", "--untracked-files=all")
    .split("\n")
    .map((line) => line.trimStart());
  assert.deepEqual(
    changed.sort(),
    RELEASE_CANDIDATE_FILES.map((file) => `M ${file}`).sort(),
  );
  for (const [file, bytes] of expected) {
    assert.equal(
      fs.readFileSync(file, "utf8"),
      bytes,
      `release_candidate_bytes_mismatch: ${file}`,
    );
    assert(
      fs.lstatSync(file).isFile(),
      "release_regular_version_file_required",
    );
  }
  git("diff", "--check");
  git("add", "--", ...RELEASE_CANDIDATE_FILES);
  git(
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "user.name=Dure release",
    "-c",
    "user.email=release@dureai.dev",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    `release: ${selected.tag}`,
  );
  const sha = git("rev-parse", "HEAD");
  checkVersionCommit(sha, selected.sourceSha, selected.tag);
  git("tag", selected.tag, sha);
  if (!process.env.GH_TOKEN) throw new Error("release_write_token_required");
  const auth = Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString(
    "base64",
  );
  const pushEnvironment = {
    ...environment,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
  };
  const target = `https://github.com/${RELEASE_REPOSITORY}.git`;
  const branch = `refs/heads/release/${selected.tag}`;
  const tagRef = `refs/tags/${selected.tag}`;
  assert.equal(
    git("ls-remote", "--refs", target, branch, tagRef),
    "",
    "release_refs_already_reserved",
  );
  const pushed = spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "--atomic",
      target,
      `HEAD:${branch}`,
      `${tagRef}:${tagRef}`,
    ],
    {
      env: pushEnvironment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const observed = git("ls-remote", "--refs", target, branch, tagRef)
    .split("\n")
    .map((line) => line.split(/\s+/));
  assert.equal(observed.length, 2, "release_atomic_push_unconfirmed");
  for (const ref of [branch, tagRef])
    assert.equal(
      observed.find((row) => row[1] === ref)?.[0],
      sha,
      "release_atomic_push_unconfirmed",
    );
  if (pushed.status !== 0)
    console.warn(
      "Release push response failed; exact remote refs confirm the atomic publication.",
    );
  output({
    tag: selected.tag,
    release_sha: sha,
    source_sha: selected.sourceSha,
  });
}

function provenance(released) {
  const match = released.body?.match(/<!-- dure-release-v2 (\{[^\n]+\}) -->/);
  if (!match) throw new Error("release_provenance_missing");
  const value = JSON.parse(match[1]);
  assert.deepEqual(Object.keys(value).sort(), [
    "runId",
    "sourceRef",
    "sourceSha",
    "tagSha",
    "verification",
    "workflowSha",
  ]);
  normalizeFullCommitSha(value.sourceSha);
  normalizeFullCommitSha(value.tagSha);
  normalizeFullCommitSha(value.workflowSha);
  assert(
    typeof value.sourceRef === "string" && value.sourceRef.length > 0 &&
    !/[\r\n]/.test(value.sourceRef),
  );
  assert(/^[1-9]\d*$/.test(value.runId));
  assert(["full", "emergency-0.2"].includes(value.verification));
  if (value.verification === "emergency-0.2")
    assert(/^v0\.2\.\d+$/.test(released.tag_name));
  return value;
}

function checkDraftIdentity(released, tag, proof) {
  assert.equal(released.tag_name, tag);
  assert.equal(released.prerelease, true);
  assert.deepEqual(provenance(released), proof, "release_provenance_mismatch");
}

function stage() {
  assert.equal(
    args.length,
    4,
    "stage requires TAG ASSET_DIRECTORY SOURCE_SHA VERIFICATION",
  );
  const [tag, directory, rawSource, verification] = args;
  requireReleaseAdmin();
  const sourceSha = normalizeFullCommitSha(rawSource);
  const tagSha = git("rev-parse", "HEAD");
  const proof = {
    runId: process.env.GITHUB_RUN_ID,
    sourceRef: sourceRef(),
    workflowSha: normalizeFullCommitSha(process.env.GITHUB_SHA),
    sourceSha,
    tagSha,
    verification,
  };
  assert.equal(process.env.GITHUB_REPOSITORY, RELEASE_REPOSITORY);
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(process.env.RELEASE_SOURCE_SHA, sourceSha);
  assert.equal(
    api(`repos/${RELEASE_REPOSITORY}/git/ref/tags/${tag}`).object.sha,
    tagSha,
  );
  checkVersionCommit(tagSha, sourceSha, tag);
  const publicKey = JSON.parse(
    run("git", ["show", `${tagSha}:src-tauri/tauri.conf.json`]),
  ).plugins.updater.pubkey;
  const { assets } = inspectReleaseFiles(directory, tag, publicKey);
  const notice =
    verification === "full"
      ? "Full release regression completed."
      : "Full regression is DEFERRED for this emergency 0.2.x beta; no full-suite success is claimed. Focused and packaged checks do not certify every provider, platform or previously reported incident.";
  const notes = `Dure ${tag} Public Beta for macOS Apple Silicon.\n\nBasic interface. Developer ID signed; the app is notarized and stapled. Installation and restart require your explicit action.\n\n${notice}\n\nCorresponding source: https://github.com/${RELEASE_REPOSITORY}/tree/${tagSha}\nBuild: https://github.com/${RELEASE_REPOSITORY}/actions/runs/${proof.runId}\nProtected workflow: https://github.com/${RELEASE_REPOSITORY}/tree/${proof.workflowSha}\n\n<!-- dure-release-v2 ${JSON.stringify(proof)} -->`;
  provenance({ body: notes, tag_name: tag });
  let current = release(tag);
  if (!current) {
    try {
      gh(
        "release",
        "create",
        tag,
        "--repo",
        RELEASE_REPOSITORY,
        "--verify-tag",
        "--draft",
        "--prerelease",
        "--latest=false",
        "--title",
        `Dure ${tag} Public Beta`,
        "--notes",
        notes,
      );
    } catch (error) {
      if (!release(tag)) throw error;
    }
    current = release(tag);
  }
  checkDraftIdentity(current, tag, proof);
  assert.equal(
    current.draft,
    true,
    "release_already_public: never stage again",
  );
  const before = current.assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    digest: asset.digest,
    size: asset.size,
  }));
  for (const asset of missingReleaseAssets(assets, current.assets)) {
    try {
      gh(
        "release",
        "upload",
        tag,
        "--repo",
        RELEASE_REPOSITORY,
        path.join(directory, asset.name),
      );
    } catch (error) {
      current = release(tag);
      if (
        missingReleaseAssets(assets, current.assets).some(
          (missing) => missing.name === asset.name,
        )
      )
        throw error;
    }
  }
  current = release(tag);
  checkDraftIdentity(current, tag, proof);
  assert.equal(current.draft, true);
  missingReleaseAssets(assets, current.assets, { complete: true });
  for (const asset of before)
    assert.deepEqual(
      current.assets
        .filter((item) => item.id === asset.id)
        .map((item) => ({
          id: item.id,
          name: item.name,
          digest: item.digest,
          size: item.size,
        })),
      [asset],
    );
  output({ tag, release_id: current.id, draft: true });
}

function anonymous(url, file) {
  return run(
    "curl",
    [
      "--disable",
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      ...(file ? ["--output", file] : []),
      url,
    ],
    { encoding: file ? "utf8" : null },
  );
}

function updateMetadata(tag, files) {
  const route = `repos/${COMPATIBILITY_REPOSITORY}/contents/${BETA_METADATA_PATH}`;
  const read = () =>
    api(`${route}?ref=main`, { absent: true, compatibility: true });
  const plan = (previous) =>
    planBetaMetadataUpdate({
      tag,
      bytes: files.bytes,
      signature: files.signature,
      previous,
    });
  const update = plan(read());
  if (update) {
    try {
      api(route, { input: update, compatibility: true });
    } catch (error) {
      if (plan(read()) !== null) throw error;
    }
  }
  if (plan(read()) !== null) throw new Error("beta_metadata_readback_mismatch");
  if (!anonymous(BETA_UPDATER_URL).equals(files.bytes))
    throw new Error(
      "beta_metadata_anonymous_readback_mismatch: resume metadata-only; do not recreate assets",
    );
}

function promote() {
  assert.equal(args.length, 1, `${command} requires TAG`);
  const [tag] = args;
  releaseVersion(tag);
  let current = release(tag);
  assert(current, "release_draft_missing");
  const proof = provenance(current);
  checkDraftIdentity(current, tag, proof);
  if (command === "metadata-only")
    assert.equal(current.draft, false, "metadata_only_requires_public_release");
  if (command === "publish")
    assert.equal(
      current.draft,
      true,
      "release_already_public: use metadata-only",
    );
  const buildRun = api(
    `repos/${RELEASE_REPOSITORY}/actions/runs/${proof.runId}`,
  );
  assert.equal(buildRun.repository.full_name, RELEASE_REPOSITORY);
  assert.equal(buildRun.path, ".github/workflows/release.yml");
  assert.equal(buildRun.event, "workflow_dispatch");
  assert.equal(buildRun.head_branch, "main", "release_main_source_required");
  assert.equal(buildRun.head_sha, proof.workflowSha, "release_workflow_source_mismatch");
  assert.equal(buildRun.status, "completed");
  assert.equal(buildRun.conclusion, "success", "release_run_not_successful");
  const jobs = api(
    `repos/${RELEASE_REPOSITORY}/actions/runs/${proof.runId}/jobs?filter=latest&per_page=100`,
  );
  assert(
    jobs.total_count <= 100 && jobs.jobs.length === jobs.total_count,
    "release_job_observation_incomplete",
  );
  for (const name of ["source", "candidate", "version", "build", "draft"]) {
    const matches = jobs.jobs.filter((job) => job.name === name);
    assert.equal(matches.length, 1, `release_job_missing: ${name}`);
    assert.equal(
      matches[0].conclusion,
      "success",
      `release_job_not_successful: ${name}`,
    );
  }
  const verificationJobs = jobs.jobs.filter(
    (job) => job.name === "verification",
  );
  assert.equal(verificationJobs.length, 1);
  assert.equal(
    verificationJobs[0].conclusion,
    proof.verification === "full" ? "success" : "skipped",
    "release_verification_claim_mismatch",
  );
  assert.equal(
    api(`repos/${RELEASE_REPOSITORY}/git/ref/tags/${tag}`).object.sha,
    proof.tagSha,
  );
  git(
    "fetch",
    "--no-tags",
    `https://github.com/${RELEASE_REPOSITORY}.git`,
    proof.tagSha,
    proof.sourceSha,
  );
  checkVersionCommit(proof.tagSha, proof.sourceSha, tag);
  for (const sha of new Set([proof.sourceSha, proof.workflowSha, proof.tagSha]))
    exactCi(sha);
  const publicKey = JSON.parse(
    run("git", ["show", `${proof.tagSha}:src-tauri/tauri.conf.json`]),
  ).plugins.updater.pubkey;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dure-public-release-"));
  // Retained on failure for reconciliation; no updater or user app is invoked.
  console.log(`Release evidence: ${work}`);
  const selection = path.join(work, "selection");
  fs.mkdirSync(selection);
  gh(
    "run", "download", proof.runId, "--repo", RELEASE_REPOSITORY,
    "--name", "release-selection", "--dir", selection,
  );
  assert.deepEqual(
    fs.readdirSync(selection), ["selection.json"], "release_selection_mismatch",
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(selection, "selection.json"))),
    selectionRecord(proof, tag, proof.runId),
    "release_selection_mismatch",
  );
  const original = path.join(work, "original"),
    downloaded = path.join(work, "downloaded");
  fs.mkdirSync(original);
  fs.mkdirSync(downloaded);
  gh(
    "run",
    "download",
    proof.runId,
    "--repo",
    RELEASE_REPOSITORY,
    "--name",
    `release-assets-${tag}`,
    "--dir",
    original,
  );
  const expected = inspectReleaseFiles(original, tag, publicKey);
  missingReleaseAssets(expected.assets, current.assets, { complete: true });
  gh(
    "release",
    "download",
    tag,
    "--repo",
    RELEASE_REPOSITORY,
    "--dir",
    downloaded,
  );
  const files = inspectReleaseFiles(downloaded, tag, publicKey);
  assert.deepEqual(
    files.assets,
    expected.assets,
    "release_build_asset_mismatch",
  );
  if (command === "publish") {
    try {
      gh(
        "release",
        "edit",
        tag,
        "--repo",
        RELEASE_REPOSITORY,
        "--draft=false",
        "--prerelease",
        "--latest=false",
      );
    } catch (error) {
      if (release(tag)?.draft !== false) throw error;
    }
    current = release(tag);
    assert.equal(current?.draft, false, "release_publication_unconfirmed");
  }
  if (current.draft === false) {
    checkDraftIdentity(current, tag, proof);
    missingReleaseAssets(expected.assets, current.assets, { complete: true });
    const publicDirectory = path.join(work, "anonymous");
    fs.mkdirSync(publicDirectory);
    for (const asset of expected.assets)
      anonymous(
        `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/${asset.name}`,
        path.join(publicDirectory, asset.name),
      );
    assert.deepEqual(
      inspectReleaseFiles(publicDirectory, tag, publicKey).assets,
      expected.assets,
    );
    if (command !== "verify") updateMetadata(tag, files);
  }
  const receipt = {
    tag,
    proof,
    releaseId: current.id,
    draft: current.draft,
    assets: files.assets,
    command,
    metadataUpdated: command !== "verify" && current.draft === false,
    nativeAcceptance:
      "Operator prerequisite; not inferred from these integrity checks",
  };
  fs.writeFileSync(
    path.join(work, "receipt.json"),
    JSON.stringify(receipt, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  console.log(JSON.stringify(receipt));
}

try {
  if (command === "preflight") preflight();
  else if (command === "version") version();
  else if (command === "stage") stage();
  else if (["verify", "publish", "metadata-only"].includes(command)) promote();
  else
    throw new Error(
      "usage: release-public.mjs preflight | version CANDIDATE_DIRECTORY | stage TAG ASSETS SOURCE VERIFICATION | verify|publish|metadata-only TAG",
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
