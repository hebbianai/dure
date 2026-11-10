import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, posix, relative, resolve } from "node:path";
import {
  backendTransportErrorReport,
  performBackendProfileRequest,
} from "./backend-transport.mjs";

export const CLAIM_CAPABILITY = "work_claim.v1";
export const CLAIM_OVERLAP_EXIT_CODE = 3;
const MAX_PATHS = 32;

export const CLAIM_HELP = `dure claim — say what you are working on so others see overlaps (Beta)

  dure claim [HOLDER] [--issue N] [--branch NAME] [--worktree PATH]
             [--paths PATTERN...] [--note TEXT] [--check] [--repo PATH]
             [--backend ID] [--json]
  dure claim --release [HOLDER] [--repo PATH] [--backend ID] [--json]
  dure claims [--repo PATH | --all] [--backend ID] [--json]

A claim is advisory: nothing is locked. It belongs to one Git repository (all of
its worktrees) and replaces the holder's previous claim there. HOLDER defaults
to the current Dure session; then --branch and --worktree default to the
current checkout. Outside a session, name the holder (an agent or bot name).

Path patterns are relative to the current directory inside the repository and
may use * and ? within a name and ** across folders. A folder covers everything
below it. Quote patterns so the shell does not expand them.

dure claim reports other holders' claims with the same issue, branch or
worktree, or with paths that can name the same file. --check reports them
without recording anything. Exit status: 0 no overlap, 3 overlap found,
2 nothing was claimed or the backend refused.

dure claims lists the claims in the current repository; --all lists every
repository on the backend.`;

function usage(message) {
  return new Error(`${message}\n\n${CLAIM_HELP}`);
}

const VALUE_FLAGS = new Set([
  "--issue",
  "--branch",
  "--worktree",
  "--note",
  "--repo",
  "--backend",
]);

/** `claim` and `claims` share one parser; each refuses the other's flags. */
export function parseClaimCommand(command, args) {
  const options = { paths: [], positional: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--help", "-h", "help"].includes(argument)) return { action: "help" };
    if (argument === "--paths" || argument === "--path") {
      const start = index;
      while (args[index + 1] !== undefined && !args[index + 1].startsWith("--")) {
        options.paths.push(args[index + 1]);
        index += 1;
      }
      if (index === start) throw usage(`${argument} needs at least one pattern.`);
      continue;
    }
    if (VALUE_FLAGS.has(argument)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw usage(`${argument} needs a value.`);
      }
      const key = argument.slice(2);
      if (Object.hasOwn(options, key)) throw usage(`${argument} was given twice.`);
      options[key] = value;
      index += 1;
      continue;
    }
    if (["--check", "--release", "--all", "--json"].includes(argument)) {
      options[argument.slice(2)] = true;
      continue;
    }
    if (argument.startsWith("--")) throw usage(`Unknown option ${argument}.`);
    options.positional.push(argument);
  }
  if (command === "claims") {
    const refused = ["issue", "branch", "worktree", "note", "check", "release"].find(
      (key) => options[key] !== undefined,
    );
    if (refused || options.paths.length > 0 || options.positional.length > 0) {
      throw usage("dure claims takes only --repo, --all, --backend and --json.");
    }
    if (options.all && options.repo !== undefined) {
      throw usage("Use either --repo or --all.");
    }
    return { action: "list", ...options };
  }
  if (options.all) throw usage("--all belongs to dure claims.");
  if (options.positional.length > 1) throw usage("Name at most one holder.");
  const holder = options.positional[0];
  if (options.release) {
    const refused = ["issue", "branch", "worktree", "note", "check"].find(
      (key) => options[key] !== undefined,
    );
    if (refused || options.paths.length > 0) {
      throw usage("--release takes only HOLDER, --repo, --backend and --json.");
    }
    return { action: "release", holder, ...options };
  }
  if (options.paths.length > MAX_PATHS) {
    throw usage(`Claim at most ${MAX_PATHS} path patterns.`);
  }
  return { action: options.check ? "check" : "put", holder, ...options };
}

function defaultGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
  return result.status === 0 ? result.stdout : null;
}

/** The repository every worktree shares (its common Git directory), this
 *  checkout's root, the directory's place in it and the current branch. */
export function inspectRepository(directory, { git = defaultGit, realpath = realpathSync } = {}) {
  const output = git(["rev-parse", "--git-common-dir", "--show-toplevel", "--show-prefix"], directory);
  if (output === null) return null;
  const [commonDirectory, root, prefix = ""] = output.replace(/\n$/u, "").split("\n");
  if (!commonDirectory || !root) return null;
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], directory)?.trim();
  return {
    repository: realpath(resolve(directory, commonDirectory)),
    root,
    prefix,
    branch: branch || null,
  };
}

export function repositoryDisplay(repository) {
  return basename(repository) === ".git" ? dirname(repository) : repository;
}

/** Repository-relative, `/`-separated patterns without `.` or `..`. A pattern
 *  naming the whole checkout becomes `**`. */
export function normalizeClaimPaths(patterns, { root, prefix }, platform = process.platform) {
  const normalized = [];
  for (const original of patterns) {
    let pattern = platform === "win32" ? original.replaceAll("\\", "/") : original;
    if (isAbsolute(pattern)) {
      const inside = relative(root, pattern);
      if (inside.startsWith("..") || isAbsolute(inside)) {
        throw new Error(`${original} is outside the checkout ${root}.`);
      }
      pattern = inside.replaceAll("\\", "/");
    } else {
      pattern = `${prefix}${pattern}`;
    }
    pattern = posix.normalize(pattern).replace(/\/+$/u, "");
    if (pattern === ".." || pattern.startsWith("../")) {
      throw new Error(`${original} is outside the repository.`);
    }
    if (pattern === "." || pattern === "") pattern = "**";
    if (!normalized.includes(pattern)) normalized.push(pattern);
  }
  return normalized;
}

function describeClaim(record) {
  const claim = record.claim;
  const parts = [];
  if (claim.issue) parts.push(/^\d+$/u.test(claim.issue) ? `#${claim.issue}` : claim.issue);
  if (claim.branch) parts.push(`branch ${claim.branch}`);
  return parts.length > 0 ? `${claim.holder} (${parts.join(", ")})` : claim.holder;
}

function age(milliseconds) {
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

const REASONS = Object.freeze({
  issue: "same issue",
  branch: "same branch",
  worktree: "same worktree",
});

export function formatOverlaps(overlaps) {
  const lines = [];
  for (const overlap of overlaps) {
    const shared = overlap.reasons.filter((reason) => reason !== "paths").map((reason) => REASONS[reason]);
    const paths = overlap.paths.map(({ mine, theirs }) =>
      mine === theirs ? mine : `${mine} ~ ${theirs}`,
    );
    if (paths.length > 0) shared.push(`paths ${paths.join(", ")}`);
    lines.push(`  ${describeClaim(overlap.held)}: ${shared.join("; ")}`);
  }
  return lines;
}

export function formatClaimReceipt(receipt, nowMs = Date.now()) {
  const claim = receipt.claim.claim;
  const lines = [
    `${receipt.recorded ? "Claimed" : "Checked (not recorded)"} for ${claim.holder} in ${repositoryDisplay(claim.repository)}.`,
  ];
  if (receipt.overlaps.length === 0) {
    lines.push("No overlap with other claims.");
  } else {
    lines.push(
      `Overlaps ${receipt.overlaps.length} other ${receipt.overlaps.length === 1 ? "claim" : "claims"}:`,
      ...formatOverlaps(receipt.overlaps),
    );
    for (const overlap of receipt.overlaps) {
      if (nowMs - overlap.held.updatedAtMs > 24 * 60 * 60 * 1000) {
        lines.push(
          `  ${overlap.held.claim.holder} last claimed ${age(nowMs - overlap.held.updatedAtMs)}; release a stale claim with: dure claim --release ${overlap.held.claim.holder}`,
        );
      }
    }
  }
  return lines.join("\n");
}

export function formatClaimList(result, nowMs = Date.now()) {
  if (result.claims.length === 0) return "No claims.";
  const lines = [];
  let repository;
  for (const record of result.claims) {
    const claim = record.claim;
    if (claim.repository !== repository) {
      repository = claim.repository;
      if (lines.length > 0) lines.push("");
      lines.push(repositoryDisplay(repository));
    }
    lines.push(`  ${describeClaim(record)}  ${age(nowMs - record.updatedAtMs)}`);
    if (claim.worktree) lines.push(`    worktree ${claim.worktree}`);
    if (claim.paths.length > 0) lines.push(`    paths ${claim.paths.join(", ")}`);
    if (claim.note) lines.push(`    note ${claim.note}`);
  }
  if (!result.complete) lines.push("", "More claims exist; filter with --repo.");
  return lines.join("\n");
}

function errorText(report, action) {
  const { code, remoteCode, message, capability } = report.error;
  if (code === "backend_transport_capability_missing" || code === "backend_transport_profile_capability_missing") {
    return `This backend does not support work claims (${capability ?? CLAIM_CAPABILITY}). Update Dure on the backend host.`;
  }
  return `Could not ${action}: ${message} (${remoteCode ?? code}).`;
}

/** Runs `dure claim` or `dure claims` and returns the exit status. */
export async function runClaimCommand(
  command,
  args,
  {
    resolveBackend,
    requestBackend = performBackendProfileRequest,
    environment = process.env,
    cwd = process.cwd(),
    git = defaultGit,
    realpath = realpathSync,
    platform = process.platform,
    now = Date.now,
    output = (text) => process.stdout.write(`${text}\n`),
    errorOutput = (text) => process.stderr.write(`${text}\n`),
  },
) {
  const parsed = parseClaimCommand(command, args);
  if (parsed.action === "help") {
    output(CLAIM_HELP);
    return 0;
  }
  const directory = resolve(cwd, parsed.repo ?? ".");
  const checkout = parsed.all ? null : inspectRepository(directory, { git, realpath });
  if (!checkout && (parsed.action !== "list" || parsed.repo !== undefined)) {
    errorOutput(
      `${directory} is not inside a Git repository. Run this in the checkout or pass --repo PATH.`,
    );
    return 2;
  }

  let operation;
  let body;
  if (parsed.action === "list") {
    operation = "work_claim.list";
    body = { schemaVersion: 1, ...(checkout ? { repository: checkout.repository } : {}) };
  } else {
    const sessionId = environment.HMUX_SESSION_ID?.trim() || null;
    const holder = parsed.holder ?? sessionId;
    if (!holder) {
      errorOutput("Name the holder (dure claim HOLDER ...); outside a Dure session there is no default.");
      return 2;
    }
    if (parsed.action === "release") {
      operation = "work_claim.release";
      body = { schemaVersion: 1, repository: checkout.repository, holder };
    } else {
      const self = parsed.holder === undefined;
      let paths;
      try {
        paths = normalizeClaimPaths(parsed.paths, checkout, platform);
      } catch (error) {
        errorOutput(error.message);
        return 2;
      }
      const branch = parsed.branch ?? (self ? checkout.branch : null);
      const worktree =
        parsed.worktree === undefined
          ? self ? checkout.root : null
          : resolve(cwd, parsed.worktree);
      const claim = {
        repository: checkout.repository,
        holder,
        ...(self ? { sessionId } : {}),
        ...(self && environment.HMUX_WORKSPACE_ID?.trim()
          ? { workspaceId: environment.HMUX_WORKSPACE_ID.trim() }
          : {}),
        ...(parsed.issue ? { issue: parsed.issue.replace(/^#/u, "") } : {}),
        ...(branch ? { branch } : {}),
        ...(worktree ? { worktree } : {}),
        paths,
        ...(parsed.note ? { note: parsed.note } : {}),
      };
      if (!claim.issue && !claim.branch && !claim.worktree && paths.length === 0) {
        errorOutput("Say what you claim: --issue, --branch, --worktree or --paths.");
        return 2;
      }
      operation = "work_claim.put";
      body = { schemaVersion: 1, claim, dryRun: parsed.action === "check" };
    }
  }

  let backend;
  try {
    backend = await resolveBackend({
      backend: parsed.backend,
      backendSpecified: parsed.backend !== undefined,
    });
    if (backend.error) throw backend.error;
    const response = await requestBackend(
      backend.profile,
      { operation, body, requiredCapabilities: [CLAIM_CAPABILITY] },
      backend.transportOptions,
    );
    const result = response.result;
    const nowMs = now();
    if (parsed.json) output(JSON.stringify(result));
    if (parsed.action === "list") {
      if (!parsed.json) output(formatClaimList(result, nowMs));
      return 0;
    }
    if (parsed.action === "release") {
      if (!parsed.json) {
        output(
          result.released
            ? `Released the claim of ${body.holder} in ${repositoryDisplay(body.repository)}.`
            : `${body.holder} holds no claim in ${repositoryDisplay(body.repository)}.`,
        );
      }
      return 0;
    }
    if (!parsed.json) output(formatClaimReceipt(result, nowMs));
    return result.overlaps.length > 0 ? CLAIM_OVERLAP_EXIT_CODE : 0;
  } catch (error) {
    const report = backendTransportErrorReport(error, backend?.profile);
    if (parsed.json) output(JSON.stringify(report));
    else {
      errorOutput(
        errorText(
          report,
          { list: "list claims", release: "release the claim", check: "check the claim", put: "record the claim" }[parsed.action],
        ),
      );
    }
    return 2;
  }
}
