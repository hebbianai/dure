use std::{collections::BTreeMap, sync::Arc};

use dure_app::{
    AgentAdapterIdV2, AgentAdapterSupportV2, ContractVersionRangeV2, ContributionDescriptorV2,
    ContributionFamilyIdV2, ContributionFamilySupportV2, ContributionIdV2, PermissionKindIdV2,
    PluginActivationEventV2, PluginBundledPermissionPackageV2, PluginHostContractV2, PluginIdV2,
    PluginPackageCandidateIdV2, PluginPackageCatalogSnapshotV2, PluginPackageRegistryV2,
    PluginPackageSourceCandidateV2, PluginPackageSourceIdV2, PluginPackageSourceRegistrationV2,
    PluginPackageSourceV2, PluginPermissionErrorV2, PluginPermissionHostPolicyV2,
    PluginPermissionKindPolicyV2, PluginPermissionParameterPolicyV2,
    PluginPermissionPlanComparisonV2, PluginPermissionPlanDigestV2, PluginPermissionReviewChangeV2,
    PluginPermissionReviewFieldV2, PluginPermissionReviewProjectionV2,
    PluginPermissionReviewSubjectV2, PluginPermissionReviewValueV2, PluginPlacementV2,
    PluginPublisherIdV2, PluginResourcePathV2, PluginVersionV2, PluginWorkspaceIdentityV2,
    canonicalize_plugin_permission_plan, compare_plugin_permission_plan_digest,
    diff_plugin_permission_review_projections,
};

fn manifest() -> dure_app::PluginManifestV2 {
    let mut manifest: dure_app::PluginManifestV2 =
        serde_json::from_str(include_str!("../../../plugins/beads/dure-plugin.json"))
            .expect("bundled Beads manifest must deserialize");
    manifest.activation.push(PluginActivationEventV2::Explicit);
    manifest
}

fn renamed_manifest() -> dure_app::PluginManifestV2 {
    let mut changed = manifest();
    changed.publisher = PluginPublisherIdV2::new("example").unwrap();
    changed.id = PluginIdV2::new("example.beads").unwrap();
    for contribution in &mut changed.contributions {
        contribution.id = ContributionIdV2::new(contribution.id.as_str().replacen(
            "dure.beads.",
            "example.beads.",
            1,
        ))
        .unwrap();
    }
    for integration in &mut changed.agent_integrations {
        integration.id = dure_app::AgentIntegrationIdV2::new(integration.id.as_str().replacen(
            "dure.beads.",
            "example.beads.",
            1,
        ))
        .unwrap();
    }
    changed
}

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

fn package_context(
    manifest: dure_app::PluginManifestV2,
    source_id: &str,
    candidate_id: &str,
    authority: &str,
) -> Result<PluginBundledPermissionPackageV2, PluginPermissionErrorV2> {
    let package = registered_package(manifest, source_id, candidate_id, Some(authority), None);
    PluginBundledPermissionPackageV2::from_registered(&package)
}

fn registered_package(
    manifest: dure_app::PluginManifestV2,
    source_id: &str,
    candidate_id: &str,
    authority: Option<&str>,
    first_resource_byte: Option<u8>,
) -> dure_app::RegisteredPluginPackageV2 {
    let plugin_id = manifest.id.clone();
    let agent_resources = manifest
        .agent_integrations
        .iter()
        .map(|integration| {
            (
                integration.id.clone(),
                BTreeMap::from([(
                    PluginResourcePathV2::new("./plugin.json").unwrap(),
                    Arc::<[u8]>::from(integration.adapter.as_str().as_bytes()),
                )]),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let resources = manifest
        .contributions
        .iter()
        .enumerate()
        .map(|(index, contribution)| {
            let bytes: Arc<[u8]> = match (index, first_resource_byte) {
                (0, Some(byte)) => Arc::from([byte]),
                _ => Arc::from(b"{}".as_slice()),
            };
            (contribution.resource.clone(), bytes)
        })
        .collect::<BTreeMap<_, _>>();
    let manifest_bytes: Arc<[u8]> = Arc::from(serde_json::to_vec(&manifest).unwrap());
    let snapshot = PluginPackageCatalogSnapshotV2::try_new_with_embedded_package(
        manifest_bytes,
        resources,
        agent_resources,
    )
    .unwrap();
    let source = FixtureSource {
        candidate_id: PluginPackageCandidateIdV2::new(candidate_id).unwrap(),
        snapshot,
    };
    let source_id = PluginPackageSourceIdV2::new(source_id).unwrap();
    let registration = match authority {
        Some(authority) => {
            PluginPackageSourceRegistrationV2::trusted_bundled(source_id, &source, authority)
                .unwrap()
        }
        None => PluginPackageSourceRegistrationV2::new(source_id, &source),
    };
    PluginPackageRegistryV2::from_sources(&[registration])
        .package(&plugin_id)
        .unwrap()
        .clone()
}

fn parameter(name: &str, required: bool, values: &[&str]) -> PluginPermissionParameterPolicyV2 {
    PluginPermissionParameterPolicyV2::try_new(
        name,
        required,
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
                true,
                &["activate", "human", "list", "ready", "show", "watch"],
            )],
        )
        .unwrap(),
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.ui.contribute").unwrap(),
            vec![parameter(
                "surfaces",
                true,
                &[
                    "agent_pane_claim_status",
                    "primary_sidebar",
                    "secondary_sidebar",
                ],
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

fn sha256(fill: char) -> String {
    format!("sha256:{}", fill.to_string().repeat(64))
}

fn workspace(fill: char) -> PluginWorkspaceIdentityV2 {
    PluginWorkspaceIdentityV2::from_host_hmac(sha256(fill)).unwrap()
}

fn plan_with(
    package: &PluginBundledPermissionPackageV2,
    host: &PluginHostContractV2,
    workspace: PluginWorkspaceIdentityV2,
    policy: &PluginPermissionHostPolicyV2,
) -> Result<dure_app::PluginPermissionPlanV2, PluginPermissionErrorV2> {
    canonicalize_plugin_permission_plan(package, host, workspace, policy)
}

fn plan(manifest: dure_app::PluginManifestV2) -> dure_app::PluginPermissionPlanV2 {
    let package =
        package_context(manifest, "host.bundled", "candidate.beads", "dure.release").unwrap();
    plan_with(&package, &host(), workspace('b'), &policy()).unwrap()
}

#[test]
fn registered_package_context_binds_manifest_provenance_and_authority_projection() {
    let first_registered = registered_package(
        manifest(),
        "host.bundled",
        "candidate.beads",
        Some("dure.release"),
        None,
    );
    let first_snapshot_sha256 = first_registered.catalog_snapshot_sha256().clone();
    let first_package = PluginBundledPermissionPackageV2::from_registered(&first_registered)
        .expect("trusted registration creates a permission package context");
    let first = plan_with(&first_package, &host(), workspace('b'), &policy()).unwrap();
    let first_wire = serde_json::to_value(&first).unwrap();
    assert_eq!(first.identity().plugin_id().as_str(), "dure.beads");
    assert_eq!(first_wire["authority"]["authority"], "dure.release");
    assert_eq!(
        first_wire["authority"]["catalog_snapshot_sha256"],
        first_snapshot_sha256.as_str()
    );
    assert_eq!(
        first.catalog_selection().source_id().as_str(),
        "host.bundled"
    );
    assert_eq!(
        first.catalog_selection().candidate_id().as_str(),
        "candidate.beads"
    );
    let untrusted = registered_package(
        manifest(),
        "host.untrusted",
        "candidate.untrusted",
        None,
        None,
    );
    assert!(matches!(
        PluginBundledPermissionPackageV2::from_registered(&untrusted),
        Err(PluginPermissionErrorV2::UntrustedPackage { .. })
    ));

    let second_package = package_context(
        renamed_manifest(),
        "host.second",
        "candidate.second",
        "example.release",
    )
    .unwrap();
    let second = plan_with(&second_package, &host(), workspace('b'), &policy()).unwrap();
    assert_eq!(second.identity().plugin_id().as_str(), "example.beads");
    assert_eq!(second.authority().authority().as_str(), "example.release");
    assert!(
        second
            .authority()
            .catalog_snapshot_sha256()
            .as_str()
            .starts_with("sha256:")
    );
    assert_eq!(
        second.catalog_selection().source_id().as_str(),
        "host.second"
    );
    assert_eq!(
        second.catalog_selection().candidate_id().as_str(),
        "candidate.second"
    );
}

#[test]
fn canonical_plan_is_invariant_to_manifest_host_and_policy_order() {
    let first_registered = registered_package(
        manifest(),
        "host.bundled",
        "candidate.beads",
        Some("dure.release"),
        None,
    );
    let first_package =
        PluginBundledPermissionPackageV2::from_registered(&first_registered).unwrap();
    let first = plan_with(&first_package, &host(), workspace('b'), &policy()).unwrap();
    let mut reordered_manifest = manifest();
    reordered_manifest.activation.reverse();
    reordered_manifest.contributions.reverse();
    reordered_manifest.agent_integrations.reverse();
    reordered_manifest.permissions.reverse();
    for permission in &mut reordered_manifest.permissions {
        for values in permission.parameters.values_mut() {
            values.reverse();
        }
    }
    let reordered_registered = registered_package(
        reordered_manifest,
        "host.bundled",
        "candidate.beads",
        Some("dure.release"),
        None,
    );
    assert_eq!(
        first_registered.catalog_snapshot_sha256(),
        reordered_registered.catalog_snapshot_sha256()
    );
    let package = PluginBundledPermissionPackageV2::from_registered(&reordered_registered).unwrap();
    let mut reordered_host = host();
    reordered_host.contribution_families.reverse();
    reordered_host.agent_adapters.reverse();
    reordered_host.permission_kinds.reverse();
    let reordered_policy = PluginPermissionHostPolicyV2::try_new(vec![
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.ui.contribute").unwrap(),
            vec![parameter(
                "surfaces",
                true,
                &[
                    "secondary_sidebar",
                    "primary_sidebar",
                    "agent_pane_claim_status",
                ],
            )],
        )
        .unwrap(),
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
            vec![parameter(
                "operations",
                true,
                &["watch", "show", "ready", "list", "human", "activate"],
            )],
        )
        .unwrap(),
    ])
    .unwrap();
    let second = plan_with(&package, &reordered_host, workspace('b'), &reordered_policy).unwrap();
    assert_eq!(first, second);
}

#[test]
fn host_negotiation_changes_plan_when_optional_capability_becomes_effective() {
    let mut optional_manifest = manifest();
    optional_manifest
        .contributions
        .push(ContributionDescriptorV2 {
            id: ContributionIdV2::new("dure.beads.optional").unwrap(),
            family: ContributionFamilyIdV2::new("dure.optional").unwrap(),
            family_api: ContractVersionRangeV2::new(1, 2),
            required: false,
            placement: PluginPlacementV2::Workspace,
            resource: PluginResourcePathV2::new("./contributions/optional.json").unwrap(),
        });
    let package = package_context(
        optional_manifest,
        "host.bundled",
        "candidate.beads",
        "dure.release",
    )
    .unwrap();
    let base = plan_with(&package, &host(), workspace('b'), &policy()).unwrap();
    assert!(
        base.ignored_optional_contributions()
            .iter()
            .any(|id| id.as_str() == "dure.beads.optional")
    );
    assert!(
        base.ignored_optional_agent_integrations()
            .iter()
            .any(|id| id.as_str() == "dure.beads.claude")
    );

    let mut expanded_host = host();
    expanded_host
        .contribution_families
        .push(ContributionFamilySupportV2 {
            family: ContributionFamilyIdV2::new("dure.optional").unwrap(),
            api: ContractVersionRangeV2::new(1, 2),
        });
    expanded_host.agent_adapters.push(AgentAdapterSupportV2 {
        adapter: AgentAdapterIdV2::new("claude").unwrap(),
    });
    let expanded = plan_with(&package, &expanded_host, workspace('b'), &policy()).unwrap();
    assert_ne!(base.digest(), expanded.digest());
    let optional = expanded
        .contributions()
        .iter()
        .find(|contribution| contribution.id().as_str() == "dure.beads.optional")
        .unwrap();
    assert_eq!(optional.family_api_version(), 2);
    assert_eq!(optional.placement(), &PluginPlacementV2::Workspace);
    assert_eq!(
        optional.resource().as_str(),
        "./contributions/optional.json"
    );
    assert!(
        expanded
            .agent_integrations()
            .iter()
            .any(|integration| integration.id.as_str() == "dure.beads.claude")
    );

    let mut older_host = expanded_host;
    older_host.host_api = ContractVersionRangeV2::new(1, 1);
    let older = plan_with(&package, &older_host, workspace('b'), &policy()).unwrap();
    assert_eq!(older.negotiated_host_api_version(), 1);
    assert_ne!(older.digest(), expanded.digest());
}

#[test]
fn every_review_identity_and_effective_scope_change_changes_digest() {
    let base = plan(manifest());
    let assert_changed = |changed: dure_app::PluginPermissionPlanV2| {
        assert_ne!(base.digest(), changed.digest());
        assert_eq!(
            compare_plugin_permission_plan_digest(&changed, Some(base.digest())),
            PluginPermissionPlanComparisonV2::ChangedSinceReview
        );
    };
    for (source, candidate, authority, workspace_digest) in [
        ("host.other", "candidate.beads", "dure.release", 'b'),
        ("host.bundled", "candidate.other", "dure.release", 'b'),
        ("host.bundled", "candidate.beads", "dure.other-release", 'b'),
        ("host.bundled", "candidate.beads", "dure.release", 'd'),
    ] {
        let package = package_context(manifest(), source, candidate, authority).unwrap();
        assert_changed(
            plan_with(&package, &host(), workspace(workspace_digest), &policy()).unwrap(),
        );
    }

    let changed_bytes = registered_package(
        manifest(),
        "host.bundled",
        "candidate.beads",
        Some("dure.release"),
        Some(b'x'),
    );
    assert_ne!(
        base.authority().catalog_snapshot_sha256(),
        changed_bytes.catalog_snapshot_sha256()
    );
    let changed_bytes = PluginBundledPermissionPackageV2::from_registered(&changed_bytes).unwrap();
    assert_changed(plan_with(&changed_bytes, &host(), workspace('b'), &policy()).unwrap());

    let mut changed_version = manifest();
    let distinct_version = match changed_version.version.as_str() {
        "0.0.0-review-change" => "0.0.1-review-change",
        _ => "0.0.0-review-change",
    };
    changed_version.version = PluginVersionV2::new(distinct_version).unwrap();
    assert_changed(plan(changed_version));
    assert_changed(plan(renamed_manifest()));

    let mut changed_permission = manifest();
    changed_permission.permissions[0]
        .parameters
        .get_mut("operations")
        .unwrap()
        .retain(|value| value != "watch");
    assert_changed(plan(changed_permission));

    let mut changed_placement = manifest();
    changed_placement.contributions[0].placement = PluginPlacementV2::Either;
    assert_changed(plan(changed_placement));

    let mut changed_resource = manifest();
    changed_resource.contributions[0].resource =
        PluginResourcePathV2::new("./contributions/issue-tracker-v2.json").unwrap();
    assert_changed(plan(changed_resource));

    let mut changed_integration = manifest();
    changed_integration.agent_integrations[0].resource =
        PluginResourcePathV2::new("./agents/codex-v2").unwrap();
    assert_changed(plan(changed_integration));

    let mut changed_activation = manifest();
    changed_activation.activation = vec![PluginActivationEventV2::WorkspaceContains {
        pattern: ".beads-v2".to_owned(),
    }];
    assert_changed(plan(changed_activation));
}

#[test]
fn applied_policy_digest_ignores_unused_expansion_but_rejects_requested_scope_removal() {
    let package = package_context(
        manifest(),
        "host.bundled",
        "candidate.beads",
        "dure.release",
    )
    .unwrap();
    let base = plan_with(&package, &host(), workspace('b'), &policy()).unwrap();

    let expanded = PluginPermissionHostPolicyV2::try_new(vec![
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
            vec![parameter(
                "operations",
                true,
                &[
                    "activate", "audit", "human", "list", "ready", "show", "watch",
                ],
            )],
        )
        .unwrap(),
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.ui.contribute").unwrap(),
            vec![
                parameter(
                    "surfaces",
                    true,
                    &[
                        "agent_pane_claim_status",
                        "primary_sidebar",
                        "secondary_sidebar",
                    ],
                ),
                parameter("unused_optional", false, &["new_value"]),
            ],
        )
        .unwrap(),
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.unrequested").unwrap(),
            vec![parameter("scope", true, &["all"])],
        )
        .unwrap(),
    ])
    .unwrap();
    let expanded_plan = plan_with(&package, &host(), workspace('b'), &expanded).unwrap();
    assert_eq!(base, expanded_plan);

    let removed_requested_value = PluginPermissionHostPolicyV2::try_new(vec![
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
            vec![parameter(
                "operations",
                true,
                &["activate", "human", "list", "ready", "show"],
            )],
        )
        .unwrap(),
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.ui.contribute").unwrap(),
            vec![parameter(
                "surfaces",
                true,
                &["agent_pane_claim_status", "primary_sidebar"],
            )],
        )
        .unwrap(),
    ])
    .unwrap();
    assert!(matches!(
        plan_with(&package, &host(), workspace('b'), &removed_requested_value),
        Err(PluginPermissionErrorV2::UnknownPermissionParameterValue { .. })
    ));

    let new_required_parameter = PluginPermissionHostPolicyV2::try_new(vec![
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
            vec![
                parameter(
                    "operations",
                    true,
                    &["activate", "human", "list", "ready", "show", "watch"],
                ),
                parameter("scope", true, &["workspace"]),
            ],
        )
        .unwrap(),
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.ui.contribute").unwrap(),
            vec![parameter(
                "surfaces",
                true,
                &["agent_pane_claim_status", "primary_sidebar"],
            )],
        )
        .unwrap(),
    ])
    .unwrap();
    assert!(matches!(
        plan_with(&package, &host(), workspace('b'), &new_required_parameter),
        Err(PluginPermissionErrorV2::MissingRequiredPermissionParameter { .. })
    ));
}

#[test]
fn review_projection_is_strict_bounded_and_hidden_from_the_plan_wire() {
    let plan = plan(manifest());
    let projection = plan.review_projection();
    projection.validate_binding(plan.digest()).unwrap();
    assert_eq!(projection.plan_digest(), plan.digest());
    assert!(serde_json::to_vec(projection).unwrap().len() <= 8 * 1024);
    assert_eq!(
        serde_json::from_value::<PluginPermissionReviewProjectionV2>(
            serde_json::to_value(projection).unwrap()
        )
        .unwrap(),
        projection.clone()
    );

    let plan_wire = serde_json::to_value(&plan).unwrap();
    assert!(plan_wire.get("review_projection").is_none());
    assert!(plan_wire.get("review_projection_digest").is_none());

    let has_required_preimage = projection.entries().iter().any(|entry| {
        entry.subject() == PluginPermissionReviewSubjectV2::Permission
            && entry.field() == PluginPermissionReviewFieldV2::Required
            && matches!(
                entry.value(),
                PluginPermissionReviewValueV2::Boolean { value: true }
            )
    });
    let has_granted_values = projection.entries().iter().any(|entry| {
        entry.subject() == PluginPermissionReviewSubjectV2::Permission
            && entry.field() == PluginPermissionReviewFieldV2::GrantedValues
            && matches!(
                entry.value(),
                PluginPermissionReviewValueV2::StringList { values }
                    if values.iter().any(|value| value == "watch")
            )
    });
    let resource_fingerprints = projection
        .entries()
        .iter()
        .filter(|entry| {
            entry.subject() == PluginPermissionReviewSubjectV2::CatalogResource
                && entry.field() == PluginPermissionReviewFieldV2::ContentSha256
        })
        .count();
    assert!(has_required_preimage);
    assert!(has_granted_values);
    assert_eq!(resource_fingerprints, 3);

    let mut unknown = serde_json::to_value(projection).unwrap();
    unknown["unexpected"] = serde_json::json!(true);
    assert!(serde_json::from_value::<PluginPermissionReviewProjectionV2>(unknown).is_err());

    let mut reordered = serde_json::to_value(projection).unwrap();
    reordered["entries"].as_array_mut().unwrap().reverse();
    assert!(serde_json::from_value::<PluginPermissionReviewProjectionV2>(reordered).is_err());

    let mut mutated = serde_json::to_value(projection).unwrap();
    let string_entry = mutated["entries"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["value"]["kind"] == "string")
        .unwrap();
    string_entry["value"]["value"] = serde_json::json!("changed");
    assert!(serde_json::from_value::<PluginPermissionReviewProjectionV2>(mutated).is_err());

    let other_digest = PluginPermissionPlanDigestV2::new(sha256('f')).unwrap();
    assert!(projection.validate_binding(&other_digest).is_err());
}

#[test]
fn review_diff_exposes_applied_policy_preimages_and_catalog_fingerprint_fidelity() {
    let package = package_context(
        manifest(),
        "host.bundled",
        "candidate.beads",
        "dure.release",
    )
    .unwrap();
    let base = plan_with(&package, &host(), workspace('b'), &policy()).unwrap();
    let changed_policy = PluginPermissionHostPolicyV2::try_new(vec![
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
            vec![parameter(
                "operations",
                false,
                &["activate", "human", "list", "ready", "show", "watch"],
            )],
        )
        .unwrap(),
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.ui.contribute").unwrap(),
            vec![parameter(
                "surfaces",
                true,
                &[
                    "agent_pane_claim_status",
                    "primary_sidebar",
                    "secondary_sidebar",
                ],
            )],
        )
        .unwrap(),
    ])
    .unwrap();
    let changed = plan_with(&package, &host(), workspace('b'), &changed_policy).unwrap();
    let policy_diff = diff_plugin_permission_review_projections(
        base.review_projection(),
        changed.review_projection(),
    );
    assert!(!policy_diff.catalog_snapshot_fingerprint_only());
    assert!(policy_diff.changes().iter().any(|change| {
        matches!(
            change,
            PluginPermissionReviewChangeV2::Changed { reviewed, current }
                if reviewed.field() == PluginPermissionReviewFieldV2::Required
                    && matches!(reviewed.value(), PluginPermissionReviewValueV2::Boolean { value: true })
                    && matches!(current.value(), PluginPermissionReviewValueV2::Boolean { value: false })
        )
    }));

    let mut display_only_manifest = manifest();
    display_only_manifest.display_name = "Beads renamed for display".to_owned();
    let display_only = plan(display_only_manifest);
    let display_diff = diff_plugin_permission_review_projections(
        base.review_projection(),
        display_only.review_projection(),
    );
    assert!(display_diff.catalog_snapshot_fingerprint_only());
    assert_eq!(display_diff.changes().len(), 1);

    let changed_resource = registered_package(
        manifest(),
        "host.bundled",
        "candidate.beads",
        Some("dure.release"),
        Some(b'x'),
    );
    let changed_resource =
        PluginBundledPermissionPackageV2::from_registered(&changed_resource).unwrap();
    let changed_resource =
        plan_with(&changed_resource, &host(), workspace('b'), &policy()).unwrap();
    let resource_diff = diff_plugin_permission_review_projections(
        base.review_projection(),
        changed_resource.review_projection(),
    );
    assert!(!resource_diff.catalog_snapshot_fingerprint_only());
    assert!(resource_diff.changes().iter().any(|change| match change {
        PluginPermissionReviewChangeV2::Changed { reviewed, current } => {
            reviewed.field() == PluginPermissionReviewFieldV2::ContentSha256
                && current.field() == PluginPermissionReviewFieldV2::ContentSha256
        }
        _ => false,
    }));
}

#[test]
fn malformed_host_inputs_and_policy_fail_closed() {
    for invalid in [
        "workspace-path",
        "sha256:abc",
        &format!("sha256:{}", "A".repeat(64)),
    ] {
        assert!(PluginWorkspaceIdentityV2::from_host_hmac(invalid).is_err());
    }
    assert!(PluginPermissionPlanDigestV2::new("bad-digest").is_err());

    assert!(
        PluginPermissionParameterPolicyV2::try_new(
            "operations",
            true,
            vec!["list".to_owned(), "list".to_owned()],
        )
        .is_err()
    );
    let duplicate_parameter = parameter("operations", true, &["list"]);
    assert!(
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
            vec![duplicate_parameter.clone(), duplicate_parameter],
        )
        .is_err()
    );
    let duplicate_kind = PluginPermissionKindPolicyV2::try_new(
        PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
        vec![parameter("operations", true, &["list"])],
    )
    .unwrap();
    assert!(
        PluginPermissionHostPolicyV2::try_new(vec![duplicate_kind.clone(), duplicate_kind])
            .is_err()
    );

    let mut oversized_projection_manifest = manifest();
    oversized_projection_manifest
        .activation
        .extend(
            (0..80).map(|index| PluginActivationEventV2::WorkspaceContains {
                pattern: format!("fixture-{index:03}-{}", "x".repeat(80)),
            }),
        );
    let oversized_package = package_context(
        oversized_projection_manifest,
        "host.bundled",
        "candidate.beads",
        "dure.release",
    )
    .unwrap();
    assert!(matches!(
        plan_with(&oversized_package, &host(), workspace('b'), &policy()),
        Err(PluginPermissionErrorV2::ReviewProjectionLimitExceeded { .. })
    ));

    let requested_values = (0..129)
        .map(|index| format!("operation-{index:03}"))
        .collect::<Vec<_>>();
    let mut too_many_values_manifest = manifest();
    too_many_values_manifest.permissions[0]
        .parameters
        .insert("operations".to_owned(), requested_values.clone());
    let too_many_values_package = package_context(
        too_many_values_manifest,
        "host.bundled",
        "candidate.beads",
        "dure.release",
    )
    .unwrap();
    let too_many_values_policy = PluginPermissionHostPolicyV2::try_new(vec![
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.issue-tracker.read").unwrap(),
            vec![
                PluginPermissionParameterPolicyV2::try_new("operations", true, requested_values)
                    .unwrap(),
            ],
        )
        .unwrap(),
        PluginPermissionKindPolicyV2::try_new(
            PermissionKindIdV2::new("dure.ui.contribute").unwrap(),
            vec![parameter(
                "surfaces",
                true,
                &[
                    "agent_pane_claim_status",
                    "primary_sidebar",
                    "secondary_sidebar",
                ],
            )],
        )
        .unwrap(),
    ])
    .unwrap();
    assert!(matches!(
        plan_with(
            &too_many_values_package,
            &host(),
            workspace('b'),
            &too_many_values_policy,
        ),
        Err(PluginPermissionErrorV2::ReviewProjectionLimitExceeded { .. })
    ));
}

#[test]
fn digest_comparison_is_neutral_and_wire_has_no_authorization_or_context_input() {
    let plan = plan(manifest());
    assert_eq!(
        compare_plugin_permission_plan_digest(&plan, None),
        PluginPermissionPlanComparisonV2::NoReviewedPlan
    );
    assert_eq!(
        compare_plugin_permission_plan_digest(&plan, Some(plan.digest())),
        PluginPermissionPlanComparisonV2::MatchesReviewedPlan
    );
    let other = PluginPermissionPlanDigestV2::new(sha256('f')).unwrap();
    assert_eq!(
        compare_plugin_permission_plan_digest(&plan, Some(&other)),
        PluginPermissionPlanComparisonV2::ChangedSinceReview
    );

    let generated = include_str!("../../../src/contracts/generated/extensionContracts.ts");
    assert!(!generated.contains("catalog_revision"));
    assert!(!generated.contains("package_sha256"));
    assert!(!generated.contains("PluginBundledPermissionPackageV2"));
    assert!(!generated.contains("PluginPermissionHostPolicyV2"));
    assert!(!generated.contains("PluginPermissionGrant"));
    assert!(!generated.contains("PluginPermissionDecision"));
    assert!(!generated.contains("PluginSignerSha256V2"));
    assert!(generated.contains("catalog_snapshot_sha256"));
}

#[test]
fn package_context_and_snapshot_digest_have_no_raw_constructors() {
    let permission_source = include_str!("../src/plugin_permission.rs");
    let context_impl = permission_source
        .split_once("impl PluginBundledPermissionPackageV2 {")
        .expect("package context implementation must exist")
        .1
        .split_once("\n}\n\n/// Backend-only")
        .expect("package context implementation must remain non-wire")
        .0;
    assert_eq!(context_impl.matches("pub fn ").count(), 1);
    assert!(context_impl.contains("pub fn from_registered("));
    assert!(!context_impl.contains("from_trusted_host"));

    let registry_source = include_str!("../src/plugin_package_registry.rs");
    let digest_impl = registry_source
        .split_once("impl PluginCatalogSnapshotSha256V2 {")
        .expect("catalog snapshot digest implementation must exist")
        .1
        .split_once("\n}\n\n/// SHA-256 of the exact embedded package bytes")
        .expect("catalog snapshot digest must be registry-owned")
        .0;
    assert_eq!(digest_impl.matches("pub fn ").count(), 1);
    assert!(digest_impl.contains("pub fn as_str("));
    assert!(!digest_impl.contains("pub fn new("));
}
