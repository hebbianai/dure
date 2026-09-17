//! Paired-device delivery. The notification service alone owns APNs credentials
//! and deduplication; the existing registry owns consent and token replacement.
use super::{commands::HubState, identity};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use dure_hub_protocol::push::{PushKind, PushSubscription};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SIGNING_CONTEXT: &[u8] = b"dure-push-request-v1\0";
static SEND_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PushEvent {
    kind: PushKind,
    event_id: String,
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

fn endpoint() -> Result<reqwest::Url, String> {
    let endpoint = std::env::var("DURE_PUSH_ENDPOINT")
        .map_err(|_| "This computer has no configured push service")?;
    let url = reqwest::Url::parse(&endpoint).map_err(|_| "Invalid push service endpoint")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "The push service requires HTTPS without URL credentials or query parameters".into(),
        );
    }
    Ok(url)
}

/// Report delivery readiness separately from the device's latest consent.
/// A provider outage must never retain an older, more permissive preference.
pub(super) fn update_subscription(
    registry: &super::devices::DeviceRegistry,
    token: &str,
    subscription: Option<PushSubscription>,
    check: impl FnOnce(&PushSubscription) -> Result<(), String>,
) -> Result<(), String> {
    registry
        .set_push(token, subscription.clone())
        .map_err(|e| e.to_string())?;
    subscription.as_ref().map_or(Ok(()), check)
}

pub(super) fn check_registration(
    registry: &super::devices::DeviceRegistry,
    subscription: &PushSubscription,
) -> Result<(), String> {
    let url = endpoint()?
        .join("register")
        .map_err(|_| "Invalid push registration endpoint")?;
    let certificate =
        identity::load_or_create_certificate(registry.root()).map_err(|e| e.to_string())?;
    let issued_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Could not read the notification clock")?
        .as_secs();
    let request = sign_request(&certificate, subscription, None, issued_at)?;
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not create push transport")?
        .post(url)
        .json(&request)
        .send()
        .map_err(|_| "Could not reach the push service. Push is not ready.")?;
    if response.status().as_u16() != 200 {
        return Err(format!(
            "Push service refused registration ({})",
            response.status().as_u16()
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn hub_push_agent_notification(
    app: tauri::AppHandle,
    state: tauri::State<'_, HubState>,
    event: PushEvent,
) -> Result<(), String> {
    if event.event_id.is_empty() || event.event_id.len() > 512 {
        return Err("Invalid notification event identity".into());
    }
    let registry = state.registry(&app)?;
    let recipients = registry.load().map_err(|error| error.to_string())?;
    if !recipients
        .iter()
        .any(|device| device.push.as_ref().is_some_and(|s| s.accepts(event.kind)))
    {
        return Ok(());
    }
    // Distinct simultaneous episodes wait for transport capacity; capacity
    // never acts as a time throttle that silently drops their event IDs.
    let _slot = SEND_SLOTS
        .acquire()
        .await
        .map_err(|_| "Phone notification delivery stopped")?;
    let url = endpoint()?;
    let certificate =
        identity::load_or_create_certificate(registry.root()).map_err(|error| error.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Could not create push transport")?;
    let mut failure = None;
    for device in recipients {
        let Some(subscription) = device.push.filter(|s| s.accepts(event.kind)) else {
            continue;
        };
        // A queued send cannot outlive revocation or a newer preference/token.
        let current = registry.load().map_err(|error| error.to_string())?;
        if !current
            .iter()
            .any(|d| d.device_id == device.device_id && d.push.as_ref() == Some(&subscription))
        {
            continue;
        }
        let issued_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "Could not read the notification clock")?
            .as_secs();
        let request = sign_request(&certificate, &subscription, Some(&event), issued_at)?;
        let response = match client.post(url.clone()).json(&request).send().await {
            Ok(response) => response,
            Err(_) => {
                failure = Some("Could not reach the phone notification service".to_string());
                continue;
            }
        };
        match response.status().as_u16() {
            200 | 202 => (),
            410 => registry
                .retire_push(&device.device_id, &subscription)
                .map_err(|error| error.to_string())?,
            status => {
                failure = Some(format!(
                    "Phone notification service refused delivery ({status})"
                ))
            }
        }
    }
    failure.map_or(Ok(()), Err)
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
            update_subscription(&registry, &phone.token, Some(current.clone()), |_| Err(
                "Provider offline".into()
            ))
            .is_err()
        );
        assert_eq!(registry.load().unwrap()[0].push, Some(current.clone()));
        update_subscription(&registry, &phone.token, Some(current), |_| {
            registry.revoke(&phone.device_id).unwrap();
            Ok(())
        })
        .unwrap();
        assert!(registry.load().unwrap().is_empty());
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

    #[test]
    fn paired_tls_off_removes_consent_even_without_a_push_service() {
        use crate::hub::{
            catalog::{HubCatalog, HUB_CATALOG_VERSION},
            server::{CatalogSource, HubServer, HubServices},
        };
        use dure_hub_protocol::{frame, hello, push::PushSubscriptionResult};
        use std::{net::TcpStream, sync::Arc};

        struct Catalog;
        impl CatalogSource for Catalog {
            fn catalog(&self) -> HubCatalog {
                HubCatalog {
                    hub_catalog_version: HUB_CATALOG_VERSION,
                    layout: None,
                    sessions: vec![],
                    unreachable: vec![],
                }
            }
        }
        let _ = rustls::crypto::ring::default_provider().install_default();
        let root = tempfile::tempdir().unwrap();
        let certificate = identity::load_or_create_certificate(root.path()).unwrap();
        let registry = Arc::new(super::super::devices::DeviceRegistry::new(root.path()));
        let phone = registry.register("Phone".into()).unwrap();
        registry
            .set_push(&phone.token, Some(subscription("aaaa")))
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
        let connect = || {
            let socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            rustls::StreamOwned::new(
                rustls::ClientConnection::new(
                    config.clone(),
                    "hebbian-hub.local".try_into().unwrap(),
                )
                .unwrap(),
                socket,
            )
        };
        // An unpaired peer cannot remove or replace another device's consent.
        let mut unpaired = connect();
        unpaired
            .write_all(
                &hello::encode_hello_for(
                    "unregistered-token",
                    hello::HubRequest::UpdatePushSubscriptionV1 { subscription: None },
                )
                .unwrap(),
            )
            .unwrap();
        unpaired.flush().unwrap();
        assert!(hello::read_ack(&mut unpaired).is_err());
        assert!(registry.load().unwrap()[0].push.is_some());

        let mut paired = connect();
        paired
            .write_all(
                &hello::encode_hello_for(
                    &phone.token,
                    hello::HubRequest::UpdatePushSubscriptionV1 { subscription: None },
                )
                .unwrap(),
            )
            .unwrap();
        paired.flush().unwrap();
        hello::read_ack(&mut paired).unwrap();
        let result: PushSubscriptionResult = frame::read(&mut paired, 4096).unwrap();
        assert_eq!(result, PushSubscriptionResult::Saved);
        assert!(registry.load().unwrap()[0].push.is_none());
        server.stop();
    }
}
