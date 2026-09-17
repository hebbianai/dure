use hmux_client::{
    ManagedRehostRecipe, PermissionMode, ProviderStateEnvironment,
    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
};
use std::path::Path;

pub(crate) fn local_create_time_recipe(
    provider_id: &str,
    permission_mode: PermissionMode,
    launch_reference: Option<String>,
    shell: &Path,
    provider_state_environment: &ProviderStateEnvironment,
) -> Result<Option<ManagedRehostRecipe>, String> {
    let Some(command) = crate::managed_provider_launch::exact_command(
        provider_id,
        permission_mode,
        MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER,
    ) else {
        return Ok(None);
    };
    let command_template = crate::managed_hooks::prepare_managed_exec(
        provider_id,
        &command,
        provider_state_environment,
    )?
    .into_command_template(shell);
    ManagedRehostRecipe::new(command_template, launch_reference)
    .map(Some)
    .map_err(|error| error.to_string())
}
