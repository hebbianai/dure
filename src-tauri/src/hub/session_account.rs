//! A phone asked about, or asked to change, one session's provider account.
//!
//! # Why the screen answers
//!
//! The account selector's transition — restart on the same conversation, or
//! queue behind a running turn — is the desktop client's
//! (`requestAgentCredentialTransition`), and so is the usage reading the
//! selector draws. This module delivers the question there and waits, like
//! [`super::start_agent`]; a Rust copy of either would be a second owner that
//! drifts from the selector.
//!
//! # What is decided here
//!
//! Only the confirmation gate. A switch restarts the provider, so a request
//! that does not carry the person's confirmation is refused before the screen
//! hears of it — the protocol twin of `--confirm-restart`.

use dure_hub_protocol::session_account::HubSessionAccountResult;
use serde::Serialize;

/// What the screen is asked. A read when `switch` is absent.
#[derive(Clone, Debug, Serialize)]
pub struct SessionAccountRequest {
    /// The hmux session id from the catalog.
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub switch: Option<SessionAccountSwitch>,
}

/// A confirmed switch. Only built after the gate in [`answer_switch`].
#[derive(Clone, Debug, Serialize)]
pub struct SessionAccountSwitch {
    /// The press's name. A retry with the same name reaches the same switch.
    pub action_id: String,
    /// `None` is the provider's default account.
    pub account_id: Option<String>,
}

/// The side that can read and switch accounts — the desktop screen.
pub trait SessionAccountSink: Send + Sync {
    fn deliver(&self, request: SessionAccountRequest) -> HubSessionAccountResult;
}

/// Round trips still waiting for the screen. The rules are [`super::roundtrip`]'s.
pub type PendingSessionAccount = super::roundtrip::PendingRoundTrips<HubSessionAccountResult>;

impl super::roundtrip::RoundTrip for HubSessionAccountResult {
    const PREFIX: &'static str = "session-account";
    const EVENT: &'static str = "hub://session-account";

    fn undeliverable() -> Self {
        Self::refused(
            "Could not forward the request to the desktop client",
            "screen_unreachable",
        )
    }

    /// Past the deadline the switch may still be running. Not knowing is its
    /// own code, so the phone tells the person to check the session rather
    /// than inviting a second press.
    fn timed_out() -> Self {
        Self::refused(
            "The desktop client did not respond in time. Check the session",
            "screen_silent",
        )
    }
}

/// Read the session's accounts.
pub fn answer_read(
    sink: Option<&dyn SessionAccountSink>,
    session_id: String,
) -> HubSessionAccountResult {
    match sink {
        Some(sink) => sink.deliver(SessionAccountRequest {
            session_id,
            switch: None,
        }),
        None => unavailable(),
    }
}

/// Switch the session's account, once the restart is confirmed.
pub fn answer_switch(
    sink: Option<&dyn SessionAccountSink>,
    session_id: String,
    action_id: String,
    account_id: Option<String>,
    confirm_restart: bool,
) -> HubSessionAccountResult {
    if !confirm_restart {
        return HubSessionAccountResult::refused(
            "Switching the account restarts the session. Confirm the restart to switch",
            "confirmation_required",
        );
    }
    if action_id.trim().is_empty() {
        return HubSessionAccountResult::refused("The switch has no name", "invalid_request");
    }
    match sink {
        Some(sink) => sink.deliver(SessionAccountRequest {
            session_id,
            switch: Some(SessionAccountSwitch {
                action_id,
                account_id,
            }),
        }),
        None => unavailable(),
    }
}

fn unavailable() -> HubSessionAccountResult {
    HubSessionAccountResult::refused(
        "This desktop cannot switch session accounts",
        "screen_unreachable",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_hub_protocol::session_account::SessionAccountOutcome;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<serde_json::Value>>);

    impl SessionAccountSink for Recorder {
        fn deliver(&self, request: SessionAccountRequest) -> HubSessionAccountResult {
            self.0
                .lock()
                .unwrap()
                .push(serde_json::to_value(&request).unwrap());
            HubSessionAccountResult::answered(SessionAccountOutcome::Switched, Vec::new())
        }
    }

    /// The screen never hears of an unconfirmed switch: nothing to undo.
    #[test]
    fn an_unconfirmed_switch_stops_at_the_hub() {
        let screen = Recorder::default();
        let result = answer_switch(
            Some(&screen),
            "session-1".into(),
            "press-1".into(),
            Some("account-spare".into()),
            false,
        );
        assert_eq!(result.outcome, SessionAccountOutcome::Refused);
        assert_eq!(result.code.as_deref(), Some("confirmation_required"));
        assert!(screen.0.lock().unwrap().is_empty());
    }

    #[test]
    fn a_confirmed_switch_reaches_the_screen_with_its_press() {
        let screen = Recorder::default();
        let result = answer_switch(
            Some(&screen),
            "session-1".into(),
            "press-1".into(),
            None,
            true,
        );
        assert_eq!(result.outcome, SessionAccountOutcome::Switched);
        assert_eq!(
            screen.0.lock().unwrap().as_slice(),
            [serde_json::json!({
                "session_id": "session-1",
                "switch": { "action_id": "press-1", "account_id": null },
            })]
        );
    }

    /// A read carries no switch at all, so a retried read can never write.
    #[test]
    fn a_read_carries_no_switch() {
        let screen = Recorder::default();
        let _ = answer_read(Some(&screen), "session-1".into());
        assert_eq!(
            screen.0.lock().unwrap().as_slice(),
            [serde_json::json!({ "session_id": "session-1" })]
        );
    }

    #[test]
    fn a_hub_without_a_screen_says_so() {
        let result = answer_read(None, "session-1".into());
        assert_eq!(result.code.as_deref(), Some("screen_unreachable"));
    }
}
