import { randomUUID } from "node:crypto";

const SCHEDULE_HELP = `dure schedule — detached automation runs

Usage:
  dure schedule create [--id ID] [--name NAME] [--project ID | --path PATH]
                       [--provider ID] --cron "M H D M W" [--timezone IANA]
                       [--model MODEL] [--effort EFFORT]
                       [--no-worktree | --base-commit SHA] [--credential-reference ID --credential-generation GENERATION]
                       [--expected-revision N] [--disabled] [--idempotency-key KEY] <prompt>
  dure schedule list
  dure schedule show <id>
  dure schedule set <id> --expected-revision N [--enabled | --disabled] [--cron "M H D M W"]
                    [--timezone IANA] [--name NAME] [--prompt TEXT] [--model MODEL]
                    [--effort EFFORT] [--idempotency-key KEY]
  dure schedule delete <id> --expected-revision N [--idempotency-key KEY]
  dure schedule run-once <id> --expected-revision N [--idempotency-key KEY]
  dure schedule runs [id]
  dure schedule inspect <run-key>

All commands support --backend ID and --json. Runs use an isolated Git worktree by default.
A scheduled agent hibernates after 30 minutes of confirmed idle. Once it has stopped, its
worktree is removed only if it is clean and every commit is on the default branch.
On a host without the Dure app, runs start on the provider's chat runtime when it has one;
read them with dure runs show. Hibernation and worktree removal apply only to terminal runs.
--no-worktree runs in the registered project root, including non-Git directories.
It requires backend capability schedule.worktree_project_root_v1; shared files are not isolated.
The local or SSH control plane must be running; the IDE can be closed.
Set changes only the given fields in place and keeps the schedule's revision history:
--disabled pauses future runs, --enabled resumes them. Read N from show.
Project, provider, permissions, credentials and workspace policy are kept as recorded.
Run-once queues a test without changing the schedule. Inspect reads the retained report.
Scheduled Claude requires prior trust of the registered project folder in the selected account.
Review that folder and complete Claude's interactive startup before scheduling; bypass approvals does not grant folder trust.
Runs/inspect show live provider attention when supported. Started means launch accepted, not task completed.
Unavailable runtime status does not prove exit. A retained completion report remains authoritative.`;

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
  if (action === "set") {
    await runScheduleSet(opts, { backendProfileQueryContext, fail });
    return;
  }
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
        (opts.worktreeSpecified && opts.worktree !== false) ||
        (opts.worktree === false && Boolean(opts.baseCommit || opts.branch || opts.setupCommand)) ||
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
  if (action !== "inspect") announceRetryKey(idempotencyKey, opts);
  const { collectScheduleCommand } = await import("./schedule-client.mjs");
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
    ...(action === "put" && opts.worktree === false ? { worktree: { kind: "project_root" } } : {}),
    ...(action === "put" && opts.baseCommit ? { worktree: { kind: "dedicated", baseCommitSha: opts.baseCommit } } : {}),
    ...(action === "put" && opts.credentialReference ? { executionProfile: {
      kind: "credential_reference", reference_id: opts.credentialReference, credential_generation: opts.credentialGeneration,
    } } : {}),
    backend,
    deadlineMs: deadlineOption(opts),
  });
  await writeScheduleReport(report, opts);
}

/** `set` changes the named fields of the current revision; other create options are refused. */
async function runScheduleSet(opts, { backendProfileQueryContext, fail }) {
  const scheduleId = opts.rest[1];
  const expectedRevision =
    opts.expectedRevision === undefined ? undefined : Number(opts.expectedRevision);
  const changes = {
    ...(opts.enabled ? { enabled: true } : {}),
    ...(opts.disabled ? { enabled: false } : {}),
    ...(opts.cron === undefined ? {} : { expression: opts.cron }),
    ...(opts.timezone === undefined ? {} : { timezone: opts.timezone }),
    ...(opts.nameSpecified ? { name: opts.name } : {}),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.effort === undefined ? {} : { effort: opts.effort }),
  };
  const fixedFieldOption =
    opts.id !== undefined ||
    opts.projectSpecified ||
    opts.pathSpecified ||
    opts.provider !== undefined ||
    opts.worktreeSpecified ||
    Boolean(opts.baseCommit || opts.branch || opts.setupCommand) ||
    Boolean(opts.credentialReference || opts.credentialGeneration) ||
    Boolean(opts.skipPermissions);
  if (
    opts.rest.length !== 2 ||
    !scheduleId ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1 ||
    (opts.enabled && opts.disabled) ||
    fixedFieldOption ||
    Object.keys(changes).length === 0
  ) {
    fail(SCHEDULE_HELP);
  }
  const idempotencyKey = opts.idempotencyKey ||
    `schedule-set-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  announceRetryKey(idempotencyKey, opts);
  const { collectScheduleUpdate } = await import("./schedule-client.mjs");
  const report = await collectScheduleUpdate({
    scheduleId,
    expectedRevision,
    idempotencyKey,
    changes,
    backend: await backendProfileQueryContext(opts),
    deadlineMs: deadlineOption(opts),
  });
  await writeScheduleReport(report, opts);
}

function announceRetryKey(idempotencyKey, opts) {
  if (idempotencyKey && !opts.idempotencyKey) {
    process.stderr.write(`Retry key: ${idempotencyKey}\n`);
  }
}

function deadlineOption(opts) {
  return opts.deadlineMs === undefined ? undefined : Number(opts.deadlineMs);
}

async function writeScheduleReport(report, opts) {
  const { formatScheduleCommand, scheduleCommandExitCode } = await import("./schedule-client.mjs");
  process.stdout.write(
    `${opts.json ? JSON.stringify(report) : formatScheduleCommand(report)}\n`,
  );
  process.exitCode = scheduleCommandExitCode(report);
}
