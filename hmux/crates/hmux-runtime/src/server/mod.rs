//! Hmux Host server-side runtime domains.

mod client_connection;
mod provider_process;

pub(crate) use client_connection::{
    AttachReply, ClientTransport, FIRST_OUTBOUND_FRAME_ID, attach_reply, run_subscriber_outbound,
    send_body, write_error, write_error_before,
};
#[cfg(feature = "terminal-state-stream")]
pub(crate) use client_connection::{
    prepare_terminal_viewport, refuse_terminal_viewport_attach, seed_terminal_delivery,
};
pub(crate) use provider_process::{
    ProviderProcessControl, ProviderTermination, cleanup_unproven_provider_child,
    expected_provider_identity_program, process_proof, provider_exit_status, resolve_command,
    wait_for_provider,
};
