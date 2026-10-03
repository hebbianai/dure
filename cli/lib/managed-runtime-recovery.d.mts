export interface RecoveryObservation {
  readonly state: string;
}

export class ManagedRuntimeRecoveryIncompleteError extends Error {
  readonly stage: "source" | "hibernate" | "wake";
  readonly observation: RecoveryObservation;
  constructor(stage: "source" | "hibernate" | "wake", observation: RecoveryObservation);
}

export function wakeManagedRuntime<Source extends RecoveryObservation>(
  source: Source,
  operations: {
    hibernate?: (source: Extract<Source, { state: "stable" }>) => Promise<Source>;
    wake: (source: Extract<Source, { state: "dormant" }>) => Promise<Source>;
  },
): Promise<Extract<Source, { state: "stable" }>>;
