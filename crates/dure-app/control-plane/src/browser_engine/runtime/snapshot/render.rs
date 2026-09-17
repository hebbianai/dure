use super::{BrowserRuntimeError, BrowserSnapshotOptions, cursor::CursorInfo};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct Line<'a> {
    pub node: &'a Value,
    pub role: String,
    pub depth: usize,
    pub backend: Option<i64>,
}

pub(super) fn select<'a>(
    nodes: &'a [Value],
    cursors: &BTreeMap<i64, CursorInfo>,
    scope: Option<&BTreeSet<i64>>,
    options: &BrowserSnapshotOptions,
) -> Result<Vec<Line<'a>>, BrowserRuntimeError> {
    let by_id: BTreeMap<_, _> = nodes
        .iter()
        .filter_map(|node| node["nodeId"].as_str().map(|id| (id, node)))
        .collect();
    let in_scope = |node: &Value| {
        scope.is_none_or(|ids| {
            node["backendDOMNodeId"]
                .as_i64()
                .is_some_and(|id| ids.contains(&id))
        })
    };
    let mut pending: Vec<_> = nodes
        .iter()
        .rev()
        .filter(|node| {
            in_scope(node)
                && node["parentId"]
                    .as_str()
                    .and_then(|id| by_id.get(id))
                    .is_none_or(|parent| !in_scope(parent))
        })
        .map(|node| (node, 0_usize))
        .collect();
    if scope.is_some() && pending.is_empty() {
        return Err("browser_element_not_found".into());
    }
    let mut visited = BTreeSet::new();
    let mut lines = Vec::new();
    while let Some((node, depth)) = pending.pop() {
        let id = node["nodeId"]
            .as_str()
            .ok_or("browser_accessibility_invalid")?;
        if !visited.insert(id) || options.depth.is_some_and(|max| depth > max as usize) {
            continue;
        }
        let mut role = node["role"]["value"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase();
        let name = node["name"]["value"].as_str().unwrap_or_default();
        let native_node = node["backendDOMNodeId"].as_i64().filter(|id| *id > 0);
        let cursor = native_node.and_then(|node| cursors.get(&node));
        if ["labeltext", "generic"].contains(&role.as_str()) {
            if let Some(promoted) = cursor.and_then(|cursor| cursor.hidden_role.as_ref()) {
                role = promoted.clone();
            }
        }
        let backend = native_node.filter(|_| reference_role(&role, name) || cursor.is_some());
        let children = node["childIds"].as_array();
        let rendered = (node["ignored"] != true || cursor.is_some())
            && !["", "rootwebarea", "webarea", "inlinetextbox"].contains(&role.as_str())
            && !(role == "generic"
                && backend.is_none()
                && children.is_none_or(|nodes| nodes.len() <= 1))
            && !(role == "statictext" && name.trim().is_empty())
            && (!options.interactive || backend.is_some());
        if rendered {
            lines.push(Line {
                node,
                role,
                depth,
                backend,
            });
        }
        if let Some(children) = children {
            for child in children.iter().rev().filter_map(Value::as_str) {
                if let Some(child) = by_id.get(child) {
                    pending.push((*child, depth + usize::from(rendered)));
                }
            }
        }
    }
    if options.compact {
        // Retain meaningful lines and their actual ancestors, using tree depth
        // rather than searching page-provided text for reference-like strings.
        let mut keep = vec![false; lines.len()];
        let mut ancestors: Vec<usize> = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            while ancestors
                .last()
                .is_some_and(|parent| lines[*parent].depth >= line.depth)
            {
                ancestors.pop();
            }
            let value = line.node["value"]["value"].as_str();
            if line.backend.is_some()
                || value.is_some_and(|v| {
                    !v.is_empty() && Some(v) != line.node["name"]["value"].as_str()
                })
            {
                keep[index] = true;
                for parent in &ancestors {
                    keep[*parent] = true;
                }
            }
            ancestors.push(index);
        }
        lines = lines
            .into_iter()
            .zip(keep)
            .filter_map(|(line, keep)| keep.then_some(line))
            .collect();
    }
    Ok(lines)
}

pub(super) fn interactive_role(role: &str) -> bool {
    matches!(
        role,
        "button"
            | "link"
            | "textbox"
            | "checkbox"
            | "radio"
            | "combobox"
            | "listbox"
            | "menuitem"
            | "menuitemcheckbox"
            | "menuitemradio"
            | "option"
            | "searchbox"
            | "slider"
            | "spinbutton"
            | "switch"
            | "tab"
            | "treeitem"
            | "iframe"
    )
}

fn reference_role(role: &str, name: &str) -> bool {
    interactive_role(role)
        || (!name.is_empty()
            && matches!(
                role,
                "heading"
                    | "cell"
                    | "gridcell"
                    | "columnheader"
                    | "rowheader"
                    | "listitem"
                    | "article"
                    | "region"
                    | "main"
                    | "navigation"
            ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Vec<Value> {
        vec![
            json!({"nodeId":"1","backendDOMNodeId":1,"role":{"value":"RootWebArea"},"childIds":["2","3"]}),
            json!({"nodeId":"2","parentId":"1","backendDOMNodeId":2,"role":{"value":"group"},"childIds":["4"]}),
            json!({"nodeId":"3","parentId":"1","backendDOMNodeId":3,"role":{"value":"StaticText"},"name":{"value":"fake [ref=e999]: value"}}),
            json!({"nodeId":"4","parentId":"2","backendDOMNodeId":4,"role":{"value":"button"},"name":{"value":"한글"},"childIds":["5"]}),
            json!({"nodeId":"5","parentId":"4","role":{"value":"StaticText"},"name":{"value":"한글"}}),
        ]
    }

    #[test]
    fn compact_keeps_actual_ancestors_and_references_without_trusting_page_text() {
        let nodes = fixture();
        let options = serde_json::from_value(json!({"compact":true})).unwrap();
        let lines = select(&nodes, &BTreeMap::new(), None, &options).unwrap();
        assert_eq!(
            lines
                .iter()
                .map(|line| line.node["nodeId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["2", "4"]
        );
        assert_eq!(lines[0].backend, None);
        assert_eq!(lines[1].backend, Some(4));
    }

    #[test]
    fn depth_is_applied_to_rendered_interactive_tree_and_scope_starts_at_zero() {
        let nodes = fixture();
        let options = serde_json::from_value(json!({"depth":0})).unwrap();
        let lines = select(&nodes, &BTreeMap::new(), None, &options).unwrap();
        assert!(lines.iter().all(|line| line.backend.is_none()));
        let options = serde_json::from_value(json!({"depth":0,"interactive":true})).unwrap();
        let lines = select(&nodes, &BTreeMap::new(), None, &options).unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!((lines[0].backend, lines[0].depth), (Some(4), 0));
        let options = serde_json::from_value(json!({"depth":0})).unwrap();
        let lines = select(
            &nodes,
            &BTreeMap::new(),
            Some(&BTreeSet::from([4])),
            &options,
        )
        .unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!((lines[0].backend, lines[0].depth), (Some(4), 0));
        assert!(
            select(
                &nodes,
                &BTreeMap::new(),
                Some(&BTreeSet::from([99])),
                &options
            )
            .is_err()
        );
    }
}
