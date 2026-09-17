export const ORCHESTRATION_API_VERSION: "dure.orchestration/v1";
export type OrchestrationRequest = {
  readonly apiVersion: typeof ORCHESTRATION_API_VERSION;
  readonly method: string;
  readonly body: object;
};
export function createOrchestrationRequest(input: { method: string; body: object }): OrchestrationRequest;
export function isOrchestrationResponse(value: unknown, method: string): value is {
  apiVersion: typeof ORCHESTRATION_API_VERSION;
  method: string;
  receipt: unknown;
};
