use super::*;
use hmux_session_protocol::browser_resource::*;
fn value() -> BrowserNetworkCaptureEntry {
    BrowserNetworkCaptureEntry {
        request: hmux_session_protocol::browser_network::BrowserNetworkRequest {
            sequence: "9007199254740993".into(),
            url: "https://example.test/".into(),
            method: "POST".into(),
            resource_type: "Fetch".into(),
            status: Some(200),
            state: BrowserNetworkState::Finished,
            error: None,
            metadata_truncated: false,
        },
        source: "source".into(),
        details: BrowserNetworkRequestDetails {
            url: "https://example.test/?label=%ED%95%9C%EA%B8%80&label=two".into(),
            headers: vec![BrowserNetworkHeader {
                name: "Cookie".into(),
                value: "a=1; b=two=3".into(),
            }],
            post_data: Some("한글".into()),
            wall_time: 1700000000.123,
            timestamp: 10.0,
            truncated: false,
        },
        response: Some(BrowserNetworkResponseDetails {
            status_text: "OK".into(),
            protocol: "h2".into(),
            headers: vec![BrowserNetworkHeader {
                name: "Set-Cookie".into(),
                value: "a=1; HttpOnly\nb=two=3; Secure".into(),
            }],
            mime_type: "text/plain".into(),
            encoded_data_length: Some(150),
            timing: Some(BrowserNetworkTiming {
                request_time: 10.0,
                dns_start: 1.0,
                dns_end: 3.0,
                connect_start: 3.0,
                connect_end: 7.0,
                ssl_start: 4.0,
                ssl_end: 6.0,
                send_start: 8.0,
                send_end: 9.0,
                receive_headers_end: 10.0,
            }),
            truncated: false,
        }),
        completed_timestamp: Some(10.05),
        body_size: Some(12),
        decoded_body_size: Some(24),
        encoded_data_length: Some(150),
    }
}
#[test]
fn har_keeps_unicode_cookies_query_duplicates_and_distinguishes_body_from_transfer() {
    let output = entry(value()).unwrap();
    assert_eq!(output["startedDateTime"], "2023-11-14T22:13:20.123Z");
    assert_eq!(output["request"]["httpVersion"], "HTTP/2.0");
    assert_eq!(
        output["request"]["queryString"],
        json!([{"name":"label","value":"한글"},{"name":"label","value":"two"}])
    );
    assert_eq!(output["request"]["postData"]["text"], "한글");
    assert_eq!(output["request"]["bodySize"], 6);
    assert_eq!(output["request"]["cookies"], output["response"]["cookies"]);
    assert_eq!(output["response"]["bodySize"], 12);
    assert_eq!(output["response"]["content"]["size"], 24);
    assert_eq!(output["_dure"]["transferredBytes"], 150);
    let phases = &output["timings"];
    let total: f64 = ["blocked", "dns", "connect", "send", "wait", "receive"]
        .into_iter()
        .map(|key| phases[key].as_f64().unwrap().max(0.0))
        .sum();
    assert_eq!(output["time"], total);
    assert_eq!(phases["ssl"], 2.0);
}
#[test]
fn unknown_metadata_stays_unknown_and_invalid_wall_time_cannot_fabricate_a_date() {
    let mut record = value();
    record.response = None;
    record.completed_timestamp = None;
    record.body_size = None;
    record.decoded_body_size = None;
    record.request.state = BrowserNetworkState::Pending;
    record.request.status = None;
    let output = entry(record).unwrap();
    assert_eq!(output["response"]["bodySize"], -1);
    assert_eq!(output["response"]["httpVersion"], "");
    assert_eq!(output["timings"]["receive"], -1);
    assert_eq!(output["_dure"]["pending"], true);
    for time in [f64::NAN, f64::INFINITY, -1.0, f64::MAX] {
        let mut record = value();
        record.details.wall_time = time;
        assert_eq!(entry(record).unwrap_err(), "browser_har_timestamp_invalid");
    }
}
#[test]
fn capture_flags_and_decimal_identity_round_trip_in_the_actual_har_document() {
    let mut record = value();
    record.request.metadata_truncated = true;
    let page = BrowserPageIdentity {
        resource: BrowserResourceIdentity {
            resource_id: BrowserResourceId::new("r").unwrap(),
            generation: BrowserResourceGeneration::new("g").unwrap(),
            workspace_id: BrowserWorkspaceId::new("w").unwrap(),
        },
        page_id: BrowserPageId::new("p").unwrap(),
        document_revision: std::num::NonZeroU64::new(1).unwrap(),
    };
    let bytes = har(BrowserNetworkCapture {
        page: page.clone(),
        complete: false,
        truncated: true,
        entries: vec![record],
    })
    .unwrap();
    let output: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(output["log"]["version"], "1.2");
    assert_eq!(output["log"]["_dure"]["page"], json!(page));
    assert_eq!(output["log"]["_dure"]["complete"], false);
    assert_eq!(output["log"]["_dure"]["truncated"], true);
    assert_eq!(
        output["log"]["entries"][0]["_dure"]["metadataTruncated"],
        true
    );
    assert_eq!(
        output["log"]["entries"][0]["_dure"]["sequence"],
        "9007199254740993"
    );
}

#[test]
fn nonempty_transferred_content_without_encoded_chunks_does_not_claim_a_zero_byte_body() {
    let mut record = value();
    record.body_size = Some(0);
    record.decoded_body_size = Some(44);
    record.encoded_data_length = Some(127);
    let output = entry(record.clone()).unwrap();
    assert_eq!(output["response"]["bodySize"], -1);
    assert_eq!(output["response"]["content"]["size"], 44);
    assert_eq!(output["_dure"]["transferredBytes"], 127);
    record.encoded_data_length = Some(0);
    assert_eq!(entry(record.clone()).unwrap()["response"]["bodySize"], 0);
    record.decoded_body_size = Some(0);
    record.encoded_data_length = Some(83);
    assert_eq!(entry(record).unwrap()["response"]["bodySize"], 0);
}
