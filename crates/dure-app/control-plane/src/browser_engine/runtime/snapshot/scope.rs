use super::{BrowserCdp, BrowserRuntimeError};
use serde_json::json;
use std::collections::BTreeSet;

/// Resolve the document subtree used to filter the accessibility snapshot.
pub(super) async fn resolve(
    cdp: &mut BrowserCdp,
    target: &str,
    session: &str,
    selector: &str,
) -> Result<BTreeSet<i64>, BrowserRuntimeError> {
    let tree = if cdp.frame().is_some() {
        let mut element = super::LocatedElement::resolve(
            cdp.clone(),
            target,
            &crate::browser_engine::runtime::locator::BrowserLocator::first(selector),
        )
        .await?;
        element.describe(-1).await?
    } else {
        let document = cdp
            .request("DOM.getDocument", json!({"depth":0}), Some(session))
            .await?;
        let root = document["root"]["nodeId"]
            .as_i64()
            .ok_or("browser_accessibility_invalid")?;
        let found = cdp
            .request(
                "DOM.querySelector",
                json!({"nodeId":root,"selector":selector}),
                Some(session),
            )
            .await?;
        let node = found["nodeId"]
            .as_i64()
            .filter(|id| *id > 0)
            .ok_or("browser_element_not_found")?;
        cdp.request(
            "DOM.describeNode",
            json!({"nodeId":node,"depth":-1}),
            Some(session),
        )
        .await?
    };
    let mut pending = vec![&tree["node"]];
    let mut ids = BTreeSet::new();
    while let Some(node) = pending.pop() {
        if let Some(id) = node["backendNodeId"].as_i64().filter(|id| *id > 0) {
            ids.insert(id);
        }
        for field in ["children", "shadowRoots"] {
            if let Some(children) = node[field].as_array() {
                pending.extend(children);
            }
        }
        if let Some(document) = node.get("contentDocument").filter(|v| v.is_object()) {
            pending.push(document);
        }
    }
    if ids.is_empty() {
        return Err("browser_accessibility_invalid".into());
    }
    Ok(ids)
}
