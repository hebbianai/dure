//! One session's provider account, read and switched from the phone.
//!
//! # Why the desktop screen answers
//!
//! Switching an account is the desktop account selector's transition: it
//! restarts the provider on the same conversation, and when a turn is running
//! it queues the switch until that turn ends instead of interrupting it. That
//! transition, its deferred intent and its recovery live in the desktop
//! client. The hub only carries the question there and the answer back, like
//! `start_agent` — a second implementation would drift from the selector, and
//! the drift would surface as a session that lost its settings on one path
//! only.
//!
//! # Why one answer document for both questions
//!
//! A switch answers with the accounts as they stand after it, so the sheet
//! that asked redraws from the same shape it opened with. A read is the same
//! document with the outcome `listed`.
//!
//! # Why the restart is confirmed in the request
//!
//! A switch restarts the provider process. `dure runs switch-account` only
//! previews unless `--confirm-restart` is given; the phone's request carries
//! the same confirmation as a field, and the hub refuses a switch without it
//! before the desktop ever hears of it.
//!
//! # What does not cross
//!
//! Account ids, the labels the desktop already draws, and usage percentages.
//! Never a profile directory, credential file, token, or anything else that
//! would let the phone act as the account.
//!
//! # Why a separate version
//!
//! Like `launch_offer`, so a phone that meets a desktop speaking another
//! version of this document loses this sheet only, not the session list.

use crate::frame::{self, FrameError};
use serde::{Deserialize, Serialize};
use std::io::Read;

/// The version this build speaks.
pub const HUB_SESSION_ACCOUNT_VERSION: u16 = 1;

/// One answer's limit. The document grows with the number of registered
/// accounts, so it does not share the greeting's 8 KiB.
pub const MAX_SESSION_ACCOUNT_BYTES: usize = 64 * 1024;

/// Which provider window a usage reading describes.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageWindow {
    /// The short (five-hour) window.
    FiveHour,
    /// The weekly window. Shown instead of the short one when it binds.
    Weekly,
}

/// The limit reading the desktop's account selector draws for one account.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AccountUsage {
    /// 0–100, rounded the way the desktop draws it.
    pub used_percent: u8,
    pub window: UsageWindow,
    /// Time until that window resets, in the desktop's compact duration form:
    /// one or two `<n>d`, `<n>h` or `<n>m` tokens separated by a space
    /// (`"3h 40m"`). Absent when the provider did not report a reset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_in: Option<String>,
}

/// One account the desktop's selector offers for this session's provider.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionAccountChoice {
    /// The id to send back to select it. Absent is the provider's default
    /// account, which has no registered id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// The name the desktop's selector shows. Absent for the provider's
    /// default account, which the phone names in its own language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The session runs on this account now.
    #[serde(default)]
    pub current: bool,
    /// A switch to this account is queued behind the running turn.
    #[serde(default)]
    pub pending: bool,
    /// Absent when nothing was observed. Never filled with 0 or 100.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<AccountUsage>,
}

/// What the desktop did with the question.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionAccountOutcome {
    /// A read: here are the accounts.
    Listed,
    /// The session now runs on the chosen account, same conversation.
    Switched,
    /// A turn is running; the switch happens when it ends.
    Scheduled,
    /// The switch is still running on the desktop. Asking again with the same
    /// `action_id` reaches the same switch rather than starting another.
    InProgress,
    /// Nothing changed. `code` says why.
    Refused,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubSessionAccountResult {
    pub hub_session_account_version: u16,
    pub outcome: SessionAccountOutcome,
    /// The accounts as they stand after this answer. Empty on a refusal that
    /// could not read them.
    #[serde(default)]
    pub accounts: Vec<SessionAccountChoice>,
    /// A sentence for a person. The screen branches on `code`, not on this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl HubSessionAccountResult {
    #[must_use]
    pub fn answered(outcome: SessionAccountOutcome, accounts: Vec<SessionAccountChoice>) -> Self {
        Self {
            hub_session_account_version: HUB_SESSION_ACCOUNT_VERSION,
            outcome,
            accounts,
            detail: None,
            code: None,
        }
    }

    #[must_use]
    pub fn refused(detail: impl Into<String>, code: impl Into<String>) -> Self {
        Self {
            hub_session_account_version: HUB_SESSION_ACCOUNT_VERSION,
            outcome: SessionAccountOutcome::Refused,
            accounts: Vec::new(),
            detail: Some(detail.into()),
            code: Some(code.into()),
        }
    }
}

/// Hub side: one answer as a frame.
///
/// # Errors
/// When serialization fails or the answer exceeds the frame limit.
pub fn encode(result: &HubSessionAccountResult) -> Result<Vec<u8>, FrameError> {
    frame::encode(result, MAX_SESSION_ACCOUNT_BYTES)
}

/// Phone side: read the answer. A version this build does not speak is refused.
///
/// # Errors
/// When the frame is broken, the version differs or the document is unreadable.
pub fn read<R: Read>(reader: &mut R) -> Result<HubSessionAccountResult, SessionAccountError> {
    let payload = frame::read_bytes(reader, MAX_SESSION_ACCOUNT_BYTES)?;
    // The loose probe reads the version first, so a document from another
    // version says "update one side" rather than "malformed".
    let probe: VersionProbe = serde_json::from_slice(&payload)
        .map_err(|_| SessionAccountError::Frame(FrameError::Malformed("Missing version")))?;
    if probe.hub_session_account_version != HUB_SESSION_ACCOUNT_VERSION {
        return Err(SessionAccountError::UnsupportedVersion {
            found: probe.hub_session_account_version,
        });
    }
    serde_json::from_slice(&payload).map_err(|_| {
        SessionAccountError::Frame(FrameError::Malformed("Could not read the account answer"))
    })
}

#[derive(Deserialize)]
struct VersionProbe {
    hub_session_account_version: u16,
}

#[derive(Debug)]
pub enum SessionAccountError {
    Frame(FrameError),
    UnsupportedVersion { found: u16 },
}

impl From<FrameError> for SessionAccountError {
    fn from(error: FrameError) -> Self {
        Self::Frame(error)
    }
}

impl std::fmt::Display for SessionAccountError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Frame(error) => write!(formatter, "{error}"),
            Self::UnsupportedVersion { found } => write!(
                formatter,
                "This computer speaks account answer version {found}. Update one side"
            ),
        }
    }
}

impl std::error::Error for SessionAccountError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn choices() -> Vec<SessionAccountChoice> {
        vec![
            SessionAccountChoice {
                account_id: None,
                label: None,
                current: false,
                pending: false,
                usage: None,
            },
            SessionAccountChoice {
                account_id: Some("account-work".to_string()),
                label: Some("Work".to_string()),
                current: true,
                pending: false,
                usage: Some(AccountUsage {
                    used_percent: 100,
                    window: UsageWindow::Weekly,
                    resets_in: Some("2d 4h".to_string()),
                }),
            },
            SessionAccountChoice {
                account_id: Some("account-spare".to_string()),
                label: Some("Spare".to_string()),
                current: false,
                pending: true,
                usage: Some(AccountUsage {
                    used_percent: 12,
                    window: UsageWindow::FiveHour,
                    resets_in: None,
                }),
            },
        ]
    }

    #[test]
    fn an_answer_round_trips_between_the_two_halves() {
        let sent = HubSessionAccountResult::answered(SessionAccountOutcome::Scheduled, choices());
        let framed = encode(&sent).expect("encode");
        assert_eq!(read(&mut framed.as_slice()).expect("read"), sent);
    }

    /// The default account has neither id nor name; writing `null` would read
    /// the same, but leaving them out keeps the document honest about there
    /// being nothing.
    #[test]
    fn the_default_account_carries_no_id() {
        let value = serde_json::to_value(&choices()[0]).expect("to value");
        assert!(value.get("account_id").is_none());
        assert!(value.get("label").is_none());
        assert!(value.get("usage").is_none());
    }

    #[test]
    fn a_refusal_carries_a_code_the_screen_can_branch_on() {
        let framed = encode(&HubSessionAccountResult::refused(
            "Confirm the restart",
            "confirmation_required",
        ))
        .expect("encode");
        let read = read(&mut framed.as_slice()).expect("read");
        assert_eq!(read.outcome, SessionAccountOutcome::Refused);
        assert_eq!(read.code.as_deref(), Some("confirmation_required"));
        assert!(read.accounts.is_empty());
    }

    #[test]
    fn a_newer_document_is_refused_rather_than_guessed() {
        let framed = frame::encode(
            &serde_json::json!({ "hub_session_account_version": HUB_SESSION_ACCOUNT_VERSION + 1 }),
            MAX_SESSION_ACCOUNT_BYTES,
        )
        .expect("encode");
        assert!(matches!(
            read(&mut framed.as_slice()),
            Err(SessionAccountError::UnsupportedVersion { .. })
        ));
    }

    /// Nothing on the wire could carry a credential: only ids, labels and
    /// usage. A field added later must fail here first.
    #[test]
    fn a_choice_has_no_field_that_could_carry_a_credential() {
        let value = serde_json::to_value(&choices()[1]).expect("to value");
        let mut fields: Vec<&str> = value
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        fields.sort_unstable();
        assert_eq!(
            fields,
            ["account_id", "current", "label", "pending", "usage"]
        );
    }

    #[test]
    fn many_accounts_still_fit_in_one_frame() {
        let accounts = (0..64)
            .map(|index| SessionAccountChoice {
                account_id: Some(format!("account-{index}-with-a-reasonably-long-identifier")),
                label: Some(format!(
                    "An account label that somebody typed at length {index}"
                )),
                current: index == 0,
                pending: false,
                usage: Some(AccountUsage {
                    used_percent: 50,
                    window: UsageWindow::FiveHour,
                    resets_in: Some("4h 59m".to_string()),
                }),
            })
            .collect();
        let framed = encode(&HubSessionAccountResult::answered(
            SessionAccountOutcome::Listed,
            accounts,
        ))
        .expect("sixty-four accounts fit");
        assert_eq!(
            read(&mut framed.as_slice()).expect("read").accounts.len(),
            64
        );
    }
}
