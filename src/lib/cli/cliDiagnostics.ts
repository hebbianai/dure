import {
  appCompatibility,
  type AppCompatibility,
} from "@/lib/ipc";
import {
  type PaneRecoveryDiagnostics,
  readPaneRecoveryDiagnostics,
} from "@/lib/ipc/paneRecoveryDiagnostics";
import {
  readWebviewDiagnostics,
  type WebviewDiagnostics,
} from "@/lib/ipc/webviewDiagnostics";

type ClaimCliRequest = (requestId: string) => Promise<boolean>;
type InspectCompatibility = () => Promise<AppCompatibility>;

export function buildCliDiagnosticsReceipt(
  compatibility: AppCompatibility,
  generatedAtMs: number,
  webviewDiagnostics?: WebviewDiagnostics,
  paneRecoveryDiagnostics?: PaneRecoveryDiagnostics,
) {
  return {
    ok: true as const,
    schemaVersion: 1 as const,
    generatedAtMs,
    compatibility,
    ...(webviewDiagnostics ? { webviewDiagnostics } : {}),
    ...(paneRecoveryDiagnostics ? { paneRecoveryDiagnostics } : {}),
  };
}

export async function handleCliDiagnostics(
  requestId: string,
  claim: ClaimCliRequest,
  inspect: InspectCompatibility = () => appCompatibility(true),
  now: () => number = Date.now,
  inspectWebview: () => Promise<WebviewDiagnostics> = readWebviewDiagnostics,
  inspectPaneRecovery: () => Promise<PaneRecoveryDiagnostics> = readPaneRecoveryDiagnostics,
) {
  if (!(await claim(requestId))) return null;
  try {
    const compatibility = await inspect();
    return buildCliDiagnosticsReceipt(
      compatibility,
      now(),
      await inspectWebview(),
      await inspectPaneRecovery(),
    );
  } catch (error) {
    return {
      ok: false as const,
      schemaVersion: 1 as const,
      error: {
        code: "app_diagnostics_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
