//! Profile replacement and cloning share source observation and target admission.
use super::*;

impl Destination {
    pub(super) async fn ready(
        self,
    ) -> Result<(BrowserInstanceId, Option<BrowserPageCreationPermit>), BrowserRuntimeError> {
        match self {
            Self::Existing { source, creation } => {
                source.ready().await?;
                Ok((source.instance().clone(), Some(*creation)))
            }
            Self::Starting(initialization) => {
                Ok((initialization.wait(Default::default()).await?, None))
            }
            Self::Unchanged => unreachable!("unchanged selection does not create a page"),
        }
    }
}

impl Execution<'_> {
    pub(super) async fn profile_source_url(
        &self,
        permit: &BrowserActionPermit,
    ) -> Result<String, BrowserRuntimeError> {
        let mut engine = self.engine().await?;
        self.observe_engine(&mut engine).await?;
        self.input_before_action(permit, true).await?;
        let observed = self.observe_engine(&mut engine).await?;
        let target = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        Ok(observed
            .tabs
            .iter()
            .find(|tab| tab.target_id == target)
            .ok_or("browser_page_missing")?
            .url
            .clone())
    }

    pub(super) async fn profile_created_target(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        creation: Option<BrowserPageCreationPermit>,
    ) -> Result<BrowserTargetId, BrowserRuntimeError> {
        let target = match creation {
            Some(creation) => self.binding.events.create_page(creation).await?,
            None => self
                .resource
                .host
                .lock()
                .await
                .created_page_target(permit)?
                .clone(),
        };
        // Join the command worker's discovery while the retained Source arms
        // native observation. Navigation starts only after this target is bound.
        let tabs = engine.require(json!({"action":"tab_list"})).await?;
        let tabs: Vec<NativeTab> = serde_json::from_value(tabs["tabs"].clone())
            .map_err(|_| "browser_tab_observation_invalid")?;
        if !tabs.iter().any(|tab| tab.target_id == target) {
            return Err("browser_profile_launch_page_invalid".into());
        }
        self.binding.events.synchronize_events().await?;
        Ok(target)
    }
}
