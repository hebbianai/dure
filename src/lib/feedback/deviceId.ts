// A random, non-identifying id the feedback intake uses to rate-limit and
// group submissions from one install (crates/dure-feedback-intake's
// src/limits.rs keys its per-device hourly cap on this value). It is not a
// user identity — never send it anywhere else.
//
// Lives directly in localStorage, the same way recentSshHost.ts and
// paneCloseIntent.ts do, rather than inside the big persisted app store
// (appPrefsStoreSlice/uiPrefs): it is a single opaque value with no
// session/layout relationship, so it needs neither the store's multi-window
// write coordination nor its versioned migrations.
const DEVICE_ID_STORAGE_KEY = "agent-ide-feedback-device-id-v1";

/** RFC 4122 version-4 UUID built from `crypto.getRandomValues` (falling back
 *  to `Math.random()` only if that too is unavailable), used solely when
 *  `crypto.randomUUID()` itself is missing or throws — for example
 *  `randomUUID()` requires a secure context and throws in an insecure one.
 *  Same shape as a real UUID, so a caller never needs to know which path
 *  produced the id. */
function fallbackUuidV4(): string {
	const bytes = new Uint8Array(16);
	if (
		typeof crypto !== "undefined" &&
		typeof crypto.getRandomValues === "function"
	) {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i += 1) {
			bytes[i] = Math.floor(Math.random() * 256);
		}
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return [
		hex.slice(0, 4).join(""),
		hex.slice(4, 6).join(""),
		hex.slice(6, 8).join(""),
		hex.slice(8, 10).join(""),
		hex.slice(10, 16).join(""),
	].join("-");
}

/** Never throws — the one thing this module promises callers who catch
 *  nothing. Neither a missing `crypto.randomUUID` nor a throwing one should
 *  ever surface past `getOrCreateFeedbackDeviceId`. */
function generateFeedbackDeviceId(): string {
	try {
		if (
			typeof crypto !== "undefined" &&
			typeof crypto.randomUUID === "function"
		) {
			return crypto.randomUUID();
		}
	} catch {
		// Fall through to the manual UUID below.
	}
	return fallbackUuidV4();
}

/**
 * Returns this install's feedback device id, creating and persisting one on
 * first use.
 *
 * Read and write failures (private browsing, storage disabled or full) are
 * swallowed — the caller still gets a usable id for this call, just an
 * unpersisted one, which only means the intake sees a "new device" next run.
 */
export function getOrCreateFeedbackDeviceId(
	storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage,
): string {
	try {
		const existing = storage.getItem(DEVICE_ID_STORAGE_KEY);
		if (existing) return existing;
	} catch {
		// Fall through and mint an unpersisted id below.
	}
	const generated = generateFeedbackDeviceId();
	try {
		storage.setItem(DEVICE_ID_STORAGE_KEY, generated);
	} catch {
		// Best effort only — see the function comment above.
	}
	return generated;
}
