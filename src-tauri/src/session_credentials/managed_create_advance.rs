use super::*;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedCredentialLaunch {
    pub(super) launch_id: String,
    session_id: String,
    workspace_id: String,
    provider_id: String,
    credential_id: Option<String>,
    conversation_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedCreateAdvanceCredentialIntent {
    source_launch_id: String,
    source_session_id: String,
    workspace_id: String,
    provider_id: String,
    credential_id: Option<String>,
    conversation_id: Option<String>,
}

impl PreparedCredentialLaunch {
    pub(super) fn from_input(input: &ManagedCredentialLaunch<'_>) -> Self {
        Self {
            launch_id: input.launch_id.to_string(),
            session_id: input.session_id.to_string(),
            workspace_id: input.workspace_id.to_string(),
            provider_id: input.provider_id.to_string(),
            credential_id: input.credential_id.map(str::to_string),
            conversation_id: input.conversation_id.map(str::to_string),
        }
    }
}

impl ManagedCreateAdvanceCredentialIntent {
    fn from_input(input: &ManagedCredentialLaunch<'_>) -> Self {
        Self {
            source_launch_id: input.launch_id.to_string(),
            source_session_id: input.session_id.to_string(),
            workspace_id: input.workspace_id.to_string(),
            provider_id: input.provider_id.to_string(),
            credential_id: input.credential_id.map(str::to_string),
            conversation_id: input.conversation_id.map(str::to_string),
        }
    }
}

/// Captures requested credential attribution without mutating the source
/// launch's durable record. Hmux owns successor identity, so the journal can
/// only prepare an attribution after the exact returned generation is known.
pub(crate) fn managed_create_advance_credential_intent(
    source_launch_id: &str,
    source_session_id: &str,
    workspace_id: &str,
    provider_id: &str,
    credential_id: Option<&str>,
    conversation_id: Option<&str>,
) -> Result<Option<ManagedCreateAdvanceCredentialIntent>, String> {
    if !provider_tracks_credential_conversations(provider_id) {
        return Ok(None);
    }
    let input = ManagedCredentialLaunch {
        launch_id: source_launch_id,
        session_id: source_session_id,
        workspace_id,
        provider_id,
        credential_id,
        conversation_id,
        preexisting_runtime: false,
    };
    validate_launch(&input)?;
    Ok(Some(ManagedCreateAdvanceCredentialIntent::from_input(
        &input,
    )))
}

pub(crate) fn finish_current_managed_launch(
    intent: Option<&ManagedCreateAdvanceCredentialIntent>,
    created: bool,
    descriptor: &SessionDescriptor,
) -> Result<(), String> {
    let Some(intent) = intent else {
        return Ok(());
    };
    finish_current_at(&default_root()?, intent, created, descriptor)
}

fn finish_current_at(
    root: &Path,
    intent: &ManagedCreateAdvanceCredentialIntent,
    created: bool,
    descriptor: &SessionDescriptor,
) -> Result<(), String> {
    if descriptor.session_id != intent.source_session_id
        || descriptor.workspace_id != intent.workspace_id
        || descriptor.provider_id != intent.provider_id
    {
        return Err(typed_error(
            "credential_binding_invalid_current",
            "managed create current result changed the requested source identity",
        ));
    }
    let prepared = prepare_at(
        root,
        ManagedCredentialLaunch {
            launch_id: &intent.source_launch_id,
            session_id: &descriptor.session_id,
            workspace_id: &descriptor.workspace_id,
            provider_id: &descriptor.provider_id,
            credential_id: intent.credential_id.as_deref(),
            conversation_id: intent.conversation_id.as_deref(),
            preexisting_runtime: false,
        },
    )?;
    finish_direct_at(root, &prepared, created, descriptor.into())
}

/// Commits credential attribution against Hmux's ledger-owned successor, not
/// the retired source identity that authorized the advance. The target prepare
/// and commit are independently idempotent so a lost adapter response can
/// replay the source advance and converge on the same target generation.
pub(crate) fn finish_advanced_managed_launch(
    intent: Option<&ManagedCreateAdvanceCredentialIntent>,
    target_launch_id: &str,
    descriptor: &SessionDescriptor,
) -> Result<(), String> {
    let Some(intent) = intent else {
        return Ok(());
    };
    finish_advanced_at(&default_root()?, intent, target_launch_id, descriptor)
}

fn finish_advanced_at(
    root: &Path,
    intent: &ManagedCreateAdvanceCredentialIntent,
    target_launch_id: &str,
    descriptor: &SessionDescriptor,
) -> Result<(), String> {
    if target_launch_id == intent.source_launch_id
        || descriptor.session_id == intent.source_session_id
        || descriptor.workspace_id != intent.workspace_id
        || descriptor.provider_id != intent.provider_id
    {
        return Err(typed_error(
            "credential_binding_invalid_successor",
            "managed create advance did not return one exact successor",
        ));
    }
    let target = prepare_at(
        root,
        ManagedCredentialLaunch {
            launch_id: target_launch_id,
            session_id: &descriptor.session_id,
            workspace_id: &descriptor.workspace_id,
            provider_id: &descriptor.provider_id,
            credential_id: intent.credential_id.as_deref(),
            conversation_id: intent.conversation_id.as_deref(),
            preexisting_runtime: false,
        },
    )?;
    finish_direct_at(root, &target, true, descriptor.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_client::{
        EndpointDescriptor, EndpointKind, ProcessDescriptor, ProtocolVersion, SessionClass,
        SessionLifecycle, VersionRange,
    };

    fn successor_descriptor() -> SessionDescriptor {
        SessionDescriptor {
            schema_version: 1,
            session_id: "successor-session".into(),
            session_name: None,
            workspace_id: "workspace-1".into(),
            session_class: SessionClass::Managed,
            lifecycle: SessionLifecycle::Ready,
            provider_id: "codex".into(),
            runtime_host: None,
            worktree_alias: None,
            branch: None,
            launch_program: Some("codex".into()),
            runner_principal: "runner-principal".into(),
            runner_instance: "runner-instance".into(),
            channel_epoch: "1".into(),
            host_instance_id: "successor-host".into(),
            terminal_epoch: "successor-terminal".into(),
            output_seq: "4".into(),
            host_build_version: "build-1".into(),
            supported_protocol: VersionRange {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: Vec::new(),
            retirement_policy: None,
            host_process: ProcessDescriptor {
                process_id: 1,
                start_marker: "host-process".into(),
            },
            provider_process: ProcessDescriptor {
                process_id: 2,
                start_marker: "provider-process".into(),
            },
            endpoint: EndpointDescriptor {
                kind: EndpointKind::UnixSocket,
                address: "/tmp/successor.sock".into(),
            },
            created_unix_ms: "1".into(),
            lifecycle_changed_unix_ms: "2".into(),
            exit: None,
            failure: None,
        }
    }

    #[test]
    fn advance_attributes_and_replays_the_exact_ledger_successor() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".dure");
        let source = prepare_at(
            &root,
            ManagedCredentialLaunch {
                launch_id: "source-create",
                session_id: "source-session",
                workspace_id: "workspace-1",
                provider_id: "codex",
                credential_id: Some("credential-a"),
                conversation_id: Some("conversation-1"),
                preexisting_runtime: false,
            },
        )
        .unwrap();
        let source_descriptor = SessionDescriptor {
            session_id: "source-session".into(),
            terminal_epoch: "source-terminal".into(),
            ..successor_descriptor()
        };
        finish_direct_at(&root, &source, true, (&source_descriptor).into()).unwrap();

        // Capturing B is side-effect free: the source's committed A record is
        // immutable until Hmux returns the exact successor generation.
        let intent = managed_create_advance_credential_intent(
            "source-create",
            "source-session",
            "workspace-1",
            "codex",
            Some("credential-b"),
            Some("conversation-1"),
        )
        .unwrap()
        .unwrap();
        let successor = successor_descriptor();

        // Crash after the target Prepared event but before its generation
        // commit. Replaying the source advance must finish this same target,
        // never commit the retired source or allocate another attribution.
        prepare_at(
            &root,
            ManagedCredentialLaunch {
                launch_id: "successor-create",
                session_id: "successor-session",
                workspace_id: "workspace-1",
                provider_id: "codex",
                credential_id: Some("credential-b"),
                conversation_id: Some("conversation-1"),
                preexisting_runtime: false,
            },
        )
        .unwrap();
        assert_eq!(bindings_at(&root, "codex").unwrap().len(), 1);
        finish_advanced_at(&root, &intent, "successor-create", &successor).unwrap();
        // Response loss after the target commit replays the same immutable
        // successor and must not create a second attribution era.
        finish_advanced_at(&root, &intent, "successor-create", &successor).unwrap();

        let bindings = bindings_at(&root, "codex").unwrap();
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].launch_id, "source-create");
        assert_eq!(bindings[0].credential_id.as_deref(), Some("credential-a"));
        assert_eq!(bindings[1].launch_id, "successor-create");
        assert_eq!(bindings[1].session_id, "successor-session");
        assert_eq!(bindings[1].credential_id.as_deref(), Some("credential-b"));
        assert_eq!(bindings[1].conversation_id, "conversation-1");
        assert_eq!(
            observe_at(
                &root,
                "successor-session",
                "workspace-1",
                "codex",
                "conversation-1",
                (&successor).into(),
            )
            .unwrap(),
            CredentialBindingObservationOutcome::AlreadyBound,
        );
    }

    #[test]
    fn legacy_unattributed_source_attributes_only_the_exact_successor() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".dure");
        let intent = managed_create_advance_credential_intent(
            "legacy-source-create",
            "legacy-source-session",
            "workspace-1",
            "codex",
            Some("credential-b"),
            Some("conversation-1"),
        )
        .unwrap()
        .unwrap();
        let successor = successor_descriptor();

        finish_advanced_at(&root, &intent, "successor-create", &successor).unwrap();
        finish_advanced_at(&root, &intent, "successor-create", &successor).unwrap();

        let bindings = bindings_at(&root, "codex").unwrap();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].launch_id, "successor-create");
        assert_eq!(bindings[0].session_id, "successor-session");
        assert_eq!(bindings[0].credential_id.as_deref(), Some("credential-b"));
        assert_eq!(bindings[0].conversation_id, "conversation-1");
    }

    #[test]
    fn current_result_never_rewrites_a_committed_source_credential() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".dure");
        let descriptor = SessionDescriptor {
            session_id: "source-session".into(),
            terminal_epoch: "source-terminal".into(),
            ..successor_descriptor()
        };
        let source = prepare_at(
            &root,
            ManagedCredentialLaunch {
                launch_id: "source-create",
                session_id: "source-session",
                workspace_id: "workspace-1",
                provider_id: "codex",
                credential_id: Some("credential-a"),
                conversation_id: Some("conversation-1"),
                preexisting_runtime: false,
            },
        )
        .unwrap();
        finish_direct_at(&root, &source, true, (&descriptor).into()).unwrap();
        let intent = managed_create_advance_credential_intent(
            "source-create",
            "source-session",
            "workspace-1",
            "codex",
            Some("credential-b"),
            Some("conversation-1"),
        )
        .unwrap()
        .unwrap();

        let error = finish_current_at(&root, &intent, false, &descriptor).unwrap_err();
        assert!(error.starts_with("credential_binding_idempotency_conflict:"));
        let bindings = bindings_at(&root, "codex").unwrap();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].credential_id.as_deref(), Some("credential-a"));
    }

    #[test]
    fn current_response_loss_before_credential_prepare_converges_exact_attribution() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".dure");
        let descriptor = SessionDescriptor {
            session_id: "source-session".into(),
            terminal_epoch: "source-terminal".into(),
            ..successor_descriptor()
        };
        let intent = managed_create_advance_credential_intent(
            "source-create",
            "source-session",
            "workspace-1",
            "codex",
            Some("credential-b"),
            Some("conversation-1"),
        )
        .unwrap()
        .unwrap();

        // The first adapter call created this canonical Hmux generation but
        // lost its response before credential preparation. Hmux returns the
        // same Current generation on retry.
        finish_current_at(&root, &intent, false, &descriptor).unwrap();

        let bindings = bindings_at(&root, "codex").unwrap();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].launch_id, "source-create");
        assert_eq!(bindings[0].credential_id.as_deref(), Some("credential-b"));
        assert_eq!(bindings[0].conversation_id, "conversation-1");
        assert_eq!(
            observe_at(
                &root,
                "source-session",
                "workspace-1",
                "codex",
                "conversation-1",
                (&descriptor).into(),
            )
            .unwrap(),
            CredentialBindingObservationOutcome::AlreadyBound,
        );
    }
}
