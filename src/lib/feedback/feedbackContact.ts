// The feedback dialog's "contact" field remembers its last value so a person
// who sends more than one report doesn't retype an email address every time.
// It is a display convenience, not identity data — never sent anywhere on
// its own.
//
// Lives directly in localStorage like deviceId.ts and recentSshHost.ts: a
// single opaque string with no session/layout relationship, so it needs
// neither the big persisted store's multi-window write coordination nor its
// versioned migrations.
const CONTACT_STORAGE_KEY = "agent-ide-feedback-contact-v1";

/** Read and write failures (private browsing, storage disabled or full) are
 *  swallowed — losing the remembered value only means the next dialog opens
 *  with an empty contact field, never that sending is blocked. */
export function readRememberedFeedbackContact(): string {
	try {
		return window.localStorage.getItem(CONTACT_STORAGE_KEY) ?? "";
	} catch {
		return "";
	}
}

export function rememberFeedbackContact(value: string): void {
	try {
		window.localStorage.setItem(CONTACT_STORAGE_KEY, value);
	} catch {
		// Best effort only — see the function comment above.
	}
}
