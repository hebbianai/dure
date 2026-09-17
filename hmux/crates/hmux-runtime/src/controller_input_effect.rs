/// How one accepted PTY write changes the Host's unsubmitted-input authority.
///
/// The PTY writer owns byte delivery. This separate semantic fact prevents
/// terminal control traffic from becoming a user draft merely because the
/// terminal encoded it as bytes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ControllerInputEffect {
    DraftCapable,
    #[cfg(feature = "terminal-state-stream")]
    ControlOnly,
}

impl ControllerInputEffect {
    #[must_use]
    pub(crate) fn retains_pending_draft(self) -> bool {
        match self {
            Self::DraftCapable => true,
            #[cfg(feature = "terminal-state-stream")]
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
            input_intent::Intent::Key(key)
                if key.key == "Escape" && key.code == "Escape" && key.modifiers & 0x0f == 0 =>
            {
                // Escape controls the current interaction. It cannot create a
                // draft, and ControlOnly deliberately preserves any prior one.
                Some(Self::ControlOnly)
            }
            input_intent::Intent::Text(_)
            | input_intent::Intent::AgentPrompt(_)
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

#[cfg(all(test, feature = "terminal-state-stream"))]
mod tests {
    use super::*;
    use terminal_state_protocol::{
        FocusInputIntent, PasteInputIntent, PointerInputIntent, ResizeInputIntent, TextInputIntent,
        input_intent,
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
}
