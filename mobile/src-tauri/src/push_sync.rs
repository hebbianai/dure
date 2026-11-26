//! One push sync's registration with each paired computer (#660).
//!
//! A computer whose catalog advertised `push_registration` 2 or later
//! (remembered on its `HubEntry`) gets `UpdatePushSubscriptionV2` with a
//! grant this phone's push key signed for exactly that computer's pinned
//! fingerprint ([`crate::push_key`]). Any other computer gets V1, exactly as
//! before V2 existed.
//!
//! The first V2 registration with a key the push service has not bound to
//! this phone's token is answered `Pending`: the service sent this phone a
//! challenge alert. [`PushChallenges`] catches it in the foreground alert
//! delegate (`push_ios`), and the same computer is asked again with a grant
//! that carries the challenge's nonce. Computers are registered one after
//! another, so the ones after it register against the binding that proof
//! created.
//!
//! # A V2 answer that never comes
//!
//! Once a computer advertised V2, a connection that closes after the ack is a
//! lost connection: it is reported as `computer_unreachable` and retried on
//! the next sync. It is never read as "an older computer" and never followed
//! by a V1 request, which would register without a grant.

use crate::hub_client::{self, HubClientError};
use crate::hub_store::HubEntry;
use crate::push::{HubPushOutcome, SyncCode};
use crate::push_key::PushKey;
use dure_hub_protocol::frame::{self, FrameError};
use dure_hub_protocol::hello::HubRequest;
use dure_hub_protocol::push::{
    read_registration_result, PushChallenge, PushId, PushNonce, PushRefusal, PushRegistration,
    PushRegistrationResult, PushSubscription, PushSubscriptionResult, MAX_RESULT_BYTES,
    PUSH_REGISTRATION_VERSION,
};
use std::io::{Read, Write};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// How long a sync waits for the challenge alert after `Pending`.
#[cfg(target_os = "ios")]
const CHALLENGE_WAIT: Duration = Duration::from_secs(20);

/// As long as the service keeps a pending challenge.
const CHALLENGE_TTL: Duration = Duration::from_secs(10 * 60);

const MAX_CHALLENGES: usize = 4;

/// Challenges the push service sent this phone's key, between the alert
/// delegate that catches them in the foreground and the sync that signs them
/// back.
///
/// A nonce is kept for as long as the service keeps its challenge: while one
/// is pending, the service sends the same nonce again rather than a new one,
/// so the next sync can still answer a challenge that arrived late.
#[derive(Default)]
pub struct PushChallenges {
    inner: Mutex<Challenges>,
    arrived: Condvar,
}

#[derive(Default)]
struct Challenges {
    /// The key this install signs with, once a sync loaded it. A challenge
    /// for any other key is not this phone's to answer, and its alert shows.
    own: Option<PushId>,
    /// Newest first, at most [`MAX_CHALLENGES`], one per key.
    held: Vec<(PushChallenge, Instant)>,
}

impl PushChallenges {
    /// The sync names the key it signs with before it registers.
    pub fn expect(&self, key: PushId) {
        self.lock().own = Some(key);
    }

    /// A delivered alert's whole payload. `true` when it was a challenge for
    /// this phone's key: it is held for the sync, and needs no banner.
    pub fn capture(&self, payload: &[u8]) -> bool {
        PushChallenge::from_payload(payload)
            .is_some_and(|challenge| self.capture_at(challenge, Instant::now()))
    }

    fn capture_at(&self, challenge: PushChallenge, now: Instant) -> bool {
        let mut inner = self.lock();
        if inner.own.as_ref() != Some(&challenge.key) {
            return false;
        }
        inner.held.retain(|(held, at)| {
            held.key != challenge.key && now.saturating_duration_since(*at) < CHALLENGE_TTL
        });
        inner.held.insert(0, (challenge, now));
        inner.held.truncate(MAX_CHALLENGES);
        drop(inner);
        self.arrived.notify_all();
        true
    }

    /// The nonce held for `key`, waiting up to `wait` for its alert.
    fn wait_for(&self, key: &PushId, wait: Duration) -> Option<PushNonce> {
        let deadline = Instant::now() + wait;
        let mut inner = self.lock();
        loop {
            let now = Instant::now();
            if let Some(nonce) = Self::held_at(&inner, key, now) {
                return Some(nonce);
            }
            let left = deadline
                .checked_duration_since(now)
                .filter(|left| !left.is_zero())?;
            inner = self
                .arrived
                .wait_timeout(inner, left)
                .unwrap_or_else(|error| error.into_inner())
                .0;
        }
    }

    fn held_at(inner: &Challenges, key: &PushId, now: Instant) -> Option<PushNonce> {
        inner
            .held
            .iter()
            .find(|(held, at)| {
                &held.key == key && now.saturating_duration_since(*at) < CHALLENGE_TTL
            })
            .map(|(held, _)| held.challenge.clone())
    }

    /// The service took a grant carrying `nonce`: its challenge is over.
    fn answered(&self, key: &PushId, nonce: &PushNonce) {
        self.lock()
            .held
            .retain(|(held, _)| !(&held.key == key && &held.challenge == nonce));
    }

    fn lock(&self) -> MutexGuard<'_, Challenges> {
        self.inner.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// What this phone asks a computer for when alerts are on: this
/// subscription, granted by this key.
#[derive(Clone, Copy)]
pub(crate) struct Alerts<'a> {
    pub subscription: &'a PushSubscription,
    pub key: &'a PushKey,
}

/// Why one computer's registration did not finish.
#[derive(Debug, PartialEq, Eq)]
struct SyncFailure {
    code: Option<SyncCode>,
    detail: String,
}

impl From<HubClientError> for SyncFailure {
    fn from(error: HubClientError) -> Self {
        let code = matches!(
            error,
            HubClientError::Unreachable(_) | HubClientError::ComputerOffline
        )
        .then_some(SyncCode::ComputerUnreachable);
        Self {
            code,
            detail: error.to_string(),
        }
    }
}

impl From<String> for SyncFailure {
    fn from(detail: String) -> Self {
        Self { code: None, detail }
    }
}

/// Registers `alerts` (None: alerts off) with every paired computer in turn,
/// over each one's pinned TLS connection. `now` is Unix seconds.
#[cfg(target_os = "ios")]
pub(crate) fn synchronize(
    hubs: &[HubEntry],
    alerts: Option<Alerts<'_>>,
    challenges: &PushChallenges,
    now: u64,
) -> Vec<HubPushOutcome> {
    register_all(hubs, alerts, challenges, now, CHALLENGE_WAIT, |entry| {
        let relay = entry
            .relay_endpoint
            .as_deref()
            .zip(entry.server_id.as_deref());
        hub_client::dial_tls(&entry.endpoint, relay, &entry.fingerprint)
    })
}

/// `synchronize` with the connection supplied: `dial` opens one fresh
/// connection to a computer per request.
fn register_all<S: Read + Write>(
    hubs: &[HubEntry],
    alerts: Option<Alerts<'_>>,
    challenges: &PushChallenges,
    now: u64,
    wait: Duration,
    mut dial: impl FnMut(&HubEntry) -> Result<S, HubClientError>,
) -> Vec<HubPushOutcome> {
    if let Some(alerts) = alerts {
        challenges.expect(alerts.key.key_id());
    }
    hubs.iter()
        .map(|entry| {
            let result = register_with(entry, alerts, challenges, now, wait, || dial(entry));
            let (error, code) = match result {
                Ok(()) => (None, None),
                Err(failure) => (Some(failure.detail), failure.code),
            };
            HubPushOutcome {
                id: entry.id.clone(),
                computer: entry.box_label.clone(),
                error,
                code,
            }
        })
        .collect()
}

/// Whether this computer's catalog advertised V2 registration.
fn speaks_v2(entry: &HubEntry) -> bool {
    entry
        .push_registration
        .is_some_and(|version| version >= PUSH_REGISTRATION_VERSION)
}

/// One computer: V2 when its catalog advertised it, V1 otherwise.
///
/// On V2, `Pending` for this phone's key means the service sent the
/// challenge alert. Once [`PushChallenges`] holds its nonce, the same
/// computer is asked again with a grant that carries it.
fn register_with<S: Read + Write>(
    entry: &HubEntry,
    alerts: Option<Alerts<'_>>,
    challenges: &PushChallenges,
    now: u64,
    wait: Duration,
    mut dial: impl FnMut() -> Result<S, HubClientError>,
) -> Result<(), SyncFailure> {
    if !speaks_v2(entry) {
        let subscription = alerts.map(|alerts| alerts.subscription.clone());
        return register_v1(&mut dial()?, &entry.token, subscription);
    }
    let Some(Alerts { subscription, key }) = alerts else {
        return settled(register_v2(&mut dial()?, &entry.token, None)?);
    };
    let registration = |nonce| {
        key.mint_grant(&entry.fingerprint, subscription, nonce, now)
            .map(|grant| PushRegistration {
                subscription: subscription.clone(),
                grant,
            })
    };
    let first = register_v2(&mut dial()?, &entry.token, Some(registration(None)?))?;
    let own = key.key_id();
    if !matches!(&first, PushRegistrationResult::Pending { key_id } if *key_id == own) {
        return settled(first);
    }
    let Some(nonce) = challenges.wait_for(&own, wait) else {
        return settled(first);
    };
    let second = register_v2(
        &mut dial()?,
        &entry.token,
        Some(registration(Some(nonce.clone()))?),
    )?;
    if matches!(second, PushRegistrationResult::Saved { .. }) {
        challenges.answered(&own, &nonce);
    }
    settled(second)
}

/// V1: the subscription alone. Every refusal a computer that reads only V1
/// gives is fixed by updating Dure there.
fn register_v1(
    stream: &mut (impl Read + Write),
    pairing_token: &str,
    subscription: Option<PushSubscription>,
) -> Result<(), SyncFailure> {
    hub_client::handshake_for(
        stream,
        pairing_token,
        HubRequest::UpdatePushSubscriptionV1 { subscription },
    )?;
    let result: PushSubscriptionResult =
        frame::read(stream, MAX_RESULT_BYTES).map_err(|error| error.to_string())?;
    match result {
        PushSubscriptionResult::Saved => Ok(()),
        PushSubscriptionResult::Refused { detail } => Err(SyncFailure {
            code: Some(SyncCode::ComputerUpdate),
            detail,
        }),
    }
}

/// V2: the subscription and the grant for it, or None to stop alerts.
fn register_v2(
    stream: &mut (impl Read + Write),
    pairing_token: &str,
    registration: Option<PushRegistration>,
) -> Result<PushRegistrationResult, SyncFailure> {
    hub_client::handshake_for(
        stream,
        pairing_token,
        HubRequest::UpdatePushSubscriptionV2 { registration },
    )?;
    read_registration_result(stream).map_err(|error| match error {
        FrameError::Closed | FrameError::Truncated(_) | FrameError::TimedOut => SyncFailure {
            code: Some(SyncCode::ComputerUnreachable),
            detail: error.to_string(),
        },
        other => other.to_string().into(),
    })
}

fn settled(result: PushRegistrationResult) -> Result<(), SyncFailure> {
    match result {
        PushRegistrationResult::Saved { .. } => Ok(()),
        PushRegistrationResult::Pending { key_id } => Err(SyncFailure {
            code: Some(SyncCode::SetupPending),
            detail: format!(
                "The push service waits for this phone to confirm key {}",
                key_id.as_str()
            ),
        }),
        PushRegistrationResult::Refused { reason, detail } => Err(SyncFailure {
            code: Some(SyncCode::Refused(reason)),
            detail,
        }),
        PushRegistrationResult::Other => Err(SyncFailure {
            code: Some(SyncCode::Refused(PushRefusal::Other)),
            detail: "The computer answered in a way this version of Dure does not know".into(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_hub_protocol::hello;
    use dure_hub_protocol::push::{
        encode_registration_result, ApnsEnvironment, PushGrantClaimsRead, PushLanguage,
        PushPreference, PUSH_ALERT_CONTEXT_KEY,
    };
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::io::Cursor;
    use std::rc::Rc;

    /// One connection: what the computer answers, and a shared record of
    /// what the phone sent on it.
    struct Stream {
        reply: Cursor<Vec<u8>>,
        sent: Rc<RefCell<Vec<u8>>>,
    }
    impl Read for Stream {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            self.reply.read(bytes)
        }
    }
    impl Write for Stream {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.sent.borrow_mut().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// A computer that answers each connection with the next reply, and
    /// remembers every request.
    #[derive(Default)]
    struct Desk {
        replies: VecDeque<Vec<u8>>,
        sent: Vec<Rc<RefCell<Vec<u8>>>>,
    }
    impl Desk {
        fn answering(replies: impl IntoIterator<Item = Vec<u8>>) -> Self {
            Self {
                replies: replies.into_iter().collect(),
                sent: Vec::new(),
            }
        }
        fn dial(&mut self) -> Result<Stream, HubClientError> {
            let reply = self
                .replies
                .pop_front()
                .ok_or_else(|| HubClientError::Unreachable("no answer".into()))?;
            let sent = Rc::new(RefCell::new(Vec::new()));
            self.sent.push(sent.clone());
            Ok(Stream {
                reply: Cursor::new(reply),
                sent,
            })
        }
        fn requests(&self) -> Vec<HubRequest> {
            self.sent
                .iter()
                .map(|sent| {
                    let hello = hello::read_hello(&mut Cursor::new(sent.borrow().clone())).unwrap();
                    assert_eq!(hello.token, "paired-token");
                    hello.request
                })
                .collect()
        }
    }

    fn ack() -> Vec<u8> {
        hello::encode_ack("device-1", "Phone").unwrap()
    }
    fn v1(result: PushSubscriptionResult) -> Vec<u8> {
        let mut reply = ack();
        reply.extend(frame::encode(&result, MAX_RESULT_BYTES).unwrap());
        reply
    }
    fn v2(result: PushRegistrationResult) -> Vec<u8> {
        let mut reply = ack();
        reply.extend(encode_registration_result(&result).unwrap());
        reply
    }
    fn saved() -> Vec<u8> {
        v2(PushRegistrationResult::Saved {
            expires_at: Some(NOW + 14 * 24 * 60 * 60),
        })
    }

    const NOW: u64 = 1_795_686_400;

    fn computer(advertised: Option<u16>) -> HubEntry {
        let fingerprint = dure_hub_protocol::fingerprint::of_der(b"laptop");
        HubEntry {
            id: fingerprint.clone(),
            box_label: "Laptop".into(),
            endpoint: "192.168.0.12:47823".into(),
            fingerprint,
            token: "paired-token".into(),
            relay_endpoint: Some("relay.example:8787".into()),
            server_id: Some("server-1".into()),
            push_registration: advertised,
        }
    }

    fn subscription() -> PushSubscription {
        PushSubscription {
            token: "aa12".to_string().try_into().unwrap(),
            environment: ApnsEnvironment::Sandbox,
            preference: PushPreference::Approvals,
            language: PushLanguage::Ko,
        }
    }

    fn key() -> (tempfile::TempDir, PushKey) {
        let root = tempfile::tempdir().unwrap();
        let key = PushKey::load_or_create(root.path()).unwrap();
        (root, key)
    }

    fn nonce() -> PushNonce {
        "0123456789abcdef0123456789abcdef"
            .to_string()
            .try_into()
            .unwrap()
    }

    fn challenge_alert(key: &PushId, nonce: &PushNonce) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "aps": { "alert": { "body": "Dure alerts are on for this iPhone." } },
            PUSH_ALERT_CONTEXT_KEY: { "challenge": nonce.as_str(), "key": key.as_str() },
        }))
        .unwrap()
    }

    fn register(
        desk: &mut Desk,
        entry: &HubEntry,
        alerts: Option<Alerts<'_>>,
        challenges: &PushChallenges,
        wait: Duration,
    ) -> Result<(), SyncFailure> {
        if let Some(alerts) = alerts {
            challenges.expect(alerts.key.key_id());
        }
        register_with(entry, alerts, challenges, NOW, wait, || desk.dial())
    }

    fn grant_claims(request: &HubRequest) -> dure_hub_protocol::push::PushGrantClaims {
        let HubRequest::UpdatePushSubscriptionV2 {
            registration: Some(registration),
        } = request
        else {
            panic!("expected a V2 registration with a grant, got {request:?}");
        };
        let Ok(PushGrantClaimsRead::Known(claims)) = registration.grant.read_claims() else {
            panic!("the grant reads as known claims");
        };
        claims
    }

    #[test]
    fn a_computer_that_did_not_advertise_v2_gets_v1_exactly_as_before() {
        let (_root, key) = key();
        let wanted = subscription();
        for advertised in [None, Some(1)] {
            for alerts in [
                Some(Alerts {
                    subscription: &wanted,
                    key: &key,
                }),
                None,
            ] {
                let mut desk = Desk::answering([v1(PushSubscriptionResult::Saved)]);
                register(
                    &mut desk,
                    &computer(advertised),
                    alerts,
                    &PushChallenges::default(),
                    Duration::ZERO,
                )
                .unwrap();
                assert_eq!(
                    desk.requests(),
                    [HubRequest::UpdatePushSubscriptionV1 {
                        subscription: alerts.map(|_| wanted.clone()),
                    }]
                );
            }
        }
    }

    #[test]
    fn a_v1_refusal_asks_to_update_the_computer_and_a_silent_close_is_not_saved() {
        let challenges = PushChallenges::default();
        let mut refused = Desk::answering([v1(PushSubscriptionResult::Refused {
            detail: "This computer has no configured push service".into(),
        })]);
        assert_eq!(
            register(
                &mut refused,
                &computer(None),
                None,
                &challenges,
                Duration::ZERO
            ),
            Err(SyncFailure {
                code: Some(SyncCode::ComputerUpdate),
                detail: "This computer has no configured push service".into(),
            })
        );
        let mut old = Desk::answering([ack()]);
        let failure =
            register(&mut old, &computer(None), None, &challenges, Duration::ZERO).unwrap_err();
        assert_eq!(failure.code, None);
    }

    #[test]
    fn a_v2_computer_gets_a_grant_for_exactly_this_pairing_and_off_sends_none() {
        let (_root, key) = key();
        let wanted = subscription();
        let entry = computer(Some(PUSH_REGISTRATION_VERSION));
        let challenges = PushChallenges::default();

        let mut desk = Desk::answering([saved()]);
        let alerts = Alerts {
            subscription: &wanted,
            key: &key,
        };
        register(&mut desk, &entry, Some(alerts), &challenges, Duration::ZERO).unwrap();
        let requests = desk.requests();
        assert_eq!(requests.len(), 1);
        let HubRequest::UpdatePushSubscriptionV2 {
            registration: Some(registration),
        } = &requests[0]
        else {
            panic!("{requests:?}");
        };
        assert_eq!(registration.subscription, wanted);
        assert_eq!(registration.grant.key_id(), key.key_id());
        let claims = grant_claims(&requests[0]);
        assert_eq!(
            (
                claims.hub.as_str(),
                &claims.token,
                claims.environment,
                claims.preference,
                claims.epoch,
                claims.issued_at,
                claims.nonce,
            ),
            (
                entry.fingerprint.as_str(),
                &wanted.token,
                wanted.environment,
                wanted.preference,
                key.epoch(),
                NOW,
                None,
            )
        );

        let mut off = Desk::answering([v2(PushRegistrationResult::Saved { expires_at: None })]);
        register(&mut off, &entry, None, &challenges, Duration::ZERO).unwrap();
        assert_eq!(
            off.requests(),
            [HubRequest::UpdatePushSubscriptionV2 { registration: None }]
        );
    }

    /// The computer advertised V2, so a close after the ack is a lost
    /// connection: retried on the next sync, and never sent again as V1.
    #[test]
    fn a_v2_computer_that_closes_after_the_ack_is_unreachable_and_gets_no_v1() {
        let (_root, key) = key();
        let wanted = subscription();
        let entry = computer(Some(PUSH_REGISTRATION_VERSION));
        let mut truncated = ack();
        truncated.extend([0, 0]);
        for reply in [ack(), truncated] {
            let mut desk = Desk::answering([reply, v1(PushSubscriptionResult::Saved)]);
            let failure = register(
                &mut desk,
                &entry,
                Some(Alerts {
                    subscription: &wanted,
                    key: &key,
                }),
                &PushChallenges::default(),
                Duration::ZERO,
            )
            .unwrap_err();
            assert_eq!(failure.code, Some(SyncCode::ComputerUnreachable));
            assert_eq!(desk.sent.len(), 1, "no second request, V1 or otherwise");
        }
        // A computer that cannot be dialled is unreachable the same way.
        let mut nobody = Desk::default();
        let failure = register(
            &mut nobody,
            &entry,
            None,
            &PushChallenges::default(),
            Duration::ZERO,
        )
        .unwrap_err();
        assert_eq!(failure.code, Some(SyncCode::ComputerUnreachable));
    }

    /// The first grant is answered Pending; the challenge alert arrives while
    /// the sync waits, and the same computer gets a grant carrying its nonce.
    #[test]
    fn pending_then_a_challenge_resends_a_grant_that_carries_its_nonce() {
        let (_root, key) = key();
        let wanted = subscription();
        let entry = computer(Some(PUSH_REGISTRATION_VERSION));
        let challenges = PushChallenges::default();
        let pending = v2(PushRegistrationResult::Pending {
            key_id: key.key_id(),
        });
        let mut desk = Desk::answering([pending, saved()]);

        let result = std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(50));
                assert!(challenges.capture(&challenge_alert(&key.key_id(), &nonce())));
            });
            register(
                &mut desk,
                &entry,
                Some(Alerts {
                    subscription: &wanted,
                    key: &key,
                }),
                &challenges,
                Duration::from_secs(10),
            )
        });

        assert_eq!(result, Ok(()));
        let requests = desk.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(grant_claims(&requests[0]).nonce, None);
        assert_eq!(grant_claims(&requests[1]).nonce, Some(nonce()));
        // Answered: the next Pending does not reuse a nonce the service dropped.
        assert_eq!(challenges.wait_for(&key.key_id(), Duration::ZERO), None);
    }

    #[test]
    fn a_challenge_that_does_not_come_leaves_setup_pending_without_a_resend() {
        let (_root, key) = key();
        let wanted = subscription();
        let entry = computer(Some(PUSH_REGISTRATION_VERSION));
        let alerts = Alerts {
            subscription: &wanted,
            key: &key,
        };
        let (_other_root, other) = self::key();
        for key_id in [key.key_id(), other.key_id()] {
            let mut desk =
                Desk::answering([v2(PushRegistrationResult::Pending { key_id }), saved()]);
            let failure = register(
                &mut desk,
                &entry,
                Some(alerts),
                &PushChallenges::default(),
                Duration::from_millis(20),
            )
            .unwrap_err();
            assert_eq!(failure.code, Some(SyncCode::SetupPending));
            assert_eq!(desk.sent.len(), 1);
        }
    }

    #[test]
    fn a_refusal_carries_the_services_reason_and_outcomes_keep_the_computers_order() {
        let (_root, key) = key();
        let wanted = subscription();
        let v2_computer = computer(Some(PUSH_REGISTRATION_VERSION));
        let mut v1_computer = computer(None);
        v1_computer.id = "SHA256:other".into();
        v1_computer.box_label = "Desktop".into();
        let mut desk = Desk::answering([
            v2(PushRegistrationResult::Refused {
                reason: PushRefusal::GrantExpired,
                detail: "The grant has expired".into(),
            }),
            v1(PushSubscriptionResult::Saved),
        ]);

        let outcomes = register_all(
            &[v2_computer.clone(), v1_computer],
            Some(Alerts {
                subscription: &wanted,
                key: &key,
            }),
            &PushChallenges::default(),
            NOW,
            Duration::ZERO,
            |_| desk.dial(),
        );

        assert_eq!(
            serde_json::to_value(&outcomes).unwrap(),
            serde_json::json!([
                {
                    "id": v2_computer.id,
                    "computer": "Laptop",
                    "error": "The grant has expired",
                    "code": "grant_expired",
                },
                { "id": "SHA256:other", "computer": "Desktop", "error": null },
            ])
        );
        assert!(matches!(
            desk.requests().as_slice(),
            [
                HubRequest::UpdatePushSubscriptionV2 { .. },
                HubRequest::UpdatePushSubscriptionV1 { .. }
            ]
        ));
        // The phone's own codes are spelled as the screen reads them.
        assert_eq!(
            serde_json::to_value([
                SyncCode::SetupPending,
                SyncCode::ComputerUnreachable,
                SyncCode::ComputerUpdate,
                SyncCode::Refused(PushRefusal::RateLimited),
            ])
            .unwrap(),
            serde_json::json!([
                "setup_pending",
                "computer_unreachable",
                "computer_update",
                "rate_limited"
            ])
        );
    }

    #[test]
    fn only_this_phones_challenges_are_held_and_only_while_the_service_keeps_them() {
        let challenges = PushChallenges::default();
        let (_root, key) = key();
        let (_other_root, other) = self::key();
        let own = key.key_id();
        // Before a sync names its key, no challenge is this phone's.
        assert!(!challenges.capture(&challenge_alert(&own, &nonce())));
        challenges.expect(own.clone());
        assert!(!challenges.capture(&challenge_alert(&other.key_id(), &nonce())));
        assert!(!challenges.capture(br#"{"aps":{},"dure":{"session":"managed_1"}}"#));
        assert!(!challenges.capture(br#"{"aps":{},"dure":{"challenge":"short","key":"k.0"}}"#));

        let start = Instant::now();
        let first = PushChallenge {
            challenge: nonce(),
            key: own.clone(),
        };
        assert!(challenges.capture_at(first, start));
        let newer: PushNonce = "fedcba9876543210fedcba9876543210"
            .to_string()
            .try_into()
            .unwrap();
        let second = PushChallenge {
            challenge: newer.clone(),
            key: own.clone(),
        };
        assert!(challenges.capture_at(second, start));
        let inner = challenges.lock();
        assert_eq!(PushChallenges::held_at(&inner, &own, start), Some(newer));
        assert_eq!(inner.held.len(), 1, "one challenge per key");
        assert_eq!(
            PushChallenges::held_at(&inner, &own, start + CHALLENGE_TTL),
            None
        );
        assert_eq!(
            PushChallenges::held_at(&inner, &other.key_id(), start),
            None
        );
        drop(inner);

        // A bounded number of keys, the newest kept.
        for index in 0..MAX_CHALLENGES + 2 {
            let key = dure_hub_protocol::push::push_key_id(&[index as u8]);
            challenges.expect(key.clone());
            assert!(challenges.capture_at(
                PushChallenge {
                    challenge: nonce(),
                    key,
                },
                start
            ));
        }
        assert_eq!(challenges.lock().held.len(), MAX_CHALLENGES);
    }
}
