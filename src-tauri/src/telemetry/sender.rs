//! The queue and the wire. One named thread owns the HTTP client and posts
//! batches to PostHog's `/batch/` endpoint; callers only hand messages to a
//! channel, so a slow network never reaches the UI thread. Events are bounded
//! by a counter (a full queue drops the newest); flush requests are not, so a
//! goodbye or an exit flush is never lost behind a backlog. Consent is asked
//! again through `Gate` right before every request: a batch that is no longer
//! allowed is discarded, never sent late.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use super::event::TelemetryEvent;

pub(crate) const ENDPOINT: &str = "https://us.i.posthog.com/batch/";
const QUEUE_CAPACITY: usize = 500;
const FLUSH_AT: usize = 20;
const FLUSH_INTERVAL: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a caller waits for a requested flush: exit and opt-out both use
/// it, and neither may hold the app hostage to a slow network.
pub(crate) const FLUSH_WAIT_CAP: Duration = Duration::from_secs(2);

/// Which kind of build this is — a closed set, never the raw channel name,
/// which for dev channels carries a worktree slug.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ReleaseChannel {
    Stable,
    Dev,
    WorktreeRelease,
    Other,
}

impl ReleaseChannel {
    pub(crate) fn from_name(name: &str) -> Self {
        if name == "stable" {
            Self::Stable
        } else if name.starts_with("dev-") {
            Self::Dev
        } else if name.starts_with("release-") {
            Self::WorktreeRelease
        } else {
            Self::Other
        }
    }
}

/// Fixed for the life of the process and attached to every event.
#[derive(Clone, Debug)]
pub(crate) struct Common {
    pub(crate) app_version: String,
    pub(crate) release_channel: ReleaseChannel,
    pub(crate) os: String,
    pub(crate) arch: String,
    /// One random id per launch (`$session_id`), so PostHog can measure how
    /// long the app stays open and what happens within one launch. It is not
    /// stored and does not survive a restart.
    pub(crate) session_id: String,
}

/// A UUID version 7: 48 bits of Unix milliseconds, then OS randomness. PostHog
/// derives session start and ordering from the timestamp half.
pub(crate) fn uuid_v7(now: SystemTime) -> Result<String, std::io::Error> {
    let millis = now
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    let mut bytes = [0u8; 16];
    bytes[..6].copy_from_slice(&millis.to_be_bytes()[2..]);
    getrandom::fill(&mut bytes[6..]).map_err(std::io::Error::other)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// Consent, re-resolved on the worker thread before every request.
pub(crate) type Gate = Arc<dyn Fn() -> bool + Send + Sync>;

struct Queued {
    event: TelemetryEvent,
    distinct_id: String,
    timestamp: String,
}

enum Message {
    Event(Queued),
    Flush(SyncSender<()>),
}

pub(crate) struct Sender {
    tx: std::sync::mpsc::Sender<Message>,
    /// Events handed over and not yet taken by the worker.
    queued: Arc<AtomicUsize>,
}

impl Sender {
    /// `None` when the worker thread cannot start; the caller stays inert.
    pub(crate) fn start(
        endpoint: String,
        api_key: String,
        common: Common,
        gate: Gate,
    ) -> Option<Self> {
        let (tx, rx) = channel();
        let queued = Arc::new(AtomicUsize::new(0));
        let worker = Worker {
            endpoint,
            api_key,
            common,
            gate,
            queued: Arc::clone(&queued),
            client: None,
            pending: Vec::new(),
            retried: false,
            dead: false,
        };
        std::thread::Builder::new()
            .name("dure-telemetry".into())
            .spawn(move || worker.run(rx))
            .ok()?;
        Some(Self { tx, queued })
    }

    /// Queue one event; a full queue drops it. The timestamp is fixed here so
    /// a retried batch keeps the time the thing happened.
    pub(crate) fn enqueue(&self, event: TelemetryEvent, distinct_id: &str) {
        if self.queued.load(Ordering::Acquire) >= QUEUE_CAPACITY {
            return;
        }
        self.queued.fetch_add(1, Ordering::AcqRel);
        if self
            .tx
            .send(Message::Event(Queued {
                event,
                distinct_id: distinct_id.to_string(),
                timestamp: rfc3339_utc(SystemTime::now()),
            }))
            .is_err()
        {
            self.queued.fetch_sub(1, Ordering::AcqRel);
        }
    }

    /// Ask for a flush and wait at most `cap` for the worker to finish it.
    pub(crate) fn flush(&self, cap: Duration) {
        let (ack_tx, ack_rx) = sync_channel(1);
        if self.tx.send(Message::Flush(ack_tx)).is_ok() {
            let _ = ack_rx.recv_timeout(cap);
        }
    }
}

enum Outcome {
    Sent,
    /// The service refused the payload or the key; retrying cannot help.
    Rejected,
    /// The service or the network failed; the same batch may succeed later.
    Failed,
}

struct Worker {
    endpoint: String,
    api_key: String,
    common: Common,
    gate: Gate,
    queued: Arc<AtomicUsize>,
    client: Option<reqwest::blocking::Client>,
    pending: Vec<Value>,
    retried: bool,
    dead: bool,
}

impl Worker {
    fn run(mut self, rx: Receiver<Message>) {
        let mut last_flush = Instant::now();
        loop {
            let wait = FLUSH_INTERVAL.saturating_sub(last_flush.elapsed());
            match rx.recv_timeout(wait) {
                Ok(Message::Event(queued)) => {
                    self.queued.fetch_sub(1, Ordering::AcqRel);
                    let rendered = self.render(queued);
                    self.pending.push(rendered);
                    if self.pending.len() >= FLUSH_AT {
                        self.flush();
                        last_flush = Instant::now();
                    }
                }
                Ok(Message::Flush(ack)) => {
                    self.flush();
                    last_flush = Instant::now();
                    let _ = ack.send(());
                }
                Err(RecvTimeoutError::Timeout) => {
                    self.flush();
                    last_flush = Instant::now();
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.flush();
                    return;
                }
            }
        }
    }

    fn render(&self, queued: Queued) -> Value {
        let mut properties = Map::new();
        properties.insert("$lib".into(), json!("dure-desktop"));
        properties.insert("$lib_version".into(), json!(self.common.app_version));
        properties.insert("$process_person_profile".into(), json!(false));
        properties.insert("$geoip_disable".into(), json!(true));
        properties.insert("$session_id".into(), json!(self.common.session_id));
        properties.insert("app_version".into(), json!(self.common.app_version));
        properties.insert("release_channel".into(), json!(self.common.release_channel));
        properties.insert("os".into(), json!(self.common.os));
        properties.insert("arch".into(), json!(self.common.arch));
        let mut event = match serde_json::to_value(&queued.event) {
            Ok(Value::Object(event)) => event,
            _ => Map::new(),
        };
        if let Some(Value::Object(own)) = event.remove("properties") {
            properties.extend(own);
        }
        json!({
            "event": event.remove("event").unwrap_or(Value::Null),
            "distinct_id": queued.distinct_id,
            "timestamp": queued.timestamp,
            "properties": properties,
        })
    }

    fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        if self.dead || !(self.gate)() {
            self.pending.clear();
            self.retried = false;
            return;
        }
        let batch = std::mem::take(&mut self.pending);
        match self.post(&batch) {
            Outcome::Sent => self.retried = false,
            Outcome::Rejected => self.dead = true,
            Outcome::Failed => {
                if self.retried {
                    self.retried = false;
                } else {
                    self.retried = true;
                    self.pending = batch;
                }
            }
        }
    }

    fn post(&mut self, batch: &[Value]) -> Outcome {
        if self.client.is_none() {
            // reqwest is built with `rustls-no-provider`; the process default
            // is whichever caller installed one first, so install ring here
            // (a second install is a harmless Err) before building a client.
            let _ = rustls::crypto::ring::default_provider().install_default();
            match reqwest::blocking::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .build()
            {
                Ok(client) => self.client = Some(client),
                Err(_) => return Outcome::Rejected,
            }
        }
        let Some(client) = self.client.as_ref() else {
            return Outcome::Rejected;
        };
        let body = json!({ "api_key": self.api_key, "batch": batch });
        match client.post(&self.endpoint).json(&body).send() {
            Ok(response) if response.status().is_success() => Outcome::Sent,
            // Rate limiting and a request timeout are the service asking for
            // later, not refusing the payload or the key.
            Ok(response) if matches!(response.status().as_u16(), 408 | 429) => Outcome::Failed,
            Ok(response) if response.status().is_client_error() => Outcome::Rejected,
            Ok(_) | Err(_) => Outcome::Failed,
        }
    }
}

/// `YYYY-MM-DDTHH:MM:SSZ` without a date crate: days since the epoch to a
/// civil date by the proleptic Gregorian algorithm.
pub(crate) fn rfc3339_utc(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let remainder = seconds.rem_euclid(86_400);
    let (hours, minutes, secs) = (remainder / 3600, remainder % 3600 / 60, remainder % 60);
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{secs:02}Z")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    /// A local intake: records every body it receives and answers with one
    /// fixed status. `try_recv` keeps the loop non-blocking so a test can
    /// assert "no request arrived" without waiting for a timeout.
    pub(crate) struct Intake {
        pub(crate) endpoint: String,
        pub(crate) bodies: Arc<Mutex<Vec<Value>>>,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Intake {
        pub(crate) fn start(status: u16) -> Self {
            let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
            let endpoint = format!("http://{}/batch/", server.server_addr());
            let bodies = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let worker_bodies = Arc::clone(&bodies);
            let worker_stop = Arc::clone(&stop);
            let thread = std::thread::spawn(move || {
                while !worker_stop.load(Ordering::Relaxed) {
                    match server.recv_timeout(Duration::from_millis(50)) {
                        Ok(Some(mut request)) => {
                            let mut text = String::new();
                            let _ = std::io::Read::read_to_string(request.as_reader(), &mut text);
                            worker_bodies
                                .lock()
                                .unwrap()
                                .push(serde_json::from_str(&text).unwrap_or(Value::Null));
                            let _ = request.respond(
                                tiny_http::Response::from_string("{}").with_status_code(status),
                            );
                        }
                        Ok(None) => {}
                        Err(_) => break,
                    }
                }
            });
            Self {
                endpoint,
                bodies,
                stop,
                thread: Some(thread),
            }
        }

        pub(crate) fn requests(&self) -> Vec<Value> {
            self.bodies.lock().unwrap().clone()
        }
    }

    impl Drop for Intake {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    pub(crate) fn common() -> Common {
        Common {
            app_version: "0.2.19".into(),
            release_channel: ReleaseChannel::Stable,
            os: "macOS 15.5".into(),
            arch: "aarch64".into(),
            session_id: "0192a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b".into(),
        }
    }

    fn open_gate() -> Gate {
        Arc::new(|| true)
    }

    #[test]
    fn posts_a_batch_in_the_posthog_wire_shape() {
        let intake = Intake::start(200);
        let sender = Sender::start(intake.endpoint.clone(), "phc_test".into(), common(), open_gate()).unwrap();
        sender.enqueue(TelemetryEvent::PaneHidden, "0123456789abcdef0123456789abcdef");
        sender.enqueue(
            TelemetryEvent::MessageSent {
                provider: super::super::event::Identifier::parse("codex").unwrap(),
            },
            "0123456789abcdef0123456789abcdef",
        );
        sender.flush(Duration::from_secs(5));

        let requests = intake.requests();
        assert_eq!(requests.len(), 1, "{requests:?}");
        let body = &requests[0];
        assert_eq!(body["api_key"], "phc_test");
        let batch = body["batch"].as_array().unwrap();
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[0]["event"], "pane_hidden");
        assert_eq!(batch[1]["event"], "message_sent");
        for entry in batch {
            assert_eq!(entry["distinct_id"], "0123456789abcdef0123456789abcdef");
            assert!(entry["timestamp"].as_str().unwrap().ends_with('Z'));
            let properties = entry["properties"].as_object().unwrap();
            assert_eq!(properties["$process_person_profile"], false);
            assert_eq!(properties["$geoip_disable"], true);
            assert_eq!(properties["$lib"], "dure-desktop");
            assert_eq!(properties["$lib_version"], "0.2.19");
            assert_eq!(properties["app_version"], "0.2.19");
            assert_eq!(properties["release_channel"], "stable");
            assert_eq!(properties["os"], "macOS 15.5");
            assert_eq!(properties["arch"], "aarch64");
            assert_eq!(properties["$session_id"], "0192a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b");
            assert!(!properties.contains_key("$set"));
            assert!(!properties.contains_key("$set_once"));
        }
        assert_eq!(batch[1]["properties"]["provider"], "codex");
        assert_eq!(batch[0]["properties"].as_object().unwrap().len(), 9);
    }

    #[test]
    fn a_closed_gate_discards_the_batch_without_a_request() {
        let intake = Intake::start(200);
        let open = Arc::new(AtomicBool::new(false));
        let gate_flag = Arc::clone(&open);
        let gate: Gate = Arc::new(move || gate_flag.load(Ordering::Relaxed));
        let sender = Sender::start(intake.endpoint.clone(), "phc_test".into(), common(), gate).unwrap();
        sender.enqueue(TelemetryEvent::PaneHidden, "id");
        sender.flush(Duration::from_secs(5));
        assert!(intake.requests().is_empty());

        // The discarded events do not reappear once the gate opens.
        open.store(true, Ordering::Relaxed);
        sender.flush(Duration::from_secs(5));
        assert!(intake.requests().is_empty());
        sender.enqueue(TelemetryEvent::PaneRestored, "id");
        sender.flush(Duration::from_secs(5));
        assert_eq!(intake.requests().len(), 1);
    }

    #[test]
    fn a_rejected_batch_stops_the_sender_for_the_process() {
        let intake = Intake::start(401);
        let sender = Sender::start(intake.endpoint.clone(), "phc_bad".into(), common(), open_gate()).unwrap();
        sender.enqueue(TelemetryEvent::PaneHidden, "id");
        sender.flush(Duration::from_secs(5));
        sender.enqueue(TelemetryEvent::PaneHidden, "id");
        sender.flush(Duration::from_secs(5));
        assert_eq!(intake.requests().len(), 1);
    }

    #[test]
    fn rate_limiting_is_retried_rather_than_fatal() {
        let intake = Intake::start(429);
        let sender = Sender::start(intake.endpoint.clone(), "phc_test".into(), common(), open_gate()).unwrap();
        sender.enqueue(TelemetryEvent::PaneHidden, "id");
        sender.flush(Duration::from_secs(5));
        sender.flush(Duration::from_secs(5));
        assert_eq!(intake.requests().len(), 2);
        sender.enqueue(TelemetryEvent::PaneHidden, "id");
        sender.flush(Duration::from_secs(5));
        assert_eq!(intake.requests().len(), 3, "a later batch is still attempted");
    }

    #[test]
    fn a_full_queue_drops_new_events_but_never_a_flush_request() {
        let intake = Intake::start(200);
        let closed: Gate = Arc::new(|| false);
        let sender = Sender::start(intake.endpoint.clone(), "phc_test".into(), common(), closed).unwrap();
        // Offer more than the queue holds; whatever the worker has not yet
        // taken is capped, and the flush request still gets through.
        for _ in 0..(QUEUE_CAPACITY + 50) {
            sender.enqueue(TelemetryEvent::PaneHidden, "id");
        }
        assert!(sender.queued.load(Ordering::Acquire) <= QUEUE_CAPACITY);
        let started = Instant::now();
        sender.flush(Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(5), "flush was acknowledged");
        assert!(intake.requests().is_empty());
    }

    #[test]
    fn a_failed_batch_is_retried_once_then_dropped() {
        let intake = Intake::start(503);
        let sender = Sender::start(intake.endpoint.clone(), "phc_test".into(), common(), open_gate()).unwrap();
        sender.enqueue(TelemetryEvent::PaneHidden, "id");
        for _ in 0..3 {
            sender.flush(Duration::from_secs(5));
        }
        assert_eq!(intake.requests().len(), 2);
    }

    /// Against the real project, on request only: `DURE_TELEMETRY_LIVE_KEY=phc_…
    /// cargo test --lib telemetry::sender::tests::live -- --ignored`. The
    /// event is `app_opened` under a throwaway id, so the funnel gains one
    /// harmless entry and PostHog's live view shows the wire shape landed.
    #[test]
    #[ignore = "posts to the real PostHog project; run by hand with DURE_TELEMETRY_LIVE_KEY"]
    fn live_posts_one_event_to_the_real_project() {
        let Ok(key) = std::env::var("DURE_TELEMETRY_LIVE_KEY") else {
            return;
        };
        let sender = Sender::start(ENDPOINT.to_string(), key, common(), open_gate()).unwrap();
        sender.enqueue(TelemetryEvent::AppOpened, "live-check-00000000000000000000");
        sender.flush(Duration::from_secs(10));
    }

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(rfc3339_utc(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(
            rfc3339_utc(UNIX_EPOCH + Duration::from_secs(1_000_000_000)),
            "2001-09-09T01:46:40Z"
        );
        assert_eq!(
            rfc3339_utc(UNIX_EPOCH + Duration::from_secs(1_789_603_200)),
            "2026-09-17T00:00:00Z"
        );
    }

    #[test]
    fn mints_time_ordered_version_7_uuids() {
        let earlier = uuid_v7(UNIX_EPOCH + Duration::from_millis(1_789_603_200_000)).unwrap();
        let later = uuid_v7(UNIX_EPOCH + Duration::from_millis(1_789_603_200_001)).unwrap();
        for id in [&earlier, &later] {
            assert_eq!(id.len(), 36, "{id}");
            assert_eq!(id.as_bytes()[14], b'7', "{id}");
            assert!(matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b'), "{id}");
        }
        assert!(earlier < later);
        assert_eq!(&earlier[..8], &later[..8]);
        assert_ne!(uuid_v7(SystemTime::now()).unwrap(), uuid_v7(SystemTime::now()).unwrap());
    }

    #[test]
    fn maps_channel_names_to_the_closed_set() {
        assert_eq!(ReleaseChannel::from_name("stable"), ReleaseChannel::Stable);
        assert_eq!(
            ReleaseChannel::from_name("dev-telemetry-20260917-ab12"),
            ReleaseChannel::Dev
        );
        assert_eq!(
            ReleaseChannel::from_name("release-1a2b3c"),
            ReleaseChannel::WorktreeRelease
        );
        assert_eq!(ReleaseChannel::from_name("beta"), ReleaseChannel::Other);
    }
}
