pub(crate) use hmux_client::recovery_journal::managed_create_ledger::ManagedCreateLineageAdmission as ManagedCreateIntentLineage;
use hmux_client::recovery_journal::managed_create_ledger::{
    self, ManagedCreateAdmissionError, ManagedCreateCompletedGenerationEvidence,
    ManagedCreateLedgerReservation, ManagedCreateLedgerState,
};
use hmux_client::{ConnectionOptions, LocalAttachRole, LocalSession, ProcessDescriptor};
use hmux_host::local_discovery::{
    DiscoveryManifest, DiscoveryRoot, LocalEndpointKind, ManifestCommon, SessionClass,
};
use hmux_host::provider_epoch::process_session_cleanup_is_incomplete;
use hmux_runtime_contract::{
    ManagedCreateOutcome, ManagedCreateReceipt, ManagedCreateReconcileRequest,
    ManagedCreateRequest, TerminalDefaultColors,
};
use std::path::Path;
use std::time::Duration;

type DynError = Box<dyn std::error::Error + Send + Sync>;
type ReplayResult<T> = std::result::Result<T, DynError>;

pub(crate) enum ManagedCreateIntent {
    Prepared(ManagedCreateIntentGuard),
    SpawnReserved {
        intent: ManagedCreateIntentGuard,
        host_process: ProcessDescriptor,
    },
    LaunchReleased {
        intent: ManagedCreateIntentGuard,
        host_process: ProcessDescriptor,
    },
    Completed(ManagedCreateReceipt),
    Retired,
}

pub(crate) struct ManagedCreateIntentGuard {
    reservation: ManagedCreateLedgerReservation,
}

pub(crate) fn acquire_with_lineage(
    discovery_root: &Path,
    request: &ManagedCreateRequest,
    lineage: ManagedCreateIntentLineage,
) -> Result<ManagedCreateIntent, ManagedCreateAdmissionError> {
    let admission = managed_create_ledger::reserve_request(discovery_root, request, lineage)?;
    match admission {
        ManagedCreateLedgerState::Completed(serialized) => {
            Ok(ManagedCreateIntent::Completed(decode_receipt(&serialized)?))
        }
        ManagedCreateLedgerState::Prepared(reservation) => {
            Ok(ManagedCreateIntent::Prepared(ManagedCreateIntentGuard {
                reservation,
            }))
        }
        ManagedCreateLedgerState::SpawnReserved {
            reservation,
            host_process,
        } => Ok(ManagedCreateIntent::SpawnReserved {
            intent: ManagedCreateIntentGuard { reservation },
            host_process,
        }),
        ManagedCreateLedgerState::LaunchReleased {
            reservation,
            host_process,
            ..
        } => Ok(ManagedCreateIntent::LaunchReleased {
            intent: ManagedCreateIntentGuard { reservation },
            host_process,
        }),
        ManagedCreateLedgerState::Retired => Ok(ManagedCreateIntent::Retired),
    }
}

pub(crate) fn replay_receipt(
    request: &ManagedCreateRequest,
    discovery_root: &Path,
    receipt: ManagedCreateReceipt,
) -> ReplayResult<ManagedCreateReceipt> {
    receipt.validate()?;
    if receipt.idempotency_key() != request.idempotency_key()
        || receipt.session_id() != request.session_id()
        || receipt.workspace_id() != request.workspace_id()
        || receipt.provider_id() != request.provider_id()
        || receipt.permission_mode() != request.permission_mode()
        || receipt.discovery_root() != discovery_root
    {
        return Err("managed create journal receipt does not match the exact request".into());
    }
    replay_completed_receipt(discovery_root, receipt)
}

/// Replays immutable ledger evidence against the exact current Host generation.
/// Replacement retries may have a different launch policy, but cannot reuse a
/// receipt without the same liveness and generation proof as ordinary replay.
pub(crate) fn replay_completed_receipt(
    discovery_root: &Path,
    receipt: ManagedCreateReceipt,
) -> ReplayResult<ManagedCreateReceipt> {
    receipt.validate()?;
    if receipt.discovery_root() != discovery_root {
        return Err("managed create journal receipt has a different discovery root".into());
    }
    let fence = receipt
        .generation_fence()
        .ok_or("managed create journal receipt has no generation fence")?;
    let root = DiscoveryRoot::open(discovery_root)?;
    let found = root.find_manifest_by_session(receipt.workspace_id(), receipt.session_id())?;
    let ready = match found.manifest {
        DiscoveryManifest::Ready(ready)
            if matches_completed_generation(
                &ready.common,
                &ready.terminal_epoch,
                &receipt,
                fence,
            ) && ready.endpoint.kind == local_endpoint_kind() =>
        {
            ready
        }
        DiscoveryManifest::Exited(exited)
            if matches_completed_generation(
                &exited.common,
                &exited.tombstone.fence.terminal_epoch,
                &receipt,
                fence,
            ) && exited.endpoint.kind == local_endpoint_kind()
                && !process_session_cleanup_is_incomplete(&exited.tombstone.exit.reason) =>
        {
            let identity = ManagedCreateReconcileRequest::new(
                receipt.idempotency_key(),
                receipt.session_id(),
                receipt.workspace_id(),
            )?;
            let source =
                managed_create_ledger::completed_generation_evidence(discovery_root, &identity)?
                    .ok_or("completed managed-create evidence disappeared")?;
            if source.receipt() != &receipt {
                return Err("completed managed-create evidence changed".into());
            }
            return Err(exact_exited_generation(source)?);
        }
        DiscoveryManifest::Ready(_)
        | DiscoveryManifest::Starting(_)
        | DiscoveryManifest::Exited(_) => {
            return Err(
                "managed create journal target generation changed; explicit recovery is required"
                    .into(),
            );
        }
    };
    let session = LocalSession::from_manifest(DiscoveryManifest::Ready(ready))?;
    let options = ConnectionOptions::new(LocalAttachRole::Observer, None)
        .with_handshake_timeout(Duration::from_secs(3))
        .with_handshake_completion_timeout(Duration::from_secs(3));
    session
        .connect_with_options(options)
        .map_err(|error| format!("managed create journal target Host handshake failed: {error}"))?;
    Ok(ManagedCreateReceipt::new(
        receipt.idempotency_key(),
        receipt.session_id(),
        receipt.workspace_id(),
        receipt.provider_id(),
        receipt.permission_mode(),
        receipt.discovery_root(),
        ManagedCreateOutcome::Reused,
    )?
    .with_generation_fence(fence.clone())?)
}

fn matches_completed_generation(
    common: &ManifestCommon,
    terminal_epoch: &str,
    receipt: &ManagedCreateReceipt,
    fence: &hmux_runtime_contract::ManagedCreateGenerationFence,
) -> bool {
    common.session_class == SessionClass::Managed
        && common.provider_id == receipt.provider_id()
        && common.claim_linkage.kickoff_action_id.as_deref() == Some(receipt.idempotency_key())
        && fence.matches_generation(
            &common.lifetime.runner_principal,
            &common.lifetime.runner_instance,
            &common.lifetime.channel_epoch.to_string(),
            &common.host_instance_id,
            terminal_epoch,
        )
}

fn exact_exited_generation(
    source: ManagedCreateCompletedGenerationEvidence,
) -> ReplayResult<DynError> {
    Ok(Box::new(
        super::managed_create_failure::ManagedCreateExactExited::from_source(source)?,
    ))
}

fn local_endpoint_kind() -> LocalEndpointKind {
    #[cfg(unix)]
    {
        LocalEndpointKind::UnixSocket
    }
    #[cfg(windows)]
    {
        LocalEndpointKind::WindowsNamedPipe
    }
}

impl ManagedCreateIntentGuard {
    pub(crate) fn resolve_terminal_default_colors(
        &self,
        request_colors: Option<TerminalDefaultColors>,
    ) -> Result<Option<TerminalDefaultColors>, String> {
        self.reservation
            .resolve_terminal_default_colors(request_colors)
    }

    pub(crate) fn checkpoint_pre_spawn_absence(&mut self) -> Result<(), String> {
        self.reservation.checkpoint_pre_spawn_absence()
    }

    pub(crate) fn mark_spawn_reserved(
        &mut self,
        host_process: ProcessDescriptor,
    ) -> Result<(), String> {
        self.reservation.mark_spawn_reserved(host_process)
    }

    pub(crate) fn release_with_barrier_proof(&mut self) -> Result<(), String> {
        self.reservation.release_with_barrier_proof()
    }

    #[cfg(unix)]
    pub(crate) fn reset_after_definite_pre_ready_failure(&mut self) -> Result<(), String> {
        self.reservation.reset_after_definite_pre_ready_failure()
    }

    pub(crate) fn complete(
        &mut self,
        receipt: &ManagedCreateReceipt,
    ) -> Result<ManagedCreateReceipt, String> {
        complete_reserved_receipt(&mut self.reservation, receipt)
    }
}

pub(crate) fn complete_reserved_receipt(
    reservation: &mut ManagedCreateLedgerReservation,
    receipt: &ManagedCreateReceipt,
) -> Result<ManagedCreateReceipt, String> {
    receipt.validate().map_err(|error| error.to_string())?;
    if receipt.generation_fence().is_none() {
        return Err(
            "managed create receipt cannot be completed without its generation fence".to_string(),
        );
    }
    let serialized = serde_json::to_string(receipt)
        .map_err(|error| format!("managed create receipt serialization failed: {error}"))?;
    reservation
        .complete(serialized)
        .and_then(|canonical| decode_receipt(&canonical))
}

fn decode_receipt(serialized: &str) -> Result<ManagedCreateReceipt, String> {
    let receipt: ManagedCreateReceipt = serde_json::from_str(serialized)
        .map_err(|error| format!("managed create intent receipt is malformed: {error}"))?;
    receipt.validate().map_err(|error| error.to_string())?;
    if receipt.generation_fence().is_none() {
        return Err("managed create intent receipt lost its generation fence".to_string());
    }
    Ok(receipt)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use hmux_client::recovery_journal::{RecoveryJournalGcPolicy, garbage_collect_completed};
    use hmux_runtime_contract::{
        MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER, ManagedCreateGenerationFence,
        ManagedCreateOutcome, ManagedRehostRecipe, PermissionMode,
        ProviderConversationIdentitySeed, TerminalDefaultColors,
    };
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Barrier, mpsc};
    use std::thread;
    use std::time::Duration;

    fn secure_root() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        root
    }

    fn acquire_root(
        discovery_root: &Path,
        request: &ManagedCreateRequest,
    ) -> Result<ManagedCreateIntent, ManagedCreateAdmissionError> {
        acquire_with_lineage(discovery_root, request, ManagedCreateIntentLineage::Root)
    }

    fn request(command: &str) -> ManagedCreateRequest {
        ManagedCreateRequest::new(
            "create-1",
            "session-1",
            "workspace-1",
            "codex",
            PermissionMode::Default,
            "/tmp",
            vec![command.to_string()],
            24,
            80,
        )
        .unwrap()
    }

    fn conversation_request(idempotency_key: &str, session_id: &str) -> ManagedCreateRequest {
        ManagedCreateRequest::new(
            idempotency_key,
            session_id,
            "workspace-1",
            "codex",
            PermissionMode::Default,
            "/tmp",
            vec!["codex".to_string(), "resume".to_string()],
            24,
            80,
        )
        .unwrap()
        .with_conversation_identity(
            ProviderConversationIdentitySeed::new("codex", "conversation-1").unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn additive_rehost_recipe_does_not_break_a_legacy_create_retry() {
        let root = secure_root();
        let legacy = request("provider")
            .with_required_managed_stop_request_version(
                hmux_runtime_contract::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap();
        assert!(matches!(
            acquire_root(root.path(), &legacy).unwrap(),
            ManagedCreateIntent::Prepared(_)
        ));

        let current = legacy
            .with_managed_rehost_recipe(
                ManagedRehostRecipe::new(
                    vec![
                        "codex".into(),
                        "resume".into(),
                        MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                    ],
                    None,
                )
                .unwrap(),
            )
            .unwrap();
        assert!(matches!(
            acquire_root(root.path(), &current).unwrap(),
            ManagedCreateIntent::Prepared(_)
        ));
        assert!(
            managed_create_ledger::managed_rehost_recipe(
                root.path(),
                current.workspace_id(),
                current.session_id(),
            )
            .unwrap()
            .is_none(),
            "a legacy create retry must remain valid without backfilling rehost authority"
        );
    }

    #[test]
    fn admitted_rehost_recipe_owns_launch_color_seed_across_retry() {
        let first_colors = TerminalDefaultColors::new(0x12_34_56, 0x65_43_21).unwrap();
        let retry_colors = TerminalDefaultColors::new(0xAB_CD_EF, 0x10_32_54).unwrap();
        let rehost = ManagedRehostRecipe::new(
            vec![
                "codex".into(),
                "resume".into(),
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
            ],
            None,
        )
        .unwrap();

        let colored_root = secure_root();
        let colored = request("provider")
            .with_required_managed_stop_request_version(
                hmux_runtime_contract::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap()
            .with_managed_rehost_recipe(rehost.clone())
            .unwrap()
            .with_terminal_default_colors(first_colors)
            .unwrap();
        assert!(matches!(
            acquire_root(colored_root.path(), &colored).unwrap(),
            ManagedCreateIntent::Prepared(_)
        ));
        let colored_retry = colored
            .clone()
            .with_terminal_default_colors(retry_colors)
            .unwrap();
        let ManagedCreateIntent::Prepared(colored_guard) =
            acquire_root(colored_root.path(), &colored_retry).unwrap()
        else {
            panic!("presentation-only retry must retain the prepared reservation")
        };
        assert_eq!(
            colored_guard
                .resolve_terminal_default_colors(Some(retry_colors))
                .unwrap(),
            Some(first_colors)
        );

        let colorless_root = secure_root();
        let colorless = request("provider")
            .with_required_managed_stop_request_version(
                hmux_runtime_contract::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap()
            .with_managed_rehost_recipe(rehost)
            .unwrap();
        assert!(matches!(
            acquire_root(colorless_root.path(), &colorless).unwrap(),
            ManagedCreateIntent::Prepared(_)
        ));
        let colorless_retry = colorless
            .clone()
            .with_terminal_default_colors(retry_colors)
            .unwrap();
        let ManagedCreateIntent::Prepared(colorless_guard) =
            acquire_root(colorless_root.path(), &colorless_retry).unwrap()
        else {
            panic!("presentation-only retry must retain the prepared reservation")
        };
        assert_eq!(
            colorless_guard
                .resolve_terminal_default_colors(Some(retry_colors))
                .unwrap(),
            Some(retry_colors),
            "a persisted recipe without a color seed must retain the request colors"
        );

        let ordinary_root = secure_root();
        let ordinary = request("provider")
            .with_terminal_default_colors(retry_colors)
            .unwrap();
        let ManagedCreateIntent::Prepared(ordinary_guard) =
            acquire_root(ordinary_root.path(), &ordinary).unwrap()
        else {
            panic!("ordinary create must be prepared")
        };
        assert_eq!(
            ordinary_guard
                .resolve_terminal_default_colors(Some(retry_colors))
                .unwrap(),
            Some(retry_colors)
        );
    }

    fn receipt(root: &Path) -> ManagedCreateReceipt {
        ManagedCreateReceipt::new(
            "create-1",
            "session-1",
            "workspace-1",
            "codex",
            PermissionMode::Default,
            root,
            ManagedCreateOutcome::Created,
        )
        .unwrap()
        .with_generation_fence(
            ManagedCreateGenerationFence::new("principal-1", "runner-1", 7, "host-1", "terminal-1")
                .unwrap(),
        )
        .unwrap()
    }

    fn process() -> ProcessDescriptor {
        ProcessDescriptor {
            process_id: 101,
            start_marker: "exact-101".to_string(),
        }
    }

    #[test]
    fn exact_retry_replays_one_durable_generation_receipt() {
        let root = secure_root();
        let ManagedCreateIntent::Prepared(mut guard) =
            acquire_root(root.path(), &conversation_request("create-1", "session-1")).unwrap()
        else {
            panic!("first reservation must be prepared")
        };
        guard.checkpoint_pre_spawn_absence().unwrap();
        guard.mark_spawn_reserved(process()).unwrap();
        guard.release_with_barrier_proof().unwrap();
        let expected = receipt(root.path());
        guard.complete(&expected).unwrap();
        drop(guard);

        let ManagedCreateIntent::Completed(replayed) =
            acquire_root(root.path(), &conversation_request("create-1", "session-1")).unwrap()
        else {
            panic!("exact retry must replay the completed receipt")
        };
        assert_eq!(replayed, expected);
    }

    #[test]
    fn same_logical_session_with_changed_canonical_request_is_refused() {
        let root = secure_root();
        let ManagedCreateIntent::Prepared(guard) =
            acquire_root(root.path(), &request("codex")).unwrap()
        else {
            panic!("first reservation must be prepared")
        };
        drop(guard);

        let error = match acquire_root(root.path(), &request("claude")) {
            Err(error) => error,
            Ok(_) => panic!("changed canonical request must be refused"),
        };
        assert!(matches!(
            error,
            ManagedCreateAdmissionError::CanonicalRequestDigestConflict
        ));
    }

    #[test]
    fn concurrent_clients_admit_only_one_writer_for_an_exact_conversation() {
        let root = secure_root();
        let start = Arc::new(Barrier::new(3));
        let release = Arc::new(Barrier::new(3));
        let (send, receive) = mpsc::channel();
        let mut workers = Vec::new();

        for (idempotency_key, session_id) in [("create-1", "session-1"), ("create-2", "session-2")]
        {
            let root = root.path().to_path_buf();
            let start = Arc::clone(&start);
            let release = Arc::clone(&release);
            let send = send.clone();
            workers.push(thread::spawn(move || {
                let request = conversation_request(idempotency_key, session_id);
                start.wait();
                let intent = acquire_root(&root, &request);
                let result = match &intent {
                    Ok(ManagedCreateIntent::Prepared(_)) => Ok(()),
                    Err(error) => Err(error.to_string()),
                    Ok(_) => Err("unexpected managed create state".to_string()),
                };
                send.send(result).unwrap();
                release.wait();
                drop(intent);
            }));
        }
        drop(send);

        start.wait();
        let results = [receive.recv().unwrap(), receive.recv().unwrap()];
        release.wait();
        for worker in workers {
            worker.join().unwrap();
        }

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let refusal = results
            .iter()
            .find_map(|result| result.as_ref().err())
            .expect("the competing writer must be refused");
        assert!(
            refusal.starts_with("hmux_managed_conversation_writer_conflict:"),
            "{refusal}"
        );
    }

    #[test]
    fn crash_after_spawn_boundary_never_grants_a_second_spawn() {
        let root = secure_root();
        let ManagedCreateIntent::Prepared(mut first) =
            acquire_root(root.path(), &request("codex")).unwrap()
        else {
            panic!("first reservation must be prepared")
        };
        first.checkpoint_pre_spawn_absence().unwrap();
        first.mark_spawn_reserved(process()).unwrap();
        drop(first);

        assert!(matches!(
            acquire_root(root.path(), &request("codex")).unwrap(),
            ManagedCreateIntent::SpawnReserved { .. }
        ));
    }

    #[test]
    fn ordinary_recovery_gc_cannot_reopen_a_completed_create() {
        let root = secure_root();
        let ManagedCreateIntent::Prepared(mut guard) =
            acquire_root(root.path(), &request("codex")).unwrap()
        else {
            panic!("first reservation must be prepared")
        };
        guard.checkpoint_pre_spawn_absence().unwrap();
        guard.mark_spawn_reserved(process()).unwrap();
        guard.release_with_barrier_proof().unwrap();
        let expected = receipt(root.path());
        guard.complete(&expected).unwrap();
        drop(guard);

        garbage_collect_completed(
            root.path(),
            RecoveryJournalGcPolicy {
                minimum_completed_age: Duration::ZERO,
                maximum_completed_records: 0,
                maximum_completed_bytes: 0,
                minimum_orphan_age: Duration::ZERO,
                maximum_source_lock_files: 0,
                maximum_orphan_operation_locks: 0,
                maximum_temporary_files: 0,
            },
        )
        .unwrap();

        assert!(matches!(
            acquire_root(root.path(), &request("codex")).unwrap(),
            ManagedCreateIntent::Completed(receipt) if receipt == expected
        ));
    }

    #[test]
    fn definite_pre_ready_failure_reopens_the_same_request() {
        let root = secure_root();
        let ManagedCreateIntent::Prepared(mut guard) =
            acquire_root(root.path(), &request("codex")).unwrap()
        else {
            panic!("first reservation must be prepared")
        };
        guard.checkpoint_pre_spawn_absence().unwrap();
        guard.mark_spawn_reserved(process()).unwrap();
        guard.reset_after_definite_pre_ready_failure().unwrap();
        drop(guard);

        assert!(matches!(
            acquire_root(root.path(), &request("codex")).unwrap(),
            ManagedCreateIntent::Prepared(_)
        ));
    }
}
