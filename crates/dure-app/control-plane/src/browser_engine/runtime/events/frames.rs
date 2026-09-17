use super::*;
use crate::browser_engine::cdp::{FrameRenderer, FrameScope};
use hmux_session_protocol::browser_resource::{
    BrowserDocumentId, BrowserFrameId, BrowserFrameIdentity, BrowserPageIdentity,
};

pub(super) fn document(frame: &Value) -> Result<BrowserDocumentId, &'static str> {
    let value = frame["loaderId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or("browser_document_invalid")?;
    BrowserDocumentId::new(value).map_err(|_| "browser_document_invalid")
}

pub(super) fn observe_tree(
    host: &mut BrowserResourceHost,
    page: &BrowserPageIdentity,
    tree: &Value,
) -> Result<(), &'static str> {
    let mut pending = vec![tree];
    let mut count = 0;
    while let Some(tree) = pending.pop() {
        count += 1;
        if count > 1024 {
            return Err("browser_frame_limit");
        }
        observe_frame(host, page, &tree["frame"])?;
        if let Some(children) = tree["childFrames"].as_array() {
            pending.extend(children);
        }
    }
    Ok(())
}

pub(super) fn observe_frame(
    host: &mut BrowserResourceHost,
    page: &BrowserPageIdentity,
    frame: &Value,
) -> Result<(), &'static str> {
    let id = BrowserFrameId::new(field(frame, "id")?).map_err(|_| "browser_frame_invalid")?;
    let parent = frame["parentId"]
        .as_str()
        .map(BrowserFrameId::new)
        .transpose()
        .map_err(|_| "browser_frame_invalid")?;
    host.frame_document_observed(page, id, parent, document(frame)?)
        .map_err(|_| "browser_frame_invalid")?;
    if let Some(url) = frame["url"]
        .as_str()
        .and_then(|url| reqwest::Url::parse(url).ok())
    {
        if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
            host.storage_origin_observed(page, url.origin().ascii_serialization())
                .map_err(|_| "browser_frame_invalid")?;
        }
    }
    Ok(())
}

impl Monitor {
    pub(super) async fn frame_scope(
        &self,
        frame: &BrowserFrameIdentity,
    ) -> Result<FrameScope, &'static str> {
        let mut host = self.host.lock().await;
        host.validate_frame(frame)
            .map_err(|_| "browser_frame_changed")?;
        let target = host
            .target_for(&frame.page)
            .map_err(|_| "browser_page_gone")?
            .clone();
        if host.instance_for_target(&target) != Some(&self.instance) {
            return Err("browser_frame_source_mismatch");
        }
        let sources = host.network().sources();
        let frames = host
            .frame_ancestry(frame)
            .map_err(|_| "browser_frame_ancestry_missing")?;
        let mut ancestry = Vec::new();
        for ancestor in frames {
            let mut renderer = None;
            for source in &sources {
                if host.network().source_target(source) != Some(&target) {
                    continue;
                }
                if let Some((_, lifetime)) = self
                    .contexts
                    .frame_world(source, ancestor.frame_id.as_str())
                {
                    if renderer.is_some() {
                        return Err("browser_frame_source_ambiguous");
                    }
                    let engine_target = host
                        .network()
                        .source_engine_target(source)
                        .ok_or("browser_frame_source_missing")?
                        .as_str()
                        .to_owned();
                    renderer = Some(FrameRenderer {
                        frame: ancestor.clone(),
                        session: source.as_str().to_owned(),
                        engine_target,
                        lifetime,
                    });
                }
            }
            ancestry.push(renderer.ok_or("browser_frame_ancestor_context_missing")?);
        }
        let mut found = None;
        for source in sources {
            if host.network().source_target(&source) != Some(&target) {
                continue;
            }
            if let Some((default_world, lifetime)) =
                self.contexts.frame_world(&source, frame.frame_id.as_str())
            {
                if found.is_some() {
                    return Err("browser_frame_source_ambiguous");
                }
                found = Some(FrameScope {
                    frame: frame.clone(),
                    target: target.as_str().to_owned(),
                    session: source.as_str().to_owned(),
                    default_world,
                    lifetime,
                    ancestry: ancestry.clone(),
                });
            }
        }
        found.ok_or("browser_frame_context_missing")
    }
}

impl BrowserEventMonitor {
    pub(in crate::browser_engine::runtime) async fn frame_scope(
        &self,
        frame: BrowserFrameIdentity,
    ) -> Result<FrameScope, &'static str> {
        let (sender, receiver) = oneshot::channel();
        self.barriers
            .send(Barrier::FrameScope(self.resource.clone(), frame, sender))
            .await
            .map_err(|_| "browser_frame_observation_lost")?;
        timeout(Duration::from_secs(5), receiver)
            .await
            .map_err(|_| "browser_frame_observation_timeout")?
            .map_err(|_| "browser_frame_observation_lost")?
    }
}
