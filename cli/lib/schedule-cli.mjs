import { randomUUID } from "node:crypto";

const SCHEDULE_HELP = `dure schedule — detached automation runs

Usage:
  dure schedule create [--id ID] [--name NAME] [--project ID | --path PATH]
                       [--provider ID] --cron "M H D M W" [--timezone IANA]
                       [--model MODEL] [--effort EFFORT]
                       [--base-commit SHA] [--credential-reference ID --credential-generation GENERATION]
                       [--expected-revision N] [--disabled] [--idempotency-key KEY] <prompt>
  dure schedule list
  dure schedule show <id>
  dure schedule delete <id> --expected-revision N [--idempotency-key KEY]
  dure schedule run-once <id> --expected-revision N [--idempotency-key KEY]
  dure schedule runs [id]
  dure schedule inspect <run-key>

All commands support --backend ID and --json. Runs use an isolated Git worktree.
The local or SSH control plane must be running; the IDE can be closed.
Run-once queues a test without changing the schedule. Inspect reads the retained report.`;

export async function runScheduleCli(sub, opts, { backendProfileQueryContext, backendProjectPathSelector, fail }) {
  if ([undefined, "help", "-h", "--help"].includes(sub)) {
    process.stdout.write(`${SCHEDULE_HELP}\n`);
    return;
  }
  const action =
    sub === "create" || sub === "put"
      ? "put"
      : sub === "runs"
        ? "occurrences"
        : sub === "run-once" ? "run_once" : sub;
  const explicitScheduleId = action === "put" ? opts.id : opts.rest[1];
  const scheduleId =
    action === "put"
      ? explicitScheduleId ||
        `schedule-${randomUUID().replaceAll("-", "").slice(0, 12)}`
      : action === "inspect" ? undefined : explicitScheduleId;
  const positionalPrompt = action === "put" ? opts.rest.slice(1).join(" ") : "";
  const prompt = opts.prompt || positionalPrompt;
  const expectedRevision =
    opts.expectedRevision === undefined
      ? action === "put"
        ? 0
        : undefined
      : Number(opts.expectedRevision);
  const invalid =
    !["put", "list", "show", "delete", "occurrences", "run_once", "inspect"].includes(action) ||
    (action === "put" &&
      ((Boolean(opts.prompt) && Boolean(positionalPrompt)) ||
        !opts.cron ||
        !prompt ||
        (opts.projectSpecified && opts.pathSpecified) ||
        (opts.projectSpecified && !opts.project) ||
        (opts.pathSpecified && !opts.path))) ||
    (action === "list" && opts.rest.length !== 1) ||
    (action === "show" && (opts.rest.length !== 2 || !scheduleId)) ||
    (["delete", "run_once"].includes(action) &&
      (opts.rest.length !== 2 || !scheduleId || expectedRevision === undefined)) ||
    (action === "occurrences" && opts.rest.length > 2) ||
    (action === "inspect" && opts.rest.length !== 2) ||
    (Boolean(opts.credentialReference) !== Boolean(opts.credentialGeneration));
  if (invalid) fail(SCHEDULE_HELP);

  const idempotencyKey = action === "inspect" ? opts.rest[1] : ["put", "delete", "run_once"].includes(action)
    ? opts.idempotencyKey ||
      `schedule-${action}-${randomUUID().replaceAll("-", "").slice(0, 12)}`
    : undefined;
  if (action !== "inspect" && idempotencyKey && !opts.idempotencyKey) {
    process.stderr.write(`Retry key: ${idempotencyKey}\n`);
  }
  const {
    collectScheduleCommand,
    formatScheduleCommand,
    scheduleCommandExitCode,
  } = await import("./schedule-client.mjs");
  const backend = await backendProfileQueryContext(opts);
  const report = await collectScheduleCommand({
    action,
    scheduleId,
    expectedRevision,
    idempotencyKey,
    name:
      action === "put"
        ? opts.name || explicitScheduleId || "Scheduled run"
        : undefined,
    enabled: action === "put" ? !opts.disabled : undefined,
    expression: action === "put" ? opts.cron : undefined,
    timezone: action === "put" ? opts.timezone || "UTC" : undefined,
    projectId:
      action === "put" && opts.projectSpecified ? opts.project : undefined,
    projectPath:
      action === "put" && !opts.projectSpecified
        ? backendProjectPathSelector(opts, backend, true)
        : undefined,
    providerId: action === "put" ? opts.provider || "claude" : undefined,
    model: action === "put" ? opts.model : undefined,
    effort: action === "put" ? opts.effort : undefined,
    prompt: action === "put" ? prompt : undefined,
    permissionMode:
      action === "put" && opts.skipPermissions
        ? "skip_permissions"
        : undefined,
    ...(action === "put" && opts.baseCommit ? { worktree: { kind: "dedicated", baseCommitSha: opts.baseCommit } } : {}),
    ...(action === "put" && opts.credentialReference ? { executionProfile: {
      kind: "credential_reference", reference_id: opts.credentialReference, credential_generation: opts.credentialGeneration,
    } } : {}),
    backend,
    deadlineMs:
      opts.deadlineMs === undefined ? undefined : Number(opts.deadlineMs),
  });
  process.stdout.write(
    `${opts.json ? JSON.stringify(report) : formatScheduleCommand(report)}\n`,
  );
  process.exitCode = scheduleCommandExitCode(report);
}
