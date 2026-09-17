use super::*;
use tauri::WebviewWindow;

const REALM_OBSERVATION_WAIT: Duration = Duration::from_secs(5);

enum WebviewClaim {
    Current(ObserverWebviewBinding),
    Unconfirmed(ObserverWebviewBinding),
}

impl ObserverWebviewLifecycle {
    fn prepare_claim(
        &mut self,
        window_label: &str,
        instance_id: &str,
    ) -> Result<WebviewClaim, String> {
        let window = self.window(window_label, instance_id)?;
        match &window.owner {
            WebviewInstanceOwner::Unbound if !window.retired_instance_ids.contains(instance_id) => {
                Ok(WebviewClaim::Unconfirmed(
                    window.binding_record(window_label, instance_id),
                ))
            }
            _ => window
                .binding(window_label, instance_id)
                .map(WebviewClaim::Current),
        }
    }

    fn confirm_claim(
        &mut self,
        candidate: ObserverWebviewBinding,
        matches_current_document: bool,
    ) -> Result<ObserverWebviewBinding, String> {
        let current = self.windows.get_mut(candidate.window_label());
        match current {
            Some(current)
                if matches_current_document
                    && candidate.is_live()
                    && Arc::ptr_eq(&current.live, &candidate.live) =>
            {
                current.binding(candidate.window_label(), candidate.instance_id())
            }
            _ => Err("hmux_webview_instance_stale: request does not belong to the current WebView document".into()),
        }
    }

    fn existing_binding(
        &mut self,
        window_label: &str,
        instance_id: &str,
    ) -> Result<ObserverWebviewBinding, String> {
        match self.prepare_claim(window_label, instance_id)? {
            WebviewClaim::Current(binding) => Ok(binding),
            WebviewClaim::Unconfirmed(_) => Err(
                "hmux_webview_instance_unbound: attach must confirm the WebView document before reading output".into(),
            ),
        }
    }
}

impl HmuxManager {
    pub(crate) fn capture_existing_observer_webview(
        &self,
        window_label: &str,
        instance_id: &str,
    ) -> Result<ObserverWebviewBinding, String> {
        validate_identifier("WebView instance id", instance_id)?;
        self.observer_webviews
            .lock()
            .map_err(|_| "Hmux observer WebView lifecycle poisoned".to_string())?
            .existing_binding(window_label, instance_id)
    }

    pub(crate) async fn claim_observer_webview(
        &self,
        window: &WebviewWindow,
        instance_id: &str,
    ) -> Result<ObserverWebviewBinding, String> {
        validate_identifier("WebView instance id", instance_id)?;
        let claim = self
            .observer_webviews
            .lock()
            .map_err(|_| "Hmux observer WebView lifecycle poisoned".to_string())?
            .prepare_claim(window.label(), instance_id)?;
        let candidate = match claim {
            WebviewClaim::Current(binding) => return Ok(binding),
            WebviewClaim::Unconfirmed(candidate) => candidate,
        };

        // The first invoke may be queued in a dead, never-bound realm. Ask the
        // actual WebView before granting its claim; no request can self-attest.
        // Retain the existing generation lifetime across this one cold-path hop.
        let instance = serde_json::to_string(instance_id).map_err(|error| error.to_string())?;
        let script = format!("globalThis.__dureHmuxDiagnosticWebviewInstanceV1 === {instance}");
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let sender = Mutex::new(Some(sender));
        window
            .eval_with_callback(script, move |result| {
                if let Some(sender) = sender
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take()
                {
                    let _ = sender.send(result == "true");
                }
            })
            .map_err(|error| format!("hmux_webview_observation_failed: {error}"))?;
        let matches = tokio::time::timeout(REALM_OBSERVATION_WAIT, receiver)
            .await
            .map_err(|_| {
                "hmux_webview_observation_timeout: current document did not answer".to_string()
            })?
            .map_err(|_| {
                "hmux_webview_observation_cancelled: current document was destroyed".to_string()
            })?;
        self.observer_webviews
            .lock()
            .map_err(|_| "Hmux observer WebView lifecycle poisoned".to_string())?
            .confirm_claim(candidate, matches)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(lifecycle: &mut ObserverWebviewLifecycle, id: &str) -> ObserverWebviewBinding {
        match lifecycle.prepare_claim("window-a", id).unwrap() {
            WebviewClaim::Unconfirmed(candidate) => candidate,
            WebviewClaim::Current(_) => panic!("expected an unconfirmed document"),
        }
    }

    #[test]
    fn never_bound_predecessor_cannot_claim_the_reload_successor() {
        let mut lifecycle = ObserverWebviewLifecycle::default();
        lifecycle.begin_page_load("window-a");
        lifecycle.begin_page_load("window-a");
        let predecessor = pending(&mut lifecycle, "old-realm");
        assert!(lifecycle
            .confirm_claim(predecessor, false)
            .unwrap_err()
            .starts_with("hmux_webview_instance_stale:"));
        let current = pending(&mut lifecycle, "current-realm");
        assert!(lifecycle.confirm_claim(current, true).unwrap().is_live());
    }

    #[test]
    fn reload_during_observation_cannot_publish_a_late_confirmation() {
        let mut lifecycle = ObserverWebviewLifecycle::default();
        let predecessor = pending(&mut lifecycle, "old-realm");
        lifecycle.begin_page_load("window-a");
        assert!(lifecycle
            .confirm_claim(predecessor, true)
            .unwrap_err()
            .starts_with("hmux_webview_instance_stale:"));
        let current = pending(&mut lifecycle, "current-realm");
        assert!(lifecycle.confirm_claim(current, true).unwrap().is_live());
    }

    #[test]
    fn concurrent_confirmations_of_one_document_converge_without_more_observations() {
        let mut lifecycle = ObserverWebviewLifecycle::default();
        let first = pending(&mut lifecycle, "current-realm");
        let second = pending(&mut lifecycle, "current-realm");
        let first = lifecycle.confirm_claim(first, true).unwrap();
        let second = lifecycle.confirm_claim(second, true).unwrap();
        assert!(first.same_generation(&second));
        let WebviewClaim::Current(current) = lifecycle
            .prepare_claim("window-a", "current-realm")
            .unwrap()
        else {
            panic!("a bound document must not need another WebView observation");
        };
        assert!(current.same_generation(&first));
    }

    #[test]
    fn output_pull_cannot_claim_an_unconfirmed_document() {
        let mut lifecycle = ObserverWebviewLifecycle::default();
        assert!(lifecycle
            .existing_binding("window-a", "old-realm")
            .unwrap_err()
            .starts_with("hmux_webview_instance_unbound:"));
        let current = pending(&mut lifecycle, "current-realm");
        let current = lifecycle.confirm_claim(current, true).unwrap();
        assert!(lifecycle
            .existing_binding("window-a", "current-realm")
            .unwrap()
            .same_generation(&current));
    }

    #[test]
    fn destruction_during_observation_does_not_recreate_a_window() {
        let mut lifecycle = ObserverWebviewLifecycle::default();
        let candidate = pending(&mut lifecycle, "old-realm");
        lifecycle.forget_window("window-a");
        assert!(lifecycle.confirm_claim(candidate, true).is_err());
        assert_eq!(lifecycle.window_count(), 0);
    }
}
