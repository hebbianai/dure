use hmux_runtime_contract::{
    MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION, ManagedCreateRequest, PermissionMode,
    ProviderStateEnvironment, read_json_frame, write_json_frame,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;
use std::path::PathBuf;

// Frozen decoder/validator snapshot of the shipped managed-create v2 contract
// immediately before lifecycle negotiation was added. Keep this independent
// of the current ManagedCreateRequest decoder: this test exists to catch a
// future accidental downgrade that only the new decoder would accept.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinnedManagedCreateV2 {
    schema: String,
    schema_version: u16,
    idempotency_key: String,
    session_id: String,
    workspace_id: String,
    provider_id: String,
    permission_mode: Value,
    provider_cwd: PathBuf,
    command: Vec<String>,
    initial_rows: u16,
    initial_columns: u16,
    #[serde(default = "empty_object")]
    terminal_environment: Value,
    #[serde(default = "empty_object")]
    provider_state_environment: Value,
    #[serde(default)]
    presentation_predecessor: Option<Value>,
    #[serde(default)]
    conversation_identity: Option<Value>,
}

fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

impl PinnedManagedCreateV2 {
    fn validate(self) -> Result<(), &'static str> {
        let legacy = self.schema == "hmux-managed-create-v1"
            && self.schema_version == 1
            && self
                .provider_state_environment
                .as_object()
                .is_none_or(serde_json::Map::is_empty);
        let provider_state = self.schema == "hmux-managed-create-v2"
            && self.schema_version == 2
            && self
                .provider_state_environment
                .as_object()
                .is_some_and(|environment| !environment.is_empty());
        let required_fields_are_valid = !self.idempotency_key.is_empty()
            && !self.session_id.is_empty()
            && !self.workspace_id.is_empty()
            && !self.provider_id.is_empty()
            && self.permission_mode.is_string()
            && self.provider_cwd.is_absolute()
            && !self.command.is_empty()
            && self.initial_rows > 0
            && self.initial_columns > 0
            && self.terminal_environment.is_object()
            && self
                .presentation_predecessor
                .as_ref()
                .is_none_or(Value::is_object)
            && self
                .conversation_identity
                .as_ref()
                .is_none_or(Value::is_object);
        if (legacy || provider_state) && required_fields_are_valid {
            Ok(())
        } else {
            Err("managed create request has an unsupported v2 schema")
        }
    }
}

fn decode_with_pinned_v2(request: &ManagedCreateRequest) -> Result<(), &'static str> {
    let mut framed = Vec::new();
    write_json_frame(&mut framed, request).unwrap();
    let decoded: PinnedManagedCreateV2 =
        read_json_frame(&mut Cursor::new(framed)).map_err(|_| "v2 frame decode failed")?;
    decoded.validate()
}

#[test]
fn shipped_v2_decoder_rejects_lifecycle_requirement_before_provider_launch() {
    let compatible_v2 = ManagedCreateRequest::new(
        "v2-create",
        "v2-session",
        "v2-workspace",
        "codex",
        PermissionMode::Default,
        "/tmp/work",
        vec!["codex".into()],
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(
        ProviderStateEnvironment::new(BTreeMap::from([(
            "CODEX_HOME".to_string(),
            "/tmp/codex-home".to_string(),
        )]))
        .unwrap(),
    )
    .unwrap();
    decode_with_pinned_v2(&compatible_v2).unwrap();

    let required_v3 = compatible_v2
        .with_required_managed_stop_request_version(MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION)
        .unwrap();
    let mut provider_launches = 0;
    if decode_with_pinned_v2(&required_v3).is_ok() {
        provider_launches += 1;
    }

    assert!(decode_with_pinned_v2(&required_v3).is_err());
    assert_eq!(provider_launches, 0);

    let removal_v6 = ManagedCreateRequest::new(
        "v6-create",
        "v6-session",
        "v6-workspace",
        "codex",
        PermissionMode::Default,
        "/tmp/work",
        vec!["codex".into()],
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(
        ProviderStateEnvironment::from_mutations(
            BTreeMap::new(),
            BTreeSet::from(["CODEX_HOME".into()]),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(
        decode_with_pinned_v2(&removal_v6).is_err(),
        "the shipped decoder must reject a removal before provider launch"
    );
}
