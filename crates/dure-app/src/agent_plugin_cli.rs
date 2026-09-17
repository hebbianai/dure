use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentNativeMarketplaceNameV2,
    AgentNativePluginSelectorV2, PhysicalTargetKeyV2, PluginResourcePathV2, PluginVersionV2,
};

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentNativePluginExecutableV2 {
    Codex,
    Claude,
}

impl AgentNativePluginExecutableV2 {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }

    pub fn matches_adapter(&self, adapter: &AgentAdapterIdV2) -> bool {
        self.as_str() == adapter.as_str()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentNativePluginCliCapabilityV2 {
    MarketplaceListJson,
    MarketplaceAdd,
    MarketplaceRemove,
    PluginListJson,
    PluginInstall,
    PluginRemove,
    JsonMutationOutput,
    UserScope,
    ProjectScope,
    LocalScope,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct AgentNativePluginCliProbeV2 {
    pub adapter: AgentAdapterIdV2,
    pub executable: AgentNativePluginExecutableV2,
    pub version: PluginVersionV2,
    pub capabilities: Vec<AgentNativePluginCliCapabilityV2>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct AgentNativePluginMarketplaceSourceV2 {
    pub resource: PluginResourcePathV2,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum AgentNativePluginCliOutputV2 {
    Json,
    HumanText,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentNativePluginRegistrationTargetV2 {
    ManagedProfile {
        profile_root_key: PhysicalTargetKeyV2,
    },
    User {
        profile_root_key: PhysicalTargetKeyV2,
    },
    Workspace {
        profile_root_key: PhysicalTargetKeyV2,
        workspace_root_key: PhysicalTargetKeyV2,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct AgentNativePluginCliPlanRequestV2 {
    pub adapter: AgentAdapterIdV2,
    pub source: AgentNativePluginMarketplaceSourceV2,
    pub selector: AgentNativePluginSelectorV2,
    pub scope: AgentInstallScopeV2,
    pub registration_target: AgentNativePluginRegistrationTargetV2,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentNativePluginCliCommandV2 {
    ListMarketplaces {
        output: AgentNativePluginCliOutputV2,
    },
    AddMarketplace {
        source: AgentNativePluginMarketplaceSourceV2,
        scope: AgentInstallScopeV2,
        output: AgentNativePluginCliOutputV2,
    },
    RemoveMarketplace {
        marketplace: AgentNativeMarketplaceNameV2,
        scope: AgentInstallScopeV2,
        output: AgentNativePluginCliOutputV2,
    },
    ListPlugins {
        marketplace: AgentNativeMarketplaceNameV2,
        include_available: bool,
        output: AgentNativePluginCliOutputV2,
    },
    InstallPlugin {
        selector: AgentNativePluginSelectorV2,
        scope: AgentInstallScopeV2,
        output: AgentNativePluginCliOutputV2,
    },
    RemovePlugin {
        selector: AgentNativePluginSelectorV2,
        scope: AgentInstallScopeV2,
        preserve_data: bool,
        output: AgentNativePluginCliOutputV2,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, TS)]
pub struct AgentNativePluginCliPlanV2 {
    pub adapter: AgentAdapterIdV2,
    pub executable: AgentNativePluginExecutableV2,
    pub cli_version: PluginVersionV2,
    pub selector: AgentNativePluginSelectorV2,
    pub registration_target: AgentNativePluginRegistrationTargetV2,
    pub commands: Vec<AgentNativePluginCliCommandV2>,
}
