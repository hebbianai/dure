#[cfg(target_os = "ios")]
use crate::hub_store;
use crate::{hub_client, CommandError};
use dure_hub_protocol::{
    frame,
    hello::HubRequest,
    push::{PushLanguage, PushPreference, PushSubscription, PushSubscriptionResult},
};
use serde::Serialize;
use std::io::{Read, Write};

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
