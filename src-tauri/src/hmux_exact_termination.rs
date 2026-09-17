use hmux_client::{
    liveness_state_name, probe_local_session_exact, project_session_liveness, LivenessState,
    LocalSession, LocalSessionCatalog, ManagedStopOutcome, Recoverability, SessionClass,
    SessionDescriptor, SessionLifecycle, SessionLivenessInput, SessionProbeStatus, SessionSelector,
};
use hmux_client::recovery_journal::managed_create_ledger::ManagedSessionRetirementObservation;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::time::Duration;

#[tauri::command]
pub(crate) async fn hmux_managed_session_retirement(
    session_id: String,
    workspace_id: String,
) -> Result<ManagedSessionRetirementObservation, String> {
    validate_identifier("session id", &session_id)?;
    validate_identifier("workspace id", &workspace_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        LocalSessionCatalog::from_environment()
            .and_then(|catalog| {
                catalog.read_managed_session_retirement(&session_id, &workspace_id)
            })
            .map_err(|error| format!("{}: {error}", error.code()))
    })
    .await
    .map_err(|error| format!("managed retirement observation failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn hmux_managed_stop_completed(
    stop_id: String,
    fence: hmux_client::SessionFence,
) -> Result<Option<hmux_client::ManagedStopReceipt>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let request =
            hmux_client::ManagedStopRequest::new(stop_id, fence.session_id, fence.workspace_id)
                .and_then(|request| {
                    request.with_expected_fence(
                        fence.runner_principal,
                        fence.runner_instance,
                        fence.channel_epoch,
                        fence.host_instance_id,
                        fence.terminal_epoch,
                    )
                })
                .and_then(|request| {
                    hmux_client::ManagedStopReconcileRequest::from_stop_request(&request)
                })
                .map_err(|error| error.to_string())?;
        LocalSessionCatalog::from_environment()
            .and_then(|catalog| catalog.read_completed_managed_stop(&request))
            .map_err(|error| format!("{}: {error}", error.code()))
    })
    .await
    .map_err(|error| format!("managed stop completion observation failed: {error}"))?
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExactSessionTerminationReceipt {
    pub session_id: String,
    pub workspace_id: String,
    pub terminal_epoch: String,
    pub session_class: SessionClass,
    pub outcome: ExactSessionTerminationOutcome,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExactSessionTerminationOutcome {
    Terminated,
    AlreadyExited,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExactTerminationDecision {
    Terminate,
    AlreadyExited,
}

/// Applies one terminal-generation fence on every desktop adapter. The
/// platform closure is needed only for managed provider shutdown.
pub(crate) fn terminate_exact_session<F>(
    catalog: &LocalSessionCatalog,
    session_id: &str,
    workspace_id: &str,
    terminal_epoch: &str,
    session_class: SessionClass,
    graceful_timeout: Duration,
    stop_managed: F,
) -> Result<ExactSessionTerminationReceipt, String>
where
    F: FnOnce(&SessionDescriptor, String) -> Result<ManagedStopOutcome, String>,
{
    validate_identifier("session id", session_id)?;
    validate_identifier("workspace id", workspace_id)?;
    validate_identifier("terminal epoch", terminal_epoch)?;
    if session_class == SessionClass::Standalone {
        let outcome = crate::session_checkout::close_standalone(
            catalog.clone(), session_id, workspace_id, Some(terminal_epoch), graceful_timeout,
        )?;
        return Ok(ExactSessionTerminationReceipt {
            session_id: session_id.to_owned(),
            workspace_id: workspace_id.to_owned(),
            terminal_epoch: terminal_epoch.to_owned(),
            session_class,
            outcome: match outcome {
                dure_session_runtime::StandaloneCloseOutcome::Terminated => ExactSessionTerminationOutcome::Terminated,
                dure_session_runtime::StandaloneCloseOutcome::AlreadyExited => ExactSessionTerminationOutcome::AlreadyExited,
            },
        });
    }
    let session = match resolve_exact_termination_target(
        catalog,
        SessionSelector::new(session_id, Some(workspace_id.to_string())),
        session_class,
    )? {
        Some(session) => session,
        None => {
            return Ok(ExactSessionTerminationReceipt {
                session_id: session_id.to_string(),
                workspace_id: workspace_id.to_string(),
                terminal_epoch: terminal_epoch.to_string(),
                session_class,
                outcome: ExactSessionTerminationOutcome::AlreadyExited,
            });
        }
    };
    let descriptor = session.descriptor().clone();
    let probe = (descriptor.lifecycle == SessionLifecycle::Ready)
        .then(|| probe_local_session_exact(catalog, &descriptor));
    let decision = exact_termination_decision(
        terminal_epoch,
        &descriptor.terminal_epoch,
        descriptor.lifecycle,
        probe,
    )?;
    if decision == ExactTerminationDecision::AlreadyExited {
        return Ok(ExactSessionTerminationReceipt {
            session_id: descriptor.session_id,
            workspace_id: descriptor.workspace_id,
            terminal_epoch: descriptor.terminal_epoch,
            session_class: descriptor.session_class,
            outcome: ExactSessionTerminationOutcome::AlreadyExited,
        });
    }

    let outcome = match descriptor.session_class {
        SessionClass::Standalone => {
            unreachable!("standalone logical close is handled above")
        }
        SessionClass::Managed => match stop_managed(
            &descriptor,
            exact_stop_id(
                &descriptor.workspace_id,
                &descriptor.session_id,
                &descriptor.terminal_epoch,
            ),
        )? {
            ManagedStopOutcome::Stopped => ExactSessionTerminationOutcome::Terminated,
            ManagedStopOutcome::AlreadyExited => ExactSessionTerminationOutcome::AlreadyExited,
        },
    };

    Ok(ExactSessionTerminationReceipt {
        session_id: descriptor.session_id,
        workspace_id: descriptor.workspace_id,
        terminal_epoch: descriptor.terminal_epoch,
        session_class: descriptor.session_class,
        outcome,
    })
}

fn resolve_exact_termination_target(
    catalog: &LocalSessionCatalog,
    selector: SessionSelector,
    expected_class: SessionClass,
) -> Result<Option<LocalSession>, String> {
    match catalog.open(&selector) {
        Ok(session) if session.descriptor().session_class == expected_class => Ok(Some(session)),
        Ok(_) => Err("hmux_exact_termination_session_class_changed".to_string()),
        Err(error) if error.is_session_absent() => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn exact_termination_decision(
    expected_terminal_epoch: &str,
    current_terminal_epoch: &str,
    lifecycle: SessionLifecycle,
    probe: Option<SessionProbeStatus>,
) -> Result<ExactTerminationDecision, String> {
    if expected_terminal_epoch != current_terminal_epoch {
        return Err("hmux_exact_termination_generation_changed".to_string());
    }
    let liveness = project_session_liveness(SessionLivenessInput {
        lifecycle,
        automatic_recovery_supported: false,
        verified_recipe: false,
        replays_explicit_command: false,
        probe,
    });
    match (liveness.state, liveness.recoverability) {
        (LivenessState::Live, Recoverability::LiveAttach) => {
            Ok(ExactTerminationDecision::Terminate)
        }
        (LivenessState::Exited, _) => Ok(ExactTerminationDecision::AlreadyExited),
        (state, _) => Err(format!(
            "hmux_exact_termination_liveness_{}",
            liveness_state_name(state)
        )),
    }
}

fn exact_stop_id(workspace_id: &str, session_id: &str, terminal_epoch: &str) -> String {
    let mut hash = Sha256::new();
    for member in [workspace_id, session_id, terminal_epoch] {
        hash.update((member.len() as u64).to_be_bytes());
        hash.update(member.as_bytes());
    }
    let digest = hash.finalize();
    format!("exact-stop-{digest:x}")
}

fn validate_identifier(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(format!("{name} must be a bounded non-control string"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn an_absent_managed_generation_converges_to_an_exited_receipt() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let catalog = LocalSessionCatalog::new(root.path());
        let receipt = terminate_exact_session(
            &catalog,
            "session-1",
            "workspace-1",
            "terminal-1",
            SessionClass::Managed,
            Duration::from_millis(1),
            |_, _| panic!("absent managed session cannot dispatch stop"),
        )
        .unwrap();

        assert_eq!(receipt.session_id, "session-1");
        assert_eq!(receipt.workspace_id, "workspace-1");
        assert_eq!(receipt.terminal_epoch, "terminal-1");
        assert_eq!(receipt.session_class, SessionClass::Managed);
        assert_eq!(
            receipt.outcome,
            ExactSessionTerminationOutcome::AlreadyExited
        );
    }

    #[test]
    fn only_an_exact_live_generation_can_cross_the_destructive_boundary() {
        assert_eq!(
            exact_termination_decision(
                "epoch-1",
                "epoch-1",
                SessionLifecycle::Ready,
                Some(SessionProbeStatus::Healthy),
            )
            .unwrap(),
            ExactTerminationDecision::Terminate
        );
        assert_eq!(
            exact_termination_decision("epoch-1", "epoch-1", SessionLifecycle::Exited, None,)
                .unwrap(),
            ExactTerminationDecision::AlreadyExited
        );
    }

    #[test]
    fn an_unknown_or_changed_generation_fails_closed() {
        for probe in [
            None,
            Some(SessionProbeStatus::StaleTransport),
            Some(SessionProbeStatus::IncompatibleProtocol),
            Some(SessionProbeStatus::GenerationChanged),
        ] {
            assert!(exact_termination_decision(
                "epoch-1",
                "epoch-1",
                SessionLifecycle::Ready,
                probe,
            )
            .is_err());
        }
        assert_eq!(
            exact_termination_decision(
                "epoch-1",
                "epoch-2",
                SessionLifecycle::Ready,
                Some(SessionProbeStatus::Healthy),
            )
            .unwrap_err(),
            "hmux_exact_termination_generation_changed"
        );
    }

    #[test]
    fn managed_stop_id_is_stable_and_identity_scoped() {
        assert_eq!(
            exact_stop_id("workspace", "session", "epoch"),
            exact_stop_id("workspace", "session", "epoch")
        );
        assert_ne!(
            exact_stop_id("workspace", "session", "epoch"),
            exact_stop_id("workspace", "session", "replacement")
        );
    }
}
