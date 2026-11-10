import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BackendTransportError } from "../cli/lib/backend-transport.mjs";
import {
  CLAIM_OVERLAP_EXIT_CODE,
  formatClaimList,
  inspectRepository,
  normalizeClaimPaths,
  parseClaimCommand,
  runClaimCommand,
} from "../cli/lib/claim-command.mjs";

function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=Dure Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

let root;
let main;
let worktree;
let repository;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "dure-claim-")));
  main = join(root, "repo");
  worktree = join(root, "repo-engine");
  mkdirSync(join(main, "Sources", "Engine"), { recursive: true });
  git(main, "init", "--quiet", "--initial-branch=main");
  git(main, "commit", "--quiet", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "--quiet", "-b", "agent/engine-2", worktree);
  mkdirSync(join(worktree, "Sources", "Engine"), { recursive: true });
  repository = join(main, ".git");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const record = (claim, updatedAtMs = 1_000) => ({
  schemaVersion: 1,
  claim: { repository, paths: [], ...claim },
  claimedAtMs: updatedAtMs,
  updatedAtMs,
});

function harness(result, { environment = {}, cwd = worktree, now = 61_000 } = {}) {
  const requestBackend = vi.fn(async () => ({ result }));
  const resolveBackend = vi.fn(async () => ({
    profile: { id: "local" },
    transportOptions: { deadlineMs: 2_500 },
  }));
  const output = vi.fn();
  const errorOutput = vi.fn();
  return {
    requestBackend,
    resolveBackend,
    output,
    errorOutput,
    run: (command, args) =>
      runClaimCommand(command, args, {
        resolveBackend,
        requestBackend,
        environment,
        cwd,
        now: () => now,
        output,
        errorOutput,
      }),
    text: () => output.mock.calls.map(([line]) => line).join("\n"),
    body: () => requestBackend.mock.calls[0][1],
  };
}

describe("dure claim parsing", () => {
  it("collects a holder and several patterns until the next option", () => {
    expect(
      parseClaimCommand("claim", [
        "engine-2",
        "--paths",
        "Sources/Engine/**",
        "Docs/engine.md",
        "--issue",
        "#2",
        "--check",
      ]),
    ).toMatchObject({
      action: "check",
      holder: "engine-2",
      issue: "#2",
      paths: ["Sources/Engine/**", "Docs/engine.md"],
    });
    expect(parseClaimCommand("claim", ["--release"])).toMatchObject({
      action: "release",
      holder: undefined,
    });
    expect(parseClaimCommand("claims", ["--all", "--json"])).toMatchObject({
      action: "list",
      all: true,
      json: true,
    });
    expect(parseClaimCommand("claims", ["--help"])).toEqual({ action: "help" });
  });

  it.each([
    ["claim", ["--paths"]],
    ["claim", ["--issue"]],
    ["claim", ["--issue", "1", "--issue", "2"]],
    ["claim", ["a", "b", "--issue", "1"]],
    ["claim", ["--release", "--paths", "src"]],
    ["claim", ["--all"]],
    ["claim", ["--frobnicate"]],
    ["claims", ["--paths", "src"]],
    ["claims", ["engine-2"]],
    ["claims", ["--all", "--repo", "."]],
  ])("refuses %s %j", (command, args) => {
    expect(() => parseClaimCommand(command, args)).toThrow(/dure claim/u);
  });
});

describe("repository identity and patterns", () => {
  it("gives every worktree of one repository the same identity", () => {
    const fromMain = inspectRepository(main);
    const fromWorktree = inspectRepository(join(worktree, "Sources"));
    expect(fromMain).toMatchObject({ repository, root: main, prefix: "", branch: "main" });
    expect(fromWorktree).toMatchObject({
      repository,
      root: worktree,
      prefix: "Sources/",
      branch: "agent/engine-2",
    });
    expect(inspectRepository(root)).toBeNull();
  });

  it("makes patterns relative to the repository root", () => {
    const checkout = { root: worktree, prefix: "Sources/" };
    expect(
      normalizeClaimPaths(
        ["Engine/**", "./Engine/**", "Engine/", "../Docs/*.md", join(worktree, "README.md"), ".."],
        checkout,
        "darwin",
      ),
    ).toEqual(["Sources/Engine/**", "Sources/Engine", "Docs/*.md", "README.md", "**"]);
    expect(normalizeClaimPaths(["Engine\\Core"], checkout, "win32")).toEqual([
      "Sources/Engine/Core",
    ]);
    expect(() => normalizeClaimPaths(["../../outside"], checkout, "darwin")).toThrow(
      /outside the repository/u,
    );
    expect(() => normalizeClaimPaths([join(root, "elsewhere")], checkout, "darwin")).toThrow(
      /outside the checkout/u,
    );
  });
});

describe("dure claim", () => {
  it("claims for the current session with its branch and worktree and reports overlaps", async () => {
    const held = record({
      holder: "engine-1",
      issue: "2",
      branch: "agent/engine-1",
      paths: ["Sources/Engine/Core"],
    });
    const run = harness(
      {
        schemaVersion: 1,
        claim: record({ holder: "session-a" }),
        recorded: true,
        overlaps: [
          {
            held,
            reasons: ["issue", "paths"],
            paths: [{ mine: "Sources/Engine/**", theirs: "Sources/Engine/Core" }],
          },
        ],
      },
      {
        environment: { HMUX_SESSION_ID: "session-a", HMUX_WORKSPACE_ID: "workspace-a" },
        cwd: join(worktree, "Sources"),
      },
    );
    expect(
      await run.run("claim", ["--issue", "#2", "--paths", "Engine/**", "--note", "parser"]),
    ).toBe(CLAIM_OVERLAP_EXIT_CODE);
    expect(run.resolveBackend).toHaveBeenCalledWith({ backend: undefined, backendSpecified: false });
    expect(run.requestBackend).toHaveBeenCalledExactlyOnceWith(
      { id: "local" },
      {
        operation: "work_claim.put",
        requiredCapabilities: ["work_claim.v1"],
        body: {
          schemaVersion: 1,
          dryRun: false,
          claim: {
            repository,
            holder: "session-a",
            sessionId: "session-a",
            workspaceId: "workspace-a",
            issue: "2",
            branch: "agent/engine-2",
            worktree,
            paths: ["Sources/Engine/**"],
            note: "parser",
          },
        },
      },
      { deadlineMs: 2_500 },
    );
    expect(run.text()).toContain(`Claimed for session-a in ${main}.`);
    expect(run.text()).toContain(
      "engine-1 (#2, branch agent/engine-1): same issue; paths Sources/Engine/** ~ Sources/Engine/Core",
    );
  });

  it("claims for a named holder with only what was given, and checks without recording", async () => {
    const run = harness(
      { schemaVersion: 1, claim: record({ holder: "engine-2" }), recorded: false, overlaps: [] },
      { environment: { HMUX_SESSION_ID: "session-a" }, cwd: main },
    );
    expect(await run.run("claim", ["engine-2", "--paths", "Sources/Engine/**", "--check"])).toBe(0);
    expect(run.body().body).toEqual({
      schemaVersion: 1,
      dryRun: true,
      claim: { repository, holder: "engine-2", paths: ["Sources/Engine/**"] },
    });
    expect(run.text()).toContain("Checked (not recorded) for engine-2");
    expect(run.text()).toContain("No overlap with other claims.");
  });

  it("refuses before contacting the backend when nothing identifies the claim", async () => {
    const outside = harness(null, { cwd: root, environment: { HMUX_SESSION_ID: "session-a" } });
    expect(await outside.run("claim", ["--issue", "2"])).toBe(2);
    expect(outside.errorOutput.mock.calls[0][0]).toMatch(/not inside a Git repository/u);

    const anonymous = harness(null, { cwd: main });
    expect(await anonymous.run("claim", ["--issue", "2"])).toBe(2);
    expect(anonymous.errorOutput.mock.calls[0][0]).toMatch(/Name the holder/u);

    const empty = harness(null, { cwd: main });
    expect(await empty.run("claim", ["engine-2"])).toBe(2);
    expect(empty.errorOutput.mock.calls[0][0]).toMatch(/Say what you claim/u);

    for (const run of [outside, anonymous, empty]) expect(run.requestBackend).not.toHaveBeenCalled();
  });

  it("releases the holder's claim in this repository", async () => {
    const run = harness(
      { schemaVersion: 1, released: record({ holder: "session-a" }) },
      { environment: { HMUX_SESSION_ID: "session-a" } },
    );
    expect(await run.run("claim", ["--release"])).toBe(0);
    expect(run.body()).toEqual({
      operation: "work_claim.release",
      requiredCapabilities: ["work_claim.v1"],
      body: { schemaVersion: 1, repository, holder: "session-a" },
    });
    expect(run.text()).toBe(`Released the claim of session-a in ${main}.`);
  });

  it("names a backend that predates claims instead of a generic failure", async () => {
    const run = harness(null, { environment: { HMUX_SESSION_ID: "session-a" } });
    run.requestBackend.mockRejectedValueOnce(
      new BackendTransportError("backend_transport_capability_missing", {
        details: { capability: "work_claim.v1" },
      }),
    );
    expect(await run.run("claim", ["--issue", "2"])).toBe(2);
    expect(run.errorOutput.mock.calls[0][0]).toMatch(/does not support work claims \(work_claim\.v1\)/u);

    const json = harness(null, { environment: { HMUX_SESSION_ID: "session-a" } });
    json.requestBackend.mockRejectedValueOnce(
      new BackendTransportError("backend_transport_remote_error", {
        details: { code: "work_claim_request_invalid", disposition: "terminal" },
      }),
    );
    expect(await json.run("claim", ["--issue", "2", "--json"])).toBe(2);
    expect(JSON.parse(json.output.mock.calls[0][0]).error).toMatchObject({
      code: "backend_transport_remote_error",
      remoteCode: "work_claim_request_invalid",
    });
  });
});

describe("dure claims", () => {
  it("lists this repository's claims by default and every repository with --all", async () => {
    const claims = [
      record({ holder: "engine-1", issue: "2", paths: ["Sources/Engine/**"] }, 1_000),
      record({ holder: "session-a", branch: "agent/ui", worktree: "/w/ui", note: "UI pass" }, 0),
    ];
    const run = harness({ schemaVersion: 1, claims, complete: true }, { now: 7_201_000 });
    expect(await run.run("claims", [])).toBe(0);
    expect(run.body().body).toEqual({ schemaVersion: 1, repository });
    expect(run.text()).toBe(
      [
        main,
        "  engine-1 (#2)  2h ago",
        "    paths Sources/Engine/**",
        "  session-a (branch agent/ui)  2h ago",
        "    worktree /w/ui",
        "    note UI pass",
      ].join("\n"),
    );

    const all = harness({ schemaVersion: 1, claims: [], complete: true }, { cwd: root });
    expect(await all.run("claims", ["--all", "--json"])).toBe(0);
    expect(all.body().body).toEqual({ schemaVersion: 1 });
    expect(JSON.parse(all.output.mock.calls[0][0])).toEqual({
      schemaVersion: 1,
      claims: [],
      complete: true,
    });
  });

  it("says when the list was cut short", () => {
    expect(
      formatClaimList({ claims: [record({ holder: "a", issue: "1" })], complete: false }, 1_000),
    ).toMatch(/More claims exist/u);
    expect(formatClaimList({ claims: [], complete: true })).toBe("No claims.");
  });
});
