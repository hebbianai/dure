//! React page instrumentation shares action admission and native registration ownership.

use super::*;
use std::num::NonZeroU64;

mod renders;
mod suspense;
mod tree;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum ReactAction {
    Tree,
    Inspect {
        fiber_id: NonZeroU64,
    },
    RendersStart,
    RendersStop,
    Suspense {
        #[serde(default)]
        only_dynamic: bool,
    },
}

#[derive(Clone)]
pub(super) struct NativeReactProfile {
    session: String,
    registration: Option<String>,
}

// Only native removal handles live here. Host owns the target/controller and
// page lifetime; the page's React profiler owns its measured render data.
pub(super) type ReactProfiles = Arc<Mutex<BTreeMap<BrowserTargetId, NativeReactProfile>>>;

impl Execution<'_> {
    pub(super) async fn react_action(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        cdp: BrowserCdp,
        action: &ReactAction,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let target = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        let script = match action {
            ReactAction::Tree => include_str!("react/tree.js").to_owned(),
            ReactAction::Inspect { fiber_id } => {
                if fiber_id.get() > 9_007_199_254_740_991 {
                    return Err("browser_react_fiber_invalid".into());
                }
                include_str!("react/inspect.js").replace("{{ID}}", &fiber_id.to_string())
            }
            ReactAction::Suspense { .. } => include_str!("react/suspense.js").to_owned(),
            ReactAction::RendersStart => {
                return self.start_react_profile(engine, permit, cdp, target).await;
            }
            ReactAction::RendersStop => {
                self.remove_react_registration(&target).await?;
                include_str!("react/renders-stop.js").to_owned()
            }
        };
        let response = self
            .evaluate_action(permit, cdp, &script, ENGINE_DEADLINE)
            .await?;
        if !response.success {
            if matches!(action, ReactAction::RendersStop) {
                self.binding
                    .retirement
                    .react_profiles
                    .lock()
                    .await
                    .remove(&target);
            }
            return Ok(response);
        }
        if matches!(action, ReactAction::RendersStop) {
            self.binding
                .retirement
                .react_profiles
                .lock()
                .await
                .remove(&target);
        }
        self.observe_engine(engine).await?;
        self.resource.host.lock().await.dispatch_target(permit)?;
        let raw: Value = serde_json::from_str(
            response.data["result"]
                .as_str()
                .ok_or("browser_react_data_invalid")?,
        )
        .map_err(|_| "browser_react_data_invalid")?;
        let data = match action {
            ReactAction::Tree => {
                let nodes: Vec<tree::TreeNode> = serde_json::from_value(raw.clone())
                    .map_err(|_| "browser_react_tree_invalid")?;
                json!({"nodes":raw,"tree":tree::format_tree(&nodes)?})
            }
            ReactAction::Inspect { .. } => raw,
            ReactAction::Suspense { only_dynamic } => {
                let mut boundaries: Vec<suspense::Boundary> =
                    serde_json::from_value(raw).map_err(|_| "browser_react_suspense_invalid")?;
                if *only_dynamic {
                    boundaries.retain(|boundary| {
                        boundary.parent_id != 0
                            && (boundary.is_suspended
                                || !boundary.suspended_by.is_empty()
                                || boundary.unknown_suspenders.is_some())
                    });
                }
                json!({"report":suspense::format_suspense_report(&boundaries,*only_dynamic),"boundaries":boundaries})
            }
            ReactAction::RendersStop => {
                let measured: renders::RendersData = serde_json::from_value(raw.clone())
                    .map_err(|_| "browser_react_renders_invalid")?;
                let mut data = raw;
                data["report"] = json!(renders::format_renders_report(&measured));
                data
            }
            ReactAction::RendersStart => unreachable!("start returns its retained registration"),
        };
        Ok(NativeBrowserResponse {
            id: "browser-react".into(),
            success: true,
            data,
            error: None,
        })
    }

    async fn start_react_profile(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        cdp: BrowserCdp,
        target: BrowserTargetId,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let mut profiles = self.binding.retirement.react_profiles.lock().await;
        let live = self
            .resource
            .host
            .lock()
            .await
            .instance_targets(self.binding.events.instance());
        profiles.retain(|target, _| live.contains(target));
        if profiles.contains_key(&target) {
            return Err("browser_react_renders_already_started".into());
        }
        let session = self
            .resource
            .host
            .lock()
            .await
            .network()
            .page_source(&target)
            .ok_or("browser_page_source_missing")?;
        let mut retained = self.renderer_cdp(self.binding.events.cdp.clone(), target.clone());
        self.resource.host.lock().await.dispatch_target(permit)?;
        let registered = retained
            .request(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"source":include_str!("react/renders-init.js")}),
                Some(session.as_str()),
            )
            .await
            .map_err(|_| BrowserEngineError::after("browser_react_registration_unknown"))?;
        let identifier = registered["identifier"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| BrowserEngineError::after("browser_react_registration_unknown"))?
            .to_owned();
        profiles.insert(
            target.clone(),
            NativeReactProfile {
                session: session.as_str().to_owned(),
                registration: Some(identifier),
            },
        );
        drop(profiles);
        // Retain the exact future-document removal handle before activating
        // the current document. Failed activation must not leave a future
        // navigation silently starting a profiler whose start was rejected.
        let initialized = self
            .evaluate_action(
                permit,
                cdp,
                include_str!("react/renders-init.js"),
                ENGINE_DEADLINE,
            )
            .await;
        if !matches!(&initialized, Ok(response) if response.success) {
            self.remove_react_registration(&target).await?;
            self.binding
                .retirement
                .react_profiles
                .lock()
                .await
                .remove(&target);
            return initialized;
        }
        self.observe_engine(engine).await?;
        self.resource.host.lock().await.dispatch_target(permit)?;
        Ok(NativeBrowserResponse {
            id: "browser-react-renders-start".into(),
            success: true,
            data: json!({"recording":true}),
            error: None,
        })
    }

    async fn remove_react_registration(
        &self,
        target: &BrowserTargetId,
    ) -> Result<(), BrowserRuntimeError> {
        let mut profiles = self.binding.retirement.react_profiles.lock().await;
        let profile = profiles
            .get_mut(target)
            .ok_or("browser_react_renders_not_started")?;
        let Some(identifier) = &profile.registration else {
            return Ok(());
        };
        // Removing a retained registration is compensation on its original
        // Page session, including when activation changed that document.
        let mut retained = self.renderer_cdp(self.binding.events.cdp.clone(), target.clone());
        retained
            .request(
                "Page.removeScriptToEvaluateOnNewDocument",
                json!({"identifier":identifier}),
                Some(&profile.session),
            )
            .await
            .map_err(|_| BrowserEngineError::after("browser_react_cleanup_unknown"))?;
        // A later known evaluation failure can resume stopping without trying
        // to remove an already-acknowledged native registration again.
        profile.registration = None;
        Ok(())
    }
}
