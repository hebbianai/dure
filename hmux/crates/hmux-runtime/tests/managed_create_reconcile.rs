#![cfg(unix)]

use hmux_client::recovery_journal::managed_create_ledger::{
    self, ManagedCreateAdmissionError, ManagedCreateLedgerState, ManagedCreateReconcileLedgerState,
    ManagedCreateSuccessorIdentity, ManagedCreateSuccessorLedgerState, ManagedStartingGeneration,
    reconcile_identity, reserve, reserve_with_rehost_recipe_and_conversation,
};
use hmux_client::recovery_journal::request_fingerprint;
use hmux_client::{
    DiscoveryGcMode, DiscoveryGcSelection, LocalProcessGenerationStatus, LocalSessionCatalog,
    LocalStateGcPolicy, ManagedCreateAdvanceResolution, ManagedCreateBrokerResponse,
    ManagedCreateChainResolution, ManagedCreateFailureDisposition, ManagedCreateIdentityResolution,
    ManagedCreateReconcileBrokerResponse, ManagedCreateReconcileRequest, ManagedCreateRequest,
    ManagedCreateResolution, ManagedSessionCreateReconciler, ManagedSessionCreator,
    ManagedSessionStopper, PermissionMode, ProcessDescriptor, ProviderConversationIdentitySeed,
    ProviderStateEnvironment, SessionLifecycle, SessionSelector, collect_local_state,
    exact_local_process_generation, probe_local_process_generation,
};
use hmux_host::local_discovery::{
    DiscoveryGcPolicy, DiscoveryKey, DiscoveryManifest, DiscoveryRoot, ExitedManifest,
    ManifestGeneration, SessionLookupKey,
};
use hmux_host::local_protocol::{Exit, ProcessProof, SessionFence};
use hmux_host::provider_epoch::{ExitTombstone, ProviderExitKind};
use hmux_runtime_contract::{
    MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND, MANAGED_CREATE_BROKER_SUBCOMMAND,
    MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND, MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE,
    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER, MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES,
    ManagedCreateAdvanceBrokerResponse, ManagedCreateAdvanceRequest, ManagedCreateOutcome,
    ManagedRehostRecipe, TerminalDefaultColors, read_json_frame, write_json_frame,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const FIXTURE_STATE_DIR_ENV: &str = "FIXTURE_STATE_DIR";

#[path = "managed_create_reconcile/archived_conversation_writer.rs"]
mod archived_conversation_writer;
#[path = "managed_create_reconcile/broker_timing.rs"]
mod broker_timing;
#[path = "managed_create_reconcile/checkpointed_retry.rs"]
mod checkpointed_retry;
use checkpointed_retry::CheckpointedRetryFixture;
#[path = "managed_create_reconcile/exact_close.rs"]
mod exact_close;
#[path = "managed_create_reconcile/prepared_request.rs"]
mod prepared_request;
#[path = "managed_create_reconcile/replacement_recovery.rs"]
mod replacement_recovery;
#[path = "managed_create_reconcile/replacement_target_exit.rs"]
mod replacement_target_exit;
#[path = "managed_create_reconcile/writer_conflict.rs"]
mod writer_conflict;

fn is_successor_edge_shard_name(name: &str) -> bool {
    name.starts_with("successor_")
        && !name.starts_with("successor_digest_")
        && !name.starts_with("successor_predecessor_")
        && name.ends_with(".json")
}

#[test]
#[ignore = "launched as the deterministic provider by managed-create reconcile tests"]
fn managed_create_reconcile_fixture_provider() {
    if let Some(root) = std::env::var_os(FIXTURE_STATE_DIR_ENV) {
        let root = std::path::Path::new(&root);
        fs::write(root.join("provider-spawns"), b"x").unwrap();
        let hold_open = root.join("hold-open");
        if hold_open.exists() {
            while hold_open.try_exists().unwrap() {
                thread::sleep(Duration::from_millis(10));
            }
        } else {
            thread::sleep(Duration::from_secs(1));
        }
        return;
    }
    thread::sleep(Duration::from_secs(1));
}

fn fixture_provider_command() -> Vec<String> {
    vec![
        std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        "--ignored".into(),
        "--exact".into(),
        "managed_create_reconcile_fixture_provider".into(),
        "--nocapture".into(),
    ]
}

fn run_crashing_managed_create(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedCreateRequest,
    fault: &str,
) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env("HMUX_TEST_MANAGED_CREATE_FAULT", fault)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    assert_eq!(child.wait().unwrap().code(), Some(86));
}

fn crashed_prepacket_create(
    suffix: &str,
) -> (
    tempfile::TempDir,
    std::path::PathBuf,
    std::path::PathBuf,
    ManagedCreateRequest,
    ManagedCreateReconcileRequest,
    ProcessDescriptor,
) {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_spawns = state.path().join("provider-spawns");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        format!("{suffix}-create"),
        format!("{suffix}-session"),
        format!("{suffix}-workspace"),
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    run_crashing_managed_create(
        &discovery_root,
        &cwd,
        &request,
        "after_launch_released_before_packet_write",
    );
    let identity = ManagedCreateReconcileRequest::new(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
    )
    .unwrap();
    let host_process = match reconcile_identity(&discovery_root, &identity).unwrap() {
        ManagedCreateReconcileLedgerState::LaunchReleased {
            host_process,
            starting_generation: None,
            provider_release_guard: true,
            ..
        } => host_process,
        _ => panic!("the current prepacket cut must retain an exact release guard"),
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    while probe_local_process_generation(&host_process).unwrap()
        != LocalProcessGenerationStatus::Absent
    {
        assert!(
            Instant::now() < deadline,
            "the exact inert Host generation did not exit"
        );
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        DiscoveryRoot::open(&discovery_root)
            .unwrap()
            .find_manifest_by_session(request.workspace_id(), request.session_id())
            .is_err(),
        "the regression requires the prepacket discovery cut"
    );
    (
        state,
        discovery_root,
        provider_spawns,
        request,
        identity,
        host_process,
    )
}

fn run_definite_pre_spawn_failure(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedCreateRequest,
    fault_marker: &std::path::Path,
) -> ManagedCreateBrokerResponse {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .env(
            "HMUX_RUNTIME_TEST_HOST_SPAWN_BEFORE_START_FAULT_MARKER",
            fault_marker,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    write_json_frame(child.stdin.as_mut().unwrap(), request).unwrap();
    drop(child.stdin.take());
    let response = read_json_frame(child.stdout.as_mut().unwrap()).unwrap();
    assert!(child.wait().unwrap().success());
    response
}

fn run_managed_create_advance(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedCreateRequest,
    fault: Option<&str>,
) -> (
    std::process::ExitStatus,
    Option<ManagedCreateAdvanceBrokerResponse>,
) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"));
    command
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    if let Some(fault) = fault {
        match fault.strip_prefix("managed_stop:") {
            Some(stop_fault) => {
                command.env("HMUX_TEST_MANAGED_STOP_FAULT", stop_fault);
            }
            None => match fault.strip_prefix("managed_create:") {
                Some(create_fault) => {
                    command.env("HMUX_TEST_MANAGED_CREATE_FAULT", create_fault);
                }
                None => {
                    command.env("HMUX_TEST_MANAGED_CREATE_ADVANCE_FAULT", fault);
                }
            },
        }
    }
    let mut child = command.spawn().unwrap();
    write_json_frame(
        child.stdin.as_mut().unwrap(),
        &ManagedCreateAdvanceRequest::new(request.clone()).unwrap(),
    )
    .unwrap();
    drop(child.stdin.take());
    let response = read_json_frame(child.stdout.as_mut().unwrap()).ok();
    let status = child.wait().unwrap();
    (status, response)
}

fn successor_edges(discovery_root: &std::path::Path) -> Vec<serde_json::Value> {
    let directory = discovery_root.join(".managed-create-v2");
    let mut edges = fs::read_dir(&directory)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            is_successor_edge_shard_name(&name)
        })
        .filter_map(|entry| fs::read(entry.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .filter_map(|shard| shard["records"].as_object().cloned())
        .flat_map(|records| records.into_values())
        .collect::<Vec<_>>();
    edges.extend(
        fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with("shard_") && name.ends_with(".json")
            })
            .filter_map(|entry| fs::read(entry.path()).ok())
            .filter_map(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .filter_map(|shard| shard["records"].as_object().cloned())
            .flat_map(|records| records.into_values())
            .filter_map(|record| {
                let slot = record.get("authority")?.get("successor")?;
                match slot["kind"].as_str()? {
                    "intent" => Some(serde_json::json!({
                        "workspaceId": record["workspaceId"],
                        "sourceSessionId": record["sessionId"],
                        "sourceIdempotencyKey": record["idempotencyKey"],
                        "successor": slot["successor"],
                        "policyDigests": slot.get("policyDigests"),
                    })),
                    "closed" => Some(serde_json::json!({
                        "workspaceId": record["workspaceId"],
                        "sourceSessionId": record["sessionId"],
                        "sourceIdempotencyKey": record["idempotencyKey"],
                        "cleanupClosedUnixMs": slot["closedUnixMs"],
                    })),
                    _ => None,
                }
            }),
    );
    edges
}

fn rewrite_successor_target(
    discovery_root: &std::path::Path,
    source_session_id: &str,
    target_session_id: &str,
    target_idempotency_key: &str,
    target_request_digest: &str,
) {
    for entry in fs::read_dir(discovery_root.join(".managed-create-v2"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            is_successor_edge_shard_name(&name)
        })
    {
        let mut shard: serde_json::Value =
            serde_json::from_slice(&fs::read(entry.path()).unwrap()).unwrap();
        let mut changed = None;
        for (key, record) in shard["records"].as_object_mut().unwrap() {
            if record["sourceSessionId"] == source_session_id {
                let old_target_session_id = record["successor"]["sessionId"]
                    .as_str()
                    .unwrap()
                    .to_string();
                record["successor"]["sessionId"] = target_session_id.into();
                record["successor"]["idempotencyKey"] = target_idempotency_key.into();
                record["successor"]["requestDigest"] = target_request_digest.into();
                let source = ManagedCreateReconcileRequest::new(
                    record["sourceIdempotencyKey"].as_str().unwrap(),
                    record["sourceSessionId"].as_str().unwrap(),
                    record["workspaceId"].as_str().unwrap(),
                )
                .unwrap();
                let successor: ManagedCreateSuccessorIdentity =
                    serde_json::from_value(record["successor"].clone()).unwrap();
                let successor_json = serde_json::to_string(&successor).unwrap();
                let edge_fingerprint = request_fingerprint(&[
                    "managed-create-successor-digest-v1",
                    source.workspace_id(),
                    source.session_id(),
                    source.idempotency_key(),
                    &successor_json,
                ]);
                changed = Some((key.clone(), old_target_session_id, source, edge_fingerprint));
            }
        }
        if let Some((changed_key, old_target_session_id, source, edge_fingerprint)) = changed {
            fs::write(entry.path(), serde_json::to_vec(&shard).unwrap()).unwrap();
            for digest_entry in fs::read_dir(discovery_root.join(".managed-create-v2"))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    name.starts_with("successor_digest_") && name.ends_with(".json")
                })
            {
                let mut digest_shard: serde_json::Value =
                    serde_json::from_slice(&fs::read(digest_entry.path()).unwrap()).unwrap();
                if digest_shard["records"]
                    .as_object_mut()
                    .unwrap()
                    .remove(&changed_key)
                    .is_some()
                {
                    fs::write(
                        digest_entry.path(),
                        serde_json::to_vec(&digest_shard).unwrap(),
                    )
                    .unwrap();
                }
            }
            rewrite_successor_predecessor(
                discovery_root,
                &old_target_session_id,
                target_session_id,
                target_idempotency_key,
                &source,
                &edge_fingerprint,
            );
            return;
        }
    }
    for entry in fs::read_dir(discovery_root.join(".managed-create-v2"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("shard_") && name.ends_with(".json")
        })
    {
        let mut shard: serde_json::Value =
            serde_json::from_slice(&fs::read(entry.path()).unwrap()).unwrap();
        let records = shard["records"].as_object_mut().unwrap();
        let Some(source_key) = records
            .iter()
            .find(|(_, record)| record["sessionId"] == source_session_id)
            .map(|(key, _)| key.clone())
        else {
            continue;
        };
        let (old_target_session_id, source, edge_fingerprint) = {
            let record = records.get_mut(&source_key).unwrap();
            let successor = &mut record["authority"]["successor"]["successor"];
            let old_target_session_id = successor["sessionId"].as_str().unwrap().to_string();
            successor["sessionId"] = target_session_id.into();
            successor["idempotencyKey"] = target_idempotency_key.into();
            successor["requestDigest"] = target_request_digest.into();
            let successor = successor.clone();
            record["authority"]["successor"]["policyDigests"]["canonicalRequestDigest"] =
                target_request_digest.into();
            let source = ManagedCreateReconcileRequest::new(
                record["idempotencyKey"].as_str().unwrap(),
                record["sessionId"].as_str().unwrap(),
                record["workspaceId"].as_str().unwrap(),
            )
            .unwrap();
            let successor: ManagedCreateSuccessorIdentity =
                serde_json::from_value(successor).unwrap();
            let successor_json = serde_json::to_string(&successor).unwrap();
            let edge_fingerprint = request_fingerprint(&[
                "managed-create-successor-digest-v1",
                source.workspace_id(),
                source.session_id(),
                source.idempotency_key(),
                &successor_json,
            ]);
            (old_target_session_id, source, edge_fingerprint)
        };
        let old_target_key = records
            .iter()
            .find(|(_, record)| record["sessionId"] == old_target_session_id)
            .map(|(key, _)| key.clone());
        if let Some(old_target_key) = old_target_key {
            records.remove(&old_target_key);
        }
        let target_record = records
            .values_mut()
            .find(|record| {
                record["sessionId"] == target_session_id
                    && record["idempotencyKey"] == target_idempotency_key
            })
            .expect("v3 cycle target record was not found");
        target_record["authority"]["lineage"] = serde_json::json!({
            "kind": "predecessor",
            "source": source,
            "edgeFingerprint": edge_fingerprint,
        });
        fs::write(entry.path(), serde_json::to_vec(&shard).unwrap()).unwrap();
        return;
    }
    panic!("successor edge for {source_session_id} was not found");
}

fn rewrite_successor_predecessor(
    discovery_root: &std::path::Path,
    old_target_session_id: &str,
    target_session_id: &str,
    target_idempotency_key: &str,
    source: &ManagedCreateReconcileRequest,
    edge_fingerprint: &str,
) {
    let mut replaced = false;
    for entry in fs::read_dir(discovery_root.join(".managed-create-v2"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("successor_predecessor_") && name.ends_with(".json")
        })
    {
        let mut shard: serde_json::Value =
            serde_json::from_slice(&fs::read(entry.path()).unwrap()).unwrap();
        let records = shard["records"].as_object_mut().unwrap();
        let stale_keys = records
            .iter()
            .filter(|(_, record)| {
                record["targetSessionId"] == old_target_session_id
                    && record["authority"]["kind"] == "predecessor"
                    && record["authority"]["predecessor"]["sessionId"] == source.session_id()
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        let mut changed = false;
        for key in stale_keys {
            records.remove(&key);
            changed = true;
        }
        for record in records.values_mut() {
            if record["targetSessionId"] == target_session_id
                && record["targetIdempotencyKey"] == target_idempotency_key
            {
                record["authority"] = serde_json::json!({
                    "kind": "predecessor",
                    "predecessor": source,
                    "edge_fingerprint": edge_fingerprint,
                });
                changed = true;
                replaced = true;
            }
        }
        if changed {
            fs::write(entry.path(), serde_json::to_vec(&shard).unwrap()).unwrap();
        }
    }
    assert!(replaced, "target predecessor projection was not found");
}

fn inject_existing_v3_edge_without_capacity_check(
    discovery_root: &std::path::Path,
    source: &ManagedCreateReconcileRequest,
    target: &ManagedCreateRequest,
) {
    let request_without_colors = target
        .clone()
        .with_terminal_default_colors_option(None)
        .unwrap();
    let serialized_request = serde_json::to_string(&request_without_colors).unwrap();
    let request_digest = request_fingerprint(&[&serialized_request]);
    let canonical_request = target.canonical_create_identity_json().unwrap();
    let canonical_request_digest = request_fingerprint(&[&canonical_request]);
    let successor = ManagedCreateSuccessorIdentity::with_policy_digests(
        target.session_id(),
        target.idempotency_key(),
        &request_digest,
        &canonical_request_digest,
        None,
    )
    .unwrap();
    let serialized_successor = serde_json::to_string(&successor).unwrap();
    let edge_fingerprint = request_fingerprint(&[
        "managed-create-successor-digest-v1",
        source.workspace_id(),
        source.session_id(),
        source.idempotency_key(),
        &serialized_successor,
    ]);

    for entry in fs::read_dir(discovery_root.join(".managed-create-v2"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("shard_") && name.ends_with(".json")
        })
    {
        let mut shard: serde_json::Value =
            serde_json::from_slice(&fs::read(entry.path()).unwrap()).unwrap();
        let records = shard["records"].as_object_mut().unwrap();
        let source_key = records
            .iter()
            .find(|(_, record)| {
                record["sessionId"] == source.session_id()
                    && record["idempotencyKey"] == source.idempotency_key()
            })
            .map(|(key, _)| key.clone());
        let target_key = records
            .iter()
            .find(|(_, record)| {
                record["sessionId"] == target.session_id()
                    && record["idempotencyKey"] == target.idempotency_key()
            })
            .map(|(key, _)| key.clone());
        let (Some(source_key), Some(target_key)) = (source_key, target_key) else {
            continue;
        };

        records.get_mut(&source_key).unwrap()["authority"]["successor"] = serde_json::json!({
            "kind": "intent",
            "successor": successor,
            "policyDigests": {
                "canonicalRequestDigest": canonical_request_digest,
                "rehostRecipeDigest": null,
            },
        });
        records.get_mut(&target_key).unwrap()["authority"]["lineage"] = serde_json::json!({
            "kind": "predecessor",
            "source": source,
            "edgeFingerprint": edge_fingerprint,
        });
        fs::write(entry.path(), serde_json::to_vec(&shard).unwrap()).unwrap();
        return;
    }
    panic!("source and target create records were not found in one v3 shard");
}

fn wait_for_exited(discovery_root: &std::path::Path, workspace_id: &str, session_id: &str) {
    let catalog = LocalSessionCatalog::new(discovery_root);
    let selector = SessionSelector::new(session_id, Some(workspace_id.to_string()));
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if catalog
            .find(&selector)
            .is_ok_and(|descriptor| descriptor.lifecycle == SessionLifecycle::Exited)
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the managed fixture generation did not publish Exited"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_conversation_writer_release(
    discovery_root: &std::path::Path,
    workspace_id: &str,
    session_id: &str,
) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let released = fs::read_dir(discovery_root.join(".managed-create-v2"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("shard_"))
            .filter_map(|entry| fs::read(entry.path()).ok())
            .filter_map(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .filter_map(|shard| shard["records"].as_object().cloned())
            .flat_map(|records| records.into_values())
            .any(|record| {
                record["workspaceId"] == workspace_id
                    && record["sessionId"] == session_id
                    && record["conversationWriterReleased"] == true
            });
        if released {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the managed Host did not release its exited conversation writer"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn immediate_provider_exit_is_published_as_host_lifecycle() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "immediate-exit-create",
        "immediate-exit-session",
        "immediate-exit-workspace",
        "fixture",
        PermissionMode::Default,
        &cwd,
        vec!["/usr/bin/true".into()],
        24,
        80,
    )
    .unwrap();
    let mut broker = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_BROKER_SUBCOMMAND)
        .current_dir(&cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, &discovery_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    write_json_frame(broker.stdin.as_mut().unwrap(), &request).unwrap();
    drop(broker.stdin.take());

    wait_for_exited(
        &discovery_root,
        request.workspace_id(),
        request.session_id(),
    );
    let found = DiscoveryRoot::open(&discovery_root)
        .unwrap()
        .find_current_manifest_by_session(request.workspace_id(), request.session_id())
        .unwrap();
    let DiscoveryManifest::Exited(exited) = found.manifest else {
        panic!("an immediate provider exit must pass through the Host lifecycle")
    };
    let tombstone = serde_json::to_value(&exited.tombstone).unwrap();
    assert_eq!(
        tombstone["failure"]["code"],
        "provider_exited_before_conversation_identity"
    );
    assert_eq!(tombstone["failure"]["phase"], "conversation_identity");
    assert_eq!(tombstone["failure"]["exit_code"], 0);
    assert_eq!(tombstone["failure"]["retry_posture"], "never");
    if broker.try_wait().unwrap().is_none() {
        broker.kill().unwrap();
    }
    broker.wait().unwrap();
}

#[test]
fn provider_argument_named_like_the_runtime_option_survives_the_gate() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "runtime-option-argument-create",
        "runtime-option-argument-session",
        "runtime-option-argument-workspace",
        "fixture",
        PermissionMode::Default,
        &cwd,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "test \"$1\" = --no-autostart".into(),
            "fixture".into(),
            "--no-autostart".into(),
        ],
        24,
        80,
    )
    .unwrap();
    let mut broker = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_BROKER_SUBCOMMAND)
        .current_dir(&cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, &discovery_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    write_json_frame(broker.stdin.as_mut().unwrap(), &request).unwrap();
    drop(broker.stdin.take());

    wait_for_exited(
        &discovery_root,
        request.workspace_id(),
        request.session_id(),
    );
    let found = DiscoveryRoot::open(&discovery_root)
        .unwrap()
        .find_current_manifest_by_session(request.workspace_id(), request.session_id())
        .unwrap();
    let DiscoveryManifest::Exited(exited) = found.manifest else {
        panic!("the provider argument fixture did not publish Exited")
    };
    assert_eq!(
        exited.tombstone.exit.exit_code,
        Some(0),
        "the provider must receive its literal --no-autostart argument"
    );
    if broker.try_wait().unwrap().is_none() {
        broker.kill().unwrap();
    }
    broker.wait().unwrap();
}

#[test]
fn host_exit_after_release_marker_cannot_exec_the_provider() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_spawns = state.path().join("provider-spawns");
    let release_observed = state.path().join("provider-release-observed");
    let release_continue = state.path().join("provider-release-continue");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "release-host-exit-create",
        "release-host-exit-session",
        "release-host-exit-workspace",
        "fixture",
        PermissionMode::Default,
        &cwd,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf x > \"$FIXTURE_STATE_DIR/provider-spawns\"; sleep 5".into(),
        ],
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(
        ProviderStateEnvironment::new(BTreeMap::from([(
            FIXTURE_STATE_DIR_ENV.into(),
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    let mut broker = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_BROKER_SUBCOMMAND)
        .current_dir(&cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, &discovery_root)
        .env(
            "HMUX_RUNTIME_TEST_PROVIDER_GATE_RELEASE_OBSERVED_MARKER",
            &release_observed,
        )
        .env(
            "HMUX_RUNTIME_TEST_PROVIDER_GATE_RELEASE_CONTINUE_MARKER",
            &release_continue,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    write_json_frame(broker.stdin.as_mut().unwrap(), &request).unwrap();
    drop(broker.stdin.take());

    let deadline = Instant::now() + Duration::from_secs(5);
    while !release_observed.exists() {
        assert!(
            Instant::now() < deadline,
            "the provider gate did not observe its durable release marker"
        );
        thread::sleep(Duration::from_millis(10));
    }
    let generation = managed_create_ledger::starting_generation(
        &discovery_root,
        request.workspace_id(),
        request.session_id(),
    )
    .unwrap()
    .expect("provider release requires the exact Starting checkpoint");
    assert_eq!(
        probe_local_process_generation(generation.host_process()).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    let host_pid = libc::pid_t::try_from(generation.host_process().process_id).unwrap();
    // SAFETY: the exact Host generation was observed immediately above and
    // this isolated fixture owns it.
    assert_eq!(unsafe { libc::kill(host_pid, libc::SIGKILL) }, 0);
    let deadline = Instant::now() + Duration::from_secs(3);
    while probe_local_process_generation(generation.host_process()).unwrap()
        != LocalProcessGenerationStatus::Absent
    {
        assert!(
            Instant::now() < deadline,
            "the exact Host generation did not exit"
        );
        thread::sleep(Duration::from_millis(10));
    }
    fs::write(&release_continue, b"continue").unwrap();

    let deadline = Instant::now() + Duration::from_secs(3);
    let provider_survived = loop {
        match probe_local_process_generation(generation.provider_process()).unwrap() {
            LocalProcessGenerationStatus::Absent => break false,
            LocalProcessGenerationStatus::Live
                if !provider_spawns.exists() && Instant::now() < deadline =>
            {
                thread::sleep(Duration::from_millis(10));
            }
            LocalProcessGenerationStatus::Live => break true,
        }
    };
    if provider_survived {
        let provider_session = libc::pid_t::try_from(generation.provider_process().process_id)
            .map(|process_id| -process_id)
            .unwrap();
        // SAFETY: the exact live provider generation is its own POSIX session
        // leader and this isolated fixture owns the complete session.
        unsafe {
            libc::kill(provider_session, libc::SIGKILL);
        }
    }
    if broker.try_wait().unwrap().is_none() {
        broker.kill().unwrap();
    }
    broker.wait().unwrap();
    assert!(
        !provider_survived,
        "the provider survived its Host across the release-to-exec boundary"
    );
    assert!(
        !provider_spawns.exists(),
        "the provider crossed its effect boundary after exact Host death"
    );
    let resolution = ManagedSessionCreateReconciler::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .reconcile(
            ManagedCreateReconcileRequest::new(
                request.idempotency_key(),
                request.session_id(),
                request.workspace_id(),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(
        resolution,
        ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion
    );
}

fn terminate_exact_process(process: &ProcessDescriptor, label: &str) {
    if probe_local_process_generation(process).unwrap() == LocalProcessGenerationStatus::Live {
        let process_id = libc::pid_t::try_from(process.process_id).unwrap();
        // SAFETY: the caller supplies an exact generation owned by its isolated
        // fixture; the positive id signals only that process.
        assert_eq!(unsafe { libc::kill(process_id, libc::SIGKILL) }, 0);
    }
    wait_for_exact_process_absence(process, label);
}

fn terminate_exact_provider_session(process: &ProcessDescriptor, label: &str) {
    if probe_local_process_generation(process).unwrap() == LocalProcessGenerationStatus::Live {
        let session_id = -libc::pid_t::try_from(process.process_id).unwrap();
        // SAFETY: checkpoint publication proves this exact provider owns the
        // numeric POSIX session, and the fixture owns that complete session.
        assert_eq!(unsafe { libc::kill(session_id, libc::SIGKILL) }, 0);
    }
    wait_for_exact_process_absence(process, label);
}

fn wait_for_exact_process_absence(process: &ProcessDescriptor, label: &str) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while probe_local_process_generation(process).unwrap() != LocalProcessGenerationStatus::Absent {
        assert!(Instant::now() < deadline, "the exact {label} did not exit");
        thread::sleep(Duration::from_millis(10));
    }
}

fn retired_manifest_generation(generation: &ManagedStartingGeneration) -> ManifestGeneration {
    let fence = generation.generation_fence();
    ManifestGeneration {
        host_instance_id: fence.host_instance_id().to_string(),
        host_process: ProcessProof {
            process_id: generation.host_process().process_id,
            start_marker: generation.host_process().start_marker.clone(),
        },
        terminal_epoch: Some(fence.terminal_epoch().to_string()),
    }
}

fn archive_checkpointed_starting_with_reason(fixture: &CheckpointedRetryFixture, reason: &str) {
    let fence = fixture.generation.generation_fence();
    let discovery = DiscoveryRoot::open(&fixture.discovery_root)
        .unwrap()
        .open_session(
            DiscoveryKey::new(
                fixture.request.workspace_id(),
                fixture.request.session_id(),
                fence.runner_instance(),
                fence.channel_epoch(),
            )
            .unwrap(),
        )
        .unwrap();
    let lifetime = discovery.acquire_lifetime_lock().unwrap();
    let DiscoveryManifest::Starting(starting) = discovery.read_manifest().unwrap() else {
        panic!("the checkpointed fixture must still own Starting discovery");
    };
    let retired_unix_ms = starting.common.created_unix_ms;
    let exited = ExitedManifest {
        common: starting.common,
        tombstone: Box::new(ExitTombstone {
            provider_conversation_identity: None,
            fence: SessionFence {
                workspace_id: fixture.request.workspace_id().to_string(),
                session_id: fixture.request.session_id().to_string(),
                runner_principal: fence.runner_principal().to_string(),
                runner_instance: fence.runner_instance().to_string(),
                channel_epoch: fence.channel_epoch(),
                host_instance_id: fence.host_instance_id().to_string(),
                terminal_epoch: fence.terminal_epoch().to_string(),
            },
            provider_process: ProcessProof {
                process_id: fixture.generation.provider_process().process_id,
                start_marker: fixture.generation.provider_process().start_marker.clone(),
            },
            exit: Exit {
                final_output_seq: 0,
                exit_code: None,
                platform_status: None,
                reason: reason.to_string(),
            },
            exit_kind: ProviderExitKind::ProviderError,
            created_unix_ms: retired_unix_ms,
            failure: None,
        }),
        endpoint: fixture.generation.endpoint().clone(),
        capability_token: fixture.generation.capability_token().to_string(),
        exited_unix_ms: retired_unix_ms,
    };
    discovery.publish_exited(&lifetime, exited.clone()).unwrap();
    discovery
        .retire_exited_current(&lifetime, &DiscoveryManifest::Exited(exited).generation())
        .unwrap();
}

#[test]
fn same_create_retry_does_not_reset_a_checkpointed_live_provider() {
    let mut fixture = CheckpointedRetryFixture::new("checkpointed-retry");
    let session_path = fixture.discovery_root.join(
        SessionLookupKey::new(fixture.request.workspace_id(), fixture.request.session_id())
            .unwrap()
            .relative_path(),
    );
    fs::remove_dir_all(session_path).unwrap();

    let retry = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&fixture.discovery_root)
        .create_with_disposition(fixture.request.clone());
    let unexpected_generation = retry.as_ref().ok().map(|created| {
        (
            created.session().descriptor().host_process.clone(),
            created.session().descriptor().provider_process.clone(),
        )
    });
    let spawn_count = fs::read_to_string(&fixture.provider_pids)
        .unwrap()
        .lines()
        .count();

    terminate_exact_provider_session(
        fixture.generation.provider_process(),
        "checkpointed provider",
    );
    if let Some((_, provider)) = &unexpected_generation {
        terminate_exact_provider_session(provider, "unexpected provider");
    }
    if let Some((host, _)) = &unexpected_generation {
        terminate_exact_process(host, "unexpected Host");
    }
    fixture.stop_broker();

    let error = retry.expect_err(
        "same-create retry must remain pending until the checkpointed provider is retired",
    );
    assert_eq!(
        error.disposition(),
        ManagedCreateFailureDisposition::Retryable
    );
    assert_eq!(
        spawn_count, 1,
        "same-create retry must not spawn a second provider from Host absence alone"
    );
}

#[test]
fn same_create_retry_does_not_treat_a_missing_manifest_as_retirement_proof() {
    let mut fixture = CheckpointedRetryFixture::new("missing-retirement-proof");
    fixture.stop_broker();
    terminate_exact_provider_session(
        fixture.generation.provider_process(),
        "checkpointed provider",
    );
    let fence = fixture.generation.generation_fence();
    let discovery = DiscoveryRoot::open(&fixture.discovery_root)
        .unwrap()
        .open_session(
            DiscoveryKey::new(
                fixture.request.workspace_id(),
                fixture.request.session_id(),
                fence.runner_instance(),
                fence.channel_epoch(),
            )
            .unwrap(),
        )
        .unwrap();
    let lifetime = discovery.acquire_lifetime_lock().unwrap();
    let current = discovery.read_manifest().unwrap();
    discovery
        .cleanup_current(&lifetime, &current.generation())
        .unwrap();
    drop(lifetime);
    assert!(
        discovery
            .find_retired_exited_generation(&retired_manifest_generation(&fixture.generation))
            .unwrap()
            .is_none()
    );

    let retry = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&fixture.discovery_root)
        .create_with_disposition(fixture.request);
    let error = retry.expect_err("manifest absence alone must not reopen a checkpointed create");
    assert_eq!(
        error.disposition(),
        ManagedCreateFailureDisposition::Retryable
    );
    assert_eq!(
        fs::read_to_string(&fixture.provider_pids)
            .unwrap()
            .lines()
            .count(),
        1,
        "missing retirement evidence must not launch another provider"
    );
}

#[test]
fn same_create_retry_does_not_treat_an_ordinary_exit_archive_as_starting_retirement() {
    let mut fixture = CheckpointedRetryFixture::new("ordinary-exit-archive");
    fixture.stop_broker();
    terminate_exact_provider_session(
        fixture.generation.provider_process(),
        "checkpointed provider",
    );
    archive_checkpointed_starting_with_reason(&fixture, "ordinary_provider_exit");

    let retry = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&fixture.discovery_root)
        .create_with_disposition(fixture.request);
    let error = retry.expect_err("an ordinary exit archive must not reopen a checkpointed create");
    assert_eq!(
        error.disposition(),
        ManagedCreateFailureDisposition::Retryable
    );
    assert_eq!(
        fs::read_to_string(&fixture.provider_pids)
            .unwrap()
            .lines()
            .count(),
        1,
        "ordinary exit evidence must not launch another provider"
    );
}

#[test]
fn same_create_retry_replays_exact_archived_starting_retirement_after_crash() {
    let mut fixture = CheckpointedRetryFixture::new("archived-retirement-retry");
    fixture.stop_broker();
    terminate_exact_provider_session(
        fixture.generation.provider_process(),
        "checkpointed provider",
    );

    let identity = ManagedCreateReconcileRequest::new(
        fixture.request.idempotency_key(),
        fixture.request.session_id(),
        fixture.request.workspace_id(),
    )
    .unwrap();
    run_crashing_managed_create(
        &fixture.discovery_root,
        &fixture.cwd,
        &fixture.request,
        "after_checkpointed_starting_retirement_before_create_ledger_transition",
    );
    assert!(matches!(
        reconcile_identity(&fixture.discovery_root, &identity).unwrap(),
        ManagedCreateReconcileLedgerState::LaunchReleased {
            starting_generation: Some(ref persisted),
            ..
        } if persisted.as_ref() == &fixture.generation
    ));
    let fence = fixture.generation.generation_fence();
    let old_discovery = DiscoveryRoot::open(&fixture.discovery_root)
        .unwrap()
        .open_session(
            DiscoveryKey::new(
                fixture.request.workspace_id(),
                fixture.request.session_id(),
                fence.runner_instance(),
                fence.channel_epoch(),
            )
            .unwrap(),
        )
        .unwrap();
    assert!(old_discovery.read_manifest_if_present().unwrap().is_none());
    let archived = old_discovery
        .find_retired_exited_generation(&retired_manifest_generation(&fixture.generation))
        .unwrap()
        .expect("the first retry must archive the exact retired generation before crashing");
    assert_eq!(
        archived.tombstone.provider_process.process_id,
        fixture.generation.provider_process().process_id
    );
    assert_eq!(
        archived.tombstone.provider_process.start_marker,
        fixture.generation.provider_process().start_marker
    );

    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&fixture.discovery_root)
        .create_with_disposition(fixture.request.clone())
        .expect("the exact archived retirement must reopen the same create on retry");
    assert_eq!(created.receipt().outcome(), ManagedCreateOutcome::Created);
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let spawn_count = fs::read_to_string(&fixture.provider_pids)
            .unwrap()
            .lines()
            .count();
        if spawn_count == 2 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the reopened create did not launch exactly one replacement provider"
        );
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        fs::read_to_string(&fixture.provider_pids)
            .unwrap()
            .lines()
            .count(),
        2,
        "retirement replay must not launch more than one replacement provider"
    );

    let replacement = created.session().descriptor();
    terminate_exact_provider_session(&replacement.provider_process, "replacement provider");
    terminate_exact_process(&replacement.host_process, "replacement Host");
}

fn apply_aggressive_gc(discovery_root: &std::path::Path) {
    let policy = LocalStateGcPolicy {
        discovery: DiscoveryGcPolicy {
            selection: DiscoveryGcSelection::AllEligible,
            minimum_age_ms: 0,
            maximum_age_ms: 0,
            max_session_entries: 0,
            max_total_bytes: 0,
            max_scan_entries: 1_024,
            max_diagnostics: 32,
        },
        ..LocalStateGcPolicy::default()
    };
    collect_local_state(discovery_root, DiscoveryGcMode::Apply, &policy).unwrap();
}

fn reconcile_raw(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    idempotency_key: &str,
    session_id: &str,
    workspace_id: &str,
) -> serde_json::Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND)
        .current_dir(cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    write_json_frame(
        child.stdin.as_mut().unwrap(),
        &serde_json::json!({
            "schema": "hmux-managed-create-reconcile-v1",
            "schemaVersion": 1,
            "idempotencyKey": idempotency_key,
            "sessionId": session_id,
            "workspaceId": workspace_id,
        }),
    )
    .unwrap();
    drop(child.stdin.take());
    let response = read_json_frame(child.stdout.as_mut().unwrap())
        .expect("the identity-only reconcile broker must return one typed response");
    assert!(child.wait().unwrap().success());
    response
}

fn lose_terminal_reconcile_response(
    discovery_root: &std::path::Path,
    cwd: &std::path::Path,
    request: &ManagedCreateRequest,
) {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let mut child = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .arg("--no-autostart")
            .arg(MANAGED_CREATE_RECONCILE_BROKER_SUBCOMMAND)
            .current_dir(cwd)
            .env(hmux_client::DISCOVERY_ROOT_ENV, discovery_root)
            .env(
                "HMUX_TEST_MANAGED_CREATE_RECONCILE_FAULT",
                "after_ledger_terminal_before_broker_receipt",
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        write_json_frame(
            child.stdin.as_mut().unwrap(),
            &ManagedCreateReconcileRequest::new(
                request.idempotency_key(),
                request.session_id(),
                request.workspace_id(),
            )
            .unwrap(),
        )
        .unwrap();
        drop(child.stdin.take());
        if child.wait().unwrap().code() == Some(86) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "the exact inert Host generation did not become absent"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn prelaunch_crash_is_terminalized_without_spawning_provider(fault: &str, suffix: &str) {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_spawns = state.path().join("provider-spawns");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        format!("abandoned-{suffix}-create"),
        format!("abandoned-{suffix}-session"),
        format!("abandoned-{suffix}-workspace"),
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap();

    run_crashing_managed_create(&discovery_root, &cwd, &request, fault);
    assert!(
        !provider_spawns.exists(),
        "a pre-launch reconciliation cut must not release the provider"
    );

    lose_terminal_reconcile_response(&discovery_root, &cwd, &request);
    let replayed = ManagedSessionCreateReconciler::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .reconcile(
            ManagedCreateReconcileRequest::new(
                request.idempotency_key(),
                request.session_id(),
                request.workspace_id(),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(
        replayed,
        ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion,
        "a lost reconcile response must replay the durable tombstone"
    );

    let retired = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create_with_disposition(request.clone())
        .expect_err("the abandoned logical identity must never be reopened");
    assert_eq!(
        retired.code(),
        hmux_client::MANAGED_CREATE_RETIRED_EXACT_CODE
    );
    assert_eq!(
        retired.disposition(),
        ManagedCreateFailureDisposition::Rejected
    );
    let composed = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create_or_reconcile(request.clone())
        .expect("the composed API must expose an exact tombstone as typed retirement");
    assert!(matches!(composed, ManagedCreateResolution::Retired));
    assert!(!provider_spawns.exists());

    let changed = request
        .with_provider_state_environment(
            ProviderStateEnvironment::new(BTreeMap::from([(
                FIXTURE_STATE_DIR_ENV.into(),
                state
                    .path()
                    .join("changed-home")
                    .to_string_lossy()
                    .into_owned(),
            )]))
            .unwrap(),
        )
        .unwrap();
    let conflict = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create_with_disposition(changed)
        .expect_err("a tombstone must preserve the old canonical digest");
    assert_eq!(
        conflict.disposition(),
        ManagedCreateFailureDisposition::Rejected
    );
    assert_eq!(
        conflict.code(),
        hmux_client::MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE
    );
    assert!(
        !provider_spawns.exists(),
        "neither exact nor changed retries may spawn from a terminal tombstone"
    );
}

#[test]
fn spawn_reserved_crash_reconciles_only_after_exact_host_absence() {
    prelaunch_crash_is_terminalized_without_spawning_provider(
        "after_spawn_reserved_before_host_release",
        "spawn-reserved",
    );
}

#[test]
fn launch_released_without_provider_barrier_proof_remains_pending() {
    let (_state, discovery_root, provider_spawns, _request, identity, _host_process) =
        crashed_prepacket_create("unproven-launch-released");
    for entry in fs::read_dir(discovery_root.join(".managed-create-v2")).unwrap() {
        let entry = entry.unwrap();
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("provider_release_guard_")
        {
            fs::remove_file(entry.path()).unwrap();
        }
    }
    assert!(matches!(
        reconcile_identity(&discovery_root, &identity).unwrap(),
        ManagedCreateReconcileLedgerState::LaunchReleased {
            provider_release_guard: false,
            ..
        }
    ));
    let resolution = ManagedSessionCreateReconciler::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .reconcile(identity)
        .unwrap();
    assert_eq!(resolution, ManagedCreateReconcileBrokerResponse::Pending);
    assert!(
        !provider_spawns.exists(),
        "the fixture confirms only that this current launch was inert, not that a legacy launch would be"
    );
}

#[test]
fn same_create_retry_does_not_reopen_a_guardless_legacy_launch() {
    let (_state, discovery_root, provider_spawns, request, identity, _host_process) =
        crashed_prepacket_create("retry-unproven-launch-released");
    for entry in fs::read_dir(discovery_root.join(".managed-create-v2")).unwrap() {
        let entry = entry.unwrap();
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("provider_release_guard_")
        {
            fs::remove_file(entry.path()).unwrap();
        }
    }
    assert!(matches!(
        reconcile_identity(&discovery_root, &identity).unwrap(),
        ManagedCreateReconcileLedgerState::LaunchReleased {
            provider_release_guard: false,
            ..
        }
    ));

    let error = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create_with_disposition(request)
        .expect_err("a legacy launch without barrier proof must remain pending");
    assert_eq!(
        error.disposition(),
        ManagedCreateFailureDisposition::Retryable
    );
    assert!(
        !provider_spawns.exists(),
        "the exact retry must not spawn from Host absence without provider-release proof"
    );
}

#[test]
fn guarded_prepacket_launch_release_reconciles_after_exact_host_absence() {
    let (_state, discovery_root, provider_spawns, _request, identity, _host_process) =
        crashed_prepacket_create("guarded-launch-released");
    let resolution = ManagedSessionCreateReconciler::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .reconcile(identity)
        .unwrap();
    assert_eq!(
        resolution,
        ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion
    );
    assert!(
        !provider_spawns.exists(),
        "the guarded prepacket cut must not release the provider"
    );
}

#[test]
fn same_create_retry_reopens_a_guarded_prepacket_launch() {
    let (_state, discovery_root, provider_spawns, request, _identity, _host_process) =
        crashed_prepacket_create("retry-guarded-launch-released");
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create_with_disposition(request)
        .expect("the exact retry must reopen a proven-inert current launch");
    assert_eq!(created.receipt().outcome(), ManagedCreateOutcome::Created);
    assert!(
        provider_spawns.exists(),
        "the reopened create must launch its provider exactly once"
    );
}

#[test]
fn cleanup_claim_preserves_guarded_prepacket_release_proof() {
    let (_state, discovery_root, provider_spawns, _request, identity, _host_process) =
        crashed_prepacket_create("claimed-guarded-launch-released");
    assert!(matches!(
        managed_create_ledger::claim_successor_chain_cleanup(&discovery_root, &identity).unwrap(),
        managed_create_ledger::ManagedCreateSuccessorChainResolution::Pending { .. }
    ));
    assert!(matches!(
        reconcile_identity(&discovery_root, &identity).unwrap(),
        ManagedCreateReconcileLedgerState::LaunchReleased {
            provider_release_guard: true,
            ..
        }
    ));
    let resolution = ManagedSessionCreateReconciler::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .reconcile(identity)
        .unwrap();
    assert_eq!(
        resolution,
        ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion
    );
    assert!(!provider_spawns.exists());
}

#[test]
fn inert_host_crash_before_process_reservation_never_releases_the_provider() {
    prelaunch_crash_is_terminalized_without_spawning_provider(
        "after_inert_host_spawn_before_reservation",
        "inert-host",
    );
}

#[test]
fn chain_stop_converges_prelaunch_crash_states_without_a_provider() {
    for (fault, suffix) in [
        (
            "after_create_reservation_before_absence_checkpoint",
            "reserved",
        ),
        ("after_spawn_reserved_before_host_release", "spawn-reserved"),
    ] {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let provider_spawns = state.path().join("provider-spawns");
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let request = ManagedCreateRequest::new(
            format!("chain-prelaunch-create-{suffix}"),
            format!("chain-prelaunch-session-{suffix}"),
            "chain-prelaunch-workspace",
            "fixture",
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
                state.path().to_string_lossy().into_owned(),
            )]))
            .unwrap(),
        )
        .unwrap();
        run_crashing_managed_create(&discovery_root, &cwd, &request, fault);
        let root = ManagedCreateReconcileRequest::new(
            request.idempotency_key(),
            request.session_id(),
            request.workspace_id(),
        )
        .unwrap();
        let runtime = std::path::Path::new(env!("CARGO_BIN_EXE_hmux-runtime"));
        let stopper = ManagedSessionStopper::new(runtime, runtime.parent().unwrap())
            .with_discovery_root(&discovery_root);

        let closed = stopper.stop_create_chain_v2(root.clone()).unwrap();
        assert_eq!(closed.chain(), std::slice::from_ref(&root));
        assert!(closed.stop_receipt().is_none());
        assert_eq!(stopper.stop_create_chain_v2(root).unwrap(), closed);
        assert!(
            !provider_spawns.exists(),
            "prelaunch chain cleanup must never release the provider",
        );
    }
}

#[test]
fn chain_stop_converges_every_precheckpoint_host_cut_without_releasing_provider() {
    for (phase, suffix) in [
        ("host_starting_published", "starting"),
        ("before_provider_spawn", "before-provider"),
        ("provider_spawned_before_checkpoint", "provider-gated"),
    ] {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let provider_spawns = state.path().join("provider-spawns");
        let cut_marker = state.path().join(format!("{suffix}-cut"));
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let request = ManagedCreateRequest::new(
            format!("precheckpoint-create-{suffix}"),
            format!("precheckpoint-session-{suffix}"),
            "precheckpoint-workspace",
            "fixture",
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
                state.path().to_string_lossy().into_owned(),
            )]))
            .unwrap(),
        )
        .unwrap();
        let mut broker = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .arg("--no-autostart")
            .arg(MANAGED_CREATE_BROKER_SUBCOMMAND)
            .current_dir(&cwd)
            .env(hmux_client::DISCOVERY_ROOT_ENV, &discovery_root)
            .env("HMUX_RUNTIME_TEST_GUARDIAN_CUT_PHASE", phase)
            .env("HMUX_RUNTIME_TEST_GUARDIAN_CUT_MARKER", &cut_marker)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        write_json_frame(broker.stdin.as_mut().unwrap(), &request).unwrap();
        drop(broker.stdin.take());

        while !cut_marker.exists() {
            assert!(
                broker.try_wait().unwrap().is_none(),
                "managed create broker exited before {phase}"
            );
            thread::sleep(Duration::from_millis(10));
        }
        let root = DiscoveryRoot::open(&discovery_root).unwrap();
        let found = root
            .find_current_manifest_by_session(request.workspace_id(), request.session_id())
            .unwrap();
        let DiscoveryManifest::Starting(starting) = found.manifest else {
            panic!("{phase} must retain the exact Starting manifest")
        };
        let release_barrier_advertised = starting
            .common
            .capabilities
            .iter()
            .any(|capability| capability == "managed_starting_provider_release_barrier_v1");
        let checkpoint_missing = managed_create_ledger::starting_generation(
            &discovery_root,
            request.workspace_id(),
            request.session_id(),
        )
        .unwrap()
        .is_none();
        let provider_unreleased = !provider_spawns.exists();
        let host = hmux_client::ProcessDescriptor {
            process_id: starting.common.host_process.process_id,
            start_marker: starting.common.host_process.start_marker,
        };
        assert_eq!(
            probe_local_process_generation(&host).unwrap(),
            LocalProcessGenerationStatus::Live
        );
        let host_pid = libc::pid_t::try_from(host.process_id).unwrap();
        // SAFETY: the exact start identity was observed immediately above and
        // this fixture owns the isolated managed Host generation.
        assert_eq!(unsafe { libc::kill(host_pid, libc::SIGKILL) }, 0);
        let absence_deadline = Instant::now() + Duration::from_secs(3);
        while probe_local_process_generation(&host).unwrap() != LocalProcessGenerationStatus::Absent
        {
            assert!(
                Instant::now() < absence_deadline,
                "the exact managed Host generation did not exit"
            );
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            release_barrier_advertised,
            "the Starting manifest must attest that provider execution is checkpoint-gated"
        );
        assert!(
            checkpoint_missing,
            "{phase} must precede the exact provider checkpoint"
        );
        assert!(
            provider_unreleased,
            "the provider crossed its effect boundary before the durable checkpoint"
        );

        let root_identity = ManagedCreateReconcileRequest::new(
            request.idempotency_key(),
            request.session_id(),
            request.workspace_id(),
        )
        .unwrap();
        let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
            .with_discovery_root(&discovery_root);
        let closed = stopper
            .stop_create_chain_v2(root_identity.clone())
            .expect("chain-stop must retire a provider-unreleased Starting generation");
        assert_eq!(closed.chain(), std::slice::from_ref(&root_identity));
        assert!(closed.stop_receipt().is_none());
        assert_eq!(stopper.stop_create_chain_v2(root_identity).unwrap(), closed);
        assert!(
            !provider_spawns.exists(),
            "reconciliation must never release the checkpoint-gated provider"
        );

        let broker_deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if broker.try_wait().unwrap().is_some() {
                break;
            }
            assert!(
                Instant::now() < broker_deadline,
                "managed create broker did not observe Host exit"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
fn terminal_identity_advance_persists_one_successor_before_target_create() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_spawns = state.path().join("provider-spawns");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "advance-create",
        "advance-session",
        "advance-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap()
    .with_managed_rehost_recipe(
        ManagedRehostRecipe::new(
            vec![
                "fixture".into(),
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
            ],
            Some("profile-a".into()),
        )
        .unwrap(),
    )
    .unwrap();

    run_crashing_managed_create(
        &discovery_root,
        &cwd,
        &request,
        "after_create_reservation_before_absence_checkpoint",
    );
    let terminal = ManagedSessionCreateReconciler::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .reconcile(
            ManagedCreateReconcileRequest::new(
                request.idempotency_key(),
                request.session_id(),
                request.workspace_id(),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(
        terminal,
        ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion
    );

    let (cut, response) = run_managed_create_advance(
        &discovery_root,
        &cwd,
        &request,
        Some("after_successor_persist_before_target_create"),
    );
    assert_eq!(cut.code(), Some(86));
    assert!(response.is_none());
    assert!(!provider_spawns.exists());
    let edges = successor_edges(&discovery_root);
    assert_eq!(edges.len(), 1);
    let persisted = edges[0]["successor"].clone();
    let persisted_session = persisted["sessionId"].as_str().unwrap();
    let persisted_create = persisted["idempotencyKey"].as_str().unwrap();
    let target = request
        .retarget_identity(persisted_create, persisted_session)
        .unwrap();
    let legacy_request = target
        .clone()
        .with_terminal_default_colors_option(None)
        .unwrap();
    let legacy_request = serde_json::to_string(&legacy_request).unwrap();
    assert_eq!(
        persisted["requestDigest"],
        request_fingerprint(&[&legacy_request])
    );
    let persisted_policy = &edges[0]["policyDigests"];
    let canonical = target.canonical_create_identity_json().unwrap();
    assert_eq!(
        persisted_policy["canonicalRequestDigest"],
        request_fingerprint(&[&canonical])
    );
    let rehost_recipe = serde_json::to_string(target.managed_rehost_recipe().unwrap()).unwrap();
    assert_eq!(
        persisted_policy["rehostRecipeDigest"],
        request_fingerprint(&[&rehost_recipe])
    );
    assert!(persisted_policy["canonicalRehostRecipe"].is_string());
    assert!(
        fs::read_dir(discovery_root.join(".managed-create-v2"))
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with("successor_digest_")),
        "v3 policy must have one create-shard authority path",
    );

    let changed = request
        .clone()
        .with_provider_state_environment(
            ProviderStateEnvironment::new(BTreeMap::from([(
                FIXTURE_STATE_DIR_ENV.into(),
                state
                    .path()
                    .join("changed-successor-policy")
                    .to_string_lossy()
                    .into_owned(),
            )]))
            .unwrap(),
        )
        .unwrap();

    let recovery_authority_changed = request
        .clone()
        .with_managed_rehost_recipe(
            ManagedRehostRecipe::new(
                vec![
                    "fixture".into(),
                    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                ],
                Some("profile-b".into()),
            )
            .unwrap(),
        )
        .unwrap();
    let (status, response) =
        run_managed_create_advance(&discovery_root, &cwd, &recovery_authority_changed, None);
    assert!(status.success());
    let ManagedCreateAdvanceBrokerResponse::Refused(failure) = response.unwrap() else {
        panic!("changed recovery authority must remain bound to the durable successor")
    };
    assert_eq!(failure.code, MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE);
    assert!(!provider_spawns.exists());

    let presentation_changed = request
        .clone()
        .with_terminal_default_colors(TerminalDefaultColors::new(0x12_34_56, 0x65_43_21).unwrap())
        .unwrap();
    let (status, response) =
        run_managed_create_advance(&discovery_root, &cwd, &presentation_changed, None);
    assert!(status.success());
    let ManagedCreateAdvanceBrokerResponse::Advanced(presentation_replay) = response.unwrap()
    else {
        panic!("presentation-only color drift must replay the durable successor")
    };
    assert_eq!(presentation_replay.session_id(), persisted_session);
    assert_eq!(presentation_replay.idempotency_key(), persisted_create);

    let presentation_changed_after_admission = request
        .clone()
        .with_terminal_default_colors(TerminalDefaultColors::new(0xAB_CD_EF, 0x10_32_54).unwrap())
        .unwrap();
    let (status, response) = run_managed_create_advance(
        &discovery_root,
        &cwd,
        &presentation_changed_after_admission,
        None,
    );
    assert!(status.success());
    let ManagedCreateAdvanceBrokerResponse::Advanced(presentation_readmission) = response.unwrap()
    else {
        panic!(
            "presentation-only color drift after target admission must replay the durable successor"
        )
    };
    assert_eq!(presentation_readmission.session_id(), persisted_session);
    assert_eq!(presentation_readmission.idempotency_key(), persisted_create);
    assert_eq!(
        presentation_readmission.generation_fence(),
        presentation_replay.generation_fence()
    );
    let persisted_rehost_recipe = managed_create_ledger::managed_rehost_recipe(
        &discovery_root,
        request.workspace_id(),
        persisted_session,
    )
    .unwrap()
    .expect("the admitted successor must retain its rehost source recipe");
    assert_eq!(
        persisted_rehost_recipe.terminal_default_colors(),
        request.terminal_default_colors(),
        "the atomic successor intent owns the full target policy before source retirement",
    );

    let (status, response) = run_managed_create_advance(&discovery_root, &cwd, &changed, None);
    assert!(status.success());
    let ManagedCreateAdvanceBrokerResponse::Refused(failure) = response.unwrap() else {
        panic!("a changed successor digest must fail closed")
    };
    assert_eq!(failure.code, MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE);
    assert_eq!(successor_edges(&discovery_root).len(), 1);

    let (status, response) =
        run_managed_create_advance(&discovery_root, &cwd, &presentation_changed, None);
    assert!(status.success());
    let response = response.unwrap();
    let ManagedCreateAdvanceBrokerResponse::Advanced(first) = response else {
        panic!("a terminal source must advance to its persisted successor: {response:?}")
    };
    assert_eq!(first.session_id(), persisted_session);
    assert_eq!(first.idempotency_key(), persisted_create);

    let resolved = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .resolve_successor_chain(
            ManagedCreateReconcileRequest::new(
                request.idempotency_key(),
                request.session_id(),
                request.workspace_id(),
            )
            .unwrap(),
        )
        .expect("a recipe-bearing admitted successor must remain readable from its root");
    let ManagedCreateChainResolution::Existing(resolved) = resolved else {
        panic!("the durable root must resolve to its admitted successor: {resolved:?}")
    };
    assert_eq!(resolved.receipt().session_id(), first.session_id());
    assert_eq!(
        resolved.receipt().idempotency_key(),
        first.idempotency_key()
    );

    let (status, response) =
        run_managed_create_advance(&discovery_root, &cwd, &presentation_changed, None);
    assert!(status.success());
    let ManagedCreateAdvanceBrokerResponse::Advanced(replayed) = response.unwrap() else {
        panic!("an exact retry must replay the same successor")
    };
    assert_eq!(replayed.session_id(), first.session_id());
    assert_eq!(replayed.idempotency_key(), first.idempotency_key());
    assert_eq!(replayed.generation_fence(), first.generation_fence());
}

#[test]
fn chain_stop_closes_a_successor_edge_left_unborn_by_advance_crash() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_spawns = state.path().join("provider-spawns");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "unborn-chain-create",
        "unborn-chain-session",
        "unborn-chain-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    DiscoveryRoot::create(&discovery_root).unwrap();
    let digest = request_fingerprint(&[&request.canonical_create_identity_json().unwrap()]);
    let ManagedCreateLedgerState::Prepared(mut source) = reserve(
        &discovery_root,
        request.workspace_id(),
        request.session_id(),
        request.idempotency_key(),
        &digest,
    )
    .unwrap() else {
        panic!("source must be prepared")
    };
    source.checkpoint_pre_spawn_absence().unwrap();
    source.abandon_before_completion().unwrap();

    let (cut, response) = run_managed_create_advance(
        &discovery_root,
        &cwd,
        &request,
        Some("after_successor_persist_before_target_create"),
    );
    assert_eq!(cut.code(), Some(86));
    assert!(response.is_none());
    assert!(!provider_spawns.exists());
    let edges = successor_edges(&discovery_root);
    assert_eq!(edges.len(), 1);
    let target = &edges[0]["successor"];
    let root = ManagedCreateReconcileRequest::new(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
    )
    .unwrap();
    let runtime = std::path::Path::new(env!("CARGO_BIN_EXE_hmux-runtime"));
    let stopper = ManagedSessionStopper::new(runtime, runtime.parent().unwrap())
        .with_discovery_root(&discovery_root);

    let closed = stopper.stop_create_chain_v2(root.clone()).unwrap();
    assert_eq!(closed.chain().len(), 2);
    assert_eq!(closed.root(), &root);
    assert_eq!(
        closed.effective().session_id(),
        target["sessionId"].as_str().unwrap(),
    );
    assert_eq!(
        closed.effective().idempotency_key(),
        target["idempotencyKey"].as_str().unwrap(),
    );
    assert!(closed.stop_receipt().is_none());
    assert_eq!(stopper.stop_create_chain_v2(root).unwrap(), closed);

    let creator = ManagedSessionCreator::new(runtime).with_discovery_root(&discovery_root);
    assert!(matches!(
        creator
            .create_or_reconcile_and_advance(request)
            .expect("closed authority must be a typed non-launching resolution"),
        ManagedCreateAdvanceResolution::AuthorityUnavailable(_)
    ));
    assert_eq!(successor_edges(&discovery_root).len(), 1);
    assert!(
        !provider_spawns.exists(),
        "cleanup-closed target must never launch its provider",
    );
}

#[test]
fn root_retry_advances_past_an_exited_successor_after_create_response_loss() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "successor-chain-create",
        "successor-chain-session",
        "successor-chain-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    creator.create(request.clone()).unwrap();
    wait_for_exited(
        &discovery_root,
        request.workspace_id(),
        request.session_id(),
    );

    let (cut, response) = run_managed_create_advance(
        &discovery_root,
        &cwd,
        &request,
        Some("managed_create:after_create_ledger_completed_before_broker_receipt"),
    );
    assert_eq!(cut.code(), Some(86));
    assert!(response.is_none());
    let edges = successor_edges(&discovery_root);
    assert_eq!(edges.len(), 1);
    let first_successor = &edges[0]["successor"];
    let first_session = first_successor["sessionId"].as_str().unwrap();
    wait_for_exited(&discovery_root, request.workspace_id(), first_session);

    let advanced = creator
        .create_or_reconcile_and_advance(request.clone())
        .expect("a root retry must traverse and retire the Exited successor");
    let ManagedCreateAdvanceResolution::Advanced(advanced) = advanced else {
        panic!("the root retry must reach a live successor")
    };
    assert_ne!(advanced.receipt().session_id(), request.session_id());
    assert_ne!(advanced.receipt().session_id(), first_session);
    assert_eq!(successor_edges(&discovery_root).len(), 2);

    let replayed = creator
        .create_or_reconcile_and_advance(request)
        .expect("the complete chain must replay from its root");
    let ManagedCreateAdvanceResolution::Advanced(replayed) = replayed else {
        panic!("the complete chain must return its live tail")
    };
    assert_eq!(
        replayed.receipt().session_id(),
        advanced.receipt().session_id()
    );
    assert_eq!(
        replayed.receipt().generation_fence(),
        advanced.receipt().generation_fence()
    );
}

#[test]
fn cleanup_claim_projects_closed_as_typed_advance_authority_without_allocating() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "cleanup-closed-create",
        "cleanup-closed-session",
        "cleanup-closed-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    creator.create(request.clone()).unwrap();
    let claimed = creator
        .claim_successor_chain_cleanup(
            ManagedCreateReconcileRequest::new(
                request.idempotency_key(),
                request.session_id(),
                request.workspace_id(),
            )
            .unwrap(),
        )
        .unwrap();
    assert!(matches!(claimed, ManagedCreateChainResolution::Existing(_)));
    wait_for_exited(
        &discovery_root,
        request.workspace_id(),
        request.session_id(),
    );

    let (status, response) = run_managed_create_advance(&discovery_root, &cwd, &request, None);
    assert!(status.success());
    let ManagedCreateAdvanceBrokerResponse::AuthorityUnavailable(authority) = response.unwrap()
    else {
        panic!("a closed cleanup slot must remain a typed advance authority boundary")
    };
    assert_eq!(
        authority.code,
        "hmux_managed_create_advance_authority_unavailable"
    );
    let records = successor_edges(&discovery_root);
    assert_eq!(records.len(), 1);
    assert!(records[0].get("successor").is_none());
    assert!(records[0]["cleanupClosedUnixMs"].as_u64().is_some());
}

#[test]
fn chain_stop_follows_an_admitted_successor_tail() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "chain-stop-successor-create",
        "chain-stop-successor-session",
        "chain-stop-successor-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    let runtime = std::path::Path::new(env!("CARGO_BIN_EXE_hmux-runtime"));
    let creator = ManagedSessionCreator::new(runtime).with_discovery_root(&discovery_root);
    creator.create(request.clone()).unwrap();
    wait_for_exited(
        &discovery_root,
        request.workspace_id(),
        request.session_id(),
    );
    fs::write(state.path().join("hold-open"), b"1").unwrap();
    let advanced = creator
        .create_or_reconcile_and_advance(request.clone())
        .unwrap();
    let ManagedCreateAdvanceResolution::Advanced(advanced) = advanced else {
        panic!("the exited root must advance to a live successor")
    };
    let root = ManagedCreateReconcileRequest::new(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
    )
    .unwrap();
    let stopper = ManagedSessionStopper::new(runtime, runtime.parent().unwrap())
        .with_discovery_root(&discovery_root);

    let stopped = stopper.stop_create_chain(root.clone()).unwrap();
    assert_eq!(stopped.root(), &root);
    assert_eq!(
        stopped.effective().session_id(),
        advanced.receipt().session_id()
    );
    assert_eq!(
        stopped.effective().idempotency_key(),
        advanced.receipt().idempotency_key()
    );
    assert_eq!(
        stopped.stop_receipt().unwrap().session_id(),
        advanced.receipt().session_id()
    );
    assert_eq!(stopper.stop_create_chain(root).unwrap(), stopped);
}

#[test]
fn chain_stop_from_successor_completes_ancestor_stop_journal() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "chain-stop-ancestor-create",
        "chain-stop-ancestor-session",
        "chain-stop-ancestor-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    let runtime = std::path::Path::new(env!("CARGO_BIN_EXE_hmux-runtime"));
    let creator = ManagedSessionCreator::new(runtime).with_discovery_root(&discovery_root);
    creator.create(request.clone()).unwrap();
    wait_for_exited(
        &discovery_root,
        request.workspace_id(),
        request.session_id(),
    );

    let (cut, response) = run_managed_create_advance(
        &discovery_root,
        &cwd,
        &request,
        Some("managed_stop:after_create_ledger_retirement"),
    );
    assert_eq!(cut.code(), Some(86));
    assert!(response.is_none());
    assert_eq!(
        hmux_client::recovery_journal::inspect(&discovery_root)
            .unwrap()
            .pending_records,
        1,
        "the source stop intent must still await its final journal commit",
    );

    let (cut, response) = run_managed_create_advance(
        &discovery_root,
        &cwd,
        &request,
        Some("after_successor_persist_before_target_create"),
    );
    assert_eq!(cut.code(), Some(86));
    assert!(response.is_none());
    fs::write(state.path().join("hold-open"), b"1").unwrap();
    let advanced = creator
        .create_or_reconcile_and_advance(request.clone())
        .unwrap();
    let ManagedCreateAdvanceResolution::Advanced(advanced) = advanced else {
        panic!("the retired source must advance to its durable successor")
    };
    assert_eq!(
        hmux_client::recovery_journal::inspect(&discovery_root)
            .unwrap()
            .pending_records,
        1,
        "successor creation must not silently discard the ancestor stop intent",
    );

    let source = ManagedCreateReconcileRequest::new(
        request.idempotency_key(),
        request.session_id(),
        request.workspace_id(),
    )
    .unwrap();
    let successor = ManagedCreateReconcileRequest::new(
        advanced.receipt().idempotency_key(),
        advanced.receipt().session_id(),
        advanced.receipt().workspace_id(),
    )
    .unwrap();
    let stopper = ManagedSessionStopper::new(runtime, runtime.parent().unwrap())
        .with_discovery_root(&discovery_root);
    let stopped = stopper.stop_create_chain_v2(successor.clone()).unwrap();
    assert_eq!(stopped.chain(), &[source, successor]);
    assert_eq!(
        hmux_client::recovery_journal::inspect(&discovery_root)
            .unwrap()
            .pending_records,
        0,
        "chain stop must complete every carried ancestor stop intent",
    );
}

#[test]
fn chain_capacity_preflight_preserves_the_live_tail_provider() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    fs::create_dir(&discovery_root).unwrap();
    fs::set_permissions(&discovery_root, fs::Permissions::from_mode(0o700)).unwrap();
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    fs::write(state.path().join("hold-open"), b"1").unwrap();
    let workspace_id = "capacity-preflight-workspace";
    let tail_index = MAX_MANAGED_CREATE_CHAIN_STOP_IDENTITIES - 1;
    let tail_request = ManagedCreateRequest::new(
        format!("capacity-create-{tail_index}"),
        format!("capacity-session-{tail_index}"),
        workspace_id,
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    let tail_identity = ManagedCreateReconcileRequest::new(
        tail_request.idempotency_key(),
        tail_request.session_id(),
        tail_request.workspace_id(),
    )
    .unwrap();
    let mut identities = (0..tail_index)
        .map(|index| {
            let session_id = (0_u32..)
                .map(|candidate| format!("capacity-session-{index}-{candidate}"))
                .find(|session_id| {
                    managed_create_ledger::successor_session_shares_create_shard(
                        &tail_identity,
                        session_id,
                    )
                    .unwrap()
                })
                .unwrap();
            ManagedCreateReconcileRequest::new(
                format!("capacity-create-{index}"),
                session_id,
                workspace_id,
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    identities.push(tail_identity);
    let requests = identities
        .iter()
        .map(|identity| {
            tail_request
                .retarget_identity(identity.idempotency_key(), identity.session_id())
                .unwrap()
        })
        .collect::<Vec<_>>();
    let policy_digests = requests
        .iter()
        .map(|request| {
            let request_without_colors = request
                .clone()
                .with_terminal_default_colors_option(None)
                .unwrap();
            let serialized_request = serde_json::to_string(&request_without_colors).unwrap();
            let canonical_request = request.canonical_create_identity_json().unwrap();
            (
                request_fingerprint(&[&serialized_request]),
                request_fingerprint(&[&canonical_request]),
            )
        })
        .collect::<Vec<_>>();

    for index in 0..tail_index {
        let source = &identities[index];
        let state = if index == 0 {
            reserve(
                &discovery_root,
                source.workspace_id(),
                source.session_id(),
                source.idempotency_key(),
                &policy_digests[index].1,
            )
            .map_err(ManagedCreateAdmissionError::from)
        } else {
            managed_create_ledger::reserve_successor_with_rehost_recipe_and_conversation(
                &discovery_root,
                source.workspace_id(),
                source.session_id(),
                source.idempotency_key(),
                &policy_digests[index].1,
                None,
                None,
            )
        }
        .unwrap();
        let ManagedCreateLedgerState::Prepared(mut source_reservation) = state else {
            panic!("capacity source {index} must be prepared")
        };
        source_reservation.checkpoint_pre_spawn_absence().unwrap();
        source_reservation.abandon_before_completion().unwrap();
        let target = &identities[index + 1];
        assert!(matches!(
            managed_create_ledger::reserve_terminal_successor(&discovery_root, source, || {
                ManagedCreateSuccessorIdentity::with_policy_digests(
                    target.session_id(),
                    target.idempotency_key(),
                    &policy_digests[index + 1].0,
                    &policy_digests[index + 1].1,
                    None,
                )
            },)
            .unwrap(),
            ManagedCreateSuccessorLedgerState::Created(_),
        ));
    }

    let runtime = std::path::Path::new(env!("CARGO_BIN_EXE_hmux-runtime"));
    let creator = ManagedSessionCreator::new(runtime).with_discovery_root(&discovery_root);
    let advanced = creator
        .create_or_reconcile_and_advance(requests[0].clone())
        .unwrap();
    let ManagedCreateAdvanceResolution::Advanced(receipt) = advanced else {
        panic!("the prepared chain must advance to its live tail")
    };
    assert_eq!(receipt.receipt().session_id(), tail_request.session_id());
    let provider_process = receipt.session().descriptor().provider_process.clone();
    assert_eq!(
        probe_local_process_generation(&provider_process).unwrap(),
        LocalProcessGenerationStatus::Live,
    );

    let changed_tail = ManagedCreateRequest::new(
        tail_request.idempotency_key(),
        tail_request.session_id(),
        tail_request.workspace_id(),
        "fixture",
        PermissionMode::BypassApprovals,
        &cwd,
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(
        ProviderStateEnvironment::new(BTreeMap::from([(
            FIXTURE_STATE_DIR_ENV.into(),
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    let (status, response) = run_managed_create_advance(&discovery_root, &cwd, &changed_tail, None);
    assert!(status.success());
    let Some(ManagedCreateAdvanceBrokerResponse::AuthorityUnavailable(authority)) = response else {
        panic!("the 129th identity must return bounded authority refusal")
    };
    assert!(
        authority
            .message
            .contains("successor would exceed 128 identities")
    );
    assert_eq!(
        probe_local_process_generation(&provider_process).unwrap(),
        LocalProcessGenerationStatus::Live,
        "capacity refusal must precede exact stop of the sole live tail provider",
    );

    fs::remove_file(state.path().join("hold-open")).unwrap();
    wait_for_exited(
        &discovery_root,
        tail_request.workspace_id(),
        tail_request.session_id(),
    );

    let overflow_session_id = (0_u32..)
        .map(|candidate| format!("capacity-overflow-session-{candidate}"))
        .find(|session_id| {
            managed_create_ledger::successor_session_shares_create_shard(
                &identities[tail_index],
                session_id,
            )
            .unwrap()
        })
        .unwrap();
    let overflow_request = tail_request
        .retarget_identity("capacity-overflow-create", &overflow_session_id)
        .unwrap();
    fs::write(state.path().join("hold-open"), b"1").unwrap();
    let overflow = creator.create(overflow_request.clone()).unwrap();
    let overflow_process = overflow.session().descriptor().provider_process.clone();
    inject_existing_v3_edge_without_capacity_check(
        &discovery_root,
        &identities[tail_index],
        &overflow_request,
    );

    let (status, response) = run_managed_create_advance(&discovery_root, &cwd, &requests[0], None);
    assert!(status.success());
    let Some(ManagedCreateAdvanceBrokerResponse::Refused(failure)) = response else {
        panic!("a retained 129th identity must return bounded authority refusal")
    };
    assert_eq!(
        failure.code,
        "hmux_managed_create_advance_authority_inconsistent"
    );
    assert!(
        failure
            .message
            .contains("successor chain exceeds 128 identities")
    );
    assert_eq!(
        probe_local_process_generation(&overflow_process).unwrap(),
        LocalProcessGenerationStatus::Live,
        "retained-chain capacity refusal must not touch the 129th provider",
    );

    fs::remove_file(state.path().join("hold-open")).unwrap();
    wait_for_exited(
        &discovery_root,
        overflow_request.workspace_id(),
        overflow_request.session_id(),
    );
}

#[test]
fn reserved_successor_rejects_root_takeover_and_one_advance_allocates_one_edge() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "effect-boundary-create",
        "effect-boundary-session",
        "effect-boundary-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();

    run_crashing_managed_create(
        &discovery_root,
        &cwd,
        &request,
        "after_create_reservation_before_absence_checkpoint",
    );
    let reconciler = ManagedSessionCreateReconciler::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    assert_eq!(
        reconciler
            .reconcile(
                ManagedCreateReconcileRequest::new(
                    request.idempotency_key(),
                    request.session_id(),
                    request.workspace_id(),
                )
                .unwrap(),
            )
            .unwrap(),
        ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion
    );

    let pause_marker = state.path().join("advance-effect-paused");
    let resume_marker = pause_marker.with_extension("resume");
    let mut broker = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND)
        .current_dir(&cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, &discovery_root)
        .env(
            "HMUX_TEST_MANAGED_CREATE_ADVANCE_PAUSE_MARKER",
            &pause_marker,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    write_json_frame(
        broker.stdin.as_mut().unwrap(),
        &ManagedCreateAdvanceRequest::new(request.clone()).unwrap(),
    )
    .unwrap();
    drop(broker.stdin.take());

    let pause_deadline = Instant::now() + Duration::from_secs(3);
    while !pause_marker.exists() {
        assert!(
            Instant::now() < pause_deadline,
            "advance did not publish its first durable successor edge"
        );
        thread::sleep(Duration::from_millis(10));
    }
    let edges = successor_edges(&discovery_root);
    assert_eq!(edges.len(), 1);
    let first = &edges[0]["successor"];
    let first_session = first["sessionId"].as_str().unwrap().to_string();
    let first_create = first["idempotencyKey"].as_str().unwrap().to_string();
    let first_target = request
        .retarget_identity(&first_create, &first_session)
        .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let root_error = creator
        .create(first_target.clone())
        .expect_err("an external Root create must not consume reserved successor authority");
    assert!(
        root_error
            .to_string()
            .contains("target lineage is already claimed")
    );

    fs::write(&resume_marker, b"resume").unwrap();
    let completion_deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        if let Some(status) = broker.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= completion_deadline {
            broker.kill().unwrap();
            let _ = broker.wait();
            panic!("one advance invocation did not stop after its first successor effect");
        }
        thread::sleep(Duration::from_millis(10));
    };
    let response = read_json_frame(broker.stdout.as_mut().unwrap()).unwrap();
    assert!(status.success());
    let ManagedCreateAdvanceBrokerResponse::Advanced(created) = response else {
        panic!("the owning advance broker must consume its reserved successor")
    };
    assert_eq!(created.session_id(), first_session);
    wait_for_exited(&discovery_root, request.workspace_id(), &first_session);
    assert_eq!(
        successor_edges(&discovery_root).len(),
        1,
        "one invocation must allocate only its reserved edge"
    );

    fs::write(state.path().join("hold-open"), b"1").unwrap();
    let advanced = creator
        .create_or_reconcile_and_advance(request)
        .expect("the next explicit call must continue from the durable edge");
    let ManagedCreateAdvanceResolution::Advanced(advanced) = advanced else {
        panic!("the replay must reach the next successor generation")
    };
    assert_ne!(advanced.receipt().session_id(), first_session);
    assert_eq!(successor_edges(&discovery_root).len(), 2);
}

#[test]
fn corrupted_successor_cycle_fails_closed_without_retry_hop_limits() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "successor-cycle-create",
        "successor-cycle-session",
        "successor-cycle-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    creator.create(request.clone()).unwrap();
    wait_for_exited(
        &discovery_root,
        request.workspace_id(),
        request.session_id(),
    );

    let (cut, response) = run_managed_create_advance(
        &discovery_root,
        &cwd,
        &request,
        Some("managed_create:after_create_ledger_completed_before_broker_receipt"),
    );
    assert_eq!(cut.code(), Some(86));
    assert!(response.is_none());
    let edges = successor_edges(&discovery_root);
    assert_eq!(edges.len(), 1);
    let first_successor_session = edges[0]["successor"]["sessionId"]
        .as_str()
        .unwrap()
        .to_string();
    wait_for_exited(
        &discovery_root,
        request.workspace_id(),
        &first_successor_session,
    );

    let advanced = creator
        .create_or_reconcile_and_advance(request.clone())
        .expect("the exited first successor must reserve a second edge");
    assert!(matches!(
        advanced,
        ManagedCreateAdvanceResolution::Advanced(_)
    ));
    assert_eq!(successor_edges(&discovery_root).len(), 2);

    let root_digest = request_fingerprint(&[&serde_json::to_string(
        &request
            .clone()
            .with_terminal_default_colors_option(None)
            .unwrap(),
    )
    .unwrap()]);
    rewrite_successor_target(
        &discovery_root,
        &first_successor_session,
        request.session_id(),
        request.idempotency_key(),
        &root_digest,
    );

    let (status, response) = run_managed_create_advance(&discovery_root, &cwd, &request, None);
    assert!(status.success());
    let Some(ManagedCreateAdvanceBrokerResponse::Refused(failure)) = response else {
        panic!("an immutable successor identity cycle must fail closed")
    };
    assert_eq!(
        failure.code, "hmux_managed_create_advance_authority_inconsistent",
        "unexpected cycle response: {failure:?}",
    );
    assert_eq!(successor_edges(&discovery_root).len(), 2);
}

#[test]
fn completed_legacy_no_conversation_exited_generation_advances_with_crash_replay() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "exited-advance-create",
        "exited-advance-session",
        "exited-advance-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();

    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let source = creator.create(request.clone()).unwrap();
    let source_fence = source.receipt().generation_fence().unwrap().clone();
    wait_for_exited(
        &discovery_root,
        request.workspace_id(),
        request.session_id(),
    );
    let ordinary_retry = creator
        .create_with_disposition(request.clone())
        .expect_err("ordinary create must remain non-destructive after exact exit");
    assert_eq!(
        ordinary_retry.disposition(),
        ManagedCreateFailureDisposition::Retryable,
        "unexpected ordinary retry: {ordinary_retry:?}",
    );

    for fault in [
        "managed_stop:after_stop_receipt_checkpoint",
        "managed_stop:after_create_ledger_retirement_checkpoint",
        "after_source_retirement_before_successor",
    ] {
        let (status, response) =
            run_managed_create_advance(&discovery_root, &cwd, &request, Some(fault));
        assert_eq!(
            status.code(),
            Some(86),
            "fault point {fault} was not reached"
        );
        assert!(response.is_none());
    }
    let source_state = creator
        .reconcile_identity(
            ManagedCreateReconcileRequest::new(
                request.idempotency_key(),
                request.session_id(),
                request.workspace_id(),
            )
            .unwrap(),
        )
        .unwrap();
    assert!(matches!(
        source_state,
        ManagedCreateIdentityResolution::Retired
    ));

    let (cut, response) = run_managed_create_advance(
        &discovery_root,
        &cwd,
        &request,
        Some("after_successor_persist_before_target_create"),
    );
    assert_eq!(cut.code(), Some(86));
    assert!(response.is_none());

    let first = creator
        .create_or_reconcile_and_advance(request.clone())
        .expect("the exact retry must finish the durable successor");
    let ManagedCreateAdvanceResolution::Advanced(first) = first else {
        panic!("the completed Exited source must advance inside the Hmux broker")
    };
    assert_ne!(first.receipt().session_id(), request.session_id());
    assert_ne!(first.receipt().generation_fence(), Some(&source_fence));

    let replayed = creator
        .create_or_reconcile_and_advance(request)
        .expect("the completed advance must replay");
    let ManagedCreateAdvanceResolution::Advanced(replayed) = replayed else {
        panic!("the exact retry must replay the successor")
    };
    assert_eq!(
        replayed.receipt().session_id(),
        first.receipt().session_id()
    );
    assert_eq!(
        replayed.receipt().idempotency_key(),
        first.receipt().idempotency_key()
    );
    assert_eq!(
        replayed.receipt().generation_fence(),
        first.receipt().generation_fence()
    );
}

#[test]
fn gc_preserves_completed_exited_sources_until_explicit_advance() {
    for with_conversation in [true, false] {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let suffix = if with_conversation {
            "conversation"
        } else {
            "legacy"
        };
        let mut request = ManagedCreateRequest::new(
            format!("gc-source-create-{suffix}"),
            format!("gc-source-session-{suffix}"),
            "gc-source-workspace",
            "fixture",
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
                state.path().to_string_lossy().into_owned(),
            )]))
            .unwrap(),
        )
        .unwrap();
        if with_conversation {
            request = request
                .with_conversation_identity(
                    ProviderConversationIdentitySeed::new(
                        "fixture",
                        format!("gc-source-conversation-{suffix}"),
                    )
                    .unwrap(),
                )
                .unwrap()
                .with_required_managed_stop_request_version(
                    hmux_client::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
                )
                .unwrap();
        }
        let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .with_discovery_root(&discovery_root);
        creator.create(request.clone()).unwrap();
        wait_for_exited(
            &discovery_root,
            request.workspace_id(),
            request.session_id(),
        );
        if with_conversation {
            wait_for_conversation_writer_release(
                &discovery_root,
                request.workspace_id(),
                request.session_id(),
            );
        }
        let source_path = SessionLookupKey::new(request.workspace_id(), request.session_id())
            .unwrap()
            .relative_path();
        assert!(
            managed_create_ledger::pending_session_paths(&discovery_root)
                .unwrap()
                .contains(&source_path),
            "completed/unretired source must remain GC-protected after {suffix} exit"
        );

        apply_aggressive_gc(&discovery_root);

        let advanced = creator
            .create_or_reconcile_and_advance(request)
            .expect("GC must preserve exact Exited evidence through explicit retirement");
        assert!(matches!(
            advanced,
            ManagedCreateAdvanceResolution::Advanced(_)
        ));
    }
}

#[test]
fn crash_after_unverified_reservation_converges_on_exact_retry() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_spawns = state.path().join("provider-spawns");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "unverified-create",
        "unverified-session",
        "unverified-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();

    run_crashing_managed_create(
        &discovery_root,
        &cwd,
        &request,
        "after_create_reservation_before_absence_checkpoint",
    );
    assert!(!provider_spawns.exists());

    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(request)
        .expect("the exact retry must recheck absence and checkpoint durably");
    assert_eq!(created.receipt().session_id(), "unverified-session");
    let deadline = Instant::now() + Duration::from_secs(2);
    while !provider_spawns.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(provider_spawns.exists());
}

#[test]
fn changed_policy_after_unverified_crash_terminalizes_without_a_spawn() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let provider_spawns = state.path().join("provider-spawns");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let original = ManagedCreateRequest::new(
        "unverified-policy-create",
        "unverified-policy-session",
        "unverified-policy-workspace",
        "fixture",
        PermissionMode::Default,
        &cwd,
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap();
    run_crashing_managed_create(
        &discovery_root,
        &cwd,
        &original,
        "after_create_reservation_before_absence_checkpoint",
    );
    let changed = original
        .clone()
        .with_provider_state_environment(
            ProviderStateEnvironment::new(BTreeMap::from([(
                FIXTURE_STATE_DIR_ENV.into(),
                state.path().to_string_lossy().into_owned(),
            )]))
            .unwrap(),
        )
        .unwrap();
    let resolution = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create_or_reconcile(changed)
        .unwrap();
    assert!(matches!(
        resolution,
        ManagedCreateResolution::AbandonedBeforeCompletion
    ));
    assert!(
        !provider_spawns.exists(),
        "identity-only convergence must not launch either canonical policy"
    );
    let retired = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create_with_disposition(original)
        .unwrap_err();
    assert_eq!(
        retired.code(),
        hmux_client::MANAGED_CREATE_RETIRED_EXACT_CODE
    );
}

#[test]
fn live_exact_host_generation_remains_pending_and_keeps_its_reservation() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    DiscoveryRoot::create(&discovery_root).unwrap();
    let ManagedCreateLedgerState::Prepared(mut reservation) = reserve(
        &discovery_root,
        "live-workspace",
        "live-session",
        "live-create",
        &"11".repeat(32),
    )
    .unwrap() else {
        panic!("the first create identity must be prepared")
    };
    reservation.checkpoint_pre_spawn_absence().unwrap();
    reservation
        .mark_spawn_reserved(exact_local_process_generation(std::process::id()).unwrap())
        .unwrap();

    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let response = reconcile_raw(
        &discovery_root,
        &cwd,
        "live-create",
        "live-session",
        "live-workspace",
    );
    assert_eq!(response["state"], "pending", "{response:#}");

    let request =
        ManagedCreateReconcileRequest::new("live-create", "live-session", "live-workspace")
            .unwrap();
    assert!(matches!(
        reconcile_identity(&discovery_root, &request).unwrap(),
        ManagedCreateReconcileLedgerState::SpawnReserved { .. }
    ));

    let create = ManagedCreateRequest::new(
        "live-create",
        "live-session",
        "live-workspace",
        "fixture",
        PermissionMode::Default,
        &cwd,
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap();
    let (status, response) = run_managed_create_advance(&discovery_root, &cwd, &create, None);
    assert!(status.success());
    assert!(matches!(
        response,
        Some(ManagedCreateAdvanceBrokerResponse::Pending)
    ));
    assert!(
        fs::read_dir(discovery_root.join(".managed-create-v2"))
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !is_successor_edge_shard_name(&entry.file_name().to_string_lossy())),
        "pending source authority must not allocate a successor"
    );
}

#[test]
fn prepared_reconcile_preserves_a_live_pre_ledger_generation_and_writer_claim() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let conversation =
        ProviderConversationIdentitySeed::new("fixture", "conversation-live").unwrap();
    fs::write(state.path().join("hold-open"), b"1").unwrap();
    let request = ManagedCreateRequest::new(
        "pre-ledger-create",
        "pre-ledger-session",
        "pre-ledger-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap()
    .with_conversation_identity(conversation.clone())
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
    )
    .unwrap();

    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(request.clone())
        .unwrap();
    assert_eq!(created.receipt().session_id(), request.session_id());
    let provider_process = created.session().descriptor().provider_process.clone();

    fs::remove_dir_all(discovery_root.join(".managed-create-v2")).unwrap();
    let retry = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create_with_disposition(request.clone())
        .expect_err("a pre-ledger live generation requires explicit recovery");
    assert_eq!(
        retry.disposition(),
        ManagedCreateFailureDisposition::Retryable
    );

    let response = ManagedSessionCreateReconciler::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .reconcile(
            ManagedCreateReconcileRequest::new(
                request.idempotency_key(),
                request.session_id(),
                request.workspace_id(),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(
        response,
        ManagedCreateReconcileBrokerResponse::Pending,
        "Prepared is not proof of absence when pre-ledger discovery is live"
    );

    let session_path = discovery_root.join(
        SessionLookupKey::new(request.workspace_id(), request.session_id())
            .unwrap()
            .relative_path(),
    );
    fs::remove_file(session_path.join("manifest.json")).unwrap();
    assert_eq!(
        probe_local_process_generation(&provider_process).unwrap(),
        LocalProcessGenerationStatus::Live,
        "removing discovery must not be mistaken for provider-process absence"
    );
    let missing_manifest_retry = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create_with_disposition(request.clone())
        .expect_err("an unverified record cannot be promoted after discovery disappears");
    assert_eq!(
        missing_manifest_retry.disposition(),
        ManagedCreateFailureDisposition::Retryable
    );
    assert_eq!(
        ManagedSessionCreateReconciler::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .with_discovery_root(&discovery_root)
            .reconcile(
                ManagedCreateReconcileRequest::new(
                    request.idempotency_key(),
                    request.session_id(),
                    request.workspace_id(),
                )
                .unwrap(),
            )
            .unwrap(),
        ManagedCreateReconcileBrokerResponse::Pending,
        "discovery absence alone cannot release an unverified writer claim"
    );

    let competing = match reserve_with_rehost_recipe_and_conversation(
        &discovery_root,
        "pre-ledger-workspace",
        "competing-session",
        "competing-create",
        &"22".repeat(32),
        None,
        Some(&conversation),
    ) {
        Err(error) => error,
        Ok(_) => panic!("the live pre-ledger writer claim must remain held"),
    };
    assert!(matches!(
        competing,
        ManagedCreateAdmissionError::ConversationWriterConflict { .. }
    ));
}

#[test]
fn absent_identity_reconcile_is_a_non_creating_typed_miss() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let response = ManagedSessionCreateReconciler::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .reconcile(
            ManagedCreateReconcileRequest::new(
                "absent-create",
                "absent-session",
                "absent-workspace",
            )
            .unwrap(),
        )
        .unwrap();

    assert_eq!(response, ManagedCreateReconcileBrokerResponse::NotFound);
    let typed = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .reconcile_identity(
            ManagedCreateReconcileRequest::new(
                "absent-create",
                "absent-session",
                "absent-workspace",
            )
            .unwrap(),
        )
        .unwrap();
    assert!(matches!(typed, ManagedCreateIdentityResolution::NotFound));
    assert!(
        !discovery_root.exists(),
        "an identity-only miss must not create ledger or discovery authority"
    );
}

#[test]
fn prepared_failure_reconcile_terminalizes_only_the_old_logical_identity() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let fault_marker = state.path().join("pre-spawn-fault");
    let provider_spawns = state.path().join("provider-spawns");
    fs::write(&fault_marker, b"fail").unwrap();
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let environment = ProviderStateEnvironment::new(BTreeMap::from([(
        FIXTURE_STATE_DIR_ENV.into(),
        state.path().to_string_lossy().into_owned(),
    )]))
    .unwrap();
    let request = ManagedCreateRequest::new(
        "prepared-create",
        "prepared-session",
        "prepared-workspace",
        "fixture",
        PermissionMode::Default,
        &cwd,
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(environment.clone())
    .unwrap();
    assert!(matches!(
        run_definite_pre_spawn_failure(&discovery_root, &cwd, &request, &fault_marker),
        ManagedCreateBrokerResponse::Refused(_)
    ));
    assert_eq!(fs::read(&fault_marker).unwrap(), b"observed");
    assert!(!provider_spawns.exists());

    let abandoned = ManagedSessionCreateReconciler::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .reconcile(
            ManagedCreateReconcileRequest::new(
                request.idempotency_key(),
                request.session_id(),
                request.workspace_id(),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(
        abandoned,
        ManagedCreateReconcileBrokerResponse::AbandonedBeforeCompletion
    );

    let replacement = ManagedCreateRequest::new(
        "replacement-create",
        "replacement-session",
        "prepared-workspace",
        "fixture",
        PermissionMode::Default,
        &cwd,
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(environment)
    .unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(replacement)
        .unwrap();
    assert_eq!(created.receipt().session_id(), "replacement-session");
    let deadline = Instant::now() + Duration::from_secs(2);
    while !provider_spawns.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(provider_spawns.exists());
}

#[test]
fn provider_environment_policy_upgrade_replays_one_exact_successor() {
    for (suffix, source_environment, target_environment) in [
        (
            "empty-to-removal",
            ProviderStateEnvironment::default(),
            ProviderStateEnvironment::from_mutations(
                BTreeMap::new(),
                BTreeSet::from(["CODEX_HOME".into(), "CODEX_SQLITE_HOME".into()]),
            )
            .unwrap(),
        ),
        (
            "set-only-to-set-and-remove",
            ProviderStateEnvironment::new(BTreeMap::from([(
                "CODEX_HOME".into(),
                "/tmp/hmux-policy-upgrade-profile".into(),
            )]))
            .unwrap(),
            ProviderStateEnvironment::from_mutations(
                BTreeMap::from([(
                    "CODEX_HOME".into(),
                    "/tmp/hmux-policy-upgrade-profile".into(),
                )]),
                BTreeSet::from(["OPENAI_API_KEY".into()]),
            )
            .unwrap(),
        ),
    ] {
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let provider_starts = state.path().join("provider-starts");
        let hold_open = state.path().join("hold-open");
        fs::write(&hold_open, b"1").unwrap();
        let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
        let command = vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf '%s\\n' \"$$\" >> \"$1\"; while [ -e \"$2\" ]; do sleep 0.02; done".into(),
            "--".into(),
            provider_starts.to_string_lossy().into_owned(),
            hold_open.to_string_lossy().into_owned(),
        ];
        let source = ManagedCreateRequest::new(
            format!("policy-upgrade-{suffix}-create"),
            format!("policy-upgrade-{suffix}-session"),
            format!("policy-upgrade-{suffix}-workspace"),
            "fixture",
            PermissionMode::Default,
            &cwd,
            command,
            24,
            80,
        )
        .unwrap();
        let source = if source_environment.is_empty() {
            source
        } else {
            source
                .with_provider_state_environment(source_environment)
                .unwrap()
        };

        run_crashing_managed_create(
            &discovery_root,
            &cwd,
            &source,
            "after_create_ledger_completed_before_broker_receipt",
        );
        let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
            .with_discovery_root(&discovery_root);
        let source_identity = ManagedCreateReconcileRequest::new(
            source.idempotency_key(),
            source.session_id(),
            source.workspace_id(),
        )
        .unwrap();
        let ManagedCreateIdentityResolution::Existing(source_generation) =
            creator.reconcile_identity(source_identity.clone()).unwrap()
        else {
            panic!("the response-lost legacy source must remain exact and live")
        };
        let source_process = source_generation
            .session()
            .descriptor()
            .provider_process
            .clone();
        drop(source_generation);

        let upgraded = source
            .clone()
            .with_provider_state_environment(target_environment)
            .unwrap();
        let (cut, response) = run_managed_create_advance(
            &discovery_root,
            &cwd,
            &upgraded,
            Some("managed_create:after_create_ledger_completed_before_broker_receipt"),
        );
        assert_eq!(cut.code(), Some(86));
        assert!(response.is_none());
        assert_eq!(successor_edges(&discovery_root).len(), 1);

        let advanced = creator
            .create_or_reconcile_and_advance(upgraded.clone())
            .expect("the exact policy-upgrade retry must replay its durable successor");
        let ManagedCreateAdvanceResolution::Advanced(successor) = advanced else {
            panic!("a changed provider policy must advance to one new identity")
        };
        assert_ne!(successor.receipt().session_id(), source.session_id());
        assert_ne!(
            successor.receipt().idempotency_key(),
            source.idempotency_key()
        );
        let successor_process = successor.session().descriptor().provider_process.clone();
        wait_for_exact_process_absence(&source_process, "retired policy source provider");
        assert_eq!(
            probe_local_process_generation(&successor_process).unwrap(),
            LocalProcessGenerationStatus::Live
        );
        assert_eq!(
            fs::read_to_string(&provider_starts)
                .unwrap()
                .lines()
                .count(),
            2,
            "response replay must not launch a duplicate provider"
        );

        let stale = creator
            .create_or_reconcile_and_advance(source)
            .expect_err("the old policy must not alias the upgraded successor");
        assert_eq!(
            stale.code(),
            hmux_client::MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE
        );
        assert_eq!(
            probe_local_process_generation(&successor_process).unwrap(),
            LocalProcessGenerationStatus::Live,
            "a stale policy retry must preserve the upgraded provider"
        );
        assert!(matches!(
            creator.reconcile_identity(source_identity).unwrap(),
            ManagedCreateIdentityResolution::Retired
        ));

        fs::remove_file(&hold_open).unwrap();
        wait_for_exact_process_absence(&successor_process, "upgraded policy provider");
    }
}

#[test]
fn completed_active_different_digest_advances_with_exact_source_fence() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    fs::write(state.path().join("hold-open"), b"1").unwrap();
    let original = ManagedCreateRequest::new(
        "legacy-policy-create",
        "legacy-policy-session",
        "legacy-policy-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("fixture", "legacy-policy-conversation").unwrap(),
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
    )
    .unwrap();
    run_crashing_managed_create(
        &discovery_root,
        &cwd,
        &original,
        "after_create_ledger_completed_before_broker_receipt",
    );

    let changed_state = state.path().join("changed-provider-state");
    fs::create_dir(&changed_state).unwrap();
    fs::write(changed_state.join("hold-open"), b"1").unwrap();
    let changed_policy = original
        .clone()
        .with_provider_state_environment(
            ProviderStateEnvironment::new(BTreeMap::from([(
                FIXTURE_STATE_DIR_ENV.into(),
                changed_state.to_string_lossy().into_owned(),
            )]))
            .unwrap(),
        )
        .unwrap();
    let changed_target = changed_policy
        .clone()
        .with_conversation_identity(
            ProviderConversationIdentitySeed::new("fixture", "changed-policy-conversation")
                .unwrap(),
        )
        .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let current = creator
        .create_or_reconcile_and_advance(original.clone())
        .expect("the exact active request must remain current");
    let ManagedCreateAdvanceResolution::Current(current) = current else {
        panic!("the exact active request must not enter normalization")
    };
    assert_eq!(current.receipt().session_id(), original.session_id());
    drop(current);
    let conflict = creator
        .create_with_disposition(changed_policy.clone())
        .expect_err("a policy upgrade must not alias the old request digest");
    assert_eq!(
        conflict.disposition(),
        ManagedCreateFailureDisposition::Rejected
    );
    assert_eq!(
        conflict.code(),
        hmux_client::MANAGED_CREATE_REQUEST_DIGEST_CONFLICT_CODE
    );

    let resolution = creator.create_or_reconcile(changed_policy.clone()).unwrap();
    let ManagedCreateResolution::NormalizeExisting(prior) = resolution else {
        panic!("the old canonical generation must require explicit normalization")
    };
    assert_eq!(prior.receipt().provider_id(), original.provider_id());
    assert_eq!(
        prior.session().descriptor().terminal_epoch,
        prior.receipt().generation_fence().unwrap().terminal_epoch()
    );
    let source_fence = prior.receipt().generation_fence().unwrap().clone();
    drop(prior);

    for fault in [
        "managed_stop:after_stop_receipt_checkpoint",
        "managed_stop:after_create_ledger_retirement_checkpoint",
        "after_source_retirement_before_successor",
    ] {
        let (status, response) =
            run_managed_create_advance(&discovery_root, &cwd, &changed_target, Some(fault));
        assert_eq!(
            status.code(),
            Some(86),
            "fault point {fault} was not reached"
        );
        assert!(response.is_none());
    }

    let (cut, response) = run_managed_create_advance(
        &discovery_root,
        &cwd,
        &changed_target,
        Some("after_successor_persist_before_target_create"),
    );
    assert_eq!(cut.code(), Some(86));
    assert!(response.is_none());

    let advanced = creator
        .create_or_reconcile_and_advance(changed_target.clone())
        .expect("the exact retry must finish the changed-policy successor");
    let ManagedCreateAdvanceResolution::Advanced(first) = advanced else {
        panic!("the active old-policy source must advance inside the Hmux broker")
    };
    assert_ne!(first.receipt().session_id(), original.session_id());
    assert_ne!(
        first.receipt().idempotency_key(),
        original.idempotency_key()
    );
    assert_ne!(first.receipt().generation_fence(), Some(&source_fence));
    let successor_process = first.session().descriptor().provider_process.clone();

    let (status, response) = run_managed_create_advance(&discovery_root, &cwd, &original, None);
    assert!(status.success());
    let Some(ManagedCreateAdvanceBrokerResponse::Refused(failure)) = response else {
        panic!("a stale root policy must not follow an edge reserved for newer policy")
    };
    assert_eq!(failure.code, MANAGED_CREATE_SUCCESSOR_DIGEST_CONFLICT_CODE);
    assert_eq!(
        failure.effective_disposition(),
        ManagedCreateFailureDisposition::Rejected
    );
    assert_eq!(
        probe_local_process_generation(&successor_process).unwrap(),
        LocalProcessGenerationStatus::Live,
        "a stale root retry must not stop the newer-policy successor"
    );

    let replayed = creator
        .create_or_reconcile_and_advance(changed_target)
        .expect("the completed changed-policy advance must replay");
    let ManagedCreateAdvanceResolution::Advanced(replayed) = replayed else {
        panic!("the exact retry must replay the changed-policy successor")
    };
    assert_eq!(
        replayed.receipt().session_id(),
        first.receipt().session_id()
    );
    assert_eq!(
        replayed.receipt().idempotency_key(),
        first.receipt().idempotency_key()
    );
    assert_eq!(
        replayed.receipt().generation_fence(),
        first.receipt().generation_fence()
    );

    let recovered = reconcile_raw(
        &discovery_root,
        &cwd,
        original.idempotency_key(),
        original.session_id(),
        original.workspace_id(),
    );
    assert_eq!(recovered["state"], "retired");
    let replayed = ManagedSessionCreateReconciler::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .reconcile(
            ManagedCreateReconcileRequest::new(
                original.idempotency_key(),
                original.session_id(),
                original.workspace_id(),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(replayed, ManagedCreateReconcileBrokerResponse::Retired);
    let typed = creator
        .reconcile_identity(
            ManagedCreateReconcileRequest::new(
                original.idempotency_key(),
                original.session_id(),
                original.workspace_id(),
            )
            .unwrap(),
        )
        .unwrap();
    assert!(matches!(typed, ManagedCreateIdentityResolution::Retired));
}

#[test]
fn explicit_replace_current_advances_an_identical_launch_policy() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    fs::write(state.path().join("hold-open"), b"1").unwrap();
    let request = ManagedCreateRequest::new(
        "resume-replace-create",
        "resume-replace-session",
        "resume-replace-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("fixture", "resume-replace-conversation").unwrap(),
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
    )
    .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let source = creator.create(request.clone()).unwrap();
    let source_fence = source.receipt().generation_fence().cloned();
    drop(source);

    let advanced = creator
        .replace_current_and_advance(request.clone())
        .expect("explicit Resume replacement must create one successor");
    let ManagedCreateAdvanceResolution::Advanced(first) = advanced else {
        panic!("explicit Resume replacement returned the source generation")
    };
    assert_ne!(first.receipt().session_id(), request.session_id());
    assert_ne!(first.receipt().idempotency_key(), request.idempotency_key());
    assert_ne!(first.receipt().generation_fence(), source_fence.as_ref());

    let replayed = creator
        .replace_current_and_advance(request)
        .expect("explicit Resume replacement must replay its durable successor");
    let ManagedCreateAdvanceResolution::Advanced(replayed) = replayed else {
        panic!("explicit Resume replacement replay returned the source generation")
    };
    assert_eq!(
        replayed.receipt().session_id(),
        first.receipt().session_id()
    );
    assert_eq!(
        replayed.receipt().idempotency_key(),
        first.receipt().idempotency_key()
    );
    assert_eq!(
        replayed.receipt().generation_fence(),
        first.receipt().generation_fence()
    );
    drop(replayed);
    drop(first);
    fs::remove_file(state.path().join("hold-open")).unwrap();
}

#[test]
fn explicit_replace_current_attempts_a_target_when_the_source_is_absent() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    fs::write(state.path().join("hold-open"), b"1").unwrap();
    let request = ManagedCreateRequest::new(
        "resume-absent-create",
        "resume-absent-session",
        "resume-absent-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("fixture", "resume-absent-conversation").unwrap(),
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
    )
    .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);

    let advanced = creator
        .replace_current_and_advance(request.clone())
        .expect("an absent historical source must not reject the new Host attempt");
    let ManagedCreateAdvanceResolution::Advanced(first) = advanced else {
        panic!("absent-source Resume did not return its new Host")
    };
    assert_ne!(first.receipt().session_id(), request.session_id());
    assert_ne!(first.receipt().idempotency_key(), request.idempotency_key());

    let replayed = creator
        .replace_current_and_advance(request)
        .expect("absent-source Resume replay must resolve the same Host");
    let ManagedCreateAdvanceResolution::Advanced(replayed) = replayed else {
        panic!("absent-source Resume replay did not return its new Host")
    };
    assert_eq!(
        replayed.receipt().session_id(),
        first.receipt().session_id()
    );
    assert_eq!(
        replayed.receipt().idempotency_key(),
        first.receipt().idempotency_key()
    );
    assert_eq!(
        replayed.receipt().generation_fence(),
        first.receipt().generation_fence()
    );
    drop(replayed);
    drop(first);
    fs::remove_file(state.path().join("hold-open")).unwrap();
}

#[test]
fn explicit_replace_current_replays_a_ready_target_across_launch_policy_drift() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    fs::write(state.path().join("hold-open"), b"1").unwrap();
    let request = ManagedCreateRequest::new(
        "resume-policy-create",
        "resume-policy-session",
        "resume-policy-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("fixture", "resume-policy-conversation").unwrap(),
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
    )
    .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let first = creator
        .replace_current_and_advance(request.clone())
        .expect("initial Resume must create its target");
    let ManagedCreateAdvanceResolution::Advanced(first) = first else {
        panic!("initial Resume did not return its target")
    };

    let mut changed_policy = serde_json::to_value(&request).unwrap();
    changed_policy["permissionMode"] = serde_json::json!("bypass_approvals");
    changed_policy["providerStateEnvironment"][FIXTURE_STATE_DIR_ENV] =
        serde_json::json!(state.path().join("new-version-policy").to_string_lossy());
    let changed_policy: ManagedCreateRequest = serde_json::from_value(changed_policy).unwrap();
    let replayed = creator
        .replace_current_and_advance(changed_policy)
        .expect("launch-policy drift must recover the already-ready target");
    let ManagedCreateAdvanceResolution::Advanced(replayed) = replayed else {
        panic!("launch-policy drift did not recover the target")
    };
    assert_eq!(
        replayed.receipt().session_id(),
        first.receipt().session_id()
    );
    assert_eq!(
        replayed.receipt().idempotency_key(),
        first.receipt().idempotency_key()
    );
    assert_eq!(
        replayed.receipt().generation_fence(),
        first.receipt().generation_fence()
    );
    assert_eq!(
        replayed.receipt().permission_mode(),
        PermissionMode::Default
    );
    drop(replayed);
    drop(first);
    fs::remove_file(state.path().join("hold-open")).unwrap();
}

#[test]
fn writer_claim_after_successor_persist_is_nonterminal_and_replays_same_edge() {
    assert_writer_claim_after_successor_persist_is_nonterminal(
        "after_successor_persist_before_target_create",
        true,
    );
}

#[test]
fn writer_claim_after_successor_intent_crash_before_source_retirement_is_nonterminal() {
    assert_writer_claim_after_successor_persist_is_nonterminal(
        "after_successor_intent_before_source_retirement",
        false,
    );
}

fn assert_writer_claim_after_successor_persist_is_nonterminal(
    fault: &str,
    source_retired_at_cut: bool,
) {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let source_state = state.path().join("toctou-source");
    let target_state = state.path().join("toctou-target");
    for directory in [&source_state, &target_state] {
        fs::create_dir(directory).unwrap();
        fs::write(directory.join("hold-open"), b"1").unwrap();
    }
    let source = ManagedCreateRequest::new(
        "toctou-source-create",
        "toctou-source-session",
        "toctou-workspace",
        "fixture",
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
            source_state.to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("fixture", "toctou-source-conversation").unwrap(),
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
    )
    .unwrap();
    let target = source
        .clone()
        .with_provider_state_environment(
            ProviderStateEnvironment::new(BTreeMap::from([(
                FIXTURE_STATE_DIR_ENV.into(),
                target_state.to_string_lossy().into_owned(),
            )]))
            .unwrap(),
        )
        .unwrap()
        .with_conversation_identity(
            ProviderConversationIdentitySeed::new("fixture", "toctou-target-conversation").unwrap(),
        )
        .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    creator.create(source.clone()).unwrap();
    let (cut, response) = run_managed_create_advance(&discovery_root, &cwd, &target, Some(fault));
    assert_eq!(cut.code(), Some(86));
    assert!(response.is_none());
    let edges = successor_edges(&discovery_root);
    assert_eq!(edges.len(), 1);
    let successor = edges[0]["successor"].clone();
    let source_resolution = creator
        .reconcile_identity(
            ManagedCreateReconcileRequest::new(
                source.idempotency_key(),
                source.session_id(),
                source.workspace_id(),
            )
            .unwrap(),
        )
        .unwrap();
    if source_retired_at_cut {
        assert!(matches!(
            source_resolution,
            ManagedCreateIdentityResolution::Retired
        ));
    } else {
        assert!(matches!(
            source_resolution,
            ManagedCreateIdentityResolution::Existing(_)
        ));
    }

    let competitor_exit = state.path().join("toctou-competitor-exit");
    let competitor = ManagedCreateRequest::new(
        "toctou-competitor-create",
        "toctou-competitor-session",
        "toctou-competitor-workspace",
        "fixture",
        PermissionMode::Default,
        &cwd,
        vec![
            "/bin/sh".into(),
            "-c".into(),
            "while [ ! -f \"$1\" ]; do sleep 0.02; done".into(),
            "--".into(),
            competitor_exit.to_string_lossy().into_owned(),
        ],
        24,
        80,
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("fixture", "toctou-target-conversation").unwrap(),
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
    )
    .unwrap();
    creator.create(competitor.clone()).unwrap();

    let (status, response) = run_managed_create_advance(&discovery_root, &cwd, &target, None);
    assert!(status.success());
    assert!(
        matches!(
            &response,
            Some(ManagedCreateAdvanceBrokerResponse::AuthorityUnavailable(_))
        ),
        "a durable successor conflict must be nonterminal, got {response:?}"
    );
    assert_eq!(successor_edges(&discovery_root).len(), 1);
    assert_eq!(successor_edges(&discovery_root)[0]["successor"], successor);

    fs::write(&competitor_exit, b"exit").unwrap();
    wait_for_exited(
        &discovery_root,
        competitor.workspace_id(),
        competitor.session_id(),
    );
    wait_for_conversation_writer_release(
        &discovery_root,
        competitor.workspace_id(),
        competitor.session_id(),
    );

    let resolution = creator
        .create_or_reconcile_and_advance(target)
        .expect("release must let the exact durable successor converge");
    let ManagedCreateAdvanceResolution::Advanced(advanced) = resolution else {
        panic!("release must reach the persisted successor, got {resolution:?}")
    };
    assert_eq!(
        advanced.receipt().session_id(),
        successor["sessionId"].as_str().unwrap()
    );
    assert_eq!(
        advanced.receipt().idempotency_key(),
        successor["idempotencyKey"].as_str().unwrap()
    );
    assert_eq!(successor_edges(&discovery_root).len(), 1);
}

#[test]
fn active_different_digest_missing_discovery_preserves_source_without_successor() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    fs::write(state.path().join("hold-open"), b"1").unwrap();
    let source = ManagedCreateRequest::new(
        "missing-discovery-create",
        "missing-discovery-session",
        "missing-discovery-workspace",
        "fixture",
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
            state.path().to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap();
    let changed_state = state.path().join("missing-discovery-target");
    fs::create_dir(&changed_state).unwrap();
    fs::write(changed_state.join("hold-open"), b"1").unwrap();
    let changed = source
        .clone()
        .with_provider_state_environment(
            ProviderStateEnvironment::new(BTreeMap::from([(
                FIXTURE_STATE_DIR_ENV.into(),
                changed_state.to_string_lossy().into_owned(),
            )]))
            .unwrap(),
        )
        .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root);
    let created = creator.create(source.clone()).unwrap();
    let provider_process = created.session().descriptor().provider_process.clone();
    let session_path = discovery_root.join(
        SessionLookupKey::new(source.workspace_id(), source.session_id())
            .unwrap()
            .relative_path(),
    );
    fs::remove_file(session_path.join("manifest.json")).unwrap();

    let (status, response) = run_managed_create_advance(&discovery_root, &cwd, &source, None);
    assert!(status.success());
    let Some(ManagedCreateAdvanceBrokerResponse::Refused(failure)) = response else {
        panic!("an exact pre-effect discovery failure must remain retryable")
    };
    assert_eq!(
        failure.effective_disposition(),
        ManagedCreateFailureDisposition::Retryable
    );
    assert_eq!(failure.code, "hmux_managed_launch_failed");
    assert_eq!(
        probe_local_process_generation(&provider_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    assert!(successor_edges(&discovery_root).is_empty());

    let (status, response) = run_managed_create_advance(&discovery_root, &cwd, &changed, None);
    assert!(status.success());
    assert!(matches!(
        response,
        Some(ManagedCreateAdvanceBrokerResponse::AuthorityUnavailable(_))
    ));
    assert_eq!(
        probe_local_process_generation(&provider_process).unwrap(),
        LocalProcessGenerationStatus::Live
    );
    assert_eq!(
        reconcile_raw(
            &discovery_root,
            &cwd,
            source.idempotency_key(),
            source.session_id(),
            source.workspace_id(),
        )["state"],
        "completed"
    );
    assert!(
        fs::read_dir(discovery_root.join(".managed-create-v2"))
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !is_successor_edge_shard_name(&entry.file_name().to_string_lossy())),
        "missing source discovery must not reserve a successor"
    );
}
