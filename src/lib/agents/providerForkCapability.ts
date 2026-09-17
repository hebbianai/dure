import { PROVIDERS, type Provider } from "@/types";

/** A same-provider worktree fork may inherit history only when the adapter
 * creates an independent provider-native conversation. Exact resume alone is
 * not a fork and would alias two panes to one mutable conversation identity. */
export function providerForkInheritsConversation(
  sourceProvider: Provider,
  targetProvider: Provider,
): boolean {
  return (
    sourceProvider === targetProvider &&
    PROVIDERS[targetProvider].conversationFork !== undefined
  );
}
