// Data contract for design-coverage.json.
// Erasable-syntax TypeScript only: this tree runs directly under the pinned Node's
// type stripping — no enums, no namespaces, no parameter properties.

export const ENVELOPE_SCHEMA_VERSION = 2;
export const BASELINE_SCHEMA_VERSION = 2;

export type StateName = "ideal" | "empty" | "loading" | "error" | "partial";

// Mockup filenames use `default.html` for the ideal state.
export const STATE_FILENAMES: Record<string, StateName> = {
  default: "ideal",
  empty: "empty",
  loading: "loading",
  error: "error",
  partial: "partial",
};

export interface SurfaceCandidate {
  /** `surface:<cluster>/<Name>` — root segment omitted while there is one scan root. */
  id: string;
  cluster: string;
  name: string;
  /** repo-relative source file */
  file: string;
  /** anchorIds that matched this candidate */
  anchors: string[];
  surfaceKind: string;
}

export type TokenScope = "root" | "dark" | "theme-inline" | "other";

export interface TokenDeclaration {
  name: string;
  scope: TokenScope;
  value: string;
}

export interface TokenInventory {
  /** unique custom-property names declared in the token source */
  names: string[];
  declarations: TokenDeclaration[];
  /** exact token-name string literals found in the runtime theme module */
  runtimeNames: string[];
  /** fail-closed scanner diagnostics (e.g. css-tree Raw recovery swallowing declarations) */
  scanErrors: CoverageError[];
}

export interface DocumentedToken {
  name: string;
  light: string | null;
  dark: string | null;
}

export interface MockupEvidence {
  path: string;
  surfaceLocalId: string;
  state: StateName;
  vars: string[];
}

/** The mechanically compared token table, not a per-screen description. */
export interface EvidenceRef {
  kind: "spec";
  tier: "gating";
  path: string;
}

export interface CoverageItem {
  id: string;
  axis: "token";
  verdict: "covered" | "uncovered";
  evidence: EvidenceRef[];
  detail: Record<string, unknown>;
}

export interface CoverageError {
  code:
    | "orphan-evidence"
    | "id-collision"
    | "unresolved-var"
    | "invalid-baseline"
    | "invalid-overrides"
    | "scan-error"
    | "raw-color-regression";
  message: string;
  file?: string;
}

export interface Envelope {
  schemaVersion: number;
  generatedAt: string;
  sourceCommit: string;
  dirty: boolean;
  axes: { token: { items: CoverageItem[] } };
  surfaces: SurfaceCandidate[];
  mockups: MockupEvidence[];
  aliases: Record<string, string>;
  anchors: Record<string, number>;
  excluded: { id: string; reason: string }[];
  errors: CoverageError[];
  tokensDtcg: Record<string, unknown>;
  rawColors: {
    total: number;
    files: Record<string, number>;
    stale: { file: string; allowed: number; actual: number }[];
  };
}

export interface Baseline {
  schemaVersion: number;
  uncovered: string[];
}

export interface Overrides {
  schemaVersion: number;
  surface: {
    exclude: Record<string, string>;
    merge: Record<string, { members: string[] }>;
    renamedFrom: Record<string, string>;
  };
  token: {
    exclude: Record<string, string>;
  };
}
