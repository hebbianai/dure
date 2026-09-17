//! The GitHub backend of the issue-tracker host: `gh` argv for each query and
//! the parsing of `gh --json` output into the neutral issue contract.
//!
//! Everything here is pure — no process, no filesystem — so the host module
//! keeps process execution, permission leases, and watchers in one place and
//! this file can be tested with fixtures.
//!
//! Authentication is never ours: the user's `gh` holds the token (owner
//! decision 2026-08-02, see ghx.rs). The host only asks `gh auth status` and
//! `gh repo view` at activation so the failure it reports is the one the user
//! can act on, and every later command is pinned to the repository that
//! activation saw (`--repo host/owner/name`), so a remote retargeted after
//! activation cannot silently answer for another repository.

use dure_app::{
    IssueTrackerCountsV1, IssueTrackerIssueDetailV1, IssueTrackerIssueIdV1,
    IssueTrackerIssueSummaryV1, IssueTrackerQueryResultV1, IssueTrackerQueryV1,
    IssueTrackerWatchSnapshotV1, IssueTrackerWatchStateV1, ISSUE_TRACKER_QUERY_LIMIT_V1,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{IssueTrackerError, MAX_BODY_BYTES, MAX_SHORT_FIELD_BYTES, MAX_TITLE_BYTES};

/// Issue numbers are carried as `gh-<number>`: the issue id contract wants a
/// lowercase identifier that starts with a letter, and Beads already uses this
/// prefix for `--external-ref`. Issues and pull requests share one number
/// space per repository, so the prefix stays unambiguous when batch 2 adds
/// pull requests (their kind lives in `issue_type`).
const ISSUE_ID_PREFIX: &str = "gh-";
const MAX_ISSUE_NUMBER_DIGITS: usize = 12;
const ISSUE_TYPE: &str = "issue";
/// Only what the contract carries; batch 2 adds fields when a surface reads
/// them.
const ISSUE_FIELDS: &str = "number,title,state,assignees,updatedAt";
const ISSUE_DETAIL_FIELDS: &str = "number,title,state,assignees,updatedAt,body";

/// `gh auth status` exits non-zero when no account is logged in.
pub(super) const AUTH_STATUS_ARGUMENTS: [&str; 2] = ["auth", "status"];
/// `gh repo view` resolves the repository from the working directory's
/// remotes; it fails when there is no GitHub remote. `url` carries the host,
/// which `nameWithOwner` alone does not (GitHub Enterprise).
pub(super) const REPOSITORY_VIEW_ARGUMENTS: [&str; 4] =
    ["repo", "view", "--json", "nameWithOwner,url"];

pub(super) fn issue_id(number: u64) -> Result<IssueTrackerIssueIdV1, IssueTrackerError> {
    if number == 0 {
        return Err(IssueTrackerError::InvalidOutput);
    }
    IssueTrackerIssueIdV1::new(format!("{ISSUE_ID_PREFIX}{number}"))
        .map_err(|_| IssueTrackerError::InvalidOutput)
}

/// The positive number behind a `gh-<number>` id; a foreign prefix, zero, a
/// leading zero, or an overlong run of digits is a bad request.
pub(super) fn issue_number(id: &IssueTrackerIssueIdV1) -> Result<u64, IssueTrackerError> {
    let digits = id
        .as_str()
        .strip_prefix(ISSUE_ID_PREFIX)
        .ok_or(IssueTrackerError::InvalidRequest)?;
    let canonical = !digits.is_empty()
        && digits.len() <= MAX_ISSUE_NUMBER_DIGITS
        && !digits.starts_with('0')
        && digits.bytes().all(|byte| byte.is_ascii_digit());
    if !canonical {
        return Err(IssueTrackerError::InvalidRequest);
    }
    digits
        .parse()
        .map_err(|_| IssueTrackerError::InvalidRequest)
}

/// `--state` for a status filter. GitHub knows `open` and `closed`; any
/// other token is not a GitHub status and the query is unsupported rather than
/// silently widened.
fn state_filter(statuses: &[String]) -> Result<&'static str, IssueTrackerError> {
    let mut open = false;
    let mut closed = false;
    for status in statuses {
        match status.as_str() {
            "open" => open = true,
            "closed" => closed = true,
            _ => return Err(IssueTrackerError::UnsupportedOperation),
        }
    }
    Ok(match (open, closed) {
        (true, true) => "all",
        (false, true) => "closed",
        _ => "open",
    })
}

fn list_arguments(
    repository: &str,
    state: &str,
    assignee: Option<&str>,
    limit: u16,
) -> Vec<String> {
    let mut arguments: Vec<String> = vec![
        "issue".into(),
        "list".into(),
        "--repo".into(),
        repository.into(),
        "--state".into(),
        state.into(),
    ];
    if let Some(assignee) = assignee {
        arguments.extend(["--assignee".into(), assignee.into()]);
    }
    // One row past the visible limit is the completeness probe the Beads
    // backend uses as well: enough to say `complete` truthfully, never the
    // whole tracker.
    arguments.extend([
        "--limit".into(),
        limit.saturating_add(1).to_string(),
        "--json".into(),
        ISSUE_FIELDS.into(),
    ]);
    arguments
}

/// Argv for one query against the repository activation pinned.
pub(super) fn command_arguments(
    query: &IssueTrackerQueryV1,
    repository: &str,
) -> Result<Vec<String>, IssueTrackerError> {
    Ok(match query {
        IssueTrackerQueryV1::List { limit } => list_arguments(repository, "open", None, *limit),
        // "Ready" is the neutral reading of "actionable for the current
        // actor"; on GitHub that is the open issues assigned to the gh user.
        // The view names it "Assigned to me" through the plugin's query titles.
        IssueTrackerQueryV1::Ready { limit } => {
            list_arguments(repository, "open", Some("@me"), *limit)
        }
        IssueTrackerQueryV1::ListByStatus { statuses, limit } => {
            list_arguments(repository, state_filter(statuses)?, None, *limit)
        }
        IssueTrackerQueryV1::Show { issue_id } => vec![
            "issue".into(),
            "view".into(),
            issue_number(issue_id)?.to_string(),
            "--repo".into(),
            repository.into(),
            "--json".into(),
            ISSUE_DETAIL_FIELDS.into(),
        ],
        // No agent binding is declared and GitHub has no "needs a human"
        // state, so neither query has a truthful answer here.
        IssueTrackerQueryV1::AgentClaims { .. } | IssueTrackerQueryV1::Human { .. } => {
            return Err(IssueTrackerError::UnsupportedOperation);
        }
        // Counts are two search calls, not one list; the host routes them
        // through `counts_arguments`.
        IssueTrackerQueryV1::Counts => return Err(IssueTrackerError::InvalidRequest),
    })
}

/// Exact tab counts come from the search API's `total_count` — listing
/// cannot count past its page. One call per tab: open issues, and open
/// issues assigned to the user. `per_page=1` keeps the payload to the count.
pub(super) fn counts_arguments(repository: &str) -> Result<[Vec<String>; 2], IssueTrackerError> {
    let (host, name_with_owner) = repository
        .split_once('/')
        .ok_or(IssueTrackerError::ActivationRequired)?;
    let search = |query: &str| -> Vec<String> {
        vec![
            "api".into(),
            "--hostname".into(),
            host.into(),
            "--method".into(),
            "GET".into(),
            "search/issues".into(),
            "-f".into(),
            format!("q=repo:{name_with_owner} is:issue {query}"),
            "-f".into(),
            "per_page=1".into(),
        ]
    };
    Ok([search("is:open"), search("is:open assignee:@me")])
}

#[derive(Debug, Deserialize)]
struct RawSearchTotal {
    total_count: u64,
}

fn search_total(output: &[u8]) -> Result<u32, IssueTrackerError> {
    let total: RawSearchTotal =
        serde_json::from_slice(output).map_err(|_| IssueTrackerError::InvalidOutput)?;
    u32::try_from(total.total_count).map_err(|_| IssueTrackerError::InvalidOutput)
}

/// GitHub has no blocked state, so that tab counts zero rather than
/// guessing from labels.
pub(super) fn parse_counts(
    open_output: &[u8],
    assigned_output: &[u8],
) -> Result<IssueTrackerQueryResultV1, IssueTrackerError> {
    Ok(IssueTrackerQueryResultV1::Counts {
        counts: IssueTrackerCountsV1 {
            ready: search_total(assigned_output)?,
            open: search_total(open_output)?,
            blocked: 0,
        },
    })
}

/// One watch cycle reads both lists the view can show — open issues and the
/// ones assigned to the user — so an assignment that happens past the capped
/// open page still changes the snapshot. `human` has no GitHub equivalent.
pub(super) fn watch_arguments(repository: &str) -> [Vec<String>; 2] {
    [
        list_arguments(repository, "open", None, ISSUE_TRACKER_QUERY_LIMIT_V1),
        list_arguments(
            repository,
            "open",
            Some("@me"),
            ISSUE_TRACKER_QUERY_LIMIT_V1,
        ),
    ]
}

#[derive(Debug, Deserialize)]
struct RawRepository {
    #[serde(rename = "nameWithOwner")]
    name_with_owner: String,
    url: String,
}

fn valid_repository_segment(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

/// `host/owner/name` from `gh repo view --json nameWithOwner,url` — the form
/// `--repo` accepts, host-qualified so an Enterprise repository cannot
/// collide with its github.com namesake.
pub(super) fn parse_repository(output: &[u8]) -> Result<String, IssueTrackerError> {
    let repository: RawRepository =
        serde_json::from_slice(output).map_err(|_| IssueTrackerError::InvalidOutput)?;
    let name_with_owner = repository.name_with_owner;
    let host = repository
        .url
        .strip_prefix("https://")
        .and_then(|rest| rest.split('/').next())
        .ok_or(IssueTrackerError::InvalidOutput)?;
    let valid = name_with_owner.len() <= MAX_SHORT_FIELD_BYTES
        && host.len() <= MAX_SHORT_FIELD_BYTES
        && valid_repository_segment(host)
        && name_with_owner
            .split_once('/')
            .is_some_and(|(owner, name)| {
                valid_repository_segment(owner) && valid_repository_segment(name)
            });
    if !valid {
        return Err(IssueTrackerError::InvalidOutput);
    }
    Ok(format!("{host}/{name_with_owner}"))
}

#[derive(Debug, Deserialize)]
struct RawActor {
    login: String,
}

#[derive(Debug, Deserialize)]
struct RawIssue {
    number: u64,
    title: String,
    state: String,
    #[serde(default)]
    assignees: Vec<RawActor>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
    #[serde(default)]
    body: Option<String>,
}

fn parse_issues(output: &[u8]) -> Result<Vec<RawIssue>, IssueTrackerError> {
    serde_json::from_slice(output).map_err(|_| IssueTrackerError::InvalidOutput)
}

fn validate_text(value: &str, maximum: usize) -> Result<(), IssueTrackerError> {
    if value.is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        return Err(IssueTrackerError::InvalidOutput);
    }
    Ok(())
}

fn summary(raw: &RawIssue) -> Result<IssueTrackerIssueSummaryV1, IssueTrackerError> {
    validate_text(&raw.title, MAX_TITLE_BYTES)?;
    // gh reports states in upper case (`OPEN`); the contract carries the
    // lower-case status tokens the status filter accepts.
    let status = match raw.state.as_str() {
        "OPEN" | "open" => "open",
        "CLOSED" | "closed" => "closed",
        _ => return Err(IssueTrackerError::InvalidOutput),
    };
    // The contract has one assignee slot; GitHub allows several. The first
    // one is shown, the rest wait for a contract that can carry a list.
    let assignee = raw.assignees.first().map(|actor| actor.login.clone());
    if let Some(assignee) = &assignee {
        validate_text(assignee, MAX_SHORT_FIELD_BYTES)?;
    }
    if let Some(updated_at) = &raw.updated_at {
        validate_text(updated_at, MAX_SHORT_FIELD_BYTES)?;
    }
    Ok(IssueTrackerIssueSummaryV1 {
        id: issue_id(raw.number)?,
        title: raw.title.clone(),
        status: status.to_owned(),
        // GitHub has no priority field; labels are not folded into one.
        priority: None,
        issue_type: ISSUE_TYPE.to_owned(),
        assignee,
        updated_at: raw.updated_at.clone(),
        dependency_count: 0,
        dependent_count: 0,
        agent_binding: None,
    })
}

fn detail(raw: RawIssue) -> Result<IssueTrackerIssueDetailV1, IssueTrackerError> {
    let summary = summary(&raw)?;
    let description = raw.body.filter(|body| !body.is_empty());
    if let Some(description) = &description {
        if description.len() > MAX_BODY_BYTES {
            return Err(IssueTrackerError::InvalidOutput);
        }
    }
    Ok(IssueTrackerIssueDetailV1 {
        summary,
        description,
        design: None,
        acceptance_criteria: None,
        notes: None,
    })
}

/// Rows up to the visible limit plus whether the probe row past it existed.
fn list_page(
    output: &[u8],
    limit: u16,
) -> Result<(Vec<IssueTrackerIssueSummaryV1>, bool), IssueTrackerError> {
    let raw = parse_issues(output)?;
    let maximum = usize::from(limit);
    if raw.len() > maximum.saturating_add(1) {
        return Err(IssueTrackerError::InvalidOutput);
    }
    let complete = raw.len() <= maximum;
    let issues = raw
        .iter()
        .take(maximum)
        .map(summary)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((issues, complete))
}

pub(super) fn parse_query_output(
    query: &IssueTrackerQueryV1,
    output: &[u8],
) -> Result<IssueTrackerQueryResultV1, IssueTrackerError> {
    query
        .validate()
        .map_err(|_| IssueTrackerError::InvalidRequest)?;
    match query {
        IssueTrackerQueryV1::Ready { limit } => {
            let (issues, complete) = list_page(output, *limit)?;
            Ok(IssueTrackerQueryResultV1::Ready {
                issues,
                complete: Some(complete),
            })
        }
        IssueTrackerQueryV1::List { limit } | IssueTrackerQueryV1::ListByStatus { limit, .. } => {
            let (issues, complete) = list_page(output, *limit)?;
            Ok(IssueTrackerQueryResultV1::List {
                issues,
                complete: Some(complete),
            })
        }
        IssueTrackerQueryV1::Show { issue_id } => {
            let raw: RawIssue =
                serde_json::from_slice(output).map_err(|_| IssueTrackerError::InvalidOutput)?;
            if raw.number != issue_number(issue_id)? {
                return Err(IssueTrackerError::InvalidOutput);
            }
            Ok(IssueTrackerQueryResultV1::Show {
                issue: Box::new(detail(raw)?),
            })
        }
        IssueTrackerQueryV1::AgentClaims { .. } | IssueTrackerQueryV1::Human { .. } => {
            Err(IssueTrackerError::UnsupportedOperation)
        }
        IssueTrackerQueryV1::Counts => Err(IssueTrackerError::InvalidRequest),
    }
}

/// One watch snapshot from the two lists a cycle reads. The snapshot carries
/// the open issues; the assigned list only feeds the revision digest, so a
/// change visible in "Assigned to me" alone still wakes the view. Human
/// completeness is `None`: GitHub has no such list, and "complete and empty"
/// would claim it looked.
pub(super) fn watch_state(
    list_output: &[u8],
    assigned_output: &[u8],
) -> Result<IssueTrackerWatchStateV1, IssueTrackerError> {
    let (issues, complete) = list_page(list_output, ISSUE_TRACKER_QUERY_LIMIT_V1)?;
    list_page(assigned_output, ISSUE_TRACKER_QUERY_LIMIT_V1)?;
    let mut digest = Sha256::new();
    digest.update(b"dure.issue-tracker.watch.v1\0github\0list\0");
    digest.update(list_output);
    digest.update(b"\0assigned\0");
    digest.update(assigned_output);
    Ok(IssueTrackerWatchStateV1::Snapshot {
        revision_digest: format!("{:x}", digest.finalize()),
        snapshot: IssueTrackerWatchSnapshotV1 {
            issues,
            issues_complete: Some(complete),
            human_issues: Vec::new(),
            human_issues_complete: None,
            agent_claim_issues: None,
            agent_claim_issues_complete: None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPOSITORY: &str = "github.com/o/r";

    fn issue(number: u64, state: &str, assignees: &[&str]) -> String {
        let assignees = assignees
            .iter()
            .map(|login| format!(r#"{{"login":"{login}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            r#"{{"number":{number},"title":"Issue {number}","state":"{state}","assignees":[{assignees}],"updatedAt":"2026-09-03T00:00:00Z"}}"#
        )
    }

    fn list(issues: &[String]) -> Vec<u8> {
        format!("[{}]", issues.join(",")).into_bytes()
    }

    #[test]
    fn ids_carry_the_number_behind_a_stable_prefix() {
        let id = issue_id(42).unwrap();
        assert_eq!(id.as_str(), "gh-42");
        assert_eq!(issue_number(&id).unwrap(), 42);
        assert_eq!(issue_id(0), Err(IssueTrackerError::InvalidOutput));
        for bad in [
            "hebbian-frontend-1abc",
            "gh-0",
            "gh-007",
            "gh-1234567890123",
            "gh-x1",
        ] {
            let foreign = IssueTrackerIssueIdV1::new(bad).unwrap();
            assert_eq!(
                issue_number(&foreign),
                Err(IssueTrackerError::InvalidRequest),
                "{bad}"
            );
        }
    }

    #[test]
    fn queries_map_to_bounded_gh_argv_pinned_to_the_repository() {
        let list = command_arguments(&IssueTrackerQueryV1::List { limit: 50 }, REPOSITORY).unwrap();
        assert_eq!(
            list,
            [
                "issue",
                "list",
                "--repo",
                REPOSITORY,
                "--state",
                "open",
                "--limit",
                "51",
                "--json",
                ISSUE_FIELDS
            ]
        );
        let ready =
            command_arguments(&IssueTrackerQueryV1::Ready { limit: 10 }, REPOSITORY).unwrap();
        assert_eq!(
            &ready[..8],
            [
                "issue",
                "list",
                "--repo",
                REPOSITORY,
                "--state",
                "open",
                "--assignee",
                "@me"
            ]
        );
        assert_eq!(&ready[8..], ["--limit", "11", "--json", ISSUE_FIELDS]);
        let closed = command_arguments(
            &IssueTrackerQueryV1::ListByStatus {
                statuses: vec!["closed".into()],
                limit: 5,
            },
            REPOSITORY,
        )
        .unwrap();
        assert_eq!(&closed[4..6], ["--state", "closed"]);
        let both = command_arguments(
            &IssueTrackerQueryV1::ListByStatus {
                statuses: vec!["open".into(), "closed".into()],
                limit: 5,
            },
            REPOSITORY,
        )
        .unwrap();
        assert_eq!(&both[4..6], ["--state", "all"]);
        let show = command_arguments(
            &IssueTrackerQueryV1::Show {
                issue_id: issue_id(7).unwrap(),
            },
            REPOSITORY,
        )
        .unwrap();
        assert_eq!(
            show,
            [
                "issue",
                "view",
                "7",
                "--repo",
                REPOSITORY,
                "--json",
                ISSUE_DETAIL_FIELDS
            ]
        );
        let [open, assigned] = watch_arguments(REPOSITORY);
        assert_eq!(
            &open[..6],
            ["issue", "list", "--repo", REPOSITORY, "--state", "open"]
        );
        assert_eq!(&assigned[6..8], ["--assignee", "@me"]);
        assert_eq!(assigned[9], (ISSUE_TRACKER_QUERY_LIMIT_V1 + 1).to_string());
    }

    #[test]
    fn counts_are_two_search_totals_and_blocked_is_zero() {
        let [open, assigned] = counts_arguments(REPOSITORY).unwrap();
        assert_eq!(
            open,
            [
                "api", "--hostname", "github.com", "--method", "GET", "search/issues", "-f",
                "q=repo:o/r is:issue is:open", "-f", "per_page=1"
            ]
        );
        assert_eq!(assigned[7], "q=repo:o/r is:issue is:open assignee:@me");
        let IssueTrackerQueryResultV1::Counts { counts } = parse_counts(
            br#"{"total_count":41,"incomplete_results":false,"items":[]}"#,
            br#"{"total_count":3,"incomplete_results":false,"items":[]}"#,
        )
        .unwrap() else {
            panic!("counts query yields counts");
        };
        assert_eq!((counts.ready, counts.open, counts.blocked), (3, 41, 0));
        assert_eq!(
            parse_counts(b"[]", b"{}"),
            Err(IssueTrackerError::InvalidOutput)
        );
        assert_eq!(
            command_arguments(&IssueTrackerQueryV1::Counts, REPOSITORY),
            Err(IssueTrackerError::InvalidRequest)
        );
        assert_eq!(
            parse_query_output(&IssueTrackerQueryV1::Counts, b"{}"),
            Err(IssueTrackerError::InvalidRequest)
        );
    }

    #[test]
    fn queries_github_cannot_answer_are_unsupported_not_widened() {
        for query in [
            IssueTrackerQueryV1::ListByStatus {
                statuses: vec!["in_progress".into()],
                limit: 5,
            },
            IssueTrackerQueryV1::Human { limit: 5 },
            IssueTrackerQueryV1::AgentClaims {
                statuses: vec!["open".into()],
                limit: 5,
            },
        ] {
            assert_eq!(
                command_arguments(&query, REPOSITORY),
                Err(IssueTrackerError::UnsupportedOperation)
            );
        }
    }

    #[test]
    fn a_list_reports_completeness_from_the_probe_row() {
        let query = IssueTrackerQueryV1::List { limit: 2 };
        let IssueTrackerQueryResultV1::List { issues, complete } = parse_query_output(
            &query,
            &list(&[
                issue(1, "OPEN", &["octocat", "hubot"]),
                issue(2, "OPEN", &[]),
            ]),
        )
        .unwrap() else {
            panic!("list query yields a list");
        };
        assert_eq!(complete, Some(true));
        assert_eq!(issues.len(), 2);
        assert_eq!(issues[0].id.as_str(), "gh-1");
        assert_eq!(issues[0].status, "open");
        assert_eq!(issues[0].assignee.as_deref(), Some("octocat"));
        assert_eq!(issues[0].issue_type, "issue");
        assert_eq!(issues[0].priority, None);
        assert_eq!(issues[1].assignee, None);

        let IssueTrackerQueryResultV1::List { issues, complete } = parse_query_output(
            &query,
            &list(&[
                issue(1, "OPEN", &[]),
                issue(2, "OPEN", &[]),
                issue(3, "OPEN", &[]),
            ]),
        )
        .unwrap() else {
            panic!("list query yields a list");
        };
        assert_eq!(complete, Some(false));
        assert_eq!(issues.len(), 2);

        assert_eq!(
            parse_query_output(
                &query,
                &list(&[
                    issue(1, "OPEN", &[]),
                    issue(2, "OPEN", &[]),
                    issue(3, "OPEN", &[]),
                    issue(4, "OPEN", &[])
                ]),
            ),
            Err(IssueTrackerError::InvalidOutput)
        );
        assert_eq!(
            parse_query_output(&query, b"not json"),
            Err(IssueTrackerError::InvalidOutput)
        );
    }

    #[test]
    fn show_requires_the_requested_number_and_carries_the_body() {
        let query = IssueTrackerQueryV1::Show {
            issue_id: issue_id(9).unwrap(),
        };
        let raw = issue(9, "CLOSED", &[]).replace(
            r#""updatedAt":"2026-09-03T00:00:00Z""#,
            r##""updatedAt":"2026-09-03T00:00:00Z","body":"Why""##,
        );
        let IssueTrackerQueryResultV1::Show { issue: shown } =
            parse_query_output(&query, raw.as_bytes()).unwrap()
        else {
            panic!("show query yields a detail");
        };
        assert_eq!(shown.summary.status, "closed");
        assert_eq!(shown.description.as_deref(), Some("Why"));
        assert_eq!(
            parse_query_output(&query, issue(10, "OPEN", &[]).as_bytes()),
            Err(IssueTrackerError::InvalidOutput)
        );
    }

    #[test]
    fn unknown_states_and_zero_numbers_are_rejected() {
        assert_eq!(
            parse_query_output(
                &IssueTrackerQueryV1::List { limit: 5 },
                &list(&[issue(1, "MERGED", &[])]),
            ),
            Err(IssueTrackerError::InvalidOutput)
        );
        assert_eq!(
            parse_query_output(
                &IssueTrackerQueryV1::List { limit: 5 },
                &list(&[issue(0, "OPEN", &[])]),
            ),
            Err(IssueTrackerError::InvalidOutput)
        );
    }

    #[test]
    fn watch_state_digests_both_lists_and_claims_no_human_list() {
        let open = list(&[issue(1, "OPEN", &[])]);
        let assigned = list(&[]);
        let IssueTrackerWatchStateV1::Snapshot {
            revision_digest,
            snapshot,
        } = watch_state(&open, &assigned).unwrap()
        else {
            panic!("watch yields a snapshot");
        };
        assert_eq!(snapshot.issues.len(), 1);
        assert_eq!(snapshot.issues_complete, Some(true));
        assert!(snapshot.human_issues.is_empty());
        assert_eq!(snapshot.human_issues_complete, None);
        assert_eq!(snapshot.agent_claim_issues, None);
        let digest_of = |open: &[u8], assigned: &[u8]| match watch_state(open, assigned).unwrap() {
            IssueTrackerWatchStateV1::Snapshot {
                revision_digest, ..
            } => revision_digest,
            IssueTrackerWatchStateV1::Unavailable { .. } => panic!("watch yields a snapshot"),
        };
        assert_eq!(digest_of(&open, &assigned), revision_digest);
        // An assignment past the open page changes only the assigned list —
        // and still the digest.
        assert_ne!(
            digest_of(&open, &list(&[issue(500, "OPEN", &["me"])])),
            revision_digest
        );
        assert_ne!(
            digest_of(&list(&[issue(2, "OPEN", &[])]), &assigned),
            revision_digest
        );
    }

    #[test]
    fn repository_view_yields_a_host_qualified_name() {
        assert_eq!(
            parse_repository(
                br#"{"nameWithOwner":"hebbianai/dure-internal","url":"https://github.com/hebbianai/dure-internal"}"#
            )
            .unwrap(),
            "github.com/hebbianai/dure-internal"
        );
        assert_eq!(
            parse_repository(
                br#"{"nameWithOwner":"team/app","url":"https://ghe.example.com/team/app"}"#
            )
            .unwrap(),
            "ghe.example.com/team/app"
        );
        for bad in [
            &br#"{"nameWithOwner":"","url":"https://github.com/"}"#[..],
            br#"{"nameWithOwner":"noslash","url":"https://github.com/noslash"}"#,
            br#"{"nameWithOwner":"a/b/c","url":"https://github.com/a/b/c"}"#,
            br#"{"nameWithOwner":"a/ b","url":"https://github.com/a/%20b"}"#,
            br#"{"nameWithOwner":"a/b","url":"http://github.com/a/b"}"#,
            br#"{"nameWithOwner":"a/b"}"#,
            b"not json",
        ] {
            assert_eq!(
                parse_repository(bad),
                Err(IssueTrackerError::InvalidOutput),
                "{}",
                String::from_utf8_lossy(bad)
            );
        }
    }
}
