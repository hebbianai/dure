use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Deserialize)]
struct Capture {
    documents: Vec<Document>,
    strings: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    frame_id: i64,
    nodes: Nodes,
    layout: Layout,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Nodes {
    parent_index: Vec<i64>,
    node_type: Vec<i64>,
    node_name: Vec<i64>,
    backend_node_id: Vec<i64>,
    attributes: Vec<Vec<i64>>,
    #[serde(default)]
    is_clickable: RareBoolean,
}

#[derive(Default, Deserialize)]
struct RareBoolean {
    index: Vec<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Layout {
    node_index: Vec<usize>,
    styles: Vec<Vec<i64>>,
}

/// A native DOM snapshot supplies candidate identities without inspecting JS
/// listener objects. Metadata is subsequently read from these exact nodes.
pub(super) fn select(value: Value, frame: &str) -> Result<Vec<(i64, bool)>, &'static str> {
    let capture: Capture =
        serde_json::from_value(value).map_err(|_| "browser_accessibility_invalid")?;
    let string = |index: i64| {
        // Chromium uses -1 for an empty StringIndex, including boolean attributes.
        if index == -1 {
            return Ok("");
        }
        usize::try_from(index)
            .ok()
            .and_then(|index| capture.strings.get(index))
            .map(String::as_str)
            .ok_or("browser_accessibility_invalid")
    };
    let document = capture
        .documents
        .iter()
        .find(|document| string(document.frame_id) == Ok(frame))
        .ok_or("browser_page_gone")?;
    let nodes = &document.nodes;
    let count = nodes.node_type.len();
    if [
        nodes.parent_index.len(),
        nodes.node_name.len(),
        nodes.backend_node_id.len(),
        nodes.attributes.len(),
    ]
    .iter()
    .any(|length| *length != count)
        || document.layout.node_index.len() != document.layout.styles.len()
        || nodes.is_clickable.index.iter().any(|index| *index >= count)
    {
        return Err("browser_accessibility_invalid");
    }
    let clickable: BTreeSet<_> = nodes.is_clickable.index.iter().copied().collect();
    let mut pointers = vec![false; count];
    for (index, styles) in document
        .layout
        .node_index
        .iter()
        .zip(&document.layout.styles)
    {
        let pointer = pointers
            .get_mut(*index)
            .ok_or("browser_accessibility_invalid")?;
        if let Some(index) = styles.first() {
            *pointer = string(*index)? == "pointer";
        }
    }
    let mut in_body = vec![false; count];
    let mut hidden = vec![false; count];
    let mut candidates = Vec::new();
    for index in 0..count {
        let parent = match nodes.parent_index[index] {
            -1 => None,
            value if value >= 0 && (value as usize) < index => Some(value as usize),
            _ => return Err("browser_accessibility_invalid"),
        };
        in_body[index] = parent
            .is_some_and(|parent| in_body[parent] || string(nodes.node_name[parent]) == Ok("BODY"));
        hidden[index] = parent.is_some_and(|parent| hidden[parent]);
        let attributes = &nodes.attributes[index];
        if attributes.len() % 2 != 0 {
            return Err("browser_accessibility_invalid");
        }
        let mut role = "";
        let mut onclick = false;
        let mut focusable = false;
        let mut editable = false;
        for pair in attributes.chunks_exact(2) {
            let name = string(pair[0])?;
            let value = string(pair[1])?;
            match name {
                "hidden" => hidden[index] = true,
                "aria-hidden" if value == "true" => hidden[index] = true,
                "role" => role = value,
                "onclick" => onclick = true,
                "tabindex" => focusable = value != "-1",
                "contenteditable" => editable = value.is_empty() || value == "true",
                _ => {}
            }
        }
        if nodes.node_type[index] != 1 || !in_body[index] || hidden[index] {
            continue;
        }
        let tag = string(nodes.node_name[index])?.to_ascii_lowercase();
        if [
            "a", "button", "input", "select", "textarea", "details", "summary",
        ]
        .contains(&tag.as_str())
            || super::super::render::interactive_role(&role.to_ascii_lowercase())
        {
            continue;
        }
        let mouse = clickable.contains(&index);
        if !pointers[index] && !mouse && !onclick && !focusable && !editable {
            continue;
        }
        if pointers[index]
            && !mouse
            && !onclick
            && !focusable
            && !editable
            && parent.is_some_and(|parent| pointers[parent])
        {
            continue;
        }
        let backend = nodes.backend_node_id[index];
        if backend <= 0 {
            return Err("browser_accessibility_invalid");
        }
        candidates.push((backend, mouse));
    }
    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Value {
        json!({
            "strings":["frame","BODY","DIV","SPAN","INPUT","pointer","auto","tabindex","0","-1","hidden","contenteditable"],
            "documents":[{
                "frameId":0,
                "nodes":{
                    "parentIndex":[-1,0,1,0,0,0,0,0,0],
                    "nodeType":[1,1,1,1,1,1,1,1,1],
                    "nodeName":[1,2,3,2,2,2,2,2,4],
                    "backendNodeId":[10,11,12,13,14,15,16,17,18],
                    "attributes":[[],[],[],[],[7,8],[7,9],[10,-1],[11,-1],[]],
                    "isClickable":{"index":[3,7]}
                },
                "layout":{"nodeIndex":[0,1,2,3,4,5,6,7,8],"styles":[[6],[5],[5],[6],[6],[6],[5],[6],[5]]}
            }]
        })
    }

    #[test]
    fn native_candidates_distinguish_inherited_hidden_empty_attributes_and_handlers() {
        assert_eq!(
            select(fixture(), "frame").unwrap(),
            [(11, false), (13, true), (14, false), (17, true)]
        );
        assert_eq!(select(fixture(), "other-frame"), Err("browser_page_gone"));
    }

    #[test]
    fn malformed_node_tables_cannot_select_different_nodes() {
        let mut value = fixture();
        value["documents"][0]["nodes"]["parentIndex"][1] = json!(1);
        assert_eq!(select(value, "frame"), Err("browser_accessibility_invalid"));
        let mut value = fixture();
        value["documents"][0]["nodes"]["attributes"][4] = json!([7]);
        assert_eq!(select(value, "frame"), Err("browser_accessibility_invalid"));
        let mut value = fixture();
        value["documents"][0]["nodes"]["backendNodeId"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert_eq!(select(value, "frame"), Err("browser_accessibility_invalid"));
    }
}
