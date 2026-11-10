//! Advisory work claims. A holder, usually one Dure session, declares the
//! issue, branch, worktree and repository paths it is working on so that
//! others can see overlaps before they start. A claim never locks anything.

use serde::{Deserialize, Serialize};

use crate::DomainStoreErrorV1;

pub const WORK_CLAIM_SCHEMA_VERSION_V1: u16 = 1;
pub const MAX_WORK_CLAIM_PATHS_V1: usize = 32;
/// Rows one list response carries; `complete` is false when more exist.
pub const MAX_WORK_CLAIMS_LISTED_V1: usize = 256;

const MAX_REPOSITORY_BYTES: usize = 4096;
const MAX_TOKEN_BYTES: usize = 160;
const MAX_BRANCH_BYTES: usize = 512;
const MAX_WORKTREE_BYTES: usize = 4096;
const MAX_PATH_PATTERN_BYTES: usize = 512;
const MAX_NOTE_BYTES: usize = 1024;

/// What a holder declares. `repository` groups claims that can overlap: the
/// CLI sends the repository's shared Git directory so every worktree of one
/// repository lands in the same group. Path patterns are relative to the
/// repository root and use `/`, `*`, `?` and `**`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkClaimV1 {
    pub repository: String,
    pub holder: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub issue: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub worktree: Option<String>,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub note: Option<String>,
}

impl WorkClaimV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        text("repository", &self.repository, MAX_REPOSITORY_BYTES)?;
        text("holder", &self.holder, MAX_TOKEN_BYTES)?;
        if self.holder.trim() != self.holder {
            return Err(invalid("holder", "must not start or end with whitespace"));
        }
        optional_text("sessionId", self.session_id.as_deref(), MAX_TOKEN_BYTES)?;
        optional_text("workspaceId", self.workspace_id.as_deref(), MAX_TOKEN_BYTES)?;
        optional_text("issue", self.issue.as_deref(), MAX_TOKEN_BYTES)?;
        optional_text("branch", self.branch.as_deref(), MAX_BRANCH_BYTES)?;
        optional_text("worktree", self.worktree.as_deref(), MAX_WORKTREE_BYTES)?;
        optional_text("note", self.note.as_deref(), MAX_NOTE_BYTES)?;
        if self.paths.len() > MAX_WORK_CLAIM_PATHS_V1 {
            return Err(invalid("paths", "must contain at most 32 patterns"));
        }
        for (index, pattern) in self.paths.iter().enumerate() {
            validate_path_pattern(pattern)?;
            if self.paths[..index].contains(pattern) {
                return Err(invalid("paths", "must not repeat a pattern"));
            }
        }
        if self.issue.is_none()
            && self.branch.is_none()
            && self.worktree.is_none()
            && self.paths.is_empty()
        {
            return Err(invalid(
                "claim",
                "must name an issue, a branch, a worktree or at least one path",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkClaimRecordV1 {
    pub schema_version: u16,
    pub claim: WorkClaimV1,
    pub claimed_at_ms: i64,
    pub updated_at_ms: i64,
}

/// Replaces the holder's claim in its repository. `dry_run` reports the
/// overlaps the claim would have without recording it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkClaimPutRequestV1 {
    pub schema_version: u16,
    pub claim: WorkClaimV1,
    #[serde(default)]
    pub dry_run: bool,
}

impl WorkClaimPutRequestV1 {
    pub fn validate(&self) -> Result<(), DomainStoreErrorV1> {
        if self.schema_version != WORK_CLAIM_SCHEMA_VERSION_V1 {
            return Err(invalid("schemaVersion", "unsupported work claim schema"));
        }
        self.claim.validate()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkClaimOverlapReasonV1 {
    Issue,
    Branch,
    Worktree,
    Paths,
}

/// One pair of patterns that can name the same file: `mine` from the claim
/// being made, `theirs` from the claim already held.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkClaimPathOverlapV1 {
    pub mine: String,
    pub theirs: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkClaimOverlapV1 {
    pub held: WorkClaimRecordV1,
    pub reasons: Vec<WorkClaimOverlapReasonV1>,
    pub paths: Vec<WorkClaimPathOverlapV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkClaimPutReceiptV1 {
    pub schema_version: u16,
    pub claim: WorkClaimRecordV1,
    pub recorded: bool,
    pub overlaps: Vec<WorkClaimOverlapV1>,
}

/// Other holders' claims in the same repository that share the candidate's
/// issue, branch or worktree, or whose path patterns can name a common file.
pub fn work_claim_overlaps(
    candidate: &WorkClaimV1,
    held: &[WorkClaimRecordV1],
) -> Vec<WorkClaimOverlapV1> {
    held.iter()
        .filter(|record| {
            record.claim.repository == candidate.repository
                && record.claim.holder != candidate.holder
        })
        .filter_map(|record| {
            let other = &record.claim;
            let mut reasons = Vec::new();
            for (reason, mine, theirs) in [
                (
                    WorkClaimOverlapReasonV1::Issue,
                    &candidate.issue,
                    &other.issue,
                ),
                (
                    WorkClaimOverlapReasonV1::Branch,
                    &candidate.branch,
                    &other.branch,
                ),
                (
                    WorkClaimOverlapReasonV1::Worktree,
                    &candidate.worktree,
                    &other.worktree,
                ),
            ] {
                if mine.is_some() && mine == theirs {
                    reasons.push(reason);
                }
            }
            let paths: Vec<_> = candidate
                .paths
                .iter()
                .flat_map(|mine| {
                    other
                        .paths
                        .iter()
                        .filter(|theirs| path_patterns_overlap(mine, theirs))
                        .map(|theirs| WorkClaimPathOverlapV1 {
                            mine: mine.clone(),
                            theirs: theirs.clone(),
                        })
                })
                .collect();
            if !paths.is_empty() {
                reasons.push(WorkClaimOverlapReasonV1::Paths);
            }
            (!reasons.is_empty()).then(|| WorkClaimOverlapV1 {
                held: record.clone(),
                reasons,
                paths,
            })
        })
        .collect()
}

/// Whether two repository path patterns can name a common file. A pattern
/// without wildcards names a file or a whole directory, so it also covers
/// everything below it. The answer errs toward overlap: `**`, character
/// classes and alternatives are assumed to match.
pub fn path_patterns_overlap(left: &str, right: &str) -> bool {
    let left: Vec<&str> = left.split('/').collect();
    let right: Vec<&str> = right.split('/').collect();
    segments_overlap(&left, &right)
}

fn segments_overlap(left: &[&str], right: &[&str]) -> bool {
    match (left.split_first(), right.split_first()) {
        (None, _) | (_, None) => true,
        (Some((&"**", _)), _) | (_, Some((&"**", _))) => true,
        (Some((mine, left)), Some((theirs, right))) => {
            segment_may_match(mine, theirs) && segments_overlap(left, right)
        }
    }
}

fn is_wildcard(segment: &str) -> bool {
    segment.contains(['*', '?', '[', '{'])
}

fn segment_may_match(left: &str, right: &str) -> bool {
    match (is_wildcard(left), is_wildcard(right)) {
        (false, false) => left == right,
        (true, false) => wildcard_matches(left, right),
        (false, true) => wildcard_matches(right, left),
        (true, true) => wildcards_may_intersect(left, right),
    }
}

/// `*` and `?` within one path segment. Classes and alternatives match.
fn wildcard_matches(pattern: &str, name: &str) -> bool {
    if pattern.contains(['[', '{']) {
        return true;
    }
    let pattern: Vec<char> = pattern.chars().collect();
    let name: Vec<char> = name.chars().collect();
    let (mut p, mut n) = (0, 0);
    let mut resume: Option<(usize, usize)> = None;
    while n < name.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == name[n]) {
            p += 1;
            n += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            resume = Some((p, n));
            p += 1;
        } else if let Some((star, consumed)) = resume {
            p = star + 1;
            n = consumed + 1;
            resume = Some((star, consumed + 1));
        } else {
            return false;
        }
    }
    pattern[p..].iter().all(|character| *character == '*')
}

/// Two `*` patterns can only match a common name when their literal heads
/// and tails agree, as `*.rs` and `*.ts` do not.
fn wildcards_may_intersect(left: &str, right: &str) -> bool {
    if left.contains(['?', '[', '{']) || right.contains(['?', '[', '{']) {
        return true;
    }
    let head = |pattern: &str| pattern.split('*').next().unwrap_or_default().to_owned();
    let tail = |pattern: &str| pattern.rsplit('*').next().unwrap_or_default().to_owned();
    let (left_head, right_head) = (head(left), head(right));
    let (left_tail, right_tail) = (tail(left), tail(right));
    (left_head.starts_with(&right_head) || right_head.starts_with(&left_head))
        && (left_tail.ends_with(&right_tail) || right_tail.ends_with(&left_tail))
}

fn validate_path_pattern(pattern: &str) -> Result<(), DomainStoreErrorV1> {
    text("paths", pattern, MAX_PATH_PATTERN_BYTES)?;
    if pattern.contains('\\')
        || pattern
            .split('/')
            .any(|segment| matches!(segment, "" | "." | ".."))
    {
        return Err(invalid(
            "paths",
            "must be relative to the repository root, use `/`, and contain no empty, `.` or `..` segments",
        ));
    }
    Ok(())
}

fn text(field: &'static str, value: &str, maximum: usize) -> Result<(), DomainStoreErrorV1> {
    if value.trim().is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        return Err(invalid(
            field,
            &format!("must contain 1 to {maximum} bytes of text without control characters"),
        ));
    }
    Ok(())
}

fn optional_text(
    field: &'static str,
    value: Option<&str>,
    maximum: usize,
) -> Result<(), DomainStoreErrorV1> {
    value.map_or(Ok(()), |value| text(field, value, maximum))
}

fn invalid(field: &'static str, reason: &str) -> DomainStoreErrorV1 {
    DomainStoreErrorV1::InvalidRecord {
        field,
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claim(holder: &str) -> WorkClaimV1 {
        WorkClaimV1 {
            repository: "/work/repo/.git".into(),
            holder: holder.into(),
            session_id: None,
            workspace_id: None,
            issue: None,
            branch: None,
            worktree: None,
            paths: Vec::new(),
            note: None,
        }
    }

    fn held(claim: WorkClaimV1) -> WorkClaimRecordV1 {
        WorkClaimRecordV1 {
            schema_version: WORK_CLAIM_SCHEMA_VERSION_V1,
            claim,
            claimed_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    #[test]
    fn literal_patterns_cover_their_directory() {
        assert!(path_patterns_overlap("src/engine", "src/engine/core.rs"));
        assert!(path_patterns_overlap("src/engine/core.rs", "src/engine"));
        assert!(path_patterns_overlap("src/engine", "src/engine"));
        assert!(!path_patterns_overlap("src/engine", "src/engine2"));
        assert!(!path_patterns_overlap("src/engine/a.rs", "src/engine/b.rs"));
    }

    #[test]
    fn wildcards_match_within_one_segment() {
        assert!(path_patterns_overlap(
            "Sources/Engine/**",
            "Sources/Engine/Core/A.swift"
        ));
        assert!(!path_patterns_overlap("Sources/Engine/**", "Sources/UI/**"));
        assert!(path_patterns_overlap("src/*.ts", "src/main.ts"));
        assert!(!path_patterns_overlap("src/*.ts", "src/main.rs"));
        assert!(path_patterns_overlap("src/?.ts", "src/a.ts"));
        assert!(!path_patterns_overlap("src/?.ts", "src/ab.ts"));
        assert!(path_patterns_overlap("src/*/mod.rs", "src/net/mod.rs"));
        assert!(!path_patterns_overlap("src/*/mod.rs", "src/net/lib.rs"));
        assert!(path_patterns_overlap("**", "anything/at/all"));
        assert!(path_patterns_overlap("a*b*c", "aXbYc"));
        assert!(!path_patterns_overlap("a*b*c", "aXbY"));
    }

    #[test]
    fn two_wildcards_overlap_unless_their_literal_ends_disagree() {
        assert!(!path_patterns_overlap("src/*.ts", "src/*.rs"));
        assert!(path_patterns_overlap("src/*.ts", "src/*.d.ts"));
        assert!(!path_patterns_overlap("src/a*", "src/b*"));
        assert!(path_patterns_overlap("src/a*", "src/ab*"));
        assert!(path_patterns_overlap("src/[ab].rs", "src/*.ts"));
        assert!(path_patterns_overlap("src/{a,b}.rs", "src/c.rs"));
    }

    #[test]
    fn overlaps_name_every_shared_reason_and_skip_the_same_holder() {
        let mut mine = claim("engine-2");
        mine.issue = Some("2".into());
        mine.branch = Some("agent/engine-2".into());
        mine.paths = vec!["Sources/Engine/**".into(), "Docs/engine.md".into()];
        let mut theirs = claim("engine-1");
        theirs.issue = Some("2".into());
        theirs.branch = Some("agent/engine-1".into());
        theirs.paths = vec!["Sources/Engine/Core".into(), "Sources/UI/**".into()];
        let mut unrelated = claim("ui-1");
        unrelated.issue = Some("3".into());
        unrelated.paths = vec!["Sources/UI/**".into()];
        let mut own = mine.clone();
        own.note = Some("previous claim".into());
        let mut elsewhere = theirs.clone();
        elsewhere.repository = "/work/other/.git".into();
        elsewhere.holder = "engine-9".into();

        let overlaps = work_claim_overlaps(
            &mine,
            &[
                held(theirs.clone()),
                held(unrelated),
                held(own),
                held(elsewhere),
            ],
        );
        assert_eq!(overlaps.len(), 1);
        assert_eq!(overlaps[0].held.claim, theirs);
        assert_eq!(
            overlaps[0].reasons,
            vec![
                WorkClaimOverlapReasonV1::Issue,
                WorkClaimOverlapReasonV1::Paths
            ]
        );
        assert_eq!(
            overlaps[0].paths,
            vec![WorkClaimPathOverlapV1 {
                mine: "Sources/Engine/**".into(),
                theirs: "Sources/Engine/Core".into(),
            }]
        );
    }

    #[test]
    fn missing_fields_never_overlap() {
        let mut mine = claim("a");
        mine.paths = vec!["src/a.rs".into()];
        let mut theirs = claim("b");
        theirs.paths = vec!["src/b.rs".into()];
        assert!(work_claim_overlaps(&mine, &[held(theirs)]).is_empty());
    }

    #[test]
    fn validation_refuses_empty_unsafe_and_oversized_claims() {
        let request = |claim: WorkClaimV1| WorkClaimPutRequestV1 {
            schema_version: 1,
            claim,
            dry_run: false,
        };
        assert!(request(claim("a")).validate().is_err());
        let mut valid = claim("a");
        valid.paths = vec!["src/**".into()];
        assert!(request(valid.clone()).validate().is_ok());
        for pattern in [
            "/src",
            "src/../etc",
            "./src",
            "src//a",
            "src/",
            "src\\a",
            "",
        ] {
            let mut claim = valid.clone();
            claim.paths = vec![pattern.into()];
            assert!(request(claim).validate().is_err(), "{pattern}");
        }
        let mut repeated = valid.clone();
        repeated.paths.push("src/**".into());
        assert!(request(repeated).validate().is_err());
        let mut many = valid.clone();
        many.paths = (0..=MAX_WORK_CLAIM_PATHS_V1)
            .map(|index| format!("p{index}"))
            .collect();
        assert!(request(many).validate().is_err());
        let mut padded = valid.clone();
        padded.holder = " a".into();
        assert!(request(padded).validate().is_err());
        let mut control = valid.clone();
        control.issue = Some("2\n".into());
        assert!(request(control).validate().is_err());
        let mut future = request(valid);
        future.schema_version = 2;
        assert!(future.validate().is_err());
    }
}
