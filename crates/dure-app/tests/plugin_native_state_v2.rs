use dure_app::{
    AgentInstallScopeV2, PluginNativeInstallationStateV2, PluginNativeMarketplaceStateV2,
    PluginNativeTargetStateV2, PluginTargetStateDigestV2, PluginVersionV2,
    digest_plugin_native_target_state,
};

fn state(source: &[u8], expected: bool, enabled: bool) -> PluginNativeTargetStateV2 {
    PluginNativeTargetStateV2 {
        marketplace: PluginNativeMarketplaceStateV2::Registered {
            source_fingerprint: PluginTargetStateDigestV2::sha256(source),
            matches_expected_source: expected,
            scope: AgentInstallScopeV2::Managed,
        },
        installation: PluginNativeInstallationStateV2::Installed {
            version: PluginVersionV2::new("0.1.0").unwrap(),
            enabled,
            scope: AgentInstallScopeV2::Managed,
        },
    }
}

#[test]
fn target_digest_is_stable_and_contains_no_raw_source_path() {
    let first = state(b"/Users/alice/private/plugin", true, true);
    let second = first.clone();

    let digest = digest_plugin_native_target_state(&first);

    assert_eq!(digest, digest_plugin_native_target_state(&second));
    assert!(digest.as_str().starts_with("sha256:"));
    assert!(!digest.as_str().contains("alice"));
    assert_eq!(digest.as_str().len(), "sha256:".len() + 64);
}

#[test]
fn every_recovery_relevant_state_change_changes_the_digest() {
    let baseline = state(b"/package/a", true, true);
    let variants = [
        state(b"/package/b", true, true),
        state(b"/package/a", false, true),
        state(b"/package/a", true, false),
        PluginNativeTargetStateV2 {
            marketplace: PluginNativeMarketplaceStateV2::Absent,
            installation: baseline.installation.clone(),
        },
        PluginNativeTargetStateV2 {
            marketplace: PluginNativeMarketplaceStateV2::Registered {
                source_fingerprint: PluginTargetStateDigestV2::sha256(b"/package/a"),
                matches_expected_source: true,
                scope: AgentInstallScopeV2::User,
            },
            installation: baseline.installation.clone(),
        },
        PluginNativeTargetStateV2 {
            marketplace: baseline.marketplace.clone(),
            installation: PluginNativeInstallationStateV2::Absent,
        },
        PluginNativeTargetStateV2 {
            marketplace: baseline.marketplace.clone(),
            installation: PluginNativeInstallationStateV2::Installed {
                version: PluginVersionV2::new("0.2.0").unwrap(),
                enabled: true,
                scope: AgentInstallScopeV2::Managed,
            },
        },
        PluginNativeTargetStateV2 {
            marketplace: baseline.marketplace.clone(),
            installation: PluginNativeInstallationStateV2::Installed {
                version: PluginVersionV2::new("0.1.0").unwrap(),
                enabled: true,
                scope: AgentInstallScopeV2::User,
            },
        },
    ];
    let baseline_digest = digest_plugin_native_target_state(&baseline);

    for variant in variants {
        assert_ne!(digest_plugin_native_target_state(&variant), baseline_digest);
    }
}

#[test]
fn component_fingerprints_use_the_same_strict_wire_format() {
    let digest = PluginTargetStateDigestV2::sha256(b"component");
    assert_eq!(
        PluginTargetStateDigestV2::new(digest.as_str()).unwrap(),
        digest
    );
}
