use dure_app::ProviderPermissionModeV1;
use hmux_client::PermissionMode;

pub(super) fn from_hmux(value: PermissionMode) -> ProviderPermissionModeV1 {
    match value {
        PermissionMode::Default => ProviderPermissionModeV1::Default,
        PermissionMode::BypassApprovals => ProviderPermissionModeV1::SkipPermissions,
    }
}

pub(super) fn to_hmux(value: ProviderPermissionModeV1) -> PermissionMode {
    match value {
        // The hmux terminal protocol only distinguishes bypass from approvals;
        // auto-edit stays on the approvals side there, and the exact mode
        // still reaches the provider CLI through its launch arguments.
        ProviderPermissionModeV1::Default | ProviderPermissionModeV1::AutoEdit => {
            PermissionMode::Default
        }
        ProviderPermissionModeV1::SkipPermissions => PermissionMode::BypassApprovals,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_modes_round_trip_without_provider_specific_interpretation() {
        for value in [
            ProviderPermissionModeV1::Default,
            ProviderPermissionModeV1::SkipPermissions,
        ] {
            assert_eq!(from_hmux(to_hmux(value.clone())), value);
        }
    }
}
