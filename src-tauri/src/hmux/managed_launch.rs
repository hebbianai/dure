use super::managed_create::{
    advance_managed_create as execute_managed_create_advance, prepare_credential_launch,
    project_direct_created, ManagedCreateProjectionContext, ManagedCreateSummary,
};
use super::managed_create_timing::ManagedCreateTiming;
use super::{validate_identifier, HmuxManager};
use crate::managed_create_resolution::ManagedCreateAdvanceCommandResolution;
use hmux_client::{
    ManagedCreateRequest, ProviderConversationIdentitySeed,
    ProviderStateEnvironment, MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
};
use std::path::PathBuf;
use tauri::{AppHandle, Runtime};

pub(super) struct PreparedManagedCreateRequest {
    pub(super) request: ManagedCreateRequest,
    pub(super) replace_current: bool,
    idempotency_key: String,
    pub(super) credential_id: Option<String>,
    pub(super) credential_generation: Option<u64>,
    pub(super) conversation_id: Option<String>,
    pub(super) initial_prompt_accepted: bool,
}

pub(super) fn prepare_managed_create_request(
    launch: super::ManagedCreateLaunch,
) -> Result<PreparedManagedCreateRequest, String> {
    let super::ManagedCreateLaunch {
        replace_current,
        idempotency_key,
        session_id,
        workspace_id,
        provider_id,
        conversation_id,
        initial_prompt,
        permission_mode,
        credential_id,
        credential_generation,
        provider_state_environment,
        cwd,
        command,
        rows,
        columns,
        terminal_environment,
        terminal_default_colors,
    } = launch;
    validate_identifier("idempotency key", &idempotency_key)?;
    validate_identifier("session id", &session_id)?;
    validate_identifier("workspace id", &workspace_id)?;
    validate_identifier("provider id", &provider_id)?;
    if let Some(conversation_id) = conversation_id.as_deref() {
        validate_identifier("conversation id", conversation_id)?;
    }
    validate_managed_provider_launch(
        credential_id.as_deref(),
        credential_generation,
        &provider_state_environment,
        &command,
    )?;
    let launch_command = crate::managed_hooks::prepare_managed_exec(
        &provider_id,
        &command,
        &provider_state_environment,
    )?;
    let cwd = if replace_current && conversation_id.is_some() {
        crate::working_directory::resolve_exact_resume_cwd(&cwd)
    } else {
        std::fs::canonicalize(&cwd)
    }
    .map_err(|error| format!("resolve managed Hmux cwd failed: {error}"))?;
    if !cwd.is_dir() {
        return Err("managed Hmux cwd must be a directory".to_string());
    }
    let shell = std::env::var_os("SHELL")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bin/sh"));
    let rehost_recipe = super::managed_rehost_recipe::local_create_time_recipe(
        &provider_id,
        permission_mode,
        credential_id.clone(),
        &shell,
        &provider_state_environment,
    )?;
    let create_request = |command| {
        ManagedCreateRequest::new(
            &idempotency_key,
            &session_id,
            &workspace_id,
            &provider_id,
            permission_mode,
            cwd.clone(),
            command,
            rows,
            columns,
        )
    };
    let base_command = launch_command.clone().into_command_template(&shell);
    let launch_prompt = initial_prompt.as_deref().filter(|prompt| {
        crate::managed_provider_launch::reviewed_command_accepts_launch_prompt(
            &provider_id,
            permission_mode,
            conversation_id.as_deref(),
            &command,
            prompt,
        )
    });
    let prompted_request = launch_prompt.map(|prompt| {
        create_request(
            launch_command
                .with_shell_argument(prompt)
                .into_command_template(&shell),
        )
    });
    let (request, initial_prompt_accepted) = match prompted_request {
        Some(Ok(request)) => (request, true),
        Some(Err(_)) => (
            create_request(base_command).map_err(|error| error.to_string())?,
            false,
        ),
        None => (
            create_request(base_command).map_err(|error| error.to_string())?,
            false,
        ),
    };
    let request = request
        .with_required_managed_stop_request_version(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION)
        .and_then(|request| request.with_terminal_environment(terminal_environment))
        .and_then(|request| request.with_terminal_default_colors(terminal_default_colors))
        .map_err(|error| error.to_string())?;
    let request = match rehost_recipe {
        Some(recipe) => request
            .with_managed_rehost_recipe(recipe)
            .map_err(|error| error.to_string())?,
        None => request,
    };
    let request = if let Some(conversation_id) = conversation_id.as_deref() {
        let identity =
            ProviderConversationIdentitySeed::new(request.provider_id(), conversation_id)
                .map_err(|error| error.to_string())?;
        request
            .with_conversation_identity(identity)
            .map_err(|error| error.to_string())?
    } else {
        request
    };
    let request = if provider_state_environment.is_empty() {
        request
    } else {
        request
            .with_provider_state_environment(provider_state_environment)
            .map_err(|error| error.to_string())?
    };
    Ok(PreparedManagedCreateRequest {
        request,
        replace_current,
        idempotency_key,
        credential_id,
        credential_generation,
        conversation_id,
        initial_prompt_accepted,
    })
}

impl HmuxManager {
    pub fn create_managed<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        launch: super::ManagedCreateLaunch,
    ) -> Result<ManagedCreateSummary, String> {
        let prepared = prepare_managed_create_request(launch)?;
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        self.create_managed_request_locked(app, prepared)
    }

    #[cfg(test)]
    pub fn advance_managed_create<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        launch: super::ManagedCreateLaunch,
    ) -> Result<ManagedCreateAdvanceCommandResolution<ManagedCreateSummary>, String> {
        self.advance_managed_create_with_broker_timing(app, launch, false)
    }

    #[cfg(test)]
    pub fn advance_managed_create_with_broker_timing<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        launch: super::ManagedCreateLaunch,
        broker_timing: bool,
    ) -> Result<ManagedCreateAdvanceCommandResolution<ManagedCreateSummary>, String> {
        let mut timing = ManagedCreateTiming::new(broker_timing, &launch.idempotency_key);
        self.advance_managed_create_with_timing(app, launch, &mut timing)
    }

    pub(crate) fn advance_managed_create_with_timing<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        launch: super::ManagedCreateLaunch,
        timing: &mut ManagedCreateTiming,
    ) -> Result<ManagedCreateAdvanceCommandResolution<ManagedCreateSummary>, String> {
        timing.mark("launch.prepare");
        let prepared = prepare_managed_create_request(launch)?;
        timing.mark("launch.prepared");
        timing.mark("operations.wait");
        let _operation = self.operations.lock().expect("Hmux operations poisoned");
        timing.mark("operations.acquired");
        let result = execute_managed_create_advance(app, prepared, timing);
        timing.mark("adapter.returned");
        result
    }

    pub(super) fn create_managed_request_locked<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        prepared: PreparedManagedCreateRequest,
    ) -> Result<ManagedCreateSummary, String> {
        let PreparedManagedCreateRequest {
            request,
            replace_current: _,
            idempotency_key,
            credential_id,
            credential_generation,
            conversation_id,
            initial_prompt_accepted,
        } = prepared;
        let request = super::require_conversation_fenced_managed_stop_lifecycle(request)?;
        // Resolve the exact runtime before recording credential launch intent.
        // A missing/stale runtime must not leave a journal entry for a provider
        // process that was never eligible to start.
        let runtime = super::runtime::resolve_runtime(app)?;
        let credential_launch = prepare_credential_launch(
            &request,
            &idempotency_key,
            credential_id.as_deref(),
            conversation_id.as_deref(),
        )?;
        let expected_cwd = request.provider_cwd().to_path_buf();
        let created = crate::session_checkout::create(runtime, None, request)?;
        project_direct_created(
            created,
            credential_launch.as_ref(),
            ManagedCreateProjectionContext {
                expected_cwd,
                credential_id,
                credential_generation,
                initial_prompt_accepted,
            },
        )
    }
}

pub(super) fn validate_managed_provider_launch(
    credential_id: Option<&str>,
    credential_generation: Option<u64>,
    provider_state_environment: &ProviderStateEnvironment,
    command: &str,
) -> Result<(), String> {
    if credential_id.is_some_and(str::is_empty) {
        return Err("credential id must not be empty".to_string());
    }
    if let Some(credential_id) = credential_id {
        validate_identifier("credential id", credential_id)?;
    }
    if credential_generation.is_some() && credential_id.is_none() {
        return Err(
            "credential_generation_without_reference: credential generation requires a non-secret credential id"
                .to_string(),
        );
    }
    provider_state_environment
        .validate()
        .map_err(|error| error.to_string())?;
    if credential_id.is_some() == provider_state_environment.values().is_empty() {
        return Err(
            "credential_environment_mismatch: credential reference and provider state-root assignments must be supplied together"
                .to_string(),
        );
    }
    if provider_state_environment
        .values()
        .keys()
        .map(String::as_str)
        .chain(
            provider_state_environment
                .removals()
                .iter()
                .map(String::as_str),
        )
        .any(|name| command.contains(name))
    {
        return Err(
            "provider_state_environment_must_be_structured: managed provider commands cannot mutate provider state roots"
                .to_string(),
        );
    }
    if command.trim().is_empty() {
        return Err("managed provider command must not be empty".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{prepare_managed_create_request, validate_managed_provider_launch};
    use crate::hmux::ManagedCreateLaunch;
    use hmux_client::{
        PermissionMode, ProviderStateEnvironment, TerminalDefaultColors, TerminalEnvironment,
    };
    use std::collections::{BTreeMap, BTreeSet};
    use std::process::Command;

    #[test]
    fn managed_launch_accepts_structured_codex_state_and_rejects_command_mutation() {
        let codex_environment = ProviderStateEnvironment::from_mutations(
            BTreeMap::from([
                (
                    "CODEX_HOME".to_string(),
                    "/tmp/hebbian/accounts/codex-crispy".to_string(),
                ),
                (
                    "CODEX_SQLITE_HOME".to_string(),
                    "/tmp/canonical-codex".to_string(),
                ),
            ]),
            BTreeSet::from([
                "CODEX_ACCESS_TOKEN".into(),
                "CODEX_API_KEY".into(),
                "OPENAI_API_KEY".into(),
            ]),
        )
        .unwrap();
        let codex_default = crate::accounts::provider_default_state_environment("codex").unwrap();
        validate_managed_provider_launch(Some("crispy"), None, &codex_environment, "codex")
            .unwrap();
        let kimi_default = crate::accounts::provider_default_state_environment("kimi").unwrap();
        validate_managed_provider_launch(None, None, &kimi_default, "kimi").unwrap();
        let error = validate_managed_provider_launch(
            Some("crispy"),
            None,
            &ProviderStateEnvironment::default(),
            "codex",
        )
        .unwrap_err();
        assert!(error.starts_with("credential_environment_mismatch:"));
        for command in [
            "CODEX_HOME=/tmp/crispy codex",
            "unset CODEX_HOME; codex",
            "env -u CODEX_HOME codex",
        ] {
            let error =
                validate_managed_provider_launch(None, None, &codex_default, command).unwrap_err();
            assert!(error.starts_with("provider_state_environment_must_be_structured:"));
        }
        validate_managed_provider_launch(None, None, &codex_default, "codex resume conversation-1")
            .unwrap();
        let error = validate_managed_provider_launch(
            None,
            Some(7),
            &ProviderStateEnvironment::default(),
            "claude",
        )
        .unwrap_err();
        assert!(error.starts_with("credential_generation_without_reference:"));
    }

    #[test]
    fn exact_resume_uses_the_repository_when_its_recorded_worktree_was_removed() {
        let temporary = tempfile::tempdir().unwrap();
        let repository = temporary.path().join("repo");
        assert!(Command::new("git")
            .args(["init", "--quiet"])
            .arg(&repository)
            .status()
            .unwrap()
            .success());
        std::fs::create_dir_all(repository.join(".worktrees")).unwrap();
        let removed_worktree = repository.join(".worktrees/removed");

        let prepared = prepare_managed_create_request(ManagedCreateLaunch {
            replace_current: true,
            idempotency_key: "resume-create".to_string(),
            session_id: "resume-session".to_string(),
            workspace_id: "resume-workspace".to_string(),
            provider_id: "fixture".to_string(),
            conversation_id: Some("resume-conversation".to_string()),
            permission_mode: PermissionMode::Default,
            credential_id: None,
            credential_generation: None,
            provider_state_environment: ProviderStateEnvironment::default(),
            cwd: removed_worktree.to_string_lossy().into_owned(),
            command: "/bin/sh".to_string(),
            initial_prompt: None,
            rows: 24,
            columns: 80,
            terminal_environment: TerminalEnvironment::default(),
            terminal_default_colors: TerminalDefaultColors::default(),
        })
        .expect("exact Resume must outlive a removed historical worktree");

        assert_eq!(
            prepared.request.provider_cwd(),
            std::fs::canonicalize(repository).unwrap()
        );
    }
}
