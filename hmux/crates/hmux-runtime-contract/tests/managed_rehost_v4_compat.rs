use hmux_runtime_contract::{
    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER, ManagedRehostRecipe, ManagedRehostReplacement,
    ManagedRehostRequest, PermissionMode, ProviderStateEnvironment, TerminalEnvironment,
    read_json_frame, write_json_frame,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;

// Frozen decoder/validator snapshot of the shipped managed-rehost v4 request.
// It deliberately knows nothing about provider-state removals or v5.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinnedManagedRehostV4 {
    schema: String,
    schema_version: u16,
    #[serde(default)]
    expected_target_build_id: Option<String>,
    #[serde(default)]
    replacement: Option<Value>,
}

impl PinnedManagedRehostV4 {
    fn validate(self) -> Result<(), &'static str> {
        let v1 = self.schema == "hmux-managed-rehost-v1"
            && self.schema_version == 1
            && self.replacement.is_none()
            && self.expected_target_build_id.is_none();
        let v2 = self.schema == "hmux-managed-rehost-v2"
            && self.schema_version == 2
            && self.replacement.is_some()
            && self.expected_target_build_id.is_none();
        let v3 = self.schema == "hmux-managed-rehost-v3"
            && self.schema_version == 3
            && self.replacement.is_some()
            && self.expected_target_build_id.is_some();
        let v4 = self.schema == "managed-session-replacement-v4"
            && self.schema_version == 4
            && self.replacement.is_some();
        (v1 || v2 || v3 || v4)
            .then_some(())
            .ok_or("managed rehost request has an unsupported v4 schema")
    }
}

#[test]
fn shipped_v4_decoder_rejects_provider_state_removal_before_source_stop() {
    let environment = ProviderStateEnvironment::from_mutations(
        BTreeMap::new(),
        BTreeSet::from(["CODEX_HOME".into(), "CODEX_SQLITE_HOME".into()]),
    )
    .unwrap();
    let recipe = ManagedRehostRecipe::new(
        vec![
            "codex".into(),
            "resume".into(),
            MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
        ],
        None,
    )
    .unwrap();
    let replacement = ManagedRehostReplacement::new(
        "codex",
        PermissionMode::Default,
        "/tmp/work",
        24,
        80,
        TerminalEnvironment::default(),
        None,
        environment,
        recipe,
    )
    .unwrap();
    let request = ManagedRehostRequest::new(
        "rehost-removal",
        "source-session",
        "source-workspace",
        "principal",
        "runner",
        1,
        "source-host",
        "source-terminal",
        true,
    )
    .unwrap()
    .with_replacement(replacement)
    .unwrap();

    let guarded = request
        .clone()
        .with_expected_provider_id("codex")
        .unwrap()
        .with_replacement(
            request
                .replacement()
                .unwrap()
                .clone()
                .with_fresh_command(vec!["codex".into()])
                .unwrap(),
        )
        .unwrap()
        .with_fresh_source_quiescence(
            hmux_runtime_contract::ManagedStopQuiescenceFence::new("source-terminal", 1, 0)
                .unwrap(),
        )
        .unwrap();
    guarded.validate().unwrap();
    let legacy: PinnedManagedRehostV4 =
        serde_json::from_value(serde_json::to_value(guarded).unwrap()).unwrap();
    assert!(
        legacy.validate().is_err(),
        "older brokers must refuse a guarded fresh replacement before source stop"
    );

    let mut framed = Vec::new();
    write_json_frame(&mut framed, &request).unwrap();
    let decoded: PinnedManagedRehostV4 = read_json_frame(&mut Cursor::new(framed)).unwrap();
    assert!(
        decoded.validate().is_err(),
        "the shipped v4 runtime must reject v5 before it can stop the source"
    );
}
