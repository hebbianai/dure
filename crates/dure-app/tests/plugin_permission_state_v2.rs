use std::{collections::BTreeMap, sync::Arc};

use dure_app::{
    AgentAdapterIdV2, AgentAdapterSupportV2, ContractVersionRangeV2, ContributionFamilyIdV2,
    ContributionFamilySupportV2, MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2,
    MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2, PermissionKindIdV2,
    PluginBundledPermissionPackageV2, PluginHostContractV2, PluginPackageCandidateIdV2,
    PluginPackageCatalogSnapshotV2, PluginPackageRegistryV2, PluginPackageSourceCandidateV2,
    PluginPackageSourceIdV2, PluginPackageSourceRegistrationV2, PluginPackageSourceV2,
    PluginPermissionDecisionErrorV2, PluginPermissionDecisionEventBodyV2,
    PluginPermissionDecisionEventDispositionV2, PluginPermissionDecisionEventV2,
    PluginPermissionDecisionFoldCheckpointV2, PluginPermissionDecisionFoldV2,
    PluginPermissionDecisionKeyV2, PluginPermissionDecisionReplayBodyV2,
    PluginPermissionDecisionRequestIdV2, PluginPermissionDecisionRequestV2,
    PluginPermissionDecisionV2, PluginPermissionEnablementV2, PluginPermissionExecutionErrorV2,
    PluginPermissionHostPolicyV2, PluginPermissionKindPolicyV2, PluginPermissionParameterPolicyV2,
    PluginWorkspaceIdentityV2, apply_plugin_permission_decision_event,
    apply_plugin_permission_decision_request, canonicalize_plugin_permission_plan,
    evaluate_plugin_permission_execution, revalidate_plugin_permission_execution_lease,
};

#[derive(Clone)]
struct FixtureSource {
    candidate_id: PluginPackageCandidateIdV2,
    snapshot: PluginPackageCatalogSnapshotV2,
}

impl PluginPackageSourceV2 for FixtureSource {
    fn load(&self) -> Vec<PluginPackageSourceCandidateV2> {
        vec![PluginPackageSourceCandidateV2::accepted(
            self.candidate_id.clone(),
            self.snapshot.clone(),
        )]
    }
}

fn workspace(fill: char) -> PluginWorkspaceIdentityV2 {
    PluginWorkspaceIdentityV2::from_host_hmac(format!("sha256:{}", fill.to_string().repeat(64)))
        .unwrap()
}

fn parameter(name: &str, values: &[&str]) -> PluginPermissionParameterPolicyV2 {
    PluginPermissionParameterPolicyV2::try_new(
        name,
        true,
        values.iter().map(|value| (*value).to_owned()).collect(),
    )
    .unwrap()
}

fn policy() -> PluginPermissionHostPolicyV2 {
    PluginPermissionHostPolicyV2::try_new(vec![
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
            vec![parameter(
                "operations",
                &["activate", "human", "list", "ready", "show", "watch"],
            )],
        )
        .unwrap(),
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.ui.contribute").unwrap(),
            vec![parameter(
                "surfaces",
                &["agent_pane_claim_status", "primary_sidebar"],
            )],
        )
        .unwrap(),
    ])
    .unwrap()
}

fn host() -> PluginHostContractV2 {
    PluginHostContractV2 {
        host_api: ContractVersionRangeV2::new(1, 2),
        contribution_families: vec![
            ContributionFamilySupportV2 {
                family: ContributionFamilyIdV2::new("dure.issue-tracker").unwrap(),
                api: ContractVersionRangeV2::new(1, 1),
            },
            ContributionFamilySupportV2 {
                family: ContributionFamilyIdV2::new("dure.settings").unwrap(),
                api: ContractVersionRangeV2::new(1, 1),
            },
            ContributionFamilySupportV2 {
                family: ContributionFamilyIdV2::new("dure.views").unwrap(),
                api: ContractVersionRangeV2::new(1, 1),
            },
        ],
        agent_adapters: vec![AgentAdapterSupportV2 {
            adapter: AgentAdapterIdV2::new("codex").unwrap(),
        }],
        permission_kinds: vec![
            PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
            PermissionKindIdV2::new("dure.ui.contribute").unwrap(),
        ],
    }
}

fn plan(source_id: &str, workspace_fill: char) -> dure_app::PluginPermissionPlanV2 {
    let manifest: dure_app::PluginManifestV2 =
        serde_json::from_str(include_str!("../../../plugins/beads/dure-plugin.json")).unwrap();
    let plugin_id = manifest.id.clone();
    let agent_resources = manifest
        .agent_integrations
        .iter()
        .map(|integration| {
            (
                integration.id.clone(),
                BTreeMap::from([(
                    dure_app::PluginResourcePathV2::new("./plugin.json").unwrap(),
                    Arc::<[u8]>::from(integration.adapter.as_str().as_bytes()),
                )]),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let resources = manifest
        .contributions
        .iter()
        .map(|contribution| {
            (
                contribution.resource.clone(),
                Arc::<[u8]>::from(b"{}".as_slice()),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let source = FixtureSource {
        candidate_id: PluginPackageCandidateIdV2::new("candidate.beads").unwrap(),
        snapshot: PluginPackageCatalogSnapshotV2::try_new_with_embedded_package(
            Arc::from(serde_json::to_vec(&manifest).unwrap()),
            resources,
            agent_resources,
        )
        .unwrap(),
    };
    let registration = PluginPackageSourceRegistrationV2::trusted_bundled(
        PluginPackageSourceIdV2::new(source_id).unwrap(),
        &source,
        "dure.release",
    )
    .unwrap();
    let registry = PluginPackageRegistryV2::from_sources(&[registration]);
    let package = PluginBundledPermissionPackageV2::from_registered(
        registry.package(&plugin_id).expect("fixture package"),
    )
    .unwrap();
    canonicalize_plugin_permission_plan(&package, &host(), workspace(workspace_fill), &policy())
        .unwrap()
}

fn request_id(value: &str) -> PluginPermissionDecisionRequestIdV2 {
    PluginPermissionDecisionRequestIdV2::new(value).unwrap()
}

fn approve(
    fold: &mut PluginPermissionDecisionFoldV2,
    plan: &dure_app::PluginPermissionPlanV2,
    id: &str,
    expected_revision: u64,
) -> PluginPermissionDecisionEventV2 {
    apply_plugin_permission_decision_request(
        fold,
        PluginPermissionDecisionRequestV2::decide(
            request_id(id),
            expected_revision,
            plan,
            PluginPermissionDecisionV2::Approve,
        ),
    )
    .unwrap()
    .into_event()
}

fn enable(
    fold: &mut PluginPermissionDecisionFoldV2,
    plan: &dure_app::PluginPermissionPlanV2,
    id: &str,
    expected_revision: u64,
) -> PluginPermissionDecisionEventV2 {
    apply_plugin_permission_decision_request(
        fold,
        PluginPermissionDecisionRequestV2::enable(request_id(id), expected_revision, plan),
    )
    .unwrap()
    .into_event()
}

fn checkpoint_round_trip(
    fold: &PluginPermissionDecisionFoldV2,
) -> PluginPermissionDecisionFoldCheckpointV2 {
    serde_json::from_value(serde_json::to_value(fold.checkpoint().unwrap()).unwrap()).unwrap()
}

#[test]
fn approval_is_not_enablement_and_exact_scope_creates_an_opaque_lease() {
    let plan = plan("host.bundled", 'a');
    let key = PluginPermissionDecisionKeyV2::from_plan(&plan);
    let mut fold = PluginPermissionDecisionFoldV2::new(key.clone());

    approve(&mut fold, &plan, "approve-1", 0);
    assert_eq!(fold.state().record_revision(), 1);
    assert_eq!(fold.state().decision_revision(), 1);
    assert_eq!(fold.state().enablement_epoch(), 1);
    assert_eq!(
        fold.state().decision(),
        Some(PluginPermissionDecisionV2::Approve)
    );
    assert_eq!(
        fold.state().reviewed_projection(),
        Some(plan.review_projection())
    );
    assert_eq!(
        fold.state().enablement(),
        PluginPermissionEnablementV2::Disabled
    );
    assert!(matches!(
        evaluate_plugin_permission_execution(
            fold.state(),
            &plan,
            &PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
            "operations",
            "list",
        ),
        Err(PluginPermissionExecutionErrorV2::Disabled)
    ));

    enable(&mut fold, &plan, "enable-1", 1);
    let lease = evaluate_plugin_permission_execution(
        fold.state(),
        &plan,
        &PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
        "operations",
        "list",
    )
    .unwrap();
    assert_eq!(lease.key(), &key);
    assert_eq!(lease.record_revision(), 2);
    assert_eq!(lease.decision_revision(), 1);
    assert_eq!(lease.enablement_epoch(), 2);
    assert_eq!(lease.parameter(), "operations");
    assert_eq!(lease.value(), "list");
    revalidate_plugin_permission_execution_lease(&lease, fold.state(), &plan).unwrap();

    assert!(matches!(
        evaluate_plugin_permission_execution(
            fold.state(),
            &plan,
            &PermissionKindIdV2::new("dure.native-agent.install").unwrap(),
            "integrations",
            "dure.beads.codex",
        ),
        Err(PluginPermissionExecutionErrorV2::PermissionKindNotGranted { .. })
    ));
}

#[test]
fn defer_and_reject_remain_distinct_decisions_and_cannot_enable() {
    let plan = plan("host.bundled", 'a');
    let mut fold =
        PluginPermissionDecisionFoldV2::new(PluginPermissionDecisionKeyV2::from_plan(&plan));
    apply_plugin_permission_decision_request(
        &mut fold,
        PluginPermissionDecisionRequestV2::decide(
            request_id("defer-1"),
            0,
            &plan,
            PluginPermissionDecisionV2::Defer,
        ),
    )
    .unwrap();
    assert_eq!(
        fold.state().decision(),
        Some(PluginPermissionDecisionV2::Defer)
    );
    assert!(matches!(
        apply_plugin_permission_decision_request(
            &mut fold,
            PluginPermissionDecisionRequestV2::enable(request_id("enable-deferred"), 1, &plan),
        ),
        Err(PluginPermissionDecisionErrorV2::DecisionNotApproved)
    ));

    apply_plugin_permission_decision_request(
        &mut fold,
        PluginPermissionDecisionRequestV2::decide(
            request_id("reject-1"),
            1,
            &plan,
            PluginPermissionDecisionV2::Reject,
        ),
    )
    .unwrap();
    assert_eq!(
        fold.state().decision(),
        Some(PluginPermissionDecisionV2::Reject)
    );
    assert_eq!(fold.state().decision_revision(), 2);
    assert_eq!(fold.state().enablement_epoch(), 2);
    assert!(matches!(
        apply_plugin_permission_decision_request(
            &mut fold,
            PluginPermissionDecisionRequestV2::enable(request_id("enable-rejected"), 2, &plan),
        ),
        Err(PluginPermissionDecisionErrorV2::DecisionNotApproved)
    ));
}

#[test]
fn every_new_decision_atomically_disables_and_invalidates_execution() {
    let plan = plan("host.bundled", 'a');
    let mut fold =
        PluginPermissionDecisionFoldV2::new(PluginPermissionDecisionKeyV2::from_plan(&plan));
    approve(&mut fold, &plan, "approve-1", 0);
    enable(&mut fold, &plan, "enable-1", 1);
    let lease = evaluate_plugin_permission_execution(
        fold.state(),
        &plan,
        &PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
        "operations",
        "watch",
    )
    .unwrap();

    approve(&mut fold, &plan, "approve-again", 2);
    assert_eq!(fold.state().record_revision(), 3);
    assert_eq!(fold.state().decision_revision(), 2);
    assert_eq!(fold.state().enablement_epoch(), 3);
    assert_eq!(
        fold.state().enablement(),
        PluginPermissionEnablementV2::Disabled
    );
    assert!(matches!(
        revalidate_plugin_permission_execution_lease(&lease, fold.state(), &plan),
        Err(PluginPermissionExecutionErrorV2::StaleLease)
    ));
}

#[test]
fn stale_plan_binding_cannot_enable_or_execute() {
    let first = plan("host.bundled", 'a');
    let changed = plan("host.replacement", 'a');
    assert_eq!(
        PluginPermissionDecisionKeyV2::from_plan(&first),
        PluginPermissionDecisionKeyV2::from_plan(&changed)
    );
    assert_ne!(first.digest(), changed.digest());
    let mut fold =
        PluginPermissionDecisionFoldV2::new(PluginPermissionDecisionKeyV2::from_plan(&first));
    approve(&mut fold, &first, "approve-1", 0);
    assert!(matches!(
        apply_plugin_permission_decision_request(
            &mut fold,
            PluginPermissionDecisionRequestV2::enable(request_id("stale-enable"), 1, &changed),
        ),
        Err(PluginPermissionDecisionErrorV2::ApprovedBindingMismatch)
    ));

    enable(&mut fold, &first, "enable-current", 1);
    assert!(matches!(
        evaluate_plugin_permission_execution(
            fold.state(),
            &changed,
            &PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
            "operations",
            "list",
        ),
        Err(PluginPermissionExecutionErrorV2::StalePlanBinding)
    ));
}

#[test]
fn unconditional_disable_fences_stale_enable_and_prevents_aba() {
    let plan = plan("host.bundled", 'a');
    let key = PluginPermissionDecisionKeyV2::from_plan(&plan);
    let mut fold = PluginPermissionDecisionFoldV2::new(key.clone());
    approve(&mut fold, &plan, "approve-1", 0);
    let stale_enable =
        PluginPermissionDecisionRequestV2::enable(request_id("stale-enable"), 1, &plan);
    apply_plugin_permission_decision_request(
        &mut fold,
        PluginPermissionDecisionRequestV2::disable(request_id("disable-1"), 1, key),
    )
    .unwrap();
    assert_eq!(fold.state().record_revision(), 2);
    assert_eq!(fold.state().enablement_epoch(), 2);
    assert_eq!(
        fold.state().decision(),
        Some(PluginPermissionDecisionV2::Approve)
    );
    assert!(matches!(
        apply_plugin_permission_decision_request(&mut fold, stale_enable),
        Err(PluginPermissionDecisionErrorV2::RecordRevisionConflict {
            expected: 1,
            actual: 2
        })
    ));

    enable(&mut fold, &plan, "enable-after-disable", 2);
    assert_eq!(fold.state().record_revision(), 3);
    assert_eq!(fold.state().enablement_epoch(), 3);
    assert_eq!(
        fold.state().enablement(),
        PluginPermissionEnablementV2::Enabled
    );
}

#[test]
fn request_replay_is_idempotent_but_conflicts_and_concurrent_stale_cas_fail() {
    let plan = plan("host.bundled", 'a');
    let mut fold =
        PluginPermissionDecisionFoldV2::new(PluginPermissionDecisionKeyV2::from_plan(&plan));
    let first = apply_plugin_permission_decision_request(
        &mut fold,
        PluginPermissionDecisionRequestV2::decide(
            request_id("same-request"),
            0,
            &plan,
            PluginPermissionDecisionV2::Approve,
        ),
    )
    .unwrap();
    assert_eq!(
        first.disposition(),
        PluginPermissionDecisionEventDispositionV2::Applied
    );
    assert!(first.event_to_append().is_some());

    let replay = apply_plugin_permission_decision_request(
        &mut fold,
        PluginPermissionDecisionRequestV2::decide(
            request_id("same-request"),
            0,
            &plan,
            PluginPermissionDecisionV2::Approve,
        ),
    )
    .unwrap();
    assert_eq!(
        replay.disposition(),
        PluginPermissionDecisionEventDispositionV2::ExactReplay
    );
    assert!(replay.event_to_append().is_none());
    assert_eq!(fold.state().record_revision(), 1);

    assert!(matches!(
        apply_plugin_permission_decision_request(
            &mut fold,
            PluginPermissionDecisionRequestV2::decide(
                request_id("same-request"),
                0,
                &plan,
                PluginPermissionDecisionV2::Reject,
            ),
        ),
        Err(PluginPermissionDecisionErrorV2::DuplicateRequestConflict { .. })
    ));
    assert!(matches!(
        apply_plugin_permission_decision_request(
            &mut fold,
            PluginPermissionDecisionRequestV2::decide(
                request_id("concurrent-request"),
                0,
                &plan,
                PluginPermissionDecisionV2::Approve,
            ),
        ),
        Err(PluginPermissionDecisionErrorV2::RecordRevisionConflict {
            expected: 0,
            actual: 1
        })
    ));
}

#[test]
fn persisted_events_are_strict_replay_safe_and_use_decimal_revision_strings() {
    let plan = plan("host.bundled", 'a');
    let key = PluginPermissionDecisionKeyV2::from_plan(&plan);
    let mut fold = PluginPermissionDecisionFoldV2::new(key.clone());
    let event = approve(&mut fold, &plan, "approve-1", 0);
    let wire = serde_json::to_value(&event).unwrap();
    assert!(matches!(
        event.body(),
        PluginPermissionDecisionEventBodyV2::DecisionRecordedWithReview {
            review_projection,
            ..
        } if review_projection == plan.review_projection()
    ));
    assert_eq!(wire["body"]["kind"], "decision_recorded_with_review");
    assert_eq!(wire["expected_record_revision"], "0");
    assert_eq!(wire["record_revision"], "1");
    assert_eq!(wire["decision_revision"], "1");
    assert_eq!(wire["enablement_epoch"], "1");
    assert_eq!(
        serde_json::from_value::<PluginPermissionDecisionEventV2>(wire.clone()).unwrap(),
        event
    );

    let mut replay_fold = PluginPermissionDecisionFoldV2::new(key);
    assert_eq!(
        apply_plugin_permission_decision_event(&mut replay_fold, &event)
            .unwrap()
            .disposition(),
        PluginPermissionDecisionEventDispositionV2::Applied
    );
    assert_eq!(
        apply_plugin_permission_decision_event(&mut replay_fold, &event)
            .unwrap()
            .disposition(),
        PluginPermissionDecisionEventDispositionV2::ExactReplay
    );
    assert_eq!(replay_fold.state().record_revision(), 1);
    assert_eq!(
        replay_fold.state().reviewed_projection(),
        Some(plan.review_projection())
    );

    let mut conflicting = wire.clone();
    conflicting["body"]["decision"] = serde_json::json!("reject");
    let conflicting: PluginPermissionDecisionEventV2 = serde_json::from_value(conflicting).unwrap();
    assert!(matches!(
        apply_plugin_permission_decision_event(&mut replay_fold, &conflicting),
        Err(PluginPermissionDecisionErrorV2::DuplicateRequestConflict { .. })
    ));

    let mut unknown = wire.clone();
    unknown["unexpected"] = serde_json::json!(true);
    assert!(serde_json::from_value::<PluginPermissionDecisionEventV2>(unknown).is_err());
    let mut unknown_binding = wire.clone();
    unknown_binding["body"]["binding"]["unexpected"] = serde_json::json!(true);
    assert!(serde_json::from_value::<PluginPermissionDecisionEventV2>(unknown_binding).is_err());
    let mut future = wire;
    future["schema_version"] = serde_json::json!(3);
    assert!(serde_json::from_value::<PluginPermissionDecisionEventV2>(future).is_err());
}

#[test]
fn legacy_digest_only_decisions_replay_with_no_projection_and_keep_existing_authorization() {
    let plan = plan("host.bundled", 'a');
    let key = PluginPermissionDecisionKeyV2::from_plan(&plan);
    let mut source = PluginPermissionDecisionFoldV2::new(key.clone());
    let current = approve(&mut source, &plan, "legacy-approve", 0);
    let mut wire = serde_json::to_value(current).unwrap();
    wire["body"]["kind"] = serde_json::json!("decision_recorded");
    wire["body"]
        .as_object_mut()
        .unwrap()
        .remove("review_projection");
    let legacy: PluginPermissionDecisionEventV2 = serde_json::from_value(wire).unwrap();

    assert!(matches!(
        legacy.body(),
        PluginPermissionDecisionEventBodyV2::DecisionRecorded { .. }
    ));
    let mut replay = PluginPermissionDecisionFoldV2::new(key);
    apply_plugin_permission_decision_event(&mut replay, &legacy).unwrap();
    assert_eq!(replay.state().reviewed_projection(), None);
    let retried = apply_plugin_permission_decision_request(
        &mut replay,
        PluginPermissionDecisionRequestV2::decide(
            request_id("legacy-approve"),
            0,
            &plan,
            PluginPermissionDecisionV2::Approve,
        ),
    )
    .unwrap();
    assert_eq!(
        retried.disposition(),
        PluginPermissionDecisionEventDispositionV2::ExactReplay
    );
    assert!(matches!(
        retried.event().body(),
        PluginPermissionDecisionEventBodyV2::DecisionRecorded { .. }
    ));
    assert_eq!(retried.state().reviewed_projection(), None);
    enable(&mut replay, &plan, "legacy-enable", 1);
    assert_eq!(
        replay.state().enablement(),
        PluginPermissionEnablementV2::Enabled
    );
    evaluate_plugin_permission_execution(
        replay.state(),
        &plan,
        &PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
        "operations",
        "list",
    )
    .unwrap();
}

#[test]
fn reviewed_decisions_require_a_projection_bound_to_the_same_plan_digest() {
    let reviewed_plan = plan("host.bundled", 'a');
    let changed = plan("host.replacement", 'a');
    let mut source = PluginPermissionDecisionFoldV2::new(PluginPermissionDecisionKeyV2::from_plan(
        &reviewed_plan,
    ));
    let event = approve(&mut source, &reviewed_plan, "reviewed-approve", 0);
    let wire = serde_json::to_value(event).unwrap();

    let mut missing = wire.clone();
    missing["body"]
        .as_object_mut()
        .unwrap()
        .remove("review_projection");
    assert!(serde_json::from_value::<PluginPermissionDecisionEventV2>(missing).is_err());

    let mut mismatched = wire;
    mismatched["body"]["review_projection"] =
        serde_json::to_value(changed.review_projection()).unwrap();
    assert!(serde_json::from_value::<PluginPermissionDecisionEventV2>(mismatched).is_err());

    let mut malformed = serde_json::to_value(reviewed_plan.review_projection()).unwrap();
    malformed["projection_digest"] = serde_json::json!(format!("sha256:{}", "f".repeat(64)));
    let mut malformed_source = PluginPermissionDecisionFoldV2::new(
        PluginPermissionDecisionKeyV2::from_plan(&reviewed_plan),
    );
    let mut malformed_event = serde_json::to_value(approve(
        &mut malformed_source,
        &reviewed_plan,
        "malformed-projection",
        0,
    ))
    .unwrap();
    malformed_event["body"]["review_projection"] = malformed;
    assert!(serde_json::from_value::<PluginPermissionDecisionEventV2>(malformed_event).is_err());
}

#[test]
fn revision_gaps_and_overflowing_persisted_events_fail_closed() {
    let plan = plan("host.bundled", 'a');
    let key = PluginPermissionDecisionKeyV2::from_plan(&plan);
    let mut source = PluginPermissionDecisionFoldV2::new(key.clone());
    let first = approve(&mut source, &plan, "approve-1", 0);
    let second = enable(&mut source, &plan, "enable-1", 1);

    let mut gap_wire = serde_json::to_value(&second).unwrap();
    gap_wire["expected_record_revision"] = serde_json::json!("2");
    gap_wire["record_revision"] = serde_json::json!("3");
    let gap: PluginPermissionDecisionEventV2 = serde_json::from_value(gap_wire).unwrap();
    let mut replay = PluginPermissionDecisionFoldV2::new(key);
    apply_plugin_permission_decision_event(&mut replay, &first).unwrap();
    assert!(matches!(
        apply_plugin_permission_decision_event(&mut replay, &gap),
        Err(PluginPermissionDecisionErrorV2::RecordRevisionConflict {
            expected: 2,
            actual: 1
        })
    ));

    let mut overflow = serde_json::to_value(first).unwrap();
    overflow["expected_record_revision"] = serde_json::json!(u64::MAX.to_string());
    overflow["record_revision"] = serde_json::json!("0");
    assert!(serde_json::from_value::<PluginPermissionDecisionEventV2>(overflow).is_err());
}

#[test]
fn unknown_operation_parameter_and_value_never_receive_a_lease() {
    let plan = plan("host.bundled", 'a');
    let mut fold =
        PluginPermissionDecisionFoldV2::new(PluginPermissionDecisionKeyV2::from_plan(&plan));
    approve(&mut fold, &plan, "approve-1", 0);
    enable(&mut fold, &plan, "enable-1", 1);
    let kind = PermissionKindIdV2::new("dure.issue-tracker.read").unwrap();
    assert!(matches!(
        evaluate_plugin_permission_execution(fold.state(), &plan, &kind, "operations", "delete"),
        Err(PluginPermissionExecutionErrorV2::PermissionValueNotGranted { .. })
    ));
    assert!(matches!(
        evaluate_plugin_permission_execution(fold.state(), &plan, &kind, "unknown", "list"),
        Err(PluginPermissionExecutionErrorV2::PermissionParameterNotGranted { .. })
    ));
}

#[test]
fn fold_checkpoint_preserves_state_counters_content_addressed_replay_and_leases() {
    let first_plan = plan("host.bundled", 'a');
    let current_plan = plan("host.replacement", 'a');
    assert_eq!(
        PluginPermissionDecisionKeyV2::from_plan(&first_plan),
        PluginPermissionDecisionKeyV2::from_plan(&current_plan)
    );
    assert_ne!(first_plan.digest(), current_plan.digest());

    let key = PluginPermissionDecisionKeyV2::from_plan(&first_plan);
    let mut source = PluginPermissionDecisionFoldV2::new(key.clone());
    let first_decision = approve(&mut source, &first_plan, "approve-old", 0);
    enable(&mut source, &first_plan, "enable-old", 1);
    approve(&mut source, &current_plan, "approve-current", 2);
    enable(&mut source, &current_plan, "enable-current", 3);
    let lease = evaluate_plugin_permission_execution(
        source.state(),
        &current_plan,
        &PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
        "operations",
        "show",
    )
    .unwrap();

    let checkpoint = source.checkpoint().unwrap();
    assert_eq!(checkpoint.record_revision(), 4);
    assert_eq!(checkpoint.decision_revision(), 2);
    assert_eq!(checkpoint.enablement_epoch(), 4);
    assert_eq!(checkpoint.observed_event_count(), 4);
    assert_eq!(checkpoint.replay_receipts().len(), 4);
    assert_eq!(checkpoint.explicit_enabled_to_disabled_event_count(), 0);
    assert_eq!(
        checkpoint.reviewed_projection(),
        Some(current_plan.review_projection())
    );
    assert!(matches!(
        checkpoint.replay_receipts()[0].body(),
        PluginPermissionDecisionReplayBodyV2::DecisionRecordedWithReview {
            binding,
            review_projection_digest,
            ..
        } if binding.plan_digest() == first_plan.digest()
            && review_projection_digest == first_plan.review_projection().digest()
    ));

    let wire = serde_json::to_value(&checkpoint).unwrap();
    assert!(wire["state"]["decision"].get("review_projection").is_some());
    for receipt in wire["replay_receipts"].as_array().unwrap() {
        assert!(receipt["body"].get("review_projection").is_none());
    }

    let decoded: PluginPermissionDecisionFoldCheckpointV2 = serde_json::from_value(wire).unwrap();
    let mut restored = PluginPermissionDecisionFoldV2::from_checkpoint(&decoded).unwrap();
    assert_eq!(restored.state(), source.state());
    assert_eq!(restored.observed_event_count(), 4);
    assert_eq!(restored.prior_request_count(), 4);
    assert_eq!(restored.prior_request_metadata().len(), 4);
    assert!(
        restored
            .prior_request_metadata_for(&request_id("approve-old"))
            .is_some()
    );
    revalidate_plugin_permission_execution_lease(&lease, restored.state(), &current_plan).unwrap();

    let retried = apply_plugin_permission_decision_request(
        &mut restored,
        PluginPermissionDecisionRequestV2::decide(
            request_id("approve-old"),
            0,
            &first_plan,
            PluginPermissionDecisionV2::Approve,
        ),
    )
    .unwrap();
    assert_eq!(
        retried.disposition(),
        PluginPermissionDecisionEventDispositionV2::ExactReplay
    );
    assert_eq!(retried.event(), &first_decision);
    assert!(retried.event_to_append().is_none());
    assert_eq!(restored.observed_event_count(), 4);

    assert!(matches!(
        apply_plugin_permission_decision_request(
            &mut restored,
            PluginPermissionDecisionRequestV2::decide(
                request_id("approve-old"),
                0,
                &current_plan,
                PluginPermissionDecisionV2::Approve,
            ),
        ),
        Err(PluginPermissionDecisionErrorV2::DuplicateRequestConflict { .. })
    ));
    assert_eq!(
        apply_plugin_permission_decision_event(&mut restored, &first_decision)
            .unwrap()
            .disposition(),
        PluginPermissionDecisionEventDispositionV2::ExactReplay
    );
    assert_eq!(restored.observed_event_count(), 5);
    assert!(matches!(
        restored.checkpoint(),
        Err(
            PluginPermissionDecisionErrorV2::InvalidCheckpointObservedEventCount {
                observed: 5,
                recorded: 4,
            }
        )
    ));

    apply_plugin_permission_decision_request(
        &mut restored,
        PluginPermissionDecisionRequestV2::disable(request_id("disable-next"), 4, key),
    )
    .unwrap();
    assert_eq!(restored.state().record_revision(), 5);
    assert_eq!(restored.state().decision_revision(), 2);
    assert_eq!(restored.state().enablement_epoch(), 5);
    assert!(matches!(
        revalidate_plugin_permission_execution_lease(&lease, restored.state(), &current_plan),
        Err(PluginPermissionExecutionErrorV2::StaleLease)
    ));
}

#[test]
fn fold_checkpoint_preserves_legacy_digest_only_replay_without_inventing_projection() {
    let plan = plan("host.bundled", 'a');
    let key = PluginPermissionDecisionKeyV2::from_plan(&plan);
    let mut event_source = PluginPermissionDecisionFoldV2::new(key.clone());
    let reviewed = approve(&mut event_source, &plan, "legacy-approve", 0);
    let mut legacy_wire = serde_json::to_value(reviewed).unwrap();
    legacy_wire["body"]["kind"] = serde_json::json!("decision_recorded");
    legacy_wire["body"]
        .as_object_mut()
        .unwrap()
        .remove("review_projection");
    let legacy: PluginPermissionDecisionEventV2 = serde_json::from_value(legacy_wire).unwrap();

    let mut source = PluginPermissionDecisionFoldV2::new(key);
    apply_plugin_permission_decision_event(&mut source, &legacy).unwrap();
    let checkpoint = checkpoint_round_trip(&source);
    assert_eq!(checkpoint.reviewed_projection(), None);
    assert!(matches!(
        checkpoint.replay_receipts()[0].body(),
        PluginPermissionDecisionReplayBodyV2::DecisionRecorded { .. }
    ));

    let mut restored = PluginPermissionDecisionFoldV2::from_checkpoint(&checkpoint).unwrap();
    assert_eq!(restored.state().reviewed_projection(), None);
    let replay = apply_plugin_permission_decision_request(
        &mut restored,
        PluginPermissionDecisionRequestV2::decide(
            request_id("legacy-approve"),
            0,
            &plan,
            PluginPermissionDecisionV2::Approve,
        ),
    )
    .unwrap();
    assert_eq!(
        replay.disposition(),
        PluginPermissionDecisionEventDispositionV2::ExactReplay
    );
    assert_eq!(replay.event(), &legacy);
    assert!(matches!(
        replay.event().body(),
        PluginPermissionDecisionEventBodyV2::DecisionRecorded { .. }
    ));
    assert_eq!(replay.state().reviewed_projection(), None);
}

#[test]
fn hostile_fold_checkpoints_fail_closed_before_private_state_is_restored() {
    let plan = plan("host.bundled", 'a');
    let empty =
        PluginPermissionDecisionFoldV2::new(PluginPermissionDecisionKeyV2::from_plan(&plan));
    let mut unexplained_observation = serde_json::to_value(empty.checkpoint().unwrap()).unwrap();
    unexplained_observation["observed_event_count"] = serde_json::json!("1");
    assert!(
        serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(unexplained_observation)
            .is_err()
    );

    let mut source =
        PluginPermissionDecisionFoldV2::new(PluginPermissionDecisionKeyV2::from_plan(&plan));
    approve(&mut source, &plan, "approve-1", 0);
    enable(&mut source, &plan, "enable-1", 1);
    let valid = serde_json::to_value(source.checkpoint().unwrap()).unwrap();

    let mut future = valid.clone();
    future["schema_version"] = serde_json::json!(3);
    assert!(serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(future).is_err());

    let mut unknown = valid.clone();
    unknown["unexpected"] = serde_json::json!(true);
    assert!(serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(unknown).is_err());

    let mut unknown_state = valid.clone();
    unknown_state["state"]["unexpected"] = serde_json::json!(true);
    assert!(
        serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(unknown_state).is_err()
    );

    let mut unknown_receipt = valid.clone();
    unknown_receipt["replay_receipts"][0]["unexpected"] = serde_json::json!(true);
    assert!(
        serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(unknown_receipt)
            .is_err()
    );

    let mut missing_state = valid.clone();
    missing_state["state"]
        .as_object_mut()
        .unwrap()
        .remove("decision");
    assert!(
        serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(missing_state).is_err()
    );

    let mut non_canonical_count = valid.clone();
    non_canonical_count["observed_event_count"] = serde_json::json!("02");
    assert!(
        serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(non_canonical_count)
            .is_err()
    );

    let mut duplicate_request = valid.clone();
    duplicate_request["replay_receipts"][1]["request_id"] =
        duplicate_request["replay_receipts"][0]["request_id"].clone();
    assert!(
        serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(duplicate_request)
            .is_err()
    );

    let mut reordered = valid.clone();
    reordered["replay_receipts"]
        .as_array_mut()
        .unwrap()
        .swap(0, 1);
    assert!(serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(reordered).is_err());

    let mut bad_decision_counter = valid.clone();
    bad_decision_counter["replay_receipts"][1]["decision_revision"] = serde_json::json!("2");
    assert!(
        serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(bad_decision_counter)
            .is_err()
    );

    let mut bad_epoch = valid.clone();
    bad_epoch["replay_receipts"][1]["enablement_epoch"] = serde_json::json!("3");
    assert!(serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(bad_epoch).is_err());

    let mut bad_state_counter = valid.clone();
    bad_state_counter["state"]["record_revision"] = serde_json::json!("3");
    assert!(
        serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(bad_state_counter)
            .is_err()
    );

    let mut wrong_key = valid.clone();
    wrong_key["state"]["key"] = serde_json::to_value(PluginPermissionDecisionKeyV2::from_plan(
        &self::plan("host.bundled", 'b'),
    ))
    .unwrap();
    assert!(serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(wrong_key).is_err());

    let mut bad_projection_identity = valid.clone();
    bad_projection_identity["replay_receipts"][0]["body"]["review_projection_digest"] =
        serde_json::json!(format!("sha256:{}", "f".repeat(64)));
    assert!(
        serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(bad_projection_identity)
            .is_err()
    );

    let mut wrong_current_projection = valid.clone();
    wrong_current_projection["state"]["decision"]["review_projection"] =
        serde_json::to_value(self::plan("host.replacement", 'a').review_projection()).unwrap();
    assert!(
        serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(
            wrong_current_projection
        )
        .is_err()
    );

    let mut bad_transition_flag = valid.clone();
    bad_transition_flag["replay_receipts"][0]["explicit_enabled_to_disabled"] =
        serde_json::json!(true);
    assert!(
        serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(bad_transition_flag)
            .is_err()
    );

    let mut oversized = valid.clone();
    oversized["replay_receipts"] = serde_json::Value::Array(vec![
        valid["replay_receipts"][0]
            .clone();
        MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2
            + 1
    ]);
    oversized["observed_event_count"] = serde_json::json!(
        (MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2 + 1).to_string()
    );
    assert!(serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(oversized).is_err());

    let mut wrong_current_enablement = valid;
    wrong_current_enablement["state"]["enablement"] = serde_json::json!("disabled");
    assert!(
        serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(
            wrong_current_enablement
        )
        .is_err()
    );
}

#[test]
fn fold_checkpoint_keeps_lifetime_capacity_and_exact_emergency_disable_reserve() {
    let plan = plan("host.bundled", 'a');
    let key = PluginPermissionDecisionKeyV2::from_plan(&plan);
    let mut fold = PluginPermissionDecisionFoldV2::new(key.clone());
    approve(&mut fold, &plan, "approve-1", 0);
    for revision in 1..(MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2 - 1) {
        apply_plugin_permission_decision_request(
            &mut fold,
            PluginPermissionDecisionRequestV2::disable(
                request_id(&format!("regular-disable-{revision}")),
                revision as u64,
                key.clone(),
            ),
        )
        .unwrap();
    }
    enable(
        &mut fold,
        &plan,
        "enable-at-regular-limit",
        (MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2 - 1) as u64,
    );
    assert_eq!(
        fold.observed_event_count(),
        MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2
    );
    assert_eq!(
        fold.prior_request_count(),
        MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2
    );
    let regular_checkpoint = checkpoint_round_trip(&fold);
    assert_eq!(
        regular_checkpoint.observed_event_count(),
        MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2
    );

    let mut forged_reserve_count = serde_json::to_value(&regular_checkpoint).unwrap();
    forged_reserve_count["observed_event_count"] = serde_json::json!(
        MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2.to_string()
    );
    assert!(
        serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(forged_reserve_count)
            .is_err()
    );

    let disable = apply_plugin_permission_decision_request(
        &mut fold,
        PluginPermissionDecisionRequestV2::disable(
            request_id("emergency-disable"),
            MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2 as u64,
            key.clone(),
        ),
    )
    .unwrap()
    .into_event();
    assert_eq!(
        fold.observed_event_count(),
        MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2
    );
    assert_eq!(
        fold.prior_request_count(),
        MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2
    );
    let checkpoint = checkpoint_round_trip(&fold);
    assert_eq!(checkpoint.explicit_enabled_to_disabled_event_count(), 1);
    assert!(
        checkpoint.replay_receipts()[MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2]
            .explicit_enabled_to_disabled()
    );

    let mut restored = PluginPermissionDecisionFoldV2::from_checkpoint(&checkpoint).unwrap();
    let replay = apply_plugin_permission_decision_request(
        &mut restored,
        PluginPermissionDecisionRequestV2::disable(
            request_id("emergency-disable"),
            MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2 as u64,
            key.clone(),
        ),
    )
    .unwrap();
    assert_eq!(
        replay.disposition(),
        PluginPermissionDecisionEventDispositionV2::ExactReplay
    );
    assert_eq!(replay.event(), &disable);
    assert_eq!(
        restored.observed_event_count(),
        MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2
    );
    assert!(matches!(
        apply_plugin_permission_decision_request(
            &mut restored,
            PluginPermissionDecisionRequestV2::disable(
                request_id("disable-again"),
                MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2 as u64,
                key,
            ),
        ),
        Err(PluginPermissionDecisionErrorV2::EventLimitExceeded)
    ));

    let mut missing_transition_proof = serde_json::to_value(checkpoint).unwrap();
    missing_transition_proof["replay_receipts"][MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2]["explicit_enabled_to_disabled"] =
        serde_json::json!(false);
    assert!(
        serde_json::from_value::<PluginPermissionDecisionFoldCheckpointV2>(
            missing_transition_proof
        )
        .is_err()
    );
}

#[test]
fn authorization_state_and_leases_are_not_generated_typescript_contracts() {
    let generated = dure_app::typescript_contracts();
    for forbidden in [
        "PluginPermissionDecisionKeyV2",
        "PluginPermissionDecisionBindingV2",
        "PluginPermissionDecisionStateV2",
        "PluginPermissionDecisionEventV2",
        "PluginPermissionDecisionFoldCheckpointV2",
        "PluginPermissionDecisionReplayReceiptV2",
        "PluginPermissionDecisionRequestV2",
        "PluginPermissionExecutionLeaseV2",
    ] {
        assert!(!generated.contains(forbidden), "generated {forbidden}");
    }
}
