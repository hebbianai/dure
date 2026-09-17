use std::collections::BTreeMap;

use serde_json::json;

use super::*;

fn contracts() -> Vec<ActionContract> {
    let string = FieldContract {
        value_type: FieldType::String,
        required: true,
        accepts_output: true,
    };
    vec![
        ActionContract {
            action: ActionRef {
                action_id: "command".into(),
                version: 1,
            },
            inputs: BTreeMap::from([(
                "script".into(),
                FieldContract {
                    accepts_output: false,
                    ..string.clone()
                },
            )]),
            outputs: BTreeMap::from([("stdout".into(), string.clone())]),
        },
        ActionContract {
            action: ActionRef {
                action_id: "agent".into(),
                version: 1,
            },
            inputs: BTreeMap::from([("input".into(), string.clone())]),
            outputs: BTreeMap::from([("resultMarkdown".into(), string)]),
        },
    ]
}

fn definition() -> WorkflowDefinition {
    serde_json::from_value(json!({
        "schemaVersion": 1,
        "nodes": [
            { "nodeId": "review", "name": "Review changes", "action": {"actionId": "agent", "version": 1},
              "inputs": { "input": { "kind": "output", "nodeId": "collect", "field": "stdout" } } },
            { "nodeId": "collect", "name": "Collect changes", "action": {"actionId": "command", "version": 1},
              "inputs": { "script": { "kind": "literal", "value": "git diff HEAD~1" } } }
        ],
        "edges": []
    })).unwrap()
}

#[test]
fn mapping_adds_the_dependency_and_resolves_exact_output_without_execution() {
    let workflow = CompiledWorkflow::parse(definition(), &contracts()).unwrap();
    assert_eq!(workflow.order(), ["collect", "review"]);
    assert_eq!(
        workflow.predecessors("review").collect::<Vec<_>>(),
        ["collect"]
    );
    let missing = workflow
        .resolve_inputs("review", &BTreeMap::new())
        .unwrap_err();
    assert_eq!(missing.code, "upstream_output_unavailable");
    assert_eq!(missing.field.as_deref(), Some("input"));
    let output = BTreeMap::from([("stdout".into(), json!("a changed function\nwith details"))]);
    workflow.validate_outputs("collect", &output).unwrap();
    let inputs = workflow
        .resolve_inputs("review", &BTreeMap::from([("collect".into(), output)]))
        .unwrap();
    assert_eq!(inputs["input"], "a changed function\nwith details");
}

#[test]
fn names_never_retarget_mappings_and_input_order_never_changes_the_version() {
    let first = CompiledWorkflow::parse(definition(), &contracts()).unwrap();
    let mut reordered = definition();
    reordered.nodes.reverse();
    reordered.edges = first.definition().edges.clone();
    assert_eq!(
        CompiledWorkflow::parse(reordered, &contracts())
            .unwrap()
            .digest(),
        first.digest()
    );
    let mut renamed = definition();
    renamed.nodes[1].name = "Changed display name".into();
    let renamed = CompiledWorkflow::parse(renamed, &contracts()).unwrap();
    assert_eq!(
        renamed.predecessors("review").collect::<Vec<_>>(),
        ["collect"]
    );
}

fn version() -> WorkflowVersion {
    let request = WorkflowPutRequest {
        schema_version: 1,
        workflow_id: "daily".into(),
        expected_revision: 0,
        idempotency_key: "save-1".into(),
        name: "Daily review".into(),
        definition: definition(),
        trigger: WorkflowTrigger::Manual,
    };
    let record = WorkflowRecord::save(None, &request, 100).unwrap();
    record
        .snapshot(
            &CompiledWorkflow::parse(definition(), &contracts()).unwrap(),
            1,
            100,
        )
        .unwrap()
}

#[test]
fn run_uses_only_its_own_completed_outputs_after_reopen() {
    let version = version();
    let mut execution =
        ExecutingWorkflow::admit(&version, &contracts(), "manual-1", RunTrigger::Manual, 200)
            .unwrap();
    let collect = execution
        .start_next("service-generation-1", 201)
        .unwrap()
        .unwrap()
        .clone();
    assert!(
        execution
            .start_next("service-generation-1", 202)
            .unwrap()
            .is_none()
    );
    execution
        .complete(
            &collect.dispatch_id,
            BTreeMap::from([("stdout".into(), json!("observed changes"))]),
            203,
        )
        .unwrap();
    let stored = serde_json::to_string(execution.run()).unwrap();
    let mut reopened = ExecutingWorkflow::restore(
        &version,
        &contracts(),
        serde_json::from_str(&stored).unwrap(),
    )
    .unwrap();
    let review = reopened
        .start_next("service-generation-2", 204)
        .unwrap()
        .unwrap()
        .clone();
    let ActionState::Started { inputs, .. } = review.state else {
        panic!("review did not start")
    };
    assert_eq!(inputs["input"], "observed changes");
    reopened
        .bind_effect(&review.dispatch_id, "retained-operation", 205)
        .unwrap();
    reopened
        .complete(
            &review.dispatch_id,
            BTreeMap::from([("resultMarkdown".into(), json!("Review report"))]),
            206,
        )
        .unwrap();
    assert_eq!(reopened.run().status(), RunStatus::Completed);
    assert!(
        reopened
            .start_next("service-generation-2", 207)
            .unwrap()
            .is_none()
    );
    assert!(ExecutingWorkflow::restore(&version, &contracts(), reopened.into_run()).is_ok());
}

#[test]
fn an_uncertain_started_effect_is_never_automatically_repeated_or_used_downstream() {
    let version = version();
    let mut execution =
        ExecutingWorkflow::admit(&version, &contracts(), "manual-1", RunTrigger::Manual, 200)
            .unwrap();
    let task = execution
        .start_next("service-before-restart", 201)
        .unwrap()
        .unwrap()
        .clone();
    let mut reopened =
        ExecutingWorkflow::restore(&version, &contracts(), execution.into_run()).unwrap();
    assert!(
        reopened
            .start_next("service-after-restart", 202)
            .unwrap()
            .is_none()
    );
    reopened
        .fail(
            &task.dispatch_id,
            "command_result_unavailable",
            true,
            None,
            203,
        )
        .unwrap();
    assert_eq!(reopened.run().status(), RunStatus::Uncertain);
    assert!(
        reopened
            .start_next("service-after-restart", 204)
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        reopened.run().tasks[1].state,
        ActionState::Pending
    ));
}

#[test]
fn invalid_outputs_and_clock_errors_leave_the_started_dispatch_unchanged() {
    let version = version();
    let mut execution =
        ExecutingWorkflow::admit(&version, &contracts(), "manual-1", RunTrigger::Manual, 200)
            .unwrap();
    let task = execution
        .start_next("service", 201)
        .unwrap()
        .unwrap()
        .clone();
    let before = execution.run().clone();
    assert!(
        execution
            .complete(&task.dispatch_id, BTreeMap::new(), 202)
            .is_err()
    );
    assert_eq!(execution.run(), &before);
    assert!(
        execution
            .complete(
                &task.dispatch_id,
                BTreeMap::from([("stdout".into(), json!("output"))]),
                1
            )
            .is_err()
    );
    assert_eq!(execution.run(), &before);
}

#[test]
fn a_deleted_source_remains_an_editable_draft_but_cannot_activate() {
    let mut draft = definition();
    draft.nodes.retain(|node| node.node_id != "collect");
    draft.validate_draft().unwrap();
    let issues = CompiledWorkflow::parse(draft, &contracts()).unwrap_err();
    assert_eq!(issues[0].code, "output_reference_missing");
    assert_eq!(issues[0].node_id.as_deref(), Some("review"));
    assert_eq!(issues[0].field.as_deref(), Some("input"));
}

#[test]
fn mismatched_or_optional_outputs_cannot_silently_feed_required_inputs() {
    let mut catalog = contracts();
    catalog[0].outputs.get_mut("stdout").unwrap().value_type = FieldType::Number;
    assert_eq!(
        CompiledWorkflow::parse(definition(), &catalog).unwrap_err()[0].code,
        "input_type_mismatch"
    );
    catalog[0].outputs.get_mut("stdout").unwrap().required = false;
    assert_eq!(
        CompiledWorkflow::parse(definition(), &catalog).unwrap_err()[0].code,
        "output_may_be_missing"
    );
}

#[test]
fn a_back_edge_or_self_reference_cannot_create_an_unbounded_cycle() {
    let mut cyclic = definition();
    cyclic.edges.push(WorkflowEdge {
        source: "review".into(),
        target: "collect".into(),
    });
    assert_eq!(
        CompiledWorkflow::parse(cyclic, &contracts()).unwrap_err()[0].code,
        "graph_cycle"
    );
    let mut self_cycle = definition();
    self_cycle.nodes[0].inputs.insert(
        "input".into(),
        InputBinding::Output {
            node_id: "review".into(),
            field: "resultMarkdown".into(),
        },
    );
    assert_eq!(
        CompiledWorkflow::parse(self_cycle, &contracts()).unwrap_err()[0].code,
        "graph_cycle"
    );
}

#[test]
fn action_versions_and_literal_only_fields_are_admission_boundaries() {
    let mut newer = definition();
    newer.nodes[0].action.version = 2;
    assert!(
        CompiledWorkflow::parse(newer, &contracts())
            .unwrap_err()
            .iter()
            .any(|issue| issue.code == "action_unsupported")
    );
    let mut dynamic_script = definition();
    dynamic_script.nodes[1].inputs.insert(
        "script".into(),
        InputBinding::Output {
            node_id: "review".into(),
            field: "resultMarkdown".into(),
        },
    );
    assert_eq!(
        CompiledWorkflow::parse(dynamic_script, &contracts()).unwrap_err()[0].code,
        "input_requires_literal"
    );
}

#[test]
fn observed_outputs_must_match_the_pinned_action_contract() {
    let workflow = CompiledWorkflow::parse(definition(), &contracts()).unwrap();
    assert_eq!(
        workflow
            .validate_outputs("collect", &BTreeMap::new())
            .unwrap_err()
            .code,
        "output_missing"
    );
    assert_eq!(
        workflow
            .validate_outputs("collect", &BTreeMap::from([("stdout".into(), json!(4))]))
            .unwrap_err()
            .code,
        "output_type_mismatch"
    );
    assert_eq!(
        workflow
            .validate_outputs(
                "collect",
                &BTreeMap::from([
                    ("stdout".into(), json!("ok")),
                    ("unexpected".into(), json!(true))
                ])
            )
            .unwrap_err()
            .code,
        "output_unknown"
    );
}

#[test]
fn malformed_graph_identity_cannot_enter_saved_drafts() {
    let mut duplicate = definition();
    duplicate.nodes.push(duplicate.nodes[0].clone());
    assert_eq!(
        duplicate.validate_draft().unwrap_err().code,
        "node_id_invalid"
    );
    let mut too_large = definition();
    too_large.nodes[1].inputs.insert(
        "script".into(),
        InputBinding::Literal {
            value: json!("x".repeat(70 * 1024)),
        },
    );
    assert_eq!(
        too_large.validate_draft().unwrap_err().code,
        "input_invalid"
    );
}
