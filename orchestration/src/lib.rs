//! Product-neutral durable orchestration boundaries.
//!
//! This crate owns the neutral interaction transitions and Store boundary.
//! The detached Dure control plane hosts this service; product and remote
//! clients reach it through the same versioned operation and Event cursor.

#![forbid(unsafe_code)]

pub mod contract;
pub mod domain;
pub mod ports;
pub mod service;
