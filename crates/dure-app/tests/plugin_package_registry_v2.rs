use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use dure_app::{
    AgentAdapterIdV2, AgentIntegrationIdV2, ContributionDescriptorV2, ContributionFamilyIdV2,
    ContributionIdV2, InMemoryPluginPackageSourceV2, MAX_EMBEDDED_PLUGIN_PACKAGE_FILE_BYTES_V2,
    MAX_EMBEDDED_PLUGIN_PACKAGE_FILES_V2, PluginIdV2, PluginManifestV2, PluginPackageCandidateIdV2,
    PluginPackageCatalogSnapshotV2, PluginPackageRegistryErrorV2, PluginPackageRegistryV2,
    PluginPackageSourceCandidateV2, PluginPackageSourceErrorV2, PluginPackageSourceIdV2,
    PluginPackageSourceRegistrationV2, PluginPackageSourceV2, PluginPublisherIdV2,
    PluginResourcePathV2, PluginVersionV2,
};

fn beads_manifest() -> PluginManifestV2 {
    serde_json::from_str(include_str!("../../../plugins/beads/dure-plugin.json"))
        .expect("bundled Beads manifest must deserialize")
}

fn bytes(value: &[u8]) -> Arc<[u8]> {
    Arc::from(value)
}

fn beads_resources() -> BTreeMap<PluginResourcePathV2, Arc<[u8]>> {
    BTreeMap::from([
        (
            PluginResourcePathV2::new("./contributions/issue-tracker.json").unwrap(),
            bytes(include_bytes!(
                "../../../plugins/beads/contributions/issue-tracker.json"
            )),
        ),
        (
            PluginResourcePathV2::new("./contributions/settings.json").unwrap(),
            bytes(include_bytes!(
                "../../../plugins/beads/contributions/settings.json"
            )),
        ),
        (
            PluginResourcePathV2::new("./contributions/views.json").unwrap(),
            bytes(include_bytes!(
                "../../../plugins/beads/contributions/views.json"
            )),
        ),
    ])
}

fn beads_agent_resources()
-> BTreeMap<AgentIntegrationIdV2, BTreeMap<PluginResourcePathV2, Arc<[u8]>>> {
    BTreeMap::from([
        (
            AgentIntegrationIdV2::new("dure.beads.claude").unwrap(),
            BTreeMap::from([
                (
                    PluginResourcePathV2::new("./.claude-plugin/marketplace.json").unwrap(),
                    bytes(include_bytes!(
                        "../../../plugins/beads/agents/claude/.claude-plugin/marketplace.json"
                    )),
                ),
                (
                    PluginResourcePathV2::new("./plugins/dure-beads/.claude-plugin/plugin.json")
                        .unwrap(),
                    bytes(include_bytes!(
                        "../../../plugins/beads/agents/claude/plugins/dure-beads/.claude-plugin/plugin.json"
                    )),
                ),
                (
                    PluginResourcePathV2::new("./plugins/dure-beads/skills/beads/SKILL.md")
                        .unwrap(),
                    bytes(include_bytes!(
                        "../../../plugins/beads/agents/claude/plugins/dure-beads/skills/beads/SKILL.md"
                    )),
                ),
            ]),
        ),
        (
            AgentIntegrationIdV2::new("dure.beads.codex").unwrap(),
            BTreeMap::from([
                (
                    PluginResourcePathV2::new("./.agents/plugins/marketplace.json").unwrap(),
                    bytes(include_bytes!(
                        "../../../plugins/beads/agents/codex/.agents/plugins/marketplace.json"
                    )),
                ),
                (
                    PluginResourcePathV2::new("./plugins/dure-beads/.codex-plugin/plugin.json")
                        .unwrap(),
                    bytes(include_bytes!(
                        "../../../plugins/beads/agents/codex/plugins/dure-beads/.codex-plugin/plugin.json"
                    )),
                ),
                (
                    PluginResourcePathV2::new("./plugins/dure-beads/skills/beads/SKILL.md")
                        .unwrap(),
                    bytes(include_bytes!(
                        "../../../plugins/beads/agents/codex/plugins/dure-beads/skills/beads/SKILL.md"
                    )),
                ),
            ]),
        ),
    ])
}

fn embedded_package_with(
    manifest_bytes: Arc<[u8]>,
    agent_resources: BTreeMap<AgentIntegrationIdV2, BTreeMap<PluginResourcePathV2, Arc<[u8]>>>,
) -> Result<PluginPackageCatalogSnapshotV2, PluginPackageRegistryErrorV2> {
    embedded_package_with_resources(manifest_bytes, beads_resources(), agent_resources)
}

fn embedded_package_with_resources(
    manifest_bytes: Arc<[u8]>,
    contribution_resources: BTreeMap<PluginResourcePathV2, Arc<[u8]>>,
    agent_resources: BTreeMap<AgentIntegrationIdV2, BTreeMap<PluginResourcePathV2, Arc<[u8]>>>,
) -> Result<PluginPackageCatalogSnapshotV2, PluginPackageRegistryErrorV2> {
    PluginPackageCatalogSnapshotV2::try_new_with_embedded_package(
        manifest_bytes,
        contribution_resources,
        agent_resources,
    )
}

fn beads_embedded_package() -> PluginPackageCatalogSnapshotV2 {
    embedded_package_with(
        bytes(include_bytes!("../../../plugins/beads/dure-plugin.json")),
        beads_agent_resources(),
    )
    .unwrap()
}

fn beads_package() -> PluginPackageCatalogSnapshotV2 {
    PluginPackageCatalogSnapshotV2::try_new(beads_manifest(), beads_resources()).unwrap()
}

fn renamed_package(
    name: &str,
    version: &str,
    settings_bytes: &[u8],
) -> PluginPackageCatalogSnapshotV2 {
    let mut manifest = beads_manifest();
    manifest.publisher = PluginPublisherIdV2::new("example").unwrap();
    manifest.id = PluginIdV2::new(format!("example.{name}")).unwrap();
    manifest.version = PluginVersionV2::new(version).unwrap();
    for contribution in &mut manifest.contributions {
        let suffix = contribution
            .family
            .as_str()
            .strip_prefix("dure.")
            .expect("fixture uses Dure contribution families");
        contribution.id = ContributionIdV2::new(format!("example.{name}.{suffix}")).unwrap();
    }
    for integration in &mut manifest.agent_integrations {
        let suffix = integration
            .id
            .as_str()
            .rsplit('.')
            .next()
            .expect("fixture integration has a suffix");
        integration.id =
            dure_app::AgentIntegrationIdV2::new(format!("example.{name}.{suffix}")).unwrap();
    }
    let mut resources = beads_resources();
    resources.insert(
        PluginResourcePathV2::new("./contributions/settings.json").unwrap(),
        bytes(settings_bytes),
    );
    PluginPackageCatalogSnapshotV2::try_new(manifest, resources).unwrap()
}

fn source_id(value: &str) -> PluginPackageSourceIdV2 {
    PluginPackageSourceIdV2::new(value).unwrap()
}

fn candidate_id(value: &str) -> PluginPackageCandidateIdV2 {
    PluginPackageCandidateIdV2::new(value).unwrap()
}

fn registry_with(
    source_id_value: &str,
    source: &dyn PluginPackageSourceV2,
) -> PluginPackageRegistryV2 {
    PluginPackageRegistryV2::from_sources(&[PluginPackageSourceRegistrationV2::new(
        source_id(source_id_value),
        source,
    )])
}

#[test]
fn in_memory_source_yields_an_owned_snapshot_with_host_provenance() {
    let source = InMemoryPluginPackageSourceV2::new(vec![beads_package()]);
    let registry = registry_with("host.bundled", &source);
    drop(source);

    let plugin_id = PluginIdV2::new("dure.beads").unwrap();
    let contribution_id = ContributionIdV2::new("dure.beads.settings").unwrap();
    let family = ContributionFamilyIdV2::new("dure.settings").unwrap();
    let contribution = registry
        .declared_contribution_resource(&plugin_id, &contribution_id, &family)
        .unwrap();

    assert_eq!(
        contribution.descriptor().resource.as_str(),
        "./contributions/settings.json"
    );
    let settings: serde_json::Value = serde_json::from_slice(contribution.bytes()).unwrap();
    assert_eq!(settings["schema_version"], 1);
    let package = registry.package(&plugin_id).unwrap();
    assert_eq!(package.source_id().as_str(), "host.bundled");
    assert_eq!(package.candidate_id().as_str(), "package.0");
    assert_eq!(package.contribution_resource_count(), 3);
}

#[test]
fn embedded_package_binds_exact_bytes_and_resolves_only_the_declared_adapter() {
    let source = InMemoryPluginPackageSourceV2::new(vec![beads_embedded_package()]);
    let registry = registry_with("host.installed", &source);
    let plugin_id = PluginIdV2::new("dure.beads").unwrap();
    let integration_id = AgentIntegrationIdV2::new("dure.beads.codex").unwrap();
    let resolved = registry
        .declared_agent_integration_resource(
            &plugin_id,
            &integration_id,
            &AgentAdapterIdV2::new("codex").unwrap(),
        )
        .unwrap();

    assert_eq!(resolved.descriptor().resource.as_str(), "./agents/codex");
    assert_eq!(resolved.files().len(), 3);
    assert!(resolved.authority_sha256().as_str().starts_with("sha256:"));
    assert!(
        resolved
            .file_manifest_sha256()
            .as_str()
            .starts_with("sha256:")
    );
    let package = registry.package(&plugin_id).unwrap();
    let authority = package.embedded_authority().unwrap();
    assert_eq!(authority.package_file_count(), 10);
    assert_eq!(
        authority.sha256().as_str(),
        "sha256:b8d8f4c0d3dca54e861ef062daa3bcae484f45d345aa7925bcb43f91814bf32d"
    );
    assert_eq!(
        authority.file_manifest_sha256().as_str(),
        "sha256:32672c56fd43c0c068e74f84d3173cebdaadd58c8edf51341f607ac8f317c0dd"
    );
    assert!(package.has_complete_embedded_authority());
    assert!(matches!(
        registry.declared_agent_integration_resource(
            &plugin_id,
            &integration_id,
            &AgentAdapterIdV2::new("claude").unwrap(),
        ),
        Err(PluginPackageRegistryErrorV2::AgentIntegrationAdapterMismatch { .. })
    ));
}

#[test]
fn embedded_package_requires_the_exact_declared_integration_set() {
    let mut missing = beads_agent_resources();
    missing.remove(&AgentIntegrationIdV2::new("dure.beads.claude").unwrap());
    assert!(matches!(
        embedded_package_with(
            bytes(include_bytes!("../../../plugins/beads/dure-plugin.json")),
            missing,
        ),
        Err(PluginPackageRegistryErrorV2::EmbeddedAgentResourcesUnavailable {
            integration_id,
            ..
        }) if integration_id.as_str() == "dure.beads.claude"
    ));

    let mut undeclared = beads_agent_resources();
    undeclared.insert(
        AgentIntegrationIdV2::new("dure.beads.future").unwrap(),
        BTreeMap::from([(
            PluginResourcePathV2::new("./plugin.json").unwrap(),
            bytes(b"{}"),
        )]),
    );
    assert!(matches!(
        embedded_package_with(
            bytes(include_bytes!("../../../plugins/beads/dure-plugin.json")),
            undeclared,
        ),
        Err(PluginPackageRegistryErrorV2::UndeclaredEmbeddedAgentResources {
            integration_id,
            ..
        }) if integration_id.as_str() == "dure.beads.future"
    ));

    let mut empty = beads_agent_resources();
    empty.insert(
        AgentIntegrationIdV2::new("dure.beads.codex").unwrap(),
        BTreeMap::new(),
    );
    assert!(matches!(
        embedded_package_with(
            bytes(include_bytes!("../../../plugins/beads/dure-plugin.json")),
            empty,
        ),
        Err(PluginPackageRegistryErrorV2::InvalidEmbeddedPackageResourceTree { .. })
    ));
}

#[test]
fn embedded_authority_changes_without_redefining_catalog_approval() {
    let original = beads_embedded_package();
    let mut changed_resources = beads_agent_resources();
    changed_resources
        .get_mut(&AgentIntegrationIdV2::new("dure.beads.codex").unwrap())
        .unwrap()
        .insert(
            PluginResourcePathV2::new("./.agents/plugins/marketplace.json").unwrap(),
            bytes(b"one changed native byte"),
        );
    let changed = embedded_package_with(
        bytes(include_bytes!("../../../plugins/beads/dure-plugin.json")),
        changed_resources,
    )
    .unwrap();

    assert_eq!(
        original.catalog_snapshot_sha256(),
        changed.catalog_snapshot_sha256()
    );
    assert_ne!(
        original.embedded_authority().unwrap().sha256(),
        changed.embedded_authority().unwrap().sha256()
    );
    assert_ne!(
        original
            .embedded_authority()
            .unwrap()
            .file_manifest_sha256(),
        changed.embedded_authority().unwrap().file_manifest_sha256()
    );
}

#[test]
fn embedded_authority_binds_raw_manifest_bytes_but_catalog_digest_is_semantic() {
    let original = beads_embedded_package();
    let mut padded_manifest = include_bytes!("../../../plugins/beads/dure-plugin.json").to_vec();
    padded_manifest.extend_from_slice(b"\n");
    let padded =
        embedded_package_with(Arc::from(padded_manifest), beads_agent_resources()).unwrap();

    assert_eq!(
        original.catalog_snapshot_sha256(),
        padded.catalog_snapshot_sha256()
    );
    assert_ne!(
        original.embedded_authority().unwrap().sha256(),
        padded.embedded_authority().unwrap().sha256()
    );
}

#[test]
fn embedded_package_rejects_file_directory_shadowing() {
    let mut resources = beads_agent_resources();
    resources.insert(
        AgentIntegrationIdV2::new("dure.beads.codex").unwrap(),
        BTreeMap::from([
            (
                PluginResourcePathV2::new("./plugins").unwrap(),
                bytes(b"file"),
            ),
            (
                PluginResourcePathV2::new("./plugins/dure-beads/plugin.json").unwrap(),
                bytes(b"nested"),
            ),
        ]),
    );
    assert!(matches!(
        embedded_package_with(
            bytes(include_bytes!("../../../plugins/beads/dure-plugin.json")),
            resources,
        ),
        Err(PluginPackageRegistryErrorV2::InvalidEmbeddedPackageResourceTree { .. })
    ));
}

#[test]
fn embedded_package_rejects_non_integration_files_inside_an_integration_root() {
    let mut contribution_resources = beads_resources();
    contribution_resources.insert(
        PluginResourcePathV2::new("./agents/codex/provider-visible-extra.json").unwrap(),
        bytes(b"{}"),
    );

    assert!(matches!(
        embedded_package_with_resources(
            bytes(include_bytes!("../../../plugins/beads/dure-plugin.json")),
            contribution_resources,
            beads_agent_resources(),
        ),
        Err(PluginPackageRegistryErrorV2::InvalidEmbeddedPackageResourceTree {
            message,
            ..
        }) if message.contains("overlaps non-integration package file")
    ));
}

#[test]
fn embedded_package_enforces_bounded_file_and_package_counts() {
    let mut oversized = beads_agent_resources();
    oversized
        .get_mut(&AgentIntegrationIdV2::new("dure.beads.codex").unwrap())
        .unwrap()
        .insert(
            PluginResourcePathV2::new("./oversized.bin").unwrap(),
            Arc::from(vec![0_u8; MAX_EMBEDDED_PLUGIN_PACKAGE_FILE_BYTES_V2 + 1]),
        );
    assert!(matches!(
        embedded_package_with(
            bytes(include_bytes!("../../../plugins/beads/dure-plugin.json")),
            oversized,
        ),
        Err(
            PluginPackageRegistryErrorV2::EmbeddedPackageResourceLimitExceeded {
                limit: "file_bytes",
                ..
            }
        )
    ));

    let mut too_many = beads_agent_resources();
    let mut colliding_files = (0..505)
        .map(|index| {
            (
                PluginResourcePathV2::new(format!("./files/{index:03}.json")).unwrap(),
                bytes(b"{}"),
            )
        })
        .collect::<BTreeMap<_, _>>();
    colliding_files.insert(
        PluginResourcePathV2::new("./files").unwrap(),
        bytes(b"shadow"),
    );
    too_many.insert(
        AgentIntegrationIdV2::new("dure.beads.codex").unwrap(),
        colliding_files,
    );
    assert!(matches!(
        embedded_package_with(
            bytes(include_bytes!("../../../plugins/beads/dure-plugin.json")),
            too_many,
        ),
        Err(
            PluginPackageRegistryErrorV2::EmbeddedPackageResourceLimitExceeded {
                limit: "file_count",
                ..
            }
        )
    ));
}

#[test]
fn oversized_embedded_manifest_is_rejected_before_deserialization() {
    let oversized = Arc::<[u8]>::from(vec![b' '; MAX_EMBEDDED_PLUGIN_PACKAGE_FILE_BYTES_V2 + 1]);

    assert!(matches!(
        PluginPackageCatalogSnapshotV2::try_new_with_embedded_package(
            oversized,
            beads_resources(),
            BTreeMap::new(),
        ),
        Err(PluginPackageRegistryErrorV2::EmbeddedManifestTooLarge {
            maximum_bytes,
        }) if maximum_bytes == MAX_EMBEDDED_PLUGIN_PACKAGE_FILE_BYTES_V2
    ));
}

#[test]
fn embedded_package_enforces_total_byte_limit() {
    let block: Arc<[u8]> = Arc::from(vec![0_u8; MAX_EMBEDDED_PLUGIN_PACKAGE_FILE_BYTES_V2]);
    let mut resources = beads_agent_resources();
    let codex = resources
        .get_mut(&AgentIntegrationIdV2::new("dure.beads.codex").unwrap())
        .unwrap();
    codex.clear();
    for index in 0..17 {
        codex.insert(
            PluginResourcePathV2::new(format!("./blocks/{index:02}.bin")).unwrap(),
            Arc::clone(&block),
        );
    }

    assert!(matches!(
        embedded_package_with(
            bytes(include_bytes!("../../../plugins/beads/dure-plugin.json")),
            resources,
        ),
        Err(
            PluginPackageRegistryErrorV2::EmbeddedPackageResourceLimitExceeded {
                limit: "total_bytes",
                ..
            }
        )
    ));
}

#[test]
fn embedded_package_accepts_exact_file_count_limit() {
    let mut resources = beads_agent_resources();
    resources.insert(
        AgentIntegrationIdV2::new("dure.beads.codex").unwrap(),
        (0..505)
            .map(|index| {
                (
                    PluginResourcePathV2::new(format!("./files/{index:03}.json")).unwrap(),
                    bytes(b"{}"),
                )
            })
            .collect(),
    );

    let package = embedded_package_with(
        bytes(include_bytes!("../../../plugins/beads/dure-plugin.json")),
        resources,
    )
    .expect("the exact embedded file-count limit remains valid");
    assert_eq!(
        package.embedded_authority().unwrap().package_file_count(),
        MAX_EMBEDDED_PLUGIN_PACKAGE_FILES_V2
    );
}

#[test]
fn trusted_bundled_native_package_without_embedded_authority_is_quarantined() {
    let source = InMemoryPluginPackageSourceV2::new(vec![beads_package()]);
    let registration = PluginPackageSourceRegistrationV2::trusted_bundled(
        source_id("host.bundled"),
        &source,
        "host.release",
    )
    .unwrap();
    let registry = PluginPackageRegistryV2::from_sources(&[registration]);

    assert_eq!(registry.available_len(), 0);
    assert_eq!(registry.source_rejections().len(), 1);
    assert_eq!(
        registry.source_rejections()[0].error().to_string(),
        "trusted bundled native package has no embedded package authority"
    );
}

#[test]
fn invalid_manifest_is_rejected_before_registration() {
    let mut manifest = beads_manifest();
    manifest.schema_version = 999;
    let error = PluginPackageCatalogSnapshotV2::try_new(manifest, beads_resources())
        .err()
        .expect("invalid manifest must be rejected");

    assert!(matches!(
        error,
        PluginPackageRegistryErrorV2::InvalidManifest { plugin_id, .. }
            if plugin_id.as_str() == "dure.beads"
    ));
}

#[test]
fn duplicate_id_conflicts_are_isolated_without_source_order_precedence() {
    let first = InMemoryPluginPackageSourceV2::new(vec![
        renamed_package("collision", "1.0.0", b"first"),
        renamed_package("unrelated", "1.0.0", b"safe"),
    ]);
    let second =
        InMemoryPluginPackageSourceV2::new(vec![renamed_package("collision", "2.0.0", b"second")]);
    let registry = PluginPackageRegistryV2::from_sources(&[
        PluginPackageSourceRegistrationV2::new(source_id("host.second"), &second),
        PluginPackageSourceRegistrationV2::new(source_id("host.first"), &first),
    ]);

    let collision_id = PluginIdV2::new("example.collision").unwrap();
    let error = match registry.package(&collision_id) {
        Ok(_) => panic!("conflicted plugin must not be selected"),
        Err(error) => error,
    };
    let PluginPackageRegistryErrorV2::DuplicatePluginId {
        plugin_id,
        candidates,
    } = error
    else {
        panic!("expected duplicate plugin ID error")
    };
    assert_eq!(plugin_id, collision_id);
    assert_eq!(
        candidates
            .iter()
            .map(|candidate| (candidate.source_id().as_str(), candidate.version().as_str(),))
            .collect::<Vec<_>>(),
        [("host.first", "1.0.0"), ("host.second", "2.0.0")]
    );
    assert!(
        candidates
            .iter()
            .all(|candidate| candidate.candidate_id().as_str() == "package.0")
    );
    assert_eq!(
        registry
            .iter_conflicts()
            .map(|(plugin_id, candidates)| (plugin_id.as_str(), candidates.len()))
            .collect::<Vec<_>>(),
        [("example.collision", 2)]
    );
    assert_eq!(
        registry
            .package(&PluginIdV2::new("example.unrelated").unwrap())
            .unwrap()
            .source_id()
            .as_str(),
        "host.first"
    );
    assert_eq!(registry.available_len(), 1);
}

#[test]
fn required_contribution_resource_is_rejected_before_registration() {
    let mut resources = beads_resources();
    resources.remove(&PluginResourcePathV2::new("./contributions/settings.json").unwrap());
    let error = match PluginPackageCatalogSnapshotV2::try_new(beads_manifest(), resources) {
        Ok(_) => panic!("required contribution resource must be rejected"),
        Err(error) => error,
    };

    assert!(matches!(
        error,
        PluginPackageRegistryErrorV2::ResourceUnavailable {
            contribution_id,
            ..
        } if contribution_id.as_str() == "dure.beads.settings"
    ));
}

#[test]
fn exact_lookup_distinguishes_plugin_contribution_family_and_resource_failures() {
    let source = InMemoryPluginPackageSourceV2::new(vec![beads_package()]);
    let registry = registry_with("host.bundled", &source);
    let plugin_id = PluginIdV2::new("dure.beads").unwrap();
    let contribution_id = ContributionIdV2::new("dure.beads.settings").unwrap();

    assert!(matches!(
        registry.package(&PluginIdV2::new("dure.missing").unwrap()),
        Err(PluginPackageRegistryErrorV2::PluginUnavailable { .. })
    ));
    assert!(matches!(
        registry.declared_contribution_resource(
            &plugin_id,
            &contribution_id,
            &ContributionFamilyIdV2::new("dure.views").unwrap(),
        ),
        Err(PluginPackageRegistryErrorV2::ContributionFamilyMismatch { .. })
    ));
    assert!(matches!(
        registry.declared_contribution_resource(
            &plugin_id,
            &ContributionIdV2::new("dure.beads.missing").unwrap(),
            &ContributionFamilyIdV2::new("dure.settings").unwrap(),
        ),
        Err(PluginPackageRegistryErrorV2::ContributionUnavailable { .. })
    ));

    let mut resources = beads_resources();
    resources.remove(&PluginResourcePathV2::new("./contributions/settings.json").unwrap());
    let mut sparse_manifest = beads_manifest();
    sparse_manifest
        .contributions
        .iter_mut()
        .find(|contribution| contribution.id.as_str() == "dure.beads.settings")
        .unwrap()
        .required = false;
    let missing_resource_package =
        PluginPackageCatalogSnapshotV2::try_new(sparse_manifest, resources).unwrap();
    let missing_resource_source =
        InMemoryPluginPackageSourceV2::new(vec![missing_resource_package]);
    let missing_resource_registry = registry_with("host.bundled", &missing_resource_source);
    assert!(matches!(
        missing_resource_registry.declared_contribution_resource(
            &plugin_id,
            &contribution_id,
            &ContributionFamilyIdV2::new("dure.settings").unwrap(),
        ),
        Err(PluginPackageRegistryErrorV2::ResourceUnavailable { .. })
    ));
}

#[test]
fn packages_with_the_same_resource_path_cannot_borrow_each_others_bytes() {
    let source = InMemoryPluginPackageSourceV2::new(vec![
        renamed_package("alpha", "1.0.0", b"alpha-owned"),
        renamed_package("beta", "1.0.0", b"beta-owned"),
    ]);
    let registry = registry_with("host.installed", &source);
    let family = ContributionFamilyIdV2::new("dure.settings").unwrap();

    for (plugin, expected) in [
        ("example.alpha", b"alpha-owned".as_slice()),
        ("example.beta", b"beta-owned".as_slice()),
    ] {
        let plugin_id = PluginIdV2::new(plugin).unwrap();
        let contribution_id = ContributionIdV2::new(format!("{plugin}.settings")).unwrap();
        assert_eq!(
            registry
                .declared_contribution_resource(&plugin_id, &contribution_id, &family)
                .unwrap()
                .bytes(),
            expected
        );
    }
}

#[test]
fn optional_unknown_contribution_can_remain_sparse_until_negotiated() {
    let mut manifest = beads_manifest();
    manifest.contributions.push(ContributionDescriptorV2 {
        id: ContributionIdV2::new("dure.beads.future").unwrap(),
        family: ContributionFamilyIdV2::new("example.future").unwrap(),
        family_api: dure_app::ContractVersionRangeV2::new(1, 1),
        required: false,
        placement: dure_app::PluginPlacementV2::Ui,
        resource: PluginResourcePathV2::new("./contributions/future.bin").unwrap(),
    });
    let source = InMemoryPluginPackageSourceV2::new(vec![
        PluginPackageCatalogSnapshotV2::try_new(manifest, beads_resources()).unwrap(),
    ]);

    let registry = registry_with("host.bundled", &source);
    assert_eq!(registry.available_len(), 1);
    assert!(matches!(
        registry.declared_contribution_resource(
            &PluginIdV2::new("dure.beads").unwrap(),
            &ContributionIdV2::new("dure.beads.future").unwrap(),
            &ContributionFamilyIdV2::new("example.future").unwrap(),
        ),
        Err(PluginPackageRegistryErrorV2::ResourceUnavailable { .. })
    ));
}

#[test]
fn registry_iteration_is_sorted_by_plugin_id() {
    let source = InMemoryPluginPackageSourceV2::new(vec![
        renamed_package("zeta", "1.0.0", b"zeta"),
        renamed_package("alpha", "1.0.0", b"alpha"),
    ]);
    let registry = registry_with("host.installed", &source);

    assert_eq!(
        registry
            .iter_available()
            .map(|package| package.manifest().id.as_str())
            .collect::<Vec<_>>(),
        ["example.alpha", "example.zeta"]
    );
}

struct FailingSource;

impl PluginPackageSourceV2 for FailingSource {
    fn load(&self) -> Vec<PluginPackageSourceCandidateV2> {
        vec![PluginPackageSourceCandidateV2::rejected(
            candidate_id("candidate.failure"),
            PluginPackageSourceErrorV2::new("source unavailable"),
        )]
    }
}

struct PartiallyFailingSource;

impl PluginPackageSourceV2 for PartiallyFailingSource {
    fn load(&self) -> Vec<PluginPackageSourceCandidateV2> {
        vec![
            PluginPackageSourceCandidateV2::rejected(
                candidate_id("candidate.zeta"),
                PluginPackageSourceErrorV2::new("malformed"),
            ),
            PluginPackageSourceCandidateV2::accepted(
                candidate_id("candidate.valid"),
                beads_package(),
            ),
            PluginPackageSourceCandidateV2::rejected(
                candidate_id("candidate.alpha"),
                PluginPackageSourceErrorV2::new("malformed"),
            ),
        ]
    }
}

struct DuplicateCandidateSource;

impl PluginPackageSourceV2 for DuplicateCandidateSource {
    fn load(&self) -> Vec<PluginPackageSourceCandidateV2> {
        vec![
            PluginPackageSourceCandidateV2::accepted(
                candidate_id("candidate.duplicate"),
                renamed_package("alpha", "1.0.0", b"alpha"),
            ),
            PluginPackageSourceCandidateV2::accepted(
                candidate_id("candidate.duplicate"),
                renamed_package("beta", "1.0.0", b"beta"),
            ),
            PluginPackageSourceCandidateV2::accepted(
                candidate_id("candidate.safe"),
                beads_package(),
            ),
        ]
    }
}

#[test]
fn source_failure_is_quarantined_without_hiding_other_sources() {
    let good = InMemoryPluginPackageSourceV2::new(vec![beads_package()]);
    let registry = PluginPackageRegistryV2::from_sources(&[
        PluginPackageSourceRegistrationV2::new(source_id("host.bundled"), &good),
        PluginPackageSourceRegistrationV2::new(source_id("host.broken"), &FailingSource),
    ]);

    assert!(
        registry
            .package(&PluginIdV2::new("dure.beads").unwrap())
            .is_ok()
    );
    assert_eq!(registry.source_rejections().len(), 1);
    assert_eq!(
        registry.source_rejections()[0].source_id().as_str(),
        "host.broken"
    );
    assert_eq!(
        registry.source_rejections()[0].candidate_id().as_str(),
        "candidate.failure"
    );
    assert_eq!(
        registry.source_rejections()[0].error().to_string(),
        "source unavailable"
    );
}

#[test]
fn candidate_rejections_do_not_hide_valid_siblings_from_the_same_source() {
    let registry = registry_with("host.installed", &PartiallyFailingSource);

    assert!(
        registry
            .package(&PluginIdV2::new("dure.beads").unwrap())
            .is_ok()
    );
    assert_eq!(
        registry
            .source_rejections()
            .iter()
            .map(|rejection| rejection.candidate_id().as_str())
            .collect::<Vec<_>>(),
        ["candidate.alpha", "candidate.zeta"]
    );
    assert!(
        registry
            .source_rejections()
            .iter()
            .all(|rejection| rejection.error().to_string() == "malformed")
    );
}

#[test]
fn duplicate_source_local_candidate_ids_are_quarantined_before_registration() {
    let registry = registry_with("host.installed", &DuplicateCandidateSource);

    assert!(
        registry
            .package(&PluginIdV2::new("dure.beads").unwrap())
            .is_ok()
    );
    for plugin_id in ["example.alpha", "example.beta"] {
        assert!(matches!(
            registry.package(&PluginIdV2::new(plugin_id).unwrap()),
            Err(PluginPackageRegistryErrorV2::PluginUnavailable { .. })
        ));
    }
    assert_eq!(registry.source_rejections().len(), 1);
    let rejection = &registry.source_rejections()[0];
    assert_eq!(rejection.candidate_id().as_str(), "candidate.duplicate");
    assert_eq!(
        rejection.error().to_string(),
        "source returned a duplicate candidate ID"
    );
}

struct MutableCountingSource {
    loads: AtomicUsize,
    packages: Mutex<Vec<PluginPackageCatalogSnapshotV2>>,
}

impl PluginPackageSourceV2 for MutableCountingSource {
    fn load(&self) -> Vec<PluginPackageSourceCandidateV2> {
        self.loads.fetch_add(1, Ordering::SeqCst);
        self.packages
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .enumerate()
            .map(|(index, package)| {
                PluginPackageSourceCandidateV2::accepted(
                    candidate_id(&format!("candidate.{index}")),
                    package,
                )
            })
            .collect()
    }
}

#[test]
fn registry_materializes_a_source_once_and_ignores_later_source_mutation() {
    let source = MutableCountingSource {
        loads: AtomicUsize::new(0),
        packages: Mutex::new(vec![renamed_package("mutable", "1.0.0", b"initial")]),
    };
    let registry = registry_with("host.installed", &source);
    *source.packages.lock().unwrap() = vec![renamed_package("mutable", "1.0.0", b"replacement")];

    let resolved = registry
        .declared_contribution_resource(
            &PluginIdV2::new("example.mutable").unwrap(),
            &ContributionIdV2::new("example.mutable.settings").unwrap(),
            &ContributionFamilyIdV2::new("dure.settings").unwrap(),
        )
        .unwrap();
    assert_eq!(resolved.bytes(), b"initial");
    assert_eq!(source.loads.load(Ordering::SeqCst), 1);
}
