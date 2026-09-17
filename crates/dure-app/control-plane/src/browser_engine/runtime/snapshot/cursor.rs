use super::{BrowserCdp, BrowserRuntimeError, LocatedElement};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;

mod candidates;

#[cfg(test)]
mod tests;

pub(super) struct CursorInfo {
    pub kind: &'static str,
    pub hints: Vec<&'static str>,
    pub text: String,
    pub hidden_role: Option<String>,
    pub checked: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Details {
    pointer: bool,
    onclick: bool,
    editable: bool,
    focusable: bool,
    inherited_pointer: bool,
    text: String,
    hidden_role: Option<String>,
    checked: Option<String>,
}

pub(super) async fn observe(
    cdp: &mut BrowserCdp,
    target: &str,
    session: &str,
) -> Result<BTreeMap<i64, CursorInfo>, BrowserRuntimeError> {
    let frame = cdp.frame_id(session).await?;
    let snapshot = cdp
        .request(
            "DOMSnapshot.captureSnapshot",
            json!({"computedStyles":["cursor"]}),
            Some(session),
        )
        .await?;
    let candidates = candidates::select(snapshot, &frame)?;
    let mut result = BTreeMap::new();
    for (backend, mouse) in candidates {
        let details = LocatedElement::resolve_node(cdp.clone(), target, backend)
            .await?
            .call(include_str!("cursor.js"))
            .await?;
        if details == Value::Null {
            continue;
        }
        let details: Details =
            serde_json::from_value(details).map_err(|_| "browser_accessibility_invalid")?;
        if !details.pointer && !details.onclick && !details.editable && !details.focusable && !mouse
        {
            continue;
        }
        if details.inherited_pointer
            && !details.onclick
            && !details.editable
            && !details.focusable
            && !mouse
        {
            continue;
        }
        let mut hints = Vec::new();
        if details.pointer {
            hints.push("cursor:pointer");
        }
        if details.onclick {
            hints.push("onclick");
        }
        // Chromium's native flag covers mouse listeners and editable nodes.
        // Reading JS listener objects would execute page-provided getters.
        if mouse && !details.onclick && !details.editable {
            hints.push("mouse-listener");
        }
        if details.focusable {
            hints.push("tabindex");
        }
        if details.editable {
            hints.push("contenteditable");
        }
        let kind = if details.pointer || details.onclick {
            "clickable"
        } else if details.editable {
            "editable"
        } else if mouse {
            "clickable"
        } else {
            "focusable"
        };
        result.insert(
            backend,
            CursorInfo {
                kind,
                hints,
                text: details.text,
                hidden_role: details.hidden_role,
                checked: details.checked,
            },
        );
    }
    Ok(result)
}
