// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Vercel Inc.
// Adapted from agent-browser c830d1b67dc18b754e305859f0ae587f858a1447,
// cli/src/native/react/. License: ../environment/device/LICENSE-agent-browser.

//! React component tree snapshot and formatter.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct TreeNode {
    pub id: i64,
    #[serde(rename = "type")]
    pub node_type: i64,
    pub name: Option<String>,
    pub key: Option<String>,
    pub parent: i64,
}

const HEADER: &str = "# React component tree\n# Columns: depth id parent name [key=...]\n# Use `react inspect <id>` for props/hooks/state. IDs valid until next navigation.";

pub fn format_tree(nodes: &[TreeNode]) -> Result<String, &'static str> {
    use std::collections::{HashMap, HashSet};
    let mut children: HashMap<i64, Vec<&TreeNode>> = HashMap::new();
    let mut ids = HashSet::new();
    for n in nodes {
        if n.id <= 0 || n.parent < 0 || !ids.insert(n.id) {
            return Err("browser_react_tree_invalid");
        }
        children.entry(n.parent).or_default().push(n);
    }

    let mut lines: Vec<String> = vec![HEADER.to_string()];
    let mut pending = Vec::new();
    if let Some(roots) = children.get(&0) {
        pending.extend(roots.iter().rev().map(|node| (*node, 0)));
    }
    let mut visited = HashSet::new();
    // Renderer data is untrusted. An iterative traversal handles deep real
    // trees without consuming the native stack and rejects malformed graphs.
    while let Some((node, depth)) = pending.pop() {
        if !visited.insert(node.id) {
            return Err("browser_react_tree_invalid");
        }
        lines.push(format_node(node, depth));
        if let Some(descendants) = children.get(&node.id) {
            pending.extend(descendants.iter().rev().map(|child| (*child, depth + 1)));
        }
    }
    if visited.len() != nodes.len() {
        return Err("browser_react_tree_invalid");
    }
    Ok(lines.join("\n"))
}

fn format_node(node: &TreeNode, depth: usize) -> String {
    let name = node
        .name
        .clone()
        .unwrap_or_else(|| type_name(node.node_type));
    let key = match &node.key {
        Some(k) => format!(" key={:?}", k),
        None => String::new(),
    };
    let parent = if node.parent == 0 {
        "-".to_string()
    } else {
        node.parent.to_string()
    };
    format!("{} {} {} {}{}", depth, node.id, parent, name, key)
}

fn type_name(t: i64) -> String {
    match t {
        11 => "Root".to_string(),
        12 => "Suspense".to_string(),
        13 => "SuspenseList".to_string(),
        _ => format!("({})", t),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: i64, parent: i64) -> TreeNode {
        TreeNode {
            id,
            parent,
            node_type: 11,
            name: None,
            key: None,
        }
    }

    #[test]
    fn react_tree_preserves_preorder_and_accepts_deep_real_trees() {
        let nodes = vec![node(1, 0), node(2, 1), node(3, 0), node(4, 2)];
        assert_eq!(
            format_tree(&nodes).unwrap(),
            format!("{HEADER}\n0 1 - Root\n1 2 1 Root\n2 4 2 Root\n0 3 - Root")
        );
        let deep: Vec<_> = (1..=10_000).map(|id| node(id, id - 1)).collect();
        assert!(
            format_tree(&deep)
                .unwrap()
                .ends_with("9999 10000 9999 Root")
        );
    }

    #[test]
    fn react_tree_rejects_cycles_duplicate_ids_and_missing_parents() {
        for nodes in [
            vec![node(1, 0), node(1, 1)],
            vec![node(1, 2), node(2, 1)],
            vec![node(1, 9)],
            vec![node(0, 0)],
            vec![node(1, -1)],
        ] {
            assert_eq!(format_tree(&nodes), Err("browser_react_tree_invalid"));
        }
    }
}
