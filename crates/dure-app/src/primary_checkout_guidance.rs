//! Session-start guidance for agents launched in a repository's primary
//! checkout. Hooks run the Git query where the agent runs; this module owns the
//! query arguments, the classification of its output and the exact text.

use serde_json::json;

/// `git -C <cwd>` arguments whose four output lines are the working tree root,
/// the Git directory, the common Git directory and the abbreviated HEAD.
pub const PRIMARY_CHECKOUT_REV_PARSE_ARGUMENTS_V1: &[&str] = &[
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
    "--abbrev-ref",
    "HEAD",
];

/// `{toplevel}` and `{branch}` are the only substitutions.
pub const PRIMARY_CHECKOUT_SESSION_CONTEXT_TEMPLATE_V1: &str = "Dure: This session started in the primary checkout of the Git repository at {toplevel} (currently on {branch}). Other agents may use this checkout at the same time, so keep it on its current branch: do not switch branches, check out other commits, rebase, or reset here. For work that needs another branch, create a separate worktree, for example `git worktree add -b <branch> .worktrees/<name> <base>`, and work there. Follow a direct request from the user to change this checkout.";

/// Guidance for a session whose working directory is inside a primary
/// checkout, or `None` for a linked worktree or unusable query output.
pub fn primary_checkout_session_context_v1(rev_parse_stdout: &str) -> Option<String> {
    let lines: Vec<&str> = rev_parse_stdout.lines().collect();
    let [toplevel, git_dir, common_dir, head] = lines.as_slice() else {
        return None;
    };
    if ![toplevel, git_dir, common_dir]
        .iter()
        .all(|path| absolute_git_path(path))
        || git_dir != common_dir
        || head.is_empty()
    {
        return None;
    }
    let branch = if *head == "HEAD" {
        "a detached HEAD"
    } else {
        head
    };
    Some(
        PRIMARY_CHECKOUT_SESSION_CONTEXT_TEMPLATE_V1
            .replace("{toplevel}", toplevel)
            .replace("{branch}", branch),
    )
}

/// Git prints absolute paths with forward slashes on every platform, including
/// a drive prefix on Windows.
fn absolute_git_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/')
        || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":/")
}

/// Claude-compatible `SessionStart` hook output carrying `context`.
pub fn session_start_additional_context_output_v1(context: &str) -> String {
    json!({"hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": context,
    }})
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rev_parse(toplevel: &str, git_dir: &str, common_dir: &str, head: &str) -> String {
        format!("{toplevel}\n{git_dir}\n{common_dir}\n{head}\n")
    }

    #[test]
    fn primary_checkout_names_its_root_and_branch() {
        let context = primary_checkout_session_context_v1(&rev_parse(
            "/work/dure",
            "/work/dure/.git",
            "/work/dure/.git",
            "main",
        ))
        .unwrap();
        assert!(context.starts_with(
            "Dure: This session started in the primary checkout of the Git repository at /work/dure (currently on main)."
        ));
        assert!(context.contains("git worktree add -b <branch> .worktrees/<name> <base>"));
        assert!(!context.contains('{'));
    }

    #[test]
    fn linked_worktree_receives_no_guidance() {
        assert_eq!(
            primary_checkout_session_context_v1(&rev_parse(
                "/work/dure/.worktrees/feature",
                "/work/dure/.git/worktrees/feature",
                "/work/dure/.git",
                "feature",
            )),
            None
        );
    }

    #[test]
    fn detached_head_is_named_as_such() {
        let context = primary_checkout_session_context_v1(&rev_parse(
            "/work/dure",
            "/work/dure/.git",
            "/work/dure/.git",
            "HEAD",
        ))
        .unwrap();
        assert!(context.contains("(currently on a detached HEAD)"));
    }

    #[test]
    fn windows_drive_paths_are_absolute() {
        let context = primary_checkout_session_context_v1(&rev_parse(
            "C:/work/dure",
            "C:/work/dure/.git",
            "C:/work/dure/.git",
            "main",
        ))
        .unwrap();
        assert!(context.contains("at C:/work/dure (currently on main)"));
    }

    #[test]
    fn incomplete_or_relative_output_receives_no_guidance() {
        for stdout in [
            "",
            "/work/dure\n/work/dure/.git\n/work/dure/.git\n",
            "/work/dure\n.git\n.git\nmain\n",
            "/work/dure\n/work/dure/.git\n/work/dure/.git\nmain\nextra\n",
        ] {
            assert_eq!(
                primary_checkout_session_context_v1(stdout),
                None,
                "{stdout:?}"
            );
        }
    }

    #[test]
    fn hook_output_is_session_start_additional_context() {
        let output: serde_json::Value =
            serde_json::from_str(&session_start_additional_context_output_v1("keep main")).unwrap();
        assert_eq!(
            output,
            json!({"hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": "keep main",
            }})
        );
    }

    #[test]
    fn query_arguments_list_the_four_lines_in_order() {
        assert_eq!(
            PRIMARY_CHECKOUT_REV_PARSE_ARGUMENTS_V1,
            [
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--git-dir",
                "--git-common-dir",
                "--abbrev-ref",
                "HEAD",
            ]
        );
    }
}
