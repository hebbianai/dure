use hmux_host::terminal_replay::ControllerDraftEdit;

/// How one accepted PTY write changes the Host's unsubmitted-input authority.
///
/// The PTY writer owns byte delivery. This separate semantic fact prevents
/// terminal control traffic, and keys that cannot insert text, from becoming a
/// user draft merely because the terminal encoded them as bytes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ControllerInputEffect {
    /// May put text into a line editor. The written bytes decide what the
    /// Host records: characters it can count, a submit, or input it cannot
    /// follow, which holds the draft until the next accepted submit.
    DraftCapable,
    /// Backspace: erases the character before the cursor and cannot insert
    /// text. The Host counts it against the characters it wrote.
    #[cfg(feature = "terminal-state-stream")]
    ErasesCharacter,
    /// A keypress that moves the cursor into the line or erases a word. It
    /// changes an existing draft in a way the Host cannot count, but cannot
    /// create one.
    #[cfg(feature = "terminal-state-stream")]
    EditsDraft,
    /// A keypress that deletes forward, switches a mode, interrupts or moves
    /// the cursor where it already stands, but cannot insert text. It neither
    /// creates nor clears a draft, and a person still waits for its echo as
    /// for typing.
    #[cfg(feature = "terminal-state-stream")]
    NonInsertingKey,
    /// Terminal control traffic such as focus and pointer reports.
    #[cfg(feature = "terminal-state-stream")]
    ControlOnly,
}

/// How the Host folds the bytes of one accepted write into its draft facts.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DraftFold {
    /// Scan the bytes: they may carry countable text, a submit or input the
    /// Host cannot follow.
    Bytes,
    /// Apply this one edit, whatever bytes the terminal encoded the key as.
    Edit(ControllerDraftEdit),
    /// Consume fresh-prompt authority only.
    WriteOnly,
}

impl ControllerInputEffect {
    #[must_use]
    pub(crate) fn draft_fold(self) -> DraftFold {
        match self {
            Self::DraftCapable => DraftFold::Bytes,
            #[cfg(feature = "terminal-state-stream")]
            Self::ErasesCharacter => DraftFold::Edit(ControllerDraftEdit::Erased(1)),
            #[cfg(feature = "terminal-state-stream")]
            Self::EditsDraft => DraftFold::Edit(ControllerDraftEdit::EditedUncounted),
            #[cfg(feature = "terminal-state-stream")]
            Self::NonInsertingKey | Self::ControlOnly => DraftFold::WriteOnly,
        }
    }

    /// Whether a person waits for this write's echo, so the next output is
    /// published without the projection throttle.
    #[cfg(feature = "terminal-state-stream")]
    #[must_use]
    pub(crate) fn awaits_echo(self) -> bool {
        match self {
            Self::DraftCapable
            | Self::ErasesCharacter
            | Self::EditsDraft
            | Self::NonInsertingKey => true,
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
            // A key that cannot insert text never creates a draft. Only
            // Backspace counts against one; any other erase is not observable
            // and deliberately preserves it.
            input_intent::Intent::Key(key) => {
                Some(non_inserting_key_effect(key).unwrap_or(Self::DraftCapable))
            }
            input_intent::Intent::Text(_)
            | input_intent::Intent::AgentPrompt(_)
            | input_intent::Intent::DraftGuarded(_) => Some(Self::DraftCapable),
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

/// The effect of a structured key that can never put text into a line
/// editor, or `None` for a key that may. Escape, Shift+Tab, Right/End,
/// Delete, Insert, F1-F24 and Ctrl+C change no draft; Backspace erases one
/// character; Left, Home and Ctrl+Backspace change a draft in a way the Host
/// cannot count. The Host encodes the physical code, so a named key must
/// also be its own code, or carry none (software keyboards). Alt and Meta
/// chords stay draft-capable because line editors bind them to word commands
/// and yanks. Tab completes, Up/Down and PageUp/PageDown can recall history,
/// and other Ctrl letters can yank, paste or accept a search, so they stay
/// too.
#[cfg(feature = "terminal-state-stream")]
fn non_inserting_key_effect(
    key: &terminal_state_protocol::KeyInputIntent,
) -> Option<ControllerInputEffect> {
    let chord = key.modifiers & CHORD;
    let named = key.code.is_empty() || key.code == key.key;
    let shift_or_control_only = chord & !(SHIFT | CONTROL) == 0;
    let effect = match key.key.as_str() {
        // Shift+Insert pastes in PSReadLine and many terminals.
        "Escape" | "Insert" if named && chord == 0 => ControllerInputEffect::NonInsertingKey,
        "Tab" if named && chord == SHIFT => ControllerInputEffect::NonInsertingKey,
        // Ctrl+Backspace erases a word, whose length the Host cannot count.
        "Backspace" if named && chord & !SHIFT == 0 => ControllerInputEffect::ErasesCharacter,
        "Backspace" | "ArrowLeft" | "Home" if named && shift_or_control_only => {
            ControllerInputEffect::EditsDraft
        }
        "ArrowRight" | "End" | "Delete" if named && shift_or_control_only => {
            ControllerInputEffect::NonInsertingKey
        }
        "c" | "C" if key.code == "KeyC" && chord == CONTROL => {
            ControllerInputEffect::NonInsertingKey
        }
        name if named && shift_or_control_only && is_function_key(name) => {
            ControllerInputEffect::NonInsertingKey
        }
        _ => return None,
    };
    Some(effect)
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
    fn keys_that_cannot_insert_text_carry_their_draft_effect() {
        use ControllerInputEffect::{EditsDraft, ErasesCharacter, NonInsertingKey};
        const CAPS_LOCK: u32 = 1 << 4;
        const NUM_LOCK: u32 = 1 << 5;
        for (key, code, modifiers, effect) in [
            ("Escape", "Escape", 0, NonInsertingKey),
            ("Escape", "", NUM_LOCK, NonInsertingKey),
            ("Tab", "Tab", SHIFT, NonInsertingKey),
            ("Tab", "Tab", SHIFT | CAPS_LOCK, NonInsertingKey),
            ("ArrowLeft", "ArrowLeft", 0, EditsDraft),
            ("ArrowLeft", "ArrowLeft", SHIFT | CONTROL, EditsDraft),
            ("Home", "Home", SHIFT, EditsDraft),
            ("ArrowRight", "ArrowRight", SHIFT | CONTROL, NonInsertingKey),
            ("End", "", 0, NonInsertingKey),
            ("Backspace", "Backspace", 0, ErasesCharacter),
            ("Backspace", "", 0, ErasesCharacter),
            ("Backspace", "Backspace", SHIFT | CAPS_LOCK, ErasesCharacter),
            ("Backspace", "Backspace", CONTROL, EditsDraft),
            ("Delete", "Delete", 0, NonInsertingKey),
            ("Delete", "Delete", CONTROL, NonInsertingKey),
            ("Insert", "Insert", 0, NonInsertingKey),
            ("F1", "F1", 0, NonInsertingKey),
            ("F24", "F24", CONTROL, NonInsertingKey),
            ("c", "KeyC", CONTROL, NonInsertingKey),
            ("C", "KeyC", CONTROL | CAPS_LOCK, NonInsertingKey),
        ] {
            assert_eq!(
                key_effect(key, code, modifiers),
                effect,
                "{key}/{code}/{modifiers:#x}"
            );
        }
    }

    #[test]
    fn keys_that_may_insert_text_stay_draft_capable() {
        const ALT: u32 = 1 << 1;
        const META: u32 = 1 << 3;
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
            ("Backspace", "Backspace", ALT),
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
            ("Backspace", "KeyH", 0),
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
    fn each_effect_names_how_the_host_folds_its_write() {
        assert_eq!(
            ControllerInputEffect::DraftCapable.draft_fold(),
            DraftFold::Bytes
        );
        assert_eq!(
            ControllerInputEffect::ErasesCharacter.draft_fold(),
            DraftFold::Edit(ControllerDraftEdit::Erased(1))
        );
        assert_eq!(
            ControllerInputEffect::EditsDraft.draft_fold(),
            DraftFold::Edit(ControllerDraftEdit::EditedUncounted)
        );
        assert_eq!(
            ControllerInputEffect::NonInsertingKey.draft_fold(),
            DraftFold::WriteOnly
        );
        assert_eq!(
            ControllerInputEffect::ControlOnly.draft_fold(),
            DraftFold::WriteOnly
        );
    }

    #[test]
    fn every_keypress_awaits_its_echo_but_control_traffic_does_not() {
        for effect in [
            ControllerInputEffect::DraftCapable,
            ControllerInputEffect::ErasesCharacter,
            ControllerInputEffect::EditsDraft,
            ControllerInputEffect::NonInsertingKey,
        ] {
            assert!(effect.awaits_echo(), "{effect:?}");
        }
        assert!(!ControllerInputEffect::ControlOnly.awaits_echo());
    }
}
