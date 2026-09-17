use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{AgentInstallScopeV2, PluginTargetStateDigestV2, PluginVersionV2};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginNativeMarketplaceStateV2 {
    Absent,
    Registered {
        source_fingerprint: PluginTargetStateDigestV2,
        matches_expected_source: bool,
        scope: AgentInstallScopeV2,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PluginNativeInstallationStateV2 {
    Absent,
    Installed {
        version: PluginVersionV2,
        enabled: bool,
        scope: AgentInstallScopeV2,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginNativeTargetStateV2 {
    pub marketplace: PluginNativeMarketplaceStateV2,
    pub installation: PluginNativeInstallationStateV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PluginNativeStateObservationV2 {
    pub state: PluginNativeTargetStateV2,
    pub digest: PluginTargetStateDigestV2,
}

impl PluginNativeStateObservationV2 {
    pub fn new(state: PluginNativeTargetStateV2) -> Self {
        let digest = digest_plugin_native_target_state(&state);
        Self { state, digest }
    }

    pub fn has_valid_digest(&self) -> bool {
        self.digest == digest_plugin_native_target_state(&self.state)
    }
}

pub fn digest_plugin_native_target_state(
    state: &PluginNativeTargetStateV2,
) -> PluginTargetStateDigestV2 {
    let mut digest = Sha256::new();
    digest.update(b"dure-plugin-native-target-state/v2\0");
    match &state.marketplace {
        PluginNativeMarketplaceStateV2::Absent => digest.update(b"marketplace:absent\0"),
        PluginNativeMarketplaceStateV2::Registered {
            source_fingerprint,
            matches_expected_source,
            scope,
        } => {
            digest.update(b"marketplace:registered\0");
            digest.update(source_fingerprint.as_str().as_bytes());
            digest.update(b"\0");
            digest.update(if *matches_expected_source {
                b"expected\0".as_slice()
            } else {
                b"foreign\0".as_slice()
            });
            digest.update(scope_token(scope));
            digest.update(b"\0");
        }
    }
    match &state.installation {
        PluginNativeInstallationStateV2::Absent => digest.update(b"installation:absent\0"),
        PluginNativeInstallationStateV2::Installed {
            version,
            enabled,
            scope,
        } => {
            digest.update(b"installation:installed\0");
            digest.update(version.as_str().as_bytes());
            digest.update(b"\0");
            digest.update(if *enabled {
                b"enabled\0".as_slice()
            } else {
                b"disabled\0".as_slice()
            });
            digest.update(scope_token(scope));
            digest.update(b"\0");
        }
    }
    PluginTargetStateDigestV2::new(format!("sha256:{:x}", digest.finalize()))
        .expect("SHA-256 output always satisfies the target digest wire format")
}

fn scope_token(scope: &AgentInstallScopeV2) -> &'static [u8] {
    match scope {
        AgentInstallScopeV2::User => b"user",
        AgentInstallScopeV2::Project => b"project",
        AgentInstallScopeV2::Local => b"local",
        AgentInstallScopeV2::Managed => b"managed",
    }
}
