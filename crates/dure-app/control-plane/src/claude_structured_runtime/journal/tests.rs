use super::*;
use crate::claude_sdk_host_client::{ClaudeDch1HostIdentity, ClaudeDch1ProviderRetirementPhase};
use dure_app::{
    AgentExecutionProfileV1, AgentIdV1, AgentProviderRuntimeFenceV1, AgentTimelineEpochV1,
    ProviderIdV1,
};
use hmux_client::{
    EndpointDescriptor, EndpointKind, ProcessDescriptor, ProtocolVersion, SessionClass,
    SessionLifecycle, VersionRange,
};

fn binding() -> AgentInteractionBindingV1 {
    AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-journal").unwrap(),
        agent_id: AgentIdV1::new("agent-journal").unwrap(),
        provider_id: ProviderIdV1::new("claude").unwrap(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-journal".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-journal".into(),
            provider_epoch: "query-journal".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-journal").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 1,
        updated_at_ms: 1,
    }
}

fn prepared() -> ClaudeRuntimeLaunchJournalV1 {
    ClaudeRuntimeLaunchJournalV1::prepared(
        &binding(),
        "workspace-journal",
        Path::new("/tmp/workspace-journal"),
        "relay-journal",
        "session-journal",
        None,
    )
}

fn descriptor() -> SessionDescriptor {
    SessionDescriptor {
        schema_version: 1,
        session_id: "session-journal".into(),
        session_name: None,
        workspace_id: "workspace-journal".into(),
        session_class: SessionClass::Managed,
        lifecycle: SessionLifecycle::Ready,
        provider_id: "claude".into(),
        runtime_host: None,
        worktree_alias: None,
        branch: None,
        launch_program: None,
        runner_principal: "principal-journal".into(),
        runner_instance: "runner-journal".into(),
        channel_epoch: "1".into(),
        host_instance_id: "host-journal".into(),
        terminal_epoch: "terminal-journal".into(),
        output_seq: "0".into(),
        host_build_version: "build-journal".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 0 },
        },
        capabilities: Vec::new(),
        retirement_policy: None,
        host_process: ProcessDescriptor {
            process_id: 1,
            start_marker: "host-process-journal".into(),
        },
        provider_process: ProcessDescriptor {
            process_id: 2,
            start_marker: "provider-process-journal".into(),
        },
        endpoint: EndpointDescriptor {
            kind: EndpointKind::UnixSocket,
            address: "unused.sock".into(),
        },
        created_unix_ms: "1".into(),
        lifecycle_changed_unix_ms: "1".into(),
        exit: None,
        failure: None,
    }
}

#[test]
fn normalization_checkpoint_atomically_requires_the_exact_descriptor() {
    let root = tempfile::tempdir().unwrap();
    let mut invalid = prepared();
    invalid.failure_cleanup_pending(
        ClaudeStructuredRecordedFailureV1::ManagedCreateNormalizationRequired,
    );
    assert_eq!(
        write_journal(root.path(), &invalid).unwrap_err(),
        ClaudeStructuredRuntimeErrorV1::JournalFailed
    );

    let mut journal = prepared();
    let expected = descriptor();
    journal.normalization_cleanup_pending(expected.clone());
    write_journal(root.path(), &journal).unwrap();

    let persisted: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("launch.json")).unwrap()).unwrap();
    assert_eq!(persisted["schemaVersion"], 6);

    let recovered = read_journal(root.path()).unwrap();
    assert_eq!(
        recovered.state(),
        ClaudeRuntimeLaunchStateV1::FailureCleanupPending
    );
    assert_eq!(recovered.descriptor(), Some(&expected));
    assert_eq!(
        recovered.failure(),
        Some(&ClaudeStructuredRecordedFailureV1::ManagedCreateNormalizationRequired)
    );
}

#[test]
fn prepared_stop_checkpoint_preserves_the_reconciled_descriptor_if_present() {
    let root = tempfile::tempdir().unwrap();
    let mut journal = prepared();
    let expected = descriptor();
    journal.stop_cleanup_pending(Some(expected.clone()));
    write_journal(root.path(), &journal).unwrap();

    let persisted: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("launch.json")).unwrap()).unwrap();
    assert_eq!(persisted["schemaVersion"], 6);

    let recovered = read_journal(root.path()).unwrap();
    assert_eq!(
        recovered.state(),
        ClaudeRuntimeLaunchStateV1::StopCleanupPending
    );
    assert_eq!(recovered.descriptor(), Some(&expected));
    assert_eq!(recovered.failure(), None);

    let mut mislabeled = persisted;
    mislabeled["schemaVersion"] = 5.into();
    fs::write(
        root.path().join("launch.json"),
        serde_json::to_vec(&mislabeled).unwrap(),
    )
    .unwrap();
    assert_eq!(
        read_journal(root.path()).unwrap_err(),
        ClaudeStructuredRuntimeErrorV1::JournalFailed,
    );

    let absent_root = tempfile::tempdir().unwrap();
    let mut absent = prepared();
    absent.stop_cleanup_pending(None);
    write_journal(absent_root.path(), &absent).unwrap();
    let recovered_absent = read_journal(absent_root.path()).unwrap();
    assert_eq!(
        recovered_absent.state(),
        ClaudeRuntimeLaunchStateV1::StopCleanupPending
    );
    assert_eq!(recovered_absent.descriptor(), None);
}

#[test]
fn schema_five_journals_without_schema_six_states_remain_readable() {
    let root = tempfile::tempdir().unwrap();
    let mut legacy = serde_json::to_value(prepared()).unwrap();
    legacy["schemaVersion"] = 5.into();
    let path = root.path().join("launch.json");
    fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

    let recovered = read_journal(root.path()).unwrap();
    assert_eq!(recovered.state(), ClaudeRuntimeLaunchStateV1::Prepared);
}

#[test]
fn advanced_managed_create_identity_round_trips_and_old_journals_default_to_source() {
    let root = tempfile::tempdir().unwrap();
    let mut journal = prepared();
    let mut successor = descriptor();
    successor.session_id = "session-journal-successor".into();
    let identity = ClaudeManagedCreateIdentityV1::new(
        "session-journal",
        "create-journal",
        &successor.session_id,
        "create-journal-successor",
    )
    .unwrap();
    journal.relay_ready_with_managed_identity(successor.clone(), identity);
    write_journal(root.path(), &journal).unwrap();

    let persisted: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("launch.json")).unwrap()).unwrap();
    assert_eq!(persisted["schemaVersion"], 7);
    assert_eq!(
        persisted["managedCreateIdentity"]["effectiveSessionId"],
        successor.session_id,
    );

    let recovered = read_journal(root.path()).unwrap();
    assert!(recovered.matches(
        &binding(),
        "workspace-journal",
        Path::new("/tmp/workspace-journal"),
        "relay-journal",
        "session-journal",
        "create-journal",
    ));
    assert_eq!(
        recovered.effective_managed_create_identity("session-journal", "create-journal",),
        ("session-journal-successor", "create-journal-successor"),
    );

    let (next_source_session, next_source_create) =
        recovered.effective_managed_create_identity("session-journal", "create-journal");
    assert_eq!(
        (next_source_session, next_source_create),
        ("session-journal-successor", "create-journal-successor"),
        "the durable effective identity is the next advance source",
    );
    let mut second_successor = successor.clone();
    second_successor.session_id = "session-journal-successor-2".into();
    let second_identity = ClaudeManagedCreateIdentityV1::new(
        "session-journal",
        "create-journal",
        &second_successor.session_id,
        "create-journal-successor-2",
    )
    .unwrap();
    let mut chained = recovered.clone();
    chained.relay_ready_with_managed_identity(second_successor, second_identity);
    write_journal(root.path(), &chained).unwrap();
    let reopened = read_journal(root.path()).unwrap();
    assert_eq!(
        reopened.effective_managed_create_identity("session-journal", "create-journal"),
        ("session-journal-successor-2", "create-journal-successor-2"),
        "a second restart resolves the second successor while retaining the canonical root",
    );
    assert!(!recovered.matches(
        &binding(),
        "workspace-journal",
        Path::new("/tmp/workspace-journal"),
        "relay-journal",
        "session-journal-other",
        "create-journal",
    ));

    let legacy = prepared();
    assert_eq!(
        legacy.effective_managed_create_identity("session-journal", "create-journal",),
        ("session-journal", "create-journal"),
    );
}

#[test]
fn schema_seven_preserves_and_consumes_the_exact_provider_predecessor() {
    let predecessor = ClaudeDch1QueryIdentity {
        runtime_generation: "runtime-predecessor".into(),
        query_epoch: "query-predecessor".into(),
        relay_id: "relay-predecessor".into(),
    };
    let mut journal = ClaudeRuntimeLaunchJournalV1::prepared(
        &binding(),
        "workspace-journal",
        Path::new("/tmp/workspace-journal"),
        "relay-journal",
        "session-journal",
        Some(predecessor.clone()),
    );
    let mut successor = descriptor();
    successor.session_id = "session-journal-successor".into();
    journal.relay_ready_with_managed_identity(
        successor,
        ClaudeManagedCreateIdentityV1::new(
            "session-journal",
            "create-journal",
            "session-journal-successor",
            "create-journal-successor",
        )
        .unwrap(),
    );

    let root = tempfile::tempdir().unwrap();
    write_journal(root.path(), &journal).unwrap();
    let mut recovered = read_journal(root.path()).unwrap();
    assert_eq!(recovered.provider_predecessor(), Some(&predecessor));
    recovered.consume_provider_predecessor();
    assert_eq!(recovered.provider_predecessor(), None);
}

#[test]
fn schema_seven_without_effective_identity_fails_closed() {
    let root = tempfile::tempdir().unwrap();
    let mut value = serde_json::to_value(prepared()).unwrap();
    value["schemaVersion"] = 7.into();
    let target = root.path().join("launch.json");
    fs::write(&target, serde_json::to_vec(&value).unwrap()).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();

    assert_eq!(
        read_journal(root.path()).unwrap_err(),
        ClaudeStructuredRuntimeErrorV1::JournalFailed,
    );
}

#[test]
fn managed_identity_checkpoint_failure_preserves_prepared_replay_source() {
    let root = tempfile::tempdir().unwrap();
    let source = prepared();
    write_journal(root.path(), &source).unwrap();
    let mut target = source.clone();
    let mut target_descriptor = descriptor();
    target_descriptor.session_id = "session-journal-successor".into();
    target.relay_ready_with_managed_identity(
        target_descriptor,
        ClaudeManagedCreateIdentityV1::new(
            "session-journal",
            "create-journal",
            "session-journal-successor",
            "create-journal-successor",
        )
        .unwrap(),
    );

    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o500)).unwrap();
    assert_eq!(
        write_journal(root.path(), &target).unwrap_err(),
        ClaudeStructuredRuntimeErrorV1::JournalFailed,
    );
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let replay = read_journal(root.path()).unwrap();
    assert_eq!(replay.state(), ClaudeRuntimeLaunchStateV1::Prepared);
    assert_eq!(
        replay.effective_managed_create_identity("session-journal", "create-journal"),
        ("session-journal", "create-journal"),
    );

    write_journal(root.path(), &target).unwrap();
    let recovered = read_journal(root.path()).unwrap();
    assert_eq!(
        recovered.effective_managed_create_identity("session-journal", "create-journal"),
        ("session-journal-successor", "create-journal-successor"),
    );
}

#[test]
fn typed_failure_round_trips_without_a_parallel_legacy_code() {
    let root = tempfile::tempdir().unwrap();
    let mut journal = prepared();
    journal.failure_cleanup_pending(ClaudeStructuredRecordedFailureV1::HostAttach {
        reason: "bind_remote_internal_error".into(),
        detail: None,
    });
    journal.failure_cleanup_completed();

    write_journal(root.path(), &journal).unwrap();

    let recovered = read_journal(root.path()).unwrap();
    assert_eq!(recovered.state(), ClaudeRuntimeLaunchStateV1::Failed);
    assert_eq!(recovered.failure(), journal.failure());
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(root.path().join("launch.json")).unwrap()).unwrap();
    assert_eq!(value["schemaVersion"], 6);
    assert_eq!(value["failure"]["kind"], "host_attach");
    assert_eq!(value["failure"]["reason"], "bind_remote_internal_error");
    assert!(value.get("failureCode").is_none());
}

#[test]
fn query_retirement_and_its_successor_are_one_typed_authority() {
    let root = tempfile::tempdir().unwrap();
    let mut journal = prepared();
    let source_identity = journal.query_identity();
    let authority = ClaudeDch1ProviderRetirementAuthority {
        source: source_identity.clone(),
        allowed_target: None,
        source_host: ClaudeDch1HostIdentity {
            host_generation: "host-journal".into(),
            host_instance_id: "instance-journal".into(),
        },
        target_host: None,
        phase: ClaudeDch1ProviderRetirementPhase::Retired,
    };
    journal.query_retired(authority.clone());
    write_journal(root.path(), &journal).unwrap();

    let recovered = read_journal(root.path()).unwrap();
    assert_eq!(recovered.state(), ClaudeRuntimeLaunchStateV1::QueryRetired);
    assert_eq!(recovered.retirement_authority(), Some(&authority));

    let replacement = ClaudeRuntimeLaunchJournalV1::prepared(
        &binding(),
        "workspace-journal",
        Path::new("/tmp/workspace-journal"),
        "relay-journal-2",
        "session-journal-2",
        Some(source_identity.clone()),
    );
    assert_eq!(replacement.replaces(), Some(&source_identity));
    assert_eq!(replacement.retirement_authority(), None);

    let mut legacy = serde_json::to_value(journal).unwrap();
    legacy["schemaVersion"] = 3.into();
    fs::write(
        root.path().join("launch.json"),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    assert_eq!(
        read_journal(root.path()).unwrap_err(),
        ClaudeStructuredRuntimeErrorV1::JournalFailed,
    );
}

#[test]
fn legacy_v4_in_flight_source_and_target_preserve_exact_lineage_for_reconciliation() {
    let source_root = tempfile::tempdir().unwrap();
    let mut source = serde_json::to_value(prepared()).unwrap();
    source["schemaVersion"] = 4.into();
    source["state"] = "query_retired".into();
    source["retainRetirementFence"] = true.into();
    let source_path = source_root.path().join("launch.json");
    fs::write(&source_path, serde_json::to_vec(&source).unwrap()).unwrap();
    fs::set_permissions(&source_path, fs::Permissions::from_mode(0o600)).unwrap();
    let source = read_journal(source_root.path()).unwrap();
    assert_eq!(source.state(), ClaudeRuntimeLaunchStateV1::QueryRetired);
    assert_eq!(source.retirement_authority(), None);
    assert!(source.has_legacy_retirement_proof());
    assert!(source.has_legacy_successor_retirement_proof());

    let target_root = tempfile::tempdir().unwrap();
    let source_identity = source.query_identity();
    let target = ClaudeRuntimeLaunchJournalV1::prepared(
        &binding(),
        "workspace-journal",
        Path::new("/tmp/workspace-journal"),
        "relay-journal-2",
        "session-journal-2",
        Some(source_identity.clone()),
    );
    let mut target = serde_json::to_value(target).unwrap();
    target["schemaVersion"] = 4.into();
    target["providerReplacementFence"] = true.into();
    let target_path = target_root.path().join("launch.json");
    fs::write(&target_path, serde_json::to_vec(&target).unwrap()).unwrap();
    fs::set_permissions(&target_path, fs::Permissions::from_mode(0o600)).unwrap();
    let target = read_journal(target_root.path()).unwrap();
    assert_eq!(target.replaces(), Some(&source_identity));
    assert_eq!(target.provider_predecessor(), Some(&source_identity));
    assert_eq!(target.retirement_authority(), None);
    let target_authority = ClaudeDch1ProviderRetirementAuthority {
        source: target.query_identity(),
        allowed_target: None,
        source_host: ClaudeDch1HostIdentity {
            host_generation: "host-target".into(),
            host_instance_id: "instance-target".into(),
        },
        target_host: None,
        phase: ClaudeDch1ProviderRetirementPhase::Retired,
    };
    let mut provider_target = target.clone();
    provider_target.set_retirement_authority(target_authority.clone());
    assert_eq!(
        provider_target.provider_predecessor(),
        Some(&source_identity),
        "a positive v4 provider fence remains the predecessor of a retired failed target",
    );

    let target_root = tempfile::tempdir().unwrap();
    let mut target = serde_json::to_value(target).unwrap();
    target["providerReplacementFence"] = false.into();
    let target_path = target_root.path().join("launch.json");
    fs::write(&target_path, serde_json::to_vec(&target).unwrap()).unwrap();
    fs::set_permissions(&target_path, fs::Permissions::from_mode(0o600)).unwrap();
    let mut target = read_journal(target_root.path()).unwrap();
    assert_eq!(target.replaces(), Some(&source_identity));
    assert_eq!(target.provider_predecessor(), None);
    target.set_retirement_authority(target_authority);
    assert_eq!(target.replaces(), None);
    assert_eq!(target.provider_predecessor(), None);
}

#[test]
fn direct_stop_never_promotes_v4_journal_ancestry_into_a_provider_predecessor() {
    let ancestry = ClaudeDch1QueryIdentity {
        runtime_generation: "runtime-ancestry".into(),
        query_epoch: "query-ancestry".into(),
        relay_id: "relay-ancestry".into(),
    };
    let mut value = serde_json::to_value(ClaudeRuntimeLaunchJournalV1::prepared(
        &binding(),
        "workspace-journal",
        Path::new("/tmp/workspace-journal"),
        "relay-current",
        "session-current",
        Some(ancestry),
    ))
    .unwrap();
    value["schemaVersion"] = 4.into();
    value["state"] = "attached".into();
    value["providerReplacementFence"] = false.into();
    let mut journal: ClaudeRuntimeLaunchJournalV1 = serde_json::from_value(value).unwrap();
    journal.query_retired(ClaudeDch1ProviderRetirementAuthority {
        source: journal.query_identity(),
        allowed_target: None,
        source_host: ClaudeDch1HostIdentity {
            host_generation: "host-current".into(),
            host_instance_id: "instance-current".into(),
        },
        target_host: None,
        phase: ClaudeDch1ProviderRetirementPhase::Retired,
    });
    journal.stopped();

    assert_eq!(journal.replaces(), None);
    assert_eq!(journal.provider_predecessor(), None);
}

#[test]
fn provider_successor_lineage_distinguishes_new_target_from_finalize_retry_cuts() {
    let mut source = prepared();
    let source_identity = source.query_identity();
    let target = ClaudeDch1QueryIdentity {
        runtime_generation: "runtime-successor".into(),
        query_epoch: "query-successor".into(),
        relay_id: "relay-successor".into(),
    };
    let mut authority = ClaudeDch1ProviderRetirementAuthority {
        source: source_identity.clone(),
        allowed_target: Some(target.clone()),
        source_host: ClaudeDch1HostIdentity {
            host_generation: "host-source".into(),
            host_instance_id: "instance-source".into(),
        },
        target_host: None,
        phase: ClaudeDch1ProviderRetirementPhase::Retired,
    };
    source.query_retired(authority.clone());
    source.stopped();
    assert_eq!(
        source.provider_predecessor_for_new_target().unwrap(),
        Some(source_identity.clone()),
    );
    assert!(source.accepts_existing_target_predecessor(&target, Some(&source_identity)));

    authority.phase = ClaudeDch1ProviderRetirementPhase::TargetBound;
    authority.target_host = Some(ClaudeDch1HostIdentity {
        host_generation: "host-target".into(),
        host_instance_id: "instance-target".into(),
    });
    source.set_retirement_authority(authority.clone());
    assert_eq!(
        source.provider_predecessor_for_new_target().unwrap_err(),
        ClaudeStructuredRuntimeErrorV1::RuntimeConflict,
    );
    assert!(source.accepts_existing_target_predecessor(&target, Some(&source_identity)));
    assert!(!source.accepts_existing_target_predecessor(&target, None));

    authority.phase = ClaudeDch1ProviderRetirementPhase::Released;
    source.set_retirement_authority(authority);
    assert_eq!(
        source.provider_predecessor_for_new_target().unwrap_err(),
        ClaudeStructuredRuntimeErrorV1::RuntimeConflict,
        "a released authority with an authorized target cannot create another target",
    );
    assert!(source.accepts_existing_target_predecessor(&target, Some(&source_identity)));
    assert!(source.accepts_existing_target_predecessor(&target, None));

    let mut directly_stopped = prepared();
    directly_stopped.query_retired(ClaudeDch1ProviderRetirementAuthority {
        source: directly_stopped.query_identity(),
        allowed_target: None,
        source_host: ClaudeDch1HostIdentity {
            host_generation: "host-direct-stop".into(),
            host_instance_id: "instance-direct-stop".into(),
        },
        target_host: None,
        phase: ClaudeDch1ProviderRetirementPhase::Released,
    });
    directly_stopped.stopped();
    assert_eq!(
        directly_stopped
            .provider_predecessor_for_new_target()
            .unwrap(),
        None,
        "a direct stop releases the old Query without authorizing a predecessor",
    );
}

#[test]
fn legacy_failure_code_normalizes_once_into_the_typed_journal() {
    let root = tempfile::tempdir().unwrap();
    let mut value = serde_json::to_value(prepared()).unwrap();
    value["schemaVersion"] = 2.into();
    value["state"] = "failed".into();
    value["failureCode"] = "host_attach_failed".into();
    let target = root.path().join("launch.json");
    fs::write(&target, serde_json::to_vec(&value).unwrap()).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();

    let recovered = read_journal(root.path()).unwrap();
    assert_eq!(
        recovered.state(),
        ClaudeRuntimeLaunchStateV1::FailureCleanupPending
    );
    assert_eq!(
        recovered.failure(),
        Some(&ClaudeStructuredRecordedFailureV1::HostAttach {
            reason: "host_attach_failed".into(),
            detail: None,
        })
    );
    write_journal(root.path(), &recovered).unwrap();

    let normalized: serde_json::Value = serde_json::from_slice(&fs::read(target).unwrap()).unwrap();
    assert_eq!(normalized["schemaVersion"], 3);
    assert_eq!(normalized["failure"]["kind"], "host_attach");
    assert!(normalized.get("failureCode").is_none());
}

#[test]
fn unknown_legacy_failure_does_not_claim_host_attach_semantics() {
    let root = tempfile::tempdir().unwrap();
    let mut value = serde_json::to_value(prepared()).unwrap();
    value["schemaVersion"] = 2.into();
    value["state"] = "failed".into();
    value["failureCode"] = "unknown_failure".into();
    let target = root.path().join("launch.json");
    fs::write(&target, serde_json::to_vec(&value).unwrap()).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();

    assert!(matches!(
        read_journal(root.path()),
        Err(ClaudeStructuredRuntimeErrorV1::JournalFailed)
    ));
}
