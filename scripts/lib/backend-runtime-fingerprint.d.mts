export interface BackendRuntimeInputs {
  sourceInputs: string[];
  artifactPrefixes: string[];
}

export function readBackendRuntimeInputs(repositoryRoot: string): BackendRuntimeInputs;
export function computeBackendRuntimeFingerprint(repositoryRoot: string): string;
export function tryBackendRuntimeFingerprint(repositoryRoot: string): string | null;
