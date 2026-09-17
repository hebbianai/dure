pub(crate) use dure_session_runtime::{
    project_checkout_advance, ManagedCreateAdvanceCommandResolution, ManagedCreateRetrySameReason,
};
use hmux_client::{PermissionMode, TerminalDefaultColors};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagedCreateCommandPayload {
    #[serde(default)]
    pub(crate) replace_current: bool,
    pub(crate) idempotency_key: String,
    pub(crate) session_id: String,
    pub(crate) workspace_id: String,
    pub(crate) provider_id: String,
    pub(crate) conversation_id: Option<String>,
    pub(crate) permission_mode: PermissionMode,
    pub(crate) credential_id: Option<String>,
    pub(crate) credential_directory: Option<String>,
    pub(crate) credential_generation: Option<u64>,
    pub(crate) cwd: String,
    pub(crate) command: String,
    #[serde(default)]
    pub(crate) initial_prompt: Option<String>,
    pub(crate) rows: u16,
    pub(crate) columns: u16,
    pub(crate) terminal_env: Option<BTreeMap<String, Option<String>>>,
    pub(crate) terminal_default_colors: TerminalDefaultColors,
}

/// Explicit wire compatibility boundary for the original create commands.
/// The transparent wrapper prevents a resolution envelope from being returned
/// under a v1 command name while preserving the raw receipt JSON shape.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub(crate) struct LegacyManagedCreateReceipt<T>(T);

impl<T> LegacyManagedCreateReceipt<T> {
    pub(crate) fn new(receipt: T) -> Self {
        Self(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_create_accepts_initial_prompt_as_launch_material() {
        let payload = serde_json::json!({
            "idempotencyKey": "create-1",
            "sessionId": "session-1",
            "workspaceId": "workspace-1",
            "providerId": "codex",
            "conversationId": null,
            "permissionMode": "default",
            "credentialId": null,
            "credentialDirectory": null,
            "credentialGeneration": null,
            "cwd": "/tmp",
            "command": "codex",
            "initialPrompt": "ship it",
            "rows": 24,
            "columns": 80,
            "terminalEnv": null,
            "terminalDefaultColors": {
                "foregroundRgb": 16777215,
                "backgroundRgb": 0
            }
        });

        serde_json::from_value::<ManagedCreateCommandPayload>(payload)
            .expect("initial prompt belongs to the managed create payload");
    }

    #[test]
    fn serialization_keeps_one_exhaustive_discriminator_for_every_transport() {
        let current = ManagedCreateAdvanceCommandResolution::Current { receipt: "receipt" };
        let retry = ManagedCreateAdvanceCommandResolution::<&str>::retry_same(
            ManagedCreateRetrySameReason::Pending,
            "hmux_managed_create_pending",
            "still pending",
        );

        assert_eq!(
            serde_json::to_value(current).unwrap(),
            serde_json::json!({ "state": "current", "receipt": "receipt" })
        );
        assert_eq!(
            serde_json::to_value(retry).unwrap(),
            serde_json::json!({
                "state": "retry_same",
                "reason": "pending",
                "code": "hmux_managed_create_pending",
                "message": "still pending"
            })
        );
    }

    #[test]
    fn legacy_commands_keep_raw_receipts_while_advance_uses_an_envelope() {
        let receipt = serde_json::json!({
            "idempotencyKey": "create-1",
            "outcome": "created"
        });
        let legacy =
            serde_json::to_value(LegacyManagedCreateReceipt::new(receipt.clone())).unwrap();
        let advance =
            serde_json::to_value(ManagedCreateAdvanceCommandResolution::Advanced { receipt })
                .unwrap();

        assert_eq!(legacy["idempotencyKey"], "create-1");
        assert!(legacy.get("state").is_none());
        assert_eq!(advance["state"], "advanced");
        assert_eq!(advance["receipt"]["idempotencyKey"], "create-1");
    }
}
