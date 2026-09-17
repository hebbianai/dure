use super::find::{finish_element_result, pointer_position, response};
use super::{
    BrowserActionPermit, BrowserCdp, BrowserElementTarget, BrowserRuntimeError, Execution,
};
use crate::browser_engine::{NativeBrowserEngine, NativeBrowserResponse};
use serde_json::json;

impl Execution<'_> {
    pub(super) async fn drag_action(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        cdp: BrowserCdp,
        source: &BrowserElementTarget,
        target: &BrowserElementTarget,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let page = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        let second = cdp.clone();
        let mut source = source.resolve(cdp, page.as_str()).await?;
        let mut target = target.resolve(second, page.as_str()).await?;
        self.validate_find(engine, permit, &mut source).await?;
        self.validate_find(engine, permit, &mut target).await?;
        let result: Result<_, BrowserRuntimeError> = async {
            source.node_command("DOM.scrollIntoViewIfNeeded").await?;
            target.node_command("DOM.scrollIntoViewIfNeeded").await?;
            self.validate_find(engine, permit, &mut source).await?;
            self.validate_find(engine, permit, &mut target).await?;
            let start = pointer_position(&mut source).await?;
            let mut end = pointer_position(&mut target).await?;
            self.element_pointer(permit, "mouseMoved", &start, 0)
                .await?;
            self.validate_find(engine, permit, &mut source).await?;
            let start = pointer_position(&mut source).await?;
            self.element_pointer(permit, "mousePressed", &start, 1)
                .await?;
            let motion: Result<(), BrowserRuntimeError> = async {
                for step in 1..=12 {
                    let progress = f64::from(step) / 12.0;
                    let x = start["x"].as_f64().unwrap()
                        + (end["x"].as_f64().unwrap() - start["x"].as_f64().unwrap()) * progress;
                    let y = start["y"].as_f64().unwrap()
                        + (end["y"].as_f64().unwrap() - start["y"].as_f64().unwrap()) * progress;
                    self.element_pointer(permit, "mouseMoved", &json!({"x":x,"y":y}), 0)
                        .await?;
                    tokio::time::sleep(std::time::Duration::from_millis(12)).await;
                }
                self.validate_find(engine, permit, &mut target).await?;
                end = pointer_position(&mut target).await?;
                Ok(())
            }
            .await;
            // A known press always gets one release, including a changed target.
            let released = self.element_pointer(permit, "mouseReleased", &end, 1).await;
            released?;
            motion?;
            Ok(response(json!({"dragged":true})))
        }
        .await;
        finish_element_result(result)
    }
}
