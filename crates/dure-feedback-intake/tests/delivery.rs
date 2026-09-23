//! Stands up real (local) GitHub and Telegram mock servers with axum, in the
//! spirit of `dure-relay`'s tests standing up a real hub: the sink is
//! pointed at these over HTTP exactly as it would be at the real hosts, and
//! the mock servers keep actual state (issues, comments, committed assets)
//! rather than scripting canned responses per call.

use axum::Json;
use axum::Router;
use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{post, put};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use dure_feedback_intake::http::{AppState, FeedbackSink, router};
use dure_feedback_intake::limits::RateLimiter;
use dure_feedback_intake::sink::{GithubTelegramConfig, GithubTelegramSink};
use dure_feedback_intake::wire::Submission;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use tower::ServiceExt;

// --- Mock GitHub -----------------------------------------------------------

#[derive(Default)]
struct GithubState {
    puts: Vec<PutCall>,
    issues: Vec<IssueRecord>,
    comments: Vec<CommentCall>,
    list_calls: Vec<String>,
    fail_issue_creation: bool,
    /// Basenames that should fail their Contents PUT with a 500, so tests
    /// can exercise a partial-attachment-failure delivery.
    fail_put_names: Vec<String>,
    next_number: u64,
    /// `Authorization` headers seen on every call against `dure-internal`
    /// (dedupe listing, issue creation, comment creation) — kept separate
    /// from `PutCall::authorization` (the Contents API, against
    /// `dure-feedback-assets`) so a test can assert the two GitHub
    /// credentials this sink holds are never mixed up at a call site.
    issues_api_authorizations: Vec<String>,
}

struct PutCall {
    path: String,
    content_b64: String,
    authorization: String,
}

/// The raw `Authorization` header value, or `""` when absent — a mock
/// server has no reason to fail a request over a missing header the way
/// real GitHub would, only to record what it saw.
fn authorization_header(headers: &HeaderMap) -> String {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

struct IssueRecord {
    number: u64,
    title: String,
    body: String,
    labels: Vec<String>,
}

struct CommentCall {
    issue_number: u64,
    body: String,
}

type SharedGithub = Arc<Mutex<GithubState>>;

fn github_router(state: SharedGithub) -> Router {
    let put_state = state.clone();
    let create_state = state.clone();
    let list_state = state.clone();
    let comment_state = state;

    Router::new()
        .route(
            "/repos/hebbianai/dure-feedback-assets/contents/{*path}",
            put(
                move |Path(path): Path<String>, headers: HeaderMap, Json(payload): Json<Value>| {
                    let state = put_state.clone();
                    async move { put_contents(state, path, authorization_header(&headers), payload) }
                },
            ),
        )
        .route(
            "/repos/hebbianai/dure-internal/issues",
            post(move |headers: HeaderMap, Json(payload): Json<Value>| {
                let state = create_state.clone();
                async move { create_issue(state, authorization_header(&headers), payload) }
            })
            .get(move |headers: HeaderMap, uri: Uri| {
                let state = list_state.clone();
                async move { list_issues(state, authorization_header(&headers), uri) }
            }),
        )
        .route(
            "/repos/hebbianai/dure-internal/issues/{number}/comments",
            post(
                move |Path(number): Path<u64>, headers: HeaderMap, Json(payload): Json<Value>| {
                    let state = comment_state.clone();
                    async move {
                        let body = payload["body"].as_str().unwrap_or_default().to_string();
                        let mut guard = state.lock().unwrap();
                        guard
                            .issues_api_authorizations
                            .push(authorization_header(&headers));
                        guard.comments.push(CommentCall {
                            issue_number: number,
                            body,
                        });
                        (StatusCode::CREATED, Json(json!({})))
                    }
                },
            ),
        )
}

fn put_contents(
    state: SharedGithub,
    path: String,
    authorization: String,
    payload: Value,
) -> Response {
    let mut guard = state.lock().unwrap();
    let basename = path.rsplit('/').next().unwrap_or(&path).to_string();
    if guard.fail_put_names.contains(&basename) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "mock github: this attachment is configured to fail",
        )
            .into_response();
    }
    let content_b64 = payload["content"].as_str().unwrap_or_default().to_string();
    guard.puts.push(PutCall {
        path: path.clone(),
        content_b64,
        authorization,
    });
    (
        StatusCode::CREATED,
        Json(json!({ "content": { "html_url": format!("https://github.mock/blob/{path}") } })),
    )
        .into_response()
}

fn create_issue(state: SharedGithub, authorization: String, payload: Value) -> Response {
    let mut guard = state.lock().unwrap();
    guard.issues_api_authorizations.push(authorization);
    if guard.fail_issue_creation {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "mock github: issue creation is failing",
        )
            .into_response();
    }
    guard.next_number += 1;
    let number = guard.next_number;
    let title = payload["title"].as_str().unwrap_or_default().to_string();
    let body = payload["body"].as_str().unwrap_or_default().to_string();
    let labels = payload["labels"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    guard.issues.push(IssueRecord {
        number,
        title,
        body,
        labels,
    });
    (
        StatusCode::CREATED,
        Json(
            json!({ "number": number, "html_url": format!("https://github.mock/issues/{number}") }),
        ),
    )
        .into_response()
}

fn list_issues(state: SharedGithub, authorization: String, uri: Uri) -> Response {
    let mut guard = state.lock().unwrap();
    guard.issues_api_authorizations.push(authorization);
    guard
        .list_calls
        .push(uri.query().unwrap_or_default().to_string());
    let issues: Vec<Value> = guard
        .issues
        .iter()
        .map(|issue| {
            json!({
                "number": issue.number,
                "html_url": format!("https://github.mock/issues/{}", issue.number),
                "body": issue.body,
            })
        })
        .collect();
    Json(Value::Array(issues)).into_response()
}

async fn spawn_github() -> (String, SharedGithub) {
    let state: SharedGithub = Arc::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = github_router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), state)
}

// --- Mock Telegram -----------------------------------------------------------

#[derive(Default)]
struct TelegramState {
    calls: Vec<&'static str>,
    /// Raw `sendPhoto` multipart bodies, lossily decoded. The upload's
    /// `filename=` parameter is only observable here, and it is the last
    /// place `attachment.name` was still used unvalidated.
    photo_bodies: Vec<String>,
}

type SharedTelegram = Arc<Mutex<TelegramState>>;

fn telegram_router(state: SharedTelegram, status: StatusCode) -> Router {
    let message_state = state.clone();
    let photo_state = state;
    Router::new()
        .route(
            "/bot{token}/sendMessage",
            post(move || {
                let state = message_state.clone();
                async move {
                    state.lock().unwrap().calls.push("sendMessage");
                    (status, Json(json!({ "ok": status.is_success() })))
                }
            }),
        )
        .route(
            "/bot{token}/sendPhoto",
            post(move |body: axum::body::Bytes| {
                let state = photo_state.clone();
                async move {
                    let mut guard = state.lock().unwrap();
                    guard.calls.push("sendPhoto");
                    guard
                        .photo_bodies
                        .push(String::from_utf8_lossy(&body).into_owned());
                    drop(guard);
                    (status, Json(json!({ "ok": status.is_success() })))
                }
            }),
        )
}

async fn spawn_telegram(status: StatusCode) -> (String, SharedTelegram) {
    let state: SharedTelegram = Arc::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = telegram_router(state.clone(), status);
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), state)
}

// --- Helpers -----------------------------------------------------------

fn sink_pointed_at(github_base: String, telegram_base: String) -> GithubTelegramSink {
    GithubTelegramSink::new(GithubTelegramConfig {
        github_token: "test-github-token".to_string(),
        github_assets_token: "test-assets-token".to_string(),
        github_api_base: github_base,
        telegram_token: Some("test-telegram-token".to_string()),
        telegram_chat_id: Some("test-chat-id".to_string()),
        telegram_api_base: telegram_base,
    })
}

/// A sink with no Telegram credentials at all — `telegram_api_base` points
/// at a port nothing is listening on, so a bug that tries to reach it
/// anyway fails loudly (connection refused) instead of silently working by
/// accident.
fn sink_without_telegram(github_base: String) -> GithubTelegramSink {
    GithubTelegramSink::new(GithubTelegramConfig {
        github_token: "test-github-token".to_string(),
        github_assets_token: "test-assets-token".to_string(),
        github_api_base: github_base,
        telegram_token: None,
        telegram_chat_id: None,
        telegram_api_base: "http://127.0.0.1:1".to_string(),
    })
}

fn env_block() -> &'static str {
    r#""env":{"app":"0.2.19","channel":"beta","os":"macOS 15.5","arch":"aarch64","locale":"ko","window":"1512x982"}"#
}

fn sha256_hex(device: &str, body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(device.as_bytes());
    hasher.update(body.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

// --- Tests -----------------------------------------------------------

#[tokio::test]
async fn bug_with_png_attachment_commits_the_asset_then_files_one_issue() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let png_b64 = BASE64.encode(b"pretend-png-bytes");
    let env = env_block();
    let body = format!(
        r#"{{"schema":1,"kind":"bug","body":"It crashed on save\nmore detail","device":"d-1",
             {env},
             "attachments":[{{"name":"screenshot.png","media_type":"image/png","bytes_b64":"{png_b64}"}}]}}"#
    );
    let submission = Submission::parse(&body).expect("submission parses");

    let reference = sink.deliver(&submission).await.expect("delivers");
    assert!(reference.starts_with("f-"), "reference: {reference}");
    assert_eq!(reference.len(), 7, "\"f-\" plus five characters");

    let guard = github_state.lock().unwrap();
    assert_eq!(
        guard.puts.len(),
        1,
        "exactly one Contents PUT per attachment"
    );
    let put = &guard.puts[0];
    assert!(
        put.path.ends_with(&format!("{reference}/screenshot.png")),
        "path was {}",
        put.path
    );
    assert_eq!(
        put.content_b64, png_b64,
        "content is passed through base64, never decoded and re-encoded"
    );

    assert_eq!(guard.issues.len(), 1, "exactly one issue created");
    let issue = &guard.issues[0];
    assert!(
        issue.body.contains("github.mock/blob"),
        "body links the committed asset: {}",
        issue.body
    );
    // Every environment value crosses `render_untrusted` (fix round 5), so
    // markdown's own punctuation arrives backslash-escaped in the stored
    // body and renders back as the literal text that was submitted.
    assert!(issue.body.contains(r"| App | 0\.2\.19 |"));
    assert!(issue.body.contains("| Channel | beta |"));
    assert!(issue.body.contains(r"| OS | macOS 15\.5 |"));
    assert!(issue.body.contains("| Arch | aarch64 |"));
    assert!(issue.body.contains("| Locale | ko |"));
    assert!(issue.body.contains("| Window | 1512x982 |"));
    assert_eq!(
        issue.labels,
        vec!["source:feedback".to_string(), "feedback:bug".to_string()]
    );
    assert!(issue.title.starts_with("[feedback] It crashed on save"));

    assert!(
        guard
            .list_calls
            .iter()
            .any(|query| query.contains("labels=source:feedback")
                && query.contains("state=open")
                && query.contains("per_page=100")),
        "dedupe lookup must use the issues list endpoint, not search: {:?}",
        guard.list_calls
    );
}

#[tokio::test]
async fn a_second_submission_with_a_known_fingerprint_comments_instead_of_filing_a_new_issue() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let env = env_block();
    let body =
        format!(r#"{{"schema":1,"kind":"bug","body":"Same bug again","device":"d-dupe",{env}}}"#);
    let submission = Submission::parse(&body).expect("submission parses");

    let first_reference = sink.deliver(&submission).await.expect("first delivers");
    let second_reference = sink.deliver(&submission).await.expect("second delivers");
    assert_ne!(
        first_reference, second_reference,
        "each delivery still gets its own client-facing reference"
    );

    let guard = github_state.lock().unwrap();
    assert_eq!(
        guard.issues.len(),
        1,
        "the second submission must not file a new issue"
    );
    assert_eq!(
        guard.comments.len(),
        1,
        "the second submission becomes a comment"
    );
    assert_eq!(guard.comments[0].issue_number, guard.issues[0].number);
    assert!(
        guard.comments[0].body.contains("Same bug again"),
        "the comment still carries the submitted text"
    );
}

#[tokio::test]
async fn a_crash_submission_takes_its_fingerprint_from_the_incident_bundle() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    // A real bundle fingerprint is a hex digest (fix round 3, finding 1
    // restricts accepted bundle fingerprints to `[A-Fa-f0-9]{8,128}`).
    let incident = json!({ "incident": { "fingerprint": "cafef00d1234" } });
    let incident_b64 = BASE64.encode(incident.to_string());
    let env = env_block();
    let device = "d-crash-1";
    let text = "It crashed on launch";
    let body = format!(
        r#"{{"schema":1,"kind":"crash","body":"{text}","device":"{device}",{env},
             "attachments":[{{"name":"incident.json","media_type":"application/json","bytes_b64":"{incident_b64}"}}]}}"#
    );
    let submission = Submission::parse(&body).expect("submission parses");
    sink.deliver(&submission).await.expect("delivers");

    let guard = github_state.lock().unwrap();
    assert_eq!(guard.issues.len(), 1);
    let issue_body = &guard.issues[0].body;
    assert!(
        issue_body.contains("dure-feedback-fingerprint: cafef00d1234"),
        "marker must carry the bundle's fingerprint: {issue_body}"
    );
    let sha_fallback = sha256_hex(device, text);
    assert!(
        !issue_body.contains(&sha_fallback),
        "must not fall back to sha256(device+body) when incident.fingerprint is present"
    );
    assert_eq!(
        guard.issues[0].labels,
        vec!["source:feedback".to_string(), "feedback:crash".to_string()]
    );
}

// --- Fix round 3 -----------------------------------------------------------
//
// Finding 1: the client-controlled crash fingerprint was spliced verbatim
// into the issue body's HTML-comment dedupe marker. Two remotely
// triggerable consequences: comment-escape injection (an HTML comment ends
// at the first `-->`, so a crafted value breaks out and the rest renders as
// issue content) and dedupe hijacking (a caller who sets a fingerprint
// matching an existing issue's marker gets its own text appended as a
// comment on that issue). Restricting accepted bundle fingerprints to
// `[A-Fa-f0-9]{8,128}` closes both.

fn crash_submission_body(device: &str, text: &str, fingerprint: &str) -> String {
    let incident = json!({ "incident": { "fingerprint": fingerprint } });
    let incident_b64 = BASE64.encode(incident.to_string());
    let env = env_block();
    format!(
        r#"{{"schema":1,"kind":"crash","body":"{text}","device":"{device}",{env},
             "attachments":[{{"name":"incident.json","media_type":"application/json","bytes_b64":"{incident_b64}"}}]}}"#
    )
}

#[tokio::test]
async fn a_crash_fingerprint_comment_escape_attempt_never_reaches_the_issue_body() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let device = "d-escape";
    let text = "It crashed on launch";
    let malicious_fingerprint = "deadbeef --> ## Injected Heading\n@everyone please look";
    let body = crash_submission_body(device, text, malicious_fingerprint);
    let submission = Submission::parse(&body).expect("submission parses");

    sink.deliver(&submission).await.expect("delivers");

    let guard = github_state.lock().unwrap();
    assert_eq!(guard.issues.len(), 1);
    let issue_body = &guard.issues[0].body;
    assert!(
        !issue_body.contains("Injected Heading"),
        "the escaped markdown payload must never reach the issue body: {issue_body}"
    );
    assert!(
        !issue_body.contains('@'),
        "an @-mention smuggled through the fingerprint must never reach the issue body: {issue_body}"
    );
    // The only "-->" allowed in the body is the legitimate marker's own
    // closing delimiter, immediately after the fallback sha256 fingerprint.
    let expected_marker = format!(
        "dure-feedback-fingerprint: {} -->",
        sha256_hex(device, text)
    );
    assert!(
        issue_body.contains(&expected_marker),
        "must fall back to sha256(device+body) rather than use the rejected value: {issue_body}"
    );
    assert_eq!(issue_body.matches("-->").count(), 1, "{issue_body}");
}

// Fix round 4: the fingerprint charset widened from hex-only to
// `[A-Za-z0-9._:-]{8,160}` (a hyphen-free value like the old
// "not-a-hex-fingerprint" fixture is now a *legitimately accepted* custom
// fingerprint, not a rejection case) — a disallowed-character example now
// needs an actual disallowed character, such as a space.
#[tokio::test]
async fn a_crash_fingerprint_with_a_disallowed_character_falls_back_to_the_sha256_rule() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let device = "d-badchar";
    let text = "Crashed with a weird bundle";
    let body = crash_submission_body(device, text, "has a disallowed space in it");
    let submission = Submission::parse(&body).expect("submission parses");

    sink.deliver(&submission).await.expect("delivers");

    let guard = github_state.lock().unwrap();
    let issue_body = &guard.issues[0].body;
    assert!(
        !issue_body.contains("has a disallowed space in it"),
        "the rejected bundle value must not appear anywhere: {issue_body}"
    );
    assert!(
        issue_body.contains(&sha256_hex(device, text)),
        "must fall back to sha256(device+body): {issue_body}"
    );
}

#[tokio::test]
async fn a_realistic_error_v1_fingerprint_still_dedupes() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    // The real shape produced by `src/lib/platform/errorIncident.ts`:
    // `error-v1-<16 hex characters>` — not itself hex (contains letters
    // and hyphens outside `[a-f0-9]`), which is exactly what round 3's
    // hex-only rule got wrong.
    let fingerprint = "error-v1-0123456789abcdef";
    let first_body = crash_submission_body("d-crash-a", "First report of the crash", fingerprint);
    let second_body =
        crash_submission_body("d-crash-b", "Second report, different device", fingerprint);

    let first = Submission::parse(&first_body).expect("submission parses");
    let second = Submission::parse(&second_body).expect("submission parses");

    sink.deliver(&first).await.expect("first delivers");
    sink.deliver(&second).await.expect("second delivers");

    let guard = github_state.lock().unwrap();
    assert_eq!(
        guard.issues.len(),
        1,
        "a genuine shared fingerprint must still dedupe across different devices/bodies"
    );
    assert_eq!(guard.comments.len(), 1);
    assert!(
        guard.issues[0]
            .body
            .contains(&format!("dure-feedback-fingerprint: {fingerprint} -->"))
    );
}

#[tokio::test]
async fn a_telegram_failure_does_not_fail_delivery() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, telegram_state) = spawn_telegram(StatusCode::INTERNAL_SERVER_ERROR).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let env = env_block();
    let body = format!(
        r#"{{"schema":1,"kind":"idea","body":"Add dark mode","device":"d-telegram",{env}}}"#
    );
    let submission = Submission::parse(&body).expect("submission parses");

    let reference = sink
        .deliver(&submission)
        .await
        .expect("delivery still succeeds when Telegram is down");
    assert!(reference.starts_with("f-"));
    assert_eq!(
        github_state.lock().unwrap().issues.len(),
        1,
        "the issue is still the durable record"
    );
    assert!(
        !telegram_state.lock().unwrap().calls.is_empty(),
        "Telegram was still attempted"
    );
}

#[tokio::test]
async fn a_github_issue_creation_failure_is_a_real_failure() {
    let (github_base, github_state) = spawn_github().await;
    github_state.lock().unwrap().fail_issue_creation = true;
    let (telegram_base, telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let env = env_block();
    let body =
        format!(r#"{{"schema":1,"kind":"bug","body":"Broken build","device":"d-fail",{env}}}"#);
    let submission = Submission::parse(&body).expect("submission parses");

    let result = sink.deliver(&submission).await;
    assert!(result.is_err(), "a GitHub failure must be a real failure");
    assert!(
        telegram_state.lock().unwrap().calls.is_empty(),
        "Telegram must not be notified about a submission that was never recorded"
    );
}

#[tokio::test]
async fn a_github_failure_surfaces_as_503_through_the_http_layer() {
    let (github_base, github_state) = spawn_github().await;
    github_state.lock().unwrap().fail_issue_creation = true;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = Arc::new(sink_pointed_at(github_base, telegram_base));

    let start = SystemTime::now();
    let state = AppState::new(sink, RateLimiter::new(Box::new(move || start)), false);

    let env = env_block();
    let body =
        format!(r#"{{"schema":1,"kind":"bug","body":"it froze","device":"d-http-fail",{env}}}"#);
    let request = axum::http::Request::builder()
        .method("POST")
        .uri("/v1/feedback")
        .header("content-type", "application/json")
        .header("origin", "tauri://localhost")
        .body(axum::body::Body::from(body))
        .unwrap();

    let response = router(state).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}

// --- Fix round 1 ---------------------------------------------------------

#[tokio::test]
async fn a_sink_with_no_telegram_configuration_still_delivers() {
    let (github_base, github_state) = spawn_github().await;
    let sink = sink_without_telegram(github_base);

    let env = env_block();
    let body = format!(
        r#"{{"schema":1,"kind":"idea","body":"Works without telegram","device":"d-no-telegram",{env}}}"#
    );
    let submission = Submission::parse(&body).expect("submission parses");

    let reference = sink
        .deliver(&submission)
        .await
        .expect("delivery succeeds with no Telegram configured at all");
    assert!(reference.starts_with("f-"));
    assert_eq!(
        github_state.lock().unwrap().issues.len(),
        1,
        "the issue is still filed"
    );
}

#[tokio::test]
async fn a_failed_attachment_upload_does_not_block_the_issue_or_the_other_attachment() {
    let (github_base, github_state) = spawn_github().await;
    github_state.lock().unwrap().fail_put_names = vec!["bad.png".to_string()];
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let good_b64 = BASE64.encode(b"good-bytes");
    let bad_b64 = BASE64.encode(b"bad-bytes");
    let env = env_block();
    let body = format!(
        r#"{{"schema":1,"kind":"bug","body":"Two attachments, one fails","device":"d-partial",{env},
             "attachments":[
                {{"name":"good.png","media_type":"image/png","bytes_b64":"{good_b64}"}},
                {{"name":"bad.png","media_type":"image/png","bytes_b64":"{bad_b64}"}}
             ]}}"#
    );
    let submission = Submission::parse(&body).expect("submission parses");

    let reference = sink
        .deliver(&submission)
        .await
        .expect("a partial attachment failure must not fail the whole delivery");
    assert!(reference.starts_with("f-"));

    let guard = github_state.lock().unwrap();
    assert_eq!(
        guard.puts.len(),
        1,
        "only the attachment that succeeded is committed"
    );
    assert_eq!(guard.issues.len(), 1, "the issue is still filed");
    let issue_body = &guard.issues[0].body;
    assert!(
        issue_body.contains("good.png") && issue_body.contains("github.mock/blob"),
        "the issue links the attachment that succeeded: {issue_body}"
    );
    assert!(
        issue_body.contains("`bad.png`"),
        "the issue names the failed attachment using its safe name, backtick-quoted: {issue_body}"
    );
    assert!(
        issue_body.contains("could not be stored"),
        "the issue explains why: {issue_body}"
    );
}

#[tokio::test]
async fn an_attachment_name_with_path_traversal_is_reduced_to_its_basename() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let png_b64 = BASE64.encode(b"traversal-bytes");
    let env = env_block();
    let body = format!(
        r#"{{"schema":1,"kind":"bug","body":"Traversal attempt","device":"d-traversal",{env},
             "attachments":[{{"name":"../../evil.png","media_type":"image/png","bytes_b64":"{png_b64}"}}]}}"#
    );
    let submission = Submission::parse(&body).expect("submission parses");

    let reference = sink.deliver(&submission).await.expect("delivers");

    let guard = github_state.lock().unwrap();
    assert_eq!(guard.puts.len(), 1);
    let put_path = &guard.puts[0].path;
    assert!(
        !put_path.contains(".."),
        "path traversal must be stripped before it reaches the Contents API: {put_path}"
    );
    assert!(
        put_path.ends_with(&format!("{reference}/evil.png")),
        "path was {put_path}"
    );
}

#[tokio::test]
async fn an_attachment_name_with_unsafe_characters_is_rejected_not_renamed() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let png_b64 = BASE64.encode(b"space-bytes");
    let env = env_block();
    let body = format!(
        r#"{{"schema":1,"kind":"bug","body":"Unsafe name","device":"d-unsafe",{env},
             "attachments":[{{"name":"screen shot.png","media_type":"image/png","bytes_b64":"{png_b64}"}}]}}"#
    );
    let submission = Submission::parse(&body).expect("submission parses");

    let reference = sink
        .deliver(&submission)
        .await
        .expect("an unsafe attachment name must not fail the whole submission");
    assert!(reference.starts_with("f-"));

    let guard = github_state.lock().unwrap();
    assert_eq!(
        guard.puts.len(),
        0,
        "the unsafe name must never reach the Contents API, sanitized or not"
    );
    assert_eq!(guard.issues.len(), 1);
    let issue_body = &guard.issues[0].body;
    assert!(
        !issue_body.contains("screen shot.png"),
        "an unvalidated, attacker-controlled name must never be echoed into the issue body: {issue_body}"
    );
    assert!(
        issue_body.contains("1 attachment was rejected"),
        "the issue reports the rejection by count and reason instead: {issue_body}"
    );
}

// --- Fix round 2 ---------------------------------------------------------

#[tokio::test]
async fn an_attachment_name_of_only_dots_is_rejected_not_uploaded() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let png_b64 = BASE64.encode(b"dot-bytes");
    let env = env_block();
    let body = format!(
        r#"{{"schema":1,"kind":"bug","body":"Dot only name","device":"d-dots",{env},
             "attachments":[{{"name":"..","media_type":"image/png","bytes_b64":"{png_b64}"}}]}}"#
    );
    let submission = Submission::parse(&body).expect("submission parses");

    let reference = sink
        .deliver(&submission)
        .await
        .expect("a dot-only name must not fail the whole submission");
    assert!(reference.starts_with("f-"));

    let guard = github_state.lock().unwrap();
    assert_eq!(
        guard.puts.len(),
        0,
        "a dot-only basename must never reach the Contents API — reqwest's own \
         dot-segment normalization would otherwise cancel the reference folder \
         and land the PUT one level up"
    );
    assert_eq!(guard.issues.len(), 1);
    assert!(guard.issues[0].body.contains("1 attachment was rejected"));
}

#[tokio::test]
async fn a_malicious_attachment_name_is_never_echoed_into_the_issue_body() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let png_b64 = BASE64.encode(b"payload-bytes");
    let env = env_block();
    let malicious_name = "[click](https://evil.test) @someone.png";
    let body = format!(
        r#"{{"schema":1,"kind":"bug","body":"Malicious filename","device":"d-malicious",{env},
             "attachments":[{{"name":"{malicious_name}","media_type":"image/png","bytes_b64":"{png_b64}"}}]}}"#
    );
    let submission = Submission::parse(&body).expect("submission parses");

    sink.deliver(&submission)
        .await
        .expect("a malicious name must not fail the whole submission");

    let guard = github_state.lock().unwrap();
    assert_eq!(
        guard.puts.len(),
        0,
        "the malicious name must never reach the Contents API"
    );
    assert_eq!(guard.issues.len(), 1);
    let issue_body = &guard.issues[0].body;
    assert!(
        !issue_body.contains("evil.test"),
        "no fragment of the payload may appear in the issue body: {issue_body}"
    );
    assert!(
        !issue_body.contains('@'),
        "an @-mention must never reach the issue body: {issue_body}"
    );
    assert!(issue_body.contains("1 attachment was rejected"));
}

// --- Fix round 5 ---------------------------------------------------------
//
// Rounds 2, 3 and 4 each hardened exactly one field on its way into the
// issue body — the attachment name, then the crash fingerprint, then the
// device id. `env.*` and `contact` were never hardened at all and rendered
// verbatim, which is what a per-field shape costs: the next field is only
// safe if someone remembers. These pin the single shared boundary
// (`render_untrusted` in sink.rs) every attacker-controlled string now
// crosses, so a seventh field is safe by construction rather than by
// recollection.

/// A minimal bug submission whose `env.os` carries `os` verbatim.
fn submission_with_env_os(device: &str, text: &str, os: &str) -> String {
    format!(
        r#"{{"schema":1,"kind":"bug","body":"{text}","device":"{device}",
             "env":{{"app":"0.2.19","channel":"beta","os":"{os}",
                     "arch":"aarch64","locale":"ko","window":"1512x982"}}}}"#
    )
}

#[tokio::test]
async fn an_env_value_cannot_inject_markdown_a_mention_or_a_table_row() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let os = "## Injected Heading @everyone [click](http://evil.test) | x |";
    let raw = submission_with_env_os("d-env-inject", "An ordinary report", os);
    let submission = Submission::parse(&raw).expect("submission parses");

    sink.deliver(&submission).await.expect("delivers");

    let guard = github_state.lock().unwrap();
    let issue_body = &guard.issues[0].body;
    assert!(
        !issue_body.contains("## Injected"),
        "an env value must not be able to open a heading: {issue_body}"
    );
    assert!(
        !issue_body.contains('@'),
        "an @-mention smuggled through an env value must never page anyone: {issue_body}"
    );
    assert!(
        !issue_body.contains("[click]("),
        "an env value must not be able to render a link: {issue_body}"
    );
    assert!(
        !issue_body.contains("| x |"),
        "an env value must not be able to forge an extra table row: {issue_body}"
    );
    // Neutralised, not discarded: a triager still reads what was submitted.
    assert!(
        issue_body.contains("Injected Heading") && issue_body.contains("evil"),
        "the value itself must still be legible: {issue_body}"
    );
}

#[tokio::test]
async fn a_contact_value_cannot_inject_a_mention_or_a_link() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let env = env_block();
    let raw = format!(
        r#"{{"schema":1,"kind":"bug","body":"Contact injection","device":"d-contact-inject",
             "contact":"@hebbianai/maintainers [pay here](http://evil.test)",{env}}}"#
    );
    let submission = Submission::parse(&raw).expect("submission parses");

    sink.deliver(&submission).await.expect("delivers");

    let guard = github_state.lock().unwrap();
    let issue_body = &guard.issues[0].body;
    assert!(
        !issue_body.contains('@'),
        "a contact must not be able to page a team: {issue_body}"
    );
    assert!(
        !issue_body.contains("[pay here]("),
        "a contact must not be able to render a link: {issue_body}"
    );
    assert!(
        issue_body.contains("hebbianai"),
        "the contact itself must still be legible: {issue_body}"
    );
}

// Fix round 8: a live hand-crafted request sent `"contact": ""`, and the
// renderer — which trusts that a present contact is a real one — printed a
// bare "**Contact:**" with nothing after it. The shipped client never sends
// a blank contact, but the wire itself accepted `Some("")`/whitespace-only,
// so this was reachable the moment another client existed. Fixed in
// `Submission::parse`, not the renderer: a whitespace-only contact is
// normalized to absent at the boundary.
#[tokio::test]
async fn a_whitespace_only_contact_never_produces_a_contact_line() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let env = env_block();
    let raw = format!(
        r#"{{"schema":1,"kind":"bug","body":"Blank contact","device":"d-blank-contact",
             "contact":"   ",{env}}}"#
    );
    let submission = Submission::parse(&raw).expect("submission parses");
    assert_eq!(
        submission.contact, None,
        "a whitespace-only contact must be normalized to absent by parse"
    );

    sink.deliver(&submission).await.expect("delivers");

    let guard = github_state.lock().unwrap();
    let issue_body = &guard.issues[0].body;
    assert!(
        !issue_body.contains("**Contact:**"),
        "a blank contact must never produce a contact line: {issue_body}"
    );
}

#[tokio::test]
async fn an_env_value_cannot_plant_a_dedupe_marker_and_capture_a_later_report() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    // The dedupe lookup is a substring search over each open issue's body,
    // so any attacker-controlled text that can spell the marker owns every
    // later report carrying that fingerprint — no body text required.
    let fingerprint = "error-v1-0123456789abcdef";
    let poisoned = format!("<!-- dure-feedback-fingerprint: {fingerprint} -->");
    let attacker = submission_with_env_os("d-attacker", "Nothing to see here", &poisoned);
    let attacker = Submission::parse(&attacker).expect("submission parses");
    sink.deliver(&attacker).await.expect("attacker issue files");

    let genuine = crash_submission_body("d-victim", "The app crashed on launch", fingerprint);
    let genuine = Submission::parse(&genuine).expect("submission parses");
    sink.deliver(&genuine)
        .await
        .expect("genuine report delivers");

    let guard = github_state.lock().unwrap();
    assert_eq!(
        guard.issues.len(),
        2,
        "a genuine crash must file its own issue, not join the attacker's: {:?}",
        guard.issues.iter().map(|i| &i.body).collect::<Vec<_>>()
    );
    assert!(
        guard.comments.is_empty(),
        "nothing may be appended to the attacker's issue: {:?}",
        guard.comments.iter().map(|c| &c.body).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn a_decoy_marker_typed_into_the_report_body_cannot_capture_a_later_report() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    // The same hijack by hand, through the one field that was always meant
    // to be free text.
    let fingerprint = "error-v1-fedcba9876543210";
    let env = env_block();
    let decoy = format!(
        r#"{{"schema":1,"kind":"bug","body":"hello <!-- dure-feedback-fingerprint: {fingerprint} --> bye",
             "device":"d-decoy",{env}}}"#
    );
    let decoy = Submission::parse(&decoy).expect("submission parses");
    sink.deliver(&decoy).await.expect("decoy issue files");

    let genuine = crash_submission_body("d-decoy-victim", "Crashed again", fingerprint);
    let genuine = Submission::parse(&genuine).expect("submission parses");
    sink.deliver(&genuine)
        .await
        .expect("genuine report delivers");

    let guard = github_state.lock().unwrap();
    assert_eq!(
        guard.issues.len(),
        2,
        "a hand-typed decoy marker must not capture a later report"
    );
    assert!(guard.comments.is_empty());
}

#[tokio::test]
async fn a_malicious_attachment_name_never_reaches_the_telegram_upload_either() {
    let (github_base, _github_state) = spawn_github().await;
    let (telegram_base, telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let png_b64 = BASE64.encode(b"payload-bytes");
    let env = env_block();
    let malicious_name = "[click](https://evil.test) @someone.png";
    let raw = format!(
        r#"{{"schema":1,"kind":"bug","body":"Malicious filename","device":"d-telegram-name",{env},
             "attachments":[{{"name":"{malicious_name}","media_type":"image/png","bytes_b64":"{png_b64}"}}]}}"#
    );
    let submission = Submission::parse(&raw).expect("submission parses");

    sink.deliver(&submission).await.expect("delivers");

    let guard = telegram_state.lock().unwrap();
    assert_eq!(guard.calls, vec!["sendPhoto"]);
    let uploaded = guard.photo_bodies.first().expect("a photo was uploaded");
    assert!(
        !uploaded.contains("evil.test") && !uploaded.contains("@someone"),
        "the unvalidated attachment name must not be used as the upload filename: {uploaded}"
    );
}

// --- Fix round 6 -----------------------------------------------------------
//
// The intake now holds two GitHub credentials rather than one: a
// fine-grained PAT applies one permission set to every repository it
// selects, so a single token needing Issues write on `dure-internal` and
// Contents write on `dure-feedback-assets` would give this internet-facing
// service Contents write on the code repository too. `sink_pointed_at` uses
// two distinct token strings ("test-github-token" / "test-assets-token")
// specifically so a single-client refactor that silently reused one token
// for everything would fail this test rather than pass it by accident.

#[tokio::test]
async fn contents_calls_carry_the_assets_token_while_issue_calls_carry_the_other() {
    let (github_base, github_state) = spawn_github().await;
    let (telegram_base, _telegram_state) = spawn_telegram(StatusCode::OK).await;
    let sink = sink_pointed_at(github_base, telegram_base);

    let png_b64 = BASE64.encode(b"token-split-bytes");
    let env = env_block();
    let body = format!(
        r#"{{"schema":1,"kind":"bug","body":"Token split check","device":"d-tokens",{env},
             "attachments":[{{"name":"screenshot.png","media_type":"image/png","bytes_b64":"{png_b64}"}}]}}"#
    );
    let submission = Submission::parse(&body).expect("submission parses");

    sink.deliver(&submission).await.expect("delivers");

    let guard = github_state.lock().unwrap();
    assert_eq!(guard.puts.len(), 1, "the attachment PUT happened");
    assert_eq!(
        guard.puts[0].authorization, "Bearer test-assets-token",
        "the Contents API call must carry the assets credential, not the issues one"
    );
    assert!(
        !guard.issues_api_authorizations.is_empty(),
        "sanity: the dedupe listing and issue creation calls must have happened"
    );
    assert!(
        guard
            .issues_api_authorizations
            .iter()
            .all(|authorization| authorization == "Bearer test-github-token"),
        "every dure-internal call (dedupe listing, issue creation, comments) \
         must carry the issues credential, never the assets one: {:?}",
        guard.issues_api_authorizations
    );
}
