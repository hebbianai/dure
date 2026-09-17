#[test]
fn legacy_catalog_does_not_require_beads() {
    let mut snapshot = super::catalog_snapshot_from_registry(super::bundled_plugin_registry());
    snapshot.outcomes.retain(|outcome| {
        !matches!(outcome,
            super::DurePluginCatalogOutcomeV2::Available { entry, .. }
                if entry.manifest.id.as_str() == "dure.beads"
        )
    });
    let entries = super::legacy_catalog_projection(snapshot).unwrap();
    assert!(entries
        .iter()
        .any(|entry| entry.manifest.id.as_str() == "dure.github"));
}
