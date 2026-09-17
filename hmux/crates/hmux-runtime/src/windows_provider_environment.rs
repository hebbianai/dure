use super::WindowsHostLaunchPacket;
use hmux_host::local_protocol::SessionFence;
use hmux_runtime_contract::{
    HMUX_CHANNEL_EPOCH_ENV, HMUX_ENV, HMUX_HOST_INSTANCE_ID_ENV, HMUX_RUNNER_INSTANCE_ENV,
    HMUX_RUNNER_PRINCIPAL_ENV, HMUX_SESSION_ID_ENV, HMUX_SESSION_NAME_ENV, HMUX_TERMINAL_EPOCH_ENV,
    HMUX_WORKSPACE_ID_ENV, interactive_terminal_environment_policy,
    launching_client_session_env_keys,
};
use std::ffi::OsString;

pub(super) fn provider_environment(
    packet: &WindowsHostLaunchPacket,
    fence: &SessionFence,
) -> Vec<(OsString, Option<OsString>)> {
    let policy = interactive_terminal_environment_policy(&packet.terminal_environment);
    let mut changes = launching_client_session_env_keys(
        std::env::vars_os().filter_map(|(key, _)| key.into_string().ok()),
    )
    .into_iter()
    .map(|key| (OsString::from(key), None))
    .chain(
        policy
            .remove()
            .iter()
            .map(|key| (OsString::from(key), None)),
    )
    .chain(
        policy
            .set()
            .iter()
            .map(|(key, value)| (OsString::from(key), Some(OsString::from(value)))),
    )
    .chain(
        packet
            .provider_state_environment
            .removals()
            .iter()
            .map(|key| (OsString::from(key), None)),
    )
    .chain(
        packet
            .provider_state_environment
            .values()
            .iter()
            .map(|(key, value)| (OsString::from(key), Some(OsString::from(value)))),
    )
    .collect::<Vec<_>>();
    let session_name = packet.session_name.as_deref().unwrap_or(&packet.session_id);
    for (key, value) in [
        (HMUX_ENV, "1"),
        (HMUX_SESSION_ID_ENV, packet.session_id.as_str()),
        (HMUX_SESSION_NAME_ENV, session_name),
        (HMUX_WORKSPACE_ID_ENV, packet.workspace_id.as_str()),
        (HMUX_RUNNER_PRINCIPAL_ENV, fence.runner_principal.as_str()),
        (HMUX_RUNNER_INSTANCE_ENV, fence.runner_instance.as_str()),
        (HMUX_CHANNEL_EPOCH_ENV, "1"),
        (HMUX_HOST_INSTANCE_ID_ENV, fence.host_instance_id.as_str()),
        (HMUX_TERMINAL_EPOCH_ENV, fence.terminal_epoch.as_str()),
    ] {
        changes.push((OsString::from(key), Some(OsString::from(value))));
    }
    changes
}
