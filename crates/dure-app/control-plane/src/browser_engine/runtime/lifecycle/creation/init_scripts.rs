//! Startup inputs are consumed by the existing construction owner. Chromium
//! retains registrations on the launch Page; no resource-level registry remains.
use super::*;

#[derive(Debug, Default, Deserialize)]
#[serde(try_from = "Vec<String>")]
pub(crate) struct BrowserLaunchScripts {
    user: Vec<String>,
    react_devtools: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserLaunchFeature {
    ReactDevtools,
}

impl TryFrom<Vec<String>> for BrowserLaunchScripts {
    type Error = &'static str;

    fn try_from(scripts: Vec<String>) -> Result<Self, Self::Error> {
        if scripts.len() > 16 {
            return Err("browser_init_script_files_invalid");
        }
        let bytes = scripts
            .iter()
            .try_fold(0usize, |bytes, script| bytes.checked_add(script.len()));
        if bytes.is_none_or(|bytes| bytes > 64 * 1024) {
            return Err("browser_script_too_large");
        }
        Ok(Self {
            user: scripts,
            react_devtools: false,
        })
    }
}

impl BrowserLaunchScripts {
    pub(crate) fn with_features(mut self, features: Vec<BrowserLaunchFeature>) -> Self {
        self.react_devtools = features
            .iter()
            .any(|feature| matches!(feature, BrowserLaunchFeature::ReactDevtools));
        self
    }

    pub(super) async fn install(
        &self,
        binding: &HostBindingRetirement,
        events: &events::BrowserEventMonitor,
        target: &BrowserTargetId,
    ) -> Result<(), BrowserRuntimeError> {
        if self.user.is_empty() && !self.react_devtools {
            return Ok(());
        }
        events.synchronize(target).await?;
        let mut cdp = execution::renderer_cdp(
            &binding.host,
            &binding.changed,
            events.cdp.clone(),
            target.clone(),
            None,
        );
        let hook = self
            .react_devtools
            .then_some(include_str!("../../react/installHook.js"));
        for script in hook.into_iter().chain(self.user.iter().map(String::as_str)) {
            let source = {
                let mut host = binding.host.lock().await;
                host.require_instance_binding(&binding.identity, &binding.instance)?;
                if host.instance_for_target(target) != Some(&binding.instance) {
                    return Err("browser_page_owner_mismatch".into());
                }
                host.network()
                    .page_source(target)
                    .ok_or("browser_page_source_missing")?
            };
            // This task retains cleanup before dispatch. Failure or caller
            // cancellation retires the initial page instead of publishing it.
            let response = cdp
                .request(
                    "Page.addScriptToEvaluateOnNewDocument",
                    json!({"source":script}),
                    Some(source.as_str()),
                )
                .await
                .map_err(|code| {
                    if code == "browser_cdp_request_rejected" {
                        BrowserEngineError::before("browser_init_script_rejected")
                    } else {
                        BrowserEngineError::after("browser_init_script_outcome_unknown")
                    }
                })?;
            if response["identifier"].as_str().is_none_or(str::is_empty) {
                return Err(
                    BrowserEngineError::after("browser_init_script_identifier_missing").into(),
                );
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_init_scripts_validate_the_entire_startup_input_before_creation() {
        for values in [vec![], vec!["".to_owned(); 16], vec!["a".repeat(64 * 1024)]] {
            assert!(serde_json::from_value::<BrowserLaunchScripts>(json!(values)).is_ok());
        }
        for values in [
            vec!["".to_owned(); 17],
            vec!["a".repeat(33 * 1024); 2],
            vec!["한".repeat(21846)],
        ] {
            assert!(serde_json::from_value::<BrowserLaunchScripts>(json!(values)).is_err());
        }
        assert!(serde_json::from_value::<BrowserLaunchScripts>(json!([null])).is_err());
    }
}
