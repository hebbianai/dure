import { createHash } from "node:crypto";
import {
  agentSpawnQueryExitCode,
  collectAgentSpawnQuery,
  formatAgentSpawnQuery,
} from "./agent-spawn-query.mjs";

export function defaultAgentRunName(providerId, idempotencyKey) {
  const suffix = createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 12);
  const provider = providerId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `${provider}-${suffix}`;
}

export async function collectAgentRun({
  projectId,
  projectPath,
  providerId,
  agentName,
  prompt,
  idempotencyKey,
  worktree = { kind: "project_root" },
  permissionOverride,
  setupCommand,
  includePresentationProject,
  backend,
  deadlineMs,
  requestBackend,
} = {}) {
  const preview = await collectAgentSpawnQuery({
    action: "preview",
    projectId,
    projectPath,
    providerId,
    agentName,
    worktree,
    permissionOverride,
    setupCommand,
    includePresentationProject,
    prompt,
    idempotencyKey,
    backend,
    deadlineMs,
    requestBackend,
  });
  const { presentationProject, ...previewReport } = preview;
  if (agentSpawnQueryExitCode(previewReport) !== 0 || !previewReport.receipt) {
    return { report: previewReport, presentationProject: null };
  }

  const report = await collectAgentSpawnQuery({
    action: "apply",
    operationId: previewReport.receipt.operationId,
    planToken: previewReport.receipt.plan.planToken,
    expectedLastSequence: previewReport.receipt.lastSequence,
    prompt,
    backend,
    deadlineMs,
    requestBackend,
  });
  return { report, presentationProject: presentationProject ?? null };
}

export const agentRunExitCode = agentSpawnQueryExitCode;
export const formatAgentRun = formatAgentSpawnQuery;
