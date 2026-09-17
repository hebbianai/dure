#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChannelCommand } from "../cli/lib/dure-cli-channel-launcher.mjs";
import { validateControlPlaneBundleIdentity } from "../cli/lib/control-plane-contract.mjs";
import { resolveBundledClaudeStructuredRuntimePayload } from "../cli/lib/claude-structured-runtime.mjs";
import { validateOrchestrationPayloadIdentity } from "../cli/lib/orchestration-integration-bundle.mjs";
import {
  backendRebuildRequired,
  controlPlanePayloadStageRequired,
} from "./lib/dev-launch-impact.mjs";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

function sourceIsCurrent(root, revision, environment) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision ?? "")) return false;
  const git = (args) => execFileSync("git", args, {
    cwd: root,
    env: withoutLocalGitOverrides(environment),
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean);
  const paths = [
    ...git(["diff", "--no-renames", "--name-only", "-z", revision, "--"]),
    ...git(["ls-files", "--others", "--exclude-standard", "-z"]),
  ];
  return !backendRebuildRequired(paths) && !controlPlanePayloadStageRequired(paths);
}

/** Read-only admission using existing bundle integrity and source provenance.
 * Frontend-only commits can reuse tools; unproven native sources cannot.
 * After installation, --verify checks compatibility even for dirty dev builds. */
export function devAgentToolsCurrent({
  root = repositoryRoot,
  home,
  channel,
  hmuxBuildId,
  environment = process.env,
  requireCurrentSource = true,
}) {
  if (!home || !/^dev-[a-z0-9-]{1,60}$/.test(channel ?? "") || !hmuxBuildId) {
    return false;
  }
  try {
    const selected = resolveChannelCommand({
      launcherPath: join(home, ".local/share/hebbian-ide-cli/channels", channel, "launcher/dure.mjs"),
      environment: { ...environment, HOME: home, DURE_APP_CHANNEL: channel },
    });
    const { metadata, resolvedTarget } = selected;
    const cliSource = join(root, "cli");
    const binaryDirectory = dirname(resolvedTarget);
    const packageVersion = JSON.parse(
      readFileSync(join(cliSource, "package.json"), "utf8"),
    ).version;
    if (
      metadata.packageVersion !== packageVersion ||
      metadata.bundle.hmux.buildId !== hmuxBuildId
    ) return false;
    validateControlPlaneBundleIdentity(
      metadata.bundle.controlPlane,
      join(binaryDirectory, metadata.controlPlaneCommand),
      { environment },
    );
    validateOrchestrationPayloadIdentity(
      metadata.bundle.orchestration, join(cliSource, "dure.mjs"),
    );
    if (!resolveBundledClaudeStructuredRuntimePayload({ cliScriptPath: resolvedTarget })) {
      return false;
    }
    return !requireCurrentSource || sourceIsCurrent(
      root, metadata.bundle.app.sourceRevision, environment,
    );
  } catch {
    // Missing, old, incomplete or invalid installs are prepared by the one
    // existing installer; its promotion checks still reject unsafe targets.
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [channel, hmuxBuildId, mode, ...extra] = process.argv.slice(2);
  const validArguments = extra.length === 0 && (mode === undefined || mode === "--verify");
  process.exitCode = validArguments && devAgentToolsCurrent({
    home: process.env.HOME,
    channel,
    hmuxBuildId,
    requireCurrentSource: mode !== "--verify",
  }) ? 0 : 1;
}
