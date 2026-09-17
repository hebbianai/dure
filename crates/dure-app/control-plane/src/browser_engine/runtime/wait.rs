use super::{BrowserElementTarget, BrowserRuntimeError, Execution, NativeTab};
use crate::browser_engine::{
    BrowserEngineError, ENGINE_DEADLINE, NativeBrowserEngine, NativeBrowserResponse,
};
use hmux_host::browser_resource::{BrowserActionPermit, BrowserAdmissionError};
use hmux_session_protocol::browser_resource::*;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::time::{Duration, Instant, sleep};

#[derive(Debug, Deserialize)]
#[serde(try_from = "u64")]
struct WaitTimeout(u64);

impl TryFrom<u64> for WaitTimeout {
    type Error = &'static str;
    fn try_from(milliseconds: u64) -> Result<Self, Self::Error> {
        if milliseconds > 120_000 {
            return Err("browser_wait_timeout_invalid");
        }
        Ok(Self(milliseconds))
    }
}

mod condition;
pub use condition::BrowserWait;
use condition::Condition;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFunctionWait {
    expression: String,
    timeout_ms: WaitTimeout,
}

#[derive(Debug, Deserialize)]
#[serde(try_from = "RawFunctionWait")]
pub(super) struct BrowserFunctionWait(RawFunctionWait);

impl TryFrom<RawFunctionWait> for BrowserFunctionWait {
    type Error = &'static str;
    fn try_from(wait: RawFunctionWait) -> Result<Self, Self::Error> {
        if wait.expression.is_empty() || wait.expression.len() > 64 * 1024 {
            return Err("browser_wait_function_invalid");
        }
        Ok(Self(wait))
    }
}

impl Execution<'_> {
    /// Follow the same registered page across document commits. Each probe
    /// releases the engine so the controller can satisfy the awaited condition.
    pub async fn wait(
        &self,
        page: &BrowserPageIdentity,
        wait: &BrowserWait,
    ) -> Result<Value, BrowserRuntimeError> {
        let started = Instant::now();
        self.binding.events.synchronize_events().await?;
        let (target, elapsed) = {
            let host = self.resource.host.lock().await;
            let target = host.target_for(page)?.clone();
            let elapsed = host
                .execution_time(&target, std::time::Instant::now())?
                .elapsed;
            (target, elapsed)
        };
        let budget = Duration::from_millis(wait.timeout_ms.0);
        if matches!(wait.condition, Condition::Duration) {
            return self.wait_duration(page, &target, started, budget).await;
        }
        // One deadline includes admission, every read, and the final identity
        // check. A zero timeout still performs one bounded, read-only probe.
        let limit = elapsed.saturating_add(if budget.is_zero() {
            ENGINE_DEADLINE
        } else {
            budget
        });
        let cdp = self.renderer_cdp_until(self.binding.cdp.clone(), target.clone(), Some(limit));
        let deadline = cdp.deadline(if budget.is_zero() {
            ENGINE_DEADLINE
        } else {
            budget
        });
        let observe = async {
            loop {
                let (ready, current) = {
                    let mut engine = self.engine().await?;
                    let observed = self.observe_engine(&mut engine).await?;
                    let current = self.wait_page(page, &target, &observed.tabs).await?;
                    let frame = self.resource.host.lock().await.selected_frame(&current)?;
                    let scoped = self.document_cdp(cdp.clone(), frame.clone()).await?;
                    let ready = wait
                        .condition
                        .ready(self, &current, &target, scoped)
                        .await?;
                    let after = self.observe_engine(&mut engine).await?;
                    let after_page = self.wait_page(page, &target, &after.tabs).await?;
                    self.validate_selected_frame(&current, &frame).await?;
                    (ready && current == after_page, after_page)
                };
                if ready {
                    return Ok(
                        json!({"page":current,"waited":true,"elapsed_ms":started.elapsed().as_millis()}),
                    );
                }
                if budget.is_zero() {
                    return Err("browser_wait_timeout".into());
                }
                sleep(Duration::from_millis(25)).await;
            }
        };
        // Dropping these fixed reads retires their request IDs. No admitted
        // action or page-side effect is cancelled or replayed by this timeout.
        let result = tokio::select! {
            biased;
            result = observe => result,
            code = deadline => Err(BrowserRuntimeError::Observation(code)),
        };
        match result {
            Err(BrowserRuntimeError::Observation("browser_cdp_response_timeout")) => {
                Err("browser_wait_timeout".into())
            }
            result => result,
        }
    }

    async fn wait_duration(
        &self,
        page: &BrowserPageIdentity,
        target: &BrowserTargetId,
        started: Instant,
        budget: Duration,
    ) -> Result<Value, BrowserRuntimeError> {
        self.wait_timer_page(page, target).await?;
        let deadline = self
            .renderer_cdp(self.binding.cdp.clone(), target.clone())
            .deadline(budget);
        // A literal duration is wall time and needs no renderer barrier. The
        // same Host clock still wakes a pending timer on retirement or loss.
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(started + budget) => {},
            code = deadline => {
                if code != "browser_cdp_response_timeout" { return Err(code.into()); }
            },
        }
        let current = self.wait_timer_page(page, target).await?;
        Ok(json!({"page":current,"waited":true,"elapsed_ms":started.elapsed().as_millis()}))
    }

    async fn wait_timer_page(
        &self,
        page: &BrowserPageIdentity,
        target: &BrowserTargetId,
    ) -> Result<BrowserPageIdentity, BrowserRuntimeError> {
        let mut engine = self.engine().await?;
        let tabs = self.observe_tabs(&mut engine).await?;
        self.binding.events.synchronize_events().await?;
        self.wait_page(page, target, &tabs).await
    }

    async fn wait_page(
        &self,
        initial: &BrowserPageIdentity,
        target: &BrowserTargetId,
        tabs: &[NativeTab],
    ) -> Result<BrowserPageIdentity, BrowserRuntimeError> {
        let host = self.resource.host.lock().await;
        let phase = host.projection().phase;
        if phase == BrowserResourcePhase::Retiring || phase == BrowserResourcePhase::Closed {
            return Err(BrowserAdmissionError::ResourceRetiring.into());
        }
        let page = host.page_identity(&initial.page_id)?;
        if page.resource != initial.resource || host.target_for(&page)? != target {
            return Err(BrowserAdmissionError::ResourceMismatch.into());
        }
        if !tabs.iter().any(|tab| &tab.target_id == target) {
            return Err("browser_page_gone".into());
        }
        Ok(page)
    }

    pub(super) async fn wait_function(
        &self,
        permit: &BrowserActionPermit,
        page: &BrowserPageIdentity,
        wait: &BrowserFunctionWait,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let (target, started) = {
            let host = self.resource.host.lock().await;
            let target = host.dispatch_target(permit)?.clone();
            let started = host
                .execution_time(&target, std::time::Instant::now())?
                .elapsed;
            (target, started)
        };
        let budget = Duration::from_millis(wait.0.timeout_ms.0);
        // Zero retains the existing single probe. Positive timeouts also bound
        // pending Promises, without restarting the total budget on each probe.
        let elapsed_limit = (!budget.is_zero()).then(|| started.saturating_add(budget));
        let mut previous: Option<NativeBrowserResponse> = None;
        loop {
            if let Some(mut response) = previous.take() {
                let error = if self
                    .resource
                    .host
                    .lock()
                    .await
                    .projection()
                    .requested_controller
                    .is_some()
                {
                    Some("browser_wait_cancelled_for_handoff")
                } else if self
                    .resource
                    .host
                    .lock()
                    .await
                    .execution_time(&target, std::time::Instant::now())?
                    .elapsed
                    .saturating_sub(started)
                    >= budget
                {
                    Some("browser_wait_timeout")
                } else {
                    None
                };
                if let Some(error) = error {
                    // End after the last known completion, before another probe.
                    // The journal records failure and forbids operation replay.
                    response.success = false;
                    response.error = Some(error.into());
                    return Ok(response);
                }
            }
            let response = {
                let mut engine = self.engine().await?;
                let cdp = self
                    .prepare_function_probe(&mut engine, permit, page, elapsed_limit)
                    .await?;
                // Await promises before testing truth; the successful expression
                // is evaluated once, including any intentional page-side effects.
                self.evaluate_action(
                    permit,
                    cdp,
                    &format!(
                        "Promise.resolve(({})).then(value => Boolean(value))",
                        wait.0.expression
                    ),
                    if budget.is_zero() {
                        ENGINE_DEADLINE
                    } else {
                        budget
                    },
                )
                .await?
            };
            if !response.success || response.data["result"] == true {
                return Ok(response);
            }
            previous = Some(response);
            let elapsed = self
                .resource
                .host
                .lock()
                .await
                .execution_time(&target, std::time::Instant::now())?
                .elapsed
                .saturating_sub(started);
            sleep(Duration::from_millis(100).min(budget.saturating_sub(elapsed))).await;
        }
    }

    async fn prepare_function_probe(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        page: &BrowserPageIdentity,
        elapsed_limit: Option<Duration>,
    ) -> Result<super::BrowserCdp, BrowserRuntimeError> {
        let mut observed = self.observe_engine(engine).await?;
        if self.input_before_action(permit, false).await? {
            observed = self
                .observe_engine(engine)
                .await
                .map_err(|_| BrowserEngineError::after("browser_input_drain_unobserved"))?;
        }
        self.select_page(engine, &observed, permit, page, false)
            .await?;
        let target = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        let frame = self.resource.host.lock().await.dispatch_frame(permit)?;
        self.document_cdp(
            self.renderer_cdp_until(observed.cdp, target, elapsed_limit),
            frame,
        )
        .await
    }
}
