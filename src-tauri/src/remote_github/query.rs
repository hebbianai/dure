use crate::ghx::{GhExecOut, NON_INTERACTIVE_ENVIRONMENT};
use hebbian_bounded_process::{CommandSpec, OutputLimitAction};
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

const UNSUPPORTED: &str = "Dure desktop GitHub supports only this project's gh issue list/view reads (including --comments and --json). Writes, auth commands, templates and other repositories are unavailable.\n";
const FIELDS: &[&str] = &[
    "assignees",
    "author",
    "body",
    "closed",
    "closedAt",
    "comments",
    "createdAt",
    "id",
    "labels",
    "milestone",
    "number",
    "projectCards",
    "projectItems",
    "reactionGroups",
    "state",
    "stateReason",
    "title",
    "updatedAt",
    "url",
];

/// Only github.com is admitted; an arbitrary origin cannot receive a locally
/// configured enterprise token. Enterprise hosts need explicit host authority.
pub(super) fn repository(value: &str) -> Option<String> {
    let path = [
        "https://github.com/",
        "ssh://git@github.com/",
        "git@github.com:",
        "github.com/",
    ]
    .iter()
    .find_map(|prefix| value.strip_prefix(prefix))?;
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || part.len() > 100
                || matches!(*part, "." | "..")
                || part.starts_with('-')
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
    {
        return None;
    }
    Some(format!("github.com/{path}"))
}

fn same_repository(value: &str, pinned: &str) -> bool {
    repository(value)
        .or_else(|| repository(&format!("github.com/{value}")))
        .is_some_and(|value| value.eq_ignore_ascii_case(pinned))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    schema_version: u8,
    args: Vec<String>,
}

fn arguments(pinned: &str, request: Value) -> Option<Vec<String>> {
    let request: Request = serde_json::from_value(request).ok()?;
    let args = request.args;
    if request.schema_version != 1
        || args.len() < 2
        || args.len() > 64
        || args[0] != "issue"
        || !matches!(args[1].as_str(), "list" | "view")
        || args
            .iter()
            .any(|arg| arg.len() > 2000 || arg.chars().any(char::is_control))
    {
        return None;
    }
    let list = args[1] == "list";
    let mut output = vec![
        "issue".into(),
        args[1].clone(),
        "--repo".into(),
        pinned.into(),
    ];
    let mut number = None;
    let mut limit = false;
    let mut index = 2;
    while index < args.len() {
        let word = &args[index];
        let (flag, inline) = word
            .split_once('=')
            .map_or((word.as_str(), None), |(flag, value)| (flag, Some(value)));
        if matches!(flag, "--comments" | "-c") && !list && inline.is_none() {
            output.push("--comments".into());
        } else if matches!(flag, "--repo" | "-R" | "--json")
            || (list
                && matches!(
                    flag,
                    "--state"
                        | "-s"
                        | "--limit"
                        | "-L"
                        | "--search"
                        | "-S"
                        | "--assignee"
                        | "-a"
                        | "--author"
                        | "-A"
                        | "--label"
                        | "-l"
                        | "--milestone"
                        | "-m"
                ))
        {
            let value = match inline {
                Some(value) => value,
                None => {
                    index += 1;
                    args.get(index)?.as_str()
                }
            };
            if value.is_empty() {
                return None;
            }
            match flag {
                "--repo" | "-R" => {
                    if !same_repository(value, pinned) {
                        return None;
                    }
                }
                "--search" | "-S" => {
                    // ponytail: accept plain text only. GitHub's full search grammar
                    // can widen repository qualifiers; add typed filters instead.
                    if !value
                        .chars()
                        .all(|character| character.is_alphanumeric() || " _.-".contains(character))
                        || value.split_whitespace().any(|word| {
                            matches!(word.to_ascii_uppercase().as_str(), "AND" | "OR" | "NOT")
                        })
                    {
                        return None;
                    }
                    output.push(format!("--search={value}"));
                }
                "--json" => {
                    if !value.split(',').all(|field| FIELDS.contains(&field)) {
                        return None;
                    }
                    output.extend(["--json".into(), value.into()]);
                }
                "--limit" | "-L" => {
                    let count: u16 = value.parse().ok()?;
                    if !(1..=100).contains(&count) {
                        return None;
                    }
                    limit = true;
                    output.extend(["--limit".into(), count.to_string()]);
                }
                "--state" | "-s" if !matches!(value, "open" | "closed" | "all") => return None,
                _ if value.contains(['(', ')', '\\']) => return None,
                _ => output.push(format!("{flag}={value}")),
            }
        } else if !list && number.is_none() && inline.is_none() {
            let value = word
                .strip_prefix(&format!("https://{pinned}/issues/"))
                .unwrap_or(word);
            let parsed: u64 = value.parse().ok()?;
            if parsed == 0 || parsed > i32::MAX as u64 {
                return None;
            }
            number = Some(parsed);
            output.push(parsed.to_string());
        } else {
            return None;
        }
        index += 1;
    }
    if !list && number.is_none() {
        return None;
    }
    if list && !limit {
        output.extend(["--limit".into(), "30".into()]);
    }
    Some(output)
}

pub(super) fn execute(pinned: &str, request: Value) -> GhExecOut {
    let Some(args) = arguments(pinned, request) else {
        return failure(UNSUPPORTED);
    };
    let mut command = CommandSpec::new("gh");
    command.clear_env();
    for (key, value) in std::env::vars_os() {
        // A debug dump must never copy local authorization headers to the SSH host.
        if key != "GH_DEBUG" && key != "GH_REPO" && !key.to_string_lossy().starts_with("GIT_") {
            command.env(key, value);
        }
    }
    for (key, value) in NON_INTERACTIVE_ENVIRONMENT {
        command.env(key, value);
    }
    command
        .args(args)
        .current_dir(std::env::temp_dir())
        .capture_stderr(true)
        .on_output_limit(OutputLimitAction::TerminateProcessTree);
    match hebbian_bounded_process::run(&command, Duration::from_secs(20), 256 * 1024) {
        Ok(output) if !output.exceeded_limit => GhExecOut {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: if output.status.code() == Some(4) {
                format!("{}\nSign in with gh auth login on the Dure desktop.\n", String::from_utf8_lossy(&output.stderr))
            } else {
                String::from_utf8_lossy(&output.stderr).into_owned()
            },
            code: output.status.code().unwrap_or(1),
            ..Default::default()
        },
        Ok(_) => failure("Dure GitHub response exceeded the size limit. Narrow the query or JSON fields.\n"),
        Err(error) => failure(&format!("Dure desktop gh failed ({}). Check gh installation/login on the desktop, or narrow the query.\n", error.stage())),
    }
}

fn failure(message: &str) -> GhExecOut {
    GhExecOut {
        stderr: message.into(),
        code: 1,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(args: &[&str]) -> Option<Vec<String>> {
        arguments(
            "github.com/owner/repo",
            json!({"schemaVersion": 1, "args": args}),
        )
    }

    #[test]
    fn pins_reads_and_retains_comment_and_json_options() {
        assert_eq!(
            parse(&[
                "issue",
                "view",
                "123",
                "--comments",
                "--json",
                "body,comments"
            ]),
            Some(
                vec![
                    "issue",
                    "view",
                    "--repo",
                    "github.com/owner/repo",
                    "123",
                    "--comments",
                    "--json",
                    "body,comments"
                ]
                .into_iter()
                .map(String::from)
                .collect()
            )
        );
        assert!(parse(&[
            "issue",
            "list",
            "--repo",
            "owner/repo",
            "--search",
            "focus regression",
            "--limit=100"
        ])
        .is_some());
        assert!(parse(&["issue", "view", "https://github.com/owner/repo/issues/4"]).is_some());
        assert!(parse(&["issue", "list", "--search", "원격 이슈"]).is_some());
        assert!(parse(&["issue", "list"])
            .unwrap()
            .ends_with(&["--limit".into(), "30".into()]));
    }

    #[test]
    fn rejects_writes_cross_repository_options_and_unbounded_queries() {
        for args in [
            vec!["auth", "token"],
            vec!["api", "user"],
            vec!["issue", "close", "1"],
            vec!["issue", "view", "1", "--repo", "other/repo"],
            vec!["issue", "view", "https://github.com/other/repo/issues/1"],
            vec!["issue", "view", "1", "--web"],
            vec!["issue", "view", "1", "--template", "x"],
            vec!["issue", "list", "--limit", "101"],
            vec!["issue", "list", "--limit", "0"],
            vec!["issue", "list", "--json", "bad"],
            vec!["issue", "list", "--state", "bad"],
            vec!["issue", "list", "--search", "repo:other/repo"],
            vec!["issue", "list", "--search", "focus OR keyboard"],
            vec!["issue", "list", "--search", "(focus)"],
            vec!["issue", "list", "--label", "x)OR(repo:other/repo"],
            vec!["issue", "view"],
            vec!["issue", "view", "0"],
            vec!["issue", "view", "1", "2"],
            vec!["issue", "list", "--search", "x\n--repo=other/repo"],
        ] {
            assert!(parse(&args).is_none(), "{args:?}");
        }
        assert!(arguments(
            "github.com/owner/repo",
            json!({"schemaVersion": 2, "args": ["issue", "list"]})
        )
        .is_none());
        assert!(arguments(
            "github.com/owner/repo",
            json!({"schemaVersion": 1, "args": ["issue", "list"], "cwd": "/tmp"})
        )
        .is_none());
    }

    #[test]
    fn origin_parsing_does_not_grant_arbitrary_host_authority() {
        for value in [
            "git@github.com:owner/repo.git",
            "https://github.com/owner/repo.git",
            "ssh://git@github.com/owner/repo.git",
        ] {
            assert_eq!(repository(value).as_deref(), Some("github.com/owner/repo"));
        }
        for value in [
            "https://example.com/owner/repo",
            "https://github.com.evil/owner/repo",
            "https://token@github.com/owner/repo",
            "https://github.com/../repo",
            "git@github.com:owner/repo.git\n",
            "github.com/owner/repo?token=x",
        ] {
            assert!(repository(value).is_none(), "{value}");
        }
    }
}
