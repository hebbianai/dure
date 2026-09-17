export interface PlainInteractiveSshDestination {
  host: string;
  user?: string;
  port?: number;
}

export function parsePlainInteractiveSsh(argv: readonly string[]):
  | { kind: "handoff"; destination: PlainInteractiveSshDestination }
  | { kind: "fallback"; reason: string };
