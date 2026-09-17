//! Provider-neutral foundations for a persistent terminal session host.
//!
//! Process spawning and orchestration authorization intentionally live outside
//! this crate. The host exposes fenced protocol, secure local discovery,
//! kernel-backed local peer identity, and bounded terminal replay primitives
//! that an adapter can compose without giving Hmux scheduling ownership.

#![forbid(unsafe_op_in_unsafe_fn)]

pub mod local_discovery;
pub use hmux_local_platform::{local_peer_identity, peer_attestation};
// Preserve the public Host path while the shared crate owns every definition.
pub use hmux_session_protocol as local_protocol;
#[cfg(feature = "local-runtime")]
pub mod browser_network;
#[cfg(feature = "local-runtime")]
pub mod browser_resource;
#[cfg(feature = "local-runtime")]
pub mod browser_workspace;
pub mod local_transport;
pub mod provider_epoch;
// Hosting a session is a property of the machine the PTY lives on. Nothing
// outside this crate's own runtime consumes either module — the client crate
// touches only discovery, protocol, transport, attestation and provider
// epochs — so gating them here costs no consumer a single edit while keeping
// the replay engine out of a build that can never run one.
#[cfg(feature = "local-runtime")]
pub mod session_host;
#[cfg(feature = "local-runtime")]
pub mod terminal_replay;
