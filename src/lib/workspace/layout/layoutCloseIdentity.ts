import {
  isTerminalPaneBindingV1,
  type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { normalizePersistedPaneLayout } from "@/lib/workspace/layout/persistedPaneLayout";

export interface ExactPaneBindingSnapshot {
  sessionId: string | null;
  binding: TerminalPaneBindingV1 | null;
  paramsRevision: string;
}

export function exactLayoutRevision(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "<undefined>" : encoded;
}

export function persistedLayoutRevision(value: unknown): string {
  return exactLayoutRevision(normalizePersistedPaneLayout(value));
}

export function matchesPersistedLayoutRevision(
  value: unknown,
  expectedValue: unknown,
  expectedRevision: string,
): boolean {
  return (
    (exactLayoutRevision(expectedValue) === expectedRevision ||
      persistedLayoutRevision(expectedValue) === expectedRevision) &&
    persistedLayoutRevision(value) === persistedLayoutRevision(expectedValue)
  );
}

export function exactPaneBindingSnapshot(
  paramsValue: unknown,
): ExactPaneBindingSnapshot {
  const params =
    paramsValue && typeof paramsValue === "object"
      ? (paramsValue as Record<string, unknown>)
      : {};
  return {
    sessionId:
      typeof params.sessionId === "string" ? params.sessionId : null,
    binding: isTerminalPaneBindingV1(params.binding) ? params.binding : null,
    paramsRevision: exactLayoutRevision(paramsValue),
  };
}

export function matchesExactPaneBinding(
  paramsValue: unknown,
  expected: ExactPaneBindingSnapshot,
): boolean {
  const current = exactPaneBindingSnapshot(paramsValue);
  return (
    current.sessionId === expected.sessionId &&
    exactLayoutRevision(current.binding) ===
      exactLayoutRevision(expected.binding) &&
    current.paramsRevision === expected.paramsRevision
  );
}

export function isExactPaneBindingSnapshot(
  value: unknown,
): value is ExactPaneBindingSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ExactPaneBindingSnapshot>;
  return (
    (snapshot.sessionId === null ||
      typeof snapshot.sessionId === "string") &&
    typeof snapshot.paramsRevision === "string" &&
    (snapshot.binding === null ||
      isTerminalPaneBindingV1(snapshot.binding))
  );
}
