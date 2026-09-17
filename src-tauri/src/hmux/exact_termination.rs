use super::{managed_stop_request_for_descriptor, product_catalog, runtime};
use crate::hmux_exact_termination::{terminate_exact_session, ExactSessionTerminationReceipt};
use hmux_client::{ManagedSessionStopper, SessionClass};
use std::time::Duration;
use tauri::AppHandle;

pub(super) fn terminate<R: tauri::Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    workspace_id: &str,
    terminal_epoch: &str,
    session_class: SessionClass,
    graceful_timeout: Duration,
) -> Result<ExactSessionTerminationReceipt, String> {
    let catalog = product_catalog().map_err(|error| error.to_string())?;
    terminate_exact_session(
        &catalog,
        session_id,
        workspace_id,
        terminal_epoch,
        session_class,
        graceful_timeout,
        |descriptor, stop_id| {
            let current = runtime::ensure_current_build(app)?;
            let working_directory = current
                .runtime
                .parent()
                .ok_or_else(|| "managed Hmux runtime has no parent directory".to_string())?;
            let request = managed_stop_request_for_descriptor(stop_id, descriptor)?;
            let receipt = ManagedSessionStopper::new(&current.runtime, working_directory)
                .stop(request)
                .map_err(|error| error.to_string())?;
            Ok(receipt.outcome())
        },
    )
}
