use super::{BrowserCdp, BrowserRuntimeError, locator::LocatedElement};
use hmux_session_protocol::browser_resource::BrowserElementId;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;

mod cursor;
mod diff;
mod render;
mod scope;

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BrowserSnapshotOptions {
    interactive: bool,
    compact: bool,
    depth: Option<u32>,
    selector: Option<String>,
    urls: bool,
    pub(super) diff_baseline: Option<super::BrowserUploadId>,
}

impl BrowserSnapshotOptions {
    pub(super) fn validate(&self) -> Result<(), BrowserRuntimeError> {
        if self.selector.as_ref().is_some_and(|value| {
            value.trim().is_empty() || value.len() > 8192 || value.contains('\0')
        }) {
            return Err("browser_snapshot_options_invalid".into());
        }
        Ok(())
    }
}

/// References encode the observed backend node identity. Host owns membership
/// and snapshot validity; resolution never searches for a replacement by name.
pub(super) async fn observe(
    cdp: &mut BrowserCdp,
    target: &str,
    url: &str,
    options: &BrowserSnapshotOptions,
    baseline: Option<String>,
) -> Result<(Value, BTreeSet<BrowserElementId>), BrowserRuntimeError> {
    let session = cdp.attach(target).await?;
    let scope = match &options.selector {
        Some(selector) => Some(scope::resolve(cdp, target, &session, selector).await?),
        None => None,
    };
    let cursors = cursor::observe(cdp, target, &session).await?;
    let tree = cdp.accessibility_tree(&session).await?;
    let nodes = tree["nodes"]
        .as_array()
        .ok_or("browser_accessibility_invalid")?;
    let selected = render::select(nodes, &cursors, scope.as_ref(), options)?;
    let mut refs = serde_json::Map::new();
    let mut elements = BTreeSet::new();
    let mut lines = Vec::new();
    let mut text_bytes = 0;
    for render::Line {
        node,
        role,
        depth,
        backend,
    } in selected
    {
        let cursor = backend.and_then(|node| cursors.get(&node));
        let original_name = node["name"]["value"].as_str().unwrap_or_default();
        let promoted =
            cursor.is_some_and(|cursor| cursor.hidden_role.as_deref() == Some(role.as_str()));
        let name = if original_name.is_empty() && (options.interactive || promoted) {
            cursor.map_or(original_name, |cursor| cursor.text.as_str())
        } else {
            original_name
        };
        let mut line = format!("{}- {role} {}", "  ".repeat(depth.min(80)), json!(name));
        if let Some(backend) = backend {
            let id = BrowserElementId::new(format!("e{backend}")).expect("bounded node identity");
            line.push_str(&format!(" [ref={}]", id.as_str()));
            refs.insert(id.as_str().into(), json!({"role":role,"name":name}));
            elements.insert(id);
            if options.urls && role == "link" {
                let href = LocatedElement::resolve_node(cdp.clone(), target, backend)
                    .await?
                    .call("function(){if(!this.isConnected)throw Error();return this.href || '';}")
                    .await?;
                if let Some(href) = href.as_str().filter(|value| !value.is_empty()) {
                    line.push_str(&format!(" [url={}]", json!(href)));
                }
            }
        }
        if let Some(cursor) = cursor {
            line.push_str(&format!(" {} [{}]", cursor.kind, cursor.hints.join(", ")));
            if promoted {
                if let Some(checked) = &cursor.checked {
                    line.push_str(&format!(" [checked={checked}]"));
                }
            }
        }
        if let Some(value) = node.get("value").and_then(|value| value.get("value")) {
            line.push_str(&format!(" [value={value}]"));
        }
        if let Some(properties) = node["properties"].as_array() {
            for property in properties {
                let name = property["name"].as_str().unwrap_or_default();
                if [
                    "checked",
                    "disabled",
                    "expanded",
                    "selected",
                    "level",
                    "required",
                    "readonly",
                    "focused",
                    "multiselectable",
                    "pressed",
                ]
                .contains(&name)
                {
                    line.push_str(&format!(" [{name}={}]", property["value"]["value"]));
                }
            }
        }
        text_bytes += line.len() + 1;
        if text_bytes > 1024 * 1024 {
            return Err("browser_snapshot_too_large".into());
        }
        lines.push(line);
    }
    let text = if lines.is_empty() {
        if options.interactive {
            "(no interactive elements)"
        } else {
            "(empty page)"
        }
        .into()
    } else {
        lines.join("\n")
    };
    let mut data = json!({"snapshot":text,"origin":url,"refs":refs});
    if let Some(baseline) = baseline {
        data["diff"] = diff::compare(baseline, text.clone()).await?;
    }
    if let Some(frame) = cdp.frame() {
        data["frame"] = json!(frame);
    }
    if serde_json::to_vec(&data)
        .map_err(|_| "browser_accessibility_invalid")?
        .len()
        > 1024 * 1024
    {
        return Err("browser_snapshot_too_large".into());
    }
    Ok((data, elements))
}
