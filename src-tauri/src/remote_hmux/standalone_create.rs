use super::*;

pub(super) async fn execute(
    app: tauri::AppHandle,
    state: State<'_, crate::AppState>,
    request: RemoteHmuxStandaloneCreateCommand,
) -> Result<RemoteHmuxStandaloneCreateReceipt, String> {
    let ssh = build_config(&request.target)?;
    let cleanup_ssh = build_config(&request.target)?;
    let account_ssh = request.target.ssh_options();
    let hmux = Arc::clone(&state.hmux);
    let host_id = request.target.host_id.clone();
    let catalog =
        hmux_client::LocalSessionCatalog::from_environment().map_err(|error| error.to_string())?;
    let discovery_root = catalog.discovery_root().to_path_buf();
    // A newly trusted machine at the same address cannot inherit this launch.
    let mut host_keys = request.target.host_key_fingerprints.clone();
    host_keys.sort_unstable();
    host_keys.dedup();
    let scope = hmux_client::recovery_journal::request_fingerprint(&[
        &request.pending_owner_id,
        &request.target.host_id,
        &request.target.host,
        &request.target.port.to_string(),
        &request.target.user,
        &host_keys.join(","),
    ]);
    let pending_owner_id = request.pending_owner_id;
    let cleanup_request_id = request.request_id.clone();
    let create = RemoteStandaloneCreateRequest {
        request_id: request.request_id,
        target_session_id: request.target_session_id,
        launch_owner_proof: request.launch_owner_proof,
        session_name: request.session_name,
        bridge_nonce: request.bridge_nonce,
        cwd: request.cwd,
        initial_rows: request.initial_rows,
        initial_columns: request.initial_columns,
        command_intercepts: request
            .command_intercepts
            .into_iter()
            .map(|intercept| RemoteCommandIntercept {
                command: intercept.command,
                provider_id: intercept.provider_id,
            })
            .collect(),
        retirement_policy: Some(
            SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                grace_period_ms: REMOTE_APP_STANDALONE_RETIREMENT_GRACE_MS,
            },
        ),
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::remote_hmux_install::ensure_available(&app, &account_ssh)?;
        let retained = hmux_ssh_transport::create_standalone_durably_over_ssh(
            &discovery_root,
            &scope,
            ssh,
            create,
            CREATE_TIMEOUT,
        )
        .map_err(|error| format!("{}: {error}", error.code()))?;
        let receipt = retained.receipt;
        let launch_owner_proof = retained.launch_owner_proof;
        if let Err(registration_error) = hmux.register_pending_remote_pane_creation(
            pending_owner_id,
            host_id,
            receipt.session.clone(),
            launch_owner_proof.clone(),
        ) {
            let cleanup = RemoteUnpresentedCreationAbandonRequest {
                request_id: cleanup_request_id,
                session_id: receipt.session.session_id.clone(),
                workspace_id: receipt.session.workspace_id.clone(),
                launch_owner_proof,
            };
            let cleanup_detail =
                match abandon_unpresented_creation_over_ssh(cleanup_ssh, cleanup, CREATE_TIMEOUT) {
                    Ok(_) => "the unpresented remote Host was retired".to_string(),
                    Err(error) => format!(
                        "safe unpresented-create cleanup also failed ({}: {error})",
                        error.code()
                    ),
                };
            return Err(format!("{registration_error}; {cleanup_detail}"));
        }
        Ok(RemoteHmuxStandaloneCreateReceipt {
            request_id: receipt.request_id,
            bridge_nonce: receipt.bridge_nonce,
            session: receipt.session.into(),
        })
    })
    .await
    .map_err(|error| format!("remote_hmux_create_task_failed: {error}"))?
}
