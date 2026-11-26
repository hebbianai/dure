//! A push registration and its answer: the phone hands a paired computer its
//! subscription together with the grant for it, and the computer says whether
//! the push service took it (#660).
//!
//! [`PushRefusal`] is the one vocabulary of reasons an alert cannot reach a
//! phone. The service, the desktop and the phone all name a failure with it,
//! so a reason never has to be translated between them.

use super::{PushGrant, PushId, PushSubscription};
use crate::frame::{self, FrameError};
use serde::{Deserialize, Serialize};
use std::io::Read;

/// The value a desktop's catalog carries in `push_registration` when it
/// reads [`crate::hello::HubRequest::UpdatePushSubscriptionV2`].
pub const PUSH_REGISTRATION_VERSION: u16 = 2;

/// Upper bound of a computer's answer to a push subscription request, V1 or
/// V2. An answer is a status and one sentence.
pub const MAX_RESULT_BYTES: usize = 4096;

/// Why an alert cannot reach a phone, or why a registration was not taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PushRefusal {
    /// This computer has no push service to use.
    NotConfigured,
    /// The push service did not answer.
    ServiceUnreachable,
    /// The push service does not know this request yet.
    ServiceOutdated,
    /// The phone must be updated before this computer can register it.
    PhoneUpdateRequired,
    /// The grant does not name this computer, token, environment or
    /// preference.
    GrantRefused,
    GrantExpired,
    /// The phone has since issued a grant with a higher epoch.
    GrantSuperseded,
    /// APNs no longer accepts the token.
    TokenInvalid,
    RateLimited,
    /// The service holds as many registrations as it can.
    Capacity,
    /// Refused without a reason, as the service answers anyone it has not
    /// authenticated.
    Refused,
    /// A reason a newer peer names and this build does not know.
    #[serde(other)]
    Other,
}

/// What the phone hands a computer to register: its subscription, and the
/// grant that lets this computer send to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PushRegistration {
    pub subscription: PushSubscription,
    pub grant: PushGrant,
}

/// A computer's answer to
/// [`crate::hello::HubRequest::UpdatePushSubscriptionV2`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PushRegistrationResult {
    /// The subscription is stored and the service took the grant. Alerts
    /// flow until `expires_at` (Unix seconds) unless the phone renews it
    /// first. None when it was a removal.
    Saved {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expires_at: Option<u64>,
    },
    /// The service sent the phone a [`super::PushChallenge`] for key
    /// `key_id`, and waits for a grant that signs it back.
    Pending { key_id: PushId },
    /// The subscription is stored, but alerts cannot flow, for `reason`.
    Refused { reason: PushRefusal, detail: String },
    /// An answer a newer computer gives and this build does not know.
    #[serde(other)]
    Other,
}

/// Computer side: one answer as a frame.
pub fn encode_registration_result(result: &PushRegistrationResult) -> Result<Vec<u8>, FrameError> {
    frame::encode(result, MAX_RESULT_BYTES)
}

/// Phone side: reads one answer.
pub fn read_registration_result<R: Read>(
    reader: &mut R,
) -> Result<PushRegistrationResult, FrameError> {
    frame::read(reader, MAX_RESULT_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_answer_round_trips_through_a_frame() {
        for result in [
            PushRegistrationResult::Saved {
                expires_at: Some(1_796_000_000),
            },
            PushRegistrationResult::Saved { expires_at: None },
            PushRegistrationResult::Pending {
                key_id: "k.0123456789abcdef".to_string().try_into().unwrap(),
            },
            PushRegistrationResult::Refused {
                reason: PushRefusal::GrantRefused,
                detail: "This grant names another computer.".to_string(),
            },
        ] {
            let framed = encode_registration_result(&result).unwrap();
            assert_eq!(
                read_registration_result(&mut framed.as_slice()).unwrap(),
                result
            );
        }
        assert_eq!(
            serde_json::to_value(PushRegistrationResult::Saved { expires_at: None }).unwrap(),
            serde_json::json!({ "status": "saved" })
        );
    }

    /// A newer peer's reason or answer reads as Other: failing the whole
    /// document would turn "this build does not know the reason" into "the
    /// computer said nothing".
    #[test]
    fn a_later_reason_or_answer_reads_as_other() {
        let refusal: PushRefusal = serde_json::from_str(r#""phone_on_fire""#).unwrap();
        assert_eq!(refusal, PushRefusal::Other);
        let result: PushRegistrationResult = serde_json::from_value(serde_json::json!({
            "status": "refused",
            "reason": "phone_on_fire",
            "detail": "x",
        }))
        .unwrap();
        assert_eq!(
            result,
            PushRegistrationResult::Refused {
                reason: PushRefusal::Other,
                detail: "x".to_string()
            }
        );
        let later: PushRegistrationResult =
            serde_json::from_value(serde_json::json!({ "status": "queued", "position": 3 }))
                .unwrap();
        assert_eq!(later, PushRegistrationResult::Other);
    }

    /// The service, the desktop and the phone spell every reason the same.
    #[test]
    fn the_refusal_vocabulary_is_snake_case_on_the_wire() {
        let spelled: Vec<String> = [
            PushRefusal::NotConfigured,
            PushRefusal::ServiceUnreachable,
            PushRefusal::ServiceOutdated,
            PushRefusal::PhoneUpdateRequired,
            PushRefusal::GrantRefused,
            PushRefusal::GrantExpired,
            PushRefusal::GrantSuperseded,
            PushRefusal::TokenInvalid,
            PushRefusal::RateLimited,
            PushRefusal::Capacity,
            PushRefusal::Refused,
            PushRefusal::Other,
        ]
        .into_iter()
        .map(|reason| {
            serde_json::to_value(reason)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
        assert_eq!(
            spelled,
            [
                "not_configured",
                "service_unreachable",
                "service_outdated",
                "phone_update_required",
                "grant_refused",
                "grant_expired",
                "grant_superseded",
                "token_invalid",
                "rate_limited",
                "capacity",
                "refused",
                "other",
            ]
        );
    }

    #[test]
    fn an_answer_over_the_bound_is_not_sent() {
        let result = PushRegistrationResult::Refused {
            reason: PushRefusal::Refused,
            detail: "x".repeat(MAX_RESULT_BYTES),
        };
        assert!(matches!(
            encode_registration_result(&result),
            Err(FrameError::OutOfRange { .. })
        ));
    }
}
