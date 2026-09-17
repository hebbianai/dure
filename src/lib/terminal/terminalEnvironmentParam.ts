// CLI `terminalEnv` 파라미터 검증 (순수) — cliServer에서 추출(랫칫).
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import type { TerminalEnvironment } from "@/types";

export function terminalEnvironmentParam(value: unknown): TerminalEnvironment | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new PaneCommandError("invalid_request", "terminalEnv must be an object");
  }
  const terminalEnv: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null && typeof entry !== "string") {
      throw new PaneCommandError(
        "invalid_request",
        `terminalEnv.${key} must be a string or null`,
      );
    }
    terminalEnv[key] = entry;
  }
  return terminalEnv as TerminalEnvironment;
}
