#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(all(unix, feature = "provider-conformance-test-support"))]
pub(crate) use unix::run_unix_bound_command_with_pre_exec_barrier;
#[cfg(unix)]
pub(crate) use unix::{run_unix_bound_command, spawn, spawn_bound};
#[cfg(windows)]
pub(crate) use windows::spawn;
