import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { formatPerformanceSummary } from "../cli/lib/performance-report.mjs";
import { scriptTestEnvironment } from "./lib/script-test-environment.mjs";

const cliPath = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const fixtures = [];
const capability = "performance_report.terminal_input_v1";
const capturedAt = 1_788_681_602_513;

afterEach(async () => {
  for (const { server, appHome } of fixtures.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
    rmSync(appHome, { recursive: true, force: true });
  }
});

function stats(count, median, p95, max = p95) {
  return { count, median, p95, max };
}

function source(count, echoP95) {
  return {
    completedCount: count,
    inputToEchoPaint: stats(count, 39, echoP95, 342),
    dispatchToTransportConfirmation: stats(count, 4, 16),
    transportConfirmationToHostReceipt: stats(count, 0, 40),
    hostAcceptedToOutput: stats(count, 1.452, 28.871),
    projectionCommitToFrame: stats(count, 81, 150),
    frameToPostPaint: stats(count, 5, 16),
    failedCount: 0,
    timedOutCount: 0,
    correlationSupersededCount: 3,
  };
}

function receipt() {
  return {
    ok: true,
    projection: "terminal-input",
    generatedAtMs: capturedAt,
    report: {
      schemaVersion: 1,
      projection: "terminal-input",
      complete: true,
      expectedWindowLabels: ["main"],
      missingWindowLabels: [],
      windows: [{
        windowLabel: "main",
        generatedAtMs: capturedAt - 20,
        latestSampleAgeMs: 7_638,
        eventLoopLag: {
          focused: true,
          visible: true,
          lastSampleAtMs: capturedAt - 120,
          sampleCount: 64,
          recentP95Ms: 58,
          recentMaxMs: 120,
        },
        terminalInput: {
          bySource: { input: source(78, 223), keydown: source(39, 219) },
          recent: [{ terminalId: "private-pane-not-for-summary" }],
        },
      }],
    },
  };
}

async function fixture(payload, capabilities = [capability], status = 200) {
  const requests = [];
  const appHome = mkdtempSync(join(tmpdir(), "dure-cli-performance-"));
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      });
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  fixtures.push({ appHome, server });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(appHome, "server.json"), JSON.stringify({
    port: server.address().port,
    token: "private-fixture-token",
    reportToken: "private-report-token",
    channel: "fixture",
    buildId: "0.1.4+fixture-sha",
    generation: "fixture-generation",
    capabilities,
  }));
  return {
    requests,
    run: (args = ["perf", "summary"]) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        env: {
          ...scriptTestEnvironment(),
          DURE_HOME: appHome,
          DURE_APP_CHANNEL: "stable",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    }),
  };
}

describe("performance summary through the real CLI", () => {
  it("reads one existing input report and separates timing sources without private data", async () => {
    const app = await fixture(receipt());
    const result = await app.run();

    expect(app.requests).toEqual([{
      method: "POST",
      path: "/perf/report",
      authorization: "Bearer private-fixture-token",
      body: { projection: "terminal-input" },
    }]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("0.1.4+fixture-sha");
    expect(result.stdout).toContain("fixture-generation");
    expect(result.stdout).toContain(new Date(capturedAt).toISOString());
    expect(result.stdout).toContain("7638ms");
    expect(result.stdout).toMatch(/input[^\n]*223/);
    expect(result.stdout).toMatch(/keydown[^\n]*219/);
    expect(result.stdout).toContain("28.871");
    expect(result.stdout).toContain("150");
    expect(result.stdout).not.toContain("private-");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(2_500);
  });

  it("ages retained event-loop samples across captures without resampling", async () => {
    // Timestamp shape from #164's two Inspector-close receipts; no live request.
    const payload = receipt();
    const window = payload.report.windows[0];
    Object.assign(window.eventLoopLag, {
      focused: false,
      lastSampleAtMs: 1_788_764_353_784,
      recentP95Ms: 6,
      recentMaxMs: 177,
    });
    const app = await fixture(payload);
    for (const [windowCapture, inputAge, loopAge] of [
      [1_788_764_398_780, 57_011, 44_996],
      [1_788_764_543_217, 201_450, 189_433],
    ]) {
      window.generatedAtMs = windowCapture;
      window.latestSampleAgeMs = inputAge;
      payload.generatedAtMs = windowCapture + 30;
      const result = await app.run();

      expect(result).toMatchObject({ code: 0, stderr: "" });
      const loopLine = result.stdout.split("\n").find((line) => line.includes("Event loop:"));
      expect(loopLine).toContain(`latest sample age at capture=${loopAge}ms`);
      expect(loopLine).toContain("p95=6ms (n=64); max=177ms");
      expect(result.stdout).toContain(`input age at capture=${inputAge}ms; unfocused, visible`);
    }
    expect(app.requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: "POST", path: "/perf/report", body: { projection: "terminal-input" } },
      { method: "POST", path: "/perf/report", body: { projection: "terminal-input" } },
    ]);
  });

  it("uses each window capture for event-loop age and preserves a measured zero age", () => {
    const report = receipt().report;
    report.generatedAtMs = capturedAt + 5_000;
    report.windows.push({
      ...report.windows[0],
      windowLabel: "floating",
      generatedAtMs: capturedAt - 2_000,
      eventLoopLag: { ...report.windows[0].eventLoopLag, lastSampleAtMs: capturedAt - 2_000 },
    });
    const lines = formatPerformanceSummary(report, {}).split("\n").filter((line) => line.includes("Event loop:"));

    expect(lines[0]).toContain("latest sample age at capture=100ms");
    expect(lines[1]).toContain("latest sample age at capture=0ms");
  });

  it.each([
    { lastSampleAtMs: null },
    { lastSampleAtMs: undefined },
    { lastSampleAtMs: -1 },
    { lastSampleAtMs: Number.NaN },
    { lastSampleAtMs: Number.POSITIVE_INFINITY },
    { lastSampleAtMs: String(capturedAt - 120) },
    { lastSampleAtMs: capturedAt },
    { sampleCount: 0 },
    { sampleCount: "64" },
    { sampleCount: 1.5 },
    { sampleCount: Number.POSITIVE_INFINITY },
  ])("does not invent event-loop freshness from unavailable evidence: %j", (override) => {
    const report = receipt().report;
    Object.assign(report.windows[0].eventLoopLag, override);
    const loopLine = formatPerformanceSummary(report, {}).split("\n").find((line) => line.includes("Event loop:"));

    expect(loopLine).toContain("latest sample age at capture=unavailable");
  });

  it.each([null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, String(capturedAt)])(
    "does not substitute the report or CLI clock for an invalid window capture: %s",
    (windowCapture) => {
      const report = receipt().report;
      report.generatedAtMs = capturedAt;
      report.windows[0].generatedAtMs = windowCapture;
      const loopLine = formatPerformanceSummary(report, {}).split("\n").find((line) => line.includes("Event loop:"));

      expect(loopLine).toContain("latest sample age at capture=unavailable");
    },
  );

  it("preserves missing windows, absent metrics and zero-sample observations", async () => {
    const payload = receipt();
    payload.report.complete = false;
    payload.report.missingWindowLabels = ["floating"];
    const window = payload.report.windows[0];
    window.latestSampleAgeMs = null;
    window.eventLoopLag = null;
    window.terminalInput.bySource = {
      keydown: { inputToEchoPaint: stats(0, 0, 0) },
    };
    const app = await fixture(payload);
    const result = await app.run();

    expect(result.code).toBe(0);
    expect(app.requests).toHaveLength(1);
    expect(result.stdout).toContain("completeness=partial");
    expect(result.stdout).toContain('Missing windows (1): "floating"');
    expect(result.stdout).toContain("input age at capture=unavailable");
    expect(result.stdout).toContain("focus unavailable, visibility unavailable");
    expect(result.stdout).toContain("latest sample age at capture=unavailable");
    expect(result.stdout).toContain("keydown: echo no samples (n=0)");
    expect(result.stdout).toContain("input: unavailable");
    expect(result.stdout).toContain("failed=unavailable");
    expect(result.stdout).not.toContain("p95=0ms");
  });

  it("preserves the raw narrow receipt when JSON is requested", async () => {
    const payload = receipt();
    const app = await fixture(payload);
    const result = await app.run(["perf", "summary", "--json"]);

    expect(result.code).toBe(0);
    expect(app.requests).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ...payload.report,
      generatedAtMs: capturedAt,
    });
  });

  it.each([
    { kind: "missing", capabilities: [] },
    { kind: "malformed", capabilities: capability },
  ])("rejects a $kind capability before sending a request", async ({ capabilities }) => {
    const app = await fixture(receipt(), capabilities);
    const result = await app.run();

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("does not advertise terminal-input");
    expect(app.requests).toHaveLength(0);
  });

  it("does not fall back to a full report when the app ignores the projection", async () => {
    const payload = receipt();
    delete payload.projection;
    const app = await fixture(payload);
    const result = await app.run();

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("did not honor the terminal-input projection");
    expect(app.requests).toHaveLength(1);
  });

  it("rejects an incompatible report without turning missing data into success", async () => {
    const payload = receipt();
    payload.report.schemaVersion = 2;
    const app = await fixture(payload);
    const result = await app.run();

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("incompatible terminal-input report");
    expect(app.requests).toHaveLength(1);
  });

  it("preserves an app refusal without retrying or emitting an empty success", async () => {
    const app = await fixture({
      ok: false,
      error: { code: "report_unavailable", message: "window did not answer" },
    }, [capability], 503);
    const result = await app.run();

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("window did not answer");
    expect(app.requests).toHaveLength(1);
  });

  it.each([false, true])("keeps unavailable pressure and measured zero in the full report (json=%s)", async (json) => {
    const payload = {
      ok: true,
      report: {
        sampleCount: 3,
        render: null,
        workspaceCache: {
          backgroundPresentation: {
            terminalSurfaces: 0,
            recentWriterSurfaces: null,
            bufferedBytes: null,
            maxRecentWriteLatencyMs: null,
          },
        },
      },
      frameBudget: { catchup: { unitsRun: 2 } },
      multiWindow: { complete: false, render: null },
      terminalGeometry: { complete: true },
      generatedAtMs: capturedAt,
    };
    const app = await fixture(payload);
    const result = await app.run(["perf", "report", ...(json ? ["--json"] : [])]);

    expect(result.code).toBe(0);
    expect(app.requests).toHaveLength(1);
    expect(app.requests[0].body).toEqual({});
    expect(JSON.parse(result.stdout)).toEqual({
      ...payload.report,
      frameBudget: payload.frameBudget,
      multiWindow: payload.multiWindow,
      terminalGeometry: payload.terminalGeometry,
      generatedAtMs: capturedAt,
    });
  });

  it("bounds large summaries, escapes labels and makes omitted windows explicit", () => {
    const report = receipt().report;
    report.windows = Array.from({ length: 20 }, () => ({
      ...report.windows[0],
      windowLabel: `\u001b[31m${"x".repeat(1_000)}`,
    }));
    report.generatedAtMs = capturedAt;
    const output = formatPerformanceSummary(report, {});

    expect(output).toContain("12 additional windows omitted");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("x".repeat(257));
    expect(output).not.toContain("private-pane");
    expect(Buffer.byteLength(output)).toBeLessThan(15_000);
  });

  it("preserves timeout context without treating successor output as recovery", () => {
    const report = receipt().report;
    Object.assign(report.windows[0].terminalInput.bySource.keydown, {
      timedOutCount: 1,
      timedOutAfterSuccessorOutputCount: 1,
      timedOutWithoutSuccessorCount: 0,
    });
    const output = formatPerformanceSummary(report, {});

    expect(output).toContain("timedOut=1");
    expect(output).toContain("timeouts after successor output=1; without successor=0");
    expect(output).not.toContain("recovered");
  });
});
