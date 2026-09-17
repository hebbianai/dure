use std::time::Duration;

use hmux_client::{
    LocalSession, SessionClass, SessionFence, SessionSelector, TerminalSurfaceAccess,
    TerminalSurfaceAttachment,
};
use serde::Deserialize;

use crate::hmux_input_contract::{
    project_command_input_receipt, send_fresh_agent_prompt, HmuxCommandInputReceipt,
    HmuxInitialAgentPromptReceipt, HmuxInputFailure,
};

use super::{product_catalog, validate_identifier, ManagedStopFence};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HmuxCommandInputRequest {
    session_id: String,
    workspace_id: String,
    expected_fence: Option<ManagedStopFence>,
    text: String,
    submit: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HmuxInitialAgentPromptRequest {
    session_id: String,
    workspace_id: String,
    expected_fence: ManagedStopFence,
    prompt: String,
}

#[tauri::command]
pub(crate) async fn hmux_command_input(
    request: HmuxCommandInputRequest,
) -> Result<HmuxCommandInputReceipt, HmuxInputFailure> {
    tauri::async_runtime::spawn_blocking(move || send_local_command(request))
        .await
        .map_err(|error| {
            HmuxInputFailure::unknown("hmux_command_input_task_failed", error.to_string())
        })?
}

#[tauri::command]
pub(crate) async fn hmux_initial_agent_prompt(
    request: HmuxInitialAgentPromptRequest,
) -> Result<HmuxInitialAgentPromptReceipt, HmuxInputFailure> {
    tauri::async_runtime::spawn_blocking(move || send_local_initial_agent_prompt(request))
        .await
        .map_err(|error| {
            HmuxInputFailure::unknown("hmux_initial_agent_prompt_task_failed", error.to_string())
        })?
}

fn send_local_command(
    request: HmuxCommandInputRequest,
) -> Result<HmuxCommandInputReceipt, HmuxInputFailure> {
    let session = open_local_input_session(
        &request.session_id,
        &request.workspace_id,
        request.expected_fence.as_ref(),
    )?;
    let mut surface = connect_writer_surface(session)?;
    let receipt = surface
        .send_command_input_confirmed(request.text, request.submit, Duration::from_secs(10))
        .map_err(HmuxInputFailure::from_command_input)?;
    let projected = project_command_input_receipt(&receipt);
    let _ = surface.detach();
    Ok(projected)
}

pub(crate) fn send_local_standalone_commands(
    session_id: &str,
    workspace_id: &str,
    commands: impl IntoIterator<Item = String>,
    timeout: Duration,
) -> Result<Option<String>, String> {
    let session = open_local_input_session(session_id, workspace_id, None)
        .map_err(|error| error.to_string())?;
    let mut surface = connect_writer_surface(session).map_err(|error| error.to_string())?;
    let result = commands.into_iter().try_fold(None, |_, command| {
        let receipt = surface
            .send_command_input_confirmed(command, true, timeout)
            .map_err(HmuxInputFailure::from_command_input)?;
        Ok::<_, HmuxInputFailure>(
            receipt
                .submit()
                .map(|receipt| receipt.in_reply_to_record_id.to_string()),
        )
    });
    let _ = surface.detach();
    result.map_err(|error| error.to_string())
}

fn send_local_initial_agent_prompt(
    request: HmuxInitialAgentPromptRequest,
) -> Result<HmuxInitialAgentPromptReceipt, HmuxInputFailure> {
    let fence = local_input_fence(
        &request.session_id,
        &request.workspace_id,
        &request.expected_fence,
    )?;
    let catalog = product_catalog().map_err(HmuxInputFailure::from_client)?;
    let selector = local_input_selector(&request.session_id, &request.workspace_id)?;
    let provider_id = catalog
        .find(&selector)
        .map_err(HmuxInputFailure::from_client)?
        .provider_id;
    let mut surface = TerminalSurfaceAttachment::connect_local_agent_prompt(&catalog, &fence)
        .map_err(HmuxInputFailure::from_client)?;
    let projected = send_fresh_agent_prompt(
        &mut surface,
        &provider_id,
        request.prompt,
        Duration::from_secs(10),
    )?;
    let _ = surface.detach();
    Ok(projected)
}

fn open_local_input_session(
    session_id: &str,
    workspace_id: &str,
    expected_fence: Option<&ManagedStopFence>,
) -> Result<LocalSession, HmuxInputFailure> {
    let selector = local_input_selector(session_id, workspace_id)?;
    let catalog = product_catalog().map_err(HmuxInputFailure::from_client)?;
    let descriptor = catalog
        .find(&selector)
        .map_err(HmuxInputFailure::from_client)?;
    let session = match descriptor.session_class {
        SessionClass::Managed => {
            let expected = expected_fence.ok_or_else(|| {
                HmuxInputFailure::not_written(
                    "hmux_expected_generation_required",
                    "managed input requires a complete generation fence",
                )
            })?;
            let fence = local_input_fence(session_id, workspace_id, expected)?;
            catalog
                .open_current_managed_for_mutation(&selector, &fence)
                .map_err(HmuxInputFailure::from_client)?
        }
        SessionClass::Standalone => {
            if expected_fence.is_some() {
                return Err(HmuxInputFailure::not_written(
                    "hmux_command_input_fence_invalid",
                    "standalone command input must not carry a managed fence",
                ));
            }
            catalog
                .open(&selector)
                .map_err(HmuxInputFailure::from_client)?
        }
    };
    Ok(session)
}

fn local_input_selector(
    session_id: &str,
    workspace_id: &str,
) -> Result<SessionSelector, HmuxInputFailure> {
    validate_identifier("session id", session_id)
        .map_err(|message| HmuxInputFailure::not_written("hmux_command_input_invalid", message))?;
    validate_identifier("workspace id", workspace_id)
        .map_err(|message| HmuxInputFailure::not_written("hmux_command_input_invalid", message))?;
    Ok(SessionSelector::new(
        session_id,
        Some(workspace_id.to_string()),
    ))
}

fn local_input_fence(
    session_id: &str,
    workspace_id: &str,
    expected: &ManagedStopFence,
) -> Result<SessionFence, HmuxInputFailure> {
    expected.validate().map_err(|message| {
        HmuxInputFailure::not_written("hmux_expected_generation_invalid", message)
    })?;
    let channel_epoch = expected.channel_epoch.parse::<u64>().map_err(|_| {
        HmuxInputFailure::not_written(
            "hmux_expected_generation_invalid",
            "managed input channel epoch is invalid",
        )
    })?;
    Ok(SessionFence {
        workspace_id: workspace_id.to_string(),
        session_id: session_id.to_string(),
        runner_principal: expected.runner_principal.clone(),
        runner_instance: expected.runner_instance.clone(),
        channel_epoch,
        host_instance_id: expected.host_instance_id.clone(),
        terminal_epoch: expected.terminal_epoch.clone(),
    })
}

fn connect_writer_surface(
    session: LocalSession,
) -> Result<TerminalSurfaceAttachment, HmuxInputFailure> {
    let connection = session
        .connect_with_options(TerminalSurfaceAttachment::connection_options(
            TerminalSurfaceAccess::Writer,
            None,
        ))
        .map_err(HmuxInputFailure::from_client)?;
    TerminalSurfaceAttachment::from_connection(connection).map_err(HmuxInputFailure::from_client)
}
