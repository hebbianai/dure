use super::*;
use crate::local_discovery::{
    ClaimLinkage, ExitedManifest, HostLifetimeIdentity, LocalEndpoint, LocalEndpointKind,
    ManifestCommon, ManifestValidationError, SecurityViolation, SessionClass, SessionLookupKey,
    SessionRetirementPolicy, StaleDiscoveryReason,
};
use crate::local_protocol::{
    Exit, ProcessProof, ProtocolVersion, RuntimeContext, SessionFence, VersionRange,
};
#[cfg(feature = "local-runtime")]
use crate::local_protocol::{ScreenSnapshot, ScreenSnapshotEncoding};
use crate::provider_epoch::{
    ExitTombstone, ProviderExitKind, SessionFailureCapsule, SessionFailurePhase,
    SessionFailureRetryPosture,
};
#[cfg(feature = "local-runtime")]
use crate::terminal_replay::{
    TERMINAL_COLD_HISTORY_CHECKPOINT_SCHEMA_VERSION, TerminalCheckpoint,
    TerminalCheckpointEncoding, TerminalColdHistoryCheckpoint,
};
use tempfile::TempDir;

fn session(temp: &TempDir) -> SessionDiscovery {
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    root.session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap()
}

fn publish_ready_session(
    root: &DiscoveryRoot,
    runner_instance: &str,
    channel_epoch: u64,
    host_instance_id: &str,
) -> SessionDiscovery {
    let session = root
        .session(DiscoveryKey::new("workspace", "session", runner_instance, channel_epoch).unwrap())
        .unwrap();
    let mut starting = starting(host_instance_id);
    starting.common.lifetime.runner_instance = runner_instance.into();
    starting.common.lifetime.channel_epoch = channel_epoch;
    let mut ready = ready(host_instance_id);
    ready.common = starting.common.clone();
    let lock = session.acquire_lifetime_lock().unwrap();
    session.publish_starting(&lock, starting).unwrap();
    session.publish_ready(&lock, ready).unwrap();
    drop(lock);
    session
}

fn common(host_instance_id: &str) -> ManifestCommon {
    ManifestCommon {
        launch_program: None,
        schema_version: 1,
        host_build_version: "build-v1".into(),
        supported_protocol: VersionRange {
            minimum: ProtocolVersion { major: 1, minor: 0 },
            maximum: ProtocolVersion { major: 1, minor: 1 },
        },
        capabilities: vec!["screen_snapshot".into()],
        lifetime: HostLifetimeIdentity {
            workspace_id: "workspace".into(),
            session_id: "session".into(),
            runner_principal: "runner".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: 4,
        },
        host_instance_id: host_instance_id.into(),
        provider_id: "fixture".into(),
        runtime_context: RuntimeContext::default(),
        claim_linkage: ClaimLinkage {
            claim_id: Some("claim-1".into()),
            kickoff_action_id: Some("action-1".into()),
        },
        host_process: ProcessProof {
            process_id: 100,
            start_marker: "host-start-1".into(),
        },
        created_unix_ms: 1,
        session_class: SessionClass::Managed,
        session_name: None,
        retirement_policy: None,
    }
}

fn starting(host_instance_id: &str) -> StartingManifest {
    StartingManifest {
        common: common(host_instance_id),
        starting_unix_ms: 2,
    }
}

fn ready(host_instance_id: &str) -> ReadyManifest {
    ReadyManifest {
        common: common(host_instance_id),
        provider_process: ProcessProof {
            process_id: 101,
            start_marker: "provider-start-1".into(),
        },
        terminal_epoch: "terminal-1".into(),
        ready_output_seq: 1,
        endpoint: LocalEndpoint {
            kind: LocalEndpointKind::UnixSocket,
            address: "host.sock".into(),
        },
        capability_token: "secret-token".into(),
        ready_unix_ms: 3,
    }
}

fn standalone_starting(host_instance_id: &str) -> StartingManifest {
    let mut manifest = starting(host_instance_id);
    manifest.common.session_class = SessionClass::Standalone;
    manifest.common.session_name = Some("dev".into());
    manifest
}

fn standalone_ready(host_instance_id: &str) -> ReadyManifest {
    let mut manifest = ready(host_instance_id);
    manifest.common = standalone_starting(host_instance_id).common;
    manifest
}

fn exited(host_instance_id: &str) -> ExitedManifest {
    let ready = ready(host_instance_id);
    ExitedManifest {
        common: ready.common,
        tombstone: Box::new(ExitTombstone {
            fence: SessionFence {
                workspace_id: "workspace".into(),
                session_id: "session".into(),
                runner_principal: "runner".into(),
                runner_instance: "runner-1".into(),
                channel_epoch: 4,
                host_instance_id: host_instance_id.into(),
                terminal_epoch: ready.terminal_epoch,
            },
            provider_process: ready.provider_process,
            exit: Exit {
                final_output_seq: 8,
                exit_code: Some(1),
                platform_status: None,
                reason: "provider_usage_limit".into(),
            },
            exit_kind: ProviderExitKind::UsageLimit,
            created_unix_ms: 4,
            failure: None,
        }),
        endpoint: ready.endpoint,
        capability_token: ready.capability_token,
        exited_unix_ms: 4,
    }
}

#[test]
fn exited_failure_capsule_is_bounded_and_matches_its_tombstone() {
    let mut exited = exited("host-1");
    exited.tombstone.failure = Some(SessionFailureCapsule {
        correlation_id: "failure_0123456789abcdef".into(),
        session_id: "session".into(),
        workspace_id: "workspace".into(),
        terminal_epoch: "terminal-1".into(),
        code: "provider_exited_before_conversation_identity".into(),
        phase: SessionFailurePhase::ConversationIdentity,
        summary: "Managed provider exited before conversation identity was established.".into(),
        exit_kind: ProviderExitKind::UsageLimit,
        exit_code: Some(1),
        occurred_unix_ms: 4,
        retry_posture: SessionFailureRetryPosture::Never,
    });
    DiscoveryManifest::Exited(exited.clone())
        .validate(&ManifestLimits::default())
        .unwrap();

    let mut inconsistent = exited.clone();
    inconsistent.tombstone.failure.as_mut().unwrap().session_id = "another-session".into();
    assert_eq!(
        DiscoveryManifest::Exited(inconsistent)
            .validate(&ManifestLimits::default())
            .unwrap_err(),
        ManifestValidationError::Inconsistent {
            field: "session_failure_capsule",
        }
    );

    exited.tombstone.failure.as_mut().unwrap().summary = "x".repeat(513);
    assert_eq!(
        DiscoveryManifest::Exited(exited)
            .validate(&ManifestLimits::default())
            .unwrap_err(),
        ManifestValidationError::TooLong {
            field: "failure.summary",
            actual: 513,
            maximum: 512,
        }
    );
}

fn replacement_generation(index: u64) -> (StartingManifest, ExitedManifest) {
    let host_instance_id = format!("host-{index}");
    let runner_instance = format!("runner-{index}");
    let terminal_epoch = format!("terminal-{index}");
    let mut starting = starting(&host_instance_id);
    starting.common.lifetime.runner_instance = runner_instance.clone();
    starting.common.lifetime.channel_epoch = index;
    starting.common.host_process.process_id = 77;
    starting.common.host_process.start_marker = format!("host-process-generation-{index}");
    starting.common.created_unix_ms = index;
    starting.starting_unix_ms = index;

    let mut exited = exited(&host_instance_id);
    exited.common = starting.common.clone();
    exited.tombstone.fence = SessionFence {
        workspace_id: "workspace".into(),
        session_id: "session".into(),
        runner_principal: "runner".into(),
        runner_instance,
        channel_epoch: index,
        host_instance_id,
        terminal_epoch,
    };
    exited.tombstone.provider_process.process_id = 88;
    exited.tombstone.provider_process.start_marker = format!("provider-process-generation-{index}");
    exited.tombstone.created_unix_ms = index;
    exited.exited_unix_ms = index;
    (starting, exited)
}

fn session_for_generation(root: &DiscoveryRoot, index: u64) -> SessionDiscovery {
    root.session(
        DiscoveryKey::new("workspace", "session", format!("runner-{index}"), index).unwrap(),
    )
    .unwrap()
}

fn publish_and_retire_generation(
    root: &DiscoveryRoot,
    index: u64,
) -> (SessionDiscovery, ManifestGeneration) {
    let session = session_for_generation(root, index);
    let lock = session.acquire_lifetime_lock().unwrap();
    let (starting, exited) = replacement_generation(index);
    let generation = DiscoveryManifest::Exited(exited.clone()).generation();
    session.publish_starting(&lock, starting).unwrap();
    session.publish_exited(&lock, exited).unwrap();
    session.retire_exited_current(&lock, &generation).unwrap();
    drop(lock);
    (session, generation)
}

fn publish_named_session(
    root: &DiscoveryRoot,
    session_id: &str,
    host_instance_id: &str,
    lifecycle: NamedSessionLifecycle,
) {
    let session = root
        .session(DiscoveryKey::new("workspace", session_id, "runner-1", 4).unwrap())
        .unwrap();
    let mut starting = starting(host_instance_id);
    starting.common.lifetime.session_id = session_id.into();
    if let NamedSessionLifecycle::Ready {
        session_name,
        session_class,
    } = &lifecycle
    {
        starting.common.session_class = *session_class;
        starting.common.session_name = session_name.map(str::to_string);
    }
    let lock = session.acquire_lifetime_lock().unwrap();
    session.publish_starting(&lock, starting.clone()).unwrap();
    match lifecycle {
        NamedSessionLifecycle::StartingOnly => {}
        NamedSessionLifecycle::Ready { .. } => {
            let mut ready = ready(host_instance_id);
            ready.common = starting.common.clone();
            session.publish_ready(&lock, ready).unwrap();
        }
        NamedSessionLifecycle::Exited => {
            let mut exited = exited(host_instance_id);
            exited.common = starting.common.clone();
            exited.tombstone.fence.session_id = session_id.into();
            session.publish_exited(&lock, exited).unwrap();
        }
    }
    drop(lock);
}

fn create_retired_corruption(session: &SessionDiscovery, name: &str) {
    let retired_path = session.path().join(RETIRED_DIRECTORY_NAME);
    private_storage::create_directory(&retired_path).unwrap();
    let path = retired_path.join(name);
    let mut file = private_storage::open_new_file(&path).unwrap();
    file.write_all(b"{not-json").unwrap();
    file.sync_all().unwrap();
}

enum NamedSessionLifecycle {
    StartingOnly,
    Ready {
        session_name: Option<&'static str>,
        session_class: SessionClass,
    },
    Exited,
}

#[cfg(feature = "local-runtime")]
fn presentation_checkpoint(ready: &ReadyManifest) -> PresentationCheckpoint {
    presentation_checkpoint_at(ready, 7, 24, 80, b"\x1b[Hscreen-before-reboot")
}

#[cfg(feature = "local-runtime")]
fn presentation_checkpoint_at(
    ready: &ReadyManifest,
    sequence_through: u64,
    rows: u16,
    columns: u16,
    repaint_bytes: &[u8],
) -> PresentationCheckpoint {
    PresentationCheckpoint::capture(
        &ScreenSnapshot {
            fence: PresentationCheckpointSource::from_ready(ready).fence(),
            sequence_through,
            rows,
            columns,
            encoding: ScreenSnapshotEncoding::AnsiRedrawV1,
            controller_input_pending: None,
            semantic_idle_ms: None,
            repaint_bytes: repaint_bytes.to_vec(),
            alternate_screen: false,
            cursor_visible: true,
            truncated: false,
            working_directory: None,
            execution_location: None,
            agent_identity: None,
            agent_runtime_state: None,
            provider_conversation_identity: None,
            recovered_presentation: None,
            actual_profile: None,
            in_reply_to_request_id: None,
        },
        9,
    )
    .unwrap()
}

#[cfg(feature = "local-runtime")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CheckpointIoPhase {
    WriteAll,
    FileSync,
    AtomicReplace,
    AtomicReplaceAfterPublication,
    DirectorySync,
}

#[cfg(feature = "local-runtime")]
struct FailOnceCheckpointIo {
    phase: CheckpointIoPhase,
    failed: bool,
    system: SystemPresentationCheckpointIo,
}

#[cfg(feature = "local-runtime")]
impl FailOnceCheckpointIo {
    fn new(phase: CheckpointIoPhase) -> Self {
        Self {
            phase,
            failed: false,
            system: SystemPresentationCheckpointIo,
        }
    }

    fn should_fail(&mut self, phase: CheckpointIoPhase) -> bool {
        if !self.failed && self.phase == phase {
            self.failed = true;
            return true;
        }
        false
    }

    fn injected(path: &Path) -> DiscoveryError {
        DiscoveryError::io(
            "fault-injected presentation checkpoint phase",
            path,
            std::io::Error::from_raw_os_error(libc::EIO),
        )
    }
}

#[cfg(feature = "local-runtime")]
impl PresentationCheckpointIo for FailOnceCheckpointIo {
    fn write_all(
        &mut self,
        file: &mut File,
        bytes: &[u8],
        path: &Path,
    ) -> Result<(), DiscoveryError> {
        if self.should_fail(CheckpointIoPhase::WriteAll) {
            return Err(Self::injected(path));
        }
        self.system.write_all(file, bytes, path)
    }

    fn sync_file(&mut self, file: &File, path: &Path) -> Result<(), DiscoveryError> {
        if self.should_fail(CheckpointIoPhase::FileSync) {
            return Err(Self::injected(path));
        }
        self.system.sync_file(file, path)
    }

    fn atomic_replace(&mut self, source: &Path, target: &Path) -> Result<(), DiscoveryError> {
        if self.should_fail(CheckpointIoPhase::AtomicReplace) {
            return Err(Self::injected(target));
        }
        self.system.atomic_replace(source, target)?;
        if self.should_fail(CheckpointIoPhase::AtomicReplaceAfterPublication) {
            return Err(Self::injected(target));
        }
        Ok(())
    }

    fn sync_directory(&mut self, path: &Path) -> Result<(), DiscoveryError> {
        if self.should_fail(CheckpointIoPhase::DirectorySync) {
            return Err(Self::injected(path));
        }
        self.system.sync_directory(path)
    }
}

#[cfg(feature = "local-runtime")]
struct CrashAfterCheckpointIo {
    phase: CheckpointIoPhase,
    system: SystemPresentationCheckpointIo,
}

#[cfg(feature = "local-runtime")]
impl CrashAfterCheckpointIo {
    fn new(phase: CheckpointIoPhase) -> Self {
        Self {
            phase,
            system: SystemPresentationCheckpointIo,
        }
    }

    fn crash_after(&self, phase: CheckpointIoPhase, path: &Path) -> Result<(), DiscoveryError> {
        if self.phase == phase {
            return Err(FailOnceCheckpointIo::injected(path));
        }
        Ok(())
    }
}

#[cfg(feature = "local-runtime")]
impl PresentationCheckpointIo for CrashAfterCheckpointIo {
    fn write_all(
        &mut self,
        file: &mut File,
        bytes: &[u8],
        path: &Path,
    ) -> Result<(), DiscoveryError> {
        self.system.write_all(file, bytes, path)?;
        self.crash_after(CheckpointIoPhase::WriteAll, path)
    }

    fn sync_file(&mut self, file: &File, path: &Path) -> Result<(), DiscoveryError> {
        self.system.sync_file(file, path)?;
        self.crash_after(CheckpointIoPhase::FileSync, path)
    }

    fn atomic_replace(&mut self, source: &Path, target: &Path) -> Result<(), DiscoveryError> {
        self.system.atomic_replace(source, target)?;
        self.crash_after(CheckpointIoPhase::AtomicReplaceAfterPublication, target)
    }

    fn sync_directory(&mut self, path: &Path) -> Result<(), DiscoveryError> {
        self.system.sync_directory(path)?;
        self.crash_after(CheckpointIoPhase::DirectorySync, path)
    }

    fn cleanup_temporary_on_failure(&self) -> bool {
        false
    }
}

#[cfg(all(feature = "local-runtime", unix))]
#[test]
fn presentation_checkpoint_is_private_atomic_and_exactly_fenced() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let session = publish_ready_session(&root, "runner-1", 4, "host-1");
    let DiscoveryManifest::Ready(ready) = session.read_manifest().unwrap() else {
        panic!("expected ready manifest")
    };
    let checkpoint = presentation_checkpoint(&ready);
    let lock = session.acquire_lifetime_lock().unwrap();
    let debug = format!("{checkpoint:?}");
    assert!(!debug.contains("screen-before-reboot"));
    assert!(debug.contains("state_bytes_len"));

    session
        .write_presentation_checkpoint(&lock, &checkpoint)
        .unwrap();

    let checkpoint_path = session.path().join(PRESENTATION_CHECKPOINT_FILE_NAME);
    assert_eq!(
        fs::metadata(&checkpoint_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        session
            .read_presentation_checkpoint(checkpoint.source())
            .unwrap(),
        Some(checkpoint)
    );
    assert!(fs::read_dir(session.path()).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".presentation.tmp")
    }));
}

#[cfg(feature = "local-runtime")]
#[test]
fn engine_native_checkpoint_roundtrips_without_exposing_state_bytes() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let session = publish_ready_session(&root, "runner-1", 4, "host-1");
    let DiscoveryManifest::Ready(ready) = session.read_manifest().unwrap() else {
        panic!("expected ready manifest")
    };
    let terminal = TerminalCheckpoint {
        fence: PresentationCheckpointSource::from_ready(&ready).fence(),
        sequence_through: 17,
        state_revision: 29,
        rows: 31,
        columns: 97,
        encoding: TerminalCheckpointEncoding::EngineNativeV1 {
            engine_fingerprint: "engine:exact-pin".into(),
        },
        payload: b"opaque-native-state-secret".to_vec(),
        alternate_screen: true,
        cursor_visible: false,
        cold_history: Some(TerminalColdHistoryCheckpoint {
            schema_version: TERMINAL_COLD_HISTORY_CHECKPOINT_SCHEMA_VERSION,
            history_namespace: "history-namespace".into(),
            store_id: "history-store".into(),
            root_generation: 3,
            end_boundary_token: [7; 16],
            end_logical_line_id: 901,
            root_digest: [9; 32],
        }),
    };
    let checkpoint = PresentationCheckpoint::capture_terminal(&terminal, 101).unwrap();
    let lock = session.acquire_lifetime_lock().unwrap();
    session
        .write_presentation_checkpoint(&lock, &checkpoint)
        .unwrap();

    let restored = session
        .read_presentation_checkpoint(&PresentationCheckpointSource::from_ready(&ready))
        .unwrap()
        .unwrap();
    assert_eq!(restored.terminal_checkpoint(), terminal);
    let debug = format!("{restored:?}");
    assert!(debug.contains("state_bytes_len: 26"));
    assert!(!debug.contains("opaque-native-state-secret"));
}

#[cfg(feature = "local-runtime")]
#[test]
fn presentation_checkpoint_pre_replace_fault_preserves_last_valid_checkpoint() {
    for phase in [
        CheckpointIoPhase::WriteAll,
        CheckpointIoPhase::FileSync,
        CheckpointIoPhase::AtomicReplace,
    ] {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let session = publish_ready_session(&root, "runner-1", 4, "host-1");
        let DiscoveryManifest::Ready(ready) = session.read_manifest().unwrap() else {
            panic!("expected ready manifest")
        };
        let old = presentation_checkpoint_at(&ready, 7, 24, 80, b"\x1b[Hold");
        let next = presentation_checkpoint_at(&ready, 8, 24, 80, b"\x1b[Hnext");
        let lock = session.acquire_lifetime_lock().unwrap();
        session.write_presentation_checkpoint(&lock, &old).unwrap();
        let mut checkpoint_io = FailOnceCheckpointIo::new(phase);

        let error = session
            .write_presentation_checkpoint_with_io(&lock, &next, &mut checkpoint_io)
            .unwrap_err();
        let expected_phase = match phase {
            CheckpointIoPhase::WriteAll => PresentationCheckpointWritePhase::Write,
            CheckpointIoPhase::FileSync => PresentationCheckpointWritePhase::FileSync,
            CheckpointIoPhase::AtomicReplace => PresentationCheckpointWritePhase::AtomicReplace,
            CheckpointIoPhase::AtomicReplaceAfterPublication | CheckpointIoPhase::DirectorySync => {
                unreachable!()
            }
        };
        assert_eq!(
            error.phase(),
            expected_phase,
            "{phase:?} must retain a typed storage phase"
        );
        assert_eq!(
            session.read_presentation_checkpoint(old.source()).unwrap(),
            Some(old),
            "{phase:?} happens before the atomic publication boundary"
        );

        session
            .write_presentation_checkpoint_with_io(&lock, &next, &mut checkpoint_io)
            .unwrap();
        assert_eq!(
            session.read_presentation_checkpoint(next.source()).unwrap(),
            Some(next)
        );
    }
}

#[cfg(feature = "local-runtime")]
#[test]
fn presentation_checkpoint_post_replace_fault_retries_uncertain_commit() {
    for phase in [
        CheckpointIoPhase::AtomicReplaceAfterPublication,
        CheckpointIoPhase::DirectorySync,
    ] {
        let temp = TempDir::new().unwrap();
        let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
        let session = publish_ready_session(&root, "runner-1", 4, "host-1");
        let DiscoveryManifest::Ready(ready) = session.read_manifest().unwrap() else {
            panic!("expected ready manifest")
        };
        let old = presentation_checkpoint_at(&ready, 7, 24, 80, b"\x1b[Hold");
        let next = presentation_checkpoint_at(&ready, 8, 25, 81, b"\x1b[Hnext");
        let lock = session.acquire_lifetime_lock().unwrap();
        session.write_presentation_checkpoint(&lock, &old).unwrap();
        let mut checkpoint_io = FailOnceCheckpointIo::new(phase);

        let error = session
            .write_presentation_checkpoint_with_io(&lock, &next, &mut checkpoint_io)
            .unwrap_err();
        assert_eq!(
            error.phase(),
            match phase {
                CheckpointIoPhase::AtomicReplaceAfterPublication => {
                    PresentationCheckpointWritePhase::AtomicReplace
                }
                CheckpointIoPhase::DirectorySync => {
                    PresentationCheckpointWritePhase::DirectorySync
                }
                _ => unreachable!(),
            }
        );
        assert_eq!(
            session.read_presentation_checkpoint(next.source()).unwrap(),
            Some(next.clone()),
            "{phase:?} occurs after rename, so the new valid file may already be visible"
        );

        session
            .write_presentation_checkpoint_with_io(&lock, &next, &mut checkpoint_io)
            .unwrap();
        assert_eq!(
            session.read_presentation_checkpoint(next.source()).unwrap(),
            Some(next)
        );
    }
}

#[cfg(feature = "local-runtime")]
#[test]
fn presentation_checkpoint_reader_ignores_crash_temporary_residue() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let session = publish_ready_session(&root, "runner-1", 4, "host-1");
    let DiscoveryManifest::Ready(ready) = session.read_manifest().unwrap() else {
        panic!("expected ready manifest")
    };
    let checkpoint = presentation_checkpoint(&ready);
    let lock = session.acquire_lifetime_lock().unwrap();
    session
        .write_presentation_checkpoint(&lock, &checkpoint)
        .unwrap();
    fs::write(session.path().join(".presentation.tmp.crash"), b"{partial").unwrap();

    assert_eq!(
        session
            .read_presentation_checkpoint(checkpoint.source())
            .unwrap(),
        Some(checkpoint)
    );
}

#[cfg(feature = "local-runtime")]
#[test]
fn presentation_checkpoint_crash_boundaries_reopen_only_valid_monotonic_state() {
    for phase in [
        CheckpointIoPhase::WriteAll,
        CheckpointIoPhase::FileSync,
        CheckpointIoPhase::AtomicReplaceAfterPublication,
        CheckpointIoPhase::DirectorySync,
    ] {
        let temp = TempDir::new().unwrap();
        let discovery_root = temp.path().join("hmux");
        let root = DiscoveryRoot::create(&discovery_root).unwrap();
        let session = publish_ready_session(&root, "runner-1", 4, "host-1");
        let DiscoveryManifest::Ready(ready) = session.read_manifest().unwrap() else {
            panic!("expected ready manifest")
        };
        let old = presentation_checkpoint_at(&ready, 7, 24, 80, b"\x1b[Hold");
        let next = presentation_checkpoint_at(&ready, 8, 25, 81, b"\x1b[Hnext");
        let source = old.source().clone();
        let key = source.discovery_key().unwrap();
        let lock = session.acquire_lifetime_lock().unwrap();
        session.write_presentation_checkpoint(&lock, &old).unwrap();
        let mut checkpoint_io = CrashAfterCheckpointIo::new(phase);

        assert!(
            session
                .write_presentation_checkpoint_with_io(&lock, &next, &mut checkpoint_io)
                .is_err()
        );
        drop(lock);
        drop(session);
        drop(root);

        let reopened = DiscoveryRoot::open(&discovery_root)
            .unwrap()
            .open_session(key)
            .unwrap();
        let recovered = reopened
            .read_presentation_checkpoint(&source)
            .unwrap()
            .expect("a crash boundary must retain one valid checkpoint");
        let expected = match phase {
            CheckpointIoPhase::WriteAll | CheckpointIoPhase::FileSync => &old,
            CheckpointIoPhase::AtomicReplaceAfterPublication | CheckpointIoPhase::DirectorySync => {
                &next
            }
            CheckpointIoPhase::AtomicReplace => unreachable!(),
        };
        assert_eq!(
            &recovered, expected,
            "{phase:?} recovered an invalid publication boundary"
        );
        assert!(
            recovered.sequence_through() >= old.sequence_through(),
            "{phase:?} regressed the durable checkpoint"
        );
    }
}

#[cfg(feature = "local-runtime")]
#[test]
fn presentation_checkpoint_rejects_corruption_wrong_fence_and_oversize() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let session = publish_ready_session(&root, "runner-1", 4, "host-1");
    let DiscoveryManifest::Ready(ready) = session.read_manifest().unwrap() else {
        panic!("expected ready manifest")
    };
    let checkpoint = presentation_checkpoint(&ready);
    let source = checkpoint.source().clone();
    let lock = session.acquire_lifetime_lock().unwrap();
    session
        .write_presentation_checkpoint(&lock, &checkpoint)
        .unwrap();
    let checkpoint_path = session.path().join(PRESENTATION_CHECKPOINT_FILE_NAME);

    fs::write(&checkpoint_path, b"{not-json").unwrap();
    assert!(matches!(
        session.read_presentation_checkpoint(&source),
        Err(DiscoveryError::Serialization(_))
    ));

    session
        .write_presentation_checkpoint(&lock, &checkpoint)
        .unwrap();
    let mut wrong_fence: serde_json::Value =
        serde_json::from_slice(&fs::read(&checkpoint_path).unwrap()).unwrap();
    wrong_fence["source"]["hostInstanceId"] = serde_json::json!("other-host");
    fs::write(&checkpoint_path, serde_json::to_vec(&wrong_fence).unwrap()).unwrap();
    assert!(matches!(
        session.read_presentation_checkpoint(&source),
        Err(DiscoveryError::PresentationCheckpointInvalid {
            reason: "source fence"
        })
    ));

    fs::write(
        &checkpoint_path,
        vec![b'x'; PRESENTATION_CHECKPOINT_MAX_BYTES + 1],
    )
    .unwrap();
    assert!(matches!(
        session.read_presentation_checkpoint(&source),
        Err(DiscoveryError::PresentationCheckpointTooLarge { .. })
    ));
}

#[cfg(all(feature = "local-runtime", unix))]
#[test]
fn presentation_checkpoint_symlink_is_refused() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let session = publish_ready_session(&root, "runner-1", 4, "host-1");
    let DiscoveryManifest::Ready(ready) = session.read_manifest().unwrap() else {
        panic!("expected ready manifest")
    };
    let source = PresentationCheckpointSource::from_ready(&ready);
    let target = temp.path().join("attacker-presentation");
    fs::write(&target, b"{}").unwrap();
    symlink(
        &target,
        session.path().join(PRESENTATION_CHECKPOINT_FILE_NAME),
    )
    .unwrap();

    assert!(matches!(
        session.read_presentation_checkpoint(&source),
        Err(DiscoveryError::Security {
            violation: SecurityViolation::Symlink,
            ..
        })
    ));
}

#[test]
fn list_sessions_reports_ready_and_exited_and_skips_starting_and_carries_class() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    publish_named_session(
        &root,
        "session_ready",
        "host-ready",
        NamedSessionLifecycle::Ready {
            session_name: Some("ready-shell"),
            session_class: SessionClass::Standalone,
        },
    );
    publish_named_session(
        &root,
        "session_exited",
        "host-exited",
        NamedSessionLifecycle::Exited,
    );
    // A Starting-only session is transient and not attachable; the census skips
    // it rather than surfacing an endpoint-less entry.
    publish_named_session(
        &root,
        "session_starting",
        "host-starting",
        NamedSessionLifecycle::StartingOnly,
    );

    let listed = root.list_sessions().unwrap();
    let session_ids: Vec<&str> = listed.iter().map(|entry| entry.key.session_id()).collect();
    assert_eq!(session_ids, vec!["session_exited", "session_ready"]);

    // The class and human name survive the census read so the standalone CLI
    // filter can select and render them without re-reading the manifest.
    let ready = listed
        .iter()
        .find(|entry| entry.key.session_id() == "session_ready")
        .unwrap();
    assert_eq!(
        ready.manifest.common().session_class,
        SessionClass::Standalone
    );
    assert_eq!(
        ready.manifest.common().session_name.as_deref(),
        Some("ready-shell")
    );
}

#[test]
fn list_sessions_is_empty_when_root_has_no_entries() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    assert!(root.list_sessions().unwrap().is_empty());
}

#[test]
fn list_sessions_ignores_more_debris_than_the_valid_result_limit() {
    let temp = TempDir::new().unwrap();
    let limits = ManifestLimits {
        max_session_lookup_entries: 1,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    publish_named_session(
        &root,
        "session_live",
        "host-live",
        NamedSessionLifecycle::Ready {
            session_name: Some("live"),
            session_class: SessionClass::Standalone,
        },
    );
    for index in 0..129 {
        let debris = root
            .session(
                DiscoveryKey::new(
                    "workspace",
                    format!("retired_debris_{index}"),
                    "runner-1",
                    4,
                )
                .unwrap(),
            )
            .unwrap();
        if index % 2 == 0 {
            let mut manifest = private_storage::open_new_file(&debris.manifest_path()).unwrap();
            manifest.write_all(b"{not-json").unwrap();
            manifest.sync_all().unwrap();
        }
    }

    let listed = root.list_sessions().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].key.session_id(), "session_live");
}

#[test]
fn list_sessions_rejects_more_valid_sessions_instead_of_truncating() {
    let temp = TempDir::new().unwrap();
    let limits = ManifestLimits {
        max_session_lookup_entries: 2,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    for (session_id, host_id) in [
        ("session_z", "host-z"),
        ("session_a", "host-a"),
        ("session_m", "host-m"),
    ] {
        publish_named_session(
            &root,
            session_id,
            host_id,
            NamedSessionLifecycle::Ready {
                session_name: Some("standalone"),
                session_class: SessionClass::Standalone,
            },
        );
    }

    assert!(matches!(
        root.list_sessions(),
        Err(DiscoveryError::LookupLimitExceeded { maximum: 2 })
    ));
}

#[test]
fn bounded_catalog_census_exceeds_the_legacy_lookup_limit_in_one_scan() {
    let temp = TempDir::new().unwrap();
    let limits = ManifestLimits {
        max_session_lookup_entries: 2,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    for (session_id, host_id) in [
        ("session_z", "host-z"),
        ("session_a", "host-a"),
        ("session_m", "host-m"),
    ] {
        publish_named_session(
            &root,
            session_id,
            host_id,
            NamedSessionLifecycle::Ready {
                session_name: Some("standalone"),
                session_class: SessionClass::Standalone,
            },
        );
    }

    assert!(matches!(
        root.list_sessions(),
        Err(DiscoveryError::LookupLimitExceeded { maximum: 2 })
    ));
    assert!(matches!(
        root.list_sessions_bounded(2),
        Err(DiscoveryError::LookupLimitExceeded { maximum: 2 })
    ));
    let sessions = root.list_sessions_bounded(3).unwrap();
    assert_eq!(
        sessions
            .iter()
            .map(|session| session.key.session_id())
            .collect::<Vec<_>>(),
        vec!["session_a", "session_m", "session_z"]
    );
}

#[test]
fn exited_session_census_has_a_deterministic_separate_candidate_bound() {
    let temp = TempDir::new().unwrap();
    let limits = ManifestLimits {
        max_session_lookup_entries: 2,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    for (session_id, host_id, lifecycle) in [
        (
            "ready_a",
            "host-ready-a",
            NamedSessionLifecycle::Ready {
                session_name: Some("ready-a"),
                session_class: SessionClass::Standalone,
            },
        ),
        (
            "ready_b",
            "host-ready-b",
            NamedSessionLifecycle::Ready {
                session_name: Some("ready-b"),
                session_class: SessionClass::Standalone,
            },
        ),
        ("exited_z", "host-z", NamedSessionLifecycle::Exited),
        ("exited_a", "host-a", NamedSessionLifecycle::Exited),
        ("exited_m", "host-m", NamedSessionLifecycle::Exited),
    ] {
        publish_named_session(&root, session_id, host_id, lifecycle);
    }

    assert!(matches!(
        root.list_sessions(),
        Err(DiscoveryError::LookupLimitExceeded { maximum: 2 })
    ));
    let exited = root.list_exited_sessions(2).unwrap();
    assert!(exited.has_more);
    assert_eq!(
        exited
            .sessions
            .iter()
            .map(|session| session.key.session_id())
            .collect::<Vec<_>>(),
        vec!["exited_a", "exited_m"]
    );
    let cursor = exited.sessions.last().unwrap().key.clone();
    let next = root.list_exited_sessions_after(2, Some(&cursor)).unwrap();
    assert!(!next.has_more);
    assert_eq!(next.sessions.len(), 1);
    assert_eq!(next.sessions[0].key.session_id(), "exited_z");
}

#[test]
fn lifetime_lock_is_exclusive_and_released_with_owner() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    let first = session.acquire_lifetime_lock().unwrap();

    assert!(matches!(
        session.acquire_lifetime_lock(),
        Err(DiscoveryError::AlreadyLocked { .. })
    ));
    drop(first);
    session.acquire_lifetime_lock().unwrap();
}

#[test]
fn starting_to_ready_is_atomic_and_cleanup_is_generation_exact() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    let lock = session.acquire_lifetime_lock().unwrap();
    session.publish_starting(&lock, starting("host-1")).unwrap();
    session.publish_ready(&lock, ready("host-1")).unwrap();
    let actual = session.read_manifest().unwrap();
    assert!(matches!(actual, DiscoveryManifest::Ready(_)));

    let wrong = ManifestGeneration {
        host_instance_id: "host-2".into(),
        host_process: common("host-2").host_process,
        terminal_epoch: Some("terminal-1".into()),
    };
    assert!(matches!(
        session.cleanup_current(&lock, &wrong),
        Err(DiscoveryError::GenerationMismatch)
    ));
    assert!(session.manifest_path().exists());

    assert!(
        session
            .cleanup_current(&lock, &actual.generation())
            .unwrap()
    );
    assert!(!session.manifest_path().exists());
}

#[test]
fn exited_host_remains_discoverable_and_keeps_the_session_lock() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let session = root
        .session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap();
    let lock = session.acquire_lifetime_lock().unwrap();
    session.publish_starting(&lock, starting("host-1")).unwrap();
    session.publish_ready(&lock, ready("host-1")).unwrap();
    let tombstone = exited("host-1");
    session.publish_exited(&lock, tombstone.clone()).unwrap();
    session.publish_exited(&lock, tombstone).unwrap();

    let found = root
        .find_manifest_by_session("workspace", "session")
        .unwrap();
    assert!(matches!(found.manifest, DiscoveryManifest::Exited(_)));
    assert!(matches!(
        session.acquire_lifetime_lock(),
        Err(DiscoveryError::AlreadyLocked { .. })
    ));
}

#[test]
fn exited_cleanup_archives_tombstone_and_is_idempotent() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let session = root
        .session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap();
    let lock = session.acquire_lifetime_lock().unwrap();
    session.publish_starting(&lock, starting("host-1")).unwrap();
    let exited = exited("host-1");
    session.publish_exited(&lock, exited.clone()).unwrap();
    let generation = DiscoveryManifest::Exited(exited.clone()).generation();

    assert!(session.retire_exited_current(&lock, &generation).unwrap());
    assert!(!session.manifest_path().exists());
    assert_eq!(session.find_retired_exited("host-1").unwrap(), Some(exited));
    assert!(session.retire_exited_current(&lock, &generation).unwrap());
    let mut stale_generation = generation.clone();
    stale_generation
        .host_process
        .start_marker
        .push_str("-stale");
    assert!(matches!(
        session.retire_exited_current(&lock, &stale_generation),
        Err(DiscoveryError::GenerationMismatch)
    ));
    assert!(matches!(
        root.find_manifest_by_session("workspace", "session"),
        Err(DiscoveryError::SessionNotFound)
    ));
}

#[test]
fn retired_history_record_capacity_refuses_new_generation_without_removing_current() {
    let temp = TempDir::new().unwrap();
    let limits = ManifestLimits {
        max_retired_manifest_entries: 1,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    publish_and_retire_generation(&root, 1);

    let session = session_for_generation(&root, 2);
    let lock = session.acquire_lifetime_lock().unwrap();
    let (starting, exited) = replacement_generation(2);
    let generation = DiscoveryManifest::Exited(exited.clone()).generation();
    session.publish_starting(&lock, starting).unwrap();
    session.publish_exited(&lock, exited.clone()).unwrap();

    assert!(matches!(
        session.retire_exited_current(&lock, &generation),
        Err(DiscoveryError::RetiredHistoryRecordCapacityExceeded {
            actual: 2,
            maximum: 1,
        })
    ));
    assert_eq!(
        session.read_manifest().unwrap(),
        DiscoveryManifest::Exited(exited)
    );
    assert_eq!(
        fs::read_dir(session.path().join(RETIRED_DIRECTORY_NAME))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn retired_directory_parent_sync_failure_preserves_the_current_manifest() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let session = session_for_generation(&root, 1);
    let lock = session.acquire_lifetime_lock().unwrap();
    let (starting, exited) = replacement_generation(1);
    let generation = DiscoveryManifest::Exited(exited.clone()).generation();
    session.publish_starting(&lock, starting).unwrap();
    session.publish_exited(&lock, exited.clone()).unwrap();

    let error = session
        .retire_exited_current_with_parent_sync_for_test(&lock, &generation, |path| {
            Err(DiscoveryError::io(
                "fault-injected retired parent sync",
                path,
                std::io::Error::other("fault-injected parent fsync failure"),
            ))
        })
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("fault-injected parent fsync failure")
    );
    assert_eq!(
        session.read_manifest().unwrap(),
        DiscoveryManifest::Exited(exited.clone())
    );
    assert!(session.manifest_path().exists());
    assert!(session.retire_exited_current(&lock, &generation).unwrap());
    assert!(!session.manifest_path().exists());
    assert_eq!(
        session.find_retired_exited_generation(&generation).unwrap(),
        Some(exited)
    );
}

#[test]
fn exact_retirement_retry_succeeds_at_history_capacity() {
    let temp = TempDir::new().unwrap();
    let limits = ManifestLimits {
        max_retired_manifest_entries: 1,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    let (session, generation) = publish_and_retire_generation(&root, 1);
    let lock = session.acquire_lifetime_lock().unwrap();

    session.restore_retired_exited(&lock, &generation).unwrap();
    assert!(session.retire_exited_current(&lock, &generation).unwrap());
    assert!(!session.manifest_path().exists());
    assert_eq!(
        fs::read_dir(session.path().join(RETIRED_DIRECTORY_NAME))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn retired_history_byte_capacity_counts_existing_files_and_preserves_current() {
    let temp = TempDir::new().unwrap();
    let (_, first) = replacement_generation(1);
    let first_bytes = serde_json::to_vec(&DiscoveryManifest::Exited(first))
        .unwrap()
        .len() as u64;
    let limits = ManifestLimits {
        max_retired_manifest_entries: 8,
        max_retired_manifest_bytes: first_bytes,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    publish_and_retire_generation(&root, 1);

    let session = session_for_generation(&root, 2);
    let lock = session.acquire_lifetime_lock().unwrap();
    let (starting, exited) = replacement_generation(2);
    let generation = DiscoveryManifest::Exited(exited.clone()).generation();
    session.publish_starting(&lock, starting).unwrap();
    session.publish_exited(&lock, exited.clone()).unwrap();

    assert!(matches!(
        session.retire_exited_current(&lock, &generation),
        Err(DiscoveryError::RetiredHistoryByteCapacityExceeded {
            maximum,
            actual,
        }) if maximum == first_bytes && actual > maximum
    ));
    assert_eq!(
        session.read_manifest().unwrap(),
        DiscoveryManifest::Exited(exited)
    );
}

#[test]
fn retired_history_raw_scan_capacity_counts_crash_temporaries() {
    let temp = TempDir::new().unwrap();
    let limits = ManifestLimits {
        max_retired_manifest_entries: 8,
        max_retired_manifest_scan_entries: 2,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    let session = session_for_generation(&root, 1);
    let retired = session.path().join(RETIRED_DIRECTORY_NAME);
    private_storage::create_directory(&retired).unwrap();
    drop(private_storage::open_new_file(&retired.join(".retired.tmp-a")).unwrap());
    drop(private_storage::open_new_file(&retired.join(".retired.tmp-b")).unwrap());
    let lock = session.acquire_lifetime_lock().unwrap();
    let (starting, exited) = replacement_generation(1);
    let generation = DiscoveryManifest::Exited(exited.clone()).generation();
    session.publish_starting(&lock, starting).unwrap();
    session.publish_exited(&lock, exited.clone()).unwrap();

    assert!(matches!(
        session.retire_exited_current(&lock, &generation),
        Err(DiscoveryError::RetiredHistoryScanCapacityExceeded {
            actual: 3,
            maximum: 2,
        })
    ));
    assert_eq!(
        session.read_manifest().unwrap(),
        DiscoveryManifest::Exited(exited)
    );
}

#[test]
fn corrupt_retired_history_consumes_capacity_without_removing_current() {
    let temp = TempDir::new().unwrap();
    let limits = ManifestLimits {
        max_retired_manifest_entries: 1,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    let session = session_for_generation(&root, 1);
    create_retired_corruption(&session, &format!("g_{}.json", "0".repeat(64)));
    let lock = session.acquire_lifetime_lock().unwrap();
    let (starting, exited) = replacement_generation(1);
    let generation = DiscoveryManifest::Exited(exited.clone()).generation();
    session.publish_starting(&lock, starting).unwrap();
    session.publish_exited(&lock, exited.clone()).unwrap();

    assert!(matches!(
        session.retire_exited_current(&lock, &generation),
        Err(DiscoveryError::RetiredHistoryRecordCapacityExceeded {
            actual: 2,
            maximum: 1,
        })
    ));
    assert_eq!(
        session.read_manifest().unwrap(),
        DiscoveryManifest::Exited(exited)
    );
}

#[cfg(unix)]
#[test]
fn symlinked_retired_history_refuses_admission_without_removing_current() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let session = session_for_generation(&root, 1);
    let retired = session.path().join(RETIRED_DIRECTORY_NAME);
    private_storage::create_directory(&retired).unwrap();
    let target = temp.path().join("retired-target");
    fs::write(&target, b"{}").unwrap();
    symlink(&target, retired.join(format!("g_{}.json", "0".repeat(64)))).unwrap();
    let lock = session.acquire_lifetime_lock().unwrap();
    let (starting, exited) = replacement_generation(1);
    let generation = DiscoveryManifest::Exited(exited.clone()).generation();
    session.publish_starting(&lock, starting).unwrap();
    session.publish_exited(&lock, exited.clone()).unwrap();

    assert!(matches!(
        session.retire_exited_current(&lock, &generation),
        Err(DiscoveryError::Security {
            violation: SecurityViolation::Symlink,
            ..
        })
    ));
    assert_eq!(
        session.read_manifest().unwrap(),
        DiscoveryManifest::Exited(exited)
    );
}

#[test]
fn more_than_legacy_lookup_bound_retired_generations_do_not_hide_live_ready_session() {
    let temp = TempDir::new().unwrap();
    let limits = ManifestLimits {
        max_session_lookup_entries: 4,
        max_retired_manifest_entries: 256,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    for index in 1..=129 {
        publish_and_retire_generation(&root, index);
    }
    publish_ready_session(&root, "runner-live", 130, "host-live");

    let sessions = root.list_sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].manifest.common().host_instance_id, "host-live");
    assert!(matches!(
        root.find_manifest_by_session("workspace", "session")
            .unwrap()
            .manifest,
        DiscoveryManifest::Ready(_)
    ));
}

#[test]
fn retired_exact_generation_lookup_ignores_unrelated_debris_and_scan_limit() {
    let temp = TempDir::new().unwrap();
    let limits = ManifestLimits {
        max_session_lookup_entries: 1,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    let session = root
        .session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap();
    create_retired_corruption(&session, "00-corrupt.json");
    create_retired_corruption(&session, "01-corrupt.json");
    let lock = session.acquire_lifetime_lock().unwrap();
    session.publish_starting(&lock, starting("host-1")).unwrap();
    let exited = exited("host-1");
    let generation = DiscoveryManifest::Exited(exited.clone()).generation();
    session.publish_exited(&lock, exited.clone()).unwrap();
    session.retire_exited_current(&lock, &generation).unwrap();

    assert_eq!(
        session.find_retired_exited_generation(&generation).unwrap(),
        Some(exited)
    );
}

#[test]
fn retired_host_scan_and_presence_are_not_blinded_by_corrupt_debris() {
    let temp = TempDir::new().unwrap();
    let limits = ManifestLimits {
        max_session_lookup_entries: 1,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    let session = root
        .session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap();
    create_retired_corruption(&session, "00-corrupt.json");
    create_retired_corruption(&session, "01-corrupt.json");
    let lock = session.acquire_lifetime_lock().unwrap();
    session.publish_starting(&lock, starting("host-1")).unwrap();
    let exited = exited("host-1");
    let generation = DiscoveryManifest::Exited(exited.clone()).generation();
    session.publish_exited(&lock, exited.clone()).unwrap();
    session.retire_exited_current(&lock, &generation).unwrap();

    assert_eq!(session.find_retired_exited("host-1").unwrap(), Some(exited));
    assert!(session.has_retired_exited().unwrap());
}

#[test]
fn retired_scan_fails_closed_when_only_corrupt_debris_exists() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    create_retired_corruption(&session, "corrupt.json");

    assert!(session.find_retired_exited("missing-host").is_err());
    assert!(session.has_retired_exited().is_err());
}

#[test]
fn retirement_without_active_or_archived_manifest_is_absent() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    let lock = session.acquire_lifetime_lock().unwrap();
    let expected = DiscoveryManifest::Exited(exited("host-1")).generation();

    assert!(!session.retire_exited_current(&lock, &expected).unwrap());
}

#[test]
fn cleanup_retry_finishes_after_archive_before_active_remove() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    let lock = session.acquire_lifetime_lock().unwrap();
    session.publish_starting(&lock, starting("host-1")).unwrap();
    let exited = exited("host-1");
    session.publish_exited(&lock, exited.clone()).unwrap();
    let generation = DiscoveryManifest::Exited(exited.clone()).generation();
    session.retire_exited_current(&lock, &generation).unwrap();

    let retired_path = std::fs::read_dir(session.path().join("retired"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut source = private_storage::open_existing_file(&retired_path).unwrap();
    let mut destination = private_storage::open_new_file(&session.manifest_path()).unwrap();
    std::io::copy(&mut source, &mut destination).unwrap();
    destination.sync_all().unwrap();

    assert!(session.retire_exited_current(&lock, &generation).unwrap());
    assert!(!session.manifest_path().exists());
    assert_eq!(session.find_retired_exited("host-1").unwrap(), Some(exited));
}

#[test]
fn legacy_v1_exited_manifest_is_retirable_for_current_replacement_retry() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    let lock = session.acquire_lifetime_lock().unwrap();
    let mut legacy = starting("legacy-host-v1");
    legacy.common.schema_version = 1;
    legacy.common.host_build_version = "0.1.0".into();
    legacy.common.capabilities = vec!["screen_snapshot".into()];
    session.publish_starting(&lock, legacy).unwrap();
    let mut legacy_exit = exited("legacy-host-v1");
    legacy_exit.common.host_build_version = "0.1.0".into();
    legacy_exit.common.capabilities = vec!["screen_snapshot".into()];
    session.publish_exited(&lock, legacy_exit.clone()).unwrap();

    session
        .retire_exited_current(&lock, &DiscoveryManifest::Exited(legacy_exit).generation())
        .unwrap();
    drop(lock);

    let root = DiscoveryRoot::open(temp.path().join("hmux")).unwrap();
    let successor = root
        .session(DiscoveryKey::new("workspace", "session", "runner-2", 5).unwrap())
        .unwrap();
    let successor_lock = successor.acquire_lifetime_lock().unwrap();
    let mut successor_starting = starting("current-host");
    successor_starting.common.lifetime.runner_instance = "runner-2".into();
    successor_starting.common.lifetime.channel_epoch = 5;
    successor
        .publish_starting(&successor_lock, successor_starting)
        .unwrap();
    let mut successor_ready = ready("current-host");
    successor_ready.common.lifetime.runner_instance = "runner-2".into();
    successor_ready.common.lifetime.channel_epoch = 5;
    successor_ready.provider_process = ProcessProof {
        process_id: 202,
        start_marker: "provider-start-current".into(),
    };
    successor_ready.terminal_epoch = "terminal-current".into();
    successor
        .publish_ready(&successor_lock, successor_ready)
        .unwrap();

    assert!(
        successor
            .find_retired_exited("legacy-host-v1")
            .unwrap()
            .is_some()
    );
    let DiscoveryManifest::Ready(current) = successor.read_manifest().unwrap() else {
        panic!("expected one current-protocol successor")
    };
    assert_eq!(current.common.host_instance_id, "current-host");
    assert_eq!(
        current.common.claim_linkage.claim_id.as_deref(),
        Some("claim-1")
    );
    assert_eq!(current.provider_process.process_id, 202);
    assert_eq!(
        current.provider_process.start_marker,
        "provider-start-current"
    );
    assert_eq!(
        root.find_manifest_by_session("workspace", "session")
            .unwrap()
            .manifest,
        DiscoveryManifest::Ready(current)
    );
}

#[test]
fn retirement_temp_allocation_skips_crash_residue() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    let retired_path = session.path().join(RETIRED_DIRECTORY_NAME);
    private_storage::create_directory(&retired_path).unwrap();
    let sequence = AtomicU64::new(17);
    let residue = retired_path.join(format!(".retired.tmp-{}-17", std::process::id()));
    private_storage::open_new_file(&residue).unwrap();

    let (selected, _file) = session
        .create_retirement_temp(&retired_path, &sequence)
        .unwrap();

    assert_eq!(
        selected.file_name().unwrap().to_string_lossy(),
        format!(".retired.tmp-{}-18", std::process::id())
    );
}

#[test]
fn retired_exited_host_allows_one_same_session_successor() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let predecessor = root
        .session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap();
    let predecessor_lock = predecessor.acquire_lifetime_lock().unwrap();
    predecessor
        .publish_starting(&predecessor_lock, starting("host-1"))
        .unwrap();
    let exited = exited("host-1");
    predecessor
        .publish_exited(&predecessor_lock, exited.clone())
        .unwrap();
    predecessor
        .retire_exited_current(
            &predecessor_lock,
            &DiscoveryManifest::Exited(exited).generation(),
        )
        .unwrap();
    drop(predecessor_lock);

    let successor = root
        .session(DiscoveryKey::new("workspace", "session", "runner-2", 5).unwrap())
        .unwrap();
    let successor_lock = successor.acquire_lifetime_lock().unwrap();
    let mut successor_starting = starting("host-2");
    successor_starting.common.lifetime.runner_instance = "runner-2".into();
    successor_starting.common.lifetime.channel_epoch = 5;
    successor
        .publish_starting(&successor_lock, successor_starting)
        .unwrap();
    let mut successor_ready = ready("host-2");
    successor_ready.common.lifetime.runner_instance = "runner-2".into();
    successor_ready.common.lifetime.channel_epoch = 5;
    successor_ready.provider_process = ProcessProof {
        process_id: 202,
        start_marker: "provider-start-2".into(),
    };
    successor_ready.terminal_epoch = "terminal-2".into();
    successor
        .publish_ready(&successor_lock, successor_ready)
        .unwrap();

    let DiscoveryManifest::Ready(current) = successor.read_manifest().unwrap() else {
        panic!("expected one ready successor")
    };
    assert_eq!(current.common.host_instance_id, "host-2");
    assert_eq!(current.terminal_epoch, "terminal-2");
    assert_eq!(current.provider_process.process_id, 202);
    assert_eq!(
        current.common.claim_linkage.claim_id.as_deref(),
        Some("claim-1")
    );
    let retired = successor.find_retired_exited("host-1").unwrap().unwrap();
    assert_eq!(retired.tombstone.fence.terminal_epoch, "terminal-1");
    assert_ne!(retired.tombstone.provider_process, current.provider_process);
    assert!(matches!(
        root.find_manifest_by_session("workspace", "session")
            .unwrap()
            .manifest,
        DiscoveryManifest::Ready(_)
    ));
    assert!(matches!(
        successor.acquire_lifetime_lock(),
        Err(DiscoveryError::AlreadyLocked { .. })
    ));
}

#[test]
fn retired_generation_digest_separates_equal_millisecond_and_reused_pid() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let first = root
        .session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap();
    let first_lock = first.acquire_lifetime_lock().unwrap();
    let mut first_starting = starting("host-1");
    first_starting.common.host_process.process_id = 77;
    first_starting.common.host_process.start_marker = "process-generation-a".into();
    first.publish_starting(&first_lock, first_starting).unwrap();
    let mut first_exit = exited("host-1");
    first_exit.common.host_process.process_id = 77;
    first_exit.common.host_process.start_marker = "process-generation-a".into();
    first_exit.exited_unix_ms = 9;
    first
        .publish_exited(&first_lock, first_exit.clone())
        .unwrap();
    first
        .retire_exited_current(
            &first_lock,
            &DiscoveryManifest::Exited(first_exit).generation(),
        )
        .unwrap();
    drop(first_lock);

    let second = root
        .session(DiscoveryKey::new("workspace", "session", "runner-2", 5).unwrap())
        .unwrap();
    let second_lock = second.acquire_lifetime_lock().unwrap();
    let mut second_starting = starting("host-2");
    second_starting.common.lifetime.runner_instance = "runner-2".into();
    second_starting.common.lifetime.channel_epoch = 5;
    second_starting.common.host_process.process_id = 77;
    second_starting.common.host_process.start_marker = "process-generation-b".into();
    second
        .publish_starting(&second_lock, second_starting)
        .unwrap();
    let mut second_exit = exited("host-2");
    second_exit.common.lifetime.runner_instance = "runner-2".into();
    second_exit.common.lifetime.channel_epoch = 5;
    second_exit.common.host_process.process_id = 77;
    second_exit.common.host_process.start_marker = "process-generation-b".into();
    second_exit.tombstone.fence.runner_instance = "runner-2".into();
    second_exit.tombstone.fence.channel_epoch = 5;
    second_exit.tombstone.fence.terminal_epoch = "terminal-2".into();
    second_exit.exited_unix_ms = 9;
    second
        .publish_exited(&second_lock, second_exit.clone())
        .unwrap();
    second
        .retire_exited_current(
            &second_lock,
            &DiscoveryManifest::Exited(second_exit).generation(),
        )
        .unwrap();

    assert!(second.find_retired_exited("host-1").unwrap().is_some());
    assert!(second.find_retired_exited("host-2").unwrap().is_some());
    assert_eq!(
        std::fs::read_dir(second.path().join("retired"))
            .unwrap()
            .count(),
        2
    );
}

#[test]
fn retirement_refuses_ready_or_wrong_generation() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    let lock = session.acquire_lifetime_lock().unwrap();
    session.publish_starting(&lock, starting("host-1")).unwrap();
    session.publish_ready(&lock, ready("host-1")).unwrap();
    let ready_generation = session.read_manifest().unwrap().generation();
    assert!(matches!(
        session.retire_exited_current(&lock, &ready_generation),
        Err(DiscoveryError::InvalidManifestTransition {
            from: "ready",
            to: "retired"
        })
    ));

    session.publish_exited(&lock, exited("host-1")).unwrap();
    let mut wrong = session.read_manifest().unwrap().generation();
    wrong.host_instance_id = "host-2".into();
    assert!(matches!(
        session.retire_exited_current(&lock, &wrong),
        Err(DiscoveryError::GenerationMismatch)
    ));
    assert!(session.manifest_path().exists());
}

#[test]
fn provider_that_exits_without_output_still_publishes_an_inspectable_tombstone() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let session = root
        .session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap();
    let lock = session.acquire_lifetime_lock().unwrap();
    session.publish_starting(&lock, starting("host-1")).unwrap();

    let mut tombstone = exited("host-1");
    tombstone.tombstone.exit.final_output_seq = 0;
    session.publish_exited(&lock, tombstone).unwrap();

    assert!(matches!(
        session.read_manifest().unwrap(),
        DiscoveryManifest::Exited(_)
    ));
}

#[test]
fn claimless_manifest_persists_explicit_absent_claim_truth() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    let lock = session.acquire_lifetime_lock().unwrap();
    let mut manifest = starting("host-1");
    manifest.common.claim_linkage.claim_id = None;

    session.publish_starting(&lock, manifest).unwrap();

    let json = std::fs::read_to_string(session.manifest_path()).unwrap();
    assert!(json.contains("\"claim_id\":null"));
}

#[test]
fn exited_predecessor_can_publish_one_exact_same_host_successor_ready() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    let lock = session.acquire_lifetime_lock().unwrap();
    session.publish_starting(&lock, starting("host-1")).unwrap();
    session.publish_ready(&lock, ready("host-1")).unwrap();
    session.publish_exited(&lock, exited("host-1")).unwrap();

    let mut successor = ready("host-1");
    successor.common.lifetime.runner_instance = "runner-2".into();
    successor.common.lifetime.channel_epoch = 5;
    successor.provider_process = ProcessProof {
        process_id: 102,
        start_marker: "provider-start-2".into(),
    };
    successor.terminal_epoch = "terminal-2".into();
    successor.ready_unix_ms = 5;
    session.publish_ready(&lock, successor.clone()).unwrap();

    assert_eq!(
        session.read_manifest().unwrap(),
        DiscoveryManifest::Ready(successor)
    );
}

#[test]
fn exited_predecessor_refuses_ready_that_changes_stable_host_truth() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    let lock = session.acquire_lifetime_lock().unwrap();
    session.publish_starting(&lock, starting("host-1")).unwrap();
    session.publish_ready(&lock, ready("host-1")).unwrap();
    session.publish_exited(&lock, exited("host-1")).unwrap();

    let mut successor = ready("host-1");
    successor.common.lifetime.runner_instance = "runner-2".into();
    successor.common.lifetime.channel_epoch = 5;
    successor.common.claim_linkage.claim_id = Some("claim-2".into());
    successor.terminal_epoch = "terminal-2".into();

    assert!(matches!(
        session.publish_ready(&lock, successor),
        Err(DiscoveryError::ManifestConflict)
    ));
}

#[cfg(unix)]
#[test]
fn discovery_entries_are_private_and_manifest_symlinks_are_refused() {
    use std::os::unix::fs::{PermissionsExt, symlink};

    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    let lock = session.acquire_lifetime_lock().unwrap();
    session.publish_starting(&lock, starting("host-1")).unwrap();

    assert_eq!(
        fs::metadata(session.path()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(session.manifest_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );

    fs::remove_file(session.manifest_path()).unwrap();
    let target = temp.path().join("attacker-manifest");
    fs::write(&target, b"{}").unwrap();
    symlink(target, session.manifest_path()).unwrap();
    assert!(matches!(
        session.read_manifest(),
        Err(DiscoveryError::Security {
            violation: SecurityViolation::Symlink,
            ..
        })
    ));
}

#[cfg(unix)]
#[test]
fn existing_discovery_root_with_broad_mode_is_refused() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new().unwrap();
    let root = temp.path().join("hmux");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();

    assert!(matches!(
        DiscoveryRoot::create(root),
        Err(DiscoveryError::Security {
            violation: SecurityViolation::WrongMode {
                expected: 0o700,
                actual: 0o755,
            },
            ..
        })
    ));
}

#[test]
fn create_provisions_missing_state_parent_for_canonical_discovery_root() {
    let temp = TempDir::new().unwrap();
    let root_path = temp.path().join("state/hmux-hosts");

    let root = DiscoveryRoot::create(&root_path).unwrap();

    assert_eq!(root.path(), root_path);
}

#[test]
fn existing_only_open_never_creates_discovery_state() {
    let temp = TempDir::new().unwrap();
    let missing_root = temp.path().join("missing");

    assert!(DiscoveryRoot::open(&missing_root).is_err());
    assert!(!missing_root.exists());

    let root_path = temp.path().join("hmux");
    let root = DiscoveryRoot::create(&root_path).unwrap();
    let key = DiscoveryKey::new("workspace", "missing", "runner-1", 4).unwrap();
    let session_path =
        root.session_base_path(&SessionLookupKey::new("workspace", "missing").unwrap());

    assert!(root.open_session(key).is_err());
    assert!(!session_path.exists());
}

#[test]
fn standalone_ready_retirement_policy_is_atomically_set_and_cleared() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    let lock = session.acquire_lifetime_lock().unwrap();
    let starting = standalone_starting("host-1");
    let ready = standalone_ready("host-1");
    let generation = DiscoveryManifest::Ready(ready.clone()).generation();
    session.publish_starting(&lock, starting).unwrap();
    session.publish_ready(&lock, ready).unwrap();
    let policy = SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
        grace_period_ms: 5_000,
    };

    let updated = session
        .update_ready_retirement_policy(&lock, &generation, Some(policy))
        .unwrap();
    assert_eq!(updated.common.retirement_policy, Some(policy));
    assert!(matches!(
        session.read_manifest().unwrap(),
        DiscoveryManifest::Ready(ReadyManifest {
            common: ManifestCommon {
                retirement_policy: Some(current),
                ..
            },
            ..
        }) if current == policy
    ));

    let cleared = session
        .update_ready_retirement_policy(&lock, &generation, None)
        .unwrap();
    assert_eq!(cleared.common.retirement_policy, None);
    assert!(matches!(
        session.read_manifest().unwrap(),
        DiscoveryManifest::Ready(ReadyManifest {
            common: ManifestCommon {
                retirement_policy: None,
                ..
            },
            ..
        })
    ));
}

#[test]
fn retirement_policy_update_rejects_stale_or_managed_generations_without_mutation() {
    let temp = TempDir::new().unwrap();
    let standalone_session = session(&temp);
    let lock = standalone_session.acquire_lifetime_lock().unwrap();
    let standalone_starting_manifest = standalone_starting("host-1");
    let standalone_manifest = standalone_ready("host-1");
    let generation = DiscoveryManifest::Ready(standalone_manifest.clone()).generation();
    standalone_session
        .publish_starting(&lock, standalone_starting_manifest)
        .unwrap();
    standalone_session
        .publish_ready(&lock, standalone_manifest.clone())
        .unwrap();
    let policy = SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
        grace_period_ms: 5_000,
    };
    let mut stale_generation = generation.clone();
    stale_generation.terminal_epoch = Some("terminal-stale".into());

    assert!(matches!(
        standalone_session.update_ready_retirement_policy(&lock, &stale_generation, Some(policy)),
        Err(DiscoveryError::GenerationMismatch)
    ));
    assert_eq!(
        standalone_session.read_manifest().unwrap(),
        DiscoveryManifest::Ready(standalone_manifest)
    );
    drop(lock);

    let managed_temp = TempDir::new().unwrap();
    let managed_session = session(&managed_temp);
    let managed_lock = managed_session.acquire_lifetime_lock().unwrap();
    let managed_ready = ready("host-1");
    let managed_generation = DiscoveryManifest::Ready(managed_ready.clone()).generation();
    managed_session
        .publish_starting(&managed_lock, starting("host-1"))
        .unwrap();
    managed_session
        .publish_ready(&managed_lock, managed_ready.clone())
        .unwrap();

    assert!(matches!(
        managed_session.update_ready_retirement_policy(
            &managed_lock,
            &managed_generation,
            Some(policy)
        ),
        Err(DiscoveryError::ManifestConflict)
    ));
    assert_eq!(
        managed_session.read_manifest().unwrap(),
        DiscoveryManifest::Ready(managed_ready)
    );
}

#[test]
fn retirement_policy_update_rejects_invalid_policy_and_non_ready_state() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    let lock = session.acquire_lifetime_lock().unwrap();
    let starting = standalone_starting("host-1");
    let starting_generation = DiscoveryManifest::Starting(starting.clone()).generation();
    session.publish_starting(&lock, starting.clone()).unwrap();
    let invalid = SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
        grace_period_ms: SessionRetirementPolicy::MIN_GRACE_PERIOD_MS - 1,
    };

    assert!(matches!(
        session.update_ready_retirement_policy(&lock, &starting_generation, None),
        Err(DiscoveryError::InvalidManifestTransition {
            from: "non-ready",
            to: "ready"
        })
    ));
    assert!(matches!(
        session.update_ready_retirement_policy(&lock, &starting_generation, Some(invalid)),
        Err(DiscoveryError::ManifestConflict)
    ));
    assert_eq!(
        session.read_manifest().unwrap(),
        DiscoveryManifest::Starting(starting)
    );
}

#[test]
fn ready_cannot_replace_another_host_starting_record() {
    let temp = TempDir::new().unwrap();
    let session = session(&temp);
    let lock = session.acquire_lifetime_lock().unwrap();
    session.publish_starting(&lock, starting("host-1")).unwrap();

    assert!(matches!(
        session.publish_ready(&lock, ready("host-2")),
        Err(DiscoveryError::ManifestConflict)
    ));
}

#[test]
fn exact_session_lookup_returns_one_ready_manifest() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    publish_ready_session(&root, "runner-1", 4, "host-1");

    let found = root
        .find_manifest_by_session("workspace", "session")
        .unwrap();
    assert_eq!(found.key.runner_instance(), "runner-1");
    assert_eq!(found.key.channel_epoch(), 4);
    assert_eq!(found.manifest.common().host_instance_id, "host-1");

    let lookup = SessionLookupKey::new("workspace", "session").unwrap();
    assert_eq!(
        root.session_base_path(&lookup),
        root.path().join("w_776f726b7370616365/s_73657373696f6e")
    );
}

#[cfg(unix)]
#[test]
fn exact_session_id_lookup_refuses_an_insecure_matching_workspace() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let session = publish_ready_session(&root, "runner-1", 4, "host-1");
    let workspace = session.path().parent().unwrap();
    std::fs::set_permissions(workspace, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert!(matches!(
        root.list_sessions_by_id("session"),
        Err(DiscoveryError::Security { .. })
    ));
}

#[test]
fn recovery_lookup_can_read_starting_without_making_it_attachable() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let session = root
        .session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap();
    let lock = session.acquire_lifetime_lock().unwrap();
    let expected = starting("host-1");
    session.publish_starting(&lock, expected.clone()).unwrap();

    assert!(matches!(
        root.find_manifest_by_session("workspace", "session"),
        Err(DiscoveryError::StaleDiscovery {
            reason: StaleDiscoveryReason::NotReady,
            ..
        })
    ));
    let found = root
        .find_current_manifest_by_session("workspace", "session")
        .unwrap();
    assert_eq!(found.key.runner_instance(), "runner-1");
    assert_eq!(found.key.channel_epoch(), 4);
    assert_eq!(found.manifest, DiscoveryManifest::Starting(expected));
}

#[test]
fn session_wide_discovery_refuses_a_parallel_runner_generation() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    publish_ready_session(&root, "runner-1", 4, "host-1");
    let second = root
        .session(DiscoveryKey::new("workspace", "session", "runner-2", 5).unwrap())
        .unwrap();
    let second_lock = second.acquire_lifetime_lock().unwrap();
    let mut second_starting = starting("host-2");
    second_starting.common.lifetime.runner_instance = "runner-2".into();
    second_starting.common.lifetime.channel_epoch = 5;

    assert!(matches!(
        second.publish_starting(&second_lock, second_starting),
        Err(DiscoveryError::InvalidManifestTransition {
            from: "ready",
            to: "starting"
        })
    ));
    assert_eq!(
        root.find_manifest_by_session("workspace", "session")
            .unwrap()
            .manifest
            .common()
            .host_instance_id,
        "host-1"
    );
}

#[test]
fn exact_session_lookup_surfaces_incomplete_discovery_as_stale() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    root.session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap();

    assert!(matches!(
        root.find_manifest_by_session("workspace", "session"),
        Err(DiscoveryError::StaleDiscovery {
            reason: StaleDiscoveryReason::MissingManifest,
            ..
        })
    ));
}

#[test]
fn runner_and_channel_generations_share_one_session_lock_path() {
    let temp = TempDir::new().unwrap();
    let root = DiscoveryRoot::create(temp.path().join("hmux")).unwrap();
    let first = root
        .session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap();
    let second = root
        .session(DiscoveryKey::new("workspace", "session", "runner-2", 5).unwrap())
        .unwrap();

    assert_eq!(first.path(), second.path());
}

#[test]
fn registration_capacity_refuses_a_new_logical_session_before_directory_creation() {
    let temp = TempDir::new().unwrap();
    let limits = ManifestLimits {
        max_session_catalog_entries: 1,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    let first = root
        .session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap();
    let first_lock = first.acquire_lifetime_lock().unwrap();
    first
        .publish_starting(&first_lock, starting("host-1"))
        .unwrap();

    let second_lookup = SessionLookupKey::new("workspace", "other").unwrap();
    let second_path = root.session_base_path(&second_lookup);
    let error = root
        .session(DiscoveryKey::new("workspace", "other", "runner-2", 1).unwrap())
        .unwrap_err();

    assert!(matches!(
        error,
        DiscoveryError::RegistrationCapacityExceeded {
            used: 1,
            maximum: 1,
            remaining: 0,
        }
    ));
    assert!(!second_path.exists());
    assert_eq!(
        first.read_manifest().unwrap().common().host_instance_id,
        "host-1"
    );
}

#[test]
fn unpublished_registration_reservation_rolls_back_under_the_creation_lease() {
    let temp = TempDir::new().unwrap();
    let limits = ManifestLimits {
        max_manifest_bytes: 1,
        max_session_catalog_entries: 1,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    let lookup = SessionLookupKey::new("workspace", "session").unwrap();
    let path = root.session_base_path(&lookup);
    let session = root
        .session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap();
    let lock = session.acquire_lifetime_lock().unwrap();

    // The bounded write refusal models a Host publication fault after
    // reservation/lifetime-lock acquisition but before Starting publication.
    assert!(matches!(
        session.publish_starting(&lock, starting("host-1")),
        Err(DiscoveryError::ManifestTooLarge { maximum: 1, .. })
    ));
    drop(lock);

    assert!(!path.exists());
    assert_eq!(
        root.registration_capacity().unwrap(),
        DiscoveryRegistrationCapacity {
            used: 0,
            maximum: 1,
            remaining: 1,
        }
    );
}

#[test]
fn exact_existing_logical_session_remains_admitted_at_capacity() {
    let temp = TempDir::new().unwrap();
    let limits = ManifestLimits {
        max_session_catalog_entries: 1,
        ..ManifestLimits::default()
    };
    let root = DiscoveryRoot::create_with_limits(temp.path().join("hmux"), limits).unwrap();
    let first = root
        .session(DiscoveryKey::new("workspace", "session", "runner-1", 4).unwrap())
        .unwrap();
    let lock = first.acquire_lifetime_lock().unwrap();
    first.publish_starting(&lock, starting("host-1")).unwrap();
    drop(lock);

    let retry = root
        .session(DiscoveryKey::new("workspace", "session", "runner-2", 5).unwrap())
        .unwrap();

    assert_eq!(retry.path(), first.path());
    drop(retry);
    assert_eq!(
        root.registration_capacity().unwrap(),
        DiscoveryRegistrationCapacity {
            used: 1,
            maximum: 1,
            remaining: 0,
        }
    );
}

#[test]
fn concurrent_registration_creators_cannot_overshoot_capacity() {
    use std::sync::{Arc, Barrier};
    use std::thread;

    let temp = TempDir::new().unwrap();
    let root_path = temp.path().join("hmux");
    let limits = ManifestLimits {
        max_session_catalog_entries: 2,
        ..ManifestLimits::default()
    };
    DiscoveryRoot::create_with_limits(&root_path, limits.clone()).unwrap();
    let barrier = Arc::new(Barrier::new(8));
    let creators = (0..8)
        .map(|index| {
            let root_path = root_path.clone();
            let limits = limits.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                let root = DiscoveryRoot::open_with_limits(root_path, limits).unwrap();
                let session_id = format!("session-{index}");
                let runner_instance = format!("runner-{index}");
                let discovery = match root.session(
                    DiscoveryKey::new("workspace", session_id.clone(), runner_instance.clone(), 1)
                        .unwrap(),
                ) {
                    Ok(discovery) => discovery,
                    Err(DiscoveryError::RegistrationCapacityExceeded { .. }) => return false,
                    Err(error) => panic!("unexpected registration error: {error}"),
                };
                let lock = discovery.acquire_lifetime_lock().unwrap();
                let mut manifest = starting(&format!("host-{index}"));
                manifest.common.lifetime.session_id = session_id;
                manifest.common.lifetime.runner_instance = runner_instance;
                manifest.common.lifetime.channel_epoch = 1;
                discovery.publish_starting(&lock, manifest).unwrap();
                true
            })
        })
        .collect::<Vec<_>>();
    let admitted = creators
        .into_iter()
        .map(|creator| creator.join().unwrap())
        .filter(|admitted| *admitted)
        .count();
    let root = DiscoveryRoot::open_with_limits(root_path, limits).unwrap();

    assert_eq!(admitted, 2);
    assert_eq!(
        root.registration_capacity().unwrap(),
        DiscoveryRegistrationCapacity {
            used: 2,
            maximum: 2,
            remaining: 0,
        }
    );
}

#[path = "manifest_store_tests/creation_lookup.rs"]
mod creation_lookup;
#[path = "manifest_publication_tests.rs"]
mod publication;

/// A freshly provisioned server has no `~/.dure` at all, so the discovery
/// root is missing its grandparent as well as its parent. Creating one missing
/// parent was not enough: the first standalone launch on a newly provisioned
/// host (2026-09-02, WSL Ubuntu) failed with "create private directory at
/// ~/.dure/state failed: No such file or directory", and the remote gateway
/// reported only that it could not create the session.
#[test]
fn discovery_root_creation_creates_every_missing_private_ancestor() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join(".dure").join("state").join("hmux-hosts");
    let root = DiscoveryRoot::create(path.clone()).unwrap();
    assert_eq!(root.path(), path);
    for created in [
        temp.path().join(".dure"),
        temp.path().join(".dure").join("state"),
        path,
    ] {
        let metadata = std::fs::symlink_metadata(&created).unwrap();
        assert!(metadata.is_dir(), "{}", created.display());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            assert_eq!(
                metadata.permissions().mode() & 0o777,
                0o700,
                "{}",
                created.display()
            );
        }
    }
}
