//! The admitted permit has one completion owner, independently of its caller.
use super::*;
use hmux_host::browser_resource::creation::BrowserPageCreationState;
use hmux_host::browser_resource::tracing::BrowserTracingStopPermit;
use tokio::{runtime::Handle, task::JoinHandle};

type Dispatched = Result<NativeBrowserResponse, BrowserRuntimeError>;
type Settlement = Result<(BrowserActionOutcome, Dispatched), BrowserRuntimeError>;

impl Execution<'_> {
    pub(super) async fn complete_action(
        &self,
        completion: ActionCompletion,
        dispatched: Dispatched,
        observe: bool,
    ) -> Result<BrowserActionResult, BrowserRuntimeError> {
        let (outcome, dispatched) = completion
            .finish(dispatched)
            .await
            .map_err(|_| BrowserEngineError::after("browser_action_completion_interrupted"))??;
        if outcome != BrowserActionOutcome::OutcomeUnknown {
            // The admitted action's receipt survives a later drain failure.
            // The drain owns its own fence before any new controller can act.
            let _ = self.resource.drain_input_transfer().await;
        }
        let response = dispatched?;
        let control = self.resource.control().await;
        let observation = if observe {
            self.resource.observe().await.ok()
        } else {
            None
        };
        Ok(BrowserActionResult {
            response,
            control,
            observation,
        })
    }
}

pub(super) struct ActionCompletion {
    permit: Option<CompletionPermit>,
    host: Arc<Mutex<BrowserResourceHost>>,
    bindings: lifecycle::BindingTable,
    changed: Arc<tokio::sync::Notify>,
}

enum CompletionPermit {
    Page(BrowserActionPermit),
    TracingStop(BrowserTracingStopPermit),
}

impl CompletionPermit {
    fn page(&self) -> Option<&BrowserActionPermit> {
        match self {
            Self::Page(permit) => Some(permit),
            Self::TracingStop(_) => None,
        }
    }
}

impl ActionCompletion {
    pub(super) fn new(runtime: &Execution<'_>, permit: BrowserActionPermit) -> Self {
        Self::with_permit(runtime, CompletionPermit::Page(permit))
    }

    pub(super) fn tracing_stop(runtime: &Execution<'_>, permit: BrowserTracingStopPermit) -> Self {
        Self::with_permit(runtime, CompletionPermit::TracingStop(permit))
    }

    fn with_permit(runtime: &Execution<'_>, permit: CompletionPermit) -> Self {
        Self {
            permit: Some(permit),
            host: Arc::clone(&runtime.resource.host),
            bindings: Arc::clone(&runtime.resource.bindings),
            changed: Arc::clone(&runtime.resource.changed),
        }
    }

    pub(super) fn permit(&self) -> &BrowserActionPermit {
        self.permit
            .as_ref()
            .unwrap()
            .page()
            .expect("page action completion")
    }

    pub(super) fn permit_mut(&mut self) -> &mut BrowserActionPermit {
        match self.permit.as_mut().unwrap() {
            CompletionPermit::Page(permit) => permit,
            CompletionPermit::TracingStop(_) => unreachable!("page action completion"),
        }
    }

    pub(super) fn tracing_stop_permit(&self) -> &BrowserTracingStopPermit {
        match self.permit.as_ref().unwrap() {
            CompletionPermit::TracingStop(permit) => permit,
            CompletionPermit::Page(_) => unreachable!("tracing stop completion"),
        }
    }

    pub(super) fn finish(mut self, dispatched: Dispatched) -> JoinHandle<Settlement> {
        self.start(&Handle::current(), dispatched)
    }

    fn start(&mut self, runtime: &Handle, dispatched: Dispatched) -> JoinHandle<Settlement> {
        // Taking the permit and transferring it to the task have no await gap.
        // Dropping its waiter cannot interrupt retirement after Host completion.
        let permit = self.permit.take().unwrap();
        runtime.spawn(settle(
            Arc::clone(&self.host),
            Arc::clone(&self.bindings),
            Arc::clone(&self.changed),
            permit,
            dispatched,
        ))
    }
}

impl Drop for ActionCompletion {
    fn drop(&mut self) {
        if self.permit.is_some()
            && let Ok(runtime) = Handle::try_current()
        {
            self.start(
                &runtime,
                Err(BrowserEngineError::after("browser_action_caller_canceled").into()),
            );
        }
    }
}

async fn settle(
    host: Arc<Mutex<BrowserResourceHost>>,
    bindings: lifecycle::BindingTable,
    changed: Arc<tokio::sync::Notify>,
    permit: CompletionPermit,
    mut dispatched: Dispatched,
) -> Settlement {
    let (outcome, unaccounted_creation) = {
        let mut admission = host.lock().await;
        if permit
            .page()
            .map(|permit| admission.page_creation_state(permit))
            .transpose()?
            .flatten()
            == Some(BrowserPageCreationState::Pending)
        {
            let source = admission
                .page_creation_instance(permit.page().expect("pending page creation"))?
                .and_then(|instance| {
                    bindings
                        .lock()
                        .unwrap()
                        .get(instance)
                        .and_then(|slot| slot.ready.get())
                        .map(|binding| binding.events.clone())
                });
            // Source retains native creation and compensation after caller
            // cancellation. Read its final Host fact before selecting retirement.
            // A lost source leaves Pending intact and still retires the instance.
            drop(admission);
            if let Some(source) = source {
                let _ = source.settle_page_creation().await;
            }
            admission = host.lock().await;
        }
        let mut host = admission;
        let creation = permit
            .page()
            .map(|permit| host.page_creation_state(permit))
            .transpose()?
            .flatten();
        if matches!(
            creation,
            Some(BrowserPageCreationState::Prepared | BrowserPageCreationState::Rejected)
        ) && let Err(BrowserRuntimeError::Engine(error)) = &mut dispatched
        {
            *error = BrowserEngineError::before(error.code);
        }
        let outcome = match &dispatched {
            Ok(_) => BrowserActionOutcome::Completed,
            Err(BrowserRuntimeError::Engine(error)) if error.outcome_unknown => {
                BrowserActionOutcome::OutcomeUnknown
            }
            Err(_) => BrowserActionOutcome::RejectedBeforeDispatch,
        };
        let unaccounted_creation = if creation == Some(BrowserPageCreationState::Pending) {
            let instance = host
                .page_creation_instance(permit.page().expect("pending page creation"))?
                .ok_or(BrowserAdmissionError::InstanceMismatch)?;
            // Host selected the native destination before dispatch. Retain that
            // exact owner while still holding Host admission, even if the action
            // originated on a different profile or its caller has disappeared.
            Some(
                bindings
                    .lock()
                    .unwrap()
                    .get(instance)
                    .and_then(|slot| slot.ready.get())
                    .map(|binding| Arc::clone(&binding.instance))
                    .ok_or_else(|| BrowserEngineError::after("browser_creation_owner_unavailable")),
            )
        } else {
            None
        };
        // Finishing under the same lock also revokes a queued creation that
        // has not reached native dispatch when its reply wait expires.
        match permit {
            CompletionPermit::Page(permit) => host.finish_action(permit, outcome)?,
            CompletionPermit::TracingStop(permit) => host.finish_tracing_stop(permit, outcome)?,
        };
        (outcome, unaccounted_creation)
    };
    changed.notify_waiters();
    if let Some(instance) = unaccounted_creation {
        // The caller released its command worker before transferring completion.
        // The existing process owner reconciles every resource in the instance.
        instance?.retire_unaccounted_creation().await?;
    }
    Ok((outcome, dispatched))
}
