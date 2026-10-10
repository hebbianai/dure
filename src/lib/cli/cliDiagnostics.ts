import {
  appCompatibility,
  type AppCompatibility,
} from "@/lib/ipc";
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
) {
  return {
    ok: true as const,
    schemaVersion: 1 as const,
    generatedAtMs,
    compatibility,
    ...(webviewDiagnostics ? { webviewDiagnostics } : {}),
  };
}

export async function handleCliDiagnostics(
  requestId: string,
  claim: ClaimCliRequest,
  inspect: InspectCompatibility = () => appCompatibility(true),
  now: () => number = Date.now,
  inspectWebview: () => Promise<WebviewDiagnostics> = readWebviewDiagnostics,
) {
  if (!(await claim(requestId))) return null;
  try {
    const compatibility = await inspect();
    return buildCliDiagnosticsReceipt(compatibility, now(), await inspectWebview());
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
