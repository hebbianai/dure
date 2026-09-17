//! The ordered connection owns the private storage contexts it creates.
use super::*;

#[derive(Clone)]
pub(in crate::browser_engine::runtime) struct BrowserStorageContext {
    resource: Arc<BrowserResourceIdentity>,
    id: Option<String>,
}

pub(in crate::browser_engine::runtime) enum PageCreationContext {
    Default,
    Isolated,
    Existing(BrowserStorageContext),
}

impl BrowserStorageContext {
    pub(in crate::browser_engine::runtime) fn apply(&self, params: &mut Value) {
        if let Some(id) = &self.id {
            params["browserContextId"] = json!(id);
        }
    }
}

impl Source {
    pub(super) async fn storage_context(
        &mut self,
        resource: &Arc<BrowserResourceIdentity>,
        target: &BrowserTargetId,
    ) -> Result<BrowserStorageContext, &'static str> {
        let monitor = self.resource(resource)?;
        if monitor.host.lock().await.instance_for_target(target) != Some(&monitor.instance) {
            return Err("browser_page_owner_mismatch");
        }
        let result = self
            .cdp
            .request("Target.getTargetInfo", json!({"targetId":target}), None)
            .await?;
        let info = &result["targetInfo"];
        if info["targetId"] != target.as_str() || info["type"] != "page" {
            return Err("browser_storage_context_invalid");
        }
        let id = match info.get("browserContextId") {
            None => None,
            Some(value) => {
                let id = context_id(value)?;
                if self.resource(resource)?.private_contexts.contains(id) {
                    Some(id.to_owned())
                } else {
                    // Chromium can report an opaque default-context id, but
                    // browser-scoped APIs address that context by omission.
                    if self.named_contexts().await?.contains(id) {
                        return Err("browser_storage_context_not_owned");
                    }
                    None
                }
            }
        };
        Ok(BrowserStorageContext {
            resource: Arc::clone(resource),
            id,
        })
    }

    pub(super) fn validate_creation_context(
        &mut self,
        resource: &Arc<BrowserResourceIdentity>,
        context: &PageCreationContext,
    ) -> Result<(), &'static str> {
        let monitor = self.resource(resource)?;
        if let PageCreationContext::Existing(context) = context {
            if !Arc::ptr_eq(&context.resource, resource)
                || context
                    .id
                    .as_ref()
                    .is_some_and(|id| !monitor.private_contexts.contains(id))
            {
                return Err("browser_storage_context_not_owned");
            }
        }
        Ok(())
    }

    pub(super) async fn creation_context(
        &mut self,
        resource: &Arc<BrowserResourceIdentity>,
        context: &PageCreationContext,
    ) -> Result<BrowserStorageContext, &'static str> {
        let id = match context {
            PageCreationContext::Default => None,
            PageCreationContext::Existing(context) => return Ok(context.clone()),
            PageCreationContext::Isolated => {
                let created = self
                    .cdp
                    .request(
                        "Target.createBrowserContext",
                        json!({"disposeOnDetach":true}),
                        None,
                    )
                    .await?;
                let id = context_id(&created["browserContextId"])?.to_owned();
                if !self.resource(resource)?.private_contexts.insert(id.clone()) {
                    return Err("browser_storage_context_conflict");
                }
                Some(id)
            }
        };
        Ok(BrowserStorageContext {
            resource: Arc::clone(resource),
            id,
        })
    }

    async fn named_contexts(&mut self) -> Result<BTreeSet<String>, &'static str> {
        let result = self
            .cdp
            .request("Target.getBrowserContexts", json!({}), None)
            .await?;
        result["browserContextIds"]
            .as_array()
            .ok_or("browser_storage_context_invalid")?
            .iter()
            .map(|value| context_id(value).map(str::to_owned))
            .collect()
    }

    pub(super) async fn discard_created_context(
        &mut self,
        context: &BrowserStorageContext,
    ) -> Result<(), &'static str> {
        if let Some(id) = &context.id {
            self.retire_context(&context.resource, id).await?;
        }
        Ok(())
    }

    async fn retire_context(
        &mut self,
        resource: &Arc<BrowserResourceIdentity>,
        id: &str,
    ) -> Result<(), &'static str> {
        if !self.resource(resource)?.private_contexts.contains(id) {
            return Err("browser_storage_context_not_owned");
        }
        match self
            .cdp
            .request(
                "Target.disposeBrowserContext",
                json!({"browserContextId":id}),
                None,
            )
            .await
        {
            Ok(_) => {}
            Err("browser_cdp_request_rejected") => {
                if self.named_contexts().await?.contains(id) {
                    return Err("browser_storage_context_retirement_failed");
                }
            }
            Err(code) => return Err(code),
        }
        self.resource(resource)?.private_contexts.remove(id);
        Ok(())
    }

    pub(super) async fn retire_resource_contexts(
        &mut self,
        resource: &Arc<BrowserResourceIdentity>,
    ) -> Result<(), &'static str> {
        let ids = self.resource(resource)?.private_contexts.clone();
        for id in ids {
            self.retire_context(resource, &id).await?;
        }
        Ok(())
    }

    pub(super) async fn retire_empty_contexts(&mut self) -> Result<(), &'static str> {
        if self
            .resources
            .values()
            .all(|monitor| monitor.private_contexts.is_empty())
        {
            return Ok(());
        }
        let result = self
            .cdp
            .request(
                "Target.getTargets",
                json!({"filter":[{"exclude":false}]}),
                None,
            )
            .await?;
        let mut live = BTreeSet::new();
        for info in result["targetInfos"]
            .as_array()
            .ok_or("browser_storage_context_invalid")?
        {
            if info["type"] == "page" {
                if let Some(id) = info.get("browserContextId") {
                    live.insert(context_id(id)?.to_owned());
                }
            }
        }
        let retired: Vec<_> = self
            .resources
            .values()
            .flat_map(|monitor| {
                monitor
                    .private_contexts
                    .difference(&live)
                    .map(|id| (Arc::clone(&monitor.resource), id.clone()))
            })
            .collect();
        for (resource, id) in retired {
            self.retire_context(&resource, &id).await?;
        }
        Ok(())
    }
}

fn context_id(value: &Value) -> Result<&str, &'static str> {
    value
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control))
        .ok_or("browser_storage_context_invalid")
}
