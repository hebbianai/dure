use super::*;

#[derive(Debug)]
pub(super) enum CompletedTarget {
    Managed(hmux_client::ManagedCreateReceipt),
    Standalone(hmux_client::CompletedStandaloneTarget),
}

impl PreparedLaunch {
    pub(super) fn completed_target(
        &self,
        catalog: &LocalSessionCatalog,
        operation: Option<&recovery::RecoveryOperationCheckpoint>,
    ) -> Result<Option<CompletedTarget>, String> {
        let Some(source) = operation.and_then(|operation| operation.replacement_receipt.as_deref())
        else {
            return Ok(None);
        };
        let malformed =
            || "hmux_recovery_journal_invalid: completed target is malformed".to_string();
        let target = match self {
            Self::Standalone(create) => {
                let target = hmux_client::CompletedStandaloneTarget::from_recovery_checkpoint(
                    catalog, create, source,
                )
                .map_err(|error| error.to_string())?;
                CompletedTarget::Standalone(target)
            }
            Self::Managed(create) => {
                let receipt: hmux_client::ManagedCreateReceipt =
                    serde_json::from_str(source).map_err(|_| malformed())?;
                if receipt.workspace_id() != create.workspace_id()
                    || receipt.provider_id() != create.provider_id()
                    || receipt.discovery_root() != catalog.discovery_root()
                {
                    return Err(malformed());
                }
                CompletedTarget::Managed(receipt)
            }
        };
        Ok(Some(target))
    }
}

pub(super) fn reopen_standalone_target(
    catalog: &LocalSessionCatalog,
    target: &hmux_client::CompletedStandaloneTarget,
) -> Result<Option<CreatedStandaloneSession>, String> {
    use hmux_client::CompletedStandaloneTargetLifecycle;
    match catalog
        .resolve_completed_standalone_target(target.generation(), target.provider_process())
    {
        CompletedStandaloneTargetLifecycle::Retired => Ok(None),
        CompletedStandaloneTargetLifecycle::Active => {
            CreatedStandaloneSession::from_completed_target(target)
                .map(Some)
                .map_err(|error| error.to_string())
        }
        CompletedStandaloneTargetLifecycle::Unresolved => {
            Err("session_conversion_replacement_unavailable: completed target is unresolved".into())
        }
    }
}

pub(super) struct ReplacementContext<'a> {
    pub(super) manager: &'a HmuxManager,
    pub(super) catalog: &'a LocalSessionCatalog,
    pub(super) prepared: &'a launch::PreparedConversion,
    pub(super) expected_identity: &'a adoption::ProviderIdentity,
    pub(super) idempotency_key: &'a str,
    pub(super) attempt: u32,
    pub(super) reservation: &'a mut recovery::RecoveryReservation,
}

pub(super) enum ReplacementAttempt {
    Ready(Box<Replacement>),
    Retired,
}

pub(super) struct Replacement {
    pub(super) session: SessionSummary,
    pub(super) managed_receipt: Option<hmux_client::ManagedCreateReceipt>,
}

pub(super) fn create_replacement(
    context: ReplacementContext<'_>,
) -> Result<ReplacementAttempt, String> {
    let ReplacementContext {
        manager,
        catalog,
        prepared,
        expected_identity,
        idempotency_key,
        attempt,
        reservation,
    } = context;
    let request = &prepared.request;
    let current = &prepared.current;
    match &prepared.launch {
        launch::PreparedLaunch::Managed(create) => {
            let conversation_id =
                validated_replacement_conversation_id(request, expected_identity)?;
            let target_session_id =
                conversion_target_session_id(&request.source_session_id, request.target, attempt);
            let create = create
                .retarget_identity(idempotency_key, &target_session_id)
                .map_err(|error| error.to_string())?;
            let credential_intent =
                crate::session_credentials::managed_create_advance_credential_intent(
                    create.idempotency_key(),
                    create.session_id(),
                    create.workspace_id(),
                    create.provider_id(),
                    request.credential_id.as_deref(),
                    Some(conversation_id),
                )?;
            let resolution = crate::session_checkout::create_replacement_and_advance(
                current.runtime.clone(),
                catalog.discovery_root().to_path_buf(),
                prepared.recovery_checkout(catalog)?,
                create,
            )?;
            use hmux_client::ManagedCreateAdvanceResolution;
            let (created, advanced) = match resolution {
                ManagedCreateAdvanceResolution::Current(created) => (created, false),
                ManagedCreateAdvanceResolution::Advanced(created) => (created, true),
                ManagedCreateAdvanceResolution::Pending => {
                    return Err(
                        "hmux_managed_create_pending: the exact managed create is still pending"
                            .into(),
                    );
                }
                ManagedCreateAdvanceResolution::AuthorityUnavailable(authority) => {
                    return Err(format!("{}: {}", authority.code, authority.message));
                }
            };
            let receipt = created.receipt().clone();
            let replacement_generation = created.session().descriptor().clone();
            let replacement = verify_replacement(
                catalog,
                replacement_generation.clone(),
                request,
                &current.build_id,
                expected_identity,
            )?;
            if advanced {
                crate::session_credentials::finish_advanced_managed_launch(
                    credential_intent.as_ref(),
                    receipt.idempotency_key(),
                    &replacement_generation,
                )?;
            } else {
                crate::session_credentials::finish_current_managed_launch(
                    credential_intent.as_ref(),
                    receipt.outcome() == hmux_client::ManagedCreateOutcome::Created,
                    &replacement_generation,
                )?;
            }
            Ok(ReplacementAttempt::Ready(Box::new(Replacement {
                session: replacement,
                managed_receipt: Some(receipt),
            })))
        }
        launch::PreparedLaunch::Standalone(create) => {
            let created = match prepared
                .launch
                .completed_target(catalog, reservation.operation_checkpoint())?
            {
                Some(CompletedTarget::Standalone(target)) => {
                    let Some(created) = reopen_standalone_target(catalog, &target)? else {
                        return Ok(ReplacementAttempt::Retired);
                    };
                    created
                }
                Some(CompletedTarget::Managed(_)) => {
                    unreachable!("standalone launch parses a standalone target")
                }
                None => {
                    let created = crate::session_checkout::create_standalone_replacement(
                        current.runtime.clone(),
                        catalog.discovery_root().to_path_buf(),
                        prepared.recovery_checkout(catalog)?,
                        create.as_ref().clone(),
                        None,
                    )
                    .map_err(|error| error.to_string())?;
                    let target = hmux_client::CompletedStandaloneTarget::from_created(
                        created.receipt().clone(),
                        created.session().descriptor(),
                    )
                    .map_err(|error| error.to_string())?;
                    // Record actual creation before provider verification or the
                    // outer completion can lose its response. Retry never turns
                    // this completed target into another create request.
                    reservation.checkpoint_replacement_receipt(
                        serde_json::to_string(&target).map_err(|error| error.to_string())?,
                    )?;
                    created
                }
            };
            let descriptor = created.session().descriptor().clone();
            let replacement = verify_replacement(
                catalog,
                descriptor,
                request,
                &current.build_id,
                expected_identity,
            )?;
            manager
                .pending_created
                .lock()
                .expect("Hmux pending create registry poisoned")
                .insert(replacement.session_id.clone(), created);
            Ok(ReplacementAttempt::Ready(Box::new(Replacement {
                session: replacement,
                managed_receipt: None,
            })))
        }
    }
}

/// Immutable execution inputs. The resume checkpoint in the journal owns
/// progress; this initial checkpoint also covers loss before its first write.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) struct PreparedConversion {
    pub request: SessionConversionRequest,
    pub initial_checkpoint: recovery::RecoveryResumeCheckpoint,
    pub current: runtime::InstalledBuild,
    pub launch: PreparedLaunch,
    #[serde(default)]
    pub source_checkout: Option<dure_app::SessionCheckoutBindingV1>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(super) enum PreparedLaunch {
    Managed(Box<ManagedCreateRequest>),
    Standalone(Box<StandaloneCreateRequest>),
}

impl PreparedLaunch {
    /// Refuse an occupied target before source retirement. This is preflight,
    /// not replay authority; creation still goes through the runtime's receipt.
    pub fn ensure_target_available(
        &self,
        catalog: &LocalSessionCatalog,
        runtime: &std::path::Path,
    ) -> Result<(), String> {
        match self {
            Self::Managed(create) => existing_managed_target(catalog, create).map(|_| ()),
            Self::Standalone(create) => ensure_standalone_name_available(catalog, runtime, create),
        }
    }
}

pub(super) fn existing_managed_target(
    catalog: &LocalSessionCatalog,
    create: &ManagedCreateRequest,
) -> Result<Option<SessionDescriptor>, String> {
    let selector = SessionSelector::new(create.session_id(), Some(create.workspace_id().into()));
    match catalog.open(&selector) {
        Ok(existing) if existing.create_idempotency_key() == Some(create.idempotency_key()) => {
            Ok(Some(existing.descriptor().clone()))
        }
        Ok(_) => Err(
            "session_conversion_replacement_conflict: another creation owns the target session"
                .to_string(),
        ),
        Err(error) if error.is_session_absent() => Ok(None),
        Err(error) => Err(format!(
            "session_conversion_replacement_unavailable: target discovery could not be inspected: {error}"
        )),
    }
}

fn ensure_standalone_name_available(
    catalog: &LocalSessionCatalog,
    runtime: &std::path::Path,
    create: &StandaloneCreateRequest,
) -> Result<(), String> {
    let session_name = create.session_name().ok_or_else(|| {
        "hmux_recovery_journal_invalid: standalone conversion lost its session name".to_string()
    })?;
    let worker = CatalogCensusWorker::new(runtime);
    // Replacement creation follows the durable source_terminated checkpoint.
    // Occupancy before that boundary cannot be replay of this conversion.
    match resolve_local_session_name_isolated(catalog, &worker, session_name, CENSUS_TOTAL_BUDGET) {
        Ok(_) => Err(
            "session_conversion_replacement_conflict: another creation owns the target name"
                .to_string(),
        ),
        Err(error) if error.is_session_absent() => Ok(()),
        Err(error) => Err(format!(
            "session_conversion_replacement_unavailable: target name could not be inspected: {error}"
        )),
    }
}

pub(super) fn prepare(
    catalog: &LocalSessionCatalog,
    request: &SessionConversionRequest,
    prior_checkpoint: Option<&recovery::RecoveryResumeCheckpoint>,
    current: runtime::InstalledBuild,
) -> Result<PreparedConversion, String> {
    let cwd = PathBuf::from(&request.cwd);
    let checkpoint = match prior_checkpoint {
        Some(checkpoint) => {
            if checkpoint.provider_id != request.provider_id
                || checkpoint.provider_cwd != request.cwd
            {
                return Err(
                    "hmux_recovery_idempotency_conflict: conversion checkpoint changed".into(),
                );
            }
            checkpoint.clone()
        }
        None => {
            let source = exact_source(catalog, request)?;
            let identity = inspect_source_provider(&source, request, &cwd)?;
            checkpoint_from_identity(&identity, &source)
        }
    };
    let identity = identity_from_checkpoint(&checkpoint)?;
    let conversation_id = validated_replacement_conversation_id(request, &identity)?;
    let command = exact_adoption_resume_command(
        &identity.provider_id,
        conversation_id,
        request.permission_mode,
    )?;
    let source_checkout = checkout::source_binding(catalog, request, &current)?;
    let launch = match request.target {
        SessionConversionTarget::Managed => {
            let provider_state_environment = resolve_managed_provider_state_environment(
                &request.provider_id,
                request.credential_id.as_deref(),
                request.credential_directory.as_deref(),
            )?;
            let prepared = managed_launch::prepare_managed_create_request(ManagedCreateLaunch {
                replace_current: false,
                idempotency_key: conversion_replacement_idempotency_key(
                    &request.conversion_id,
                    checkpoint.attempt,
                ),
                session_id: conversion_target_session_id(
                    &request.source_session_id,
                    request.target,
                    checkpoint.attempt,
                ),
                workspace_id: request.source_workspace_id.clone(),
                provider_id: request.provider_id.clone(),
                conversation_id: Some(conversation_id.to_string()),
                initial_prompt: None,
                permission_mode: request.permission_mode,
                credential_id: request.credential_id.clone(),
                credential_generation: request.credential_generation,
                provider_state_environment,
                cwd: request.cwd.clone(),
                command,
                rows: request.rows,
                columns: request.columns,
                terminal_environment: request.terminal_environment.clone(),
                terminal_default_colors: request.terminal_default_colors.unwrap_or_default(),
            })?;
            PreparedLaunch::Managed(Box::new(prepared.request))
        }
        SessionConversionTarget::Standalone => {
            let shell = std::env::var_os("SHELL")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/bin/sh"));
            let argv = vec![
                shell.to_string_lossy().into_owned(),
                "-lc".to_string(),
                format!("exec {command}"),
            ];
            let mut proof = [0_u8; 32];
            getrandom::fill(&mut proof).map_err(|_| {
                "hmux_recovery_random_failed: launch proof generation failed".to_string()
            })?;
            // The private journal, not a name lookup or a saved shell recipe,
            // owns this exact request across response loss and retries.
            PreparedLaunch::Standalone(Box::new(standalone_request(
                request,
                argv,
                checkpoint.attempt,
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(proof),
            )?))
        }
    };
    Ok(PreparedConversion {
        request: request.clone(),
        initial_checkpoint: checkpoint,
        current,
        launch,
        source_checkout,
    })
}

pub(super) fn standalone_request(
    request: &SessionConversionRequest,
    argv: Vec<String>,
    attempt: u32,
    launch_owner_proof: String,
) -> Result<StandaloneCreateRequest, String> {
    let identity = hmux_client::StandaloneRecoveryCreateIdentity::new(
        format!(
            "standalone_convert_{}",
            conversion_digest(&request.conversion_id, request.target),
        ),
        launch_owner_proof,
    )
    .map_err(|error| error.to_string())?
    .with_recipe_requirement(hmux_client::StandaloneRecipeRequirement::RequestBound);
    StandaloneCreateRequest::new(
        PathBuf::from(&request.cwd),
        Some(conversion_standalone_name(
            &request.source_session_id,
            request.target,
            attempt,
        )),
        argv,
        request.rows,
        request.columns,
    )
    .and_then(|create| create.with_terminal_environment(request.terminal_environment.clone()))
    .and_then(|create| create.with_terminal_default_colors_option(request.terminal_default_colors))
    .and_then(|create| {
        create.with_resurrection_replay_policy(
            hmux_client::StandaloneResurrectionReplayPolicy::ConfirmExplicitCommand,
        )
    })
    .and_then(|create| create.with_recovery_identity(identity))
    .map_err(|error| error.to_string())
}
