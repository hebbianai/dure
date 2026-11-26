//! Paired-device delivery. The notification service alone owns APNs credentials
//! and deduplication; the existing registry owns consent, token replacement
//! and what the service last said about each subscription.
use super::{
    commands::HubState,
    devices::DeviceRegistry,
    identity::{self, DeviceToken, PushRegistrationState},
    push_service::{self, PushAnswer, PushRoute},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use dure_hub_protocol::push::{
    PushApproval, PushId, PushKind, PushRefusal, PushReply, PushSubscription,
};
use serde::{Deserialize, Deserializer, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SIGNING_CONTEXT: &[u8] = b"dure-push-request-v1\0";
static SEND_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

/// The signed event is identifiers only: what the agent asked or said stays
/// on this computer, which the phone asks over its paired channel.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PushEvent {
    kind: PushKind,
    event_id: String,
    /// The agent a tap on the alert opens on the phone.
    #[serde(
        default,
        deserialize_with = "opaque",
        skip_serializing_if = "Option::is_none"
    )]
    session_id: Option<PushId>,
    /// The pending approval Allow once and Deny on the alert answer. Only
    /// beside an `approval` event whose request the phone can answer.
    #[serde(
        default,
        deserialize_with = "opaque",
        skip_serializing_if = "Option::is_none"
    )]
    approval: Option<PushApproval>,
    /// The process a text reply on a finished turn's alert reaches. Only
    /// beside a `done` event of an agent whose prompts this desktop serves.
    #[serde(
        default,
        deserialize_with = "opaque",
        skip_serializing_if = "Option::is_none"
    )]
    reply: Option<PushReply>,
}

impl PushEvent {
    /// Keeps each answer the alert offers only where the phone can give it:
    /// an approval on an approval event, a reply on a finished turn of an
    /// Hmux-managed agent whose prompts this desktop serves (`provider`).
    fn offer_only_answerable(&mut self, provider: Option<&str>) {
        if self.session_id.is_none() || self.kind != PushKind::Approval {
            self.approval = None;
        }
        let serves = provider.is_some_and(|provider| {
            super::conversation::serves_conversation(&hmux_client::SessionClass::Managed, provider)
        });
        if self.session_id.is_none() || self.kind != PushKind::Done || !serves {
            self.reply = None;
        }
    }
}

/// An identifier outside the opaque alphabet is dropped at this boundary: the
/// alert still goes, without the tap target or actions it would have named.
fn opaque<'de, D: Deserializer<'de>, T: serde::de::DeserializeOwned>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Ok(Option::<serde_json::Value>::deserialize(deserializer)?
        .and_then(|value| serde_json::from_value(value).ok()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PushMessage<'a> {
    version: u8,
    operation: &'static str,
    issued_at: u64,
    event: Option<&'a PushEvent>,
    subscription: &'a PushSubscription,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignedRequest {
    certificate: String,
    message: String,
    signature: String,
}

fn sign_request(
    certificate: &identity::HubCertificate,
    subscription: &PushSubscription,
    event: Option<&PushEvent>,
    issued_at: u64,
) -> Result<SignedRequest, String> {
    let message = serde_json::to_vec(&PushMessage {
        version: 1,
        operation: if event.is_some() { "send" } else { "register" },
        issued_at,
        event,
        subscription,
    })
    .map_err(|_| "Could not encode push request")?;
    let rng = ring::rand::SystemRandom::new();
    let key = ring::signature::EcdsaKeyPair::from_pkcs8(
        &ring::signature::ECDSA_P256_SHA256_ASN1_SIGNING,
        &certificate.private_key_der,
        &rng,
    )
    .map_err(|_| "Could not load the Hub signing identity")?;
    let signed = [SIGNING_CONTEXT, message.as_slice()].concat();
    let signature = key
        .sign(&rng, &signed)
        .map_err(|_| "Could not sign push request")?;
    Ok(SignedRequest {
        certificate: STANDARD.encode(&certificate.der),
        message: STANDARD.encode(message),
        signature: STANDARD.encode(signature.as_ref()),
    })
}

fn unix_now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .map_err(|_| "Could not read the notification clock".into())
}

/// The subscription an alert of `kind` goes to: one that wants that kind
/// and that the push service registered. A device the service refused, or
/// one never registered, waits for the phone's next sync.
fn recipient(device: &DeviceToken, kind: PushKind) -> Option<&PushSubscription> {
    let registered = matches!(
        device
            .push_registration
            .as_ref()
            .map(|record| &record.state),
        Some(PushRegistrationState::Registered)
    );
    device
        .push
        .as_ref()
        .filter(|subscription| registered && subscription.accepts(kind))
}

/// Keeps the registry in step with what the service answered about
/// `subscription`, and names why it did not pass. None: accepted.
fn apply_answer(
    registry: &DeviceRegistry,
    device_id: &str,
    subscription: &PushSubscription,
    answer: PushAnswer,
) -> Result<Option<PushRefusal>, String> {
    let reason = match answer {
        PushAnswer::Accepted => return Ok(None),
        PushAnswer::Retired => {
            registry
                .retire_push(device_id, subscription)
                .map_err(|error| error.to_string())?;
            PushRefusal::TokenInvalid
        }
        PushAnswer::Refused(reason) => {
            registry
                .record_push_registration(
                    device_id,
                    subscription,
                    PushRegistrationState::Refused { reason },
                )
                .map_err(|error| error.to_string())?;
            reason
        }
        // A passing outage keeps what the service said last.
        PushAnswer::Unavailable(reason) => reason,
    };
    Ok(Some(reason))
}

/// The sentence a phone shows for `reason` in a V1 answer.
fn refusal_detail(reason: PushRefusal) -> &'static str {
    match reason {
        PushRefusal::PhoneUpdateRequired => {
            "Phone alerts from this computer need a newer Dure for iPhone."
        }
        PushRefusal::NotConfigured => {
            "This computer's custom push service file is invalid, so phone alerts are off."
        }
        PushRefusal::ServiceUnreachable => "Could not reach the push service. Push is not ready.",
        PushRefusal::ServiceOutdated => "The push service does not support this computer yet.",
        PushRefusal::RateLimited => "The push service is busy. Try again later.",
        PushRefusal::TokenInvalid => "Apple no longer accepts this phone's alert token.",
        _ => "The push service refused this computer.",
    }
}

/// Report delivery readiness separately from the device's latest consent.
/// A provider outage must never retain an older, more permissive preference.
pub(super) fn update_subscription(
    registry: &DeviceRegistry,
    device: &DeviceToken,
    subscription: Option<PushSubscription>,
    check: impl FnOnce(&PushSubscription) -> Result<PushAnswer, String>,
) -> Result<(), String> {
    registry
        .set_push(&device.token, subscription.clone())
        .map_err(|e| e.to_string())?;
    let Some(subscription) = subscription else {
        return Ok(());
    };
    let answer = check(&subscription)?;
    match apply_answer(registry, &device.device_id, &subscription, answer)? {
        None => registry
            .record_push_registration(
                &device.device_id,
                &subscription,
                PushRegistrationState::Registered,
            )
            .map_err(|error| error.to_string()),
        Some(reason) => Err(refusal_detail(reason).into()),
    }
}

/// Asks the push service to register `subscription`. Err: this computer
/// could not make the request at all.
pub(super) fn check_registration(
    registry: &DeviceRegistry,
    subscription: &PushSubscription,
) -> Result<PushAnswer, String> {
    let service = match push_service::resolve(registry.root()) {
        Ok(service) => service,
        Err(reason) => return Ok(PushAnswer::Unavailable(reason)),
    };
    let certificate =
        identity::load_or_create_certificate(registry.root()).map_err(|e| e.to_string())?;
    let request = sign_request(&certificate, subscription, None, unix_now()?)?;
    let status = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not create push transport")?
        .post(service.url(PushRoute::RegisterV1))
        .json(&request)
        .send()
        .ok()
        .map(|response| response.status().as_u16());
    Ok(push_service::read_answer(PushRoute::RegisterV1, status))
}

/// What became of one agent event's phone alert.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PhonePushReceipt {
    /// No paired phone wants this kind with a subscription the service
    /// registered.
    NoSubscribedPhone,
    Sent {
        devices: usize,
    },
    /// `reason` is the first failure's.
    Partial {
        sent: usize,
        failed: usize,
        reason: PushRefusal,
    },
    Failed {
        reason: PushRefusal,
    },
}

impl PhonePushReceipt {
    fn of(sent: usize, failures: &[PushRefusal]) -> Self {
        match (sent, failures.first()) {
            (0, None) => Self::NoSubscribedPhone,
            (devices, None) => Self::Sent { devices },
            (0, Some(&reason)) => Self::Failed { reason },
            (sent, Some(&reason)) => Self::Partial {
                sent,
                failed: failures.len(),
                reason,
            },
        }
    }
}

/// Sends `event` to every registered phone that wants it. `post` delivers one
/// signed request and gives the HTTP status, or None when none arrived.
async fn deliver<F, Fut>(
    registry: &DeviceRegistry,
    event: &PushEvent,
    post: F,
) -> Result<PhonePushReceipt, String>
where
    F: Fn(reqwest::Url, SignedRequest) -> Fut,
    Fut: std::future::Future<Output = Option<u16>>,
{
    let devices = registry.load().map_err(|error| error.to_string())?;
    if !devices
        .iter()
        .any(|device| recipient(device, event.kind).is_some())
    {
        return Ok(PhonePushReceipt::NoSubscribedPhone);
    }
    let service = match push_service::resolve(registry.root()) {
        Ok(service) => service,
        Err(reason) => return Ok(PhonePushReceipt::Failed { reason }),
    };
    // Distinct simultaneous episodes wait for transport capacity; capacity
    // never acts as a time throttle that silently drops their event IDs.
    let _slot = SEND_SLOTS
        .acquire()
        .await
        .map_err(|_| "Phone notification delivery stopped")?;
    let certificate =
        identity::load_or_create_certificate(registry.root()).map_err(|error| error.to_string())?;
    let (mut sent, mut failures) = (0, Vec::new());
    for device in devices {
        let Some(subscription) = recipient(&device, event.kind).cloned() else {
            continue;
        };
        // A queued send cannot outlive revocation, a newer preference or
        // token, or a refusal another send just recorded.
        let current = registry.load().map_err(|error| error.to_string())?;
        if !current.iter().any(|d| {
            d.device_id == device.device_id && recipient(d, event.kind) == Some(&subscription)
        }) {
            continue;
        }
        let request = sign_request(&certificate, &subscription, Some(event), unix_now()?)?;
        let status = post(service.url(PushRoute::SendV1), request).await;
        let answer = push_service::read_answer(PushRoute::SendV1, status);
        match apply_answer(registry, &device.device_id, &subscription, answer)? {
            None => sent += 1,
            Some(reason) => failures.push(reason),
        }
    }
    Ok(PhonePushReceipt::of(sent, &failures))
}

#[tauri::command]
pub async fn hub_push_agent_notification(
    app: tauri::AppHandle,
    state: tauri::State<'_, HubState>,
    mut event: PushEvent,
    provider: Option<String>,
) -> Result<PhonePushReceipt, String> {
    if event.event_id.is_empty() || event.event_id.len() > 512 {
        return Err("Invalid notification event identity".into());
    }
    event.offer_only_answerable(provider.as_deref());
    let registry = state.registry(&app)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not create push transport")?;
    deliver(&registry, &event, |url, request| {
        let sending = client.post(url).json(&request).send();
        async move {
            sending
                .await
                .ok()
                .map(|response| response.status().as_u16())
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_hub_protocol::push::{ApnsEnvironment, PushLanguage, PushPreference};
    use std::{
        io::Write as _,
        process::{Command, Stdio},
    };

    pub(super) fn subscription(token: &str) -> PushSubscription {
        PushSubscription {
            token: token.to_string().try_into().unwrap(),
            environment: ApnsEnvironment::Sandbox,
            preference: PushPreference::All,
            language: PushLanguage::Ko,
        }
    }

    #[test]
    fn native_hub_signature_reaches_apns_without_a_mobile_attachment() {
        let root = tempfile::tempdir().unwrap();
        let certificate = identity::load_or_create_certificate(root.path()).unwrap();
        let subscription = subscription(&"ab".repeat(32));
        let event = PushEvent {
            kind: PushKind::Approval,
            event_id: "host:session:approval:1".into(),
            session_id: Some("managed_0123456789abcdef".to_string().try_into().unwrap()),
            approval: Some(PushApproval {
                attention_id: "attention-3".to_string().try_into().unwrap(),
                terminal_epoch: "7".to_string().try_into().unwrap(),
            }),
            reply: None,
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let requests = [
            sign_request(&certificate, &subscription, None, now).unwrap(),
            sign_request(&certificate, &subscription, Some(&event), now).unwrap(),
        ];
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../mobile/push-service/verify-native.mjs");
        let mut child = Command::new("node")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&requests).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("APNs alert: passed"));
    }

    #[test]
    fn the_signed_relay_event_names_the_agent_by_identifier_only() {
        let event = |session: &str| -> PushEvent {
            serde_json::from_value(serde_json::json!({
                "kind": "approval",
                "eventId": "hmux:pane-1:7:attention:3",
                "sessionId": session,
                "approval": { "attentionId": "attention-3", "terminalEpoch": "7" },
            }))
            .unwrap()
        };
        // A path or a title is no identifier: dropped, and the alert still goes.
        for unusable in ["/Users/me/project", "Fix the build", ""] {
            assert!(event(unusable).session_id.is_none());
        }
        let approval = |attention: &str| -> Option<PushApproval> {
            serde_json::from_value::<PushEvent>(serde_json::json!({
                "kind": "approval",
                "eventId": "e",
                "approval": { "attentionId": attention, "terminalEpoch": "7" },
            }))
            .unwrap()
            .approval
        };
        assert!(approval("attention 3").is_none());
        assert!(approval("attention-3").is_some());
        let root = tempfile::tempdir().unwrap();
        let certificate = identity::load_or_create_certificate(root.path()).unwrap();
        let signed = sign_request(
            &certificate,
            &subscription(&"ab".repeat(32)),
            Some(&event("managed_0123456789abcdef")),
            1,
        )
        .unwrap();
        let message: serde_json::Value =
            serde_json::from_slice(&STANDARD.decode(signed.message).unwrap()).unwrap();
        assert_eq!(
            message["event"],
            serde_json::json!({
                "kind": "approval",
                "eventId": "hmux:pane-1:7:attention:3",
                "sessionId": "managed_0123456789abcdef",
                "approval": { "attentionId": "attention-3", "terminalEpoch": "7" },
            })
        );
        let mut fields: Vec<_> = message.as_object().unwrap().keys().cloned().collect();
        fields.sort();
        assert_eq!(
            fields,
            ["event", "issuedAt", "operation", "subscription", "version"]
        );
    }

    #[test]
    fn an_alert_offers_a_reply_only_on_a_finished_turn_whose_prompts_this_desktop_serves() {
        let event = |kind: &str| -> PushEvent {
            serde_json::from_value(serde_json::json!({
                "kind": kind,
                "eventId": "hmux:pane-1:7:turn:4",
                "sessionId": "managed_1",
                "reply": { "terminalEpoch": "7" },
                "approval": { "attentionId": "attention-3", "terminalEpoch": "7" },
            }))
            .unwrap()
        };
        let offered = |kind: &str, provider: Option<&str>| {
            let mut event = event(kind);
            event.offer_only_answerable(provider);
            (event.reply.is_some(), event.approval.is_some())
        };
        assert_eq!(offered("done", Some("claude")), (true, false));
        assert_eq!(offered("done", Some("codex")), (true, false));
        assert_eq!(offered("done", Some("gemini")), (false, false));
        assert_eq!(offered("done", None), (false, false));
        assert_eq!(offered("input", Some("claude")), (false, false));
        assert_eq!(offered("approval", Some("claude")), (false, true));
        let signed: serde_json::Value = {
            let mut done = event("done");
            done.offer_only_answerable(Some("claude"));
            serde_json::to_value(&done).unwrap()
        };
        assert_eq!(
            signed,
            serde_json::json!({
                "kind": "done",
                "eventId": "hmux:pane-1:7:turn:4",
                "sessionId": "managed_1",
                "reply": { "terminalEpoch": "7" },
            })
        );
    }

    #[test]
    fn push_consent_is_replaced_and_revocation_cannot_be_undone_by_an_old_connection() {
        let root = tempfile::tempdir().unwrap();
        let registry = super::super::devices::DeviceRegistry::new(root.path());
        let phone = registry.register("Phone".into()).unwrap();
        let old = subscription("aaaa");
        let current = subscription("bbbb");
        registry.set_push(&phone.token, Some(old.clone())).unwrap();
        registry
            .set_push(&phone.token, Some(current.clone()))
            .unwrap();
        registry.retire_push(&phone.device_id, &old).unwrap();
        assert_eq!(registry.load().unwrap()[0].push, Some(current));
        registry.set_push(&phone.token, None).unwrap();
        assert!(registry.load().unwrap()[0].push.is_none());
        registry.revoke(&phone.device_id).unwrap();
        assert!(registry.set_push(&phone.token, Some(old)).is_err());
        assert!(registry.load().unwrap().is_empty());
    }

    #[test]
    fn delivery_failure_cannot_retain_an_older_more_permissive_preference() {
        let root = tempfile::tempdir().unwrap();
        let registry = super::super::devices::DeviceRegistry::new(root.path());
        let phone = registry.register("Phone".into()).unwrap();
        registry
            .set_push(&phone.token, Some(subscription("aaaa")))
            .unwrap();
        let mut current = subscription("bbbb");
        current.preference = PushPreference::Approvals;
        assert!(
            update_subscription(&registry, &phone, Some(current.clone()), |_| Err(
                "Provider offline".into()
            ))
            .is_err()
        );
        assert_eq!(registry.load().unwrap()[0].push, Some(current.clone()));
        for offline in [PushRefusal::ServiceUnreachable, PushRefusal::RateLimited] {
            assert!(
                update_subscription(&registry, &phone, Some(current.clone()), |_| Ok(
                    PushAnswer::Unavailable(offline)
                ))
                .is_err()
            );
            assert_eq!(registry.load().unwrap()[0].push, Some(current.clone()));
        }
        update_subscription(&registry, &phone, Some(current), |_| {
            registry.revoke(&phone.device_id).unwrap();
            Ok(PushAnswer::Accepted)
        })
        .unwrap();
        assert!(registry.load().unwrap().is_empty());
    }

    fn state(registry: &DeviceRegistry) -> Option<PushRegistrationState> {
        registry.load().unwrap()[0]
            .push_registration
            .as_ref()
            .map(|record| record.state.clone())
    }

    /// A phone that registered through the service, as the desktop stores it.
    fn registered(registry: &DeviceRegistry, label: &str, token: &str) -> DeviceToken {
        let phone = registry.register(label.into()).unwrap();
        update_subscription(registry, &phone, Some(subscription(token)), |_| {
            Ok(PushAnswer::Accepted)
        })
        .unwrap();
        phone
    }

    #[test]
    fn the_registration_state_follows_the_service_and_the_subscription_it_describes() {
        let root = tempfile::tempdir().unwrap();
        let registry = DeviceRegistry::new(root.path());
        let phone = registry.register("Phone".into()).unwrap();

        // Refused: stored with its reason, and the phone reads why.
        let refused = update_subscription(&registry, &phone, Some(subscription("aaaa")), |_| {
            Ok(PushAnswer::Refused(PushRefusal::PhoneUpdateRequired))
        });
        assert_eq!(
            refused,
            Err("Phone alerts from this computer need a newer Dure for iPhone.".into())
        );
        assert_eq!(
            state(&registry),
            Some(PushRegistrationState::Refused {
                reason: PushRefusal::PhoneUpdateRequired
            })
        );

        // Registered on the next sync of the same subscription.
        update_subscription(&registry, &phone, Some(subscription("aaaa")), |_| {
            Ok(PushAnswer::Accepted)
        })
        .unwrap();
        assert_eq!(state(&registry), Some(PushRegistrationState::Registered));
        assert!(
            registry.load().unwrap()[0]
                .push_registration
                .as_ref()
                .unwrap()
                .at
                > 0
        );

        // A passing outage on a later sync keeps the registration.
        assert!(
            update_subscription(&registry, &phone, Some(subscription("aaaa")), |_| Ok(
                PushAnswer::Unavailable(PushRefusal::ServiceUnreachable)
            ))
            .is_err()
        );
        assert_eq!(state(&registry), Some(PushRegistrationState::Registered));

        // A new token is not what the service registered.
        assert!(
            update_subscription(&registry, &phone, Some(subscription("bbbb")), |_| Ok(
                PushAnswer::Unavailable(PushRefusal::ServiceUnreachable)
            ))
            .is_err()
        );
        assert_eq!(state(&registry), None);

        // Off clears both, without asking the service.
        update_subscription(&registry, &phone, Some(subscription("bbbb")), |_| {
            Ok(PushAnswer::Accepted)
        })
        .unwrap();
        update_subscription(&registry, &phone, None, |_| unreachable!()).unwrap();
        assert_eq!(registry.load().unwrap()[0].push, None);
        assert_eq!(state(&registry), None);

        // APNs retiring the token clears both too.
        update_subscription(&registry, &phone, Some(subscription("cccc")), |_| {
            Ok(PushAnswer::Accepted)
        })
        .unwrap();
        registry
            .retire_push(&phone.device_id, &subscription("cccc"))
            .unwrap();
        assert_eq!(registry.load().unwrap()[0].push, None);
        assert_eq!(state(&registry), None);
        assert_eq!(
            update_subscription(&registry, &phone, Some(subscription("dddd")), |_| Ok(
                PushAnswer::Retired
            )),
            Err("Apple no longer accepts this phone's alert token.".into())
        );
        assert_eq!(registry.load().unwrap()[0].push, None);

        // Revocation removes the device with its state.
        registered(&registry, "Other", "eeee");
        registry.revoke(&phone.device_id).unwrap();
        assert!(registry
            .load()
            .unwrap()
            .iter()
            .all(|device| device.device_id != phone.device_id));
    }

    #[test]
    fn a_check_that_finishes_after_the_phone_changed_its_subscription_records_nothing() {
        let root = tempfile::tempdir().unwrap();
        let registry = DeviceRegistry::new(root.path());
        let phone = registry.register("Phone".into()).unwrap();
        update_subscription(&registry, &phone, Some(subscription("aaaa")), |_| {
            // The phone's newer sync lands while the service is asked.
            registry
                .set_push(&phone.token, Some(subscription("bbbb")))
                .unwrap();
            Ok(PushAnswer::Accepted)
        })
        .unwrap();
        assert_eq!(registry.load().unwrap()[0].push, Some(subscription("bbbb")));
        assert_eq!(state(&registry), None);
    }

    /// A file written before #660 has no registration state.
    #[test]
    fn a_device_list_from_before_registration_state_reads_as_not_yet_registered() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("hub-devices.json"),
            serde_json::to_vec(&serde_json::json!({
                "hub_devices_version": 1,
                "devices": [{
                    "device_id": "device_1",
                    "label": "Phone",
                    "token": "t",
                    "push": serde_json::to_value(subscription("aaaa")).unwrap(),
                }],
            }))
            .unwrap(),
        )
        .unwrap();
        let registry = DeviceRegistry::new(root.path());
        let device = &registry.load().unwrap()[0];
        assert_eq!(device.push_registration, None);
        assert_eq!(recipient(device, PushKind::Approval), None);
        let written = serde_json::to_value(device).unwrap();
        assert!(written.get("push_registration").is_none(), "{written}");
        let record = identity::PushRegistrationRecord {
            state: PushRegistrationState::Refused {
                reason: PushRefusal::PhoneUpdateRequired,
            },
            at: 7,
        };
        assert_eq!(
            serde_json::to_value(&record).unwrap(),
            serde_json::json!({ "state": "refused", "reason": "phone_update_required", "at": 7 })
        );
    }

    #[test]
    fn alerts_go_only_to_subscriptions_the_service_registered() {
        let root = tempfile::tempdir().unwrap();
        let registry = DeviceRegistry::new(root.path());
        let never = registry.register("Never checked".into()).unwrap();
        registry
            .set_push(&never.token, Some(subscription("aaaa")))
            .unwrap();
        let refused = registry.register("Refused".into()).unwrap();
        let _ = update_subscription(&registry, &refused, Some(subscription("bbbb")), |_| {
            Ok(PushAnswer::Refused(PushRefusal::PhoneUpdateRequired))
        });
        registered(&registry, "Registered", "cccc");
        let approvals = registry.register("Approvals".into()).unwrap();
        let mut narrow = subscription("dddd");
        narrow.preference = PushPreference::Approvals;
        update_subscription(&registry, &approvals, Some(narrow), |_| {
            Ok(PushAnswer::Accepted)
        })
        .unwrap();
        let devices = registry.load().unwrap();
        let tokens = |kind| -> Vec<String> {
            devices
                .iter()
                .filter_map(|device| recipient(device, kind))
                .map(|subscription| subscription.token.as_str().to_string())
                .collect()
        };
        assert_eq!(tokens(PushKind::Approval), ["cccc", "dddd"]);
        assert_eq!(tokens(PushKind::Done), ["cccc"]);
    }

    fn approval() -> PushEvent {
        PushEvent {
            kind: PushKind::Approval,
            event_id: "host:session:approval:1".into(),
            session_id: None,
            approval: None,
            reply: None,
        }
    }

    /// Delivers `event`, answering each request in turn from `answers`, and
    /// gives the receipt with the URLs the requests went to.
    fn deliver_with(
        registry: &DeviceRegistry,
        event: &PushEvent,
        answers: &[Option<u16>],
    ) -> (PhonePushReceipt, Vec<String>) {
        let urls = std::sync::Mutex::new(Vec::new());
        let receipt = tauri::async_runtime::block_on(deliver(registry, event, |url, _| {
            let mut urls = urls.lock().unwrap();
            let answer = *answers
                .get(urls.len())
                .expect("no more requests than answers");
            urls.push(url.to_string());
            async move { answer }
        }))
        .unwrap();
        (receipt, urls.into_inner().unwrap())
    }

    #[test]
    fn nobody_registered_for_the_kind_means_no_request_at_all() {
        let root = tempfile::tempdir().unwrap();
        let registry = DeviceRegistry::new(root.path());
        assert_eq!(
            deliver_with(&registry, &approval(), &[]),
            (PhonePushReceipt::NoSubscribedPhone, vec![])
        );
        let phone = registry.register("Phone".into()).unwrap();
        registry
            .set_push(&phone.token, Some(subscription("aaaa")))
            .unwrap();
        assert_eq!(
            deliver_with(&registry, &approval(), &[]),
            (PhonePushReceipt::NoSubscribedPhone, vec![])
        );
    }

    #[test]
    fn sends_go_to_the_official_service_or_the_override_and_never_past_an_invalid_one() {
        let root = tempfile::tempdir().unwrap();
        let registry = DeviceRegistry::new(root.path());
        registered(&registry, "Phone", "aaaa");
        assert_eq!(
            deliver_with(&registry, &approval(), &[Some(202)]),
            (
                PhonePushReceipt::Sent { devices: 1 },
                vec!["https://push.dureai.dev/v1/send".to_string()]
            )
        );
        let file = root.path().join("hub-push-service.json");
        std::fs::write(
            &file,
            r#"{"hub_push_service_version": 1, "endpoint": "https://host.example/push"}"#,
        )
        .unwrap();
        assert_eq!(
            deliver_with(&registry, &approval(), &[Some(200)]).1,
            ["https://host.example/push/v1/send"]
        );
        std::fs::write(
            &file,
            r#"{"hub_push_service_version": 1, "endpoint": "http://host.example/push"}"#,
        )
        .unwrap();
        assert_eq!(
            deliver_with(&registry, &approval(), &[]),
            (
                PhonePushReceipt::Failed {
                    reason: PushRefusal::NotConfigured
                },
                vec![]
            )
        );
    }

    #[test]
    fn registration_against_an_invalid_override_asks_no_service() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("hub-push-service.json"), "{").unwrap();
        let registry = DeviceRegistry::new(root.path());
        assert_eq!(
            check_registration(&registry, &subscription("aaaa")),
            Ok(PushAnswer::Unavailable(PushRefusal::NotConfigured))
        );
    }

    #[test]
    fn each_failed_send_is_typed_and_a_refused_device_waits_for_its_next_sync() {
        let root = tempfile::tempdir().unwrap();
        let registry = DeviceRegistry::new(root.path());
        let first = registered(&registry, "First", "aaaa");
        registered(&registry, "Second", "bbbb");

        // Passing failures keep both devices registered.
        for (status, reason) in [
            (Some(429), PushRefusal::RateLimited),
            (Some(503), PushRefusal::ServiceUnreachable),
            (None, PushRefusal::ServiceUnreachable),
        ] {
            assert_eq!(
                deliver_with(&registry, &approval(), &[status, status]).0,
                PhonePushReceipt::Failed { reason }
            );
        }
        assert_eq!(
            deliver_with(&registry, &approval(), &[Some(202), Some(404)]).0,
            PhonePushReceipt::Partial {
                sent: 1,
                failed: 1,
                reason: PushRefusal::ServiceOutdated
            }
        );

        // The second was refused by the 404; the first is refused now.
        assert_eq!(
            deliver_with(&registry, &approval(), &[Some(403)]).0,
            PhonePushReceipt::Failed {
                reason: PushRefusal::Refused
            }
        );
        assert_eq!(
            deliver_with(&registry, &approval(), &[]).0,
            PhonePushReceipt::NoSubscribedPhone
        );

        // The phone's next sync registers it again.
        update_subscription(&registry, &first, Some(subscription("aaaa")), |_| {
            Ok(PushAnswer::Accepted)
        })
        .unwrap();
        assert_eq!(
            deliver_with(&registry, &approval(), &[Some(202)]).0,
            PhonePushReceipt::Sent { devices: 1 }
        );

        // APNs retiring the token removes that subscription.
        assert_eq!(
            deliver_with(&registry, &approval(), &[Some(410)]).0,
            PhonePushReceipt::Failed {
                reason: PushRefusal::TokenInvalid
            }
        );
        assert_eq!(registry.load().unwrap()[0].push, None);
    }

    #[test]
    fn the_receipt_names_the_outcome_for_the_desktop() {
        assert_eq!(
            serde_json::to_value(PhonePushReceipt::Partial {
                sent: 1,
                failed: 2,
                reason: PushRefusal::RateLimited
            })
            .unwrap(),
            serde_json::json!({ "status": "partial", "sent": 1, "failed": 2, "reason": "rate_limited" })
        );
        assert_eq!(
            serde_json::to_value(PhonePushReceipt::NoSubscribedPhone).unwrap(),
            serde_json::json!({ "status": "no_subscribed_phone" })
        );
    }

    #[test]
    fn push_updates_leave_an_open_registry_reader_on_a_complete_snapshot() {
        use std::io::Read as _;
        let root = tempfile::tempdir().unwrap();
        let registry = super::super::devices::DeviceRegistry::new(root.path());
        let phone = registry.register("Phone".into()).unwrap();
        let path = root.path().join("hub-devices.json");
        let before = std::fs::read(&path).unwrap();
        let mut reader = std::fs::File::open(&path).unwrap();
        registry
            .set_push(&phone.token, Some(subscription("aaaa")))
            .unwrap();
        let mut observed = Vec::new();
        reader.read_to_end(&mut observed).unwrap();
        assert_eq!(
            observed, before,
            "a reader must not observe an in-place rewrite"
        );
        assert!(registry.load().unwrap()[0].push.is_some());
    }

    /// A running hub with one paired phone that has alerts on, reached over
    /// TLS as any device token.
    struct PairedHub {
        server: crate::hub::server::HubServer,
        registry: std::sync::Arc<super::super::devices::DeviceRegistry>,
        phone: String,
        port: u16,
        config: std::sync::Arc<rustls::ClientConfig>,
        _root: tempfile::TempDir,
    }

    impl PairedHub {
        fn start() -> Self {
            use crate::hub::{
                catalog::{HubCatalog, HUB_CATALOG_VERSION},
                server::{CatalogSource, HubServer, HubServices},
            };
            use std::sync::Arc;

            struct Catalog;
            impl CatalogSource for Catalog {
                fn catalog(&self) -> HubCatalog {
                    HubCatalog {
                        chat_sessions: Vec::new(),
                        hub_catalog_version: HUB_CATALOG_VERSION,
                        layout: None,
                        push_registration: None,
                        sessions: vec![],
                        unreachable: vec![],
                    }
                }
            }
            let _ = rustls::crypto::ring::default_provider().install_default();
            let root = tempfile::tempdir().unwrap();
            let certificate = identity::load_or_create_certificate(root.path()).unwrap();
            let registry = Arc::new(super::super::devices::DeviceRegistry::new(root.path()));
            let phone = registry.register("Phone".into()).unwrap().token;
            registry
                .set_push(&phone, Some(subscription("aaaa")))
                .unwrap();
            let server = HubServer::default();
            let port = server
                .start_with_gateway(
                    "127.0.0.1",
                    0,
                    &certificate,
                    registry.clone(),
                    HubServices::catalog_only(Arc::new(Catalog)),
                )
                .unwrap()
                .port
                .unwrap();
            let mut roots = rustls::RootCertStore::empty();
            roots
                .add(rustls::pki_types::CertificateDer::from(certificate.der))
                .unwrap();
            let config = Arc::new(
                rustls::ClientConfig::builder()
                    .with_root_certificates(roots)
                    .with_no_client_auth(),
            );
            Self {
                server,
                registry,
                phone,
                port,
                config,
                _root: root,
            }
        }

        /// Connects and greets the hub with `request` as `token`.
        fn ask(
            &self,
            token: &str,
            request: dure_hub_protocol::hello::HubRequest,
        ) -> rustls::StreamOwned<rustls::ClientConnection, std::net::TcpStream> {
            let socket = std::net::TcpStream::connect(("127.0.0.1", self.port)).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut tls = rustls::StreamOwned::new(
                rustls::ClientConnection::new(
                    self.config.clone(),
                    "hebbian-hub.local".try_into().unwrap(),
                )
                .unwrap(),
                socket,
            );
            tls.write_all(&dure_hub_protocol::hello::encode_hello_for(token, request).unwrap())
                .unwrap();
            tls.flush().unwrap();
            tls
        }

        fn stored(&self) -> Option<PushSubscription> {
            self.registry.load().unwrap()[0].push.clone()
        }
    }

    impl Drop for PairedHub {
        fn drop(&mut self) {
            self.server.stop();
        }
    }

    #[test]
    fn paired_tls_off_removes_consent_even_without_a_push_service() {
        use dure_hub_protocol::{
            frame, hello,
            push::{PushSubscriptionResult, MAX_RESULT_BYTES},
        };

        let hub = PairedHub::start();
        // An unpaired peer cannot remove or replace another device's consent.
        let mut unpaired = hub.ask(
            "unregistered-token",
            hello::HubRequest::UpdatePushSubscriptionV1 { subscription: None },
        );
        assert!(hello::read_ack(&mut unpaired).is_err());
        assert!(hub.stored().is_some());

        let mut paired = hub.ask(
            &hub.phone,
            hello::HubRequest::UpdatePushSubscriptionV1 { subscription: None },
        );
        hello::read_ack(&mut paired).unwrap();
        let result: PushSubscriptionResult = frame::read(&mut paired, MAX_RESULT_BYTES).unwrap();
        assert_eq!(result, PushSubscriptionResult::Saved);
        assert!(hub.stored().is_none());
    }

    /// This desktop does not advertise `push_registration` yet (#660), so a
    /// V2 registration gets what a desktop that predates it gives: the ack,
    /// then nothing. Consent stays as it was, and the request is never read
    /// as a catalog request.
    #[test]
    fn a_v2_registration_is_acknowledged_then_closed_without_touching_consent() {
        use dure_hub_protocol::{
            hello,
            push::{PushGrant, PushRegistration},
        };
        use std::io::Read as _;

        let hub = PairedHub::start();
        let registration = PushRegistration {
            subscription: subscription("bbbb"),
            grant: PushGrant::new(vec![0x04; 65], b"{}".to_vec(), vec![1; 72]).unwrap(),
        };
        for registration in [Some(registration), None] {
            let mut paired = hub.ask(
                &hub.phone,
                hello::HubRequest::UpdatePushSubscriptionV2 { registration },
            );
            hello::read_ack(&mut paired).unwrap();
            let mut rest = Vec::new();
            let _ = paired.read_to_end(&mut rest);
            assert!(rest.is_empty(), "{} bytes followed the ack", rest.len());
            assert_eq!(hub.stored(), Some(subscription("aaaa")));
        }
    }
}
