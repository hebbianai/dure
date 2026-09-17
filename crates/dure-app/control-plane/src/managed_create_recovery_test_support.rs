use std::path::Path;

use hmux_client::{
    ManagedCreateGenerationFence, ManagedCreateOutcome, ManagedCreateReceipt,
    ManagedCreateReconcileRequest, ManagedStopOutcome, ManagedStopReceipt, ManagedStopRequest,
    PermissionMode, ProcessDescriptor,
    recovery_journal::managed_create_ledger::{
        self, ManagedCreateLedgerState, ManagedCreateSuccessorIdentity,
        ManagedCreateSuccessorLedgerState,
    },
};
use hmux_host::local_discovery::{
    ClaimLinkage, DiscoveryKey, DiscoveryRoot, HostLifetimeIdentity, LocalEndpoint,
    LocalEndpointKind, ManifestCommon, ReadyManifest, StartingManifest,
};
use hmux_host::local_protocol::{
    MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY, ProcessProof,
    ProtocolVersion as HostProtocolVersion, RuntimeContext, VersionRange as HostVersionRange,
};

pub(crate) fn publish_completed_successor(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
    idempotency_key: &str,
    provider_id: &str,
) -> (
    hmux_host::local_discovery::LifetimeLock,
    ManagedCreateReceipt,
) {
    publish_completed_successor_with_capabilities(
        discovery_root,
        workspace_id,
        session_id,
        idempotency_key,
        provider_id,
        &[MANAGED_PROVIDER_CONVERSATION_FENCED_STOP_CAPABILITY],
    )
}

pub(crate) fn publish_completed_successor_with_capabilities(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
    idempotency_key: &str,
    provider_id: &str,
    capabilities: &[&str],
) -> (
    hmux_host::local_discovery::LifetimeLock,
    ManagedCreateReceipt,
) {
    let root = DiscoveryRoot::create(discovery_root).unwrap();
    let session = root
        .session(
            DiscoveryKey::new(workspace_id, session_id, "successor-runner-instance", 7).unwrap(),
        )
        .unwrap();
    let common = ManifestCommon {
        schema_version: 1,
        host_build_version: "successor-build".into(),
        supported_protocol: HostVersionRange {
            minimum: HostProtocolVersion { major: 1, minor: 0 },
            maximum: HostProtocolVersion { major: 1, minor: 1 },
        },
        capabilities: capabilities.iter().map(|value| (*value).into()).collect(),
        lifetime: HostLifetimeIdentity {
            workspace_id: workspace_id.into(),
            session_id: session_id.into(),
            runner_principal: "successor-runner".into(),
            runner_instance: "successor-runner-instance".into(),
            channel_epoch: 7,
        },
        host_instance_id: "successor-host".into(),
        provider_id: provider_id.into(),
        runtime_context: RuntimeContext::default(),
        claim_linkage: ClaimLinkage {
            claim_id: None,
            kickoff_action_id: Some(idempotency_key.into()),
        },
        host_process: ProcessProof {
            process_id: 999_991,
            start_marker: "999991-1".into(),
        },
        created_unix_ms: 1,
        session_class: hmux_host::local_discovery::SessionClass::Managed,
        session_name: None,
        retirement_policy: None,
        launch_program: None,
    };
    let lock = session.acquire_lifetime_lock().unwrap();
    session
        .publish_starting(
            &lock,
            StartingManifest {
                common: common.clone(),
                starting_unix_ms: 2,
            },
        )
        .unwrap();
    session
        .publish_ready(
            &lock,
            ReadyManifest {
                common,
                provider_process: ProcessProof {
                    process_id: 999_992,
                    start_marker: "999992-1".into(),
                },
                terminal_epoch: "successor-terminal".into(),
                ready_output_seq: 1,
                endpoint: LocalEndpoint {
                    kind: LocalEndpointKind::UnixSocket,
                    address: discovery_root
                        .join("successor.sock")
                        .to_string_lossy()
                        .into_owned(),
                },
                capability_token: "successor-capability".into(),
                ready_unix_ms: 3,
            },
        )
        .unwrap();
    let receipt = ManagedCreateReceipt::new(
        idempotency_key,
        session_id,
        workspace_id,
        provider_id,
        PermissionMode::Default,
        discovery_root,
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new(
            "successor-runner",
            "successor-runner-instance",
            7,
            "successor-host",
            "successor-terminal",
        )
        .unwrap(),
    )
    .unwrap();
    (lock, receipt)
}

pub(crate) fn successor_session_in_source_shard(
    workspace_id: &str,
    source_session_id: &str,
    source_idempotency_key: &str,
    target_prefix: &str,
) -> String {
    let source =
        ManagedCreateReconcileRequest::new(source_idempotency_key, source_session_id, workspace_id)
            .unwrap();
    (0..=u16::MAX)
        .map(|candidate| format!("{target_prefix}-{candidate}"))
        .find(|candidate| {
            managed_create_ledger::successor_session_shares_create_shard(&source, candidate)
                .unwrap()
        })
        .expect("fixture must find a bounded same-shard successor identity")
}

pub(crate) fn publish_managed_create_successor_edge(
    discovery_root: &Path,
    source_session_id: &str,
    source_idempotency_key: &str,
    target_receipt: &ManagedCreateReceipt,
) {
    let workspace_id = target_receipt.workspace_id();
    let target_session_id = target_receipt.session_id();
    let target_idempotency_key = target_receipt.idempotency_key();
    let provider_id = target_receipt.provider_id();
    let ManagedCreateLedgerState::Prepared(mut source) = managed_create_ledger::reserve(
        discovery_root,
        workspace_id,
        source_session_id,
        source_idempotency_key,
        &"a".repeat(64),
    )
    .unwrap() else {
        panic!("source must begin prepared")
    };
    source.checkpoint_pre_spawn_absence().unwrap();
    source
        .mark_spawn_reserved(ProcessDescriptor {
            process_id: 999_981,
            start_marker: "999981-1".into(),
        })
        .unwrap();
    source.release_with_barrier_proof().unwrap();
    let source_receipt = ManagedCreateReceipt::new(
        source_idempotency_key,
        source_session_id,
        workspace_id,
        provider_id,
        PermissionMode::Default,
        discovery_root,
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new(
            "source-runner",
            "source-runner-instance",
            5,
            "source-host",
            "source-terminal",
        )
        .unwrap(),
    )
    .unwrap();
    source
        .complete(serde_json::to_string(&source_receipt).unwrap())
        .unwrap();
    let source_stop =
        ManagedStopRequest::new("source-retirement-stop", source_session_id, workspace_id)
            .and_then(|request| {
                request.with_expected_fence(
                    "source-runner",
                    "source-runner-instance",
                    5,
                    "source-host",
                    "source-terminal",
                )
            })
            .and_then(|request| {
                ManagedStopReceipt::from_request(
                    &request,
                    ManagedStopOutcome::Stopped,
                    "source-retired-before-response",
                )
            })
            .unwrap();
    managed_create_ledger::checkpoint_retirement_exact(discovery_root, &source_stop).unwrap();
    managed_create_ledger::finalize_retirement_exact(discovery_root, &source_stop).unwrap();
    let source_identity =
        ManagedCreateReconcileRequest::new(source_idempotency_key, source_session_id, workspace_id)
            .unwrap();
    let target_request_digest = "b".repeat(64);
    let target_identity = ManagedCreateSuccessorIdentity::with_policy_digests(
        target_session_id,
        target_idempotency_key,
        target_request_digest.clone(),
        target_request_digest.clone(),
        None,
    )
    .unwrap();
    assert!(matches!(
        managed_create_ledger::reserve_terminal_successor(discovery_root, &source_identity, || Ok(
            target_identity
        ))
        .unwrap(),
        ManagedCreateSuccessorLedgerState::Created(_),
    ));

    let ManagedCreateLedgerState::Prepared(mut target) =
        managed_create_ledger::reserve_successor_with_rehost_recipe_and_conversation(
            discovery_root,
            workspace_id,
            target_session_id,
            target_idempotency_key,
            &target_request_digest,
            None,
            None,
        )
        .unwrap()
    else {
        panic!("target must begin prepared")
    };
    target.checkpoint_pre_spawn_absence().unwrap();
    target
        .mark_spawn_reserved(ProcessDescriptor {
            process_id: 999_991,
            start_marker: "999991-1".into(),
        })
        .unwrap();
    target.release_with_barrier_proof().unwrap();
    target
        .complete(serde_json::to_string(target_receipt).unwrap())
        .unwrap();
}
