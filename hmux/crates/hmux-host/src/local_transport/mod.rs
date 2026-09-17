//! OS byte carriers implementing the shared session framing contract.
//!
//! These reexports preserve existing Host paths without a second framing driver.

pub use hmux_session_protocol::transport::*;

#[cfg(unix)]
pub use hmux_local_platform::transport::fd;
#[cfg(windows)]
pub use hmux_local_platform::transport::windows_named_pipe;
