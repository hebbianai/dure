/**
 * The per-host keys screen's state and transitions, without the DOM.
 *
 * What the screen shows is two facts from two owners: the host row (its label,
 * whether it came from pairing, which private slots are filled) and the
 * screen's own state (the public key read back so far, whether the copy
 * landed, the pasted drafts). `keysScreenModel` joins them once so the view
 * takes one model and app.ts only wires.
 *
 * The drafts are screen state rather than textarea contents because the
 * host check the detail screen fires can land after the person has moved on
 * to this screen and started pasting; that redraw rebuilds the tree, and a
 * textarea nobody recorded is a paste nobody sees again.
 */

import type { KeyRole } from "./ipc";

export interface HostKeysDraft {
  readonly attach: string;
  readonly list: string;
}

export const EMPTY_HOST_KEYS_DRAFT: HostKeysDraft = { attach: "", list: "" };

/**
 * Whether a pasted slot is worth sending.
 *
 * Only the shape every PEM shares: the Rust side is the authority on what a
 * key is, and it refuses an encrypted or malformed one with a reason the
 * banner repeats. The button just declines to send a public key line or a
 * stray paste as a private key.
 */
export function canSave(draft: string): boolean {
  return draft.trim().startsWith("-----BEGIN");
}

export function withDraft(drafts: HostKeysDraft, role: KeyRole, text: string): HostKeysDraft {
  return { ...drafts, [role]: text };
}

export function clearDraft(drafts: HostKeysDraft, role: KeyRole): HostKeysDraft {
  return withDraft(drafts, role, "");
}

/** What the screen's own state holds between redraws. */
export interface HostKeysScreenState {
  readonly publicKey?: string;
  readonly publicKeyFailure?: string;
  readonly copied?: boolean;
  readonly drafts: HostKeysDraft;
}

export interface HostKeysModel {
  readonly label: string;
  readonly paired: boolean;
  /** The `authorized_keys` line, once read back; absent while loading or after a failure. */
  readonly publicKey?: string;
  readonly publicKeyFailure?: string;
  readonly copied: boolean;
  readonly drafts: HostKeysDraft;
  readonly stored: { readonly attach: boolean; readonly list: boolean };
}

export function keysScreenModel(
  server: {
    readonly label: string;
    readonly paired: boolean;
    readonly has_attach_key: boolean;
    readonly has_list_key: boolean;
  },
  screen: HostKeysScreenState,
): HostKeysModel {
  return {
    label: server.label,
    paired: server.paired,
    publicKey: screen.publicKey,
    publicKeyFailure: screen.publicKeyFailure,
    copied: screen.copied === true,
    drafts: screen.drafts,
    stored: { attach: server.has_attach_key, list: server.has_list_key },
  };
}
