//! OS carriers for the shared framing contract.

pub use hmux_session_protocol::transport::*;

#[cfg(unix)]
pub mod fd;
#[cfg(windows)]
pub mod windows_named_pipe;
