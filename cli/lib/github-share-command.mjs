import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  GithubReadError,
  githubReadArguments,
  githubReadRepository,
} from "./github-read-policy.mjs";
import {
  GITHUB_READ_VERSION,
  GITHUB_READ_REQUEST_BYTES,
  GITHUB_READ_RESPONSE_BYTES,
  GITHUB_READ_CONCURRENCY,
  githubReadFrames,
  writeGithubReadFrame,
} from "./github-read-wire.mjs";

export const GITHUB_SHARE_HELP = `Share local GitHub issue access with an SSH host

Usage:
  dure github share <ssh-destination> --repo [HOST/]OWNER/REPO [--port PORT]

Run on the computer where gh is installed and logged in. SSH uses your normal
SSH configuration and requires a previously trusted host key. The SSH host
needs Node.js 18+ and a POSIX shell. No GitHub token leaves this computer.

Keep this command running. Run the printed export command in your Dure SSH
terminal; agents started there inherit the gh wrapper. Already-running agents
can use the printed absolute gh path directly.

Supports gh issue list, gh issue view NUMBER, --comments, --json FIELDS, and
list filters: --assignee, --author, --label, --limit, --mention, --milestone,
--search, --state. Commands default to the shared repository. An explicit
--repo or issue URL must match it. Reads allow up to 1000 issues, 20 seconds
and 2 MiB per output stream. --jq/--template, browser actions, auth and writes
are unavailable.

Ctrl-C ends the share and removes its temporary remote wrapper. Start a new
share after disconnecting; an old wrapper never gains new access.
`;

function quote(value) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function parseGithubShare(args) {
  if (args[0] !== "share")
    throw new GithubReadError("Use dure github share; see dure github --help.");
  let destination, repository, port;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--repo" && repository === undefined) repository = githubReadRepository(args[++i]);
    else if (arg === "--port" && port === undefined) {
      const value = args[++i];
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 65535)
        throw new GithubReadError("Invalid SSH port.");
      port = Number(value);
    } else if (!destination && /^[A-Za-z0-9_][A-Za-z0-9_.@:[\]%-]*$/.test(arg)) destination = arg;
    else throw new GithubReadError("Invalid share argument: " + arg);
  }
  if (!destination || !repository)
    throw new GithubReadError("Specify an SSH destination and --repo [HOST/]OWNER/REPO.");
  return { destination, repository, port };
}

/** Deliver the same executable modules exercised by the process fixtures. */
export function githubShareRemoteCommand(repository) {
  const files = Object.fromEntries(
    ["./github-read-wire.mjs", "./github-read-client.mjs", "./github-read-remote.mjs"].map(
      (name) => [name.slice(2), readFileSync(new URL(name, import.meta.url), "utf8")],
    ),
  );
  const source = `
const fs = await import('node:fs');
const {pathToFileURL} = await import('node:url');
const root = fs.mkdtempSync('/tmp/dure-gh-');
fs.chmodSync(root, 0o700);
const identity = fs.lstatSync(root);
try {
  for (const [name, source] of Object.entries(${JSON.stringify(files)})) fs.writeFileSync(root + '/' + name, source, {flag:'wx',mode:0o600});
  const {serveGithubReads} = await import(pathToFileURL(root + '/github-read-remote.mjs'));
  await serveGithubReads(root, ${JSON.stringify(githubReadRepository(repository))});
} catch (error) {
  process.stderr.write('dure: GitHub share failed: ' + error.message + '\\n');
  process.exitCode = 69;
} finally {
  const current = fs.lstatSync(root, {throwIfNoEntry:false});
  if (current?.dev === identity.dev && current.ino === identity.ino) fs.rmSync(root, {recursive:true});
}`;
  return "node --input-type=module -e " + quote(source);
}

export function githubShareSshEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"])
    delete result[name];
  return result;
}

export function githubShareSshArguments({ destination, repository, port }) {
  return [
    "-T",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=2",
    "-o",
    "ConnectTimeout=10",
    ...(port ? ["-p", String(port)] : []),
    "--",
    destination,
    githubShareRemoteCommand(repository),
  ];
}

export function executeGithubRead(
  args,
  { signal, gh = "gh", environment = process.env, timeoutMs = 20_000 } = {},
) {
  const env = {
    ...environment,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "cat",
    PAGER: "cat",
    NO_COLOR: "1",
    CLICOLOR: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  delete env.GH_DEBUG;
  delete env.DEBUG;
  delete env.GH_FORCE_TTY;
  return new Promise((resolve) => {
    execFile(
      gh,
      args,
      {
        env,
        signal,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && !Number.isInteger(error.code)) {
          const message =
            error.code === "ENOENT"
              ? "Install gh on the local computer first."
              : error.name === "AbortError"
                ? "GitHub share disconnected."
                : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
                  ? "GitHub read exceeded its output limit. Request fewer issues or JSON fields."
                  : error.killed
                    ? "GitHub read exceeded its time limit."
                    : "Local gh could not complete the read.";
          resolve({
            version: GITHUB_READ_VERSION,
            code: 69,
            stdout: "",
            stderr: "dure: " + message + "\n",
          });
        } else {
          const result = { version: GITHUB_READ_VERSION, code: error?.code ?? 0, stdout, stderr };
          // JSON escaping can exceed the transport budget even when both streams fit.
          resolve(
            Buffer.byteLength(JSON.stringify(result)) > GITHUB_READ_RESPONSE_BYTES - 128
              ? {
                  version: GITHUB_READ_VERSION,
                  code: 69,
                  stdout: "",
                  stderr: "dure: GitHub read exceeded its encoded output limit.\n",
                }
              : result,
          );
        }
      },
    );
  });
}

/** The SSH process handle owns cancellation; no process-name lookup or retry. */
export async function shareGithubReads(
  options,
  {
    spawnSsh = (args, options) => spawn("ssh", args, options),
    execute = executeGithubRead,
    onReady = () => {},
    signal,
    readyTimeoutMs = 30_000,
  } = {},
) {
  if (signal?.aborted) throw new GithubReadError("GitHub share was cancelled.");
  const repository = githubReadRepository(options.repository);
  const auth = await execute(["auth", "status", "--hostname", repository.split("/")[0]], {
    signal,
  });
  if (auth.code !== 0)
    throw new GithubReadError(auth.stderr || "Log in to gh on the local computer first.");
  if (signal?.aborted) throw new GithubReadError("GitHub share was cancelled.");
  const controller = new AbortController();
  const child = spawnSsh(githubShareSshArguments({ ...options, repository }), {
    env: githubShareSshEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const running = new Set();
  let ready = false,
    stopped = false,
    failure,
    diagnostics = "",
    lastId = 0;
  let shutdownTimer;
  const closed = new Promise((resolve) => child.once("close", (code) => resolve(code)));
  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    child.stdin.end();
    // EOF lets the remote relay remove its socket before SSH reports completion.
    // A broken peer still has a bounded cancellation path owned by this child.
    if (child.exitCode === null && child.signalCode === null) {
      shutdownTimer = setTimeout(() => {
        failure ??= new GithubReadError(
          "GitHub share stopped locally; remote cleanup could not be confirmed.",
        );
        child.kill("SIGTERM");
      }, 5000);
    }
  };
  const fail = (error) => {
    failure ??= error;
    stop();
  };
  const timer = setTimeout(
    () =>
      fail(
        new GithubReadError(
          "The remote GitHub bridge did not become ready. Check SSH access and remote Node.js.",
        ),
      ),
    readyTimeoutMs,
  );
  child.once("error", fail);
  child.stdin.on("error", fail);
  child.stderr.on("data", (chunk) => {
    if (diagnostics.length < 8192)
      diagnostics += chunk.toString("utf8").slice(0, 8192 - diagnostics.length);
  });
  child.once("close", () => {
    clearTimeout(shutdownTimer);
    controller.abort();
  });
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  try {
    for await (const frame of githubReadFrames(child.stdout, GITHUB_READ_REQUEST_BYTES)) {
      if (!ready) {
        if (
          frame?.version !== GITHUB_READ_VERSION ||
          frame.kind !== "ready" ||
          frame.repository !== repository ||
          !/^\/tmp\/dure-gh-[A-Za-z0-9]+\/gh$/.test(frame.executable)
        )
          throw new GithubReadError("Invalid remote GitHub readiness receipt.");
        ready = true;
        clearTimeout(timer);
        onReady(frame);
        continue;
      }
      if (
        frame?.version !== GITHUB_READ_VERSION ||
        !Number.isSafeInteger(frame.id) ||
        frame.id !== lastId + 1 ||
        Object.keys(frame).length !== 3 ||
        running.size >= GITHUB_READ_CONCURRENCY
      )
        throw new GithubReadError("Invalid remote GitHub request.");
      lastId = frame.id;
      const task = (async () => {
        let result;
        try {
          result = await execute(githubReadArguments(frame.args, repository), {
            signal: controller.signal,
          });
        } catch (error) {
          result = {
            version: GITHUB_READ_VERSION,
            code: 64,
            stdout: "",
            stderr: "dure: " + error.message + "\n",
          };
        }
        if (!controller.signal.aborted)
          await writeGithubReadFrame(
            child.stdin,
            { ...result, id: frame.id },
            GITHUB_READ_RESPONSE_BYTES,
          );
      })();
      running.add(task);
      void task.catch(fail).finally(() => running.delete(task));
    }
    const code = await closed;
    if (failure) throw failure;
    if (!signal?.aborted)
      throw new GithubReadError(
        "GitHub share disconnected (SSH exit " + code + "). " + diagnostics.trim(),
      );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    stop();
    await closed;
    await Promise.allSettled(running);
  }
}

export async function runGithubShareCommand(args) {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(GITHUB_SHARE_HELP);
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await shareGithubReads(parseGithubShare(args), {
      signal: controller.signal,
      onReady: ({ repository, executable }) =>
        process.stdout.write(
          "Sharing GitHub issue reads for " +
            repository +
            ". Keep this command running.\n\nRun in the remote Dure terminal:\n  export PATH=" +
            quote(dirname(executable)) +
            ':"$PATH"\n\nExisting agents can invoke:\n  ' +
            executable +
            " issue list --json number,title\n",
        ),
    });
  } catch (error) {
    process.stderr.write("dure: " + error.message + "\n");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
