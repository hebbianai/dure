export type RuntimeInteractionProfile = "native_cli" | "structured_protocol";
/** Retained observations, not permission to stop or wake an Agent. */
export interface AgentRuntimeIdleInspection {
  readonly schemaVersion: 1;
  readonly configuration: "enabled" | "disabled" | "invalid";
  readonly afterMs: number | null;
  readonly policyRevision?: number | null;
  readonly observedAtMs: number | null;
  readonly partial: boolean;
  readonly reasonCode: string | null;
  readonly reclamation?: RuntimeReclamation;
  readonly agents: readonly {
    readonly agentId: string;
    readonly state: string;
    readonly observedIdleMs: number | null;
    readonly reasonCode: string | null;
  }[];
}

export interface RuntimeReclamation {
  readonly schemaVersion: 1;
  readonly state: "available" | "unavailable";
  readonly observedAtMs: number | null;
  readonly scope: "latest_runtime_transition_admissions";
  readonly scanned: number;
  readonly limit: 64;
  readonly partial: boolean;
  readonly reasonCode: string | null;
  readonly entries: readonly {
    readonly agentId: string;
    readonly providerId: string;
    readonly operationId: string;
    readonly journalRevision: number;
    readonly stage: string;
    readonly stopState: string;
    readonly wakeState: string;
    readonly sourceSessionId: string | null;
    readonly requestedAtMs: number;
    readonly updatedAtMs: number;
    readonly reasonCode: string | null;
  }[];
}
export function parseRuntimeReclamation(value: unknown): RuntimeReclamation | undefined;

export function parseAgentRuntimeIdleInspection(
  value: unknown,
): AgentRuntimeIdleInspection | undefined;

export type RuntimeSourceStopPolicy = "preserve" | "discard";
export type ProviderPermissionMode = "default" | "auto_edit" | "skip_permissions";

export interface RuntimeLaunchSelectionTarget {
  readonly model: string | null;
  readonly effort: string | null;
  readonly permissionMode?: ProviderPermissionMode;
}

export interface RuntimeTransitionIntent<ExecutionProfile = unknown> {
  readonly agentId: string;
  readonly targetInteractionProfile: RuntimeInteractionProfile;
  readonly expectedSourceRevision?: number;
  readonly sourceStopPolicy?: RuntimeSourceStopPolicy;
  readonly targetExecutionProfile?: ExecutionProfile;
  readonly targetLaunchSelection?: RuntimeLaunchSelectionTarget;
}

export interface RuntimeReceiptEnvelope extends Record<string, unknown> {
  schemaVersion: 1;
  agentId: string;
  selectionRevision: number;
}

export interface RuntimeTransitionEnvelope extends Record<string, unknown> {
  schemaVersion: 1;
  receipt: RuntimeReceiptEnvelope;
}

export interface RuntimeProjectionContextV1<ProviderId extends string = string> {
  readonly schemaVersion: 1;
  readonly identity:
    | { readonly kind: "registered" }
    | { readonly kind: "checkpoint_bootstrap"; readonly runtimeWorkspaceId: string };
  readonly agent: {
    readonly agentId: string;
    readonly workspaceId: string;
    readonly providerId: ProviderId;
  };
  readonly workspace: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly rootPath: string;
  };
  readonly project: { readonly projectId: string; readonly rootPath: string };
}

export type RuntimeInspectionEnvelope =
  | (RuntimeTransitionEnvelope & { state: "stable"; projectionContext: RuntimeProjectionContextV1 })
  | (Record<string, unknown> & {
      schemaVersion: 1;
      state: "unmanaged";
      agentId: string;
    })
  | (Record<string, unknown> & {
      schemaVersion: 1;
      state: "closed";
      agentId: string;
      projectionContext?: RuntimeProjectionContextV1;
    })
  | (Record<string, unknown> & {
      schemaVersion: 1;
      state: "transitioning";
      agentId: string;
      projectionContext: RuntimeProjectionContextV1;
    });

export function parseAgentRuntimeTransitionEnvelope(
  value: unknown,
  agentId: string,
): RuntimeTransitionEnvelope | undefined;

export function parseAgentRuntimeInspectionEnvelope(
  value: unknown,
  agentId: string,
): RuntimeInspectionEnvelope | undefined;

export function agentRuntimeWakeTarget(
  value: unknown,
): { readonly operationId: string; readonly expectedJournalRevision: number } | undefined;

export interface RuntimeHibernateIntent {
  readonly agentId: string;
  readonly expectedSourceRevision: number;
}

export interface RuntimeWakeIntent {
  readonly agentId: string;
  readonly operationId: string;
  readonly expectedJournalRevision: number;
  /** A caller's equality guard, never replacement identity authority. */
  readonly expectedProviderConversationRef?: string;
}

export function agentRuntimeHibernateBody(
  intent: RuntimeHibernateIntent,
): (RuntimeHibernateIntent & { readonly schemaVersion: 1 }) | undefined;

export function agentRuntimeWakeBody(
  intent: RuntimeWakeIntent,
): (RuntimeWakeIntent & { readonly schemaVersion: 1 }) | undefined;

export function hasRequiredRuntimeFields(
  value: Record<string, unknown>,
  keys: readonly string[],
  ...presentOptional: readonly string[]
): boolean;

export function agentRuntimeTransitionBody<ExecutionProfile>(
  intent: RuntimeTransitionIntent<ExecutionProfile>,
): Record<string, unknown>;

export function runtimeLaunchSelectionBody(
  selection: RuntimeLaunchSelectionTarget,
): Record<string, unknown>;
