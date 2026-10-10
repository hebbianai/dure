//! Terminal-reported program status (OSC 7501, Program Status Protocol 0.3).
//!
//! A program running in the terminal describes itself; the Host enforces the
//! protocol's framing, limits and record lifetime and nothing more. This is
//! presentation the program wrote to its own terminal, not a Host-owned fact:
//! it never changes agent lifecycle, activity, attention, source or completed
//! turns, and clients show it only alongside the terminal it came from.
use serde::{Deserialize, Serialize};
use std::fmt;

/// Longest decoded `msg` the protocol admits.
pub const PROGRAM_STATUS_MESSAGE_MAX_BYTES: usize = 2048;
/// Longest `app` name the protocol admits.
pub const PROGRAM_STATUS_APP_MAX_BYTES: usize = 32;

/// Adding a state is a protocol change: older peers reject unknown variants.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgramStatusState {
    Idle,
    Working,
    Blocked,
    Done,
    Error,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgramStatusBlockedKind {
    Permission,
    Question,
    Auth,
}

/// The terminal's root program status record. Child records, titles and
/// progress stay Host-local until a client surface needs them.
#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProgramStatusProjection {
    pub state: ProgramStatusState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_kind: Option<ProgramStatusBlockedKind>,
    /// Stable machine-readable program name such as `claude-code`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    /// One displayable line. The Host has already refused control characters
    /// and removed bidirectional and invisible formatting characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

// The message is program-chosen text (a prompt, a path, an error line); logs
// carry its size only, as with other provider-controlled strings.
impl fmt::Debug for ProgramStatusProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProgramStatusProjection")
            .field("state", &self.state)
            .field("blocked_kind", &self.blocked_kind)
            .field("app", &self.app)
            .field("message_len", &self.message.as_ref().map(String::len))
            .finish()
    }
}

impl ProgramStatusProjection {
    pub fn is_valid(&self) -> bool {
        (self.blocked_kind.is_none() || self.state == ProgramStatusState::Blocked)
            && self.app.as_deref().is_none_or(is_program_status_app)
            && self.message.as_deref().is_none_or(|message| {
                !message.is_empty()
                    && message.len() <= PROGRAM_STATUS_MESSAGE_MAX_BYTES
                    && message.chars().all(is_displayable_program_status_char)
            })
    }
}

/// `app` and every `id` segment share one character set: 1-32 bytes of
/// `[A-Za-z0-9_.+-]`.
pub fn is_program_status_app(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= PROGRAM_STATUS_APP_MAX_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.+-".contains(&byte))
}

/// Control characters make a report invalid.
pub fn is_program_status_control_char(character: char) -> bool {
    character.is_control()
}

/// Bidirectional overrides and invisible formatting characters (Unicode
/// general category Cf) are removed before a message is displayed, so a
/// program cannot reorder or hide text around its own status.
pub fn is_program_status_format_char(character: char) -> bool {
    matches!(
        u32::from(character),
        0x00AD
            | 0x0600..=0x0605
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x0890..=0x0891
            | 0x08E2
            | 0x180E
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0001
            | 0xE0020..=0xE007F
    )
}

fn is_displayable_program_status_char(character: char) -> bool {
    !is_program_status_control_char(character) && !is_program_status_format_char(character)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn projection(state: ProgramStatusState) -> ProgramStatusProjection {
        ProgramStatusProjection {
            state,
            blocked_kind: None,
            app: Some("claude-code".into()),
            message: Some("Reading files".into()),
        }
    }

    #[test]
    fn a_blocked_kind_belongs_only_to_a_blocked_state() {
        let mut blocked = projection(ProgramStatusState::Blocked);
        blocked.blocked_kind = Some(ProgramStatusBlockedKind::Permission);
        assert!(blocked.is_valid());

        let mut done = projection(ProgramStatusState::Done);
        done.blocked_kind = Some(ProgramStatusBlockedKind::Question);
        assert!(!done.is_valid(), "a kind explains only a blocked state");
    }

    #[test]
    fn app_and_message_must_be_bounded_and_displayable() {
        for app in ["", "has space", "x".repeat(33).as_str(), "ünïcode"] {
            let mut status = projection(ProgramStatusState::Idle);
            status.app = Some(app.into());
            assert!(!status.is_valid(), "{app:?}");
        }
        for message in [
            String::new(),
            "two\nlines".into(),
            "bell\u{7}".into(),
            "c1\u{85}".into(),
            "rtl\u{202E}override".into(),
            "zero\u{200B}width".into(),
            "x".repeat(PROGRAM_STATUS_MESSAGE_MAX_BYTES + 1),
        ] {
            let mut status = projection(ProgramStatusState::Idle);
            status.message = Some(message.clone());
            assert!(!status.is_valid(), "{message:?}");
        }
        let mut status = projection(ProgramStatusState::Error);
        status.message = Some("빌드 실패: 테스트 3개 🚧".into());
        assert!(status.is_valid());
    }

    #[test]
    fn absent_fields_are_omitted_and_unknown_ones_tolerated() {
        let status = ProgramStatusProjection {
            state: ProgramStatusState::Working,
            blocked_kind: None,
            app: None,
            message: None,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({ "state": "working" })
        );
        let blocked: ProgramStatusProjection = serde_json::from_value(serde_json::json!({
            "state": "blocked",
            "blocked_kind": "auth",
            "future_field": true
        }))
        .unwrap();
        assert_eq!(blocked.blocked_kind, Some(ProgramStatusBlockedKind::Auth));
    }
}
