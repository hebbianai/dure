/// How one accepted PTY write changes the Host's unsubmitted-input authority.
///
/// The PTY writer owns byte delivery. This separate semantic fact prevents
/// terminal control traffic, and keys that cannot insert text, from becoming a
/// user draft merely because the terminal encoded them as bytes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ControllerInputEffect {
    /// May put text into a line editor. Erasing is not observable, so it
    /// holds the draft until the next accepted submit.
    DraftCapable,
    /// A keypress that moves the cursor, deletes, switches a mode or
    /// interrupts, but cannot insert text. It neither creates nor clears a
    /// draft, and a person still waits for its echo as for typing.
    #[cfg(feature = "terminal-state-stream")]
    NonInsertingKey,
    /// Terminal control traffic such as focus and pointer reports.
    #[cfg(feature = "terminal-state-stream")]
    ControlOnly,
}

impl ControllerInputEffect {
    #[must_use]
    pub(crate) fn retains_pending_draft(self) -> bool {
        match self {
            Self::DraftCapable => true,
            #[cfg(feature = "terminal-state-stream")]
            Self::NonInsertingKey | Self::ControlOnly => false,
        }
    }

    /// Whether a person waits for this write's echo, so the next output is
    /// published without the projection throttle.
    #[cfg(feature = "terminal-state-stream")]
    #[must_use]
    pub(crate) fn awaits_echo(self) -> bool {
        match self {
            Self::DraftCapable | Self::NonInsertingKey => true,
            Self::ControlOnly => false,
        }
    }

    /// Parses one already-validated structured intent into its Host-side draft
    /// effect. Resize has no PTY-input effect and is therefore not representable
    /// by the return value.
    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn from_non_resize_structured(
        intent: &terminal_state_protocol::input_intent::Intent,
    ) -> Option<Self> {
        use terminal_state_protocol::input_intent;

        match intent {
            input_intent::Intent::Key(key) if key_cannot_insert_text(key) => {
                // It cannot create a draft, and deliberately preserves any
                // prior one: an erase is not observable.
                Some(Self::NonInsertingKey)
            }
            input_intent::Intent::Text(_)
            | input_intent::Intent::AgentPrompt(_)
            | input_intent::Intent::DraftGuarded(_)
            | input_intent::Intent::Key(_) => Some(Self::DraftCapable),
            input_intent::Intent::Paste(paste) if !paste.utf8.is_empty() => {
                Some(Self::DraftCapable)
            }
            input_intent::Intent::Paste(_)
            | input_intent::Intent::Pointer(_)
            | input_intent::Intent::Focus(_) => Some(Self::ControlOnly),
            input_intent::Intent::Resize(_) => None,
        }
    }
}

/// `KeyInputIntent::modifiers` bits. Caps lock (bit 4) and num lock (bit 5)
/// do not change the keys classified here.
#[cfg(feature = "terminal-state-stream")]
const SHIFT: u32 = 1;
#[cfg(feature = "terminal-state-stream")]
const CONTROL: u32 = 1 << 2;
#[cfg(feature = "terminal-state-stream")]
const CHORD: u32 = 0x0f;

/// Whether a structured key can never put text into a line editor: Escape,
/// Shift+Tab, Left/Right, Home/End, Backspace/Delete, Insert, F1-F24 and
/// Ctrl+C. The Host encodes the physical code, so a named key must also be
/// its own code, or carry none (software keyboards). Alt and Meta chords
/// stay draft-capable because line editors bind them to word commands and
/// yanks. Tab completes, Up/Down and PageUp/PageDown can recall history, and
/// other Ctrl letters can yank, paste or accept a search, so they stay too.
#[cfg(feature = "terminal-state-stream")]
fn key_cannot_insert_text(key: &terminal_state_protocol::KeyInputIntent) -> bool {
    let chord = key.modifiers & CHORD;
    let named = key.code.is_empty() || key.code == key.key;
    let shift_or_control_only = chord & !(SHIFT | CONTROL) == 0;
    match key.key.as_str() {
        // Shift+Insert pastes in PSReadLine and many terminals.
        "Escape" | "Insert" => named && chord == 0,
        "Tab" => named && chord == SHIFT,
        "ArrowLeft" | "ArrowRight" | "Home" | "End" | "Backspace" | "Delete" => {
            named && shift_or_control_only
        }
        "c" | "C" => key.code == "KeyC" && chord == CONTROL,
        name => named && shift_or_control_only && is_function_key(name),
    }
}

/// Exact DOM names "F1" through "F24", without a sign or leading zero.
#[cfg(feature = "terminal-state-stream")]
fn is_function_key(name: &str) -> bool {
    name.strip_prefix('F')
        .and_then(|number| {
            number
                .parse::<u8>()
                .ok()
                .filter(|parsed| parsed.to_string() == number)
        })
        .is_some_and(|number| (1..=24).contains(&number))
}

#[cfg(all(test, feature = "terminal-state-stream"))]
mod tests {
    use super::*;
    use terminal_state_protocol::{
        FocusInputIntent, KeyInputIntent, PasteInputIntent, PointerInputIntent, ResizeInputIntent,
        TextInputIntent, input_intent,
    };

    #[test]
    fn only_draft_capable_structured_intents_retain_user_input_authority() {
        assert_eq!(
            ControllerInputEffect::from_non_resize_structured(&input_intent::Intent::Text(
                TextInputIntent {
                    utf8: b"draft".to_vec()
                },
            )),
            Some(ControllerInputEffect::DraftCapable)
        );
        assert_eq!(
            ControllerInputEffect::from_non_resize_structured(&input_intent::Intent::Paste(
                PasteInputIntent::default(),
            )),
            Some(ControllerInputEffect::ControlOnly)
        );
        assert_eq!(
            ControllerInputEffect::from_non_resize_structured(&input_intent::Intent::Focus(
                FocusInputIntent { focused: false },
            )),
            Some(ControllerInputEffect::ControlOnly)
        );
        assert_eq!(
            ControllerInputEffect::from_non_resize_structured(&input_intent::Intent::Pointer(
                PointerInputIntent::default(),
            )),
            Some(ControllerInputEffect::ControlOnly)
        );
        assert_eq!(
            ControllerInputEffect::from_non_resize_structured(&input_intent::Intent::Resize(
                ResizeInputIntent::default(),
            )),
            None
        );
    }

    fn key_effect(key: &str, code: &str, modifiers: u32) -> ControllerInputEffect {
        ControllerInputEffect::from_non_resize_structured(&input_intent::Intent::Key(
            KeyInputIntent {
                key: key.into(),
                code: code.into(),
                modifiers,
                repeat: false,
            },
        ))
        .unwrap()
    }

    #[test]
    fn only_keys_that_cannot_insert_text_skip_the_draft() {
        const ALT: u32 = 1 << 1;
        const META: u32 = 1 << 3;
        const CAPS_LOCK: u32 = 1 << 4;
        const NUM_LOCK: u32 = 1 << 5;
        for (key, code, modifiers) in [
            ("Escape", "Escape", 0),
            ("Escape", "", NUM_LOCK),
            ("Tab", "Tab", SHIFT),
            ("Tab", "Tab", SHIFT | CAPS_LOCK),
            ("ArrowLeft", "ArrowLeft", 0),
            ("ArrowRight", "ArrowRight", SHIFT | CONTROL),
            ("Home", "Home", SHIFT),
            ("End", "", 0),
            ("Backspace", "Backspace", 0),
            ("Backspace", "Backspace", CONTROL),
            ("Delete", "Delete", 0),
            ("Insert", "Insert", 0),
            ("F1", "F1", 0),
            ("F24", "F24", CONTROL),
            ("c", "KeyC", CONTROL),
            ("C", "KeyC", CONTROL | CAPS_LOCK),
        ] {
            assert_eq!(
                key_effect(key, code, modifiers),
                ControllerInputEffect::NonInsertingKey,
                "{key}/{code}/{modifiers:#x}"
            );
        }
        for (key, code, modifiers) in [
            ("a", "KeyA", 0),
            ("1", "Digit1", 0),
            ("Enter", "Enter", 0),
            ("Tab", "Tab", 0),
            ("Tab", "Tab", SHIFT | CONTROL),
            ("ArrowUp", "ArrowUp", 0),
            ("ArrowDown", "ArrowDown", 0),
            ("PageUp", "PageUp", 0),
            ("PageDown", "PageDown", 0),
            ("Escape", "Escape", ALT),
            ("ArrowLeft", "ArrowLeft", ALT),
            ("Backspace", "Backspace", META),
            ("Insert", "Insert", SHIFT),
            ("F1", "F1", ALT),
            ("F0", "F0", 0),
            ("F25", "F25", 0),
            ("F01", "F01", 0),
            ("F+1", "F+1", 0),
            ("c", "KeyC", CONTROL | SHIFT),
            ("c", "KeyC", CONTROL | ALT),
            ("c", "KeyI", CONTROL),
            ("j", "KeyC", CONTROL),
            ("c", "", CONTROL),
            ("r", "KeyR", CONTROL),
            ("y", "KeyY", CONTROL),
            ("v", "KeyV", CONTROL),
            // A printable key text with a navigation code is still text.
            ("a", "ArrowLeft", 0),
            ("ArrowLeft", "Numpad4", 0),
            ("Unidentified", "", 0),
        ] {
            assert_eq!(
                key_effect(key, code, modifiers),
                ControllerInputEffect::DraftCapable,
                "{key}/{code}/{modifiers:#x}"
            );
        }
    }

    #[test]
    fn non_inserting_keys_still_await_their_echo() {
        assert!(ControllerInputEffect::DraftCapable.awaits_echo());
        assert!(ControllerInputEffect::NonInsertingKey.awaits_echo());
        assert!(!ControllerInputEffect::ControlOnly.awaits_echo());
        assert!(!ControllerInputEffect::NonInsertingKey.retains_pending_draft());
    }
}
