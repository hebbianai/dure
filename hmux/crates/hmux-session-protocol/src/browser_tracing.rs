//! Trace and profiler share one browser-instance interval, independently of input.
use crate::browser_resource::{
    counter, BrowserControllerLease, BrowserInstanceId, BrowserOperationId, BrowserPageIdentity,
    BrowserResourceIdentity,
};
use serde::{Deserialize, Serialize};
use std::num::NonZeroU64;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserTracingStopAuthority {
    pub lease: BrowserControllerLease,
    #[serde(with = "counter")]
    pub command_sequence: NonZeroU64,
    pub operation_id: BrowserOperationId,
    pub instance_id: BrowserInstanceId,
    pub recording: BrowserOperationId,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserTracingMode {
    Trace,
    Profiler,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserTracingScope {
    #[default]
    Task,
    Browser,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserTracingPhase {
    Starting,
    Recording,
    Finished,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BrowserTracingInterval {
    pub resource: BrowserResourceIdentity,
    /// Capture provenance, never authority to input into a retired document.
    pub origin: BrowserPageIdentity,
    pub operation_id: BrowserOperationId,
    pub mode: BrowserTracingMode,
    pub scope: BrowserTracingScope,
    pub phase: BrowserTracingPhase,
    pub cleanup_confirmed: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BrowserTracingStatus {
    pub resource: BrowserResourceIdentity,
    pub instance_id: BrowserInstanceId,
    pub busy: bool,
    /// A peer can observe contention, but cannot acquire this interval's identity.
    pub interval: Option<BrowserTracingInterval>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BrowserTracingPageStatus {
    pub page: BrowserPageIdentity,
    #[serde(flatten)]
    pub tracing: BrowserTracingStatus,
}
