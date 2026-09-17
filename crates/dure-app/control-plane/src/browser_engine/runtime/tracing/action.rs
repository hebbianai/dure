use super::*;
use hmux_session_protocol::browser_tracing::{
    BrowserTracingMode, BrowserTracingPageStatus, BrowserTracingScope, BrowserTracingStatus,
    BrowserTracingStopAuthority,
};

#[derive(Debug, Deserialize)]
#[serde(try_from = "RawAction")]
pub(in crate::browser_engine::runtime) enum TracingAction {
    Start {
        mode: BrowserTracingMode,
        scope: BrowserTracingScope,
        categories: Option<Vec<String>>,
    },
    Stop {
        recording: BrowserOperationId,
    },
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum RawAction {
    Start {
        mode: BrowserTracingMode,
        #[serde(default)]
        scope: BrowserTracingScope,
        categories: Option<Vec<String>>,
    },
    Stop {
        recording: BrowserOperationId,
    },
}

impl TryFrom<RawAction> for TracingAction {
    type Error = &'static str;

    fn try_from(value: RawAction) -> Result<Self, Self::Error> {
        Ok(match value {
            RawAction::Start {
                mode,
                scope,
                categories,
            } => {
                if let Some(categories) = &categories
                    && (mode != BrowserTracingMode::Profiler
                        || categories.len() > 256
                        || categories.iter().any(|category| {
                            category.is_empty() || category.len() > 256 || category.contains('\0')
                        }))
                {
                    return Err("browser_trace_categories_invalid");
                }
                Self::Start {
                    mode,
                    scope,
                    categories,
                }
            }
            RawAction::Stop { recording } => Self::Stop { recording },
        })
    }
}

impl Execution<'_> {
    pub(in crate::browser_engine::runtime) async fn trace(
        &self,
        permit: &BrowserActionPermit,
        action: &TracingAction,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        self.binding.events.synchronize_events().await?;
        self.binding
            .instance
            .trace(&self.resource.host, permit, action)
            .await
    }
}

impl BrowserRuntime {
    pub async fn tracing_intervals(
        &self,
        resource: &BrowserResourceIdentity,
    ) -> Result<Vec<BrowserTracingStatus>, BrowserRuntimeError> {
        let instances = {
            let host = self.host.lock().await;
            if &host.projection().resource != resource {
                return Err(BrowserAdmissionError::ResourceMismatch.into());
            }
            host.instance_binding_ids()
        };
        let mut statuses = Vec::with_capacity(instances.len());
        for instance in instances {
            statuses.push(
                self.execution_for_instance(&instance)?
                    .binding
                    .instance
                    .tracing_instance_state(&self.host, resource, &instance)
                    .await?,
            );
        }
        Ok(statuses)
    }

    pub async fn stop_tracing(
        &self,
        caller: &BrowserControllerId,
        authority: &BrowserTracingStopAuthority,
    ) -> Result<BrowserActionResult, BrowserRuntimeError> {
        let execution = self.execution_for_instance(&authority.instance_id)?;
        let permit = execution
            .binding
            .instance
            .admit_tracing_stop(&self.host, caller, authority)
            .await?;
        // Install the existing command completion owner before another await.
        let completion = completion::ActionCompletion::tracing_stop(&execution, permit);
        let dispatched = execution
            .binding
            .instance
            .stop_tracing(&self.host, completion.tracing_stop_permit())
            .await;
        execution
            .complete_action(completion, dispatched, false)
            .await
    }

    pub async fn tracing_state(
        &self,
        resource: &BrowserResourceIdentity,
        page: &BrowserPageId,
    ) -> Result<BrowserTracingPageStatus, BrowserRuntimeError> {
        let instance = {
            let host = self.host.lock().await;
            let page = host.page_identity(page)?;
            if &page.resource != resource {
                return Err(BrowserAdmissionError::ResourceMismatch.into());
            }
            host.instance_for_page(&page.page_id)?.clone()
        };
        self.execution_for_instance(&instance)?
            .binding
            .instance
            .tracing_state(&self.host, resource, page)
            .await
    }
}
