import {
  appCompatibility,
  type AppCompatibility,
} from "@/lib/ipc";

type ClaimCliRequest = (requestId: string) => Promise<boolean>;
type InspectCompatibility = () => Promise<AppCompatibility>;

export function buildCliDiagnosticsReceipt(
  compatibility: AppCompatibility,
  generatedAtMs: number,
) {
  return {
    ok: true as const,
    schemaVersion: 1 as const,
    generatedAtMs,
    compatibility,
  };
}

export async function handleCliDiagnostics(
  requestId: string,
  claim: ClaimCliRequest,
  inspect: InspectCompatibility = () => appCompatibility(true),
  now: () => number = Date.now,
) {
  if (!(await claim(requestId))) return null;
  try {
    return buildCliDiagnosticsReceipt(await inspect(), now());
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
