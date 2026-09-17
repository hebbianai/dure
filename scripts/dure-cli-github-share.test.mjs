import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubReadArguments, githubReadRepository } from "../cli/lib/github-read-policy.mjs";
import {
  executeGithubRead,
  githubShareSshEnvironment,
  parseGithubShare,
  shareGithubReads,
} from "../cli/lib/github-share-command.mjs";
import { GITHUB_READ_VERSION, githubReadFrames } from "../cli/lib/github-read-wire.mjs";

const repository = "github.com/hebbianai/dure-internal";
const cli = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function run(file, args, options = {}) {
  return new Promise((resolve) =>
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: 10_000, maxBuffer: 7 * 1024 * 1024, ...options },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    ),
  );
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture(
  source = "process.stdout.write(JSON.stringify({args, tokenPresent:Boolean(process.env.GH_TOKEN)}));",
) {
  const root = mkdtempSync(join(tmpdir(), "dure-gh-fixture-"));
  const gh = join(root, "gh");
  writeFileSync(
    gh,
    "#!" +
      process.execPath +
      "\nconst args = process.argv.slice(2);\nif (args[0] === 'auth') process.exit(0);\n" +
      source,
    { mode: 0o700 },
  );
  const controller = new AbortController();
  const ready = deferred();
  const calls = [];
  let child;
  const environment = {
    PATH: process.env.PATH,
    HOME: root,
    DURE_HOME: root,
    HMUX_DISCOVERY_ROOT: join(root, "discovery"),
    GH_TOKEN: "disposable-gh-fixture-token",
    GH_DEBUG: "api",
  };
  const share = shareGithubReads(
    { destination: "fixture", repository },
    {
      signal: controller.signal,
      onReady: ready.resolve,
      spawnSsh: (args) => {
        // Real delivered modules, Unix socket and gh wrapper; only SSH encryption is substituted here.
        child = spawn("/bin/sh", ["-c", args.at(-1)], {
          env: {
            PATH: process.env.PATH,
            HOME: root,
            DURE_HOME: root,
            HMUX_DISCOVERY_ROOT: join(root, "remote-discovery"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        return child;
      },
      execute: (args, options) => {
        calls.push(args);
        return executeGithubRead(args, { ...options, gh, environment });
      },
    },
  );
  share.catch(ready.reject);
  cleanups.push(async () => {
    controller.abort();
    await share.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  const receipt = await ready.promise;
  return {
    receipt,
    calls,
    controller,
    share,
    child,
    root,
    read: (args) => run(receipt.executable, args, { env: { PATH: process.env.PATH, HOME: root } }),
  };
}

describe("GitHub read authority", () => {
  it("pins the repository and preserves useful list filters", () => {
    expect(githubReadRepository("HebbianAI/Dure-Internal")).toBe(repository);
    expect(
      githubReadArguments(
        [
          "issue",
          "list",
          "-R",
          "hebbianai/dure-internal",
          "--state=all",
          "--json",
          "number,title,labels",
          "--search",
          "no:assignee -label:status:blocked",
        ],
        repository,
      ),
    ).toEqual([
      "issue",
      "list",
      "--repo",
      repository,
      "--state",
      "all",
      "--json",
      "number,title,labels",
      "--search",
      "no:assignee -label:status:blocked",
    ]);
    expect(
      githubReadArguments(
        ["issue", "view", "https://github.com/hebbianai/dure-internal/issues/42", "-c"],
        repository,
      ),
    ).toEqual(["issue", "view", "--repo", repository, "42", "--comments"]);
  });
  it.each([
    ["auth", "token"],
    ["auth", "status", "--show-token"],
    ["api", "/user"],
    ["extension", "exec", "anything"],
    ["issue", "create", "--title", "wrong"],
    ["issue", "close", "42"],
    ["issue", "view", "42", "--web"],
    ["issue", "view", "42", "--template", "{{.}}"],
    ["issue", "list", "--jq", "env"],
    ["issue", "list", "--repo", "other/private"],
    ["issue", "view", "https://github.com/other/private/issues/42"],
    ["issue", "list", "--search", "repo:other/private"],
    ["issue", "list", "--search", "foo OR bar"],
    ["issue", "list", "--limit", "1001"],
    ["issue", "view", "-1"],
    ["issue", "view"],
    ["issue", "list", "--json", "title\n--web"],
  ])("refuses unsupported or unscoped reads: %j", (...args) => {
    expect(() => githubReadArguments(args, repository)).toThrow();
  });
  it.each([
    ["share", "-oProxyCommand=touch"],
    ["share", "host", "--repo", "a/b", "--port", "0"],
    ["share", "host;id", "--repo", "a/b"],
    ["share", "host", "--repo", "a/b", "--repo", "other/repo"],
  ])("rejects ambiguous SSH share arguments: %j", (...args) => {
    expect(() => parseGithubShare(args)).toThrow();
  });
  it("keeps GitHub authentication out of the SSH process even with SendEnv configured", () => {
    const env = {
      PATH: "/bin",
      SSH_AUTH_SOCK: "/private/agent",
      GH_TOKEN: "fake-1",
      GITHUB_TOKEN: "fake-2",
      GH_ENTERPRISE_TOKEN: "fake-3",
      GITHUB_ENTERPRISE_TOKEN: "fake-4",
    };
    expect(githubShareSshEnvironment(env)).toEqual({
      PATH: "/bin",
      SSH_AUTH_SOCK: "/private/agent",
    });
    expect(env.GH_TOKEN).toBe("fake-1");
  });
  it("accepts an SSH alias and an explicit port", () => {
    expect(
      parseGithubShare([
        "share",
        "clink@worker",
        "--repo",
        "hebbianai/dure-internal",
        "--port",
        "2222",
      ]),
    ).toEqual({ destination: "clink@worker", repository, port: 2222 });
  });
});

describe("GitHub bridge framing", () => {
  it("preserves UTF-8 split across transport chunks", async () => {
    const data = Buffer.from(JSON.stringify({ body: "한글 👋\ncomment" }) + "\n");
    const frames = [];
    for await (const frame of githubReadFrames(
      Readable.from(Array.from(data, (byte) => Buffer.from([byte]))),
      200,
    ))
      frames.push(frame);
    expect(frames).toEqual([{ body: "한글 👋\ncomment" }]);
  });
  it.each([Buffer.from("[]"), Buffer.from("\n"), Buffer.alloc(1025, 120), Buffer.from([0xff, 10])])(
    "rejects partial, empty, oversized or invalid UTF-8 frames",
    async (data) => {
      await expect(
        (async () => {
          for await (const _frame of githubReadFrames(Readable.from([data]), 1024)) {
          }
        })(),
      ).rejects.toThrow();
    },
  );
});

describe("Dure GitHub sharing through real processes", () => {
  it("delivers list args to local gh and returns its output without sending its token to the remote artifact", async () => {
    const { read, receipt, calls } = await fixture();
    const result = await read(["issue", "list", "--json", "number,title,body,labels,assignees"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args: ["issue", "list", "--repo", repository, "--json", "number,title,body,labels,assignees"],
      tokenPresent: true,
    });
    expect(calls[0]).toEqual(["auth", "status", "--hostname", "github.com"]);
    expect(readFileSync(receipt.executable, "utf8")).not.toContain("disposable-gh-fixture-token");
    expect(
      readFileSync(join(dirname(receipt.executable), "github-read-client.mjs"), "utf8"),
    ).not.toContain("disposable-gh-fixture-token");
  });
  it("preserves comments, Unicode, stderr and a nonzero gh exit status", async () => {
    const { read } = await fixture(
      'process.stdout.write("한글 👋\\ncomment\\n"); process.stderr.write("rate limit\\n"); process.exitCode = 7;',
    );
    expect(await read(["issue", "view", "42", "--comments"])).toEqual({
      code: 7,
      stdout: "한글 👋\ncomment\n",
      stderr: "rate limit\n",
    });
  });
  it("rejects writes and another repository at the local boundary, then still serves valid reads", async () => {
    const { read, calls } = await fixture();
    expect((await read(["issue", "close", "42"])).code).toBe(64);
    expect((await read(["issue", "list", "-R", "other/private"])).code).toBe(64);
    expect(calls).toHaveLength(1);
    expect((await read(["issue", "view", "42", "--json", "body,comments"])).code).toBe(0);
    expect(calls).toHaveLength(2);
  });
  it("correlates concurrent responses without crossing client output", async () => {
    const { read } = await fixture(
      "setTimeout(() => process.stdout.write(args.at(-1)), Number(args.at(-1)) === 1 ? 120 : 5);",
    );
    const results = await Promise.all(
      [1, 2, 3, 4].map((number) => read(["issue", "view", String(number)])),
    );
    expect(results.map((result) => result.stdout)).toEqual(["1", "2", "3", "4"]);
    expect(results.every((result) => result.code === 0)).toBe(true);
  });
  it("ends access and removes only its temporary root when the share is stopped", async () => {
    const { read, receipt, controller, share, root } = await fixture();
    expect((await read(["issue", "list"])).code).toBe(0);
    controller.abort();
    await share;
    expect(existsSync(dirname(receipt.executable))).toBe(false);
    expect(existsSync(root)).toBe(true);
    expect((await read(["issue", "list"])).code).not.toBe(0);
  });
  it("reports missing local gh before opening SSH", async () => {
    const spawnSsh = vi.fn();
    await expect(
      shareGithubReads(
        { destination: "fixture", repository },
        {
          spawnSsh,
          execute: (args, options) =>
            executeGithubRead(args, { ...options, gh: "/missing/dure-gh-fixture" }),
        },
      ),
    ).rejects.toThrow("Install gh");
    expect(spawnSsh).not.toHaveBeenCalled();
  });
  it("returns an output-limit error instead of partial successful output", async () => {
    const { read } = await fixture('process.stdout.write("x".repeat(3 * 1024 * 1024));');
    const result = await read(["issue", "list"]);
    expect(result.code).toBe(69);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("output limit");
  });
  it("bounds JSON-escaped output without terminating the share", async () => {
    const { read } = await fixture(
      "process.stdout.write(String.fromCharCode(0).repeat(2 * 1024 * 1024));",
    );
    const result = await read(["issue", "list"]);
    expect(result.code).toBe(69);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("encoded output limit");
    expect((await read(["issue", "view", "42"])).code).toBe(69);
  });
  it("allows an exclusion-only search while retaining the repository constraint", () => {
    expect(
      githubReadArguments(["issue", "list", "--search", "-label:blocked"], repository),
    ).toEqual(["issue", "list", "--repo", repository, "--search", "-label:blocked"]);
  });
  it("does not connect after local authentication fails", async () => {
    const spawnSsh = vi.fn();
    await expect(
      shareGithubReads(
        { destination: "fixture", repository },
        {
          spawnSsh,
          execute: async () => ({
            version: GITHUB_READ_VERSION,
            code: 1,
            stdout: "",
            stderr: "Log in to gh first.",
          }),
        },
      ),
    ).rejects.toThrow("Log in");
    expect(spawnSsh).not.toHaveBeenCalled();
  });
  it("refuses a mismatched readiness receipt before running any issue command", async () => {
    const execute = vi.fn(async () => ({
      version: GITHUB_READ_VERSION,
      code: 0,
      stdout: "",
      stderr: "",
    }));
    const wrong = {
      version: GITHUB_READ_VERSION,
      kind: "ready",
      repository: "github.com/other/private",
      executable: "/tmp/dure-gh-test/gh",
    };
    await expect(
      shareGithubReads(
        { destination: "fixture", repository },
        {
          execute,
          spawnSsh: () =>
            spawn(
              process.execPath,
              [
                "-e",
                "process.stdout.write(" +
                  JSON.stringify(JSON.stringify(wrong) + String.fromCharCode(10)) +
                  ")",
              ],
              { stdio: ["pipe", "pipe", "pipe"] },
            ),
        },
      ),
    ).rejects.toThrow("readiness receipt");
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("loads the command without an app or Hmux session", async () => {
    const result = await run(process.execPath, [cli, "github", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("dure github share");
  });
});
