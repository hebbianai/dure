use super::*;
use crate::hmux::{ambiguous_provider_resume_recipe, verified_resurrection_recipe};
use base64::Engine;
use hmux_client::recovery_journal::standalone_launch;
use hmux_client::{
    StandaloneRecipeRequirement, StandaloneRecoveryCreateIdentity, StandaloneUpgradeDecision,
    StandaloneUpgradePolicyInput, evaluate_standalone_upgrade_policy,
};

pub(super) fn prepare<R: tauri::Runtime>(
    app: &AppHandle<R>,
    catalog: &LocalSessionCatalog,
    request: &StandaloneUpgradeRequest,
    operation_root: Option<&std::path::Path>,
) -> Result<Preparation, String> {
    let current = runtime::ensure_current_build(app)?;
    let refuse = |reason, confirmation| {
        Preparation::Refused(Box::new(refusal(
            request,
            current.build_id.clone(),
            reason,
            confirmation,
        )))
    };
    let source = match catalog.open(&SessionSelector::new(
        &request.session_id,
        Some(request.workspace_id.clone()),
    )) {
        Ok(source) => source,
        Err(error) if error.is_session_absent() => {
            return Ok(refuse("upgrade_source_missing", false));
        }
        Err(error) => return Err(message(error)),
    };
    let exact_source = StandaloneReplacementSource::from_session(&source).map_err(message)?;
    let source_lock = exact_source.lock()?;
    let source = exact_source.open().map_err(message)?;
    let descriptor = source.descriptor();
    if descriptor.session_class != SessionClass::Standalone
        || descriptor.session_name.as_deref() != Some(&request.session_name)
    {
        return Ok(refuse("upgrade_source_identity_mismatch", false));
    }
    let source_healthy = descriptor.lifecycle == SessionLifecycle::Ready
        && probe_local_session_exact(catalog, descriptor) == SessionProbeStatus::Healthy;
    if source_healthy && descriptor.host_build_version == current.build_id {
        return Ok(Preparation::Prepared(
            Box::new(PreparedUpgrade {
                source: exact_source,
                source_build_id: descriptor.host_build_version.clone(),
                target_build_id: current.build_id,
                replacement: None,
            }),
            source_lock,
        ));
    }
    let create =
        match standalone_launch::read_for_session(catalog, &source, decode_launch)? {
            Some(create) => create,
            None => {
                let Some(recipe) =
                    verified_resurrection_recipe(catalog.discovery_root(), &request.session_name)
                else {
                    return Ok(refuse("verified_resurrection_recipe_required", false));
                };
                recipe.to_create_request().map_err(message)?
            }
        };
    if let Some(reason) = ambiguous_provider_resume_recipe(create.command()) {
        return Ok(refuse(reason, false));
    }
    match evaluate_standalone_upgrade_policy(StandaloneUpgradePolicyInput {
        verified_recipe: true,
        source_healthy,
        target_build_differs: descriptor.host_build_version != current.build_id,
        confirmed: request.confirmed,
    }) {
        StandaloneUpgradeDecision::Refused {
            reason,
            requires_confirmation,
        } => {
            return Ok(refuse(reason, requires_confirmation));
        }
        StandaloneUpgradeDecision::AlreadyCurrent => {
            return Err("hmux_upgrade_inconsistent: current source failed its handshake".into());
        }
        StandaloneUpgradeDecision::Rehost => {}
    }
    let source_build_id = descriptor.host_build_version.clone();
    let target = recovery::request_fingerprint(&[
        "standalone_upgrade_target_v1",
        &request.upgrade_id,
        &descriptor.workspace_id,
        &descriptor.session_id,
        &descriptor.host_instance_id,
        &descriptor.terminal_epoch,
    ]);
    let mut proof = [0_u8; 32];
    getrandom::fill(&mut proof)
        .map_err(|_| "hmux_recovery_random_failed: launch proof generation failed".to_string())?;
    let predecessor = exact_source.presentation_predecessor()?;
    let requirement = create
        .recovery_identity()
        .map_or(StandaloneRecipeRequirement::Existing, |identity| {
            identity.recipe_requirement()
        });
    let identity = StandaloneRecoveryCreateIdentity::new(
        format!("standalone_{}", &target[..12]),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(proof),
    )
    .and_then(|identity| {
        identity
            .with_recipe_requirement(requirement)
            .with_source_predecessor(predecessor)
    })
    .map_err(message)?;
    let create = create
        .without_recovery_identity()
        .with_recovery_identity(identity)
        .map_err(message)?;
    // An old, unprepared reservation keeps its original launch namespace.
    // Fresh intent belongs to the exact source and freezes the caller's target.
    let target_root = operation_root.unwrap_or(catalog.discovery_root());
    let create = create
        .with_negotiated_recovery_operation(
            &request.upgrade_id,
            operation_root.unwrap_or(exact_source.discovery_root()),
            target_root,
            &current.capabilities()?,
        )
        .map_err(message)?;
    let checkout = crate::session_checkout::checkout_for_session(
        current.runtime,
        exact_source.discovery_root().to_path_buf(),
        source,
    )?;
    Ok(Preparation::Prepared(
        Box::new(PreparedUpgrade {
            source: exact_source,
            source_build_id,
            target_build_id: current.build_id,
            replacement: Some(PreparedReplacement {
                discovery_root: Some(target_root.to_path_buf()),
                create,
                context: CheckoutContext { checkout },
            }),
        }),
        source_lock,
    ))
}

fn decode_launch(
    action: &str,
    checkpoint: &recovery::RecoveryOperationCheckpoint,
) -> Result<Option<StandaloneCreateRequest>, String> {
    if let Some(create) = crate::hmux::conversion::read_standalone_launch(action, checkpoint)? {
        return Ok(Some(create));
    }
    crate::hmux::plain_shell_recovery::read_standalone_launch(action, checkpoint)
}

fn refusal(
    request: &StandaloneUpgradeRequest,
    target_build_id: String,
    reason: &str,
    requires_confirmation: bool,
) -> StandaloneUpgradeReceipt {
    StandaloneUpgradeReceipt {
        source_session_id: request.session_id.clone(),
        source_workspace_id: request.workspace_id.clone(),
        source_build_id: None,
        target_build_id,
        action: "none",
        outcome: "refused",
        replayed: false,
        reason: Some(reason.to_string()),
        requires_confirmation,
        replacement_session: None,
    }
}
