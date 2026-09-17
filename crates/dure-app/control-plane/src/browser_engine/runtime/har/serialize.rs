use hmux_session_protocol::browser_network::BrowserNetworkState;
use hmux_session_protocol::browser_network_capture::*;
use serde_json::{Value, json};

fn headers(values: &[BrowserNetworkHeader]) -> Value {
    json!(
        values
            .iter()
            .map(|header| json!({"name":header.name,"value":header.value}))
            .collect::<Vec<_>>()
    )
}

fn header<'a>(values: &'a [BrowserNetworkHeader], name: &str) -> Option<&'a str> {
    values
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(name))
        .map(|header| header.value.as_str())
}

fn cookies(values: &[BrowserNetworkHeader], response: bool) -> Vec<Value> {
    values
        .iter()
        .filter(|header| {
            header
                .name
                .eq_ignore_ascii_case(if response { "set-cookie" } else { "cookie" })
        })
        .flat_map(|header| {
            let pairs: Vec<_> = if response {
                header
                    .value
                    .lines()
                    .filter_map(|line| line.split(';').next())
                    .collect()
            } else {
                header.value.split(';').collect()
            };
            pairs.into_iter().filter_map(|pair| {
                let (name, value) = pair.trim().split_once('=')?;
                Some(json!({"name":name.trim(),"value":value.trim()}))
            })
        })
        .collect()
}

fn timings(entry: &BrowserNetworkCaptureEntry) -> (Value, f64) {
    let span = |start: f64, end: f64| {
        if start >= 0.0 && end >= start {
            end - start
        } else {
            -1.0
        }
    };
    let Some(t) = entry
        .response
        .as_ref()
        .and_then(|response| response.timing.as_ref())
    else {
        return (
            json!({"blocked":-1,"dns":-1,"connect":-1,"ssl":-1,"send":-1,"wait":-1,"receive":-1}),
            0.0,
        );
    };
    let blocked = [t.dns_start, t.connect_start, t.send_start]
        .into_iter()
        .find(|value| *value >= 0.0)
        .unwrap_or(-1.0);
    let dns = span(t.dns_start, t.dns_end);
    let connect = span(t.connect_start, t.connect_end);
    let ssl = span(t.ssl_start, t.ssl_end);
    let send = span(t.send_start, t.send_end);
    let wait = span(t.send_end, t.receive_headers_end);
    let receive = entry
        .completed_timestamp
        .map(|end| span(t.receive_headers_end, (end - t.request_time) * 1000.0))
        .unwrap_or(-1.0);
    let time: f64 = [blocked, dns, connect, send, wait, receive]
        .into_iter()
        .filter(|value| *value >= 0.0)
        .sum();
    (
        json!({"blocked":blocked,"dns":dns,"connect":connect,"ssl":ssl,"send":send,"wait":wait,"receive":receive}),
        time,
    )
}

fn entry(entry: BrowserNetworkCaptureEntry) -> Result<Value, &'static str> {
    let milliseconds = entry.details.wall_time * 1000.0;
    if !milliseconds.is_finite() || milliseconds < 0.0 || milliseconds >= i64::MAX as f64 {
        return Err("browser_har_timestamp_invalid");
    }
    let started = chrono::DateTime::from_timestamp_millis(milliseconds as i64)
        .ok_or("browser_har_timestamp_invalid")?
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let (timings, time) = timings(&entry);
    let response = entry.response.as_ref();
    let response_headers = response.map_or(&[][..], |response| response.headers.as_slice());
    let protocol = response.map_or("", |response| response.protocol.as_str());
    let version = match protocol {
        "http/1.0" => "HTTP/1.0",
        "http/1.1" => "HTTP/1.1",
        "h2" => "HTTP/2.0",
        "h3" => "HTTP/3.0",
        _ => protocol,
    };
    let query: Vec<_> = reqwest::Url::parse(&entry.details.url)
        .ok()
        .map(|url| {
            url.query_pairs()
                .map(|(name, value)| json!({"name":name,"value":value}))
                .collect()
        })
        .unwrap_or_default();
    let mut request = json!({"method":entry.request.method,"url":entry.details.url,"httpVersion":version,"cookies":cookies(&entry.details.headers,false),"headers":headers(&entry.details.headers),"queryString":query,"headersSize":-1,"bodySize":entry.details.post_data.as_ref().map(|body|body.len() as i64).unwrap_or(-1)});
    if let Some(body) = &entry.details.post_data {
        request["postData"] = json!({"mimeType":header(&entry.details.headers,"content-type").unwrap_or(""),"text":body});
    }
    let unknown = |value: Option<u64>| value.map_or(json!(-1), |value| json!(value));
    let size = unknown(entry.decoded_body_size);
    // Some loads report decoded content but no encoded chunk bytes despite a
    // nonzero total transfer. That is insufficient to claim an empty body.
    let body_size = unknown(entry.body_size.filter(|bytes| {
        *bytes != 0 || entry.decoded_body_size == Some(0) || entry.encoded_data_length == Some(0)
    }));
    let pending = matches!(entry.request.state, BrowserNetworkState::Pending);
    let metadata_truncated = entry.metadata_truncated();
    Ok(
        json!({"startedDateTime":started,"time":time,"request":request,
            "response":{"status":entry.request.status.unwrap_or(0),"statusText":response.map_or("",|response|response.status_text.as_str()),"httpVersion":version,"cookies":cookies(response_headers,true),"headers":headers(response_headers),"content":{"size":size,"mimeType":response.map_or("",|response|response.mime_type.as_str())},"redirectURL":header(response_headers,"location").unwrap_or(""),"headersSize":-1,"bodySize":body_size},
            "cache":{},"timings":timings,"_resourceType":entry.request.resource_type,
            "_dure":{"sequence":entry.request.sequence,"source":entry.source,"state":entry.request.state,"error":entry.request.error,"pending":pending,"transferredBytes":entry.encoded_data_length.or_else(||response.and_then(|response|response.encoded_data_length)),"metadataTruncated":metadata_truncated}
        }),
    )
}

pub(super) fn har(capture: BrowserNetworkCapture) -> Result<Vec<u8>, &'static str> {
    let entries = capture
        .entries
        .into_iter()
        .map(entry)
        .collect::<Result<Vec<_>, _>>()?;
    let har = json!({"log":{"version":"1.2","creator":{"name":"Dure","version":env!("CARGO_PKG_VERSION")},"entries":entries,"_dure":{"page":capture.page,"complete":capture.complete,"truncated":capture.truncated}}});
    let bytes = serde_json::to_vec_pretty(&har).map_err(|_| "browser_har_invalid")?;
    if bytes.len() > super::super::capture::MAX_ARTIFACT_BYTES {
        return Err("browser_har_byte_limit");
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests;
