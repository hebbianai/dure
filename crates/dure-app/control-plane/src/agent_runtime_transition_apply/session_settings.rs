//! A relaunch that inherits the launch selection keeps the conversation's own
//! model and effort.
//!
//! Claude saves `/model` and `/effort` only to the running account's settings,
//! and keeps `/effort max` in the session alone. Codex saves `/model` to the
//! running account's config. Dure syncs each account's settings from the
//! canonical ones before every launch, so a successor that inherits the
//! selection would otherwise run at the defaults instead of the settings the
//! conversation last used. Both providers record those settings on each turn.

use std::path::PathBuf;

use dure_app::{
    AgentRuntimeLaunchSelectionV1, AgentRuntimeTransitionIntentV1, AgentSpawnEffortSelectionV1,
    AgentSpawnModelSelectionV1, ProviderIdV1,
};
use dure_provider_profile::transcript::{ProviderSessionSettings, read_session_settings_roots};

/// The selection a native successor launches with. An explicit target
/// selection is installed as requested; an inherited one adopts the settings
/// of the conversation's latest recorded turn, read from the history that the
/// successor resumes in `provider_home`.
pub(super) async fn successor_launch_selection(
    intent: &AgentRuntimeTransitionIntentV1,
    provider_home: Option<PathBuf>,
) -> AgentRuntimeLaunchSelectionV1 {
    let inherited = intent.effective_launch_selection();
    let (None, Some(conversation), Some(home)) = (
        &intent.target_launch_selection,
        intent.provider_conversation_ref.as_option(),
        provider_home,
    ) else {
        return inherited;
    };
    let provider = intent.source.provider_id.as_str().to_owned();
    let conversation = conversation.to_owned();
    // A provider without recorded settings, or unreadable history, leaves the
    // inherited selection unchanged.
    let observed = tokio::task::spawn_blocking(move || {
        read_session_settings_roots(
            &home.join("projects"),
            &home.join("sessions"),
            &provider,
            &conversation,
        )
    })
    .await
    .ok()
    .and_then(Result::ok)
    .unwrap_or_default();
    carry_session_settings(&intent.source.provider_id, inherited, observed)
}

fn carry_session_settings(
    provider_id: &ProviderIdV1,
    inherited: AgentRuntimeLaunchSelectionV1,
    observed: ProviderSessionSettings,
) -> AgentRuntimeLaunchSelectionV1 {
    let model = observed
        .model
        .as_deref()
        .and_then(|model| AgentSpawnModelSelectionV1::parse(model).ok())
        .or(inherited.model);
    let observed_effort = observed
        .effort
        .as_deref()
        .and_then(|effort| AgentSpawnEffortSelectionV1::parse(effort).ok());
    // A selection that already runs at the recorded level, such as Claude's
    // `ultracode` at `xhigh`, is kept with what it adds beyond that level.
    let effort = match (inherited.effort, observed_effort) {
        (Some(inherited), Some(observed))
            if dure_provider_adapter::native_provider_effort_level(provider_id, &inherited)
                == observed.as_str() =>
        {
            Some(inherited)
        }
        (inherited, observed) => observed.or(inherited),
    };
    AgentRuntimeLaunchSelectionV1 {
        model,
        effort,
        permission_mode: inherited.permission_mode,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_app::{
        AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
        AgentCheckpointBindingAuthorityV1, AgentExecutionProfileV1, AgentIdV1,
        AgentInteractionProfileV1, AgentProviderConversationPlanV1, AgentRuntimeBindingAuthorityV1,
        AgentRuntimeSelectionV1, AgentRuntimeSourceStopPolicyV1, OperationIdV1,
        ProviderPermissionModeV1, RuntimeKindIdV1, SessionBindingRecordV1,
    };

    const CONVERSATION: &str = "019f0000-0000-7000-8000-000000000287";

    fn selection(model: Option<&str>, effort: Option<&str>) -> AgentRuntimeLaunchSelectionV1 {
        AgentRuntimeLaunchSelectionV1 {
            model: model.map(|model| AgentSpawnModelSelectionV1::parse(model).unwrap()),
            effort: effort.map(|effort| AgentSpawnEffortSelectionV1::parse(effort).unwrap()),
            permission_mode: None,
        }
    }

    fn observed(model: Option<&str>, effort: Option<&str>) -> ProviderSessionSettings {
        ProviderSessionSettings {
            model: model.map(str::to_owned),
            effort: effort.map(str::to_owned),
        }
    }

    /// An account switch: the target profile changes and the selection is
    /// inherited from a source that was launched with `source` settings.
    fn account_switch(
        provider: &str,
        source: AgentRuntimeLaunchSelectionV1,
    ) -> AgentRuntimeTransitionIntentV1 {
        let agent_id = AgentIdV1::new("agent-1").unwrap();
        let intent = AgentRuntimeTransitionIntentV1 {
            schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
            operation_id: OperationIdV1::new("runtime-transition-1").unwrap(),
            idempotency_key: "account-switch".into(),
            source: AgentRuntimeSelectionV1 {
                schema_version: AGENT_RUNTIME_TRANSITION_SCHEMA_VERSION_V1,
                agent_id: agent_id.clone(),
                provider_id: ProviderIdV1::new(provider).unwrap(),
                interaction_profile: AgentInteractionProfileV1::NativeCli,
                execution_profile: AgentExecutionProfileV1::ProviderDefault,
                permission_mode: ProviderPermissionModeV1::Default,
                model: source.model,
                effort: source.effort,
                revision: 1,
                selected_by_operation_id: None,
                updated_at_ms: 1,
            },
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: AgentCheckpointBindingAuthorityV1 {
                    schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
                    binding: SessionBindingRecordV1 {
                        agent_id,
                        runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                        session_id: "session-1".into(),
                        provider_conversation_id: Some(CONVERSATION.into()),
                        credential_reference_id: None,
                        binding_generation: 1,
                        bound_at_ms: 1,
                    },
                    runtime_workspace_id: "workspace-1".into(),
                    runner_principal: "runner-principal-1".into(),
                    runner_instance: "runner-instance-1".into(),
                    channel_epoch: "1".into(),
                    host_instance_id: "host-instance-1".into(),
                    terminal_epoch: "terminal-epoch-1".into(),
                    updated_at_ms: 1,
                },
            },
            source_stop_policy: AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: AgentProviderConversationPlanV1::resume(CONVERSATION)
                .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            target_execution_profile: AgentExecutionProfileV1::CredentialReference {
                reference_id: "work".into(),
                credential_generation: Some("generation-1".into()),
            },
            target_launch_selection: None,
            workspace_move: None,
            requested_at_ms: 2,
        };
        intent.validate().unwrap();
        intent
    }

    fn write_claude_turn(home: &std::path::Path, model: &str, effort: &str) {
        let project = home.join("projects/project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join(format!("{CONVERSATION}.jsonl")),
            format!(
                "{}\n",
                serde_json::json!({"type": "assistant", "requestedModel": model,
                    "effort": effort, "message": {"model": model, "content": "ok"}})
            ),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn account_switch_keeps_an_in_session_model_and_effort_change() {
        let home = tempfile::tempdir().unwrap();
        // Launched on the account's defaults, then `/model` and `/effort` in session.
        write_claude_turn(home.path(), "claude-sonnet-5-5", "low");
        for launched in [selection(None, None), selection(Some("opus"), Some("high"))] {
            let intent = account_switch("claude", launched);
            assert_eq!(
                successor_launch_selection(&intent, Some(home.path().into())).await,
                selection(Some("claude-sonnet-5-5"), Some("low"))
            );
        }
    }

    #[tokio::test]
    async fn an_explicit_target_or_missing_history_installs_the_selection_unchanged() {
        let home = tempfile::tempdir().unwrap();
        let mut intent = account_switch("claude", selection(Some("opus"), Some("high")));
        assert_eq!(
            successor_launch_selection(&intent, Some(home.path().into())).await,
            selection(Some("opus"), Some("high"))
        );
        write_claude_turn(home.path(), "claude-sonnet-5-5", "low");
        intent.target_launch_selection = Some(selection(None, Some("medium")));
        assert_eq!(
            successor_launch_selection(&intent, Some(home.path().into())).await,
            selection(None, Some("medium"))
        );
        // A provider whose turns record no settings keeps its selection.
        let other = account_switch("kimi", selection(Some("kimi-k2"), None));
        assert_eq!(
            successor_launch_selection(&other, Some(home.path().into())).await,
            selection(Some("kimi-k2"), None)
        );
    }

    #[test]
    fn recorded_settings_replace_inherited_ones_field_by_field() {
        let claude = ProviderIdV1::new("claude").unwrap();
        let carry = |inherited, observed| carry_session_settings(&claude, inherited, observed);
        assert_eq!(
            carry(
                selection(Some("opus"), Some("high")),
                observed(None, Some("max"))
            ),
            selection(Some("opus"), Some("max"))
        );
        assert_eq!(
            carry(
                selection(None, Some("high")),
                observed(Some("claude-opus-5-5[1m]"), None)
            ),
            selection(Some("claude-opus-5-5[1m]"), Some("high"))
        );
        // A value that is not a valid selection token is not carried.
        assert_eq!(
            carry(
                selection(None, Some("high")),
                observed(Some("-x"), Some("x y"))
            ),
            selection(None, Some("high"))
        );
        // Ultracode records its turns at xhigh and keeps its own setting.
        assert_eq!(
            carry(
                selection(None, Some("ultracode")),
                observed(None, Some("xhigh"))
            ),
            selection(None, Some("ultracode"))
        );
        assert_eq!(
            carry(
                selection(None, Some("ultracode")),
                observed(None, Some("low"))
            ),
            selection(None, Some("low"))
        );
        let codex = ProviderIdV1::new("codex").unwrap();
        assert_eq!(
            carry_session_settings(
                &codex,
                selection(None, None),
                observed(Some("gpt-6-astra"), Some("low"))
            ),
            selection(Some("gpt-6-astra"), Some("low"))
        );
    }
}
