export interface PromptAttachmentReference {
  readonly path: string;
  readonly fileName: string;
}
export function buildPromptWithAttachments(text: string, attachmentPaths: readonly string[]): string;
export function splitPromptAttachments(text: string): { readonly body: string; readonly attachments: readonly PromptAttachmentReference[] };
