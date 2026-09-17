use super::{
    CliError, UpgradeArgs, attach_foreground, resolve_runtime_executable, resolve_upgrade_source,
    resurrection, runtime_build_id,
};
use hmux_client::{
    CompletedStandaloneTarget, CreatedStandaloneSession, LocalSession, LocalSessionCatalog,
    SessionLifecycle, SessionProbeStatus, StandaloneCreateRequest, StandaloneRecipeRequirement,
    StandaloneRecoveryCreateIdentity, StandaloneReplacementSource, StandaloneSessionCreator,
    StandaloneUpgradeDecision, StandaloneUpgradePolicyInput, evaluate_standalone_upgrade_policy,
    probe_local_session_exact,
    recovery_journal::{
        self as journal,
        standalone_upgrade::{
            self, PreparedStandaloneUpgrade, SELECTED_BUILD_ACTION, StandaloneUpgradeOperation,
            StandaloneUpgradeReplacement,
        },
    },
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};
use uuid::Uuid;

const ACTION: &str = SELECTED_BUILD_ACTION;
type Error = Box<dyn std::error::Error>;
type PreparedUpgrade = PreparedStandaloneUpgrade<LaunchContext>;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchContext {
    runtime: PathBuf,
}

pub(super) fn run(
    catalog: &LocalSessionCatalog,
    args: UpgradeArgs,
    json: bool,
) -> Result<(), Error> {
    if let Some(operation_id) = &args.operation_id {
        match standalone_upgrade::read_operation(catalog, operation_id, ACTION)? {
            Some(StandaloneUpgradeOperation::Rehosted(completed)) => {
                let replacement =
                    CreatedStandaloneSession::from_completed_target(&completed.successor.target)?;
                let session = replacement.session();
                if probe_local_session_exact(
                    &LocalSessionCatalog::new(
                        completed.successor.target.receipt().discovery_root(),
                    ),
                    session.descriptor(),
                ) != SessionProbeStatus::Healthy
                {
                    return Err(CliError(
                        "saved upgrade target has not passed its handshake".into(),
                    )
                    .into());
                }
                print_receipt(
                    json,
                    "rehosted",
                    &completed.source,
                    &completed.source_build_id,
                    completed.successor.target.host_build_version(),
                    session,
                    Some(operation_id),
                )?;
                if args.foreground {
                    attach_foreground(session, false)?;
                }
                return Ok(());
            }
            Some(StandaloneUpgradeOperation::Pending(pending)) => {
                let state = pending
                    .reopen()?
                    .ok_or_else(|| CliError("saved upgrade is no longer available".into()))?;
                // This existing operation resumes its frozen launch in the namespace
                // that originally admitted it. Fresh requests below still use the
                // caller's primary root; lookup roots grant no fresh creation authority.
                let operation_catalog = LocalSessionCatalog::with_read_only_discovery_roots(
                    pending.operation_root(),
                    catalog
                        .discovery_paths()
                        .map(std::path::Path::to_path_buf)
                        .collect(),
                )?;
                return execute(&operation_catalog, &args, json, operation_id, state);
            }
            Some(StandaloneUpgradeOperation::Cancelled) => {
                return Err(CliError(format!(
                    "{}: upgrade was cancelled",
                    standalone_upgrade::CANCELLED_CODE,
                ))
                .into());
            }
            None => {}
        }
    }
    let source = resolve_upgrade_source(catalog, &args.session)?;
    let exact_source = StandaloneReplacementSource::from_session(&source)?;
    // Fresh preparation and final retirement share this source fence. A stale
    // pre-lock observation cannot publish a new intent after retirement.
    let source_lock = exact_source.lock()?;
    let source = exact_source.open()?;
    let descriptor = source.descriptor();
    let runtime = resolve_runtime_executable(args.runtime.clone())?.canonicalize()?;
    let target_info = super::runtime_info::inspect(&runtime)?;
    let target_build_id = target_info.build_id;
    let source_healthy = descriptor.lifecycle == SessionLifecycle::Ready
        && probe_local_session_exact(catalog, descriptor) == SessionProbeStatus::Healthy;
    // An already-current source needs no launch authority or new operation.
    if source_healthy && descriptor.host_build_version == target_build_id {
        drop(source_lock);
        print_receipt(
            json,
            "already_current",
            &exact_source,
            &descriptor.host_build_version,
            &target_build_id,
            &source,
            None,
        )?;
        if args.foreground {
            attach_foreground(&source, false)?;
        }
        return Ok(());
    }
    let name = descriptor
        .session_name
        .as_deref()
        .ok_or_else(|| CliError("standalone upgrade requires a session name".into()))?;
    let request =
        match journal::standalone_launch::read_for_session(catalog, &source, decode_launch)? {
            Some(request) => request,
            None => resurrection::resolve_and_migrate(catalog.discovery_root(), name)?
                .recipe()
                .to_create_request()?,
        };
    match evaluate_standalone_upgrade_policy(StandaloneUpgradePolicyInput {
        verified_recipe: true,
        source_healthy,
        target_build_differs: descriptor.host_build_version != target_build_id,
        confirmed: args.confirm_restart,
    }) {
        StandaloneUpgradeDecision::Rehost => {}
        StandaloneUpgradeDecision::Refused { reason, .. } => {
            return Err(CliError(match reason {
                "upgrade_restart_requires_confirmation" => {
                    format!("upgrading `{name}` restarts its live provider; pass --confirm-restart")
                }
                _ => format!("upgrade refused: {reason}"),
            })
            .into());
        }
        StandaloneUpgradeDecision::AlreadyCurrent => {
            unreachable!("healthy current source returned above")
        }
    }
    let operation_id = args.operation_id.clone().unwrap_or_else(|| {
        journal::request_fingerprint(&[
            ACTION,
            &descriptor.workspace_id,
            &descriptor.session_id,
            &descriptor.host_instance_id,
            &descriptor.terminal_epoch,
            &target_build_id,
        ])
    });
    let identity = journal::PreparedRecoveryIdentity {
        recovery_id: operation_id.clone(),
        source_session_id: descriptor.session_id.clone(),
        source_workspace_id: descriptor.workspace_id.clone(),
        action: ACTION,
        legacy_request_fingerprint: None,
    };
    let state = match journal::reserve_prepared(catalog.discovery_root(), identity.clone(), None) {
        Ok(state) => state,
        Err(error) if error.starts_with("hmux_recovery_prepare_required:") => {
            let requirement = request
                .recovery_identity()
                .map_or(StandaloneRecipeRequirement::Existing, |identity| {
                    identity.recipe_requirement()
                });
            let predecessor = exact_source.presentation_predecessor()?;
            let target =
                journal::request_fingerprint(&["standalone_upgrade_target_v1", &operation_id]);
            let recovery = StandaloneRecoveryCreateIdentity::new(
                format!("standalone_{}", &target[..12]),
                Uuid::new_v4().to_string(),
            )?
            .with_recipe_requirement(requirement)
            .with_source_predecessor(predecessor)?;
            let create = request
                .without_recovery_identity()
                .with_recovery_identity(recovery)?;
            // Negotiate once before source stop and persist that decision. An
            // older selected build retains its exact legacy request on replay;
            // lack of binding never becomes cancellation authority.
            let create = create.with_negotiated_recovery_operation(
                &operation_id,
                exact_source.discovery_root(),
                catalog.discovery_root(),
                &target_info.capabilities,
            )?;
            let prepared = PreparedUpgrade {
                source: exact_source,
                source_build_id: descriptor.host_build_version.clone(),
                target_build_id,
                replacement: Some(StandaloneUpgradeReplacement {
                    discovery_root: None,
                    create,
                    context: LaunchContext { runtime },
                }),
            };
            journal::reserve_prepared(
                catalog.discovery_root(),
                identity,
                Some(serde_json::to_string(&prepared)?),
            )?
        }
        Err(error) => return Err(error.into()),
    };
    drop(source_lock);
    execute(catalog, &args, json, &operation_id, state)
}

fn execute(
    catalog: &LocalSessionCatalog,
    args: &UpgradeArgs,
    json: bool,
    operation_id: &str,
    state: journal::RecoveryReservationState,
) -> Result<(), Error> {
    let (pending, checkpoint) = match state {
        journal::RecoveryReservationState::Completed(completion) => {
            (None, completion.operation_checkpoint)
        }
        journal::RecoveryReservationState::Pending(reservation) => {
            let checkpoint = reservation.operation_checkpoint().cloned();
            (Some(reservation), checkpoint)
        }
    };
    let checkpoint =
        checkpoint.ok_or_else(|| CliError("saved upgrade has no prepared launch".into()))?;
    let prepared = PreparedUpgrade::read(&checkpoint)?;
    let replacement_plan = prepared
        .replacement
        .as_ref()
        .ok_or_else(|| CliError("saved selected-build upgrade has no replacement".into()))?;
    let target_catalog =
        LocalSessionCatalog::new(replacement_plan.discovery_root(catalog.discovery_root()));
    let replacement = if let Some(target) =
        standalone_upgrade::resolve_target(catalog, &prepared, &checkpoint)?
    {
        CreatedStandaloneSession::from_completed_target(&target)?
    } else {
        if pending.is_none() {
            return Err(CliError("completed upgrade has no saved target".into()).into());
        }
        if runtime_build_id(&replacement_plan.context.runtime)? != prepared.target_build_id {
            return Err(CliError(
                "saved upgrade runtime no longer matches its inspected build".into(),
            )
            .into());
        }
        // Emit the durable retry address before the first destructive action.
        // A retry with this id does not require the old source or fresh hints.
        eprintln!(
            "hmux: upgrade operation {operation_id}; retry with --operation-id {operation_id}"
        );
        let _source_lock = prepared.source.lock()?;
        prepared
            .source
            .stop(Duration::from_millis(args.timeout_ms))?;
        match StandaloneSessionCreator::new(&replacement_plan.context.runtime)
            .with_discovery_root(target_catalog.discovery_root())
            .create(replacement_plan.create.clone())
        {
            Ok(created) => created,
            Err(error) => {
                if json {
                    let source = &prepared.source.generation().fence;
                    super::output::writeln(format_args!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "ok": false,
                            "outcome": "source_terminated_replacement_failed",
                            "sourceSessionId": source.session_id,
                            "sourceWorkspaceId": source.workspace_id,
                            "targetBuildId": prepared.target_build_id,
                            "reason": error.code(),
                            "operationId": operation_id,
                            "recovery": format!("retry this saved upgrade with --operation-id {operation_id}"),
                        }))?
                    ))?;
                }
                return Err(error.into());
            }
        }
    };
    let session = replacement.session();
    if session.descriptor().host_build_version != prepared.target_build_id
        || probe_local_session_exact(&target_catalog, session.descriptor())
            != SessionProbeStatus::Healthy
    {
        return Err(CliError(
            "saved upgrade target has not passed its expected-build handshake".into(),
        )
        .into());
    }
    if let Some(mut reservation) = pending {
        let target = CompletedStandaloneTarget::from_created(
            replacement.receipt().clone(),
            session.descriptor(),
        )?;
        standalone_upgrade::complete_target(&mut reservation, &target)?;
    }
    print_receipt(
        json,
        "rehosted",
        &prepared.source,
        &prepared.source_build_id,
        &prepared.target_build_id,
        session,
        Some(operation_id),
    )?;
    if args.foreground {
        attach_foreground(session, false)?;
    }
    Ok(())
}

fn decode_launch(
    action: &str,
    checkpoint: &journal::RecoveryOperationCheckpoint,
) -> Result<Option<StandaloneCreateRequest>, String> {
    match action {
        "restore_plain_shell_for_attach" | "restore_saved_plain_shell_for_attach" => {
            journal::prepared_standalone_create::read_request(checkpoint).map(Some)
        }
        _ => Ok(None),
    }
}

fn print_receipt(
    json: bool,
    outcome: &str,
    source: &StandaloneReplacementSource,
    source_build_id: &str,
    target_build_id: &str,
    replacement: &LocalSession,
    operation_id: Option<&str>,
) -> Result<(), Error> {
    let fence = &source.generation().fence;
    let target = replacement.descriptor();
    if json {
        super::output::writeln(format_args!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "ok": true, "outcome": outcome, "operationId": operation_id,
                "sourceSessionId": fence.session_id, "sourceWorkspaceId": fence.workspace_id,
                "sourceBuildId": source_build_id, "targetBuildId": target_build_id,
                "replacementSessionId": target.session_id, "replacementWorkspaceId": target.workspace_id,
                "sessionName": target.session_name,
            }))?
        ))?;
    } else {
        super::output::writeln(format_args!(
            "Hmux shell \"{}\": {outcome} ({source_build_id} -> {target_build_id})",
            target.session_name.as_deref().unwrap_or("<unnamed>")
        ))?;
    }
    Ok(())
}
