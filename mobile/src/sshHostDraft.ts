/**
 * The SSH host somebody types in, and what it takes to be one.
 *
 * Figma 3177:82034 asks for four things and no more: host, port, user and an
 * optional label. There is deliberately no host-key field — a fingerprint is
 * not something a person knows, and the screen that asked for one could not be
 * filled from a phone. The host is asked for its key instead, on save.
 *
 * Pure, and tested without a DOM or a phone: what makes a form saveable is the
 * one thing both the button's enabled state and the save path have to agree on.
 */

/** The default the port field shows and means when left empty. */
export const DEFAULT_SSH_PORT = 22;

/**
 * How the phone will get in.
 *
 * Three ways, and they are not three flavours of the same thing:
 *
 * - `device` makes a key here and leaves the person to install it. Saving
 *   proves the address answers and no more.
 * - `imported` uses a key the person already has, which the host already
 *   trusts — the only one that proves the whole way in on the first save.
 * - `password` is used once, to put this phone's key on the host, and is then
 *   dropped. It is never stored: this app's storage is plaintext and an
 *   account password opens far more than one box.
 */
export type SshHostAuth =
  | { readonly kind: "device" }
  | { readonly kind: "imported"; readonly privateKeyPem: string; readonly fileName: string }
  | { readonly kind: "password"; readonly password: string };

export interface SshHostForm {
  readonly host: string;
  readonly port: string;
  readonly username: string;
  readonly label: string;
  readonly auth: SshHostAuth;
}

export const EMPTY_SSH_HOST_FORM: SshHostForm = {
  host: "",
  port: "",
  username: "",
  label: "",
  auth: { kind: "device" },
};

export interface SshHostFields {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  /** What the list will call it. */
  readonly label: string;
  readonly auth: SshHostAuth;
}

/**
 * The form as fields, or nothing.
 *
 * `undefined` rather than a list of errors: the frame draws no error text per
 * field, only a disabled 저장 button, so "not yet" is the whole answer. What is
 * wrong is visible — the empty box is under the label that names it.
 */
export function sshHostFields(form: SshHostForm): SshHostFields | undefined {
  const host = form.host.trim();
  const username = form.username.trim();
  const label = form.label.trim();
  const portText = form.port.trim();
  if (host.length === 0 || username.length === 0) return undefined;
  // A chosen way in that has nothing in it is not a choice yet: an empty
  // password would be sent as one, and a key that failed to read is not a key.
  if (form.auth.kind === "password" && form.auth.password.length === 0) return undefined;
  if (form.auth.kind === "imported" && form.auth.privateKeyPem.trim().length === 0) {
    return undefined;
  }

  // An empty port is the placeholder's 22, which is what the field shows. Any
  // other text has to be a port — `Number(text) || 22` would turn both "0" and
  // "abc" into 22 silently, and the failure would surface much later as a
  // connection nobody could explain.
  let port = DEFAULT_SSH_PORT;
  if (portText.length > 0) {
    if (!/^\d+$/.test(portText)) return undefined;
    port = Number(portText);
    if (port < 1 || port > 65535) return undefined;
  }

  // The label is optional, and a host with no name is listed by its address —
  // which is what somebody who skipped the field would have typed anyway.
  return { host, port, username, label: label.length > 0 ? label : host, auth: form.auth };
}

/** Whether 저장 can be pressed. The frame's disabled state, as a question. */
export function sshHostFormComplete(form: SshHostForm): boolean {
  return sshHostFields(form) !== undefined;
}
