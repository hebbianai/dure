use super::*;
use hmux_session_protocol::browser_resource::BrowserFrameIdentity;
use tokio::sync::watch;
mod geometry;

/// A borrowed renderer context from the resource's retained event connection.
/// Host owns selection; the context lease only bounds native object lifetime.
#[derive(Clone)]
pub(in crate::browser_engine) struct FrameScope {
    pub frame: BrowserFrameIdentity,
    pub target: String,
    pub session: String,
    pub default_world: String,
    pub lifetime: watch::Receiver<()>,
    pub ancestry: Vec<FrameRenderer>,
}

#[derive(Clone)]
pub(in crate::browser_engine) struct FrameRenderer {
    pub frame: BrowserFrameIdentity,
    pub session: String,
    pub engine_target: String,
    pub lifetime: watch::Receiver<()>,
}

impl BrowserCdp {
    pub(in crate::browser_engine) fn on_frame(self, events: &Self, scope: FrameScope) -> Self {
        let mut cdp = events.clone();
        cdp.frame = Some(scope);
        cdp.deadline = self.deadline;
        cdp
    }

    pub(in crate::browser_engine) fn frame(&self) -> Option<&BrowserFrameIdentity> {
        self.frame.as_ref().map(|scope| &scope.frame)
    }

    pub(in crate::browser_engine) fn evaluation_context(&self, params: &mut Value) {
        if let Some(scope) = &self.frame {
            params["uniqueContextId"] = scope.default_world.clone().into();
        }
    }

    pub(in crate::browser_engine) async fn frame_id(
        &mut self,
        session: &str,
    ) -> Result<String, &'static str> {
        if let Some(scope) = &self.frame {
            if scope.session != session {
                return Err("browser_frame_source_mismatch");
            }
            return Ok(scope.frame.frame_id.as_str().to_owned());
        }
        let tree = self
            .request("Page.getFrameTree", json!({}), Some(session))
            .await?;
        tree["frameTree"]["frame"]["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or("browser_frame_missing")
    }

    pub(in crate::browser_engine) async fn accessibility_tree(
        &mut self,
        session: &str,
    ) -> Result<Value, &'static str> {
        let params = match &self.frame {
            Some(scope) => json!({"frameId":scope.frame.frame_id}),
            None => json!({}),
        };
        self.request("Accessibility.getFullAXTree", params, Some(session))
            .await
    }

    pub(in crate::browser_engine) async fn frame_metadata(
        &mut self,
        session: &str,
    ) -> Result<Value, &'static str> {
        let tree = self
            .request("Page.getFrameTree", json!({}), Some(session))
            .await?;
        let Some(scope) = &self.frame else {
            return Ok(tree["frameTree"]["frame"].clone());
        };
        let mut pending = vec![&tree["frameTree"]];
        let mut count = 0;
        while let Some(tree) = pending.pop() {
            count += 1;
            if count > 1024 {
                return Err("browser_frame_limit");
            }
            if tree["frame"]["id"] == scope.frame.frame_id.as_str() {
                return Ok(tree["frame"].clone());
            }
            if let Some(children) = tree["childFrames"].as_array() {
                pending.extend(children);
            }
        }
        Err("browser_frame_gone")
    }
}
