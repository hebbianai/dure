// Quick-dispatch prompt assembly: attachments travel as files (the prompt
// cap is 16 KiB), so the delivered prompt references them by absolute path
// rather than inlining bytes.

import { buildPromptWithAttachments } from "@/lib/agents/attachmentPrompt";

export const MAX_QUICK_DISPATCH_PROMPT_BYTES = 16 * 1024;

/** Builds the prompt delivered to the spawned agent: trimmed task text,
 *  followed by one absolute-path read instruction per attachment. */
export function buildQuickDispatchPrompt(
	text: string,
	attachmentPaths: readonly string[],
): string {
	return buildPromptWithAttachments(text, attachmentPaths);
}

/** Byte length (not UTF-16 code units) for enforcing the 16 KiB prompt cap. */
export function quickDispatchPromptByteLength(prompt: string): number {
	return new TextEncoder().encode(prompt).length;
}
