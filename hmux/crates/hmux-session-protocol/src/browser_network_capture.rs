//! HTTP metadata retained for an explicitly recorded page interval.

use crate::browser_network::BrowserNetworkRequest;
use crate::browser_resource::BrowserPageIdentity;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserNetworkHeader {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserNetworkRequestDetails {
    pub url: String,
    pub headers: Vec<BrowserNetworkHeader>,
    pub post_data: Option<String>,
    pub wall_time: f64,
    pub timestamp: f64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserNetworkTiming {
    pub request_time: f64,
    pub dns_start: f64,
    pub dns_end: f64,
    pub connect_start: f64,
    pub connect_end: f64,
    pub ssl_start: f64,
    pub ssl_end: f64,
    pub send_start: f64,
    pub send_end: f64,
    pub receive_headers_end: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserNetworkResponseDetails {
    pub status_text: String,
    pub protocol: String,
    pub headers: Vec<BrowserNetworkHeader>,
    pub mime_type: String,
    pub encoded_data_length: Option<u64>,
    pub timing: Option<BrowserNetworkTiming>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserNetworkCaptureEntry {
    pub request: BrowserNetworkRequest,
    pub source: String,
    pub details: BrowserNetworkRequestDetails,
    pub response: Option<BrowserNetworkResponseDetails>,
    pub completed_timestamp: Option<f64>,
    pub body_size: Option<u64>,
    pub decoded_body_size: Option<u64>,
    pub encoded_data_length: Option<u64>,
}

impl BrowserNetworkCaptureEntry {
    pub fn metadata_truncated(&self) -> bool {
        self.request.metadata_truncated
            || self.details.truncated
            || self
                .response
                .as_ref()
                .is_some_and(|response| response.truncated)
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BrowserNetworkCaptureStatus {
    pub page: BrowserPageIdentity,
    pub recording: bool,
    pub recorded: usize,
    pub complete: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BrowserNetworkCapture {
    pub page: BrowserPageIdentity,
    pub complete: bool,
    pub truncated: bool,
    pub entries: Vec<BrowserNetworkCaptureEntry>,
}
