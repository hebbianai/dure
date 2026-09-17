use super::{Monitor, field};
use hmux_host::browser_network::BrowserNetworkId;
use hmux_session_protocol::browser_network_capture::*;
use serde_json::Value;
use std::time::Instant;

fn text(value: &Value, limit: usize, truncated: &mut bool) -> String {
    let value = value.as_str().unwrap_or("");
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    *truncated |= end < value.len();
    value[..end].into()
}

fn headers(value: &Value, truncated: &mut bool) -> Vec<BrowserNetworkHeader> {
    let Some(headers) = value.as_object() else {
        return Vec::new();
    };
    let mut remaining = 64 * 1024;
    let mut result = Vec::new();
    for (name, value) in headers {
        if result.len() == 256 || name.len() > remaining {
            *truncated = true;
            break;
        }
        remaining -= name.len();
        let value = text(value, remaining, truncated);
        remaining -= value.len();
        result.push(BrowserNetworkHeader {
            name: name.clone(),
            value,
        });
    }
    result
}

fn timestamp(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn request_details(params: &Value) -> Result<BrowserNetworkRequestDetails, &'static str> {
    let request = &params["request"];
    let mut truncated = request["hasPostData"] == true && !request["postData"].is_string();
    let url = text(&request["url"], 8192, &mut truncated);
    let headers = headers(&request["headers"], &mut truncated);
    let post_data = request["postData"]
        .as_str()
        .map(|_| text(&request["postData"], 64 * 1024, &mut truncated));
    Ok(BrowserNetworkRequestDetails {
        url,
        headers,
        post_data,
        wall_time: timestamp(&params["wallTime"]).ok_or("browser_network_timestamp_invalid")?,
        timestamp: timestamp(&params["timestamp"]).ok_or("browser_network_timestamp_invalid")?,
        truncated,
    })
}

fn response_details(response: &Value) -> BrowserNetworkResponseDetails {
    let mut truncated = false;
    let raw = &response["timing"];
    let duration = |name: &str| timestamp(&raw[name]).unwrap_or(-1.0);
    let timing = timestamp(&raw["requestTime"]).map(|request_time| BrowserNetworkTiming {
        request_time,
        dns_start: duration("dnsStart"),
        dns_end: duration("dnsEnd"),
        connect_start: duration("connectStart"),
        connect_end: duration("connectEnd"),
        ssl_start: duration("sslStart"),
        ssl_end: duration("sslEnd"),
        send_start: duration("sendStart"),
        send_end: duration("sendEnd"),
        receive_headers_end: duration("receiveHeadersEnd"),
    });
    BrowserNetworkResponseDetails {
        status_text: text(&response["statusText"], 1024, &mut truncated),
        protocol: text(&response["protocol"], 32, &mut truncated),
        headers: headers(&response["headers"], &mut truncated),
        mime_type: text(&response["mimeType"], 1024, &mut truncated),
        encoded_data_length: response["encodedDataLength"].as_u64(),
        timing,
        truncated,
    }
}

impl Monitor {
    pub(super) async fn network_event(&mut self, event: &Value) -> Result<(), &'static str> {
        let method = field(event, "method")?;
        if !matches!(
            method,
            "Network.requestWillBeSent"
                | "Network.requestWillBeSentExtraInfo"
                | "Network.responseReceivedExtraInfo"
                | "Network.responseReceived"
                | "Network.dataReceived"
                | "Network.loadingFinished"
                | "Network.loadingFailed"
        ) {
            return Ok(());
        }
        let params = &event["params"];
        let source = BrowserNetworkId::new(field(event, "sessionId")?)?;
        let request = BrowserNetworkId::new(field(params, "requestId")?)?;
        let mut host = self.host.lock().await;
        let network = host.network();
        // Late events cannot recreate a closed page or change a neighbor.
        if network.source_target(&source).is_none() {
            return Ok(());
        }
        let capturing = network.capturing_source(&source);
        match method {
            "Network.requestWillBeSent" => {
                if let Some(status) = params["redirectResponse"]["status"]
                    .as_u64()
                    .and_then(|n| u16::try_from(n).ok())
                {
                    network.response(&source, &request, status);
                    network.observed_response_details(
                        &source,
                        &request,
                        response_details(&params["redirectResponse"]),
                        params["redirectHasExtraInfo"] == true,
                    );
                    if capturing {
                        network.capture_completion_details(
                            &source,
                            &request,
                            timestamp(&params["timestamp"]),
                            params["redirectResponse"]["encodedDataLength"].as_u64(),
                        );
                    }
                }
                network.started(
                    &source,
                    request.clone(),
                    (
                        field(&params["request"], "url")?,
                        field(&params["request"], "method")?,
                        params["type"].as_str().unwrap_or("Other"),
                    ),
                    Instant::now(),
                )?;
                match request_details(params) {
                    Ok(details) => network.observed_request_details(&source, &request, details),
                    Err(code) if capturing => return Err(code),
                    Err(_) => {}
                }
            }
            "Network.responseReceived" => {
                let status = params["response"]["status"]
                    .as_u64()
                    .and_then(|n| u16::try_from(n).ok())
                    .ok_or("browser_network_status_invalid")?;
                network.response(&source, &request, status);
                network.observed_response_details(
                    &source,
                    &request,
                    response_details(&params["response"]),
                    params["hasExtraInfo"] == true,
                );
            }
            "Network.requestWillBeSentExtraInfo" | "Network.responseReceivedExtraInfo"
                if capturing =>
            {
                let mut truncated = false;
                let headers = headers(&params["headers"], &mut truncated);
                let status = if method == "Network.responseReceivedExtraInfo" {
                    Some(
                        params["statusCode"]
                            .as_u64()
                            .and_then(|value| u16::try_from(value).ok())
                            .ok_or("browser_network_status_invalid")?,
                    )
                } else {
                    None
                };
                network.capture_extra_headers(&source, &request, headers, status, truncated);
            }
            "Network.dataReceived" => {
                network.observed_body_received(
                    &source,
                    &request,
                    params["encodedDataLength"]
                        .as_u64()
                        .ok_or("browser_network_size_invalid")?,
                    params["dataLength"]
                        .as_u64()
                        .ok_or("browser_network_size_invalid")?,
                );
            }
            "Network.loadingFinished" | "Network.loadingFailed" => {
                if capturing {
                    network.capture_completion_details(
                        &source,
                        &request,
                        timestamp(&params["timestamp"]),
                        params["encodedDataLength"].as_u64(),
                    );
                }
                let result = if method == "Network.loadingFinished" {
                    Ok(())
                } else {
                    Err(field(params, "errorText")?)
                };
                network.completed(&source, &request, result, Instant::now());
            }
            _ => {}
        }
        Ok(())
    }
}
