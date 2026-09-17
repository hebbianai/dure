import {
  publicAppControlIdentity,
  requestAppControl,
} from "./app-control-client.mjs";

const INPUT_REPORT_CAPABILITY = "performance_report.terminal_input_v1";
const MAX_SUMMARY_WINDOWS = 8;
const HELP = "dure perf report [--projection terminal-input] [--json]\n" +
  "dure perf summary [--json]";

export async function runPerformanceCommand(action, options, descriptor) {
  if (action !== "report" && action !== "summary") return HELP;
  if (options.projectionSpecified && options.projection !== "terminal-input") {
    throw new Error("--projection must be terminal-input");
  }
  if (!descriptor) {
    throw new Error("Dure app is not running; performance reports require a connected app.");
  }
  const projection = action === "summary" ? "terminal-input" : options.projection;
  if (
    projection &&
    (!Array.isArray(descriptor.capabilities) ||
      !descriptor.capabilities.includes(INPUT_REPORT_CAPABILITY))
  ) {
    throw new Error("running app does not advertise terminal-input performance reports");
  }
  const receipt = await requestAppControl({
    descriptor,
    path: "/perf/report",
    body: projection ? { projection } : {},
    // Reuse the bounded app-control transport. Full reports include geometry
    // and workspace evidence; the input projection needs only its default cap.
    ...(projection ? {} : { maxResponseBytes: 32 * 1024 * 1024 }),
  });
  if (projection && receipt.projection !== "terminal-input") {
    throw new Error("running app did not honor the terminal-input projection");
  }
  const payload = receipt.projection === "terminal-input"
    ? { ...receipt.report, generatedAtMs: receipt.generatedAtMs ?? null }
    : {
        ...receipt.report,
        frameBudget: receipt.frameBudget ?? null,
        multiWindow: receipt.multiWindow ?? null,
        terminalGeometry: receipt.terminalGeometry ?? null,
        generatedAtMs: receipt.generatedAtMs ?? null,
      };
  if (action === "summary") {
    if (
      payload.schemaVersion !== 1 || payload.projection !== "terminal-input" ||
      !Array.isArray(payload.windows)
    ) {
      throw new Error("running app returned an incompatible terminal-input report");
    }
    if (!options.json) {
      return formatPerformanceSummary(payload, publicAppControlIdentity(descriptor));
    }
  }
  return JSON.stringify(payload, null, options.json ? undefined : 2);
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : "unavailable";
}

function milliseconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? `${Number(value.toFixed(3))}ms`
    : "unavailable";
}

function label(value) {
  return typeof value === "string" && value.length > 0
    ? JSON.stringify(value.length > 256 ? `${value.slice(0, 256)}…` : value)
    : "unavailable";
}

function capturedAt(value) {
  const date = new Date(typeof value === "number" ? value : Number.NaN);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "unavailable";
}

function timing(stats, detailed = false) {
  if (!Number.isSafeInteger(stats?.count) || stats.count < 0) return "unavailable";
  if (stats.count === 0) return "no samples (n=0)";
  const values = detailed
    ? `median=${milliseconds(stats.median)} p95=${milliseconds(stats.p95)} max=${milliseconds(stats.max)}`
    : `p95=${milliseconds(stats.p95)}`;
  return `${values} (n=${stats.count})`;
}

function sourceLines(name, source) {
  if (!source) return [`  ${name}: unavailable`];
  return [
    `  ${name}: echo ${timing(source.inputToEchoPaint, true)}`,
    `    dispatch→transport ${timing(source.dispatchToTransportConfirmation)}; transport→Host ${timing(source.transportConfirmationToHostReceipt)}`,
    `    Host→output ${timing(source.hostAcceptedToOutput)}; commit→frame ${timing(source.projectionCommitToFrame)}`,
    `    frame→post-paint ${timing(source.frameToPostPaint)}`,
    `    failed=${count(source.failedCount)}; timedOut=${count(source.timedOutCount)}; superseded=${count(source.correlationSupersededCount)}`,
    ...(source.timedOutCount > 0
      ? [`    timeouts after successor output=${count(source.timedOutAfterSuccessorOutputCount)}; without successor=${count(source.timedOutWithoutSuccessorCount)}`]
      : []),
  ];
}

/** Presentation of existing receipts only; no sampling or health verdict. */
export function formatPerformanceSummary(report, identity) {
  const lines = [
    "Dure input performance — one read-only snapshot",
    `App descriptor: channel=${label(identity.channel)} build=${label(identity.buildId)} generation=${label(identity.generation)}`,
    `Captured: ${capturedAt(report.generatedAtMs)}; completeness=${report.complete === true ? "complete" : report.complete === false ? "partial" : "unavailable"}`,
  ];
  const missing = report.missingWindowLabels;
  if (Array.isArray(missing) && missing.length > 0) {
    lines.push(`Missing windows (${missing.length}): ${missing.slice(0, MAX_SUMMARY_WINDOWS).map(label).join(", ")}${missing.length > MAX_SUMMARY_WINDOWS ? ", …" : ""}`);
  }
  for (const window of report.windows.slice(0, MAX_SUMMARY_WINDOWS)) {
    const loop = window.eventLoopLag;
    const loopSampleAge = Number.isSafeInteger(loop?.sampleCount) && loop.sampleCount > 0 &&
        Number.isFinite(loop.lastSampleAtMs) && loop.lastSampleAtMs >= 0 &&
        Number.isFinite(window.generatedAtMs) && window.generatedAtMs >= 0
      ? window.generatedAtMs - loop.lastSampleAtMs
      : null;
    const focus = loop?.focused === true ? "focused" : loop?.focused === false ? "unfocused" : "focus unavailable";
    const visibility = loop?.visible === true ? "visible" : loop?.visible === false ? "hidden" : "visibility unavailable";
    lines.push(
      "",
      `Window ${label(window.windowLabel)}: observed=${capturedAt(window.generatedAtMs)}`,
      `  Latest input age at capture=${milliseconds(window.latestSampleAgeMs)}; ${focus}, ${visibility}`,
      `  Event loop: ${timing({ count: loop?.sampleCount, p95: loop?.recentP95Ms })}; max=${milliseconds(loop?.sampleCount > 0 ? loop.recentMaxMs : undefined)}; latest sample age at capture=${milliseconds(loopSampleAge)}`,
      ...sourceLines("keydown", window.terminalInput?.bySource?.keydown),
      ...sourceLines("input", window.terminalInput?.bySource?.input),
    );
  }
  if (report.windows.length === 0) lines.push("No window observations available.");
  if (report.windows.length > MAX_SUMMARY_WINDOWS) {
    lines.push(`${report.windows.length - MAX_SUMMARY_WINDOWS} additional windows omitted from this summary.`);
  }
  lines.push(
    "",
    'Retained samples; "input" is an event source, not a language. Stage percentiles are not additive.',
    "Window focus/visibility is current at capture; event-loop and input timings are retained.",
    "Paint uses the existing frame/task probe. CPU and disk I/O are not sampled.",
    "A trace timeout is not proof that input was lost.",
    "Raw evidence: dure perf report --projection terminal-input --json",
  );
  return lines.join("\n");
}
