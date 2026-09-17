use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::model::{
    ActionContract, ActionRef, GraphIssue, InputBinding, MAX_EDGES, MAX_VALUE_BYTES,
    WorkflowDefinition, WorkflowEdge, WorkflowNode,
};

#[derive(Clone, Debug)]
pub struct CompiledWorkflow {
    source: WorkflowDefinition,
    definition: WorkflowDefinition,
    contracts: BTreeMap<ActionRef, ActionContract>,
    order: Vec<String>,
    digest: String,
}

impl CompiledWorkflow {
    pub fn parse(
        mut definition: WorkflowDefinition,
        contracts: &[ActionContract],
    ) -> Result<Self, Vec<GraphIssue>> {
        definition.validate_draft().map_err(|issue| vec![issue])?;
        let source = definition.clone();
        if definition.nodes.is_empty() {
            return Err(vec![GraphIssue::new("graph_empty", None, None)]);
        }
        let contracts: BTreeMap<_, _> = contracts
            .iter()
            .map(|contract| (contract.action.clone(), contract.clone()))
            .collect();
        let nodes: BTreeMap<_, _> = definition
            .nodes
            .iter()
            .map(|node| (node.node_id.as_str(), node))
            .collect();
        let mut issues = Vec::new();
        let mut edges: BTreeSet<_> = definition.edges.iter().cloned().collect();
        for edge in &edges {
            if !nodes.contains_key(edge.source.as_str())
                || !nodes.contains_key(edge.target.as_str())
            {
                issues.push(GraphIssue::new(
                    "edge_node_missing",
                    Some(&edge.target),
                    None,
                ));
            }
        }
        for node in &definition.nodes {
            let Some(contract) = contracts.get(&node.action) else {
                issues.push(GraphIssue::new(
                    "action_unsupported",
                    Some(&node.node_id),
                    None,
                ));
                continue;
            };
            for (field, spec) in &contract.inputs {
                if spec.required && !node.inputs.contains_key(field) {
                    issues.push(GraphIssue::new(
                        "input_missing",
                        Some(&node.node_id),
                        Some(field),
                    ));
                }
            }
            for (field, binding) in &node.inputs {
                let Some(spec) = contract.inputs.get(field) else {
                    issues.push(GraphIssue::new(
                        "input_unknown",
                        Some(&node.node_id),
                        Some(field),
                    ));
                    continue;
                };
                let code = match binding {
                    InputBinding::Literal { value } if !spec.value_type.accepts(value) => {
                        Some("input_type_mismatch")
                    }
                    InputBinding::Literal { .. } => None,
                    InputBinding::Output { .. } if !spec.accepts_output => {
                        Some("input_requires_literal")
                    }
                    InputBinding::Output {
                        node_id,
                        field: output_field,
                    } => {
                        let output = nodes
                            .get(node_id.as_str())
                            .and_then(|source| contracts.get(&source.action))
                            .and_then(|source| source.outputs.get(output_field));
                        match output {
                            None => Some("output_reference_missing"),
                            Some(output) if !output.required => Some("output_may_be_missing"),
                            Some(output) if !spec.value_type.accepts_type(output.value_type) => {
                                Some("input_type_mismatch")
                            }
                            Some(_) => {
                                edges.insert(WorkflowEdge {
                                    source: node_id.clone(),
                                    target: node.node_id.clone(),
                                });
                                None
                            }
                        }
                    }
                };
                if let Some(code) = code {
                    issues.push(GraphIssue::new(code, Some(&node.node_id), Some(field)));
                }
            }
        }
        if edges.len() > MAX_EDGES {
            issues.push(GraphIssue::new("graph_too_large", None, None));
        }
        if !issues.is_empty() {
            return Err(issues);
        }
        let mut remaining: BTreeSet<_> = nodes.keys().map(|key| (*key).to_owned()).collect();
        let mut order = Vec::with_capacity(remaining.len());
        while !remaining.is_empty() {
            let next = remaining
                .iter()
                .find(|node| {
                    !edges
                        .iter()
                        .any(|edge| &edge.target == *node && remaining.contains(&edge.source))
                })
                .cloned();
            let Some(next) = next else {
                return Err(vec![GraphIssue::new("graph_cycle", None, None)]);
            };
            remaining.remove(&next);
            order.push(next);
        }
        definition
            .nodes
            .sort_by(|left, right| left.node_id.cmp(&right.node_id));
        definition.edges = edges.into_iter().collect();
        let bytes = serde_json::to_vec(&definition)
            .map_err(|_| vec![GraphIssue::new("definition_invalid", None, None)])?;
        let digest = format!("{:x}", Sha256::digest(bytes));
        Ok(Self {
            source,
            definition,
            contracts,
            order,
            digest,
        })
    }

    pub(crate) fn compiled_from(&self, definition: &WorkflowDefinition) -> bool {
        &self.source == definition
    }

    pub fn definition(&self) -> &WorkflowDefinition {
        &self.definition
    }

    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn order(&self) -> &[String] {
        &self.order
    }

    pub fn node(&self, node_id: &str) -> Option<&WorkflowNode> {
        self.definition
            .nodes
            .iter()
            .find(|node| node.node_id == node_id)
    }

    pub fn predecessors(&self, node_id: &str) -> impl Iterator<Item = &str> {
        self.definition
            .edges
            .iter()
            .filter(move |edge| edge.target == node_id)
            .map(|edge| edge.source.as_str())
    }

    /// Mapping preview and real admission share this pure resolver. Missing
    /// outputs are errors; neither path runs predecessors or substitutes samples.
    pub fn resolve_inputs(
        &self,
        node_id: &str,
        outputs: &BTreeMap<String, BTreeMap<String, Value>>,
    ) -> Result<BTreeMap<String, Value>, GraphIssue> {
        let node = self
            .node(node_id)
            .ok_or_else(|| GraphIssue::new("node_missing", Some(node_id), None))?;
        let contract = &self.contracts[&node.action];
        let mut inputs = BTreeMap::new();
        for (field, binding) in &node.inputs {
            let value = match binding {
                InputBinding::Literal { value } => value,
                InputBinding::Output {
                    node_id: source,
                    field: source_field,
                } => outputs
                    .get(source)
                    .and_then(|output| output.get(source_field))
                    .ok_or_else(|| {
                        GraphIssue::new("upstream_output_unavailable", Some(node_id), Some(field))
                    })?,
            };
            if !contract.inputs[field].value_type.accepts(value) {
                return Err(GraphIssue::new(
                    "input_type_mismatch",
                    Some(node_id),
                    Some(field),
                ));
            }
            inputs.insert(field.clone(), value.clone());
        }
        Ok(inputs)
    }

    pub fn validate_outputs(
        &self,
        node_id: &str,
        outputs: &BTreeMap<String, Value>,
    ) -> Result<(), GraphIssue> {
        let node = self
            .node(node_id)
            .ok_or_else(|| GraphIssue::new("node_missing", Some(node_id), None))?;
        let contract = &self.contracts[&node.action];
        if serde_json::to_vec(outputs).map_or(true, |bytes| bytes.len() > MAX_VALUE_BYTES) {
            return Err(GraphIssue::new("output_too_large", Some(node_id), None));
        }
        for (field, spec) in &contract.outputs {
            match outputs.get(field) {
                None if spec.required => {
                    return Err(GraphIssue::new(
                        "output_missing",
                        Some(node_id),
                        Some(field),
                    ));
                }
                Some(value) if !spec.value_type.accepts(value) => {
                    return Err(GraphIssue::new(
                        "output_type_mismatch",
                        Some(node_id),
                        Some(field),
                    ));
                }
                _ => {}
            }
        }
        if let Some(field) = outputs
            .keys()
            .find(|field| !contract.outputs.contains_key(*field))
        {
            return Err(GraphIssue::new(
                "output_unknown",
                Some(node_id),
                Some(field),
            ));
        }
        Ok(())
    }
}
