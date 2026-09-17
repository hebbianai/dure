//! Page recording identity survives document navigation and control handoff.

use crate::browser_resource::{BrowserOperationId, BrowserPageIdentity, BrowserResourcePhase};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BrowserRecordingStatus {
    pub page: BrowserPageIdentity,
    pub phase: BrowserResourcePhase,
    /// The admitted start operation identifies the recording, not its local file.
    pub operation_id: Option<BrowserOperationId>,
    /// Native capture has finished; its retained interval awaits the stop action.
    pub finished: bool,
}
