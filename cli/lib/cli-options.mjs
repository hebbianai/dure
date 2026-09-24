/** Shared CLI options preserve all positional arguments after --. */
export function parseOpts(args) {
  const opts = {
    follow: false,
    lines: 0,
    enter: true,
    worktree: undefined,
    worktreeSpecified: false,
    idle: false,
    project: "",
    projectSpecified: false,
    agent: "",
    name: "",
    prompt: "",
    timeout: 0,
    rest: [],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      opts.rest.push(...args.slice(i + 1));
      break;
    }
    if (a === "-f" || a === "--follow") opts.follow = true;
    else if (a === "-n" || a === "--lines") {
      opts.linesSpecified = true;
      opts.lines = parseInt(args[++i], 10) || 0;
    }
    else if (a === "--no-enter") opts.enter = false;
    else if (a === "--no-worktree") {
      opts.worktreeSpecified = true;
      opts.worktree = false;
    }
    else if (a === "--worktree") {
      opts.worktreeSpecified = true;
      opts.worktree = args[++i];
    }
    else if (a === "--base-commit") opts.baseCommit = args[++i];
    else if (a === "--credential-reference") opts.credentialReference = args[++i];
    else if (a === "--credential-generation") opts.credentialGeneration = args[++i];
    else if (a === "--branch") opts.branch = args[++i];
    else if (a === "--setup-command") opts.setupCommand = args[++i];
    else if (a === "--skip-permissions") opts.skipPermissions = true;
    else if (a === "--permission-override") opts.permissionOverride = args[++i] ?? "";
    else if (a === "--idle") opts.idle = true;
    else if (a === "--project" || a === "-p") {
      opts.projectSpecified = true;
      opts.project = args[++i];
    }
    else if (a === "--path") {
      opts.pathSpecified = true;
      opts.path = args[++i];
    }
    else if (a === "--agent" || a === "-a") opts.agent = args[++i];
    else if (a === "--agent-name") opts.agentName = args[++i];
    else if (a === "--from-session") opts.fromSession = args[++i];
    else if (a === "--strict-session") opts.strictSession = args[++i] ?? null;
    else if (a === "--account") opts.account = args[++i] ?? "";
    else if (a === "--provider") opts.provider = args[++i];
    else if (a === "--model") opts.model = args[++i] ?? "";
    else if (a === "--effort") opts.effort = args[++i] ?? "";
    else if (a === "--name") {
      opts.nameSpecified = true;
      opts.name = args[++i];
    }
    else if (a === "--prompt") opts.prompt = args[++i];
    else if (a === "--timeout") opts.timeout = parseInt(args[++i], 10) || 0;
    else if (a === "--timeout-ms") opts.timeoutMs = args[++i];
    else if (a === "--probe-budget-ms") opts.probeBudgetMs = args[++i];
    else if (a === "--cache-ms") opts.cacheMs = args[++i];
    else if (a === "--projection") {
      opts.projectionSpecified = true;
      opts.projection = args[++i];
    }
    else if (a === "--apply") opts.apply = true;
    else if (a === "--to") opts.to = args[++i];
    else if (a === "--from") opts.from = args[++i];
    else if (a === "--body") opts.body = args[++i];
    else if (a === "--subject") opts.subject = args[++i];
    else if (a === "--type") opts.type = args[++i];
    else if (a === "--title") opts.title = args[++i];
    else if (a === "--spec") opts.spec = args[++i];
    else if (a === "--deps") opts.deps = args[++i];
    else if (a === "--status") opts.status = args[++i];
    else if (a === "--assignee") opts.assignee = args[++i];
    else if (a === "--task") opts.task = args[++i];
    else if (a === "--id") opts.id = args[++i];
    else if (a === "--question") opts.question = args[++i];
    else if (a === "--options") opts.options = args[++i];
    else if (a === "--resolution") opts.resolution = args[++i];
    else if (a === "--inject") opts.inject = true;
    else if (a === "--unread") opts.unread = true;
    else if (a === "--wait") opts.wait = true;
    else if (a === "--types") opts.types = args[++i];
    else if (a === "--all") opts.all = true;
    else if (a === "--cron") opts.cron = args[++i];
    else if (a === "--timezone") opts.timezone = args[++i];
    else if (a === "--expected-revision") opts.expectedRevision = args[++i];
    else if (a === "--disabled") opts.disabled = true;
    else if (a === "--reuse" || a === "--reuse-session") opts.reuse = true;
    else if (a === "--app") opts.app = args[++i];
    else if (a === "--kind") opts.kind = args[++i];
    else if (a === "--contact") opts.contact = args[++i];
    else if (a === "--text") opts.text = args[++i];
    else if (a === "--key") opts.key = args[++i];
    else if (a === "--space") {
      opts.spaceSpecified = true;
      opts.space = args[++i];
    }
    else if (a === "--space-id") opts.spaceId = args[++i];
    // Deprecated compatibility alias; emit both equal fields at the boundary.
    else if (a === "--desktop-id") opts.desktopId = args[++i];
    else if (a === "--target-panel-id") opts.targetPanelId = args[++i];
    else if (a === "--conversation-id") opts.conversationId = args[++i];
    else if (a === "--fresh") opts.fresh = true;
    else if (a === "--permission-mode") opts.permissionMode = args[++i] ?? "";
    else if (a === "--plan-token") opts.planToken = args[++i];
    else if (a === "--confirm-restart") opts.confirmRestart = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--window-label") opts.windowLabel = args[++i];
    else if (a === "--idempotency-key") opts.idempotencyKey = args[++i];
    else if (a === "--operation-id") opts.operationId = args[++i];
    else if (a === "--expected-sequence") opts.expectedSequence = args[++i];
    else if (a === "--existing-session") opts.existingSessionId = args[++i];
    else if (a === "--binding-generation") opts.bindingGeneration = args[++i];
    else if (a === "--metadata-json") opts.metadataJson = args[++i];
    else if (a === "--cwd") opts.cwd = args[++i];
    else if (a === "--repo") opts.repo = args[++i];
    else if (a === "--workspace") opts.workspace = args[++i];
    else if (a === "--cursor") opts.cursor = args[++i] ?? "";
    else if (a === "--deadline-ms") opts.deadlineMs = args[++i];
    else if (a === "--probe-budget-ms") opts.probeBudgetMs = args[++i];
    else if (a === "--global" || a === "-g") opts.global = true;
    else if (a === "--remote") opts.remote = true;
    else if (a === "--approve-global-config") opts.approveGlobalConfig = true;
    else if (a === "--install-root") opts.installRoot = args[++i];
    else if (a === "--transport-ref") opts.transportRef = args[++i];
    else if (a === "--hook-json") opts.hookJson = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--check") opts.check = true;
    else if (a === "--require") opts.require = args[++i] ?? "";
    else if (a === "--backend") {
      opts.backendSpecified = true;
      opts.backend = args[++i];
    }
    else opts.rest.push(a);
  }
  return opts;
}
