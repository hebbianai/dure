export type CanonicalAgentStopStatusV1 =
  | "planned"
  | "superseded"
  | "authorized"
  | "succeeded"
  | "workspace_preserved"
  | "source_retained"
  | "workspace_replaced";

export interface CanonicalAgentStopReceiptV1 {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly spawnOperationId: string;
  readonly agentId: string;
  readonly planToken: string;
  readonly journalRevision: number;
  readonly workspaceDisposition: "preserve" | "remove_owned";
  readonly status: CanonicalAgentStopStatusV1;
}

export type CanonicalAgentStopProjectionV1 =
  | { readonly kind: "absent" }
  | { readonly kind: "pending_confirmation"; readonly receipt: CanonicalAgentStopReceiptV1 }
  | { readonly kind: "resume_apply"; readonly receipt: CanonicalAgentStopReceiptV1 }
  | { readonly kind: "forget_presentation"; readonly receipt: CanonicalAgentStopReceiptV1 }
  | { readonly kind: "source_retained"; readonly receipt: CanonicalAgentStopReceiptV1 };

export function parseCanonicalAgentStopResultV1(
  value: unknown,
  expectedSpawnOperationId: string,
): CanonicalAgentStopReceiptV1 | null | undefined;
export function projectCanonicalAgentStopV1(
  receipt: CanonicalAgentStopReceiptV1 | null,
): CanonicalAgentStopProjectionV1;
export function canonicalAgentStopApplyRevisionV1(receipt: CanonicalAgentStopReceiptV1): number | null;
