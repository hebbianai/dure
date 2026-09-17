use std::collections::BTreeMap;

use dure_app::{
    AgentAdapterIdV2, AgentAdapterSupportV2, AgentEnvironmentTargetV2, AgentInstallScopeV2,
    AgentIntegrationEffectOwnershipV2, AgentIntegrationEffectReceiptV2,
    AgentIntegrationInstallActionV2, AgentIntegrationInstallReceiptV2, AgentIntegrationPlanErrorV2,
    AgentIntegrationUninstallActionV2, AgentProfileIdV2, AgentTargetIdV2, ContractVersionRangeV2,
    ContributionDescriptorV2, ContributionFamilyIdV2, ContributionFamilySupportV2,
    ContributionIdV2, IssueTrackerAgentBindingSourceV1, IssueTrackerOperationV1,
    IssueTrackerProviderV1, PermissionKindIdV2, PhysicalTargetKeyV2, PluginCompatibilityOutcomeV2,
    PluginHostContractV2, PluginManifestV2, PluginPlacementV2, PluginResourcePathV2, PluginViewsV1,
    negotiate_plugin_manifest, plan_agent_integration_install, plan_agent_integration_uninstall,
};

fn beads_manifest() -> PluginManifestV2 {
    serde_json::from_str(include_str!("../../../plugins/beads/dure-plugin.json"))
        .expect("bundled Beads manifest must deserialize")
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

fn target(
    id: &str,
    profile_id: &str,
    profile_root_key: &str,
    plugin_store_key: &str,
) -> AgentEnvironmentTargetV2 {
    AgentEnvironmentTargetV2 {
        id: AgentTargetIdV2::new(id).unwrap(),
        profile_id: AgentProfileIdV2::new(profile_id).unwrap(),
        adapter: AgentAdapterIdV2::new("codex").unwrap(),
        profile_root_key: PhysicalTargetKeyV2::new(profile_root_key).unwrap(),
        plugin_store_key: PhysicalTargetKeyV2::new(plugin_store_key).unwrap(),
        scope: AgentInstallScopeV2::User,
    }
}

#[test]
fn bundled_beads_manifest_is_self_contained_and_valid() {
    let manifest = beads_manifest();
    manifest.validate().unwrap();
    assert_eq!(manifest.id.as_str(), "dure.beads");
    assert_eq!(
        manifest.description.as_deref(),
        Some("Beads 패키지에는 Codex와 Claude Code 연동 플러그인이 함께 포함되어 있습니다.")
    );
    assert_eq!(manifest.contributions.len(), 3);
    assert_eq!(manifest.agent_integrations.len(), 2);

    let codex_manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../plugins/beads/agents/codex/plugins/dure-beads/.codex-plugin/plugin.json"
    ))
    .expect("bundled Codex package manifest must deserialize");
    let claude_manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../plugins/beads/agents/claude/plugins/dure-beads/.claude-plugin/plugin.json"
    ))
    .expect("bundled Claude package manifest must deserialize");
    for native_manifest in [&codex_manifest, &claude_manifest] {
        assert_eq!(native_manifest["name"], "dure-beads");
        assert_eq!(native_manifest["version"], manifest.version.as_str());
        assert_eq!(native_manifest["skills"], "./skills/");
    }

    let codex_skill = include_str!(
        "../../../plugins/beads/agents/codex/plugins/dure-beads/skills/beads/SKILL.md"
    );
    let claude_skill = include_str!(
        "../../../plugins/beads/agents/claude/plugins/dure-beads/skills/beads/SKILL.md"
    );
    assert_eq!(
        codex_skill, claude_skill,
        "native agent packages must ship the same Beads guidance"
    );

    let codex_marketplace: serde_json::Value = serde_json::from_str(include_str!(
        "../../../plugins/beads/agents/codex/.agents/plugins/marketplace.json"
    ))
    .expect("bundled Codex marketplace must deserialize");
    let claude_marketplace: serde_json::Value = serde_json::from_str(include_str!(
        "../../../plugins/beads/agents/claude/.claude-plugin/marketplace.json"
    ))
    .expect("bundled Claude marketplace must deserialize");
    for marketplace in [&codex_marketplace, &claude_marketplace] {
        assert_eq!(marketplace["name"], "dure-bundled");
        assert_eq!(marketplace["plugins"][0]["name"], "dure-beads");
    }
    assert_eq!(
        codex_marketplace["plugins"][0]["source"]["path"],
        "./plugins/dure-beads"
    );
    assert_eq!(
        claude_marketplace["plugins"][0]["source"],
        "./plugins/dure-beads"
    );
}

#[test]
fn bundled_beads_views_use_the_same_typed_contribution_contract_as_external_plugins() {
    let manifest = beads_manifest();
    let views: PluginViewsV1 = serde_json::from_str(include_str!(
        "../../../plugins/beads/contributions/views.json"
    ))
    .expect("bundled Beads views contribution must deserialize");
    views.validate_for_manifest(&manifest).unwrap();
    assert_eq!(views.containers[0].id.as_str(), "dure.beads.issues");
    assert_eq!(views.views[0].id.as_str(), "dure.beads.issues.list");
    let dure_app::PluginViewKindV1::IssueTracker {
        default_query_setting_key,
        watch_interval_setting_key,
        agent_claims,
        ..
    } = &views.views[0].kind;
    assert_eq!(
        default_query_setting_key.as_ref().map(|key| key.as_str()),
        Some("default_view")
    );
    assert_eq!(
        watch_interval_setting_key.as_ref().map(|key| key.as_str()),
        Some("watch_interval_seconds")
    );
    let agent_claims = agent_claims
        .as_ref()
        .expect("Beads view declares pane claims");
    assert_eq!(agent_claims.setting_key.as_str(), "show_agent_claims");
    assert_eq!(agent_claims.statuses, ["in_progress"]);
    assert_eq!(
        agent_claims.surfaces,
        [
            dure_app::PluginIssueTrackerAgentClaimsSurfaceV1::PrimarySidebar,
            dure_app::PluginIssueTrackerAgentClaimsSurfaceV1::AgentPaneClaimStatus,
        ]
    );
}

#[test]
fn plugin_description_is_optional_but_bounded_when_present() {
    let mut manifest = beads_manifest();
    manifest.description = None;
    manifest.validate().unwrap();

    manifest.description = Some(" ".to_owned());
    assert!(manifest.validate().is_err());

    manifest.description = Some("a".repeat(513));
    assert!(manifest.validate().is_err());
}

#[test]
fn bundled_beads_issue_tracker_declares_the_bounded_read_only_contract() {
    let provider: IssueTrackerProviderV1 = serde_json::from_str(include_str!(
        "../../../plugins/beads/contributions/issue-tracker.json"
    ))
    .expect("bundled Beads issue tracker contribution must deserialize");
    provider.validate().unwrap();
    assert_eq!(provider.provider.as_str(), "beads");
    assert_eq!(
        provider.operations,
        vec![
            IssueTrackerOperationV1::Human,
            IssueTrackerOperationV1::List,
            IssueTrackerOperationV1::Ready,
            IssueTrackerOperationV1::Show,
            IssueTrackerOperationV1::Watch,
        ]
    );
    assert_eq!(
        provider.agent_binding,
        Some(IssueTrackerAgentBindingSourceV1::ScmBranchMetadata {
            metadata_key: "dure_worktree_branch".into(),
        })
    );
}

#[test]
fn resource_paths_fail_closed_on_package_escape() {
    for invalid in [
        "\"../outside\"",
        "\"/absolute\"",
        "\"./../outside\"",
        "\"./nested/../../outside\"",
        "\".\\\\outside\"",
        "\"./C:/outside\"",
        "\"./\"",
    ] {
        assert!(
            serde_json::from_str::<PluginResourcePathV2>(invalid).is_err(),
            "{invalid} should be rejected"
        );
    }
    assert!(PluginResourcePathV2::new("./agents/codex").is_ok());
}

#[test]
fn open_family_negotiation_ignores_optional_but_rejects_required() {
    let mut manifest = beads_manifest();
    manifest.contributions.push(ContributionDescriptorV2 {
        id: ContributionIdV2::new("dure.beads.optional-view").unwrap(),
        family: ContributionFamilyIdV2::new("example.future-view").unwrap(),
        family_api: ContractVersionRangeV2::new(1, 1),
        required: false,
        placement: PluginPlacementV2::Ui,
        resource: PluginResourcePathV2::new("./contributions/optional-view.json").unwrap(),
    });

    let outcome = negotiate_plugin_manifest(&manifest, &host()).unwrap();
    match outcome {
        PluginCompatibilityOutcomeV2::Supported {
            contributions,
            ignored_optional_contributions,
            enabled_agent_integrations,
            ignored_optional_agent_integrations,
            ..
        } => {
            assert_eq!(contributions.len(), 3);
            assert_eq!(
                ignored_optional_contributions,
                vec![ContributionIdV2::new("dure.beads.optional-view").unwrap()]
            );
            assert_eq!(
                enabled_agent_integrations,
                vec![dure_app::AgentIntegrationIdV2::new("dure.beads.codex").unwrap()]
            );
            assert_eq!(
                ignored_optional_agent_integrations,
                vec![dure_app::AgentIntegrationIdV2::new("dure.beads.claude").unwrap()]
            );
        }
        other => panic!("expected supported outcome, got {other:?}"),
    }

    manifest
        .contributions
        .last_mut()
        .expect("optional contribution exists")
        .required = true;
    assert_eq!(
        negotiate_plugin_manifest(&manifest, &host()).unwrap(),
        PluginCompatibilityOutcomeV2::UnsupportedRequiredContributions {
            contributions: vec![ContributionIdV2::new("dure.beads.optional-view").unwrap()],
        }
    );
}

#[test]
fn unknown_permission_kind_is_rejected_before_activation() {
    let mut manifest = beads_manifest();
    manifest.permissions[0].kind = PermissionKindIdV2::new("unknown.permission").unwrap();
    assert_eq!(
        negotiate_plugin_manifest(&manifest, &host()).unwrap(),
        PluginCompatibilityOutcomeV2::UnsupportedPermissions {
            permissions: vec![PermissionKindIdV2::new("unknown.permission").unwrap()],
        }
    );
}

#[test]
fn install_plan_deduplicates_package_store_and_physical_profile_roots() {
    let targets = vec![
        target(
            "target.codex.a",
            "profile.codex.a",
            "root.codex.a",
            "store.codex.shared",
        ),
        target(
            "target.codex.a-alias",
            "profile.codex.a-alias",
            "root.codex.a",
            "store.codex.shared",
        ),
        target(
            "target.codex.b",
            "profile.codex.b",
            "root.codex.b",
            "store.codex.shared",
        ),
    ];
    let plan = plan_agent_integration_install(&beads_manifest(), &targets).unwrap();
    assert_eq!(plan.actions.len(), 3);
    assert_eq!(
        plan.skipped_optional_integrations,
        vec![dure_app::AgentIntegrationIdV2::new("dure.beads.claude").unwrap()]
    );

    match &plan.actions[0] {
        AgentIntegrationInstallActionV2::PreparePackage {
            plugin_store_key,
            target_ids,
            ..
        } => {
            assert_eq!(plugin_store_key.as_str(), "store.codex.shared");
            assert_eq!(target_ids.len(), 3);
        }
        other => panic!("expected one package preparation, got {other:?}"),
    }
    match &plan.actions[1] {
        AgentIntegrationInstallActionV2::RegisterProfile { target_ids, .. } => {
            assert_eq!(target_ids.len(), 2);
        }
        other => panic!("expected de-duplicated profile registration, got {other:?}"),
    }
}

#[test]
fn inconsistent_physical_target_and_missing_required_target_fail_closed() {
    let mut alias = target(
        "target.codex.alias",
        "profile.codex.alias",
        "root.codex.a",
        "store.codex.two",
    );
    alias.scope = AgentInstallScopeV2::Local;
    let inconsistent = vec![
        target(
            "target.codex.a",
            "profile.codex.a",
            "root.codex.a",
            "store.codex.one",
        ),
        alias,
    ];
    assert!(matches!(
        plan_agent_integration_install(&beads_manifest(), &inconsistent),
        Err(AgentIntegrationPlanErrorV2::InconsistentPhysicalTarget { .. })
    ));

    let mut inconsistent_scope = target(
        "target.codex.alias",
        "profile.codex.alias",
        "root.codex.a",
        "store.codex.one",
    );
    inconsistent_scope.scope = AgentInstallScopeV2::Local;
    assert!(matches!(
        plan_agent_integration_install(
            &beads_manifest(),
            &[
                target(
                    "target.codex.a",
                    "profile.codex.a",
                    "root.codex.a",
                    "store.codex.one",
                ),
                inconsistent_scope,
            ],
        ),
        Err(AgentIntegrationPlanErrorV2::InconsistentPhysicalTarget { .. })
    ));

    let mut required = beads_manifest();
    required.agent_integrations[0].required = true;
    assert!(matches!(
        plan_agent_integration_install(&required, &[]),
        Err(AgentIntegrationPlanErrorV2::RequiredTargetUnavailable { .. })
    ));
}

#[test]
fn uninstall_removes_only_effects_created_by_the_install_operation() {
    let plan = plan_agent_integration_install(
        &beads_manifest(),
        &[
            target(
                "target.codex.a",
                "profile.codex.a",
                "root.codex.a",
                "store.codex.shared",
            ),
            target(
                "target.codex.b",
                "profile.codex.b",
                "root.codex.b",
                "store.codex.shared",
            ),
        ],
    )
    .unwrap();
    let effects = plan
        .actions
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, action)| AgentIntegrationEffectReceiptV2 {
            action,
            ownership: if index == 2 {
                AgentIntegrationEffectOwnershipV2::PreexistingExternal
            } else {
                AgentIntegrationEffectOwnershipV2::CreatedByOperation
            },
        })
        .collect();
    let uninstall = plan_agent_integration_uninstall(&AgentIntegrationInstallReceiptV2 {
        plugin_id: plan.plugin_id,
        plugin_version: plan.plugin_version,
        effects,
    })
    .unwrap();

    assert_eq!(uninstall.actions.len(), 2);
    assert!(matches!(
        uninstall.actions[0],
        AgentIntegrationUninstallActionV2::UnregisterProfile { .. }
    ));
    assert!(matches!(
        uninstall.actions[1],
        AgentIntegrationUninstallActionV2::RemoveOwnedPackageIfUnleased { .. }
    ));
}

#[test]
fn uninstall_rejects_duplicate_receipt_effects() {
    let plan = plan_agent_integration_install(
        &beads_manifest(),
        &[target(
            "target.codex.a",
            "profile.codex.a",
            "root.codex.a",
            "store.codex.shared",
        )],
    )
    .unwrap();
    let effect = AgentIntegrationEffectReceiptV2 {
        action: plan.actions[0].clone(),
        ownership: AgentIntegrationEffectOwnershipV2::CreatedByOperation,
    };
    assert_eq!(
        plan_agent_integration_uninstall(&AgentIntegrationInstallReceiptV2 {
            plugin_id: plan.plugin_id,
            plugin_version: plan.plugin_version,
            effects: vec![effect.clone(), effect],
        }),
        Err(AgentIntegrationPlanErrorV2::DuplicateReceiptEffect)
    );
}

#[test]
fn permission_parameters_reject_duplicates_and_invalid_semver() {
    let mut manifest = beads_manifest();
    manifest.permissions[0].parameters = BTreeMap::from([(
        "operations".to_owned(),
        vec!["show".to_owned(), "show".to_owned()],
    )]);
    assert!(manifest.validate().is_err());

    let json = include_str!("../../../plugins/beads/dure-plugin.json")
        .replace("\"0.2.1\"", "\"not-semver\"");
    assert!(serde_json::from_str::<PluginManifestV2>(&json).is_err());
}
