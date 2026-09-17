use super::RemoteHmuxCatalogSession;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteHmuxManagedCreateReceipt {
    pub(super) idempotency_key: String,
    pub(super) bridge_nonce: String,
    pub(super) outcome: &'static str,
    // Legacy clients reject extra receipt keys. They cannot request a launch
    // prompt; newer clients already interpret an omitted acceptance as false.
    #[serde(skip_serializing_if = "is_false")]
    pub(super) initial_prompt_accepted: bool,
    pub(super) session: RemoteHmuxCatalogSession,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[cfg(test)]
mod tests {
    use super::{RemoteHmuxCatalogSession, RemoteHmuxManagedCreateReceipt};
    use crate::managed_create_resolution::{
        LegacyManagedCreateReceipt, ManagedCreateAdvanceCommandResolution,
    };
    use serde::Deserialize;

    // The pre-prompt SSH client rejects unknown top-level receipt fields.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct HistoricalReceipt {
        idempotency_key: String,
        bridge_nonce: String,
        outcome: String,
        session: RemoteHmuxCatalogSession,
    }

    fn receipt(outcome: &'static str, accepted: bool) -> RemoteHmuxManagedCreateReceipt {
        RemoteHmuxManagedCreateReceipt {
            idempotency_key: "create-1".into(),
            bridge_nonce: "bridge-1".into(),
            outcome,
            initial_prompt_accepted: accepted,
            session: serde_json::from_value(serde_json::json!({
                "sessionId": "session-1",
                "workspaceId": "workspace-1",
                "sessionClass": "managed",
                "lifecycle": "ready",
                "providerId": "claude",
                "runnerPrincipal": "principal-1",
                "runnerInstance": "runner-1",
                "channelEpoch": "7",
                "hostInstanceId": "host-1",
                "terminalEpoch": "terminal-1",
                "supportedProtocol": {
                    "minimum": { "major": 1, "minor": 0 },
                    "maximum": { "major": 1, "minor": 0 }
                },
                "capabilities": ["screen_snapshot"]
            }))
            .unwrap(),
        }
    }

    #[test]
    fn legacy_remote_create_decodes_with_pre_prompt_receipt_contract() {
        for outcome in ["created", "reused"] {
            let value =
                serde_json::to_value(LegacyManagedCreateReceipt::new(receipt(outcome, false)))
                    .unwrap();
            let historical: HistoricalReceipt = serde_json::from_value(value)
                .expect("an unprompted legacy create must remain readable after Host admission");
            assert_eq!(historical.idempotency_key, "create-1");
            assert_eq!(historical.bridge_nonce, "bridge-1");
            assert_eq!(historical.outcome, outcome);
            assert_eq!(historical.session.session_id, "session-1");
            assert_eq!(historical.session.channel_epoch, "7");
        }
    }

    #[test]
    fn versioned_remote_create_preserves_prompt_acceptance() {
        let value = serde_json::to_value(ManagedCreateAdvanceCommandResolution::Current {
            receipt: receipt("created", true),
        })
        .unwrap();
        assert_eq!(value["state"], "current");
        assert_eq!(value["receipt"]["initialPromptAccepted"], true);
        assert_eq!(value["receipt"]["session"]["channelEpoch"], "7");
    }
}
