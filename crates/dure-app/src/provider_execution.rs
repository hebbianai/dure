use serde::{Deserialize, Serialize};

/// Provider launch policy selected before the runtime effect is journaled.
///
/// The provider adapter interprets the policy while orchestration and runtime
/// adapters carry the exact normalized value without provider-specific flags.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderPermissionModeV1 {
    Default,
    /// Workspace edits proceed without per-edit approval while everything
    /// else keeps asking — Claude's acceptEdits, Codex's full-auto.
    AutoEdit,
    SkipPermissions,
}

impl ProviderPermissionModeV1 {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::AutoEdit => "auto_edit",
            Self::SkipPermissions => "skip_permissions",
        }
    }
}
