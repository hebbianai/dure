import type { GitCheckoutInstanceV1 } from "./git-checkout-identity.mjs";

interface SelectedCheckout {
  instance: GitCheckoutInstanceV1;
  branch: string;
  base_commit_sha: string;
}

export function validWorktree(value: unknown, options?: { allowUnresolvedBase?: boolean }): boolean;
export function selectedCheckoutReference(worktree: SelectedCheckout): {
  canonicalPath: string;
  gitCommonDir: string;
  gitDir: string;
  branch: string;
  head: string;
};
export function checkoutRegistrationMatches(worktree: SelectedCheckout, registration: unknown): boolean;
