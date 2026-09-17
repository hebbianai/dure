//! Local OS capabilities shared by the session Host and its clients.
//!
//! Kernel credentials, carrier IO, and private files live here. Session
//! lifecycle, discovery publication, and recovery transactions remain with
//! their callers; this crate has no Host, Client, or runtime dependency.

#![forbid(unsafe_op_in_unsafe_fn)]

pub mod local_peer_identity;
pub mod peer_attestation;
pub mod private_storage;
pub mod transport;
#[cfg(windows)]
mod windows_security;
