// Whether the user's last input to a document was the keyboard or a pointer.
//
// `:focus-visible` looked like the engine's own answer, and in Chromium and in
// Playwright's WebKit it is: focus a script moves after a click does not match.
// The app's WKWebView disagrees — a dialog opened by mouse handed its first
// control a focus ring (owner report 2026-09-18, the Connections dialog) — so
// focus the user never moved cannot be told apart by asking the engine. The
// input events themselves can: every webview delivers them the same way.
//
// Capture-phase listeners on the document, so a handler that stops a press
// from bubbling (pane chrome does) still counts. Each Tauri window runs its
// own copy of the app against its own document, tracked from import; any
// other document is tracked from the first time it is asked about.

// A key, or null for a pointer press.
const lastInputs = new WeakMap<Document, string | null>();

// Held on the way to a click (⌘-click, shift-click): not keyboard use.
const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift"]);

// The keys that walk focus from one control to the next: Tab everywhere, the
// rest inside toolbars, tab lists and radio groups.
const FOCUS_KEYS = new Set([
	"Tab",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
]);

/** Start listening to `doc`. The app's own document is tracked from import. */
export function trackInputModality(doc: Document) {
	if (lastInputs.has(doc)) return;
	// Nothing seen yet: assume the keyboard, which keeps focus handling as the
	// platform defines it until a real press says otherwise.
	lastInputs.set(doc, "");
	doc.addEventListener(
		"keydown",
		(event) => {
			if (!MODIFIER_KEYS.has(event.key)) lastInputs.set(doc, event.key);
		},
		true,
	);
	doc.addEventListener("pointerdown", () => lastInputs.set(doc, null), true);
}

if (typeof document !== "undefined") trackInputModality(document);

/** True when the last thing the user did in `doc` was press a key. */
export function lastInputWasKeyboard(doc: Document): boolean {
	trackInputModality(doc);
	return lastInputs.get(doc) !== null;
}

/**
 * True when the user's last input was a key that moves focus. Narrower than
 * keyboard use on purpose: Enter that opens a dialog and Escape that closes
 * one also move focus, but the user did not walk to where it landed.
 */
export function lastInputMovedFocus(doc: Document): boolean {
	trackInputModality(doc);
	return FOCUS_KEYS.has(lastInputs.get(doc) ?? "");
}
