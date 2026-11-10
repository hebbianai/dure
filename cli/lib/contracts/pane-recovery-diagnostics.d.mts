export type PaneRecoveryDiagnosticStage = "exact_resume" | "lineage_wake";
export interface PaneRecoveryDiagnosticInput {
  stage: PaneRecoveryDiagnosticStage;
  code: string;
  agentId?: string;
}
export interface PaneRecoveryDiagnosticEvent extends PaneRecoveryDiagnosticInput {
  firstSeenMs: number;
  lastSeenMs: number;
  count: number;
}
export interface PaneRecoveryDiagnostics {
  schemaVersion: 1;
  state: "available" | "unavailable";
  events: PaneRecoveryDiagnosticEvent[];
}
export const PANE_RECOVERY_DIAGNOSTIC_STAGES: readonly PaneRecoveryDiagnosticStage[];
export const PANE_RECOVERY_UNCLASSIFIED_CODE: "unclassified";
export const MAX_PANE_RECOVERY_DIAGNOSTIC_EVENTS: 64;
export function isPaneRecoveryDiagnosticCode(value: unknown): value is string;
export function parsePaneRecoveryDiagnostics(value: unknown): PaneRecoveryDiagnostics | null;
