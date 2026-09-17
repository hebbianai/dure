use super::*;
use hmux_client::{
    ManagedRehostReceipt, ManagedRehostReconcileRequest, ManagedRehostReplacement,
    ManagedRehostRequest, ManagedSessionRehoster,
};

const EXACT_RESUME_ACTION: &str = "replace_ai_provider_with_explicit_conversation";
const FRESH_REPLACEMENT_ACTION: &str = "replace_ai_provider_with_fresh_conversation";
const MANAGED_REHOST_INTENT_NOT_FOUND: &str = "hmux_managed_rehost_intent_not_found";
const MISSING_SOURCE_BUILD_ID: &str = "missing-discovery-generation";

#[derive(Debug, Eq, PartialEq)]
enum ManagedLaunchIntent<'a> {
    ExactResume { conversation_id: &'a str },
    FreshStart,
}

fn managed_launch_intent(
    kind: RecoveryExecutionKind,
    conversation_id: Option<&str>,
) -> Result<ManagedLaunchIntent<'_>, &'static str> {
    match kind {
        RecoveryExecutionKind::ManagedProvider => Ok(ManagedLaunchIntent::ExactResume {
            conversation_id: conversation_id.ok_or("conversation_identity_required")?,
        }),
        RecoveryExecutionKind::ManagedProviderFresh if conversation_id.is_none() => {
            Ok(ManagedLaunchIntent::FreshStart)
        }
        RecoveryExecutionKind::ManagedProviderFresh | RecoveryExecutionKind::PlainShell => {
            Err("managed_recovery_identity_mismatch")
        }
    }
}

pub(super) fn plan_missing_source(
    request: &RecoveryPlanRequest,
    target_build_id: Option<String>,
) -> Result<RecoveryPlanReceipt, String> {
    request
        .expected_source_fence
        .as_ref()
        .ok_or_else(|| {
            "managed_recovery_source_fence_invalid: missing source requires its persisted generation fence"
                .to_string()
        })?
        .validate()?;
    match evaluate_recovery_policy(RecoveryPolicyInput::ManagedProvider {
        resume_identity_present: request
            .conversation_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
        adapter_supports_exact_resume: request.adapter_supports_explicit_resume,
        confirmed: request.confirmed,
    }) {
        RecoveryDecision::ReplaceManagedProvider => Ok(RecoveryPlanReceipt {
            session_id: request.session_id.clone(),
            source_build_id: MISSING_SOURCE_BUILD_ID.to_string(),
            target_build_id,
            action: EXACT_RESUME_ACTION,
            allowed: true,
            reason: None,
            requires_confirmation: true,
        }),
        RecoveryDecision::Refused {
            reason,
            requires_confirmation,
        } => Ok(RecoveryPlanReceipt {
            session_id: request.session_id.clone(),
            source_build_id: MISSING_SOURCE_BUILD_ID.to_string(),
            target_build_id,
            action: "none",
            allowed: false,
            reason: Some(reason),
            requires_confirmation,
        }),
        RecoveryDecision::RestorePlainShell { .. } => Err(
            "managed_recovery_identity_mismatch: missing managed source planned plain-shell recovery"
                .to_string(),
        ),
    }
}

fn reconcile_request(
    request: &RecoveryExecutionRequest,
) -> Result<ManagedRehostReconcileRequest, String> {
    ManagedRehostReconcileRequest::by_operation_identity(
        &request.recovery_id,
        &request.session_id,
        &request.workspace_id,
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn reconcile_then_initiate<T, E>(
    reconcile: impl FnOnce() -> Result<Option<T>, E>,
    initiate: impl FnOnce() -> Result<T, E>,
) -> Result<T, E> {
    match reconcile()? {
        Some(receipt) => Ok(receipt),
        None => initiate(),
    }
}

fn reconcile_existing(
    rehoster: &ManagedSessionRehoster,
    request: ManagedRehostReconcileRequest,
) -> Result<Option<ManagedRehostReceipt>, String> {
    match rehoster.reconcile(request) {
        Ok(receipt) => Ok(Some(receipt)),
        Err(error) if error.code() == MANAGED_REHOST_INTENT_NOT_FOUND => Ok(None),
        Err(error) => Err(format!("{}: {error}", error.code())),
    }
}

#[derive(Debug)]
struct ManagedRecoverySourceAuthority<'a> {
    runner_principal: &'a str,
    runner_instance: &'a str,
    channel_epoch: u64,
    host_instance_id: &'a str,
    terminal_epoch: &'a str,
    provider_id: Option<&'a str>,
}

fn recovery_source_authority<'a>(
    source: Option<&'a ManagedRehostSource>,
    request: &'a RecoveryExecutionRequest,
) -> Result<ManagedRecoverySourceAuthority<'a>, &'static str> {
    match source {
        Some(source) => {
            let source = source.descriptor();
            if source.session_id != request.session_id
                || source.workspace_id != request.workspace_id
                || source.session_class != SessionClass::Managed
            {
                return Err("managed_recovery_identity_mismatch");
            }
            if let Some(expected) = &request.expected_source_fence {
                expected
                    .validate()
                    .map_err(|_| "managed_recovery_source_fence_invalid")?;
                if !expected.matches(source) {
                    return Err("managed_recovery_source_fence_changed");
                }
            }
            Ok(ManagedRecoverySourceAuthority {
                runner_principal: &source.runner_principal,
                runner_instance: &source.runner_instance,
                channel_epoch: source
                    .channel_epoch
                    .parse::<u64>()
                    .map_err(|_| "managed_recovery_source_fence_invalid")?,
                host_instance_id: &source.host_instance_id,
                terminal_epoch: &source.terminal_epoch,
                provider_id: Some(&source.provider_id),
            })
        }
        None => {
            if request.kind != RecoveryExecutionKind::ManagedProvider {
                return Err("managed_recovery_source_missing");
            }
            let expected = request
                .expected_source_fence
                .as_ref()
                .ok_or("managed_recovery_source_fence_invalid")?;
            expected
                .validate()
                .map_err(|_| "managed_recovery_source_fence_invalid")?;
            Ok(ManagedRecoverySourceAuthority {
                runner_principal: &expected.runner_principal,
                runner_instance: &expected.runner_instance,
                channel_epoch: expected
                    .channel_epoch
                    .parse::<u64>()
                    .map_err(|_| "managed_recovery_source_fence_invalid")?,
                host_instance_id: &expected.host_instance_id,
                terminal_epoch: &expected.terminal_epoch,
                provider_id: None,
            })
        }
    }
}

fn admission_request(
    source: Option<&ManagedRehostSource>,
    request: &RecoveryExecutionRequest,
) -> Result<ManagedRehostRequest, &'static str> {
    if !request.confirmed {
        return Err("update_requires_confirmation");
    }
    if request.kind == RecoveryExecutionKind::PlainShell {
        return Err("managed_recovery_identity_mismatch");
    }
    let source_authority = recovery_source_authority(source, request)?;
    let rehost = ManagedRehostRequest::new(
        &request.recovery_id,
        &request.session_id,
        &request.workspace_id,
        source_authority.runner_principal,
        source_authority.runner_instance,
        source_authority.channel_epoch,
        source_authority.host_instance_id,
        source_authority.terminal_epoch,
        true,
    )
    .map_err(|_| "managed_recovery_request_invalid")?;
    let Some(launch) = request.managed_launch.as_ref() else {
        if source.is_none() {
            return Err("managed_recovery_launch_required");
        }
        if request.kind == RecoveryExecutionKind::ManagedProviderFresh {
            return Err("managed_recovery_launch_required");
        }
        return match request
            .conversation_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            Some(conversation_id) => rehost
                .with_expected_conversation_id(conversation_id)
                .map_err(|_| "managed_recovery_request_invalid"),
            None => Ok(rehost),
        };
    };
    if source_authority
        .provider_id
        .is_some_and(|provider_id| provider_id != launch.provider_id)
    {
        return Err("managed_recovery_identity_mismatch");
    }
    let conversation_id = request
        .conversation_id
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let intent = managed_launch_intent(request.kind, conversation_id)?;
    let provider_id = launch.provider_id.as_str();
    let permission_mode = launch.permission_mode;
    let credential_id = launch.credential_id.as_deref();
    if let ManagedLaunchIntent::ExactResume { conversation_id } = &intent {
        crate::managed_provider_launch::exact_command(provider_id, permission_mode, conversation_id)
            .ok_or("managed_recovery_launch_invalid")?;
    }
    let provider_state_environment = resolve_managed_provider_state_environment(
        provider_id,
        credential_id,
        launch.credential_directory.as_deref(),
    )
    .map_err(|_| "managed_recovery_credential_unavailable")?;
    let fresh_command = crate::managed_provider_launch::fresh_command(provider_id, permission_mode)
        .ok_or("managed_recovery_exact_resume_unsupported")?;
    managed_launch::validate_managed_provider_launch(
        credential_id,
        launch.credential_generation,
        &provider_state_environment,
        &fresh_command,
    )
    .map_err(|_| "managed_recovery_launch_invalid")?;
    let cwd = fs::canonicalize(&launch.cwd)
        .ok()
        .filter(|path| path.is_dir())
        .ok_or("managed_recovery_cwd_unavailable")?;
    let shell = std::env::var_os("SHELL")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bin/sh"));
    let recipe = managed_rehost_recipe::local_create_time_recipe(
        provider_id,
        permission_mode,
        credential_id.map(str::to_string),
        &shell,
        &provider_state_environment,
    )
    .map_err(|_| "managed_recovery_launch_invalid")?
    .ok_or("managed_recovery_exact_resume_unsupported")?;
    let replacement = ManagedRehostReplacement::new(
        provider_id,
        permission_mode,
        cwd,
        launch.rows,
        launch.columns,
        launch.terminal_environment.clone(),
        credential_id.map(str::to_string),
        provider_state_environment,
        recipe,
    )
    .map_err(|_| "managed_recovery_launch_invalid")?;
    let rehost = rehost
        .with_expected_provider_id(provider_id)
        .map_err(|_| "managed_recovery_request_invalid")?;
    let rehost = match intent {
        ManagedLaunchIntent::ExactResume { conversation_id } => rehost
            .with_expected_conversation_id(conversation_id)
            .and_then(|request| request.with_replacement(replacement))
            .map_err(|_| "managed_recovery_request_invalid")?,
        ManagedLaunchIntent::FreshStart => {
            let command = crate::managed_hooks::prepare_managed_exec(
                provider_id,
                &fresh_command,
                replacement.provider_state_environment(),
            )
            .map_err(|_| "managed_recovery_launch_invalid")?;
            let replacement = replacement
                .with_fresh_command(command.into_command_template(&shell))
                .map_err(|_| "managed_recovery_launch_invalid")?;
            rehost
                .with_replacement(replacement)
                .map_err(|_| "managed_recovery_request_invalid")?
        }
    };
    match request.expected_target_build_id.as_deref() {
        Some(build_id) => rehost
            .with_expected_target_build_id(build_id)
            .map_err(|_| "managed_recovery_request_invalid"),
        None => Ok(rehost),
    }
}

fn project_receipt(
    catalog: &LocalSessionCatalog,
    source_session_id: &str,
    receipt: ManagedRehostReceipt,
) -> Result<RecoveryExecutionReceipt, String> {
    let replacement_target = ManagedRehostTargetReceipt::from_rehost(&receipt)?;
    let replacement_session = replacement_presentation(catalog, &replacement_target);
    let target_build_id = replacement_session
        .as_ref()
        .map(|descriptor| descriptor.host_build_version.clone())
        .or_else(runtime::current_build_id);
    let conversation_id = receipt.conversation_id().map(str::to_string);
    Ok(RecoveryExecutionReceipt {
        source_session_id: source_session_id.to_string(),
        target_build_id,
        action: if conversation_id.is_some() {
            EXACT_RESUME_ACTION
        } else {
            FRESH_REPLACEMENT_ACTION
        },
        outcome: "replaced",
        replayed: receipt.replayed(),
        reason: None,
        operation_id: Some(receipt.operation_id().to_string()),
        conversation_id,
        launch_reference: receipt.launch_reference().map(str::to_string),
        source_stop_receipt: Some(receipt.source_stop_receipt().clone()),
        replacement_target: Some(replacement_target),
        replacement_session: replacement_session.map(project_session),
    })
}

pub(super) fn reconcile<R: tauri::Runtime>(
    app: &AppHandle<R>,
    catalog: &LocalSessionCatalog,
    request: ManagedRecoveryReconcileRequest,
) -> Result<Option<RecoveryExecutionReceipt>, String> {
    let current = runtime::ensure_current_build(app)?;
    let working_directory = current
        .runtime
        .parent()
        .ok_or_else(|| "managed Hmux runtime has no parent directory".to_string())?;
    let rehoster = ManagedSessionRehoster::new(&current.runtime, working_directory)
        .with_discovery_root(catalog.discovery_root());
    let reconcile = ManagedRehostReconcileRequest::by_operation_identity(
        &request.recovery_id,
        &request.session_id,
        &request.workspace_id,
    )
    .map_err(|error| error.to_string())?;
    reconcile_existing(&rehoster, reconcile)?
        .map(|receipt| {
            if let Err(error) = crate::session_credentials::record_managed_rehost(&receipt) {
                eprintln!("managed rehost credential binding projection failed: {error}");
            }
            project_receipt(catalog, &request.session_id, receipt)
        })
        .transpose()
}

fn replacement_presentation(
    catalog: &LocalSessionCatalog,
    target: &ManagedRehostTargetReceipt,
) -> Option<SessionDescriptor> {
    catalog
        .find(&SessionSelector::new(
            &target.session_id,
            Some(target.workspace_id.clone()),
        ))
        .ok()
        .filter(|descriptor| {
            descriptor.session_class == SessionClass::Managed
                && descriptor.session_id == target.session_id
                && descriptor.workspace_id == target.workspace_id
                && descriptor.provider_id == target.provider_id
                && target.runner_principal == descriptor.runner_principal
                && target.runner_instance == descriptor.runner_instance
                && target.channel_epoch == descriptor.channel_epoch
                && target.host_instance_id == descriptor.host_instance_id
                && target.terminal_epoch == descriptor.terminal_epoch
        })
}

pub(super) fn execute<R: tauri::Runtime>(
    app: &AppHandle<R>,
    catalog: &LocalSessionCatalog,
    request: RecoveryExecutionRequest,
) -> Result<RecoveryExecutionReceipt, String> {
    let current = runtime::ensure_current_build(app)?;
    let working_directory = current
        .runtime
        .parent()
        .ok_or_else(|| "managed Hmux runtime has no parent directory".to_string())?;
    let rehoster = ManagedSessionRehoster::new(&current.runtime, working_directory)
        .with_discovery_root(catalog.discovery_root());
    let reconcile = reconcile_request(&request)?;
    let receipt = reconcile_then_initiate(
        || reconcile_existing(&rehoster, reconcile),
        || {
            let source = match catalog.managed_rehost_source(&SessionSelector::new(
                &request.session_id,
                Some(request.workspace_id.clone()),
            )) {
                Ok(source) => Some(source),
                Err(error) if error.is_session_absent() => None,
                Err(error) => {
                    return Err(format!("{}: {error}", error.code()));
                }
            };
            let admission = match admission_request(source.as_ref(), &request) {
                Ok(admission) => admission,
                Err(reason) => {
                    return Err(format!("managed_recovery_refused:{reason}"));
                }
            };
            let admission = if request.require_socket_owner_absent {
                admission.requiring_socket_owner_absence()
                    .map_err(|error| format!("managed_recovery_refused:{error}"))?
            } else {
                admission
            };
            let rehoster = ManagedSessionRehoster::new(&current.runtime, working_directory)
                .with_discovery_root(catalog.discovery_root());
            match source {
                Some(source) => rehoster.with_source(source).rehost(admission),
                None => rehoster.rehost(admission),
            }
            .map_err(|error| format!("{}: {error}", error.code()))
        },
    );
    let receipt = match receipt {
        Ok(receipt) => receipt,
        Err(error) if error.starts_with("managed_recovery_refused:") => {
            let reason = error
                .strip_prefix("managed_recovery_refused:")
                .unwrap_or("managed_recovery_request_invalid");
            return Ok(recovery_request_refusal(
                &request.session_id,
                runtime::current_build_id(),
                match reason {
                    "update_requires_confirmation" => "update_requires_confirmation",
                    "conversation_identity_required" => "conversation_identity_required",
                    "managed_recovery_launch_required" => "managed_recovery_launch_required",
                    "managed_recovery_source_missing" => "managed_recovery_source_missing",
                    "managed_recovery_identity_mismatch" => "managed_recovery_identity_mismatch",
                    "managed_recovery_credential_unavailable" => {
                        "managed_recovery_credential_unavailable"
                    }
                    "managed_recovery_cwd_unavailable" => "managed_recovery_cwd_unavailable",
                    "managed_recovery_exact_resume_unsupported" => {
                        "managed_recovery_exact_resume_unsupported"
                    }
                    "managed_recovery_source_fence_invalid" => {
                        "managed_recovery_source_fence_invalid"
                    }
                    "managed_recovery_source_fence_changed" => {
                        "managed_recovery_source_fence_changed"
                    }
                    "managed_recovery_launch_invalid" => "managed_recovery_launch_invalid",
                    _ => "managed_recovery_request_invalid",
                },
            ));
        }
        Err(error) => return Err(error),
    };
    if let Err(error) = crate::session_credentials::record_managed_rehost(&receipt) {
        eprintln!("managed rehost credential binding projection failed: {error}");
    }
    project_receipt(catalog, &request.session_id, receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn missing_source_plan_request() -> RecoveryPlanRequest {
        RecoveryPlanRequest {
            session_id: "source-session".into(),
            workspace_id: "source-workspace".into(),
            expected_source_fence: Some(ManagedStopFence {
                runner_principal: "runner-principal".into(),
                runner_instance: "runner-instance".into(),
                channel_epoch: "7".into(),
                host_instance_id: "host-instance".into(),
                terminal_epoch: "terminal-epoch".into(),
            }),
            conversation_id: Some("conversation-exact".into()),
            adapter_supports_explicit_resume: true,
            confirmed: false,
        }
    }

    #[test]
    fn missing_source_plan_preserves_the_exact_resume_confirmation_contract() {
        let request = missing_source_plan_request();

        let plan = plan_missing_source(&request, Some("current-build".into())).unwrap();

        assert_eq!(plan.session_id, "source-session");
        assert_eq!(plan.source_build_id, MISSING_SOURCE_BUILD_ID);
        assert_eq!(plan.action, "none");
        assert!(!plan.allowed);
        assert_eq!(plan.reason, Some("update_requires_confirmation"));
        assert!(plan.requires_confirmation);
    }

    #[test]
    fn missing_source_plan_requires_the_persisted_generation_fence() {
        let mut request = missing_source_plan_request();
        request.expected_source_fence = None;

        assert!(
            plan_missing_source(&request, None)
                .unwrap_err()
                .starts_with("managed_recovery_source_fence_invalid:")
        );
    }

    fn missing_source_exact_resume_request() -> RecoveryExecutionRequest {
        RecoveryExecutionRequest {
            recovery_id: "recovery_missing_source".into(),
            kind: RecoveryExecutionKind::ManagedProvider,
            session_id: "source-session".into(),
            workspace_id: "source-workspace".into(),
            expected_source_fence: Some(ManagedStopFence {
                runner_principal: "runner-principal".into(),
                runner_instance: "runner-instance".into(),
                channel_epoch: "7".into(),
                host_instance_id: "host-instance".into(),
                terminal_epoch: "terminal-epoch".into(),
            }),
            expected_target_build_id: None,
            require_socket_owner_absent: false,
            conversation_id: Some("conversation-exact".into()),
            adapter_supports_explicit_resume: true,
            confirmed: true,
            managed_launch: Some(ManagedRecoveryLaunchRequest {
                provider_id: "codex".into(),
                permission_mode: PermissionMode::Default,
                credential_id: None,
                credential_directory: None,
                credential_generation: None,
                cwd: std::env::current_dir()
                    .unwrap()
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                rows: 30,
                columns: 120,
                terminal_environment: TerminalEnvironment::default(),
            }),
        }
    }

    #[test]
    fn missing_source_exact_resume_uses_the_persisted_generation_fence() {
        let request = missing_source_exact_resume_request();

        let authority = recovery_source_authority(None, &request).unwrap();

        assert_eq!(authority.runner_principal, "runner-principal");
        assert_eq!(authority.runner_instance, "runner-instance");
        assert_eq!(authority.channel_epoch, 7);
        assert_eq!(authority.host_instance_id, "host-instance");
        assert_eq!(authority.terminal_epoch, "terminal-epoch");
        assert_eq!(authority.provider_id, None);
    }

    #[test]
    fn missing_source_without_a_complete_fence_never_launches() {
        let mut request = missing_source_exact_resume_request();
        request.expected_source_fence = None;

        assert_eq!(
            recovery_source_authority(None, &request).unwrap_err(),
            "managed_recovery_source_fence_invalid"
        );
    }

    #[test]
    fn completed_receipt_treats_missing_catalog_projection_as_pending_presentation() {
        let state = tempfile::tempdir().unwrap();
        let target = ManagedRehostTargetReceipt {
            idempotency_key: "replacement-1".to_string(),
            session_id: "session-replacement".to_string(),
            workspace_id: "workspace-1".to_string(),
            provider_id: "codex".to_string(),
            permission_mode: PermissionMode::Default,
            runner_principal: "principal-1".to_string(),
            runner_instance: "runner-1".to_string(),
            channel_epoch: "1".to_string(),
            host_instance_id: "host-1".to_string(),
            terminal_epoch: "terminal-1".to_string(),
        };

        assert!(replacement_presentation(
            &LocalSessionCatalog::new(state.path()),
            &target,
        )
        .is_none());
    }

    #[test]
    fn completed_canonical_rehost_skips_all_new_admission_hints() {
        let initiations = Cell::new(0);
        let receipt = reconcile_then_initiate(
            || Ok(Some("journaled-replacement")),
            || {
                initiations.set(initiations.get() + 1);
                Err("changed or missing client hints".to_string())
            },
        )
        .unwrap();

        assert_eq!(receipt, "journaled-replacement");
        assert_eq!(initiations.get(), 0);
    }

    #[test]
    fn absent_canonical_intent_admits_exactly_one_replacement() {
        let initiations = Cell::new(0);
        let receipt = reconcile_then_initiate(
            || Ok::<Option<&str>, String>(None),
            || {
                initiations.set(initiations.get() + 1);
                Ok("new-replacement")
            },
        )
        .unwrap();

        assert_eq!(receipt, "new-replacement");
        assert_eq!(initiations.get(), 1);
    }

    #[test]
    fn reconcile_failure_never_crosses_the_admission_boundary() {
        let initiations = Cell::new(0);
        let error = reconcile_then_initiate::<&str, String>(
            || Err("canonical journal unavailable".to_string()),
            || {
                initiations.set(initiations.get() + 1);
                Ok("must-not-launch")
            },
        )
        .unwrap_err();

        assert_eq!(error, "canonical journal unavailable");
        assert_eq!(initiations.get(), 0);
    }

    #[test]
    fn explicit_fresh_kind_does_not_depend_on_an_exact_resume_capability_hint() {
        assert_eq!(
            managed_launch_intent(RecoveryExecutionKind::ManagedProviderFresh, None),
            Ok(ManagedLaunchIntent::FreshStart)
        );
    }
}
