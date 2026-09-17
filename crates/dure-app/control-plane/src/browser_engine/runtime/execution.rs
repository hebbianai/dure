//! Renderer deadlines consume the Host's clock, excluding observed page dialogs.

use super::{BrowserCdp, BrowserResourceHost, BrowserTargetId, Execution};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify};

impl Execution<'_> {
    pub(super) fn renderer_cdp(&self, cdp: BrowserCdp, target: BrowserTargetId) -> BrowserCdp {
        self.renderer_cdp_until(cdp, target, None)
    }

    /// An overall operation can cap each request using the same Host clock.
    /// The limit is elapsed renderer time, so dialog suspension is excluded once.
    pub(super) fn renderer_cdp_until(
        &self,
        cdp: BrowserCdp,
        target: BrowserTargetId,
        elapsed_limit: Option<Duration>,
    ) -> BrowserCdp {
        renderer_cdp(
            &self.resource.host,
            &self.binding.events.changed,
            cdp,
            target,
            elapsed_limit,
        )
    }
}

pub(super) fn renderer_cdp(
    host: &Arc<Mutex<BrowserResourceHost>>,
    changed: &Arc<Notify>,
    cdp: BrowserCdp,
    target: BrowserTargetId,
    elapsed_limit: Option<Duration>,
) -> BrowserCdp {
    let host = Arc::clone(host);
    let changed = Arc::clone(changed);
    cdp.with_deadline(move |budget| {
        renderer_deadline(
            Arc::clone(&host),
            Arc::clone(&changed),
            target.clone(),
            budget,
            elapsed_limit,
        )
    })
}

async fn renderer_deadline(
    host: Arc<Mutex<BrowserResourceHost>>,
    changed: Arc<Notify>,
    target: BrowserTargetId,
    budget: Duration,
    elapsed_limit: Option<Duration>,
) -> &'static str {
    let start = match host.lock().await.execution_time(&target, Instant::now()) {
        Ok(clock) => clock.elapsed,
        Err(_) => return "browser_renderer_lifecycle_changed",
    };
    let budget = elapsed_limit
        .map(|limit| budget.min(limit.saturating_sub(start)))
        .unwrap_or(budget);
    loop {
        // Register before reading Host so a close/retirement cannot be lost
        // between observing a suspended dialog and sleeping for its change.
        let notification = changed.notified();
        tokio::pin!(notification);
        notification.as_mut().enable();
        let clock = match host.lock().await.execution_time(&target, Instant::now()) {
            Ok(clock) => clock,
            Err(_) => return "browser_renderer_lifecycle_changed",
        };
        let remaining = budget.saturating_sub(clock.elapsed.saturating_sub(start));
        if remaining.is_zero() {
            return "browser_cdp_response_timeout";
        }
        if clock.suspended {
            notification.await;
        } else {
            tokio::select! {
                _ = tokio::time::sleep(remaining) => {},
                _ = notification => {},
            }
        }
    }
}
