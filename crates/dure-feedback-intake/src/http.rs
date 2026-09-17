//! HTTP surface for the feedback intake: a single POST endpoint behind a
//! CORS allowlist, a per-device/per-IP rate limit, and a kill switch.
//!
//! Delivery is stubbed behind `FeedbackSink` — this module only decides
//! *whether* a submission is accepted, never how it reaches GitHub.

use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use axum::extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

use crate::limits::RateLimiter;
use crate::wire::{Submission, SubmissionError};

/// Origins the desktop app is allowed to call this endpoint from. Every
/// other origin is refused with a bare 403 and no CORS header, so a browser
/// never exposes the response to a page from anywhere else.
///
/// Tauri v2 does not serve the frontend from one origin on every platform:
/// macOS and Linux use the custom `tauri://` scheme, while WebView2 on
/// Windows uses `http://tauri.localhost` (or `https://` when
/// `useHttpsScheme` is set, which `tauri.conf.json` does not set today —
/// both are listed so turning it on is not a silent outage). Windows bundles
/// are built and launched by `windows-desktop.yml`, so omitting these made
/// Send 403 on the preflight and report a bare network failure there.
const ALLOWED_ORIGINS: [&str; 4] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
];

/// Generous ceiling above the wire-level attachment cap (4 MiB decoded,
/// ~5.33 MiB once base64-encoded) so a legitimate submission never trips
/// axum's default 2 MiB body limit before `Submission::parse` gets a chance
/// to produce the proper `TooLarge` rejection.
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// Where a submission goes once it has passed validation and rate limiting.
/// Task 3 implements the real GitHub-backed sink; this trait is what keeps
/// that delivery mechanism out of the HTTP layer entirely.
#[async_trait]
pub trait FeedbackSink: Send + Sync {
    /// Deliver `submission` and return a caller-facing reference id on
    /// success (for example `f-8K2QP`, the convention this system uses:
    /// `f-` followed by five characters from a random alphabet).
    async fn deliver(&self, submission: &Submission) -> Result<String, SinkError>;
}

/// Opaque delivery failure. The HTTP layer only needs to know delivery
/// failed (it maps every variant to 503); the message is for logs.
#[derive(Debug)]
pub struct SinkError(pub String);

impl fmt::Display for SinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for SinkError {}

/// Shared application state. Cheap to clone: the sink is an `Arc<dyn _>`,
/// the limiter's own counters live behind mutexes inside an `Arc`, and the
/// kill switch is a plain `bool`. Cloning `AppState` never resets rate
/// limiting — every clone shares the same underlying counters.
#[derive(Clone)]
pub struct AppState {
    sink: Arc<dyn FeedbackSink>,
    limiter: Arc<RateLimiter>,
    disabled: bool,
}

impl AppState {
    pub fn new(sink: Arc<dyn FeedbackSink>, limiter: RateLimiter, disabled: bool) -> Self {
        Self {
            sink,
            limiter: Arc::new(limiter),
            disabled,
        }
    }
}

/// Builds the intake router: `POST /v1/feedback`, its `OPTIONS` preflight,
/// and `GET /health`.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/feedback", post(submit_feedback).options(preflight))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(middleware::from_fn(cors_guard))
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

/// Answers CORS preflight for `/v1/feedback`. The actual allow/refuse
/// decision (and the `Access-Control-Allow-Origin` header) happens in
/// `cors_guard`; this handler only runs once that guard has already let an
/// allowed origin through, so it just advertises what the real request may
/// use.
async fn preflight() -> Response {
    (
        StatusCode::NO_CONTENT,
        [
            (header::ACCESS_CONTROL_ALLOW_METHODS, "POST, OPTIONS"),
            (header::ACCESS_CONTROL_ALLOW_HEADERS, "content-type"),
        ],
    )
        .into_response()
}

/// Rejects requests from any `Origin` outside `ALLOWED_ORIGINS` before they
/// reach a handler, and stamps `Access-Control-Allow-Origin` on responses to
/// origins that are allowed. Requests with no `Origin` header at all (health
/// checks, server-to-server calls) are not CORS requests and pass through
/// untouched.
async fn cors_guard(req: Request<Body>, next: Next) -> Response {
    let Some(origin) = req.headers().get(header::ORIGIN).cloned() else {
        return next.run(req).await;
    };
    let allowed = origin
        .to_str()
        .map(|value| ALLOWED_ORIGINS.contains(&value))
        .unwrap_or(false);
    if !allowed {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("origin"));
    response
}

/// Peeks at `ConnectInfo<SocketAddr>` when the server was bound with
/// `into_make_service_with_connect_info`, without failing when it wasn't.
/// axum's blanket `Option<T>` extractor does not cover `ConnectInfo` (it
/// only special-cases extractors that opt in to `OptionalFromRequestParts`),
/// so a plain `Option<ConnectInfo<SocketAddr>>` parameter would reject every
/// request run through `tower::ServiceExt::oneshot` in tests. This extractor
/// reads the extension directly and is infallible either way.
struct MaybeConnectInfo(Option<SocketAddr>);

impl<S> FromRequestParts<S> for MaybeConnectInfo
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(MaybeConnectInfo(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|info| info.0),
        ))
    }
}

/// Resolves the client IP for rate limiting, in order of trust:
///
/// 1. `Fly-Client-IP` — stamped by the fly.io edge from the real TCP
///    connection, never by the caller, so it cannot be forged.
/// 2. The LAST entry of `x-forwarded-for` — fly.io appends the real client
///    address to whatever the caller already sent, so the first entry is
///    attacker-controlled (a client can send `x-forwarded-for: 1.2.3.4` and
///    have `1.2.3.4, <real address>` arrive here); the last entry is not.
/// 3. The socket peer address, when neither header is present.
/// 4. A shared `"unknown"` bucket when none of the above is available.
///
/// Every candidate has to parse as an [`IpAddr`] before it is used, and the
/// value returned is that address re-rendered, never the caller's bytes.
/// This result is a rate-limiter map key, which is the same
/// unbounded-key hole `device` was capped for: without the parse, any header
/// value at all interned a fresh bucket. A candidate that does not parse is
/// not a client address, so resolution falls through to the next source
/// rather than trusting it.
fn parsed_ip(candidate: &str) -> Option<String> {
    candidate
        .trim()
        .parse::<IpAddr>()
        .ok()
        .map(|ip| ip.to_string())
}

fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>) -> String {
    if let Some(value) = headers.get("fly-client-ip") {
        if let Ok(raw) = value.to_str() {
            if let Some(ip) = parsed_ip(raw) {
                return ip;
            }
        }
    }
    if let Some(value) = headers.get("x-forwarded-for") {
        if let Ok(raw) = value.to_str() {
            if let Some(ip) = raw.split(',').next_back().and_then(parsed_ip) {
                return ip;
            }
        }
    }
    if let Some(addr) = peer {
        return addr.ip().to_string();
    }
    "unknown".to_string()
}

async fn submit_feedback(
    State(state): State<AppState>,
    connect_info: MaybeConnectInfo,
    headers: HeaderMap,
    body: String,
) -> Response {
    if state.disabled {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "FEEDBACK_DISABLED" })),
        )
            .into_response();
    }

    let submission = match Submission::parse(&body) {
        Ok(submission) => submission,
        Err(SubmissionError::Schema(message)) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "INVALID_SUBMISSION", "message": message })),
            )
                .into_response();
        }
        Err(SubmissionError::TooLarge(field)) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(json!({ "error": "PAYLOAD_TOO_LARGE", "field": field })),
            )
                .into_response();
        }
    };

    let ip = client_ip(&headers, connect_info.0);
    if !state.limiter.allow(&submission.device, &ip) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": "RATE_LIMITED" })),
        )
            .into_response();
    }

    match state.sink.deliver(&submission).await {
        Ok(reference) => (StatusCode::CREATED, Json(json!({ "id": reference }))).into_response(),
        Err(err) => {
            eprintln!("feedback delivery failed: {err}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "DELIVERY_FAILED" })),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use tower::ServiceExt;

    #[derive(Default)]
    struct RecordingSink(Arc<Mutex<Vec<String>>>);

    #[async_trait::async_trait]
    impl FeedbackSink for RecordingSink {
        async fn deliver(&self, submission: &Submission) -> Result<String, SinkError> {
            self.0.lock().unwrap().push(submission.body.clone());
            Ok("f-TEST1".to_string())
        }
    }

    fn body_json(device: &str) -> String {
        format!(
            r#"{{"schema":1,"kind":"bug","body":"it froze","device":"{device}",
                 "env":{{"app":"0.2.19","channel":"beta","os":"macOS 15.5",
                         "arch":"aarch64","locale":"ko","window":"1512x982"}}}}"#
        )
    }

    fn post(device: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/v1/feedback")
            .header("content-type", "application/json")
            .header("origin", "tauri://localhost")
            .header("x-forwarded-for", "203.0.113.7")
            .body(Body::from(body_json(device)))
            .unwrap()
    }

    fn state(clock: impl Fn() -> Instant + Send + Sync + 'static) -> AppState {
        AppState::new(
            Arc::new(RecordingSink::default()),
            RateLimiter::new(Box::new(clock)),
            false,
        )
    }

    #[tokio::test]
    async fn accepts_a_valid_submission_and_returns_a_reference() {
        let start = Instant::now();
        let response = router(state(move || start))
            .oneshot(post("d-1"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert!(
            String::from_utf8(bytes.to_vec())
                .unwrap()
                .contains("f-TEST1")
        );
    }

    #[tokio::test]
    async fn rejects_the_sixth_submission_from_one_device_within_an_hour() {
        let start = Instant::now();
        let app = router(state(move || start));
        for _ in 0..5 {
            assert_eq!(
                app.clone().oneshot(post("d-2")).await.unwrap().status(),
                StatusCode::CREATED
            );
        }
        assert_eq!(
            app.oneshot(post("d-2")).await.unwrap().status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    #[tokio::test]
    async fn forgets_the_device_once_the_hour_has_passed() {
        let start = Instant::now();
        let tick = Arc::new(Mutex::new(start));
        let reading = Arc::clone(&tick);
        let app = router(state(move || *reading.lock().unwrap()));
        for _ in 0..5 {
            let _ = app.clone().oneshot(post("d-3")).await.unwrap();
        }
        *tick.lock().unwrap() = start + Duration::from_secs(3_601);
        assert_eq!(
            app.oneshot(post("d-3")).await.unwrap().status(),
            StatusCode::CREATED
        );
    }

    #[tokio::test]
    async fn returns_503_when_the_kill_switch_is_set() {
        let start = Instant::now();
        let disabled = AppState::new(
            Arc::new(RecordingSink::default()),
            RateLimiter::new(Box::new(move || start)),
            true,
        );
        assert_eq!(
            router(disabled)
                .oneshot(post("d-4"))
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn answers_preflight_for_the_app_origin_only() {
        let start = Instant::now();
        let app = router(state(move || start));
        let preflight = |origin: &str| {
            Request::builder()
                .method("OPTIONS")
                .uri("/v1/feedback")
                .header("origin", origin)
                .header("access-control-request-method", "POST")
                .body(Body::empty())
                .unwrap()
        };
        let allowed = app
            .clone()
            .oneshot(preflight("tauri://localhost"))
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            allowed
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            "tauri://localhost"
        );
        let refused = app.oneshot(preflight("https://evil.test")).await.unwrap();
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        assert!(
            refused
                .headers()
                .get("access-control-allow-origin")
                .is_none()
        );
    }

    // Boundary coverage requested by a prior review: these exercise
    // `Submission::parse`'s caps through the HTTP surface, which is the
    // right place for them since the caps themselves are already covered
    // in `wire.rs`.
    #[tokio::test]
    async fn rejects_a_201_character_contact() {
        let start = Instant::now();
        let long_contact = "x".repeat(201);
        let body = format!(
            r#"{{"schema":1,"kind":"bug","body":"it froze","device":"d-contact","contact":"{long_contact}",
                 "env":{{"app":"0.2.19","channel":"beta","os":"macOS 15.5",
                         "arch":"aarch64","locale":"ko","window":"1512x982"}}}}"#
        );
        let request = Request::builder()
            .method("POST")
            .uri("/v1/feedback")
            .header("content-type", "application/json")
            .header("origin", "tauri://localhost")
            .header("x-forwarded-for", "203.0.113.7")
            .body(Body::from(body))
            .unwrap();
        let response = router(state(move || start)).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    // Fix round 1, finding 1: fly.io's edge appends the real client address
    // to whatever `x-forwarded-for` the caller already sent, so the FIRST
    // entry is attacker-controlled. These exercise `client_ip` directly as
    // a pure function to pin the resolution order exactly.
    #[test]
    fn attributes_the_ip_to_the_last_x_forwarded_for_entry_not_the_first() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("9.9.9.9, 203.0.113.7"),
        );
        assert_eq!(client_ip(&headers, None), "203.0.113.7");
    }

    #[test]
    fn fly_client_ip_header_wins_over_x_forwarded_for() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("9.9.9.9, 203.0.113.7"),
        );
        headers.insert("fly-client-ip", HeaderValue::from_static("198.51.100.4"));
        assert_eq!(client_ip(&headers, None), "198.51.100.4");
    }

    #[test]
    fn falls_back_to_the_peer_address_when_no_header_is_present() {
        let headers = HeaderMap::new();
        let peer: SocketAddr = "127.0.0.1:9999".parse().unwrap();
        assert_eq!(client_ip(&headers, Some(peer)), "127.0.0.1");
    }

    // Fix round 5, I1: Tauri v2 serves the frontend from
    // `http://tauri.localhost` on Windows (WebView2), and tauri.conf.json
    // sets no `useHttpsScheme`. With only the macOS/Linux `tauri://localhost`
    // and the dev server allowed, the preflight 403s and Send is dead on
    // every Windows bundle windows-desktop.yml builds.
    #[tokio::test]
    async fn answers_preflight_for_the_windows_webview_origin() {
        let start = Instant::now();
        let app = router(state(move || start));
        for origin in ["http://tauri.localhost", "https://tauri.localhost"] {
            let request = Request::builder()
                .method("OPTIONS")
                .uri("/v1/feedback")
                .header("origin", origin)
                .header("access-control-request-method", "POST")
                .body(Body::empty())
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::NO_CONTENT,
                "{origin} must be allowed"
            );
            assert_eq!(
                response
                    .headers()
                    .get("access-control-allow-origin")
                    .unwrap(),
                origin
            );
        }
    }

    // Fix round 5, I2: the rate-limit key was whatever the header said,
    // verbatim — the same unbounded-map-key hole `device` was capped for.
    // A value that is not an address is not a client; fall through to the
    // next source rather than interning it.
    #[test]
    fn ignores_a_forwarded_value_that_is_not_an_ip_address() {
        let mut headers = HeaderMap::new();
        headers.insert("fly-client-ip", HeaderValue::from_static("not-an-ip"));
        headers.insert("x-forwarded-for", HeaderValue::from_static("203.0.113.7"));
        assert_eq!(client_ip(&headers, None), "203.0.113.7");
    }

    #[test]
    fn falls_back_to_the_shared_bucket_when_nothing_parses_as_an_address() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("9.9.9.9, definitely-not-an-address"),
        );
        assert_eq!(client_ip(&headers, None), "unknown");
    }

    // Fix round 5, C3: an oversized environment value must be refused by
    // `Submission::parse`, not by GitHub's 65536-character body limit after
    // a delivery attempt has already been spent.
    #[tokio::test]
    async fn rejects_an_oversized_environment_value() {
        let start = Instant::now();
        let huge = "x".repeat(200_000);
        let body = format!(
            r#"{{"schema":1,"kind":"bug","body":"it froze","device":"d-env",
                 "env":{{"app":"{huge}","channel":"beta","os":"macOS 15.5",
                         "arch":"aarch64","locale":"ko","window":"1512x982"}}}}"#
        );
        let request = Request::builder()
            .method("POST")
            .uri("/v1/feedback")
            .header("content-type", "application/json")
            .header("origin", "tauri://localhost")
            .header("x-forwarded-for", "203.0.113.7")
            .body(Body::from(body))
            .unwrap();
        let response = router(state(move || start)).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn rejects_three_attachments() {
        let start = Instant::now();
        let attachment = r#"{"name":"a.png","media_type":"image/png","bytes_b64":"QQ=="}"#;
        let body = format!(
            r#"{{"schema":1,"kind":"bug","body":"it froze","device":"d-attach",
                 "env":{{"app":"0.2.19","channel":"beta","os":"macOS 15.5",
                         "arch":"aarch64","locale":"ko","window":"1512x982"}},
                 "attachments":[{attachment},{attachment},{attachment}]}}"#
        );
        let request = Request::builder()
            .method("POST")
            .uri("/v1/feedback")
            .header("content-type", "application/json")
            .header("origin", "tauri://localhost")
            .header("x-forwarded-for", "203.0.113.7")
            .body(Body::from(body))
            .unwrap();
        let response = router(state(move || start)).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
}
