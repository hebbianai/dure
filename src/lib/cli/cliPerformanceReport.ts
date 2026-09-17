import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { readQaPerformanceEvidence } from "@/lib/qa/qaPerformanceEvidence";
import { qaRuntimeErrorLedger } from "@/lib/qa/qaRuntimeErrorLedger";
import {
  projectQaStatusRuntimeErrors,
  type QaStatusRuntimeErrorProjection,
} from "@/lib/qa/qaRuntimeErrorProjection";
import {
  collectWindowPerformanceDiagnostics,
  collectWindowTerminalInputDiagnostics,
  type MultiWindowPerformanceDiagnostics,
} from "@/lib/workspace/performance/windowPerformanceReport";
import type { MultiWindowTerminalInputDiagnostics } from "@/lib/workspace/performance/windowTerminalInputDiagnostics";

type ClaimCliRequest = (requestId: string) => Promise<boolean>;
type CollectWindowPerformance = () => Promise<MultiWindowPerformanceDiagnostics>;
type CollectWindowTerminalInput = () => Promise<MultiWindowTerminalInputDiagnostics>;

function performanceReportProjection(
  params: Record<string, unknown>,
): "full" | "terminal-input" | null {
  if (params.projection === undefined) return "full";
  return params.projection === "terminal-input" ? params.projection : null;
}

/** Main owns the CLI receipt; each WebView contributes its presentation facts. */
export async function handleCliPerformanceReport(
  requestId: string,
  params: Record<string, unknown>,
  claim: ClaimCliRequest,
  collectWindows: CollectWindowPerformance = collectWindowPerformanceDiagnostics,
  collectTerminalInput: CollectWindowTerminalInput =
    collectWindowTerminalInputDiagnostics,
) {
  if (getCurrentWebviewWindow().label !== "main") return null;
  if (!(await claim(requestId))) return null;
  try {
    const projection = performanceReportProjection(params);
    if (!projection) {
      return {
        ok: false,
        error: {
          code: "perf_report_projection_invalid",
          message: "performance report projection is invalid",
        },
      };
    }
    if (projection === "terminal-input") {
      return {
        ok: true,
        projection,
        report: await collectTerminalInput(),
        generatedAtMs: Date.now(),
      };
    }
    const [
      { summarizeWorkspacePerformance },
      { getWorkspacePerformanceSnapshot },
      { getFrameBudgetScheduler },
      { collectTerminalGeometryDiagnostics },
      multiWindow,
    ] = await Promise.all([
      import("@/lib/workspace/performance/workspacePerformanceReport"),
      import("@/lib/workspace/performance/workspacePerformance"),
      import("@/lib/scheduling/frameBudgetScheduler"),
      import("@/lib/terminal/geometry/terminalGeometryDiagnostics"),
      collectWindows(),
    ]);
    const qaStatus =
      (
        window as typeof window & {
          __DURE_WORKSPACE_PERFORMANCE_QA__?: QaStatusRuntimeErrorProjection;
        }
      ).__DURE_WORKSPACE_PERFORMANCE_QA__ ?? null;
    const runtimeErrors = qaRuntimeErrorLedger.snapshot(
      qaStatus?.runtimeErrorScope,
    );
		const frozenEvidence = readQaPerformanceEvidence(window);
		const report =
			frozenEvidence?.report ??
			summarizeWorkspacePerformance(getWorkspacePerformanceSnapshot());
    return {
      ok: true,
      terminalGeometry: collectTerminalGeometryDiagnostics(document),
			report,
			frameBudget:
				frozenEvidence?.frameBudget ??
				getFrameBudgetScheduler().getTelemetry(),
      multiWindow,
      qaStatus: projectQaStatusRuntimeErrors(qaStatus, runtimeErrors),
      generatedAtMs: Date.now(),
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "perf_report_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
