//! Product check run before a native rehost replays a session's recorded
//! recipe. Hmux replays the recipe verbatim and cannot tell which argument is
//! the provider behind Dure's launch wrapper, so a recipe whose provider was
//! removed (for example a versioned install directory deleted by an upgrade)
//! would retire a live source for a successor that cannot start.

use std::path::Path;

use dure_provider_adapter::managed_environment::unix_managed_launch_program;
use hmux_client::recovery_journal::managed_create_ledger::managed_rehost_recipe;
use serde_json::{Value, json};

use crate::provider_executable::recorded_program_unavailable;

pub const MANAGED_REHOST_PROVIDER_UNAVAILABLE: &str = "managed_rehost_provider_unavailable";

/// `ready` when the recorded provider program can still run, `refused` when it
/// is proven gone, and `unknown` when no recipe could be read; only `refused`
/// should stop a caller before it asks Hmux to rehost.
pub fn managed_rehost_preflight(
    discovery_root: &Path,
    workspace_id: &str,
    session_id: &str,
) -> Value {
    let recipe = match managed_rehost_recipe(discovery_root, workspace_id, session_id) {
        Ok(Some(recipe)) => recipe,
        Ok(None) | Err(_) => return json!({ "schemaVersion": 1, "state": "unknown" }),
    };
    command_preflight(recipe.rehost().command_template())
}

fn command_preflight(command: &[String]) -> Value {
    let program = unix_managed_launch_program(command).map(Path::new);
    match program {
        // A bare name is resolved through PATH by the launch itself.
        Some(program) if program.is_absolute() && recorded_program_unavailable(program) => json!({
            "schemaVersion": 1,
            "state": "refused",
            "error": {
                "code": MANAGED_REHOST_PROVIDER_UNAVAILABLE,
                "message": format!(
                    "The provider program this session was started with, {}, no longer exists or cannot run (often after a provider upgrade). The session was left running; start it with a fresh launch instead, such as Refresh in its pane.",
                    program.display()
                ),
            },
        }),
        _ => json!({ "schemaVersion": 1, "state": "ready" }),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use dure_provider_adapter::managed_environment::unix_managed_launch_prefix;
    use std::os::unix::fs::PermissionsExt;

    /// The recipe shape a control-plane launch records: Dure's launch wrapper,
    /// then the provider program and its resume arguments.
    fn wrapped_resume(program: &Path) -> Vec<String> {
        let mut command =
            unix_managed_launch_prefix("stable", Some(Path::new("/cli/versions/0.2.70/commands")));
        command.extend([
            program.to_str().unwrap().to_string(),
            "--resume".into(),
            hmux_client::MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
        ]);
        command
    }

    #[test]
    fn a_wrapped_recipe_is_refused_once_its_provider_program_is_removed() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("Caskroom/provider/1.0.0");
        std::fs::create_dir_all(&install).unwrap();
        let program = install.join("provider");
        std::fs::write(&program, "not executed").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let recipe = wrapped_resume(&program);
        assert_eq!(recipe[0], "/bin/sh", "the recipe starts with the wrapper");
        assert_eq!(command_preflight(&recipe)["state"], "ready");

        std::fs::remove_dir_all(&install).unwrap();
        let refused = command_preflight(&recipe);
        assert_eq!(refused["state"], "refused");
        assert_eq!(
            refused["error"]["code"],
            MANAGED_REHOST_PROVIDER_UNAVAILABLE
        );
        assert!(
            refused["error"]["message"]
                .as_str()
                .unwrap()
                .contains(program.to_str().unwrap())
        );
    }

    #[test]
    fn bare_and_unwrapped_programs_follow_their_own_resolution() {
        let bare = vec!["provider".to_string(), "--resume".into()];
        assert_eq!(command_preflight(&bare)["state"], "ready");
        let missing = vec!["/nonexistent/provider".to_string(), "--resume".into()];
        assert_eq!(command_preflight(&missing)["state"], "refused");
    }

    #[test]
    fn a_session_without_a_readable_recipe_is_unknown() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            managed_rehost_preflight(root.path(), "workspace", "session")["state"],
            "unknown"
        );
    }
}
