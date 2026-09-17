//! Engine mirror lifetime; Host page/document identity remains unchanged.

use super::super::field;
use hmux_host::browser_network::BrowserNetworkId;
use serde_json::Value;
use std::collections::BTreeMap;
use tokio::sync::watch;

#[derive(Default)]
pub(in crate::browser_engine::runtime::events) struct ConsoleContexts {
    live: BTreeMap<(BrowserNetworkId, i64), Context>,
}

struct Context {
    lifetime: watch::Sender<()>,
    default_world: Option<(String, String)>,
}

impl ConsoleContexts {
    pub(super) fn observe(&mut self, event: &Value) -> Result<bool, &'static str> {
        let method = field(event, "method")?;
        if method == "Target.detachedFromTarget" {
            let source = BrowserNetworkId::new(field(&event["params"], "sessionId")?)?;
            self.live.retain(|(session, _), _| session != &source);
            return Ok(false);
        }
        if !matches!(
            method,
            "Runtime.executionContextCreated"
                | "Runtime.executionContextDestroyed"
                | "Runtime.executionContextsCleared"
        ) {
            return Ok(false);
        }
        let source = BrowserNetworkId::new(field(event, "sessionId")?)?;
        let params = &event["params"];
        if method == "Runtime.executionContextsCleared" {
            self.live.retain(|(session, _), _| session != &source);
        } else {
            let value = if method == "Runtime.executionContextCreated" {
                &params["context"]["id"]
            } else {
                &params["executionContextId"]
            };
            let context = value
                .as_i64()
                .filter(|id| *id > 0)
                .ok_or("browser_console_context_invalid")?;
            let key = (source, context);
            if method == "Runtime.executionContextDestroyed" {
                self.live.remove(&key);
            } else {
                if self.live.len() >= 4096 && !self.live.contains_key(&key) {
                    return Err("browser_console_context_limit");
                }
                // Reused numeric IDs cannot keep an earlier object's lease.
                let metadata = &params["context"];
                let default_world = if metadata["auxData"]["isDefault"] == true {
                    let frame = field(&metadata["auxData"], "frameId")?;
                    let unique = field(metadata, "uniqueId")?;
                    if frame.len() > 160 || unique.is_empty() || unique.len() > 160 {
                        return Err("browser_frame_context_invalid");
                    }
                    Some((frame.to_owned(), unique.to_owned()))
                } else {
                    None
                };
                self.live.insert(
                    key,
                    Context {
                        lifetime: watch::channel(()).0,
                        default_world,
                    },
                );
            }
        }
        Ok(true)
    }

    pub(in crate::browser_engine::runtime::events) fn has_source(
        &self,
        source: &BrowserNetworkId,
    ) -> bool {
        self.live.keys().any(|(session, _)| session == source)
    }

    pub(super) fn scope(
        &self,
        source: &BrowserNetworkId,
        context: i64,
    ) -> Result<watch::Receiver<()>, &'static str> {
        self.live
            .get(&(source.clone(), context))
            .map(|context| context.lifetime.subscribe())
            .ok_or("browser_console_context_missing")
    }

    pub(in crate::browser_engine::runtime::events) fn frame_world(
        &self,
        source: &BrowserNetworkId,
        frame: &str,
    ) -> Option<(String, watch::Receiver<()>)> {
        self.live.iter().find_map(|((session, _), context)| {
            let (id, unique) = context.default_world.as_ref()?;
            (session == source && id == frame)
                .then(|| (unique.clone(), context.lifetime.subscribe()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn context_reuse_clear_and_source_detach_end_only_their_mirror_lifetimes() {
        let mut contexts = ConsoleContexts::default();
        let source = BrowserNetworkId::new("source").unwrap();
        let other = BrowserNetworkId::new("other").unwrap();
        let create = |source: &str| json!({"method":"Runtime.executionContextCreated","sessionId":source,"params":{"context":{"id":7}}});
        contexts.observe(&create("source")).unwrap();
        contexts.observe(&create("other")).unwrap();
        let mut previous = contexts.scope(&source, 7).unwrap();
        let other_scope = contexts.scope(&other, 7).unwrap();
        contexts.observe(&create("source")).unwrap();
        assert!(previous.changed().await.is_err());
        assert!(other_scope.has_changed().is_ok());
        let mut replacement = contexts.scope(&source, 7).unwrap();
        contexts.observe(&json!({"method":"Runtime.executionContextDestroyed","sessionId":"source","params":{"executionContextId":7}})).unwrap();
        assert!(replacement.changed().await.is_err());
        assert!(contexts.scope(&source, 7).is_err());
        assert!(other_scope.has_changed().is_ok());
        contexts.observe(&create("source")).unwrap();
        let mut cleared = contexts.scope(&source, 7).unwrap();
        contexts.observe(&json!({"method":"Runtime.executionContextsCleared","sessionId":"source","params":{}})).unwrap();
        assert!(cleared.changed().await.is_err());
        assert!(other_scope.has_changed().is_ok());
        contexts
            .observe(&json!({"method":"Target.detachedFromTarget","params":{"sessionId":"other"}}))
            .unwrap();
        assert!(other_scope.has_changed().is_err());
        assert!(contexts.live.is_empty());
    }
}
