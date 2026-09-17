use dure_app::{AgentSpawnEffortSelectionV1, AgentSpawnModelSelectionV1, ProviderPermissionModeV1};

/// One semantic selection shared by managed runtimes and provider protocols.
/// Wire spellings and permission interpretation remain in each provider adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderTurnSettings {
    pub(crate) permission_mode: ProviderPermissionModeV1,
    pub(crate) model: Option<AgentSpawnModelSelectionV1>,
    pub(crate) effort: Option<AgentSpawnEffortSelectionV1>,
}

impl ProviderTurnSettings {
    pub(crate) fn new(
        permission_mode: ProviderPermissionModeV1,
        model: Option<AgentSpawnModelSelectionV1>,
        effort: Option<AgentSpawnEffortSelectionV1>,
    ) -> Self {
        Self {
            permission_mode,
            model,
            effort,
        }
    }

    pub(crate) fn bypasses_approvals(&self) -> bool {
        self.permission_mode == ProviderPermissionModeV1::SkipPermissions
    }
}
