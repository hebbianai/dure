use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};
use tauri::{webview::PageLoadEvent, Manager, Wry};

use super::{validate_identifier, HmuxManager};

mod claim;

const PREDECESSOR_RETIREMENT_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug)]
struct ObserverWebviewRetirement {
    complete: Mutex<bool>,
    changed: Condvar,
}

impl ObserverWebviewRetirement {
    fn completed() -> Arc<Self> {
        Arc::new(Self {
            complete: Mutex::new(true),
            changed: Condvar::new(),
        })
    }

    fn pending() -> Arc<Self> {
        Arc::new(Self {
            complete: Mutex::new(false),
            changed: Condvar::new(),
        })
    }

    fn is_complete(&self) -> bool {
        *self
            .complete
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn complete(&self) {
        let mut complete = self
            .complete
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *complete = true;
        self.changed.notify_all();
    }

    fn wait(&self) {
        let mut complete = self
            .complete
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while !*complete {
            complete = self
                .changed
                .wait(complete)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    fn wait_for(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut complete = self
            .complete
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while !*complete {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let (next, result) = self
                .changed
                .wait_timeout(complete, deadline.saturating_duration_since(now))
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            complete = next;
            if result.timed_out() && !*complete {
                return false;
            }
        }
        true
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ObserverWebviewBinding {
    window_label: String,
    webview_instance_id: String,
    generation: u64,
    live: Arc<RwLock<bool>>,
    predecessor_retirement: Arc<ObserverWebviewRetirement>,
}

impl ObserverWebviewBinding {
    pub(super) fn window_label(&self) -> &str {
        &self.window_label
    }

    pub(super) fn instance_id(&self) -> &str {
        &self.webview_instance_id
    }

    pub(super) fn generation(&self) -> u64 {
        self.generation
    }

    pub(super) fn lifetime_identity(&self) -> usize {
        Arc::as_ptr(&self.live) as usize
    }

    pub(super) fn is_live(&self) -> bool {
        self.live.read().is_ok_and(|live| *live)
    }

    pub(super) fn same_generation(&self, other: &Self) -> bool {
        self.window_label == other.window_label
            && self.webview_instance_id == other.webview_instance_id
            && self.generation == other.generation
            && Arc::ptr_eq(&self.live, &other.live)
    }

    pub(crate) fn require_live(&self, message: &'static str) -> Result<(), String> {
        self.is_live()
            .then_some(())
            .ok_or_else(|| message.to_string())
    }

    pub(super) fn wait_for_predecessor_retirement(&self) -> Result<(), String> {
        self.require_live(
            "hmux_structured_webview_stale: structured terminal attach belongs to an inactive WebView generation",
        )?;
        if !self
            .predecessor_retirement
            .wait_for(PREDECESSOR_RETIREMENT_WAIT)
        {
            return Err(
                "hmux_structured_predecessor_retirement_timeout: prior WebView terminal surface is still retiring"
                    .to_string(),
            );
        }
        self.require_live(
            "hmux_structured_webview_stale: structured terminal attach belongs to an inactive WebView generation",
        )
    }

    pub(super) fn require_same_generation(
        &self,
        other: &Self,
        message: &'static str,
    ) -> Result<(), String> {
        (self.is_live() && self.same_generation(other))
            .then_some(())
            .ok_or_else(|| message.to_string())
    }
}

#[derive(Debug)]
enum WebviewInstanceOwner {
    Unbound,
    Bound(String),
}

#[derive(Debug)]
struct WindowGeneration {
    generation: u64,
    owner: WebviewInstanceOwner,
    retired_instance_ids: HashSet<String>,
    live: Arc<RwLock<bool>>,
    predecessor_retirement: Arc<ObserverWebviewRetirement>,
}

impl WindowGeneration {
    fn new(
        generation: u64,
        retired_instance_ids: HashSet<String>,
        predecessor_retirement: Arc<ObserverWebviewRetirement>,
    ) -> Self {
        Self {
            generation,
            owner: WebviewInstanceOwner::Unbound,
            retired_instance_ids,
            live: Arc::new(RwLock::new(true)),
            predecessor_retirement,
        }
    }

    fn binding(
        &mut self,
        window_label: &str,
        webview_instance_id: &str,
    ) -> Result<ObserverWebviewBinding, String> {
        match &self.owner {
            WebviewInstanceOwner::Unbound
                if self.retired_instance_ids.contains(webview_instance_id) =>
            {
                return Err(format!(
                    "hmux_webview_instance_stale: window {window_label} request belongs to a retired WebView instance"
                ));
            }
            WebviewInstanceOwner::Unbound => {
                self.owner = WebviewInstanceOwner::Bound(webview_instance_id.to_string());
            }
            WebviewInstanceOwner::Bound(current) if current != webview_instance_id => {
                return Err(format!(
                    "hmux_webview_generation_conflict: window {window_label} is already bound to another WebView instance"
                ));
            }
            WebviewInstanceOwner::Bound(_) => {}
        }
        Ok(self.binding_record(window_label, webview_instance_id))
    }

    fn binding_record(
        &self,
        window_label: &str,
        webview_instance_id: &str,
    ) -> ObserverWebviewBinding {
        ObserverWebviewBinding {
            window_label: window_label.to_string(),
            webview_instance_id: webview_instance_id.to_string(),
            generation: self.generation,
            live: Arc::clone(&self.live),
            predecessor_retirement: Arc::clone(&self.predecessor_retirement),
        }
    }

    fn revoke(&self) {
        match self.live.write() {
            Ok(mut live) => *live = false,
            Err(poisoned) => *poisoned.into_inner() = false,
        }
    }

    fn into_successor(self) -> (u64, HashSet<String>, Arc<ObserverWebviewRetirement>) {
        self.revoke();
        let next_generation = self.generation.wrapping_add(1).max(1);
        let mut retired_instance_ids = self.retired_instance_ids;
        if let WebviewInstanceOwner::Bound(instance_id) = self.owner {
            retired_instance_ids.insert(instance_id);
        }
        (
            next_generation,
            retired_instance_ids,
            self.predecessor_retirement,
        )
    }
}

#[derive(Default)]
pub(super) struct ObserverWebviewLifecycle {
    windows: HashMap<String, WindowGeneration>,
}

impl ObserverWebviewLifecycle {
    #[cfg(test)]
    pub(super) fn begin_page_load(&mut self, window_label: &str) -> u64 {
        self.begin_page_load_after(window_label, ObserverWebviewRetirement::completed())
            .0
    }

    fn begin_page_load_after(
        &mut self,
        window_label: &str,
        predecessor_retirement: Arc<ObserverWebviewRetirement>,
    ) -> (u64, Arc<ObserverWebviewRetirement>) {
        let (next_generation, retired_instance_ids, prior_retirement) = self
            .windows
            .remove(window_label)
            .map(WindowGeneration::into_successor)
            .unwrap_or_else(|| (1, HashSet::new(), ObserverWebviewRetirement::completed()));
        self.windows.insert(
            window_label.to_string(),
            WindowGeneration::new(
                next_generation,
                retired_instance_ids,
                predecessor_retirement,
            ),
        );
        (next_generation, prior_retirement)
    }

    #[cfg(any(test, debug_assertions))]
    pub(super) fn bind(
        &mut self,
        window_label: &str,
        webview_instance_id: &str,
    ) -> Result<ObserverWebviewBinding, String> {
        self.window(window_label, webview_instance_id)?
            .binding(window_label, webview_instance_id)
    }

    fn window(
        &mut self,
        window_label: &str,
        webview_instance_id: &str,
    ) -> Result<&mut WindowGeneration, String> {
        if window_label.is_empty() {
            return Err("hmux_webview_window_missing: native window label is empty".to_string());
        }
        if webview_instance_id.is_empty() {
            return Err("hmux_webview_instance_missing: WebView instance id is empty".to_string());
        }
        Ok(self
            .windows
            .entry(window_label.to_string())
            .or_insert_with(|| {
                WindowGeneration::new(1, HashSet::new(), ObserverWebviewRetirement::completed())
            }))
    }

    pub(super) fn forget_window(&mut self, window_label: &str) {
        if let Some(current) = self.windows.remove(window_label) {
            current.revoke();
        }
    }

    #[cfg(test)]
    fn window_count(&self) -> usize {
        self.windows.len()
    }
}

impl HmuxManager {
    // Trusted native fixture seam. IPC callers must confirm the actual realm.
    #[cfg(any(test, debug_assertions))]
    pub(crate) fn capture_observer_webview(
        &self,
        window_label: &str,
        webview_instance_id: &str,
    ) -> Result<ObserverWebviewBinding, String> {
        validate_identifier("WebView instance id", webview_instance_id)?;
        self.observer_webviews
            .lock()
            .map_err(|_| "Hmux observer WebView lifecycle poisoned".to_string())?
            .bind(window_label, webview_instance_id)
    }

    pub(crate) fn begin_observer_webview_load(
        &self,
        window_label: &str,
    ) -> Result<(u64, usize), String> {
        self.retire_observer_webview(window_label, true)
    }

    pub(crate) fn forget_observer_webview(&self, window_label: &str) -> Result<usize, String> {
        self.retire_observer_webview(window_label, false)
            .map(|(_, retired)| retired)
    }

    fn retire_observer_webview(
        &self,
        window_label: &str,
        begin_next_generation: bool,
    ) -> Result<(u64, usize), String> {
        let operation = self
            .operations
            .lock()
            .map_err(|_| "Hmux operations poisoned".to_string())?;
        let next_retirement = begin_next_generation.then(ObserverWebviewRetirement::pending);
        let (generation, prior_retirement) = {
            let mut lifecycle = self
                .observer_webviews
                .lock()
                .map_err(|_| "Hmux observer WebView lifecycle poisoned".to_string())?;
            if begin_next_generation {
                lifecycle.begin_page_load_after(
                    window_label,
                    Arc::clone(
                        next_retirement
                            .as_ref()
                            .expect("next generation retirement barrier exists"),
                    ),
                )
            } else {
                lifecycle.forget_window(window_label);
                (0, ObserverWebviewRetirement::completed())
            }
        };
        let structured_retired = {
            let mut observers = self
                .structured_terminals
                .lock()
                .map_err(|_| "Hmux structured terminal registry poisoned".to_string())?;
            let slots = observers
                .iter()
                .filter(|(_, entry)| entry.webview().window_label() == window_label)
                .map(|(slot, _)| slot.clone())
                .collect::<Vec<_>>();
            slots
                .into_iter()
                .filter_map(|slot| observers.remove(&slot))
                .collect::<Vec<_>>()
        };
        for task in &structured_retired {
            task.begin_stop();
        }
        let retired_count = structured_retired.len();
        drop(operation);
        let wait_for_prior = !prior_retirement.is_complete();
        if !structured_retired.is_empty() || wait_for_prior {
            tauri::async_runtime::spawn_blocking(move || {
                prior_retirement.wait();
                for task in structured_retired {
                    if let Err(error) = task.stop_confirmed() {
                        eprintln!(
                            "[hmux-observer-webview] event=structured_detach_unconfirmed error={error}"
                        );
                    }
                }
                // This barrier means every predecessor retirement reached a
                // terminal outcome, not that every remote detach was confirmed.
                // The revoked WebView generation fences the old local owner and
                // the Host still arbitrates the exact session generation. Keeping
                // this window-wide barrier pending after one transport failure
                // would instead prevent every unrelated pane from reconnecting.
                if let Some(retirement) = next_retirement {
                    retirement.complete();
                }
            });
        } else if let Some(retirement) = next_retirement {
            retirement.complete();
        }
        Ok((generation, retired_count))
    }
}

pub(crate) fn configure_builder(builder: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    builder
        .on_page_load(|webview, payload| {
            if payload.event() != PageLoadEvent::Started {
                return;
            }
            match webview
                .state::<crate::AppState>()
                .hmux
                .begin_observer_webview_load(webview.label())
            {
                Ok((generation, retired)) if retired > 0 => eprintln!(
                    "[hmux-observer-webview] event=page_started window={} generation={generation} retired_observers={retired}",
                    webview.label()
                ),
                Ok(_) => {}
                Err(error) => eprintln!(
                    "[hmux-observer-webview] event=page_started_failed window={} error={error}",
                    webview.label()
                ),
            }
        })
        .on_window_event(|window, event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            if let Err(error) = window
                .state::<crate::AppState>()
                .hmux
                .forget_observer_webview(window.label())
            {
                eprintln!(
                    "[hmux-observer-webview] event=window_destroyed_failed window={} error={error}",
                    window.label()
                );
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reload_retires_all_matching_window_bindings_but_not_other_windows() {
        let mut lifecycle = ObserverWebviewLifecycle::default();
        assert_eq!(lifecycle.begin_page_load("window-a"), 1);
        assert_eq!(lifecycle.begin_page_load("window-b"), 1);
        let visible_a = lifecycle.bind("window-a", "boot-a-1").unwrap();
        let hidden_a = lifecycle.bind("window-a", "boot-a-1").unwrap();
        let old_b = lifecycle.bind("window-b", "boot-b-1").unwrap();

        assert_eq!(lifecycle.begin_page_load("window-a"), 2);
        let new_a = lifecycle.bind("window-a", "boot-a-2").unwrap();

        assert!(!visible_a.is_live());
        assert!(!hidden_a.is_live());
        assert!(old_b.is_live());
        assert!(new_a.is_live());
        assert!(!visible_a.same_generation(&new_a));
    }

    #[test]
    fn stale_generation_cannot_bind_as_the_current_callback_owner() {
        let mut lifecycle = ObserverWebviewLifecycle::default();
        lifecycle.begin_page_load("window-a");
        let old = lifecycle.bind("window-a", "boot-a-1").unwrap();

        lifecycle.begin_page_load("window-a");
        let current = lifecycle.bind("window-a", "boot-a-2").unwrap();

        assert!(!old.is_live());
        assert!(!old.same_generation(&current));
        assert!(old
            .require_live("slow attach may not publish after reload")
            .is_err());
        assert!(old
            .require_same_generation(&current, "stale open may not publish")
            .is_err());
        assert!(current.same_generation(&current.clone()));
    }

    #[test]
    fn outgoing_realm_cannot_claim_the_reload_successor() {
        let mut lifecycle = ObserverWebviewLifecycle::default();
        lifecycle.begin_page_load("window-a");
        let old = lifecycle.bind("window-a", "boot-a-1").unwrap();

        lifecycle.begin_page_load("window-a");
        let stale_error = lifecycle.bind("window-a", "boot-a-1").unwrap_err();
        let current = lifecycle.bind("window-a", "boot-a-2").unwrap();

        assert!(stale_error.starts_with("hmux_webview_instance_stale:"));
        assert!(!old.is_live());
        assert!(current.is_live());
        assert!(!old.same_generation(&current));
    }

    #[test]
    fn repeated_page_starts_keep_the_outgoing_realm_fenced() {
        let mut lifecycle = ObserverWebviewLifecycle::default();
        lifecycle.begin_page_load("window-a");
        lifecycle.bind("window-a", "boot-a-1").unwrap();

        lifecycle.begin_page_load("window-a");
        lifecycle.begin_page_load("window-a");

        let stale_error = lifecycle.bind("window-a", "boot-a-1").unwrap_err();
        let current = lifecycle.bind("window-a", "boot-a-2").unwrap();

        assert!(stale_error.starts_with("hmux_webview_instance_stale:"));
        assert_eq!(current.generation(), 3);
        assert!(current.is_live());
    }

    #[test]
    fn every_retired_realm_stays_fenced_across_later_reload_generations() {
        let mut lifecycle = ObserverWebviewLifecycle::default();
        lifecycle.begin_page_load("window-a");
        lifecycle.bind("window-a", "boot-a-1").unwrap();
        lifecycle.begin_page_load("window-a");
        lifecycle.bind("window-a", "boot-a-2").unwrap();

        lifecycle.begin_page_load("window-a");

        let oldest_error = lifecycle.bind("window-a", "boot-a-1").unwrap_err();
        let predecessor_error = lifecycle.bind("window-a", "boot-a-2").unwrap_err();
        let current = lifecycle.bind("window-a", "boot-a-3").unwrap();

        assert!(oldest_error.starts_with("hmux_webview_instance_stale:"));
        assert!(predecessor_error.starts_with("hmux_webview_instance_stale:"));
        assert_eq!(current.generation(), 3);
        assert!(current.is_live());
    }

    #[test]
    fn repeated_reload_keeps_one_bounded_generation_per_window() {
        let mut lifecycle = ObserverWebviewLifecycle::default();
        let mut previous = None;
        for generation in 1..=128 {
            assert_eq!(lifecycle.begin_page_load("window-a"), generation);
            let current = lifecycle
                .bind("window-a", &format!("boot-a-{generation}"))
                .unwrap();
            if let Some(previous) = previous.replace(current) {
                assert!(!previous.is_live());
            }
        }

        assert_eq!(lifecycle.window_count(), 1);
        assert!(previous.unwrap().is_live());
    }

    #[test]
    fn one_page_generation_rejects_two_frontend_instances() {
        let mut lifecycle = ObserverWebviewLifecycle::default();
        lifecycle.begin_page_load("window-a");
        lifecycle.bind("window-a", "boot-a-1").unwrap();

        let error = lifecycle.bind("window-a", "boot-a-2").unwrap_err();
        assert!(error.starts_with("hmux_webview_generation_conflict:"));
    }

    #[test]
    fn destroyed_window_revokes_and_releases_its_registry_slot() {
        let mut lifecycle = ObserverWebviewLifecycle::default();
        lifecycle.begin_page_load("window-a");
        let binding = lifecycle.bind("window-a", "boot-a-1").unwrap();

        lifecycle.forget_window("window-a");

        assert!(!binding.is_live());
        assert_eq!(lifecycle.window_count(), 0);
    }
}
