//! Anonymous, opt-in usage telemetry (#961). The native side owns the whole
//! decision: consent, the install id, the event type, the queue and the
//! transport. The webview asks for state, records a choice and offers events;
//! it holds no consent cache and can bypass neither the type nor the gate.

pub(crate) mod consent;
pub(crate) mod event;
pub(crate) mod sender;
pub(crate) mod store;

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use consent::{Choice, DisabledReason, Effective, EnvSnapshot};
use event::TelemetryEvent;
use sender::{Common, Gate, ReleaseChannel, Sender, FLUSH_WAIT_CAP};
use store::{Store, Stored};

/// The PostHog project token, compiled in by the release build (a public,
/// write-only token). Absent in local builds, which are then inert.
const KEY: Option<&str> = option_env!("DURE_TELEMETRY_KEY");

type EnvReader = Arc<dyn Fn() -> EnvSnapshot + Send + Sync>;

pub(crate) struct TelemetryRuntime {
    /// `None` when there is nowhere to keep a choice; the runtime is inert.
    store: Option<Store>,
    stored: Arc<Mutex<Stored>>,
    /// Serialises choice changes, which may wait on a flush while `stored`
    /// stays unlocked for the worker's gate.
    choice_change: Mutex<()>,
    env: EnvReader,
    sender: Option<Sender>,
    key_present: bool,
}

/// What the Settings page and the notice render. Mirrored by
/// `TelemetryState` in src/lib/ipc/telemetry.ts.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(crate) struct TelemetryStateDto {
    effective: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<DisabledReason>,
    choice: Option<Choice>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

impl TelemetryRuntime {
    /// The production runtime. Never fails: an unresolvable channel directory
    /// or a missing key leaves the runtime inert, and an unreadable state file
    /// counts as "no choice".
    pub(crate) fn for_this_process() -> Self {
        let environment = crate::feedback_capture::feedback_environment();
        let session_id = match sender::uuid_v7(SystemTime::now()) {
            Ok(session_id) => session_id,
            Err(error) => {
                eprintln!("[telemetry] no OS randomness, telemetry stays off: {error}");
                return Self::inert(environment);
            }
        };
        let common = Common {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            release_channel: ReleaseChannel::from_name(
                &crate::app_channel::current_name().unwrap_or_else(|_| "stable".to_string()),
            ),
            os: environment.os,
            arch: environment.arch,
            session_id,
        };
        match crate::app_channel::current() {
            Ok(channel) => Self::start(
                Some(&channel.control_dir),
                KEY,
                sender::ENDPOINT,
                common,
                Arc::new(EnvSnapshot::from_process),
            ),
            Err(error) => {
                eprintln!("[telemetry] no channel directory, telemetry stays off: {error}");
                Self::start(
                    None,
                    None,
                    sender::ENDPOINT,
                    common,
                    Arc::new(EnvSnapshot::from_process),
                )
            }
        }
    }

    /// A runtime that can never send: no store, no key, no sender.
    fn inert(environment: crate::feedback_capture::FeedbackEnvironment) -> Self {
        Self::start(
            None,
            None,
            sender::ENDPOINT,
            Common {
                app_version: env!("CARGO_PKG_VERSION").to_string(),
                release_channel: ReleaseChannel::Other,
                os: environment.os,
                arch: environment.arch,
                session_id: String::new(),
            },
            Arc::new(EnvSnapshot::from_process),
        )
    }

    pub(crate) fn start(
        directory: Option<&Path>,
        key: Option<&str>,
        endpoint: &str,
        common: Common,
        env: EnvReader,
    ) -> Self {
        let store = directory.map(Store::in_directory);
        let stored = Arc::new(Mutex::new(match store.as_ref().map(Store::read) {
            Some(Ok(stored)) => stored,
            Some(Err(error)) => {
                eprintln!("[telemetry] state unreadable, treating it as no choice: {error}");
                Stored::default()
            }
            None => Stored::default(),
        }));
        // Without a store there is no choice to keep, so there is nothing to
        // send under: the key is treated as absent.
        let key = key.filter(|key| !key.is_empty() && store.is_some());
        let sender = key.and_then(|key| {
            let gate_stored = Arc::clone(&stored);
            let gate_env = Arc::clone(&env);
            let gate: Gate = Arc::new(move || {
                consent::effective(&gate_env(), lock(&gate_stored).choice, true) == Effective::Enabled
            });
            Sender::start(endpoint.to_string(), key.to_string(), common, gate)
        });
        Self {
            store,
            stored,
            choice_change: Mutex::new(()),
            env,
            key_present: key.is_some() && sender.is_some(),
            sender,
        }
    }

    fn effective_for(&self, choice: Option<Choice>) -> Effective {
        consent::effective(&(self.env)(), choice, self.key_present)
    }

    pub(crate) fn state(&self) -> TelemetryStateDto {
        let stored = lock(&self.stored);
        self.state_of(&stored)
    }

    fn state_of(&self, stored: &Stored) -> TelemetryStateDto {
        match self.effective_for(stored.choice) {
            Effective::Enabled => TelemetryStateDto {
                effective: "enabled",
                reason: None,
                choice: stored.choice,
            },
            Effective::Pending => TelemetryStateDto {
                effective: "pending",
                reason: None,
                choice: stored.choice,
            },
            Effective::Disabled(reason) => TelemetryStateDto {
                effective: "disabled",
                reason: Some(reason),
                choice: stored.choice,
            },
        }
    }

    /// Offer one event. Dropped at the door unless consent is Enabled right
    /// now; nothing is held back for a later Accept.
    pub(crate) fn offer(&self, event: TelemetryEvent) {
        let stored = lock(&self.stored);
        if self.effective_for(stored.choice) != Effective::Enabled {
            return;
        }
        let Some(install_id) = stored.install_id.clone() else {
            return;
        };
        drop(stored);
        if let Some(sender) = &self.sender {
            sender.enqueue(event, &install_id);
        }
    }

    /// Record the person's answer. Refused, without touching the disk, when
    /// this build cannot send anyway: a keyless build shows no switch, and a
    /// runtime without a store has nowhere to keep the answer.
    pub(crate) fn set_choice(&self, choice: Choice) -> Result<TelemetryStateDto, String> {
        let _serialised = lock(&self.choice_change);
        let current = lock(&self.stored).clone();
        let Some(store) = self.store.as_ref().filter(|_| self.key_present) else {
            return Err("telemetry_unavailable".to_string());
        };
        if current.choice == Some(choice) {
            return Ok(self.state_of(&current));
        }
        let next = match choice {
            Choice::Accepted => Stored {
                install_id: Some(crate::random_token::gen_token().map_err(|error| error.to_string())?),
                choice: Some(Choice::Accepted),
                decided_at_ms: Some(now_ms()),
            },
            Choice::Declined => {
                // Accepted → Declined may say goodbye once, while the stored
                // choice still permits it. Pending → Declined has nothing to
                // send and no id to send it under.
                if let (Some(sender), Some(install_id)) = (&self.sender, current.install_id.as_deref()) {
                    if self.effective_for(current.choice) == Effective::Enabled {
                        sender.enqueue(TelemetryEvent::TelemetryOptedOut, install_id);
                        sender.flush(FLUSH_WAIT_CAP);
                    }
                }
                Stored {
                    install_id: None,
                    choice: Some(Choice::Declined),
                    decided_at_ms: Some(now_ms()),
                }
            }
        };
        store.write(&next)?;
        *lock(&self.stored) = next.clone();
        if choice == Choice::Accepted {
            self.offer(TelemetryEvent::TelemetryAccepted);
        }
        Ok(self.state_of(&next))
    }

    /// Best-effort final flush; bounded so exit never waits on the network.
    pub(crate) fn shutdown(&self) {
        if let Some(sender) = &self.sender {
            sender.flush(FLUSH_WAIT_CAP);
        }
    }

    #[cfg(test)]
    fn flush_for_test(&self) {
        if let Some(sender) = &self.sender {
            sender.flush(std::time::Duration::from_secs(5));
        }
    }
}

#[tauri::command]
pub(crate) fn telemetry_state(runtime: tauri::State<'_, TelemetryRuntime>) -> TelemetryStateDto {
    runtime.state()
}

#[tauri::command]
pub(crate) async fn telemetry_set_choice(
    app: tauri::AppHandle,
    choice: Choice,
) -> Result<TelemetryStateDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        app.state::<TelemetryRuntime>().set_choice(choice)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn telemetry_track(
    runtime: tauri::State<'_, TelemetryRuntime>,
    event: TelemetryEvent,
) -> Result<(), String> {
    if event.is_native_only() {
        return Err("native_only".to_string());
    }
    runtime.offer(event);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::sender::tests::{common, Intake};
    use super::*;

    fn quiet_env() -> EnvReader {
        Arc::new(EnvSnapshot::default)
    }

    fn runtime(directory: &Path, intake: &Intake, key: Option<&str>, env: EnvReader) -> TelemetryRuntime {
        TelemetryRuntime::start(Some(directory), key, &intake.endpoint, common(), env)
    }

    fn events(request: &serde_json::Value) -> Vec<String> {
        request["batch"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["event"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn nothing_leaves_before_accept_and_accept_sends_only_its_own_event() {
        let directory = tempfile::tempdir().unwrap();
        let intake = Intake::start(200);
        let runtime = runtime(directory.path(), &intake, Some("phc_test"), quiet_env());
        assert_eq!(runtime.state().effective, "pending");

        runtime.offer(TelemetryEvent::AppOpened);
        runtime.offer(TelemetryEvent::PaneHidden);
        runtime.flush_for_test();
        assert!(intake.requests().is_empty());

        let state = runtime.set_choice(Choice::Accepted).unwrap();
        assert_eq!(state.effective, "enabled");
        runtime.flush_for_test();
        let requests = intake.requests();
        assert_eq!(requests.len(), 1, "{requests:?}");
        assert_eq!(events(&requests[0]), ["telemetry_accepted"]);
        let stored = Store::in_directory(directory.path()).read().unwrap();
        assert_eq!(
            requests[0]["batch"][0]["distinct_id"].as_str(),
            stored.install_id.as_deref()
        );
        assert_eq!(stored.install_id.map(|id| id.len()), Some(32));

        runtime.offer(TelemetryEvent::PaneHidden);
        runtime.flush_for_test();
        let requests = intake.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(events(&requests[1]), ["pane_hidden"]);
    }

    #[test]
    fn do_not_track_beats_a_stored_accept_without_touching_it() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::in_directory(directory.path());
        store
            .write(&Stored {
                install_id: Some("0123456789abcdef0123456789abcdef".into()),
                choice: Some(Choice::Accepted),
                decided_at_ms: Some(1),
            })
            .unwrap();
        let bytes_before = std::fs::read(directory.path().join("telemetry.json")).unwrap();
        let intake = Intake::start(200);
        let env: EnvReader = Arc::new(|| EnvSnapshot::from_lookup(|name| name == "DO_NOT_TRACK"));
        let runtime = runtime(directory.path(), &intake, Some("phc_test"), env);

        let state = runtime.state();
        assert_eq!(state.effective, "disabled");
        assert_eq!(state.reason, Some(DisabledReason::DoNotTrack));
        assert_eq!(state.choice, Some(Choice::Accepted));

        runtime.offer(TelemetryEvent::PaneHidden);
        runtime.flush_for_test();
        assert!(intake.requests().is_empty());
        assert_eq!(
            std::fs::read(directory.path().join("telemetry.json")).unwrap(),
            bytes_before
        );
    }

    #[test]
    fn declining_from_pending_sends_nothing_and_mints_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let intake = Intake::start(200);
        let runtime = runtime(directory.path(), &intake, Some("phc_test"), quiet_env());
        let state = runtime.set_choice(Choice::Declined).unwrap();
        assert_eq!(state.effective, "disabled");
        assert_eq!(state.reason, Some(DisabledReason::Declined));
        runtime.flush_for_test();
        assert!(intake.requests().is_empty());
        let stored = Store::in_directory(directory.path()).read().unwrap();
        assert_eq!(stored.install_id, None);
        assert_eq!(stored.choice, Some(Choice::Declined));
    }

    #[test]
    fn declining_after_accept_says_goodbye_once_and_rotates_the_id() {
        let directory = tempfile::tempdir().unwrap();
        let intake = Intake::start(200);
        let runtime = runtime(directory.path(), &intake, Some("phc_test"), quiet_env());
        runtime.set_choice(Choice::Accepted).unwrap();
        runtime.flush_for_test();
        let first_id = Store::in_directory(directory.path())
            .read()
            .unwrap()
            .install_id
            .unwrap();

        runtime.set_choice(Choice::Declined).unwrap();
        let requests = intake.requests();
        assert_eq!(requests.len(), 2, "{requests:?}");
        assert_eq!(events(&requests[1]), ["telemetry_opted_out"]);
        assert_eq!(requests[1]["batch"][0]["distinct_id"], first_id.as_str());
        assert_eq!(
            Store::in_directory(directory.path()).read().unwrap().install_id,
            None
        );

        runtime.offer(TelemetryEvent::PaneHidden);
        runtime.flush_for_test();
        assert_eq!(intake.requests().len(), 2);

        runtime.set_choice(Choice::Accepted).unwrap();
        let second_id = Store::in_directory(directory.path())
            .read()
            .unwrap()
            .install_id
            .unwrap();
        assert_ne!(first_id, second_id);
    }

    #[test]
    fn declining_under_do_not_track_sends_no_goodbye() {
        let directory = tempfile::tempdir().unwrap();
        Store::in_directory(directory.path())
            .write(&Stored {
                install_id: Some("0123456789abcdef0123456789abcdef".into()),
                choice: Some(Choice::Accepted),
                decided_at_ms: Some(1),
            })
            .unwrap();
        let intake = Intake::start(200);
        let env: EnvReader = Arc::new(|| EnvSnapshot::from_lookup(|name| name == "CI"));
        let runtime = runtime(directory.path(), &intake, Some("phc_test"), env);
        runtime.set_choice(Choice::Declined).unwrap();
        runtime.flush_for_test();
        assert!(intake.requests().is_empty());
    }

    #[test]
    fn a_build_without_a_key_is_inert_whatever_is_chosen() {
        let directory = tempfile::tempdir().unwrap();
        let intake = Intake::start(200);
        let runtime = runtime(directory.path(), &intake, None, quiet_env());
        assert_eq!(runtime.state().reason, Some(DisabledReason::NoKey));
        assert_eq!(
            runtime.set_choice(Choice::Accepted),
            Err("telemetry_unavailable".to_string())
        );
        runtime.offer(TelemetryEvent::PaneHidden);
        runtime.flush_for_test();
        assert!(intake.requests().is_empty());
        assert!(
            std::fs::read_dir(directory.path()).unwrap().next().is_none(),
            "a keyless build writes nothing"
        );

        let blank_key = TelemetryRuntime::start(Some(directory.path()), Some(""), &intake.endpoint, common(), quiet_env());
        assert_eq!(blank_key.state().reason, Some(DisabledReason::NoKey));

        let no_store = TelemetryRuntime::start(None, Some("phc_test"), &intake.endpoint, common(), quiet_env());
        assert_eq!(no_store.state().reason, Some(DisabledReason::NoKey));
        assert!(no_store.set_choice(Choice::Accepted).is_err());
        assert!(!std::path::Path::new("telemetry.json").exists());
    }

    #[test]
    fn an_unreadable_state_file_is_no_choice_and_is_not_rewritten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("telemetry.json");
        std::fs::write(&path, "{\"schema_version\": 9}\n").unwrap();
        let intake = Intake::start(200);
        let runtime = runtime(directory.path(), &intake, Some("phc_test"), quiet_env());
        assert_eq!(runtime.state().effective, "pending");
        runtime.offer(TelemetryEvent::PaneHidden);
        runtime.flush_for_test();
        assert!(intake.requests().is_empty());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"schema_version\": 9}\n"
        );
    }

    #[test]
    fn the_webview_may_not_offer_lifecycle_events() {
        let value: serde_json::Value = serde_json::json!({"event": "telemetry_accepted"});
        let event: TelemetryEvent = serde_json::from_value(value).unwrap();
        assert!(event.is_native_only());
    }
}
