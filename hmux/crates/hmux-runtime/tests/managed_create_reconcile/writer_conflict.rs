use super::*;
use hmux_client::{CreatedManagedSession, ManagedCreateError, SessionDescriptor};

#[test]
fn active_source_is_preserved_when_target_conversation_has_another_writer() {
    preserves_source_when_target_conversation_has_another_writer(false, "fixture");
}

#[test]
fn explicit_replace_current_preserves_source_when_target_conversation_has_another_writer() {
    preserves_source_when_target_conversation_has_another_writer(true, "fixture");
}

#[test]
fn explicit_replace_current_preserves_another_provider_with_the_same_conversation_id() {
    preserves_source_when_target_conversation_has_another_writer(true, "other-provider");
}

fn preserves_source_when_target_conversation_has_another_writer(
    replace_current: bool,
    source_provider: &str,
) {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let source_state = state.path().join("source-state");
    let owner_state = state.path().join("owner-state");
    let target_state = state.path().join("target-state");
    for directory in [&source_state, &owner_state, &target_state] {
        fs::create_dir(directory).unwrap();
        fs::write(directory.join("hold-open"), b"1").unwrap();
    }
    let request = |idempotency_key: &str,
                   session_id: &str,
                   provider_id: &str,
                   conversation_id: &str,
                   provider_state: &std::path::Path| {
        ManagedCreateRequest::new(
            idempotency_key,
            session_id,
            "writer-conflict-workspace",
            provider_id,
            PermissionMode::Default,
            &cwd,
            fixture_provider_command(),
            24,
            80,
        )
        .unwrap()
        .with_provider_state_environment(
            ProviderStateEnvironment::new(BTreeMap::from([(
                FIXTURE_STATE_DIR_ENV.into(),
                provider_state.to_string_lossy().into_owned(),
            )]))
            .unwrap(),
        )
        .unwrap()
        .with_conversation_identity(
            ProviderConversationIdentitySeed::new(provider_id, conversation_id).unwrap(),
        )
        .unwrap()
        .with_required_managed_stop_request_version(
            hmux_client::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
        )
        .unwrap()
    };
    let source = request(
        "writer-conflict-source-create",
        "writer-conflict-source-session",
        source_provider,
        if source_provider == "fixture" {
            "writer-conflict-source-conversation"
        } else {
            "writer-conflict-target-conversation"
        },
        &source_state,
    );
    let other_owner = request(
        "writer-conflict-owner-create",
        "writer-conflict-owner-session",
        "fixture",
        "writer-conflict-target-conversation",
        &owner_state,
    );
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let source_receipt = creator.create(source.clone()).unwrap().receipt().clone();
    let owner_receipt = creator.create(other_owner).unwrap().receipt().clone();

    let changed = request(
        source.idempotency_key(),
        source.session_id(),
        "fixture",
        "writer-conflict-target-conversation",
        &target_state,
    );

    for _ in 0..2 {
        let result = if replace_current {
            creator.replace_current_and_advance(changed.clone())
        } else {
            creator.create_or_reconcile_and_advance(changed.clone())
        };
        let error = result.expect_err("another active conversation writer must refuse advance");
        assert_eq!(
            error.code(),
            hmux_runtime_contract::MANAGED_CONVERSATION_WRITER_CONFLICT_CODE
        );
        assert_eq!(
            error.disposition(),
            ManagedCreateFailureDisposition::Rejected
        );
        for expected in [&source_receipt, &owner_receipt] {
            let identity = ManagedCreateReconcileRequest::new(
                expected.idempotency_key(),
                expected.session_id(),
                expected.workspace_id(),
            )
            .unwrap();
            let ManagedCreateIdentityResolution::Existing(current) =
                creator.reconcile_identity(identity).unwrap()
            else {
                panic!("a refused replacement must preserve source and owner generations");
            };
            assert_eq!(current.receipt(), expected);
        }
    }
    assert!(
        !target_state.join("provider-spawns").exists(),
        "a refused target must not spawn a provider"
    );
    assert!(
        fs::read_dir(discovery_root.join(".managed-create-v2"))
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !is_successor_edge_shard_name(&entry.file_name().to_string_lossy())),
        "a refused target conversation must not reserve a successor"
    );
}

fn rebooted_writer_request(
    idempotency_key: &str,
    session_id: &str,
    provider_state: &std::path::Path,
) -> ManagedCreateRequest {
    ManagedCreateRequest::new(
        idempotency_key,
        session_id,
        "rebooted-writer-workspace",
        "fixture",
        PermissionMode::Default,
        std::env::current_dir().unwrap().canonicalize().unwrap(),
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(
        ProviderStateEnvironment::new(BTreeMap::from([(
            FIXTURE_STATE_DIR_ENV.into(),
            provider_state.to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("fixture", "rebooted-conversation").unwrap(),
    )
    .unwrap()
}

/// An isolated provider state that keeps the fixture provider running.
fn held_provider_state(
    state: &std::path::Path,
    name: &str,
    survive_host: bool,
) -> std::path::PathBuf {
    let directory = state.join(name);
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("hold-open"), b"1").unwrap();
    if survive_host {
        fs::write(directory.join("survive-host"), b"1").unwrap();
    }
    directory
}

fn assert_ready_manifest_remains(discovery_root: &std::path::Path, owner: &SessionDescriptor) {
    assert!(
        matches!(
            DiscoveryRoot::open(discovery_root)
                .unwrap()
                .find_current_manifest_by_session(&owner.workspace_id, &owner.session_id)
                .unwrap()
                .manifest,
            DiscoveryManifest::Ready(_)
        ),
        "the killed Host must leave its Ready manifest, as a reboot does"
    );
}

fn assert_writer_conflict(result: Result<CreatedManagedSession, ManagedCreateError>) {
    let error = result
        .map(|_| ())
        .expect_err("a live conversation writer keeps its conversation");
    assert_eq!(
        error.code(),
        hmux_runtime_contract::MANAGED_CONVERSATION_WRITER_CONFLICT_CODE
    );
}

/// A reboot ends every Host without its Exited tombstone, so the stale Ready
/// manifest was the only record left. Once the OS proves that exact Host and
/// its provider session are gone, a new session may resume the conversation
/// (#544); while they run, the conversation stays reserved.
#[test]
fn a_writer_whose_host_died_without_a_tombstone_releases_its_conversation() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let owner = creator
        .create(rebooted_writer_request(
            "rebooted-owner-create",
            "rebooted-owner-session",
            &held_provider_state(state.path(), "owner-state", false),
        ))
        .unwrap();
    let owner = owner.session().descriptor().clone();
    assert_writer_conflict(creator.create_with_disposition(rebooted_writer_request(
        "rebooted-control-create",
        "rebooted-control-session",
        &held_provider_state(state.path(), "control-state", false),
    )));

    // What a reboot leaves: both processes gone, no tombstone written.
    terminate_exact_process(&owner.host_process, "Host");
    terminate_exact_provider_session(&owner.provider_process, "provider session");
    assert_ready_manifest_remains(&discovery_root, &owner);

    let resumed = creator
        .create_with_disposition(rebooted_writer_request(
            "rebooted-resume-create",
            "rebooted-resume-session",
            &held_provider_state(state.path(), "resume-state", false),
        ))
        .unwrap_or_else(|error| {
            panic!(
                "a gone writer must release its conversation: {} {error:?}",
                error.code()
            )
        });
    assert_eq!(
        resumed.session().descriptor().lifecycle,
        SessionLifecycle::Ready
    );
}

/// A Host that died is not proof its provider stopped writing: a provider that
/// survived the Host keeps the conversation reserved.
#[test]
fn a_provider_that_outlived_its_host_keeps_the_conversation() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let owner = creator
        .create(rebooted_writer_request(
            "orphaned-owner-create",
            "orphaned-owner-session",
            &held_provider_state(state.path(), "owner-state", true),
        ))
        .unwrap();
    let owner = owner.session().descriptor().clone();

    terminate_exact_process(&owner.host_process, "Host");
    assert_ready_manifest_remains(&discovery_root, &owner);
    assert_eq!(
        probe_local_process_generation(&owner.provider_process).unwrap(),
        LocalProcessGenerationStatus::Live,
        "the fixture provider must survive its Host for this check"
    );
    assert_writer_conflict(creator.create_with_disposition(rebooted_writer_request(
        "orphaned-resume-create",
        "orphaned-resume-session",
        &held_provider_state(state.path(), "resume-state", false),
    )));
    terminate_exact_provider_session(&owner.provider_process, "provider session");
}
