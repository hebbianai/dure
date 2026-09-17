import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { getPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  directoryGeneration,
  directoryGenerationAuthority,
  directoryIdentity,
} from "./atomic-directory-move.mjs";
import {
  discoverBuildOutputs,
  listWorktrees,
  measureBytes,
  observeDureSessionWorktrees,
  reclaim,
  worktreeSessionReason,
} from "./disk-reclaim.mjs";
import { ensureHeadroom } from "./build-storage-admission.mjs";
import { GIB } from "./disk-space.mjs";
import {
  isBuildCommand,
  observeWorktreeProcesses,
  worktreeProcessReason,
} from "./worktree-inventory.mjs";
import { withoutLocalGitOverrides } from "./git-environment.mjs";

let root;
let previousDureHome;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "disk-reclaim-"));
  previousDureHome = process.env.DURE_HOME;
  process.env.DURE_HOME = join(root, "dure-home");
});

afterEach(() => {
  if (previousDureHome === undefined) delete process.env.DURE_HOME;
  else process.env.DURE_HOME = previousDureHome;
  rmSync(root, { force: true, recursive: true });
});

function make(...segments) {
  const path = join(root, ...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

function makeGitWorktree(
  repositoryName,
  branch,
  { ignore = "target/\n" } = {},
) {
  const repository = make(repositoryName);
  const linked = join(root, branch);
  const runGit = (args, cwd = repository) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: withoutLocalGitOverrides(process.env),
    });
  runGit(["init", "--initial-branch=main"]);
  runGit(["config", "user.email", "test@example.test"]);
  runGit(["config", "user.name", "Disk Reclaim Test"]);
  runGit(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repository, ".gitignore"), ignore);
  writeFileSync(join(repository, "tracked"), "fixture\n");
  runGit(["add", ".gitignore", "tracked"]);
  runGit(["commit", "-m", "fixture"]);
  runGit(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  runGit(["worktree", "add", "-b", branch, linked]);
  return { linked, repository, runGit };
}

describe("listWorktrees", () => {
  it("preserves a registered worktree path containing a newline", () => {
    const repository = make("newline-path-repository");
    const linked = join(root, "linked\nworktree");
    const runGit = (args, cwd = repository) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: withoutLocalGitOverrides(process.env),
      });
    runGit(["init", "--initial-branch=main"]);
    runGit(["config", "user.email", "test@example.test"]);
    runGit(["config", "user.name", "Disk Reclaim Test"]);
    runGit(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repository, "tracked"), "fixture\n");
    runGit(["add", "tracked"]);
    runGit(["commit", "-m", "fixture"]);
    runGit(["worktree", "add", "-b", "newline-path", linked]);

    expect(listWorktrees(repository)).toContain(realpathSync(linked));
  });
});

describe("observeDureSessionWorktrees", () => {
  it("protects references from stable and channel-scoped Dure registries", () => {
    const first = make("worktrees", "first");
    const second = make("worktrees", "second");
    const unreferenced = make("worktrees", "unreferenced");
    const stateRoot = make("dure-state");
    writeFileSync(
      join(stateRoot, "agents.json"),
      JSON.stringify({ agents: [{ worktree: first }] }),
    );
    const channel = make("dure-state", "channels", "dev-test");
    writeFileSync(
      join(channel, "agents.json"),
      JSON.stringify({ agents: [{ worktree: second }] }),
    );

    const observation = observeDureSessionWorktrees(
      [first, second, unreferenced],
      { root: stateRoot },
    );

    expect(observation.status).toBe("complete");
    expect(worktreeSessionReason(observation, first)).toBe(
      "session-referenced",
    );
    expect(worktreeSessionReason(observation, second)).toBe(
      "session-referenced",
    );
    expect(worktreeSessionReason(observation, unreferenced)).toBeNull();
  });

  it("fails closed when a Dure registry cannot provide absolute references", () => {
    const worktree = make("worktrees", "candidate");
    const stateRoot = make("invalid-dure-state");
    writeFileSync(
      join(stateRoot, "agents.json"),
      JSON.stringify({ agents: [{ worktree: "relative/path" }] }),
    );

    const observation = observeDureSessionWorktrees([worktree], {
      root: stateRoot,
    });

    expect(observation).toEqual({
      status: "incomplete",
      reason: "session-registry-invalid",
    });
    expect(worktreeSessionReason(observation, worktree)).toBe(
      "session-observation-incomplete",
    );
  });

  it("does not reinterpret a changing session census as empty", () => {
    const worktree = make("worktrees", "candidate");
    let sample = 0;
    const observation = observeDureSessionWorktrees([worktree], {
      root: make("changing-dure-state"),
      readCensus: () => ({
        status: "complete",
        signature: String((sample += 1)),
        references: [],
      }),
    });

    expect(observation).toEqual({
      status: "incomplete",
      reason: "session-registry-census-changed",
    });
  });
});

describe("discoverBuildOutputs", () => {
  it("워크스페이스마다 있는 target을 모두 찾는다", () => {
    make("hmux", "target");
    make("src-tauri", "target");
    make("crates", "hebbian-app", "target");
    make("mobile", "src-tauri", "target");
    make("src", "components");

    expect(discoverBuildOutputs(root).sort()).toEqual(
      [
        join(root, "crates", "hebbian-app", "target"),
        join(root, "hmux", "target"),
        join(root, "mobile", "src-tauri", "target"),
        join(root, "src-tauri", "target"),
      ].sort(),
    );
  });

  it("target 아래로는 내려가지 않는다 — 중첩 target을 따로 세지 않는다", () => {
    make("hmux", "target", "debug", "target");
    expect(discoverBuildOutputs(root)).toEqual([join(root, "hmux", "target")]);
  });

  it("does not reinterpret an arbitrary reclaim path as a build output", () => {
    make(
      ".dure-reclaim",
      "018f6172-6078-7f8a-a9cf-324b6f98e9da",
      "target",
    );
    expect(discoverBuildOutputs(root)).toEqual([]);
  });

  it("captures native-width directory generations without Number coercion", () => {
    const target = make("hmux", "target");
    const metadata = lstatSync(target, { bigint: true });
    expect(directoryGeneration(target)).toEqual({
      change: String(metadata.ctimeNs),
      device: String(metadata.dev),
      inode: String(metadata.ino),
    });
  });

  it("다른 워크트리를 넘겨보지 않는다 (.worktrees 는 건너뛴다)", () => {
    // 워크트리는 git worktree list가 각각 따로 준다. 여기서 또 내려가면
    // 같은 디렉터리를 두 번 계획에 넣게 된다.
    make(".worktrees", "other", "hmux", "target");
    make("hmux", "target");
    expect(discoverBuildOutputs(root)).toEqual([join(root, "hmux", "target")]);
  });

  it("node_modules 와 .git 은 훑지 않는다", () => {
    make("node_modules", "pkg", "target");
    make(".git", "target");
    expect(discoverBuildOutputs(root)).toEqual([]);
  });

  it("깊이 제한을 넘는 곳은 찾지 않는다", () => {
    make("a", "b", "c", "d", "e", "f", "target");
    expect(discoverBuildOutputs(root, 2)).toEqual([]);
  });

  it("없는 경로에서도 던지지 않는다", () => {
    expect(discoverBuildOutputs(join(root, "nope"))).toEqual([]);
  });
});

describe("measureBytes", () => {
  it.skipIf(
    process.platform !== "darwin" && process.platform !== "linux",
  )("executes storage measurement at the converged background priority", () => {
    const fakeBin = make("priority-bin");
    const priorityPath = join(root, "du-priority");
    const target = make("priority-target");
    const du = join(fakeBin, "du");
    writeFileSync(
      du,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { getPriority } from "node:os";
const paths = process.argv.slice(2);
if (paths.shift() !== "-sk") process.exit(64);
writeFileSync(process.env.DURE_TEST_DU_PRIORITY_PATH, String(getPriority()));
process.stdout.write(paths.map((path) => \`1\\t\${path}\`).join("\\n") + "\\n");
`,
      { mode: 0o700 },
    );
    chmodSync(du, 0o700);
    const previousPath = process.env.PATH;
    const previousPriorityPath = process.env.DURE_TEST_DU_PRIORITY_PATH;
    process.env.PATH = `${fakeBin}:${previousPath}`;
    process.env.DURE_TEST_DU_PRIORITY_PATH = priorityPath;
    const callerPriority = getPriority();
    try {
      expect(measureBytes([target])).toEqual([{ path: target, bytes: 1024 }]);
      expect(getPriority()).toBe(callerPriority);
      expect(Number(readFileSync(priorityPath, "utf8"))).toBe(
        Math.max(15, callerPriority),
      );
    } finally {
      process.env.PATH = previousPath;
      if (previousPriorityPath === undefined) {
        delete process.env.DURE_TEST_DU_PRIORITY_PATH;
      } else {
        process.env.DURE_TEST_DU_PRIORITY_PATH = previousPriorityPath;
      }
    }
  });

  it("실제 크기를 잰다", () => {
    const target = make("hmux", "target");
    writeFileSync(join(target, "blob"), "x".repeat(200_000));
    const [entry] = measureBytes([target]);
    expect(entry.path).toBe(target);
    expect(entry.bytes).toBeGreaterThan(100_000);
  });

  it("빈 목록은 du를 부르지 않는다", () => {
    expect(measureBytes([])).toEqual([]);
  });

  it("한 경로가 사라져도 stable 경로의 측정값을 보존한다", () => {
    const target = make("stable", "target");
    writeFileSync(join(target, "blob"), "x".repeat(200_000));
    const [missing, stable] = measureBytes([join(root, "missing"), target]);
    expect(missing.bytes).toBe(0);
    expect(stable.bytes).toBeGreaterThan(100_000);
  });
});

describe("isBuildCommand", () => {
  it("cargo/rustc 와 셸 래퍼를 빌드로 본다", () => {
    for (const command of [
      "cargo build --locked",
      "/Users/x/.cargo/bin/cargo test",
      "rustc --crate-name hmux_host",
      "/bin/sh -c cargo fmt --manifest-path mobile/src-tauri/Cargo.toml --all --check",
      "sh -c cd hmux && cargo clippy",
    ]) {
      expect(isBuildCommand(command)).toBe(true);
    }
  });

  it("이름에 cargo가 들어간 무관한 프로세스를 빌드로 보지 않는다", () => {
    for (const command of [
      "node scripts/cargo-report.mjs",
      "vim cargo.md",
      "tail -f cargo",
    ]) {
      expect(isBuildCommand(command)).toBe(false);
    }
  });
});

describe("observeWorktreeProcesses", () => {
  const ps = () =>
    [
      "  100     1 /bin/zsh",
      "  200   100 cargo build --locked",
      "  300     1 /w/pixel/src-tauri/target/debug/dure",
      "  400     1 node vite",
    ].join("\n");
  const members = (pids) => ({
    status: "complete",
    scope: {
      kind: "point",
      requestedPids: [...pids].sort((left, right) => left - right),
    },
    members: pids.map((pid) => ({
      pid,
      groupId: pid,
      state: "live",
      processIdentity: `test:${pid}`,
    })),
  });
  const membersAt = (entries) => (pids) => {
    const byPid = new Map(typeof entries === "function" ? entries(pids) : entries);
    const observation = members(pids);
    return {
      ...observation,
      members: observation.members.map((member) => ({
        ...member,
        cwd: byPid.get(member.pid),
      })),
    };
  };
  const observe = (worktrees, options = {}) =>
    observeWorktreeProcesses(worktrees, {
      memberRunner: members,
      ...options,
    });
  const record = (result, path) =>
    result.worktrees.find((entry) => entry.path === path);

  it("classifies live, building, and app roles once per worktree", () => {
    const result = observe(["/w/alpha", "/w/beta", "/w/pixel"], {
      psRunner: ps,
      memberRunner: membersAt([
        [100, "/w/alpha"],
        [200, "/w/beta"],
        [300, "/w/pixel/src-tauri"],
        [400, "/w/alpha"],
      ]),
    });

    expect(record(result, "/w/alpha")).toMatchObject({
      pids: [100, 400],
      roles: ["live"],
    });
    expect(record(result, "/w/beta")).toMatchObject({
      pids: [200],
      roles: ["building", "live"],
    });
    expect(record(result, "/w/pixel")).toMatchObject({
      pids: [300],
      roles: ["app", "live"],
    });
  });

  it("uses an embedded generated app path when its cwd is elsewhere", () => {
    const bundled = () =>
      "  301     1 /w/pixel/src-tauri/target/debug/.dure-dev/dev-pixel-a1b2c3d4/Dure.app/Contents/MacOS/dure";
    const result = observe(["/w/pixel"], {
      psRunner: bundled,
      memberRunner: membersAt([[301, "/tmp"]]),
    });

    expect(record(result, "/w/pixel")).toMatchObject({
      pids: [301],
      roles: ["app"],
    });
  });

  it("uses cwd for a dev app whose process command is relative", () => {
    const relative = () => "  700     1 target/debug/dure";
    const result = observe(["/w/daily"], {
      psRunner: relative,
      memberRunner: membersAt([[700, "/w/daily/src-tauri"]]),
    });
    expect(record(result, "/w/daily").roles).toEqual(["app", "live"]);
  });

  it("continues to classify the legacy agent-ide executable as an app", () => {
    const legacy = () =>
      "  710     1 /w/legacy/src-tauri/target/debug/agent-ide";
    const result = observe(["/w/legacy"], {
      psRunner: legacy,
      memberRunner: membersAt([[710, "/tmp"]]),
    });
    expect(record(result, "/w/legacy").roles).toEqual(["app"]);
  });

  it("does not turn missing process cwd values into idle worktrees", () => {
    const result = observe(["/w/alpha"], {
      psRunner: ps,
      memberRunner: membersAt([]),
    });
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "process-cwd-missing",
      missingPids: [100, 200, 300, 400],
    });
    expect(worktreeProcessReason(result, "/w/alpha")).toBe(
      "process-observation-incomplete",
    );
  });

  it("maps a nested process cwd to the longest registered worktree", () => {
    const result = observe(
      ["/repo", "/repo/.worktrees/alice"],
      {
        psRunner: () => "  200   100 cargo build --locked",
        memberRunner: membersAt([[200, "/repo/.worktrees/alice/hmux"]]),
      },
    );

    expect(record(result, "/repo").roles).toEqual([]);
    expect(record(result, "/repo/.worktrees/alice")).toMatchObject({
      pids: [200],
      roles: ["building", "live"],
    });
  });

  it("stabilizes an exact scope after assigning nested processes to their registered owner", () => {
    const registeredWorktrees = ["/repo", "/repo/.worktrees/alice"];
    let mainSamples = 0;
    const main = observe(registeredWorktrees, {
      selectedWorktrees: ["/repo"],
      psRunner: () => {
        mainSamples += 1;
        return `  ${100 + mainSamples}     1 cargo build --locked`;
      },
      memberRunner: membersAt((pids) =>
        pids.map((pid) => [pid, "/repo/.worktrees/alice/hmux"]),
      ),
    });

    expect(mainSamples).toBe(2);
    expect(main).toMatchObject({ status: "complete", scope: ["/repo"] });
    expect(record(main, "/repo")).toMatchObject({ pids: [], roles: [] });

    const nested = observe(registeredWorktrees, {
      selectedWorktrees: ["/repo/.worktrees/alice"],
      psRunner: () => "  200     1 cargo build --locked",
      memberRunner: membersAt([[200, "/repo/.worktrees/alice/hmux"]]),
    });
    expect(record(nested, "/repo/.worktrees/alice")).toMatchObject({
      pids: [200],
      roles: ["building", "live"],
    });
  });

  it("fails closed when an exact process scope is not registered", () => {
    expect(() =>
      observe(["/repo", "/repo/.worktrees/alice"], {
        selectedWorktrees: ["/repo/.worktrees/unknown"],
        psRunner: () => "",
        memberRunner: membersAt([]),
      }),
    ).toThrow("process scope must contain only registered worktrees");
  });

  it("reports an incomplete observation when a requested process cwd is missing", () => {
    const result = observe(["/repo"], {
      psRunner: () =>
        ["  100     1 /bin/zsh", "  200   100 cargo build"].join("\n"),
      memberRunner: membersAt([[100, "/repo"]]),
    });

    expect(result.status).toBe("incomplete");
    expect(result.missingPids).toEqual([200]);
  });

  it("converges when the latest relevant process census stabilizes", () => {
    let observations = 0;
    const result = observe(["/w/alpha"], {
      psRunner: () => {
        observations += 1;
        return observations === 1
          ? "  100     1 /bin/zsh"
          : ["  100     1 /bin/zsh", "  200   100 cargo build"].join(
              "\n",
            );
      },
      memberRunner: membersAt((pids) =>
        pids.map((pid) => [pid, pid === 100 ? "/w/alpha" : "/w/alpha/hmux"]),
      ),
    });

    expect(observations).toBe(3);
    expect(record(result, "/w/alpha")).toMatchObject({
      pids: [100, 200],
      roles: ["building", "live"],
    });
  });

  it("fails closed when every relevant process census differs", () => {
    let observations = 0;
    const result = observe(["/w/alpha"], {
      psRunner: () => {
        observations += 1;
        return Array.from({ length: observations }, (_, index) => {
          const pid = (index + 1) * 100;
          return `  ${pid}     1 /bin/zsh`;
        }).join("\n");
      },
      memberRunner: membersAt((pids) => pids.map((pid) => [pid, "/w/alpha"])),
    });

    expect(observations).toBe(3);
    expect(result).toMatchObject({
      status: "incomplete",
      reason: "process-census-changed",
    });
    expect(worktreeProcessReason(result, "/w/alpha")).toBe(
      "process-observation-incomplete",
    );
  });

  it("requires complete scope and an explicit worktree record", () => {
    expect(
      worktreeProcessReason(
        { status: "complete", scope: [], worktrees: [] },
        "/w/alpha",
      ),
    ).toBe("process-observation-incomplete");
    expect(
      worktreeProcessReason(
        { status: "complete", scope: ["/w/alpha"], worktrees: [] },
        "/w/alpha",
      ),
    ).toBe("process-observation-incomplete");
  });

  it("rejects a complete process identity observation for another scope", () => {
    const result = observe(["/w/alpha"], {
      psRunner: () => "  100     1 /bin/zsh",
      memberRunner: () => ({
        status: "complete",
        scope: { kind: "point", requestedPids: [200] },
        members: [],
      }),
    });

    expect(result).toMatchObject({
      status: "incomplete",
      reason: "process-identity-unavailable",
    });
  });

  it.skipIf(process.platform !== "darwin")(
    "finds process cwd without an open-file census on PATH",
    () => {
      const previousPath = process.env.PATH;
      process.env.PATH = "/bin";
      try {
        const result = observeWorktreeProcesses([process.cwd()], {
          psRunner: () => `  ${process.pid}     1 node vitest`,
        });
        expect(result.status).toBe("complete");
        expect(record(result, process.cwd())).toMatchObject({
          pids: [process.pid],
          roles: ["live"],
        });
      } finally {
        process.env.PATH = previousPath;
      }
    },
  );
});

describe.skipIf(process.platform === "win32")("reclaim size scans", () => {
  it.each(["protected", "removed", "refused"])(
    "only repeats the target-size scan for a selected removal plan (%s)",
    (outcome) => {
      const { linked, repository } = makeGitWorktree("scan-repository", "scan-worker");
      const target = realpathSync(make("scan-worker", "hmux", "target"));
      const blob = join(target, "blob");
      writeFileSync(blob, "generated\n".repeat(20_000));
      const before = measureBytes([target])[0].bytes;
      const bin = make("scan-bin");
      const log = join(root, "size-scans.jsonl");
      writeFileSync(join(bin, "du"), `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const result = spawnSync("/usr/bin/du", args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`, { mode: 0o700 });
      let observations = 0;
      const processObserver = (worktrees, { selectedWorktrees }) => {
        observations += 1;
        return {
          status: "complete",
          scope: selectedWorktrees,
          worktrees: selectedWorktrees.map(path => ({
            path,
            pids: [],
            roles: outcome === "protected" || (outcome === "refused" && observations > 1)
              ? ["building"] : [],
          })),
        };
      };
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}:${previousPath}`;
      let report;
      try {
        report = reclaim({
          cwd: repository,
          worktree: realpathSync(linked),
          apply: true,
          all: true,
          processObserver,
        });
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
      const scans = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(report.totalCacheBytes).toBe(before);
      expect(report.availableAfter).toBeTypeOf("number");
      if (outcome === "protected") {
        expect(report.plan.selected).toEqual([]);
        expect(scans).toEqual([["-sk", target]]);
      } else {
        expect(report.plan.selected).toHaveLength(1);
        expect(scans.filter(args => args.includes(target))).toHaveLength(2);
      }
      if (outcome === "removed") {
        expect(report.removed).toHaveLength(1);
        expect(report.totalCacheAfter).toBe(0);
        expect(report.satisfied).toBe(true);
        expect(existsSync(target)).toBe(false);
      } else {
        expect(report.removed).toEqual([]);
        expect(report.totalCacheAfter).toBe(before);
        expect(report.satisfied).toBe(false);
        expect(readFileSync(blob, "utf8")).toBe("generated\n".repeat(20_000));
      }
    },
  );
});

describe("reclaim process fence", () => {
  it("never falls through to another worktree when the exact scope is building", () => {
    const { linked, repository, runGit } = makeGitWorktree(
      "scoped-repository",
      "scoped-alice",
    );
    const other = join(root, "scoped-bob");
    runGit(["worktree", "add", "-b", "scoped-bob", other]);
    const scopedTarget = join(linked, "hmux", "target");
    const otherTarget = join(other, "hmux", "target");
    for (const target of [scopedTarget, otherTarget]) {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "artifact"), "generated\n");
    }
    const scopedWorktree = realpathSync(linked);
    const observations = [];
    const processObserver = (worktrees, { selectedWorktrees }) => {
      observations.push({
        registered: [...worktrees],
        selected: [...selectedWorktrees],
      });
      return {
        status: "complete",
        scope: [...selectedWorktrees],
        worktrees: selectedWorktrees.map((path) => ({
          path,
          pids: path === scopedWorktree ? [42] : [],
          roles: path === scopedWorktree ? ["building", "live"] : [],
        })),
      };
    };

    const report = reclaim({
      all: true,
      apply: true,
      cwd: repository,
      processObserver,
      worktree: scopedWorktree,
    });

    expect(observations).toEqual([
      {
        registered: [
          realpathSync(repository),
          scopedWorktree,
          realpathSync(other),
        ],
        selected: [scopedWorktree],
      },
    ]);
    expect(report.plan.selected).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.satisfied).toBe(false);
    expect(report.skipped).toContainEqual({
      worktree: scopedWorktree,
      reason: "building",
    });
    expect(existsSync(scopedTarget)).toBe(true);
    expect(existsSync(otherTarget)).toBe(true);
  });

  it("plans generated outputs only inside the exact worktree scope", () => {
    const { linked, repository, runGit } = makeGitWorktree(
      "plan-scope-repository",
      "plan-scope-alice",
    );
    const other = join(root, "plan-scope-bob");
    runGit(["worktree", "add", "-b", "plan-scope-bob", other]);
    const scopedTarget = join(linked, "hmux", "target");
    const otherTarget = join(other, "hmux", "target");
    for (const target of [scopedTarget, otherTarget]) {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "artifact"), "generated\n");
    }
    const scopedWorktree = realpathSync(linked);
    const observations = [];

    const report = reclaim({
      all: true,
      cwd: repository,
      processObserver: (worktrees, { selectedWorktrees }) => {
        observations.push({
          registered: [...worktrees],
          selected: [...selectedWorktrees],
        });
        return {
          status: "complete",
          scope: [...selectedWorktrees],
          worktrees: selectedWorktrees.map((path) => ({
            path,
            pids: [],
            roles: [],
          })),
        };
      },
      worktree: scopedWorktree,
    });

    expect(observations).toEqual([
      {
        registered: [
          realpathSync(repository),
          scopedWorktree,
          realpathSync(other),
        ],
        selected: [scopedWorktree],
      },
    ]);
    expect(report.candidateCount).toBe(1);
    expect(report.plan.selected.map((entry) => entry.path)).toEqual([
      realpathSync(scopedTarget),
    ]);
    expect(report.plan.selected.map((entry) => entry.path)).not.toContain(
      realpathSync(otherTarget),
    );
  });

  it("keeps a later target when a process starts during apply", () => {
    const { linked, repository } = makeGitWorktree("repository", "alice");
    const firstTarget = join(linked, "hmux", "target");
    const laterTarget = join(linked, "src-tauri", "target");
    for (const target of [firstTarget, laterTarget]) {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "artifact"), "generated\n");
    }
    const bin = make("bin");
    const ps = join(bin, "ps");
    writeFileSync(ps, "#!/bin/sh\nexit 0\n");
    chmodSync(ps, 0o755);

    let observations = 0;
    let observedLinked;
    const scopes = [];
    const processObserver = (worktrees, { selectedWorktrees }) => {
      observations += 1;
      scopes.push({
        registered: [...worktrees],
        selected: [...selectedWorktrees],
      });
      observedLinked ??= worktrees.find((worktree) =>
        worktree.endsWith("/alice"),
      );
      return {
        status: "complete",
        scope: [...selectedWorktrees],
        worktrees: selectedWorktrees.map((path) => ({
          path,
          pids: observations >= 4 && path === observedLinked ? [42] : [],
          roles:
            observations >= 4 && path === observedLinked
              ? ["building", "live"]
              : [],
        })),
      };
    };

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    let report;
    try {
      report = reclaim({
        all: true,
        apply: true,
        cwd: repository,
        processObserver,
      });
    } finally {
      process.env.PATH = previousPath;
    }

    expect(observations).toBe(4);
    expect(scopes[0].selected.length).toBeGreaterThan(1);
    expect(scopes.every((scope) => scope.registered.length > 1)).toBe(true);
    expect(scopes.slice(1).map((scope) => scope.selected)).toEqual([
      [observedLinked],
      [observedLinked],
      [observedLinked],
    ]);
    expect(existsSync(firstTarget)).toBe(false);
    expect(existsSync(laterTarget)).toBe(true);
    expect(report.removed).toHaveLength(1);
    expect(report.removedBytes).toBeGreaterThan(0);
    expect(report.satisfied).toBe(false);
    expect(report.skipped).toContainEqual({
      path: realpathSync(laterTarget),
      phase: "pre-claim",
      worktree: observedLinked,
      reason: "building",
    });
  });

  it.skipIf(
    !existsSync("/usr/sbin/lsof") && !existsSync("/usr/bin/lsof"),
  )("isolates the target before a real child enters its worktree", async () => {
    const { linked, repository } = makeGitWorktree(
      "atomic-repository",
      "atomic-alice",
    );
    const target = make("atomic-alice", "hmux", "target");
    writeFileSync(join(target, "artifact"), "generated\n");

    let child;
    const directoryAuthority = {
      ...directoryGenerationAuthority,
      claim(input) {
        const claim = directoryGenerationAuthority.claim(input);
        child = spawn("/bin/sleep", ["30"], {
          cwd: join(linked, "hmux"),
          stdio: "ignore",
        });
        return claim;
      },
    };

    let report;
    try {
      report = reclaim({
        all: true,
        apply: true,
        cwd: repository,
        directoryAuthority,
      });
    } finally {
      if (child?.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
    }

    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(linked, ".dure-reclaim"))).toBe(false);
    expect(report.removed).toEqual([]);
    expect(report.removedBytes).toBe(0);
    expect(report.satisfied).toBe(false);
    expect(report.skipped).toContainEqual({
      path: join(realpathSync(linked), "hmux", "target"),
      phase: "post-claim",
      worktree: realpathSync(linked),
      reason: "live-process",
    });
  });

  it("preserves a replacement target created after isolation", () => {
    const { linked, repository } = makeGitWorktree(
      "replacement-repository",
      "replacement-alice",
    );
    const target = make("replacement-alice", "hmux", "target");
    writeFileSync(join(target, "old"), "old generation\n");
    const processObserver = (worktrees) => ({
      status: "complete",
      scope: [...worktrees],
      worktrees: worktrees.map((path) => ({ path, pids: [], roles: [] })),
    });
    const directoryAuthority = {
      ...directoryGenerationAuthority,
      claim(input) {
        const claim = directoryGenerationAuthority.claim(input);
        mkdirSync(input.path, { recursive: true });
        writeFileSync(join(input.path, "replacement"), "new generation\n");
        return claim;
      },
    };

    const report = reclaim({
      all: true,
      apply: true,
      cwd: repository,
      directoryAuthority,
      processObserver,
    });

    expect(readFileSync(join(target, "replacement"), "utf8")).toBe(
      "new generation\n",
    );
    expect(existsSync(join(target, "old"))).toBe(false);
    expect(report.removed).toHaveLength(1);
    expect(report.removedBytes).toBeGreaterThan(0);
    expect(report.satisfied).toBe(true);
    expect(report.removed[0].worktree).toBe(realpathSync(linked));
  });

  it("retains the isolated generation when restore loses a no-replace race", () => {
    const { linked, repository } = makeGitWorktree(
      "restore-race-repository",
      "restore-race-alice",
    );
    const target = make("restore-race-alice", "hmux", "target");
    writeFileSync(join(target, "old"), "old generation\n");
    let observations = 0;
    const processObserver = (worktrees) => {
      observations += 1;
      return {
        status: "complete",
        scope: [...worktrees],
        worktrees: worktrees.map((path) => ({
          path,
          pids: observations >= 3 ? [42] : [],
          roles: observations >= 3 ? ["live"] : [],
        })),
      };
    };
    const directoryAuthority = {
      ...directoryGenerationAuthority,
      restore(claim) {
        mkdirSync(claim.path, { recursive: true });
        writeFileSync(join(claim.path, "replacement"), "new generation\n");
        return directoryGenerationAuthority.restore(claim);
      },
    };

    const report = reclaim({
      all: true,
      apply: true,
      cwd: repository,
      directoryAuthority,
      processObserver,
    });

    expect(readFileSync(join(target, "replacement"), "utf8")).toBe(
      "new generation\n",
    );
    const residues = directoryGenerationAuthority.inspect(
      linked,
      directoryIdentity(linked),
    );
    expect(residues.conflicts).toEqual([]);
    expect(residues.claims).toHaveLength(1);
    expect(existsSync(residues.claims[0].quarantine)).toBe(true);
    expect(report.removedBytes).toBe(0);
    expect(report.satisfied).toBe(false);
    expect(report.refused.map((entry) => entry.detail).join("\n")).toContain(
      "retained isolated output",
    );
  });

  it("reconciles only an exact manifested claim left by an interrupted run", () => {
    const { linked, repository, runGit } = makeGitWorktree(
      "residue-repository",
      "residue-alice",
      { ignore: "/hmux/target/\n" },
    );
    writeFileSync(join(linked, "branch-only"), "unlanded\n");
    runGit(["add", "branch-only"], linked);
    runGit(["commit", "-m", "unlanded fixture"], linked);
    writeFileSync(join(linked, "local-wip"), "dirty\n");
    const target = make("residue-alice", "hmux", "target");
    writeFileSync(join(target, "artifact"), "generated\n");
    const claim = directoryGenerationAuthority.claim({
      generation: directoryGeneration(target),
      path: target,
      root: linked,
      rootGeneration: directoryIdentity(linked),
    });
    expect(existsSync(target)).toBe(false);
    expect(existsSync(claim.quarantine)).toBe(true);
    expect(runGit(["status", "--porcelain"], linked)).toContain(
      ".dure-reclaim/",
    );
    const processObserver = (worktrees) => ({
      status: "complete",
      scope: [...worktrees],
      worktrees: worktrees.map((path) => ({ path, pids: [], roles: [] })),
    });

    const report = reclaim({
      all: true,
      apply: true,
      cwd: repository,
      processObserver,
    });

    expect(existsSync(claim.transaction)).toBe(false);
    expect(existsSync(join(linked, ".dure-reclaim"))).toBe(false);
    expect(discoverBuildOutputs(linked)).toEqual([]);
    expect(report.removed).toHaveLength(1);
    expect(report.removedBytes).toBeGreaterThan(0);
    expect(report.satisfied).toBe(true);
  });

  it("keeps dry-run inspection read-only", () => {
    const { linked, repository } = makeGitWorktree(
      "inspect-repository",
      "inspect-alice",
    );
    const target = make("inspect-alice", "hmux", "target");
    writeFileSync(join(target, "artifact"), "generated\n");
    const claim = directoryGenerationAuthority.claim({
      generation: directoryGeneration(target),
      path: target,
      root: linked,
      rootGeneration: directoryIdentity(linked),
    });
    const manifest = join(claim.transaction, "claim.json");
    const before = readFileSync(manifest, "utf8");
    const processObserver = (worktrees) => ({
      status: "complete",
      scope: [...worktrees],
      worktrees: worktrees.map((path) => ({ path, pids: [], roles: [] })),
    });

    const report = reclaim({
      all: true,
      cwd: repository,
      processObserver,
    });

    expect(readFileSync(manifest, "utf8")).toBe(before);
    expect(existsSync(claim.quarantine)).toBe(true);
    expect(report.plan.selected).toHaveLength(1);
    expect(report.plan.selected[0]).toMatchObject({
      kind: "recovery",
      lifecycle: "isolated",
      path: join(realpathSync(linked), "hmux", "target"),
    });
  });

  it("converges metadata-only transaction crash windows", () => {
    const { linked } = makeGitWorktree(
      "metadata-repository",
      "metadata-alice",
    );
    const control = make("metadata-alice", ".dure-reclaim");
    chmodSync(control, 0o700);
    const transactions = [
      "018f6172-6078-7f8a-a9cf-324b6f98e9da",
      "018f6172-6078-7f8a-a9cf-324b6f98e9db",
    ].map((transactionId) => {
      const transaction = make(
        "metadata-alice",
        ".dure-reclaim",
        transactionId,
      );
      chmodSync(transaction, 0o700);
      return transaction;
    });
    writeFileSync(join(transactions[1], "claim.json"), "{partial", {
      mode: 0o600,
    });
    const rootGeneration = directoryIdentity(linked);

    expect(
      directoryGenerationAuthority.inspect(linked, rootGeneration),
    ).toEqual({ claims: [], conflicts: [] });
    expect(transactions.every((transaction) => existsSync(transaction))).toBe(
      true,
    );

    expect(
      directoryGenerationAuthority.recover(linked, rootGeneration),
    ).toEqual({ claims: [], conflicts: [] });
    expect(existsSync(control)).toBe(false);
  });

  it("reports the same payload conflict during inspect and recovery", () => {
    const { linked } = makeGitWorktree(
      "resolved-conflict-repository",
      "resolved-conflict-alice",
    );
    const target = make("resolved-conflict-alice", "hmux", "target");
    writeFileSync(join(target, "artifact"), "generated\n");
    const claim = directoryGenerationAuthority.claim({
      generation: directoryGeneration(target),
      path: target,
      root: linked,
      rootGeneration: directoryIdentity(linked),
    });
    const manifest = join(claim.transaction, "claim.json");
    const value = JSON.parse(readFileSync(manifest, "utf8"));
    writeFileSync(manifest, `${JSON.stringify({ ...value, state: "removing" })}\n`);
    rmSync(claim.quarantine, { recursive: true });
    writeFileSync(join(claim.transaction, "unexpected"), "foreign\n", {
      mode: 0o600,
    });
    const rootGeneration = directoryIdentity(linked);

    const inspected = directoryGenerationAuthority.inspect(
      linked,
      rootGeneration,
    );
    const recovered = directoryGenerationAuthority.recover(
      linked,
      rootGeneration,
    );

    expect(inspected.claims).toEqual([]);
    expect(recovered.claims).toEqual([]);
    expect(inspected.conflicts).toHaveLength(1);
    expect(recovered.conflicts).toHaveLength(1);
    expect(existsSync(join(claim.transaction, "unexpected"))).toBe(true);
  });

  it.skipIf(
    process.platform !== "darwin" && !process.platform.startsWith("linux"),
  )("serializes operations on one transaction", async () => {
    const { linked } = makeGitWorktree("lock-repository", "lock-alice");
    const target = make("lock-alice", "hmux", "target");
    writeFileSync(join(target, "artifact"), "generated\n");
    const claim = directoryGenerationAuthority.claim({
      generation: directoryGeneration(target),
      path: target,
      root: linked,
      rootGeneration: directoryIdentity(linked),
    });
    const holder = spawn(
      "python3",
      [
        "-c",
        [
          "import fcntl, os, sys, time",
          "descriptor = os.open(sys.argv[1], os.O_RDONLY)",
          "fcntl.flock(descriptor, fcntl.LOCK_EX)",
          "print('ready', flush=True)",
          "time.sleep(30)",
        ].join("\n"),
        claim.transaction,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await once(holder.stdout, "data");
    let failure;
    try {
      directoryGenerationAuthority.remove(claim);
    } catch (error) {
      failure = error;
    } finally {
      const exited = once(holder, "exit");
      holder.kill("SIGTERM");
      await exited;
    }

    expect(failure).toMatchObject({ code: "EBUSY" });
    expect(existsSync(claim.quarantine)).toBe(true);
    directoryGenerationAuthority.remove(claim);
    expect(existsSync(claim.transaction)).toBe(false);
  });

  it("resumes only after a durable removing transition", () => {
    const { linked, repository } = makeGitWorktree(
      "removing-repository",
      "removing-alice",
    );
    const target = make("removing-alice", "hmux", "target");
    writeFileSync(join(target, "artifact"), "generated\n");
    const claim = directoryGenerationAuthority.claim({
      generation: directoryGeneration(target),
      path: target,
      root: linked,
      rootGeneration: directoryIdentity(linked),
    });
    const manifest = join(claim.transaction, "claim.json");
    const value = JSON.parse(readFileSync(manifest, "utf8"));
    writeFileSync(manifest, `${JSON.stringify({ ...value, state: "removing" })}\n`);
    writeFileSync(join(claim.quarantine, "late-artifact"), "generated\n");
    const processObserver = (worktrees) => ({
      status: "complete",
      scope: [...worktrees],
      worktrees: worktrees.map((path) => ({ path, pids: [], roles: [] })),
    });

    const report = reclaim({
      all: true,
      apply: true,
      cwd: repository,
      processObserver,
    });

    expect(existsSync(claim.transaction)).toBe(false);
    expect(report.removed).toHaveLength(1);
    expect(report.removed[0]).toMatchObject({
      kind: "recovery",
      lifecycle: "removing",
    });
  });

  it("converges a prepared claim completed by the atomic rename", () => {
    const { linked, repository } = makeGitWorktree(
      "prepared-repository",
      "prepared-alice",
    );
    const target = make("prepared-alice", "hmux", "target");
    writeFileSync(join(target, "artifact"), "generated\n");
    const claim = directoryGenerationAuthority.claim({
      generation: directoryGeneration(target),
      path: target,
      root: linked,
      rootGeneration: directoryIdentity(linked),
    });
    const manifest = join(claim.transaction, "claim.json");
    const value = JSON.parse(readFileSync(manifest, "utf8"));
    writeFileSync(
      manifest,
      `${JSON.stringify({
        ...value,
        state: "prepared",
        target: { ...value.target, change: "0" },
      })}\n`,
    );
    const processObserver = (worktrees) => ({
      status: "complete",
      scope: [...worktrees],
      worktrees: worktrees.map((path) => ({ path, pids: [], roles: [] })),
    });

    const report = reclaim({
      all: true,
      apply: true,
      cwd: repository,
      processObserver,
    });

    expect(existsSync(claim.transaction)).toBe(false);
    expect(report.removed).toHaveLength(1);
  });

  it("refuses ctime drift before the removing authority is durable", () => {
    const { linked, repository } = makeGitWorktree(
      "isolated-drift-repository",
      "isolated-drift-alice",
    );
    const target = make("isolated-drift-alice", "hmux", "target");
    writeFileSync(join(target, "artifact"), "generated\n");
    const claim = directoryGenerationAuthority.claim({
      generation: directoryGeneration(target),
      path: target,
      root: linked,
      rootGeneration: directoryIdentity(linked),
    });
    writeFileSync(join(claim.quarantine, "foreign-change"), "not authorized\n");
    const processObserver = (worktrees) => ({
      status: "complete",
      scope: [...worktrees],
      worktrees: worktrees.map((path) => ({ path, pids: [], roles: [] })),
    });

    const report = reclaim({
      all: true,
      apply: true,
      cwd: repository,
      processObserver,
    });

    expect(existsSync(claim.quarantine)).toBe(true);
    expect(report.removed).toEqual([]);
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "recovery",
          reason: "reclaim-residue-conflict",
          worktree: realpathSync(linked),
        }),
      ]),
    );
  });

  it("refreshes Git authorization immediately before each claim", () => {
    const { linked, repository, runGit } = makeGitWorktree(
      "git-race-repository",
      "git-race-alice",
    );
    const laterWorktree = join(root, "git-race-bob");
    runGit(["worktree", "add", "-b", "git-race-bob", laterWorktree]);
    const firstTarget = make("git-race-alice", "hmux", "target");
    const laterTarget = make("git-race-bob", "hmux", "target");
    for (const target of [firstTarget, laterTarget]) {
      writeFileSync(join(target, "artifact"), "generated\n");
    }
    const directoryAuthority = {
      ...directoryGenerationAuthority,
      claim(input) {
        const claim = directoryGenerationAuthority.claim(input);
        if (input.root === realpathSync(linked)) {
          writeFileSync(join(laterWorktree, "local-wip"), "new work\n");
        }
        return claim;
      },
    };
    const processObserver = (worktrees) => ({
      status: "complete",
      scope: [...worktrees],
      worktrees: worktrees.map((path) => ({ path, pids: [], roles: [] })),
    });

    const report = reclaim({
      all: true,
      apply: true,
      cwd: repository,
      directoryAuthority,
      processObserver,
    });

    expect(existsSync(firstTarget)).toBe(false);
    expect(existsSync(laterTarget)).toBe(true);
    expect(report.removed).toHaveLength(1);
    expect(report.skipped).toContainEqual({
      path: realpathSync(laterTarget),
      phase: "pre-claim",
      reason: "dirty",
      worktree: realpathSync(laterWorktree),
    });
  });

  it("retains an unmanifested reclaim path as a conflict", () => {
    const { linked, repository } = makeGitWorktree(
      "conflict-repository",
      "conflict-alice",
    );
    const transaction = make(
      "conflict-alice",
      ".dure-reclaim",
      "018f6172-6078-7f8a-a9cf-324b6f98e9da",
    );
    chmodSync(join(linked, ".dure-reclaim"), 0o700);
    chmodSync(transaction, 0o700);
    const foreign = make(
      "conflict-alice",
      ".dure-reclaim",
      "018f6172-6078-7f8a-a9cf-324b6f98e9da",
      "target",
    );
    writeFileSync(join(foreign, "artifact"), "foreign\n");
    const processObserver = (worktrees) => ({
      status: "complete",
      scope: [...worktrees],
      worktrees: worktrees.map((path) => ({ path, pids: [], roles: [] })),
    });

    const report = reclaim({
      all: true,
      apply: true,
      cwd: repository,
      processObserver,
    });

    expect(readFileSync(join(foreign, "artifact"), "utf8")).toBe("foreign\n");
    expect(report.removed).toEqual([]);
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "recovery",
          reason: "reclaim-residue-conflict",
          worktree: realpathSync(linked),
        }),
      ]),
    );
  });

  it("refuses an ancestor symlink swap instead of deleting its target", () => {
    const { linked, repository } = makeGitWorktree(
      "symlink-race-repository",
      "symlink-race-alice",
    );
    const originalParent = make("symlink-race-alice", "hmux");
    const originalTarget = make("symlink-race-alice", "hmux", "target");
    writeFileSync(join(originalTarget, "original"), "original generation\n");
    const externalParent = make("external-build");
    const externalTarget = make("external-build", "target");
    writeFileSync(join(externalTarget, "foreign"), "foreign generation\n");
    const retainedParent = `${originalParent}.retained`;
    let observations = 0;
    const processObserver = (worktrees) => {
      observations += 1;
      if (observations === 2) {
        renameSync(originalParent, retainedParent);
        symlinkSync(externalParent, originalParent, "dir");
      }
      return {
        status: "complete",
        scope: [...worktrees],
        worktrees: worktrees.map((path) => ({ path, pids: [], roles: [] })),
      };
    };

    const report = reclaim({
      aggressive: true,
      all: true,
      apply: true,
      cwd: repository,
      processObserver,
    });

    expect(readFileSync(join(externalTarget, "foreign"), "utf8")).toBe(
      "foreign generation\n",
    );
    expect(
      readFileSync(join(retainedParent, "target", "original"), "utf8"),
    ).toBe("original generation\n");
    expect(report.removed).toEqual([]);
    expect(report.refused.map((entry) => entry.detail).join("\n")).toContain(
      "generation changed",
    );
  });

  it("aggressive apply removes only generated output, never its worktree", () => {
    const { linked, repository } = makeGitWorktree(
      "aggressive-boundary-repository",
      "aggressive-boundary-alice",
    );
    writeFileSync(join(linked, "local-wip"), "keep me\n");
    const target = make("aggressive-boundary-alice", "hmux", "target");
    writeFileSync(join(target, "artifact"), "generated\n");

    const report = reclaim({
      aggressive: true,
      all: true,
      apply: true,
      cwd: repository,
      processObserver: (worktrees) => ({
        status: "complete",
        scope: [...worktrees],
        worktrees: worktrees.map((path) => ({ path, pids: [], roles: [] })),
      }),
    });

    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(linked, "local-wip"), "utf8")).toBe("keep me\n");
    expect(listWorktrees(repository)).toContain(realpathSync(linked));
    expect(report.removed).toHaveLength(1);
  });

  it("aggressive apply preserves a target used by a live session process", () => {
    const { linked, repository } = makeGitWorktree(
      "aggressive-repository",
      "aggressive-alice",
    );
    const target = make("aggressive-alice", "hmux", "target");
    writeFileSync(join(target, "artifact"), "generated\n");
    const processObserver = (worktrees) => ({
      status: "complete",
      scope: [...worktrees],
      worktrees: worktrees.map((path) => ({
        path,
        pids: path === realpathSync(linked) ? [42] : [],
        roles: path === realpathSync(linked) ? ["live"] : [],
      })),
    });

    const report = reclaim({
      aggressive: true,
      all: true,
      apply: true,
      cwd: repository,
      processObserver,
    });

    expect(existsSync(target)).toBe(true);
    expect(report.removed).toEqual([]);
    expect(report.removedBytes).toBe(0);
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "live-process",
          worktree: realpathSync(linked),
        }),
      ]),
    );
  });

  it("treats a Dure session reference as authoritative when process CWD is idle", () => {
    const { linked, repository } = makeGitWorktree(
      "session-reference-repository",
      "session-reference-alice",
    );
    const linkedPath = realpathSync(linked);
    const target = make("session-reference-alice", "hmux", "target");
    writeFileSync(join(target, "artifact"), "generated\n");
    const processObserver = (worktrees) => ({
      status: "complete",
      scope: [...worktrees],
      worktrees: worktrees.map((path) => ({ path, pids: [], roles: [] })),
    });
    const sessionObserver = (worktrees, { selectedWorktrees }) => ({
      status: "complete",
      scope: [...selectedWorktrees],
      worktrees: selectedWorktrees.map((path) => ({
        path,
        referenceCount: path === linkedPath ? 1 : 0,
      })),
    });

    const report = reclaim({
      aggressive: true,
      all: true,
      apply: true,
      cwd: repository,
      processObserver,
      sessionObserver,
    });

    expect(existsSync(target)).toBe(true);
    expect(report.removed).toEqual([]);
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "session-referenced",
          worktree: linkedPath,
        }),
      ]),
    );
  });

  it("rechecks Dure session references before the destructive boundary", () => {
    const { linked, repository } = makeGitWorktree(
      "session-race-repository",
      "session-race-alice",
    );
    const linkedPath = realpathSync(linked);
    const target = make("session-race-alice", "hmux", "target");
    writeFileSync(join(target, "artifact"), "generated\n");
    let observations = 0;
    const sessionObserver = (worktrees, { selectedWorktrees }) => {
      observations += 1;
      return {
        status: "complete",
        scope: [...selectedWorktrees],
        worktrees: selectedWorktrees.map((path) => ({
          path,
          referenceCount: observations >= 2 && path === linkedPath ? 1 : 0,
        })),
      };
    };

    const report = reclaim({
      all: true,
      apply: true,
      cwd: repository,
      processObserver: (worktrees) => ({
        status: "complete",
        scope: [...worktrees],
        worktrees: worktrees.map((path) => ({ path, pids: [], roles: [] })),
      }),
      sessionObserver,
    });

    expect(observations).toBe(2);
    expect(report.candidateCount).toBe(1);
    expect(existsSync(target)).toBe(true);
    expect(report.removed).toEqual([]);
    expect(report.skipped).toContainEqual({
      path: realpathSync(target),
      phase: "pre-claim",
      reason: "session-referenced",
      worktree: linkedPath,
    });
  });

  it("fails the applied plan closed when session references are unobservable", () => {
    const { linked, repository } = makeGitWorktree(
      "session-unknown-repository",
      "session-unknown-alice",
    );
    const target = make("session-unknown-alice", "hmux", "target");
    writeFileSync(join(target, "artifact"), "generated\n");

    const report = reclaim({
      all: true,
      apply: true,
      cwd: repository,
      processObserver: (worktrees) => ({
        status: "complete",
        scope: [...worktrees],
        worktrees: worktrees.map((path) => ({ path, pids: [], roles: [] })),
      }),
      sessionObserver: () => ({
        status: "incomplete",
        reason: "session-registry-invalid",
      }),
    });

    expect(existsSync(target)).toBe(true);
    expect(report.removed).toEqual([]);
    expect(report.satisfied).toBe(false);
    expect(report.sessionObservation).toEqual({
      status: "incomplete",
      reason: "session-registry-invalid",
      applyStatus: "incomplete",
      applyReason: "session-registry-invalid",
    });
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "session-observation-incomplete",
          worktree: realpathSync(linked),
        }),
      ]),
    );
  });
});

describe("build storage admission", () => {
  it("plans safe reclaim when local generated cache exceeds its root budget", () => {
    const { linked, repository } = makeGitWorktree(
      "cache-budget-repository",
      "cache-budget-worker",
    );
    const target = join(linked, "hmux", "target");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "artifact"), "generated\n");
    const report = reclaim({
      cacheBudgetBytes: 1,
      cwd: repository,
      floorBytes: 0,
      goalBytes: 0,
      processObserver: (worktrees) => ({
        status: "complete",
        scope: [...worktrees],
        worktrees: worktrees.map((path) => ({ path, pids: [], roles: [] })),
      }),
    });

    expect(report.overCacheBudget).toBe(true);
    expect(report.totalCacheBytes).toBeGreaterThan(1);
    expect(report.plan.selected.map((entry) => entry.path)).toContain(
      realpathSync(target),
    );
  });

  it("does not approve concurrent budgets beyond one volume's free capacity", () => {
    const { repository } = makeGitWorktree(
      "reservation-repository",
      "reservation-worker",
    );
    const stats = statfsSync(repository, { bigint: true });
    const available = Number(stats.bavail * stats.bsize);
    const floorBytes = 1024 ** 3;
    const requestedBytes = Math.floor((available - floorBytes) / 2) + 1;
    const reservationRoot = make("build-storage-reservations");
    const options = {
      cwd: repository,
      floorBytes,
      goalBytes: floorBytes,
      label: "fixture build",
      log: () => {},
      observeAvailableBytes: () => available,
      // The refused request retries once after safe reclaim. Let that retry
      // read the same fixed capacity: unstubbed, it observes the live volume,
      // and this fixture overbooks by exactly two bytes — any concurrent write
      // on the machine repaid that margin and admitted the second build.
      reclaimOutputs: () => ({
        availableAfter: available,
        removed: [],
        removedBytes: 0,
      }),
      requestedBytes,
      reservationRoot,
    };

    const first = ensureHeadroom(options);
    const second = ensureHeadroom(options);
    try {
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(false);
    } finally {
      first.reservation?.release();
      second.reservation?.release();
    }
  });

  it("refuses a sub-10GiB fixture before starting the build", () => {
    const { repository } = makeGitWorktree(
      "low-space-repository",
      "low-space-worker",
    );
    const requestedBytes = 10 * GIB;
    let reclaimed = 0;
    const result = ensureHeadroom({
      cwd: repository,
      floorBytes: 0,
      goalBytes: 0,
      label: "low-space fixture",
      log: () => {},
      observeAvailableBytes: () => 9 * GIB,
      reclaimOutputs: () => {
        reclaimed += 1;
        return {
          availableAfter: 9 * GIB,
          removed: [],
          removedBytes: 0,
        };
      },
      requestedBytes,
      reservationOptions: {
        observeProcesses: (pids) => ({
          status: "complete",
          scope: { kind: "point", requestedPids: pids },
          members: pids.map((pid) => ({
            pid,
            processIdentity: "fixture:owner",
            state: "live",
          })),
        }),
        ownerIdentity: "fixture:owner",
        pid: 41,
      },
      reservationRoot: make("low-space-reservations"),
    });

    expect(result.ok).toBe(false);
    expect(reclaimed).toBe(1);
    expect(result.message).toContain("was not started");
    expect(result.message.length).toBeLessThan(1_024);
  });
});
