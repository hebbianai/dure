export interface ManagedSessionEnrollmentIdentity {
  sessionId: string;
  workspaceId: string;
  providerId: string;
  runnerPrincipal: string;
  runnerInstance: string;
  channelEpoch: string;
  hostInstanceId: string;
  terminalEpoch: string;
}

export interface ManagedSessionIntegrationReceipt {
  installRootRef: string;
  version: string;
  digest: string;
  channel: string;
  capabilities: string[];
}

export interface ManagedSessionEnrollmentPredecessor {
  dispatchId: string;
  generation: number;
}

export function managedSessionEnrollmentEvidence(
  session: ManagedSessionEnrollmentIdentity,
  integrationReceipt: ManagedSessionIntegrationReceipt,
  predecessor?: ManagedSessionEnrollmentPredecessor,
): string;
