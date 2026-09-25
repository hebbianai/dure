use super::*;
use hmux_client::recovery_journal::{
    ManagedRehostResolutionLookup, PreparedRecoveryIdentity, RecoveryCompletion,
    RecoveryReservation, RecoveryReservationState, existing_operation::reopen_prepared,
    managed_create_ledger, reserve_prepared, resolve_managed_rehost_current,
};
#[cfg(feature = "terminal-state-stream")]
use hmux_client::{TerminalSurfaceAccess, TerminalSurfaceAttachment};
use hmux_host::local_discovery::DiscoveryError;
use hmux_runtime_contract::{
    MANAGED_REHOST_RECOVERY_ACTION, MANAGED_REHOST_RECOVERY_ID_PREFIX,
    ManagedCreateReconcileRequest, ManagedRehostReceipt, ManagedRehostRecipe,
    ManagedRehostReconcileRequest, ManagedRehostRequest, ManagedRehostSourceRecipe, PermissionMode,
    PresentationCheckpointPredecessor, ProviderStateEnvironment,
};

const MANAGED_REHOST_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);
const MANAGED_REHOST_FORCED_EXIT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedManagedRehost {
    request: ManagedRehostRequest,
    replacement: ManagedCreateRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_discovery_root: Option<PathBuf>,
    #[serde(default)]
    conversation_id: Option<String>,
    launch_reference: Option<String>,
    #[serde(default)]
    presentation_handoff: Option<PresentationCheckpointHandoff>,
}

#[derive(Debug)]
pub(crate) struct ManagedRehostError {
    code: &'static str,
    message: String,
}

impl ManagedRehostError {
    pub(crate) fn code(&self) -> &'static str {
        self.code
    }

    fn refused(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn unknown(message: impl Into<String>) -> Self {
        Self::refused("hmux_managed_rehost_outcome_unknown", message)
    }
}

impl std::fmt::Display for ManagedRehostError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub(crate) fn execute(
    request: ManagedRehostRequest,
) -> std::result::Result<ManagedRehostReceipt, ManagedRehostError> {
    let discovery_root = default_discovery_root().map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_unavailable", error.to_string())
    })?;
    let identity = recovery_identity(request.operation_id(), request.source());
    let state = reserve_rehost(&discovery_root, identity.clone(), request)?;
    if matches!(&state, RecoveryReservationState::Pending(_)) {
        ensure_replacement_capacity_before_source_retirement(&discovery_root)?;
    }
    continue_state(&discovery_root, &identity, state)
}

fn ensure_replacement_capacity_before_source_retirement(
    discovery_root: &Path,
) -> std::result::Result<(), ManagedRehostError> {
    let capacity =
        hmux_client::maintain_registration_capacity(discovery_root).map_err(|error| {
            ManagedRehostError::refused("hmux_managed_rehost_unavailable", error.to_string())
        })?;
    if capacity.remaining > 0 {
        return Ok(());
    }
    Err(ManagedRehostError::refused(
        hmux_runtime_contract::DISCOVERY_REGISTRATION_CAPACITY_EXCEEDED_CODE,
        format!(
            "discovery registration capacity remains exhausted after safe cleanup: used={}, maximum={}",
            capacity.used, capacity.maximum
        ),
    ))
}

fn reserve_rehost(
    discovery_root: &Path,
    identity: PreparedRecoveryIdentity,
    request: ManagedRehostRequest,
) -> std::result::Result<RecoveryReservationState, ManagedRehostError> {
    if canonical_root_exists(discovery_root)? {
        if let Some(state) =
            reopen_prepared(discovery_root, &identity).map_err(map_journal_error)?
        {
            return Ok(state);
        }
    }

    prepare_rehost(discovery_root, identity, request)
}

fn prepare_rehost(
    discovery_root: &Path,
    identity: PreparedRecoveryIdentity,
    request: ManagedRehostRequest,
) -> std::result::Result<RecoveryReservationState, ManagedRehostError> {
    request.validate().map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_request_invalid", error.to_string())
    })?;
    if !request.confirmed() {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_confirmation_required",
            "managed rehost requires explicit restart confirmation",
        ));
    }
    if request
        .expected_target_build_id()
        .is_some_and(|expected| expected != crate::HOST_BUILD_ID)
    {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_target_build_changed",
            "runtime build differs from the confirmed rehost target",
        ));
    }
    DiscoveryRoot::create(discovery_root).map_err(map_discovery_error)?;
    let source_discovery_root = source_discovery_root(discovery_root)?;
    let _source_lock = lock_source(
        &source_discovery_root,
        request.source().workspace_id(),
        request.source().session_id(),
    )
    .map_err(map_journal_error)?;
    ensure_source_has_no_other_rehost(discovery_root, &source_discovery_root, request.source())?;
    let prepared = prepare(discovery_root, &source_discovery_root, request)?;
    let canonical = serde_json::to_string(&prepared).map_err(|_| {
        ManagedRehostError::refused(
            "hmux_managed_rehost_request_invalid",
            "prepared managed rehost is not serializable",
        )
    })?;
    reserve_prepared(discovery_root, identity, Some(canonical)).map_err(map_journal_error)
}

fn canonical_root_exists(discovery_root: &Path) -> std::result::Result<bool, ManagedRehostError> {
    match DiscoveryRoot::open(discovery_root) {
        Ok(_) => Ok(true),
        Err(DiscoveryError::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
            Ok(false)
        }
        Err(error) => Err(map_discovery_error(error)),
    }
}

fn map_discovery_error(error: DiscoveryError) -> ManagedRehostError {
    ManagedRehostError::refused("hmux_managed_rehost_unavailable", error.to_string())
}

fn ensure_source_has_no_other_rehost(
    discovery_root: &Path,
    source_discovery_root: &Path,
    source: &ManagedStopRequest,
) -> std::result::Result<(), ManagedRehostError> {
    for root in std::iter::once(discovery_root)
        .chain((source_discovery_root != discovery_root).then_some(source_discovery_root))
    {
        match resolve_managed_rehost_current(root, source.workspace_id(), source.session_id())
            .map_err(map_journal_error)?
        {
            ManagedRehostResolutionLookup::NotFound => {}
            ManagedRehostResolutionLookup::RetryRequired { .. } => {
                return Err(ManagedRehostError::refused(
                    "hmux_managed_rehost_source_changed",
                    "source already has a durable managed rehost intent",
                ));
            }
            ManagedRehostResolutionLookup::Resolved(_) => {
                return Err(ManagedRehostError::refused(
                    "hmux_managed_rehost_source_changed",
                    "source already has a durable managed rehost successor",
                ));
            }
        }
    }
    Ok(())
}

fn source_discovery_root(
    discovery_root: &Path,
) -> std::result::Result<PathBuf, ManagedRehostError> {
    let Some(configured) = std::env::var_os(hmux_client::MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV)
    else {
        return Ok(discovery_root.to_path_buf());
    };
    if configured.is_empty() {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_request_invalid",
            "managed rehost source discovery root is empty",
        ));
    }
    let source = PathBuf::from(configured);
    if !source.is_absolute() {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_request_invalid",
            "managed rehost source discovery root must be absolute",
        ));
    }
    DiscoveryRoot::open(&source).map_err(map_discovery_error)?;
    Ok(source)
}

pub(crate) fn reconcile(
    request: ManagedRehostReconcileRequest,
) -> std::result::Result<ManagedRehostReceipt, ManagedRehostError> {
    let discovery_root = default_discovery_root().map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_unavailable", error.to_string())
    })?;
    let identity = recovery_identity_parts(
        request.operation_id(),
        request.source_session_id(),
        request.source_workspace_id(),
    );
    if !canonical_root_exists(&discovery_root)? {
        return Err(managed_rehost_intent_not_found());
    }
    let state = reopen_prepared(&discovery_root, &identity)
        .map_err(map_journal_error)?
        .ok_or_else(managed_rehost_intent_not_found)?;
    let receipt = continue_state(&discovery_root, &identity, state)?;
    receipt
        .validate_against_reconcile(&request)
        .map_err(|error| ManagedRehostError::unknown(error.to_string()))?;
    Ok(receipt)
}

fn managed_rehost_intent_not_found() -> ManagedRehostError {
    ManagedRehostError::refused(
        "hmux_managed_rehost_intent_not_found",
        "no durable managed rehost intent exists",
    )
}

fn recovery_identity(operation_id: &str, source: &ManagedStopRequest) -> PreparedRecoveryIdentity {
    recovery_identity_parts(operation_id, source.session_id(), source.workspace_id())
}

fn recovery_identity_parts(
    operation_id: &str,
    source_session_id: &str,
    source_workspace_id: &str,
) -> PreparedRecoveryIdentity {
    PreparedRecoveryIdentity {
        recovery_id: format!("{MANAGED_REHOST_RECOVERY_ID_PREFIX}{}", operation_id),
        source_session_id: source_session_id.to_string(),
        source_workspace_id: source_workspace_id.to_string(),
        action: MANAGED_REHOST_RECOVERY_ACTION,
        legacy_request_fingerprint: None,
    }
}

fn continue_state(
    discovery_root: &Path,
    identity: &PreparedRecoveryIdentity,
    state: RecoveryReservationState,
) -> std::result::Result<ManagedRehostReceipt, ManagedRehostError> {
    let mut reservation = match state {
        RecoveryReservationState::Completed(completion) => {
            return replay_completed(discovery_root, identity, completion);
        }
        RecoveryReservationState::Pending(reservation) => reservation,
    };
    let prepared = parse_prepared(&reservation)?;
    validate_prepared_identity(&prepared, identity)?;
    let source_discovery_root = prepared.source_discovery_root(discovery_root)?;
    inject_fault("after_payload_journaled");

    let _source_lock = lock_source(
        &source_discovery_root,
        prepared.request.source().workspace_id(),
        prepared.request.source().session_id(),
    )
    .map_err(map_journal_error)?;

    refuse_if_source_stop_was_refused(&source_discovery_root, &prepared, &mut reservation)?;

    let mut source_checkpointed = reservation
        .operation_checkpoint()
        .and_then(|checkpoint| checkpoint.source_stop_receipt.as_ref())
        .is_some();
    if !source_checkpointed {
        if let Some(receipt) = reconcile_missing_source_stop(&source_discovery_root, &prepared)? {
            checkpoint_source_stop_receipt(&mut reservation, &receipt)?;
            source_checkpointed = true;
        } else if let Some(receipt) =
            reconcile_exited_source_stop(&source_discovery_root, &prepared)?
        {
            checkpoint_source_stop_receipt(&mut reservation, &receipt)?;
            source_checkpointed = true;
        }
    }
    if !source_checkpointed
        && reservation
            .operation_checkpoint()
            .and_then(|checkpoint| checkpoint.replacement_receipt.as_deref())
            .is_some()
    {
        return Err(ManagedRehostError::unknown(
            "managed rehost journal violates source-stop-before-replacement ordering",
        ));
    }

    if !source_checkpointed {
        validate_live_source(&source_discovery_root, &prepared)?;
        validate_socket_owner_recovery(&source_discovery_root, &prepared.request)?;
        ensure_replacement_host_capabilities(&prepared.replacement)?;
        let receipt =
            match stop_managed_provider_at(&source_discovery_root, prepared.request.source()) {
                Ok(receipt) => receipt,
                Err(ManagedStopProviderError::OutcomeUnknown(_))
                    if prepared.request.expected_conversation_id().is_some()
                        || prepared.request.is_fresh_replacement() =>
                {
                    // Fresh launch deliberately has no conversation ID. Its
                    // confirmed, journaled source fence authorizes the same
                    // exact-process retirement when the old Host cannot reply.
                    force_retire_exact_source(&source_discovery_root, &prepared)?
                }
                Err(error) => {
                    refuse_if_source_stop_was_refused(
                        &source_discovery_root,
                        &prepared,
                        &mut reservation,
                    )?;
                    return Err(ManagedRehostError::unknown(error.to_string()));
                }
            };
        validate_source_stop(&receipt, &prepared)?;
        checkpoint_source_stop_receipt(&mut reservation, &receipt)?;
        source_checkpointed = true;
        // The source has crossed the only destructive boundary. Persist its
        // exact stop receipt before any successor process can start so exact
        // resume never has two live provider generations.
        inject_fault("after_source_stop");
    }

    let source_stop = reservation
        .operation_checkpoint()
        .and_then(|checkpoint| checkpoint.source_stop_receipt.as_deref())
        .ok_or_else(|| ManagedRehostError::unknown("managed rehost lost its exact stop receipt"))
        .and_then(|serialized| decode_source_stop(serialized, &prepared))?;
    let completed_replacement =
        preflight_replacement(discovery_root, &prepared.replacement, source_checkpointed)?;

    let replacement = match reservation
        .operation_checkpoint()
        .and_then(|checkpoint| checkpoint.replacement_receipt.as_deref())
    {
        Some(serialized) => decode_replacement_identity(serialized, &prepared, discovery_root)?,
        None => {
            let receipt = match completed_replacement {
                Some(receipt) => receipt,
                None => match launch_managed_with_handoff(
                    prepared.replacement.clone(),
                    prepared.presentation_handoff.clone(),
                ) {
                    Ok(receipt) => receipt,
                    Err(launch_error) => {
                        match managed_create_intent::acquire_with_lineage(
                            discovery_root,
                            &prepared.replacement,
                            managed_create_intent::ManagedCreateIntentLineage::Root,
                        )
                        .map_err(|error| {
                            ManagedRehostError::refused(
                                "hmux_managed_rehost_target_conflict",
                                error.to_string(),
                            )
                        })? {
                            managed_create_intent::ManagedCreateIntent::Completed(receipt) => {
                                receipt
                            }
                            _ => return Err(ManagedRehostError::unknown(launch_error.to_string())),
                        }
                    }
                },
            };
            validate_replacement_identity(&receipt, &prepared, discovery_root)?;
            reservation
                .checkpoint_replacement_receipt(serde_json::to_string(&receipt).map_err(|_| {
                    ManagedRehostError::unknown("replacement receipt is not serializable")
                })?)
                .map_err(ManagedRehostError::unknown)?;
            inject_fault("after_replacement_create");
            receipt
        }
    };
    let target_build_id = replacement_build_id(&prepared);
    let replayed = reservation.was_existing();
    reservation
        .complete(RecoveryCompletion {
            target_session_id: replacement.session_id().to_string(),
            target_workspace_id: replacement.workspace_id().to_string(),
            target_build_id,
            action: MANAGED_REHOST_RECOVERY_ACTION.to_string(),
            outcome: "rehosted".to_string(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .map_err(ManagedRehostError::unknown)?;
    completed_receipt(&prepared, source_stop, replacement, replayed)
}

fn refuse_if_source_stop_was_refused(
    discovery_root: &Path,
    prepared: &PreparedManagedRehost,
    reservation: &mut RecoveryReservation,
) -> std::result::Result<(), ManagedRehostError> {
    let Some(checkpoint) = reservation.operation_checkpoint() else {
        return Ok(());
    };
    if checkpoint.source_stop_receipt.is_some() || checkpoint.replacement_receipt.is_some() {
        return Ok(());
    }
    let source = prepared.request.source();
    let request = ManagedStopReconcileRequest::from_stop_request(source)
        .map_err(|error| ManagedRehostError::unknown(error.to_string()))?;
    if !matches!(
        managed_stop_intent::reconcile(discovery_root, &request),
        Ok(managed_stop_intent::ManagedStopIntent::Refused)
    ) {
        return Ok(());
    }
    reservation
        .complete(RecoveryCompletion {
            target_session_id: source.session_id().to_string(),
            target_workspace_id: source.workspace_id().to_string(),
            target_build_id: "precondition".to_string(),
            action: MANAGED_REHOST_RECOVERY_ACTION.to_string(),
            outcome: "refused_precondition".to_string(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .map_err(ManagedRehostError::unknown)?;
    Err(ManagedRehostError::refused(
        "hmux_managed_rehost_precondition_refused",
        "the Host durably refused this operation before source retirement",
    ))
}

fn prepare(
    discovery_root: &Path,
    source_discovery_root: &Path,
    request: ManagedRehostRequest,
) -> std::result::Result<PreparedManagedRehost, ManagedRehostError> {
    validate_socket_owner_recovery(source_discovery_root, &request)?;
    let source_recipe = managed_create_ledger::managed_rehost_recipe(
        source_discovery_root,
        request.source().workspace_id(),
        request.source().session_id(),
    )
    .map_err(map_recipe_error)?;
    if source_recipe.is_none() && request.replacement().is_none() {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_recipe_missing",
            "source predates canonical managed rehost recipe storage",
        ));
    }
    if source_recipe.is_none() && request.expected_launch_reference().is_some() {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_identity_mismatch",
            "source launch reference cannot be verified for a pre-recipe generation",
        ));
    }
    if let Some(source_recipe) = source_recipe.as_ref() {
        let recipe = source_recipe.rehost();
        if source_recipe.session_id() != request.source().session_id()
            || source_recipe.workspace_id() != request.source().workspace_id()
            || request
                .expected_provider_id()
                .is_some_and(|expected| expected != source_recipe.provider_id())
            || request
                .expected_launch_reference()
                .is_some_and(|expected| recipe.launch_reference() != Some(expected))
        {
            return Err(ManagedRehostError::refused(
                "hmux_managed_rehost_identity_mismatch",
                "source create recipe does not match the asserted identity",
            ));
        }
    }
    let provider_id = request
        .replacement()
        .map(|replacement| replacement.provider_id())
        .or_else(|| {
            source_recipe
                .as_ref()
                .map(ManagedRehostSourceRecipe::provider_id)
        })
        .ok_or_else(|| {
            ManagedRehostError::refused(
                "hmux_managed_rehost_recipe_missing",
                "managed rehost has no replacement provider",
            )
        })?;
    if request
        .expected_provider_id()
        .is_some_and(|expected| expected != provider_id)
        || source_recipe
            .as_ref()
            .is_some_and(|source| source.provider_id() != provider_id)
    {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_identity_mismatch",
            "replacement provider does not match the exact source",
        ));
    }
    let provider_cwd = request
        .replacement()
        .map(|replacement| replacement.provider_cwd())
        .or_else(|| {
            source_recipe
                .as_ref()
                .map(ManagedRehostSourceRecipe::provider_cwd)
        })
        .ok_or_else(|| {
            ManagedRehostError::refused(
                "hmux_managed_rehost_recipe_missing",
                "managed rehost has no replacement cwd",
            )
        })?;
    if !fs::metadata(provider_cwd)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
    {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_recipe_invalid",
            "source provider cwd is unavailable before retirement",
        ));
    }
    let conversation_id = if request.is_fresh_replacement() {
        None
    } else {
        Some(exact_conversation(
            source_discovery_root,
            &request,
            provider_id,
        )?)
    };
    let (
        permission_mode,
        recipe_initial_rows,
        recipe_initial_columns,
        terminal_environment,
        provider_state_environment,
        replacement_recipe,
    ) = match request.replacement() {
        Some(replacement) => (
            replacement.permission_mode(),
            replacement.initial_rows(),
            replacement.initial_columns(),
            replacement.terminal_environment().clone(),
            replacement.provider_state_environment().clone(),
            replacement.rehost().clone(),
        ),
        None => {
            let source = source_recipe.as_ref().ok_or_else(|| {
                ManagedRehostError::refused(
                    "hmux_managed_rehost_recipe_missing",
                    "managed rehost source recipe is missing",
                )
            })?;
            (
                source.permission_mode(),
                source.initial_rows(),
                source.initial_columns(),
                source.terminal_environment().clone(),
                source.provider_state_environment().clone(),
                source.rehost().clone(),
            )
        }
    };
    let prepared_presentation = prepare_presentation_checkpoint(source_discovery_root, &request);
    let (initial_rows, initial_columns) = prepared_presentation
        .as_ref()
        .map(|presentation| (presentation.rows(), presentation.columns()))
        .unwrap_or((recipe_initial_rows, recipe_initial_columns));
    let replacement = replacement_request(
        &request,
        ReplacementLaunch {
            provider_id,
            permission_mode,
            provider_cwd,
            initial_rows,
            initial_columns,
            terminal_environment,
            recipe: &replacement_recipe,
            provider_state_environment,
            conversation_id: conversation_id.as_deref(),
            fresh_command: request
                .replacement()
                .and_then(|replacement| replacement.launch().fresh_command()),
            terminal_default_colors: source_recipe
                .as_ref()
                .and_then(ManagedRehostSourceRecipe::terminal_default_colors),
        },
    )?;
    let presentation_handoff = prepared_presentation.as_ref().and_then(|presentation| {
        write_presentation_handoff(source_discovery_root, &request, presentation)
    });
    Ok(PreparedManagedRehost {
        request,
        replacement,
        source_discovery_root: (source_discovery_root != discovery_root)
            .then(|| source_discovery_root.to_path_buf()),
        conversation_id,
        launch_reference: replacement_recipe.launch_reference().map(str::to_string),
        presentation_handoff,
    })
}

fn validate_socket_owner_recovery(
    discovery_root: &Path,
    request: &ManagedRehostRequest,
) -> std::result::Result<(), ManagedRehostError> {
    if !request.requires_socket_owner_absent() {
        return Ok(());
    }
    let root = DiscoveryRoot::open(discovery_root).map_err(map_discovery_error)?;
    let found = root
        .find_manifest_by_session(
            request.source().workspace_id(),
            request.source().session_id(),
        )
        .map_err(map_discovery_error)?;
    validate_managed_stop_fence(request.source(), &found.manifest).map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_source_changed", error.to_string())
    })?;
    let session = LocalSession::from_manifest(found.manifest).map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_source_changed", error.to_string())
    })?;
    let descriptor = session.descriptor();
    // An exact source that exited after admission follows existing abandoned
    // source reconciliation. A live source needs fresh native socket evidence;
    // no frontend timeout, health flag or elapsed duration can substitute.
    if probe_local_process_generation(&descriptor.host_process).ok()
        == Some(LocalProcessGenerationStatus::Absent)
        || hmux_client::local_host_socket_owner_absent(descriptor)
    {
        return Ok(());
    }
    Err(ManagedRehostError::refused(
        "managed_rehost_socket_owner_absence_required",
        "the exact Host still owns a socket, or socket ownership could not be proven absent",
    ))
}

fn ensure_replacement_host_capabilities(
    replacement: &ManagedCreateRequest,
) -> std::result::Result<(), ManagedRehostError> {
    managed_create_failure::ensure_required_capabilities(
        replacement,
        &effective_managed_host_capabilities(),
    )
    .map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_request_invalid", error.to_string())
    })
}

impl PreparedManagedRehost {
    fn source_discovery_root(
        &self,
        discovery_root: &Path,
    ) -> std::result::Result<PathBuf, ManagedRehostError> {
        let source = self
            .source_discovery_root
            .as_deref()
            .unwrap_or(discovery_root);
        if !source.is_absolute() {
            return Err(ManagedRehostError::unknown(
                "journaled managed rehost source discovery root is invalid",
            ));
        }
        Ok(source.to_path_buf())
    }
}

fn prepare_presentation_checkpoint(
    discovery_root: &Path,
    request: &ManagedRehostRequest,
) -> Option<PresentationCheckpoint> {
    let source = request_presentation_source(request).ok()?;
    let root = DiscoveryRoot::open(discovery_root).ok()?;
    let discovery = root.open_session(source.discovery_key().ok()?).ok()?;
    discovery.read_presentation_checkpoint(&source).ok()?
}

fn write_presentation_handoff(
    discovery_root: &Path,
    request: &ManagedRehostRequest,
    presentation: &PresentationCheckpoint,
) -> Option<PresentationCheckpointHandoff> {
    #[cfg(not(feature = "terminal-state-stream"))]
    let _ = request;
    let root = DiscoveryRoot::open(discovery_root).ok()?;
    let discovery = root
        .open_session(presentation.source().discovery_key().ok()?)
        .ok()?;
    #[cfg(feature = "terminal-state-stream")]
    let handoff = discovery.write_rehost_presentation_handoff(
        presentation.source(),
        presentation,
        &format!("rehost-v1-{}", replacement_target_id(request)),
        &TerminalReplayLimits {
            max_snapshot_bytes: FrameLimits::default().max_snapshot_bytes,
            ..TerminalReplayLimits::default()
        },
    );
    #[cfg(not(feature = "terminal-state-stream"))]
    let handoff = discovery.write_presentation_handoff(presentation.source(), presentation);
    handoff.ok()
}

fn request_presentation_source(
    request: &ManagedRehostRequest,
) -> std::result::Result<PresentationCheckpointSource, ManagedRehostError> {
    let predecessor = replacement_presentation_predecessor(request)?;
    PresentationCheckpointSource::new(
        request.source().workspace_id(),
        predecessor.session_id(),
        predecessor.runner_principal(),
        predecessor.runner_instance(),
        predecessor.channel_epoch(),
        predecessor.host_instance_id(),
        predecessor.terminal_epoch(),
    )
    .map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_source_changed", error.to_string())
    })
}

fn starting_source_evidence(
    discovery_root: &Path,
    source: &ManagedStopRequest,
    provider_id: &str,
    expected_conversation_id: Option<&str>,
) -> std::result::Result<
    (
        managed_create_ledger::ManagedStartingGeneration,
        StartingManifest,
    ),
    ManagedRehostError,
> {
    let generation = managed_create_ledger::starting_generation(
        discovery_root,
        source.workspace_id(),
        source.session_id(),
    )
    .map_err(|error| ManagedRehostError::refused("hmux_managed_rehost_source_changed", error))?
    .ok_or_else(|| {
        ManagedRehostError::refused(
            "hmux_managed_rehost_source_changed",
            "Starting source has no exact launch-reconciliation evidence",
        )
    })?;
    let fence = generation.generation_fence();
    if source.expected_runner_principal() != Some(fence.runner_principal())
        || source.expected_runner_instance() != Some(fence.runner_instance())
        || source.expected_channel_epoch() != Some(fence.channel_epoch())
        || source.expected_host_instance_id() != Some(fence.host_instance_id())
        || source.expected_terminal_epoch() != Some(fence.terminal_epoch())
    {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_identity_mismatch",
            "Starting source request does not match its exact launch generation",
        ));
    }
    let conversation = generation.conversation_identity().ok_or_else(|| {
        ManagedRehostError::refused(
            "hmux_managed_rehost_conversation_required",
            "Starting source has no exact launch conversation identity",
        )
    })?;
    if conversation.provider_id() != provider_id
        || expected_conversation_id != Some(conversation.conversation_id())
    {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_identity_mismatch",
            "Starting source conversation does not match its exact launch identity",
        ));
    }
    let key = DiscoveryKey::new(
        source.workspace_id(),
        source.session_id(),
        fence.runner_instance(),
        fence.channel_epoch(),
    )
    .map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_source_changed", error.to_string())
    })?;
    let root = DiscoveryRoot::open(discovery_root).map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_unavailable", error.to_string())
    })?;
    let discovery = root.open_session(key).map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_source_changed", error.to_string())
    })?;
    let manifest = discovery.read_manifest().map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_source_changed", error.to_string())
    })?;
    let DiscoveryManifest::Starting(starting) = manifest else {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_source_changed",
            "source is no longer the recorded Starting generation",
        ));
    };
    let common = &starting.common;
    if common.session_class != SessionClass::Managed
        || common.lifetime.workspace_id != source.workspace_id()
        || common.lifetime.session_id != source.session_id()
        || common.lifetime.runner_principal != fence.runner_principal()
        || common.lifetime.runner_instance != fence.runner_instance()
        || common.lifetime.channel_epoch != fence.channel_epoch()
        || common.host_instance_id != fence.host_instance_id()
        || common.host_process.process_id != generation.host_process().process_id
        || common.host_process.start_marker != generation.host_process().start_marker
        || common.provider_id != provider_id
        || common.claim_linkage.kickoff_action_id.as_deref() != Some(generation.idempotency_key())
    {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_identity_mismatch",
            "Starting manifest does not match its exact create-ledger generation",
        ));
    }
    Ok((generation, starting))
}

fn exact_conversation(
    discovery_root: &Path,
    request: &ManagedRehostRequest,
    provider_id: &str,
) -> std::result::Result<String, ManagedRehostError> {
    let root = DiscoveryRoot::open(discovery_root).map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_unavailable", error.to_string())
    })?;
    let found = match root.find_manifest_by_session(
        request.source().workspace_id(),
        request.source().session_id(),
    ) {
        Ok(found) => found,
        Err(hmux_host::local_discovery::DiscoveryError::StaleDiscovery {
            reason: StaleDiscoveryReason::NotReady,
            ..
        }) => {
            let (generation, _) = starting_source_evidence(
                discovery_root,
                request.source(),
                provider_id,
                request.expected_conversation_id(),
            )?;
            return Ok(generation
                .conversation_identity()
                .expect("Starting evidence validation requires conversation identity")
                .conversation_id()
                .to_string());
        }
        Err(hmux_host::local_discovery::DiscoveryError::SessionNotFound)
        | Err(hmux_host::local_discovery::DiscoveryError::StaleDiscovery {
            reason: StaleDiscoveryReason::MissingManifest,
            ..
        }) => {
            validate_missing_source_resume_authority(discovery_root, request, provider_id)?;
            return explicit_replacement_conversation(request);
        }
        Err(error) => {
            return Err(ManagedRehostError::refused(
                "hmux_managed_rehost_source_changed",
                error.to_string(),
            ));
        }
    };
    validate_managed_stop_fence(request.source(), &found.manifest).map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_source_changed", error.to_string())
    })?;
    if found.manifest.common().provider_id != provider_id {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_identity_mismatch",
            "source provider differs from its canonical create recipe",
        ));
    }
    if let DiscoveryManifest::Exited(exited) = &found.manifest {
        // Discovery validates this Host projection against the tombstone's full
        // generation, provider and final output sequence. Keep explicit callers
        // fenced to that same conversation even after the Host has gone away.
        if let Some(identity) = &exited.tombstone.provider_conversation_identity {
            if request
                .expected_conversation_id()
                .is_some_and(|expected| expected != identity.conversation_id)
            {
                return Err(ManagedRehostError::refused(
                    "hmux_managed_rehost_identity_mismatch",
                    "expected conversation differs from the exact exited source",
                ));
            }
            return Ok(identity.conversation_id.clone());
        }
        // Older Hosts did not retain identity. Preserve their explicit recovery
        // contract rather than inferring from a launch seed or nearby transcript.
        return explicit_replacement_conversation(request);
    }
    if request.expected_conversation_id().is_some() {
        return explicit_replacement_conversation(request);
    }
    let ready = match found.manifest {
        DiscoveryManifest::Ready(ready) => ready,
        DiscoveryManifest::Exited(_) => unreachable!("exited source handled above"),
        DiscoveryManifest::Starting(_) => {
            return Err(ManagedRehostError::refused(
                "hmux_managed_rehost_source_changed",
                "managed rehost source is still starting",
            ));
        }
    };
    let session =
        LocalSession::from_manifest(DiscoveryManifest::Ready(ready)).map_err(|error| {
            ManagedRehostError::refused("hmux_managed_rehost_unavailable", error.to_string())
        })?;
    #[cfg(feature = "terminal-state-stream")]
    {
        let connection = match session.connect_with_options(
            TerminalSurfaceAttachment::connection_options(TerminalSurfaceAccess::ReadOnly, None)
                .with_handshake_timeout(MANAGED_REHOST_HANDSHAKE_TIMEOUT)
                .with_handshake_completion_timeout(MANAGED_REHOST_HANDSHAKE_TIMEOUT),
        ) {
            Ok(connection) => connection,
            Err(error) => {
                return request
                    .expected_conversation_id()
                    .map(str::to_string)
                    .ok_or_else(|| {
                        ManagedRehostError::refused(
                            "hmux_managed_rehost_unavailable",
                            format!("source conversation handshake failed: {error}"),
                        )
                    });
            }
        };
        let surface = TerminalSurfaceAttachment::from_connection(connection).map_err(|error| {
            ManagedRehostError::refused(
                "hmux_managed_rehost_unavailable",
                format!("source conversation projection failed: {error}"),
            )
        })?;
        let identity = surface.initial_provider_conversation_identity().cloned();
        let _ = surface.detach();
        let Some(identity) = identity else {
            return explicit_replacement_conversation(request);
        };
        let source = request.source();
        if identity.session_id != source.session_id()
            || identity.workspace_id != source.workspace_id()
            || source.expected_runner_principal() != Some(identity.runner_principal.as_str())
            || source.expected_runner_instance() != Some(identity.runner_instance.as_str())
            || identity.channel_epoch.parse::<u64>().ok() != source.expected_channel_epoch()
            || source.expected_host_instance_id() != Some(identity.host_instance_id.as_str())
            || source.expected_terminal_epoch() != Some(identity.terminal_epoch.as_str())
            || identity.provider_id != provider_id
        {
            return Err(ManagedRehostError::refused(
                "hmux_managed_rehost_identity_mismatch",
                "Host conversation projection does not match the exact source fence",
            ));
        }
        Ok(identity.conversation_id)
    }

    #[cfg(not(feature = "terminal-state-stream"))]
    let connection = match session.connect_with_options(
        hmux_client::ConnectionOptions::new(hmux_client::LocalAttachRole::Observer, None)
            .with_optional_capabilities(&[
                AGENT_RUNTIME_STATE_CAPABILITY,
                PROVIDER_CONVERSATION_IDENTITY_CAPABILITY,
            ])
            .with_handshake_timeout(MANAGED_REHOST_HANDSHAKE_TIMEOUT)
            .with_handshake_completion_timeout(MANAGED_REHOST_HANDSHAKE_TIMEOUT),
    ) {
        Ok(connection) => connection,
        Err(error) => {
            return request
                .expected_conversation_id()
                .map(str::to_string)
                .ok_or_else(|| {
                    ManagedRehostError::refused(
                        "hmux_managed_rehost_unavailable",
                        format!("source conversation handshake failed: {error}"),
                    )
                });
        }
    };
    #[cfg(not(feature = "terminal-state-stream"))]
    let snapshot = connection
        .require_initial_snapshot()
        .map_err(|error| {
            ManagedRehostError::refused("hmux_managed_rehost_unavailable", error.to_string())
        })?
        .clone();
    #[cfg(not(feature = "terminal-state-stream"))]
    drop(connection);
    #[cfg(not(feature = "terminal-state-stream"))]
    let identity = match snapshot.provider_conversation_identity {
        Some(identity) => identity,
        None => return explicit_replacement_conversation(request),
    };
    #[cfg(not(feature = "terminal-state-stream"))]
    let source = request.source();
    #[cfg(not(feature = "terminal-state-stream"))]
    let fence = &identity.fence;
    #[cfg(not(feature = "terminal-state-stream"))]
    if fence.session_id != source.session_id()
        || fence.workspace_id != source.workspace_id()
        || source.expected_runner_principal() != Some(fence.runner_principal.as_str())
        || source.expected_runner_instance() != Some(fence.runner_instance.as_str())
        || source.expected_channel_epoch() != Some(fence.channel_epoch)
        || source.expected_host_instance_id() != Some(fence.host_instance_id.as_str())
        || source.expected_terminal_epoch() != Some(fence.terminal_epoch.as_str())
        || identity.provider_id != provider_id
    {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_identity_mismatch",
            "Host conversation projection does not match the exact source fence",
        ));
    }
    #[cfg(not(feature = "terminal-state-stream"))]
    Ok(identity.conversation_id)
}

fn explicit_replacement_conversation(
    request: &ManagedRehostRequest,
) -> std::result::Result<String, ManagedRehostError> {
    request
        .expected_conversation_id()
        .map(str::to_string)
        .ok_or_else(|| {
            ManagedRehostError::refused(
                "hmux_managed_rehost_conversation_required",
                "managed rehost has no exact conversation identity",
            )
        })
}

struct ReplacementLaunch<'a> {
    provider_id: &'a str,
    permission_mode: PermissionMode,
    provider_cwd: &'a Path,
    initial_rows: u16,
    initial_columns: u16,
    terminal_environment: TerminalEnvironment,
    recipe: &'a ManagedRehostRecipe,
    provider_state_environment: ProviderStateEnvironment,
    conversation_id: Option<&'a str>,
    fresh_command: Option<&'a [String]>,
    terminal_default_colors: Option<hmux_runtime_contract::TerminalDefaultColors>,
}

fn replacement_required_stop_version() -> u16 {
    hmux_runtime_contract::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION
}

fn replacement_request(
    request: &ManagedRehostRequest,
    launch: ReplacementLaunch<'_>,
) -> std::result::Result<ManagedCreateRequest, ManagedRehostError> {
    let target_session_id = replacement_target_id(request);
    let idempotency_key = target_session_id.clone();
    let predecessor = replacement_presentation_predecessor(request)?;
    let command =
        match (launch.fresh_command, launch.conversation_id) {
            (Some(command), None) => command.to_vec(),
            (None, Some(conversation_id)) => launch
                .recipe
                .render_command(conversation_id)
                .map_err(|error| {
                    ManagedRehostError::refused(
                        "hmux_managed_rehost_recipe_invalid",
                        error.to_string(),
                    )
                })?,
            _ => {
                return Err(ManagedRehostError::refused(
                    "hmux_managed_rehost_request_invalid",
                    "managed replacement launch mode is inconsistent",
                ));
            }
        };
    let required_stop_version = replacement_required_stop_version();
    let replacement = ManagedCreateRequest::new(
        idempotency_key,
        target_session_id,
        request.source().workspace_id(),
        launch.provider_id,
        launch.permission_mode,
        launch.provider_cwd,
        command,
        launch.initial_rows,
        launch.initial_columns,
    )
    .and_then(|request| request.with_required_managed_stop_request_version(required_stop_version))
    .and_then(|request| request.with_terminal_environment(launch.terminal_environment))
    .and_then(|request| request.with_presentation_predecessor(predecessor))
    .and_then(|request| request.with_managed_rehost_recipe(launch.recipe.clone()))
    .and_then(|request| request.with_terminal_default_colors_option(launch.terminal_default_colors))
    .map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_recipe_invalid", error.to_string())
    })?;
    let replacement = match launch.conversation_id {
        Some(conversation_id) => replacement
            .with_conversation_identity(
                ProviderConversationIdentitySeed::new(launch.provider_id, conversation_id)
                    .map_err(|error| {
                        ManagedRehostError::refused(
                            "hmux_managed_rehost_request_invalid",
                            error.to_string(),
                        )
                    })?,
            )
            .map_err(|error| {
                ManagedRehostError::refused("hmux_managed_rehost_recipe_invalid", error.to_string())
            })?,
        None => replacement,
    };
    if launch.provider_state_environment.is_empty() {
        Ok(replacement)
    } else {
        replacement
            .with_provider_state_environment(launch.provider_state_environment)
            .map_err(|error| {
                ManagedRehostError::refused("hmux_managed_rehost_recipe_invalid", error.to_string())
            })
    }
}

fn replacement_presentation_predecessor(
    request: &ManagedRehostRequest,
) -> std::result::Result<PresentationCheckpointPredecessor, ManagedRehostError> {
    PresentationCheckpointPredecessor::new(
        request.source().session_id(),
        request
            .source()
            .expected_runner_principal()
            .unwrap_or_default(),
        request
            .source()
            .expected_runner_instance()
            .unwrap_or_default(),
        request
            .source()
            .expected_channel_epoch()
            .unwrap_or_default(),
        request
            .source()
            .expected_host_instance_id()
            .unwrap_or_default(),
        request
            .source()
            .expected_terminal_epoch()
            .unwrap_or_default(),
    )
    .map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_request_invalid", error.to_string())
    })
}

fn replacement_target_id(request: &ManagedRehostRequest) -> String {
    let mut digest = Sha256::new();
    digest.update(b"hmux_managed_rehost_target_v1");
    digest.update(request.operation_id().as_bytes());
    digest.update(request.source().workspace_id().as_bytes());
    digest.update(request.source().session_id().as_bytes());
    let digest = format!("{:x}", digest.finalize());
    format!("managed_rehost_{}", &digest[..32])
}

fn parse_prepared(
    reservation: &RecoveryReservation,
) -> std::result::Result<PreparedManagedRehost, ManagedRehostError> {
    let serialized = reservation
        .operation_checkpoint()
        .map(|checkpoint| checkpoint.canonical_payload.as_str())
        .ok_or_else(|| ManagedRehostError::unknown("managed rehost journal lost its payload"))?;
    serde_json::from_str(serialized)
        .map_err(|_| ManagedRehostError::unknown("managed rehost journal payload is malformed"))
}

fn validate_prepared_identity(
    prepared: &PreparedManagedRehost,
    identity: &PreparedRecoveryIdentity,
) -> std::result::Result<(), ManagedRehostError> {
    prepared
        .request
        .validate()
        .map_err(|error| ManagedRehostError::unknown(error.to_string()))?;
    prepared
        .replacement
        .validate()
        .map_err(|error| ManagedRehostError::unknown(error.to_string()))?;
    let canonical = recovery_identity(prepared.request.operation_id(), prepared.request.source());
    if canonical.recovery_id != identity.recovery_id
        || canonical.source_session_id != identity.source_session_id
        || canonical.source_workspace_id != identity.source_workspace_id
        || canonical.action != identity.action
        || prepared.request.source().stop_id()
            != format!("managed_rehost_stop_{}", prepared.request.operation_id())
    {
        return Err(ManagedRehostError::unknown(
            "managed rehost journal payload changed its operation identity",
        ));
    }
    if prepared.request.is_fresh_replacement() != prepared.conversation_id.is_none() {
        return Err(ManagedRehostError::unknown(
            "managed rehost journal payload changed its launch identity",
        ));
    }
    Ok(())
}

fn validate_live_source(
    discovery_root: &Path,
    prepared: &PreparedManagedRehost,
) -> std::result::Result<(), ManagedRehostError> {
    validated_source_generation(discovery_root, prepared).map(|_| ())
}

fn source_discovery_is_absent(
    discovery_root: &Path,
    source: &ManagedStopRequest,
) -> std::result::Result<bool, ManagedRehostError> {
    let root = DiscoveryRoot::open(discovery_root).map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_unavailable", error.to_string())
    })?;
    match root.find_manifest_by_session(source.workspace_id(), source.session_id()) {
        Ok(_) => Ok(false),
        Err(hmux_host::local_discovery::DiscoveryError::SessionNotFound)
        | Err(hmux_host::local_discovery::DiscoveryError::StaleDiscovery {
            reason: StaleDiscoveryReason::MissingManifest,
            ..
        }) => Ok(true),
        Err(hmux_host::local_discovery::DiscoveryError::StaleDiscovery { .. }) => Ok(false),
        Err(error) => Err(ManagedRehostError::refused(
            "hmux_managed_rehost_unavailable",
            error.to_string(),
        )),
    }
}

/// Exact Resume is independently launchable after discovery loss. The
/// replacement packet supplies cwd/provider/credential-root authority, while
/// the complete source fence still has to match any completed create ledger
/// that survived. A launch-released generation remains fail-closed because it
/// retains process evidence whose outcome must first be reconciled.
fn validate_missing_source_resume_authority(
    discovery_root: &Path,
    request: &ManagedRehostRequest,
    provider_id: &str,
) -> std::result::Result<(), ManagedRehostError> {
    if request.is_fresh_replacement()
        || request.replacement().is_none()
        || request.expected_conversation_id().is_none()
    {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_conversation_required",
            "missing source discovery can only launch an explicit exact conversation replacement",
        ));
    }
    if managed_create_ledger::starting_generation(
        discovery_root,
        request.source().workspace_id(),
        request.source().session_id(),
    )
    .map_err(|error| ManagedRehostError::refused("hmux_managed_rehost_unavailable", error))?
    .is_some()
    {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_source_changed",
            "missing source manifest still has an unreconciled launch generation",
        ));
    }
    let Some(receipt) = managed_create_ledger::completed_create_receipt(
        discovery_root,
        request.source().workspace_id(),
        request.source().session_id(),
    )
    .map_err(|error| ManagedRehostError::refused("hmux_managed_rehost_unavailable", error))?
    else {
        return Ok(());
    };
    let fence = receipt.generation_fence().ok_or_else(|| {
        ManagedRehostError::refused(
            "hmux_managed_rehost_identity_mismatch",
            "missing source create receipt has no complete generation fence",
        )
    })?;
    let source = request.source();
    if receipt.provider_id() != provider_id
        || !fence.matches_generation(
            source.expected_runner_principal().unwrap_or_default(),
            source.expected_runner_instance().unwrap_or_default(),
            &source
                .expected_channel_epoch()
                .unwrap_or_default()
                .to_string(),
            source.expected_host_instance_id().unwrap_or_default(),
            source.expected_terminal_epoch().unwrap_or_default(),
        )
    {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_identity_mismatch",
            "missing source recovery does not match its completed create generation",
        ));
    }
    Ok(())
}

fn reconcile_missing_source_stop(
    discovery_root: &Path,
    prepared: &PreparedManagedRehost,
) -> std::result::Result<Option<ManagedStopReceipt>, ManagedRehostError> {
    if !source_discovery_is_absent(discovery_root, prepared.request.source())? {
        return Ok(None);
    }
    validate_missing_source_resume_authority(
        discovery_root,
        &prepared.request,
        prepared.replacement.provider_id(),
    )?;
    let receipt = ManagedStopReceipt::from_request(
        prepared.request.source(),
        ManagedStopOutcome::AlreadyExited,
        "missing_discovery_generation",
    )
    .map_err(|error| ManagedRehostError::unknown(error.to_string()))?;
    managed_create_ledger::checkpoint_retirement_exact(discovery_root, &receipt)
        .and_then(|_| managed_create_ledger::finalize_retirement_exact(discovery_root, &receipt))
        .map_err(|error| {
            ManagedRehostError::refused("hmux_managed_rehost_source_changed", error)
        })?;
    validate_source_stop(&receipt, prepared)?;
    Ok(Some(receipt))
}

fn validated_source_generation(
    discovery_root: &Path,
    prepared: &PreparedManagedRehost,
) -> std::result::Result<DiscoveryManifest, ManagedRehostError> {
    let root = DiscoveryRoot::open(discovery_root).map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_unavailable", error.to_string())
    })?;
    let found = match root.find_manifest_by_session(
        prepared.request.source().workspace_id(),
        prepared.request.source().session_id(),
    ) {
        Ok(found) => found,
        Err(hmux_host::local_discovery::DiscoveryError::StaleDiscovery {
            reason: StaleDiscoveryReason::NotReady,
            ..
        }) => {
            let conversation_id = prepared.conversation_id.as_deref().ok_or_else(|| {
                ManagedRehostError::refused(
                    "hmux_managed_rehost_source_changed",
                    "fresh replacement requires a ready or exited source generation",
                )
            })?;
            let (_, starting) = starting_source_evidence(
                discovery_root,
                prepared.request.source(),
                prepared.replacement.provider_id(),
                Some(conversation_id),
            )?;
            return Ok(DiscoveryManifest::Starting(starting));
        }
        Err(error) => {
            return Err(ManagedRehostError::refused(
                "hmux_managed_rehost_source_changed",
                error.to_string(),
            ));
        }
    };
    validate_managed_stop_fence(prepared.request.source(), &found.manifest).map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_source_changed", error.to_string())
    })?;
    if found.manifest.common().provider_id != prepared.replacement.provider_id() {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_identity_mismatch",
            "source provider changed before retirement",
        ));
    }
    Ok(found.manifest)
}

fn reconcile_exited_source_stop(
    discovery_root: &Path,
    prepared: &PreparedManagedRehost,
) -> std::result::Result<Option<ManagedStopReceipt>, ManagedRehostError> {
    match validated_source_generation(discovery_root, prepared)? {
        DiscoveryManifest::Ready(ready) => {
            return match managed_abandonment::acquire(
                discovery_root,
                prepared.request.source(),
                &ready,
            )
            .map_err(map_abandoned_ready_error)?
            {
                managed_abandonment::AbandonedReadyAcquisition::Acquired(abandoned) => {
                    reconcile_abandoned_ready_source_stop(discovery_root, prepared, *abandoned)
                        .map(Some)
                }
                managed_abandonment::AbandonedReadyAcquisition::HostLifetimeOwned
                | managed_abandonment::AbandonedReadyAcquisition::AlreadyExited => Ok(None),
            };
        }
        DiscoveryManifest::Starting(_) => {
            return reconcile_abandoned_starting_source_stop(discovery_root, prepared).map(Some);
        }
        DiscoveryManifest::Exited(_) => {}
    }
    let reconcile = ManagedStopReconcileRequest::from_stop_request(prepared.request.source())
        .map_err(|error| ManagedRehostError::unknown(error.to_string()))?;
    let intent = match managed_stop_intent::reconcile(discovery_root, &reconcile) {
        Ok(intent) => intent,
        Err(error) if error.not_found() => return Ok(None),
        Err(error) => return Err(ManagedRehostError::unknown(error.to_string())),
    };
    let receipt = match intent {
        managed_stop_intent::ManagedStopIntent::Completed(receipt) => {
            finalize_completed_managed_stop(discovery_root, &receipt)
                .map_err(|error| ManagedRehostError::unknown(error.to_string()))?;
            receipt
        }
        managed_stop_intent::ManagedStopIntent::Checkpointed { receipt, intent } => {
            finalize_checkpointed_managed_stop(discovery_root, receipt, intent)
                .map_err(|error| ManagedRehostError::unknown(error.to_string()))?
        }
        managed_stop_intent::ManagedStopIntent::Resume { request, intent } => {
            continue_reserved_managed_stop(discovery_root, &request, intent, false)
                .map_err(|error| ManagedRehostError::unknown(error.to_string()))?
        }
        managed_stop_intent::ManagedStopIntent::Refused => {
            return Err(ManagedRehostError::unknown(
                "managed rehost source stop was durably refused",
            ));
        }
        managed_stop_intent::ManagedStopIntent::Pending(_) => {
            return Err(ManagedRehostError::unknown(
                "managed rehost source stop reconciliation created a fresh intent",
            ));
        }
    };
    validate_source_stop(&receipt, prepared)?;
    Ok(Some(receipt))
}

fn force_retire_exact_source(
    discovery_root: &Path,
    prepared: &PreparedManagedRehost,
) -> std::result::Result<ManagedStopReceipt, ManagedRehostError> {
    if prepared.request.source().expected_quiescence().is_some()
        || prepared.request.source().expected_conversation().is_some()
    {
        return Err(ManagedRehostError::unknown(
            "guarded source retirement requires the Host's admission receipt",
        ));
    }
    let ready = match validated_source_generation(discovery_root, prepared)? {
        DiscoveryManifest::Exited(exited) => {
            let host_process = ProcessDescriptor {
                process_id: exited.common.host_process.process_id,
                start_marker: exited.common.host_process.start_marker.clone(),
            };
            let provider_process = ProcessDescriptor {
                process_id: exited.tombstone.provider_process.process_id,
                start_marker: exited.tombstone.provider_process.start_marker.clone(),
            };
            terminate_exact_source_session("Host", &host_process)?;
            let retirement_deadline = Instant::now() + MANAGED_REHOST_FORCED_EXIT_TIMEOUT;
            wait_for_exact_source_absence("Host", &host_process, retirement_deadline)?;
            wait_for_exact_source_absence("provider", &provider_process, retirement_deadline)?;
            return stop_managed_provider_at(discovery_root, prepared.request.source())
                .map_err(|error| ManagedRehostError::unknown(error.to_string()));
        }
        DiscoveryManifest::Ready(ready) => ready,
        DiscoveryManifest::Starting(_) => {
            return Err(ManagedRehostError::unknown(
                "exact rehost source returned to Starting after stop admission",
            ));
        }
    };
    let provider_process = ProcessDescriptor {
        process_id: ready.provider_process.process_id,
        start_marker: ready.provider_process.start_marker.clone(),
    };
    terminate_exact_source_session("provider", &provider_process)?;

    let host_process = ProcessDescriptor {
        process_id: ready.common.host_process.process_id,
        start_marker: ready.common.host_process.start_marker.clone(),
    };
    terminate_exact_source_session("Host", &host_process)?;
    let retirement_deadline = Instant::now() + MANAGED_REHOST_FORCED_EXIT_TIMEOUT;
    wait_for_exact_source_absence("Host", &host_process, retirement_deadline)?;
    wait_for_exact_source_absence("provider", &provider_process, retirement_deadline)?;
    require_absent_source_process_session(&provider_process)?;
    if matches!(
        validated_source_generation(discovery_root, prepared)?,
        DiscoveryManifest::Exited(_)
    ) {
        return stop_managed_provider_at(discovery_root, prepared.request.source())
            .map_err(|error| ManagedRehostError::unknown(error.to_string()));
    }
    let abandoned = match managed_abandonment::acquire_until(
        discovery_root,
        prepared.request.source(),
        &ready,
        retirement_deadline,
    )
    .map_err(map_abandoned_ready_error)?
    {
        managed_abandonment::AbandonedReadyAcquisition::Acquired(abandoned) => *abandoned,
        managed_abandonment::AbandonedReadyAcquisition::HostLifetimeOwned => {
            return Err(ManagedRehostError::unknown(
                "retired exact source still owns its Host lifetime",
            ));
        }
        managed_abandonment::AbandonedReadyAcquisition::AlreadyExited => {
            return stop_managed_provider_at(discovery_root, prepared.request.source())
                .map_err(|error| ManagedRehostError::unknown(error.to_string()));
        }
    };
    reconcile_abandoned_ready_source_stop(discovery_root, prepared, abandoned)
}

fn terminate_exact_source_session(
    label: &str,
    process: &ProcessDescriptor,
) -> std::result::Result<(), ManagedRehostError> {
    match probe_local_process_generation(process) {
        Ok(LocalProcessGenerationStatus::Absent) => return Ok(()),
        Ok(LocalProcessGenerationStatus::Live) => {}
        Err(error) => {
            return Err(ManagedRehostError::unknown(format!(
                "exact source {label} generation is unobservable: {error}"
            )));
        }
    }
    let session = match OwnedProcessSession::new(process.process_id) {
        Ok(session) => session,
        Err(_error)
            if matches!(
                probe_local_process_generation(process),
                Ok(LocalProcessGenerationStatus::Absent)
            ) =>
        {
            return Ok(());
        }
        Err(error) => {
            return Err(ManagedRehostError::unknown(format!(
                "exact source {label} session cannot be acquired: {error}"
            )));
        }
    };
    if !matches!(
        probe_local_process_generation(process),
        Ok(LocalProcessGenerationStatus::Live)
    ) {
        return require_absent_source_process(label, process);
    }
    let termination = session.terminate(None).map_err(|error| {
        ManagedRehostError::unknown(format!(
            "exact source {label} session termination failed: {error}"
        ))
    })?;
    if !termination.complete {
        return Err(ManagedRehostError::unknown(format!(
            "exact source {label} session termination was incomplete"
        )));
    }
    Ok(())
}

fn wait_for_exact_source_absence(
    label: &str,
    process: &ProcessDescriptor,
    deadline: Instant,
) -> std::result::Result<(), ManagedRehostError> {
    loop {
        match probe_local_process_generation(process) {
            Ok(LocalProcessGenerationStatus::Absent) => return Ok(()),
            Ok(LocalProcessGenerationStatus::Live) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(LocalProcessGenerationStatus::Live) => {
                return Err(ManagedRehostError::unknown(format!(
                    "exact source {label} generation did not exit"
                )));
            }
            Err(error) => {
                return Err(ManagedRehostError::unknown(format!(
                    "exact source {label} absence is unproven: {error}"
                )));
            }
        }
    }
}

fn reconcile_abandoned_ready_source_stop(
    discovery_root: &Path,
    prepared: &PreparedManagedRehost,
    abandoned: managed_abandonment::AbandonedReadyGeneration,
) -> std::result::Result<ManagedStopReceipt, ManagedRehostError> {
    let source = prepared.request.source();
    managed_abandonment::reserve_stop_intent(discovery_root, source)
        .map_err(ManagedRehostError::unknown)?;
    abandoned
        .publish_exited()
        .map_err(map_abandoned_ready_error)?;

    let receipt = stop_managed_provider_at(discovery_root, source)
        .map_err(|error| ManagedRehostError::unknown(error.to_string()))?;
    validate_source_stop(&receipt, prepared)?;
    Ok(receipt)
}

fn map_abandoned_ready_error(
    error: managed_abandonment::AbandonedReadyError,
) -> ManagedRehostError {
    match error {
        managed_abandonment::AbandonedReadyError::SourceChanged(message) => {
            ManagedRehostError::refused("hmux_managed_rehost_source_changed", message)
        }
        managed_abandonment::AbandonedReadyError::Unavailable(message) => {
            ManagedRehostError::refused("hmux_managed_rehost_unavailable", message)
        }
    }
}

fn reconcile_abandoned_starting_source_stop(
    discovery_root: &Path,
    prepared: &PreparedManagedRehost,
) -> std::result::Result<ManagedStopReceipt, ManagedRehostError> {
    let source = prepared.request.source();
    let conversation_id = prepared.conversation_id.as_deref().ok_or_else(|| {
        ManagedRehostError::refused(
            "hmux_managed_rehost_source_changed",
            "fresh replacement cannot retire a starting source generation",
        )
    })?;
    let (generation, starting) = starting_source_evidence(
        discovery_root,
        source,
        prepared.replacement.provider_id(),
        Some(conversation_id),
    )?;
    let fence = generation.generation_fence();
    let key = DiscoveryKey::new(
        source.workspace_id(),
        source.session_id(),
        fence.runner_instance(),
        fence.channel_epoch(),
    )
    .map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_source_changed", error.to_string())
    })?;
    let root = DiscoveryRoot::open(discovery_root).map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_unavailable", error.to_string())
    })?;
    let discovery = root.open_session(key).map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_source_changed", error.to_string())
    })?;
    let lifetime_lock = match discovery.acquire_lifetime_lock() {
        Ok(lock) => lock,
        Err(hmux_host::local_discovery::DiscoveryError::AlreadyLocked { .. }) => {
            return Err(ManagedRehostError::refused(
                "hmux_managed_rehost_source_changed",
                "Starting source Host still owns its exact lifetime",
            ));
        }
        Err(error) => {
            return Err(ManagedRehostError::refused(
                "hmux_managed_rehost_unavailable",
                format!("Starting source lifetime cannot be proven abandoned: {error}"),
            ));
        }
    };
    let current = discovery.read_manifest().map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_source_changed", error.to_string())
    })?;
    if current != DiscoveryManifest::Starting(starting.clone()) {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_source_changed",
            "Starting source changed while acquiring its exact lifetime",
        ));
    }
    require_absent_source_process("Host", generation.host_process())?;
    require_absent_source_process("provider", generation.provider_process())?;

    match managed_stop_intent::acquire(discovery_root, source)
        .map_err(|error| ManagedRehostError::unknown(error.to_string()))?
    {
        managed_stop_intent::ManagedStopIntent::Refused => {
            return Err(ManagedRehostError::unknown(
                "abandoned Starting source stop was durably refused",
            ));
        }
        managed_stop_intent::ManagedStopIntent::Pending(_)
        | managed_stop_intent::ManagedStopIntent::Checkpointed { .. }
        | managed_stop_intent::ManagedStopIntent::Resume { .. }
        | managed_stop_intent::ManagedStopIntent::Completed(_) => {}
    }

    require_absent_source_process_session(generation.provider_process())?;

    let now = unix_time_ms();
    discovery
        .publish_exited(
            &lifetime_lock,
            ExitedManifest {
                common: starting.common,
                tombstone: Box::new(hmux_host::provider_epoch::ExitTombstone {
                    provider_conversation_identity: None,
                    fence: SessionFence {
                        workspace_id: source.workspace_id().to_string(),
                        session_id: source.session_id().to_string(),
                        runner_principal: fence.runner_principal().to_string(),
                        runner_instance: fence.runner_instance().to_string(),
                        channel_epoch: fence.channel_epoch(),
                        host_instance_id: fence.host_instance_id().to_string(),
                        terminal_epoch: fence.terminal_epoch().to_string(),
                    },
                    provider_process: ProcessProof {
                        process_id: generation.provider_process().process_id,
                        start_marker: generation.provider_process().start_marker.clone(),
                    },
                    exit: hmux_host::local_protocol::Exit {
                        final_output_seq: 0,
                        exit_code: None,
                        platform_status: None,
                        reason: "abandoned_starting_generation".to_string(),
                    },
                    exit_kind: hmux_host::provider_epoch::ProviderExitKind::ProviderError,
                    created_unix_ms: now,
                    failure: None,
                }),
                endpoint: generation.endpoint().clone(),
                capability_token: generation.capability_token().to_string(),
                exited_unix_ms: now,
            },
        )
        .map_err(|error| ManagedRehostError::unknown(error.to_string()))?;
    inject_fault("after_abandoned_starting_exited");
    drop(lifetime_lock);

    let receipt = stop_managed_provider_at(discovery_root, source)
        .map_err(|error| ManagedRehostError::unknown(error.to_string()))?;
    validate_source_stop(&receipt, prepared)?;
    Ok(receipt)
}

fn require_absent_source_process(
    label: &str,
    process: &ProcessDescriptor,
) -> std::result::Result<(), ManagedRehostError> {
    match probe_local_process_generation(process) {
        Ok(LocalProcessGenerationStatus::Absent) => Ok(()),
        Ok(LocalProcessGenerationStatus::Live) => Err(ManagedRehostError::refused(
            "hmux_managed_rehost_source_changed",
            format!("source {label} generation is still live"),
        )),
        Err(error) => Err(ManagedRehostError::refused(
            "hmux_managed_rehost_unavailable",
            format!("source {label} absence is unproven: {error}"),
        )),
    }
}

fn require_absent_source_process_session(
    provider_process: &ProcessDescriptor,
) -> std::result::Result<(), ManagedRehostError> {
    match crate::process_session::observe_process_session_presence(provider_process.process_id) {
        Ok(crate::process_session::ProcessSessionPresence::Absent) => Ok(()),
        Ok(crate::process_session::ProcessSessionPresence::Live) => {
            Err(ManagedRehostError::refused(
                "hmux_managed_rehost_source_changed",
                "source provider session still has a live member",
            ))
        }
        Err(error) => Err(ManagedRehostError::refused(
            "hmux_managed_rehost_unavailable",
            format!("source provider session absence is unproven: {error}"),
        )),
    }
}

fn checkpoint_source_stop_receipt(
    reservation: &mut RecoveryReservation,
    receipt: &ManagedStopReceipt,
) -> std::result::Result<(), ManagedRehostError> {
    let serialized = serde_json::to_string(receipt)
        .map_err(|_| ManagedRehostError::unknown("source stop receipt is not serializable"))?;
    reservation
        .checkpoint_source_stop_receipt(serialized)
        .map_err(ManagedRehostError::unknown)
}

fn retire_abandoned_replacement(
    discovery_root: &Path,
    replacement: &ManagedCreateRequest,
    host_process: &ProcessDescriptor,
) -> std::result::Result<bool, ManagedRehostError> {
    let Some(generation) = managed_create_ledger::starting_generation(
        discovery_root,
        replacement.workspace_id(),
        replacement.session_id(),
    )
    .map_err(|error| ManagedRehostError::refused("hmux_managed_rehost_target_conflict", error))?
    else {
        return Ok(false);
    };
    if generation.idempotency_key() != replacement.idempotency_key()
        || generation.host_process() != host_process
    {
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_target_conflict",
            "replacement Starting generation changed",
        ));
    }
    let identity = ManagedCreateReconcileRequest::new(
        replacement.idempotency_key(),
        replacement.session_id(),
        replacement.workspace_id(),
    )
    .map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_target_conflict", error.to_string())
    })?;
    super::managed_starting_generation::retire_if_abandoned(
        discovery_root,
        &identity,
        &generation,
        Some(replacement.provider_id()),
        super::managed_starting_generation::AbandonedStartingRetirement::RehostReplacement,
    )
    .map_err(map_abandoned_replacement_retirement_error)
}

fn map_abandoned_replacement_retirement_error(
    error: super::managed_starting_generation::AbandonedStartingRetirementError,
) -> ManagedRehostError {
    use super::managed_starting_generation::AbandonedStartingRetirementError;

    match error {
        AbandonedStartingRetirementError::Conflict(message) => {
            ManagedRehostError::refused("hmux_managed_rehost_target_conflict", message)
        }
        AbandonedStartingRetirementError::Unavailable(message) => {
            ManagedRehostError::refused("hmux_managed_rehost_unavailable", message)
        }
        AbandonedStartingRetirementError::OutcomeUnknown(message) => {
            ManagedRehostError::unknown(message)
        }
    }
}

fn preflight_replacement(
    discovery_root: &Path,
    replacement: &ManagedCreateRequest,
    source_checkpointed: bool,
) -> std::result::Result<Option<ManagedCreateReceipt>, ManagedRehostError> {
    match managed_create_intent::acquire_with_lineage(
        discovery_root,
        replacement,
        managed_create_intent::ManagedCreateIntentLineage::Root,
    )
    .map_err(|error| {
        ManagedRehostError::refused("hmux_managed_rehost_target_conflict", error.to_string())
    })? {
        managed_create_intent::ManagedCreateIntent::Prepared(_) => Ok(None),
        managed_create_intent::ManagedCreateIntent::Completed(receipt) => Ok(Some(receipt)),
        managed_create_intent::ManagedCreateIntent::SpawnReserved { .. } if source_checkpointed => {
            Ok(None)
        }
        managed_create_intent::ManagedCreateIntent::LaunchReleased {
            mut intent,
            host_process,
        } if source_checkpointed => {
            if retire_abandoned_replacement(discovery_root, replacement, &host_process)? {
                intent
                    .reset_after_definite_pre_ready_failure()
                    .map_err(ManagedRehostError::unknown)?;
            }
            Ok(None)
        }
        managed_create_intent::ManagedCreateIntent::Retired => Err(ManagedRehostError::refused(
            "hmux_managed_rehost_target_conflict",
            "managed rehost target logical session is retired",
        )),
        _ => Err(ManagedRehostError::refused(
            "hmux_managed_rehost_target_conflict",
            "managed rehost target advanced before source retirement",
        )),
    }
}

fn validate_source_stop(
    receipt: &ManagedStopReceipt,
    prepared: &PreparedManagedRehost,
) -> std::result::Result<(), ManagedRehostError> {
    receipt
        .validate()
        .map_err(|error| ManagedRehostError::unknown(error.to_string()))?;
    let source = prepared.request.source();
    if receipt.stop_id() != source.stop_id()
        || receipt.session_id() != source.session_id()
        || receipt.workspace_id() != source.workspace_id()
        || receipt.runner_principal() != source.expected_runner_principal().unwrap_or_default()
        || receipt.runner_instance() != source.expected_runner_instance().unwrap_or_default()
        || Some(receipt.channel_epoch()) != source.expected_channel_epoch()
        || receipt.host_instance_id() != source.expected_host_instance_id().unwrap_or_default()
        || receipt.terminal_epoch() != source.expected_terminal_epoch().unwrap_or_default()
    {
        return Err(ManagedRehostError::unknown(
            "source stop receipt changed the durable rehost fence",
        ));
    }
    Ok(())
}

fn decode_source_stop(
    serialized: &str,
    prepared: &PreparedManagedRehost,
) -> std::result::Result<ManagedStopReceipt, ManagedRehostError> {
    let receipt = serde_json::from_str(serialized)
        .map_err(|_| ManagedRehostError::unknown("source stop receipt is malformed"))?;
    validate_source_stop(&receipt, prepared)?;
    Ok(receipt)
}

fn validate_replacement_identity(
    receipt: &ManagedCreateReceipt,
    prepared: &PreparedManagedRehost,
    discovery_root: &Path,
) -> std::result::Result<(), ManagedRehostError> {
    receipt
        .validate()
        .map_err(|error| ManagedRehostError::unknown(error.to_string()))?;
    if receipt.idempotency_key() != prepared.replacement.idempotency_key()
        || receipt.session_id() != prepared.replacement.session_id()
        || receipt.workspace_id() != prepared.replacement.workspace_id()
        || receipt.provider_id() != prepared.replacement.provider_id()
        || receipt.permission_mode() != prepared.replacement.permission_mode()
        || receipt.discovery_root() != discovery_root
        || receipt.generation_fence().is_none()
    {
        return Err(ManagedRehostError::unknown(
            "replacement receipt changed the durable rehost target",
        ));
    }
    Ok(())
}

fn decode_replacement_identity(
    serialized: &str,
    prepared: &PreparedManagedRehost,
    discovery_root: &Path,
) -> std::result::Result<ManagedCreateReceipt, ManagedRehostError> {
    let receipt = serde_json::from_str(serialized)
        .map_err(|_| ManagedRehostError::unknown("replacement receipt is malformed"))?;
    validate_replacement_identity(&receipt, prepared, discovery_root)?;
    Ok(receipt)
}

fn decode_completed_replacement(
    serialized: &str,
    prepared: &PreparedManagedRehost,
    discovery_root: &Path,
) -> std::result::Result<ManagedCreateReceipt, ManagedRehostError> {
    let receipt = serde_json::from_str(serialized)
        .map_err(|_| ManagedRehostError::unknown("replacement receipt is malformed"))?;
    validate_replacement_identity(&receipt, prepared, discovery_root)?;
    Ok(receipt)
}

fn replacement_build_id(prepared: &PreparedManagedRehost) -> String {
    prepared
        .request
        .expected_target_build_id()
        .unwrap_or(crate::HOST_BUILD_ID)
        .to_string()
}

fn replay_completed(
    discovery_root: &Path,
    identity: &PreparedRecoveryIdentity,
    completion: RecoveryCompletion,
) -> std::result::Result<ManagedRehostReceipt, ManagedRehostError> {
    if completion.action != MANAGED_REHOST_RECOVERY_ACTION
        || !matches!(
            completion.outcome.as_str(),
            "rehosted" | "refused_precondition"
        )
    {
        return Err(ManagedRehostError::unknown(
            "managed rehost completion has an unsupported outcome",
        ));
    }
    let checkpoint = completion.operation_checkpoint.as_ref().ok_or_else(|| {
        ManagedRehostError::unknown("managed rehost completion lost its durable payload")
    })?;
    let prepared: PreparedManagedRehost = serde_json::from_str(&checkpoint.canonical_payload)
        .map_err(|_| ManagedRehostError::unknown("managed rehost completion is malformed"))?;
    validate_prepared_identity(&prepared, identity)?;
    if completion.outcome == "refused_precondition" {
        if completion.target_session_id != identity.source_session_id
            || completion.target_workspace_id != identity.source_workspace_id
            || completion.target_build_id != "precondition"
            || checkpoint.source_stop_receipt.is_some()
            || checkpoint.replacement_receipt.is_some()
        {
            return Err(ManagedRehostError::unknown(
                "refused rehost completion changed its boundary",
            ));
        }
        return Err(ManagedRehostError::refused(
            "hmux_managed_rehost_precondition_refused",
            "the Host durably refused this operation before source retirement",
        ));
    }
    let source = checkpoint.source_stop_receipt.as_deref().ok_or_else(|| {
        ManagedRehostError::unknown("managed rehost completion lost its stop receipt")
    })?;
    let replacement = checkpoint.replacement_receipt.as_deref().ok_or_else(|| {
        ManagedRehostError::unknown("managed rehost completion lost its replacement receipt")
    })?;
    let source = decode_source_stop(source, &prepared)?;
    let replacement = decode_completed_replacement(replacement, &prepared, discovery_root)?;
    if completion.target_session_id != replacement.session_id()
        || completion.target_workspace_id != replacement.workspace_id()
    {
        return Err(ManagedRehostError::unknown(
            "managed rehost completion target changed after commit",
        ));
    }
    completed_receipt(&prepared, source, replacement, true)
}

fn completed_receipt(
    prepared: &PreparedManagedRehost,
    source: ManagedStopReceipt,
    replacement: ManagedCreateReceipt,
    replayed: bool,
) -> std::result::Result<ManagedRehostReceipt, ManagedRehostError> {
    let receipt = match prepared.conversation_id.as_deref() {
        Some(conversation_id) => ManagedRehostReceipt::new(
            &prepared.request,
            source,
            replacement,
            conversation_id,
            prepared.launch_reference.clone(),
            replayed,
        ),
        None => ManagedRehostReceipt::new_fresh(
            &prepared.request,
            source,
            replacement,
            prepared.launch_reference.clone(),
            replayed,
        ),
    };
    receipt.map_err(|error| ManagedRehostError::unknown(error.to_string()))
}

fn map_recipe_error(error: String) -> ManagedRehostError {
    if error.contains("canonical rehost recipe") {
        ManagedRehostError::refused("hmux_managed_rehost_recipe_invalid", error)
    } else {
        ManagedRehostError::refused("hmux_managed_rehost_recipe_missing", error)
    }
}

fn map_journal_error(error: String) -> ManagedRehostError {
    let code = if error.starts_with("hmux_recovery_busy:") {
        "hmux_recovery_busy"
    } else if error.starts_with("hmux_recovery_idempotency_conflict:") {
        "hmux_managed_rehost_identity_mismatch"
    } else {
        "hmux_managed_rehost_outcome_unknown"
    };
    ManagedRehostError::refused(code, error)
}

#[cfg(debug_assertions)]
fn inject_fault(point: &str) {
    if std::env::var("HMUX_TEST_MANAGED_REHOST_FAULT").as_deref() == Ok(point) {
        std::process::exit(87);
    }
}

#[cfg(not(debug_assertions))]
fn inject_fault(_point: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_rehost_successor_requires_conversation_fenced_stop_authority() {
        assert_eq!(
            replacement_required_stop_version(),
            hmux_runtime_contract::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION
        );
    }

    #[test]
    fn legacy_v3_source_recipe_upgrades_its_replacement_to_v5() {
        let recipe = ManagedRehostRecipe::new(
            vec![
                "provider".into(),
                "--resume".into(),
                hmux_runtime_contract::MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
            ],
            None,
        )
        .unwrap();
        let source_create = ManagedCreateRequest::new(
            "legacy-create",
            "legacy-session",
            "workspace",
            "codex",
            PermissionMode::Default,
            "/tmp",
            vec!["provider".into()],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(
            hmux_runtime_contract::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
        )
        .unwrap()
        .with_managed_rehost_recipe(recipe)
        .unwrap();
        let source = ManagedRehostSourceRecipe::from_create_request(&source_create)
            .unwrap()
            .unwrap();
        let request = ManagedRehostRequest::new(
            "upgrade-operation",
            source.session_id(),
            source.workspace_id(),
            "principal",
            "runner",
            1,
            "host",
            "terminal",
            true,
        )
        .unwrap();

        let replacement = replacement_request(
            &request,
            ReplacementLaunch {
                provider_id: source.provider_id(),
                permission_mode: source.permission_mode(),
                provider_cwd: source.provider_cwd(),
                initial_rows: source.initial_rows(),
                initial_columns: source.initial_columns(),
                terminal_environment: source.terminal_environment().clone(),
                recipe: source.rehost(),
                provider_state_environment: source.provider_state_environment().clone(),
                conversation_id: Some("conversation-1"),
                fresh_command: None,
                terminal_default_colors: source.terminal_default_colors(),
            },
        )
        .unwrap();

        assert_eq!(
            source.required_managed_stop_request_version(),
            hmux_runtime_contract::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION
        );
        assert_eq!(
            replacement.required_managed_stop_request_version(),
            Some(hmux_runtime_contract::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION)
        );
    }
}
