//! One Hmux client connection's protocol and lifecycle boundaries.

#[cfg(feature = "terminal-state-stream")]
mod attach_seed;
mod protocol;
mod transport;

#[cfg(feature = "terminal-state-stream")]
pub(crate) use attach_seed::{
    prepare_terminal_viewport, refuse_terminal_viewport_attach, seed_terminal_delivery,
};
pub(crate) use protocol::{
    AttachReply, FIRST_OUTBOUND_FRAME_ID, attach_reply, run_subscriber_outbound, send_body,
    write_error, write_error_before,
};
pub(crate) use transport::ClientTransport;
