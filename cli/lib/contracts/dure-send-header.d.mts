export interface DureSendHeader {
  readonly agentName: string | null;
  readonly label: string | null;
  readonly body: string;
}
export function formatDureSendHeader(fields?: { readonly agentName?: string; readonly label?: string }): string;
export function splitDureSendHeader(text: string): DureSendHeader | null;
