#[cfg(target_os = "ios")]
use crate::hub_store;
use crate::{hub_client, CommandError};
use dure_hub_protocol::{
    frame,
    hello::HubRequest,
    push::{
        PushAlertContext, PushLanguage, PushPreference, PushSubscription, PushSubscriptionResult,
    },
};
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::ipc::Channel;

/// A tapped alert, for the screen to open its agent as a tap on its row would.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushActivation {
    /// The phone's catalog key for the agent (`PushSessionId`).
    session_id: String,
}

impl PushActivation {
    /// The activation a tap on this delivered alert asks for, read from the
    /// alert's whole JSON payload. None for an alert that names no agent.
    pub fn from_payload(payload: &[u8]) -> Option<Self> {
        PushAlertContext::from_payload(payload)
            .session
            .map(|session| Self {
                session_id: session.into(),
            })
    }
}

type ActivationReceiver = Box<dyn Fn(PushActivation) -> bool + Send>;

/// Taps on alerts, between the system and the screen. A tap that launches
/// the app arrives before the WebView listens, so the latest one waits here;
/// an earlier unread tap is superseded, as only one agent can be opened.
#[derive(Default)]
pub struct PushActivations {
    inner: Mutex<(Option<PushActivation>, Option<ActivationReceiver>)>,
}

impl PushActivations {
    /// The system reported a tap.
    pub fn offer(&self, activation: PushActivation) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(receiver) = &inner.1 {
            if receiver(activation.clone()) {
                return;
            }
            // The screen that listened is gone; the next one reads this tap.
            inner.1 = None;
        }
        inner.0 = Some(activation);
    }

    /// The screen listens. A waiting tap is delivered first; a newer screen
    /// replaces an older one.
    fn listen(&self, receiver: ActivationReceiver) {
        let mut inner = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(waiting) = inner.0.take() {
            if !receiver(waiting.clone()) {
                inner.0 = Some(waiting);
                return;
            }
        }
        inner.1 = Some(receiver);
    }
}

/// The screen's channel for alert taps (`PushActivations`).
#[tauri::command]
pub fn push_activations(
    activations: tauri::State<'_, PushActivations>,
    channel: Channel<PushActivation>,
) {
    activations.listen(Box::new(move |activation| channel.send(activation).is_ok()));
}

#[derive(Serialize)]
pub struct PushSyncResult {
    supported: bool,
    outcomes: Vec<HubPushOutcome>,
}

#[derive(Serialize)]
struct HubPushOutcome {
    id: String,
    error: Option<String>,
}

pub fn update_on_stream(
    stream: &mut (impl Read + Write),
    pairing_token: &str,
    subscription: Option<PushSubscription>,
) -> Result<(), hub_client::HubClientError> {
    hub_client::handshake_for(
        stream,
        pairing_token,
        HubRequest::UpdatePushSubscriptionV1 { subscription },
    )?;
    let result: PushSubscriptionResult = frame::read(stream, 4096)
        .map_err(|error| hub_client::HubClientError::Protocol(error.to_string()))?;
    match result {
        PushSubscriptionResult::Saved => Ok(()),
        PushSubscriptionResult::Refused { detail } => {
            Err(hub_client::HubClientError::Protocol(detail))
        }
    }
}

#[cfg(target_os = "ios")]
fn synchronize(
    entry: &hub_store::HubEntry,
    subscription: Option<PushSubscription>,
) -> Result<(), hub_client::HubClientError> {
    let relay = entry
        .relay_endpoint
        .as_deref()
        .zip(entry.server_id.as_deref());
    let mut stream = hub_client::dial_tls(&entry.endpoint, relay, &entry.fingerprint)?;
    update_on_stream(&mut stream, &entry.token, subscription)
}

#[tauri::command]
pub async fn sync_push_notifications(
    app: tauri::AppHandle,
    preference: Option<PushPreference>,
    language: PushLanguage,
) -> Result<PushSyncResult, CommandError> {
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, preference, language);
        Ok(PushSyncResult {
            supported: false,
            outcomes: Vec::new(),
        })
    }
    #[cfg(target_os = "ios")]
    {
        let error = |message: String| CommandError {
            code: "push_registration_failed".into(),
            message,
        };
        let hubs = hub_store::load(&crate::hub_store_path(&app)?)?.hubs;
        let subscription = if let Some(preference) = preference {
            if hubs.is_empty() {
                return Ok(PushSyncResult {
                    supported: true,
                    outcomes: Vec::new(),
                });
            }
            let (token, environment) = crate::push_ios::register(&app).await.map_err(error)?;
            Some(PushSubscription {
                token,
                environment,
                preference,
                language,
            })
        } else {
            crate::push_ios::unregister(&app).map_err(error)?;
            None
        };
        let outcomes = tauri::async_runtime::spawn_blocking(move || {
            hubs.into_iter()
                .map(|entry| HubPushOutcome {
                    id: entry.id.clone(),
                    error: synchronize(&entry, subscription.clone())
                        .err()
                        .map(|error| error.to_string()),
                })
                .collect()
        })
        .await
        .map_err(|_| error("Push synchronization was interrupted".into()))?;
        Ok(PushSyncResult {
            supported: true,
            outcomes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_hub_protocol::{
        hello,
        push::{ApnsEnvironment, PushLanguage, PushPreference},
    };
    use std::io::Cursor;

    struct Stream {
        reply: Cursor<Vec<u8>>,
        request: Vec<u8>,
    }
    impl Read for Stream {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            self.reply.read(bytes)
        }
    }
    impl Write for Stream {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.request.write(bytes)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    fn stream(result: Option<PushSubscriptionResult>) -> Stream {
        let mut reply = hello::encode_ack("device-1", "Phone").unwrap();
        if let Some(result) = result {
            reply.extend(frame::encode(&result, 4096).unwrap());
        }
        Stream {
            reply: Cursor::new(reply),
            request: Vec::new(),
        }
    }

    #[test]
    fn registration_and_off_use_the_paired_request_without_terminal_attachment() {
        let subscription = PushSubscription {
            token: "aa12".to_string().try_into().unwrap(),
            environment: ApnsEnvironment::Sandbox,
            preference: PushPreference::Approvals,
            language: PushLanguage::Ko,
        };
        for subscription in [Some(subscription), None] {
            let mut stream = stream(Some(PushSubscriptionResult::Saved));
            update_on_stream(&mut stream, "paired-token", subscription.clone()).unwrap();
            let hello = hello::read_hello(&mut Cursor::new(stream.request)).unwrap();
            assert_eq!(hello.token, "paired-token");
            assert_eq!(
                hello.request,
                HubRequest::UpdatePushSubscriptionV1 { subscription }
            );
        }
    }

    #[test]
    fn a_tap_that_launched_the_app_waits_for_the_screen_and_the_latest_wins() {
        use std::sync::{Arc, Mutex};
        let tap = |session: &str| {
            PushActivation::from_payload(
                format!(r#"{{"aps":{{}},"dure":{{"session":"{session}"}}}}"#).as_bytes(),
            )
            .unwrap()
        };
        assert_eq!(PushActivation::from_payload(br#"{"aps":{}}"#), None);
        let activations = PushActivations::default();
        activations.offer(tap("agent-1"));
        activations.offer(tap("agent-2"));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let screen = |seen: &Arc<Mutex<Vec<String>>>, open: bool| -> ActivationReceiver {
            let seen = seen.clone();
            Box::new(move |activation: PushActivation| {
                if open {
                    seen.lock().unwrap().push(activation.session_id);
                }
                open
            })
        };
        activations.listen(screen(&seen, true));
        activations.offer(tap("agent-3"));
        assert_eq!(*seen.lock().unwrap(), ["agent-2", "agent-3"]);
        // A screen that stopped listening loses no tap: the next one reads it.
        activations.listen(screen(&seen, false));
        activations.offer(tap("agent-4"));
        activations.listen(screen(&seen, true));
        assert_eq!(*seen.lock().unwrap(), ["agent-2", "agent-3", "agent-4"]);
    }

    #[test]
    fn old_hubs_and_refused_registrations_are_not_reported_as_saved() {
        let mut old_hub = stream(None);
        assert!(update_on_stream(&mut old_hub, "paired-token", None).is_err());
        let mut refused = stream(Some(PushSubscriptionResult::Refused {
            detail: "Service unavailable".into(),
        }));
        let error = update_on_stream(&mut refused, "paired-token", None).unwrap_err();
        assert!(error.to_string().contains("Service unavailable"));
    }
}
