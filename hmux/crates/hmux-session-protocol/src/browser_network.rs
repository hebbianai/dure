//! Bounded browser request observations, independent of terminal transport.

use crate::browser_resource::BrowserPageIdentity;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct BrowserNetworkSequence(
    #[serde(with = "crate::browser_resource::counter")] pub std::num::NonZeroU64,
);

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserNetworkBody {
    pub data: String,
    pub base64_encoded: bool,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserNetworkDetail {
    pub page: BrowserPageIdentity,
    pub request: BrowserNetworkRequest,
    pub details: Option<crate::browser_network_capture::BrowserNetworkRequestDetails>,
    pub response: Option<crate::browser_network_capture::BrowserNetworkResponseDetails>,
    pub metadata_truncated: bool,
    pub body: Option<BrowserNetworkBody>,
    pub body_error: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserNetworkState {
    Pending,
    Finished,
    Failed,
    Redirected,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserNetworkRequest {
    /// Resource-local sequence, serialized exactly for JavaScript clients.
    pub sequence: String,
    pub url: String,
    pub method: String,
    pub resource_type: String,
    pub status: Option<u16>,
    pub state: BrowserNetworkState,
    pub error: Option<String>,
    pub metadata_truncated: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BrowserNetworkSnapshot {
    pub page: BrowserPageIdentity,
    pub complete: bool,
    pub pending: usize,
    /// Host decides idle only after 500 ms with complete coverage and no request.
    pub idle: bool,
    pub quiet_ms: Option<u64>,
    pub history_truncated: bool,
    pub requests: Vec<BrowserNetworkRequest>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_sequences_keep_exact_positive_wire_identity() {
        for value in ["1", "9007199254740993", "18446744073709551615"] {
            let sequence: BrowserNetworkSequence =
                serde_json::from_value(serde_json::json!(value)).unwrap();
            assert_eq!(serde_json::to_value(sequence).unwrap(), value);
        }
        for invalid in [
            serde_json::json!(1),
            serde_json::json!("0"),
            serde_json::json!("01"),
            serde_json::json!("+1"),
            serde_json::json!("18446744073709551616"),
        ] {
            assert!(serde_json::from_value::<BrowserNetworkSequence>(invalid).is_err());
        }
    }
}
