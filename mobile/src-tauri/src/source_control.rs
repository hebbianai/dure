//! Asking a box directly what version control says about one of its sessions.
//!
//! The other half of this question is [`crate::hub_client::send_git_status`]:
//! when a paired laptop knows the session, it answers. A box this phone reaches
//! only over SSH has no laptop in the middle, and it is not reachable by
//! running a command there either — a paired key is `command="…",restrict`, so
//! sshd replaces whatever argv this client sends. Everything a phone may ask
//! for on that channel is a typed document, and this module writes one.
//!
//! The shapes here mirror the gateway's, written out rather than imported for
//! the same reason [`crate::catalog`] mirrors the listing: those types are
//! private to that binary. The guard against the two drifting is the same as
//! well — a version the far end refuses when it is not one it serves, rather
//! than two sides quietly disagreeing about what a field means.

use std::io::Read;

use serde::Deserialize;

use crate::catalog::{read_exact_or_end, refusal_in, CatalogError, ReadEnd, LENGTH_PREFIX_BYTES};

/// The request-document version that carries this question.
///
/// One version admits one variant on the far side, so this constant is also
/// the statement "the box must be new enough to have the reader".
pub const GATEWAY_REQUEST_VERSION_SOURCE_CONTROL: u16 = 8;

/// The version that carries *which* answer to compute.
///
/// A box that admits this one answers all three tabs. A box that does not is
/// not broken — it is a box whose `hmux` predates the commits and pull-request
/// readers, and it still answers the changes tab at version 8. Which is why
/// [`request`] picks the version from the want rather than always sending the
/// newer one: sending 9 for the changes tab would turn every box in the field
/// from "answers one tab" into "answers nothing".
pub const GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_WANT: u16 = 9;

/// Which tab is asking.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Want {
    #[default]
    Changes,
    Commits,
    PullRequest,
}

impl Want {
    fn wire(self) -> Option<&'static str> {
        match self {
            // The changes tab has an older way to ask, and it is the one every
            // box already serves. Asking it the new way buys nothing and costs
            // every box that has not been updated.
            Self::Changes => None,
            Self::Commits => Some("commits"),
            Self::PullRequest => Some("pull_request"),
        }
    }
}

/// The answer-document version this build understands.
pub const SUPPORTED_SOURCE_CONTROL_VERSION: u16 = 1;

/// The framed document that asks for one session's source-control status.
///
/// Three identifiers and, for the two newer tabs, a closed choice of which
/// answer to compute. There is deliberately no path, no revision and no
/// argument field: the box resolves the directory from its own Host state, and
/// any of those would turn a directory read into a command channel.
///
/// The version comes from the want, not from this build's ceiling. Version 8
/// is the shape every box in the field serves, and the changes tab still sends
/// exactly it — byte for byte — so updating the phone never stops an
/// un-updated box from answering the tab it always answered.
#[must_use]
pub fn request(request_id: &str, session_id: &str, workspace_id: &str, want: Want) -> Vec<u8> {
    let mut question = serde_json::json!({
        "request_id": request_id,
        "session_id": session_id,
        "workspace_id": workspace_id,
    });
    let version = match want.wire() {
        Some(wire) => {
            question["want"] = serde_json::Value::String(wire.to_string());
            GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_WANT
        }
        None => GATEWAY_REQUEST_VERSION_SOURCE_CONTROL,
    };
    let payload = serde_json::json!({
        "gateway_request_version": version,
        "request": { "source_control_status": question }
    })
    .to_string();
    let mut framed = Vec::with_capacity(LENGTH_PREFIX_BYTES + payload.len());
    framed.extend_from_slice(
        &u32::try_from(payload.len())
            .expect("three bounded identifiers and one closed word are far below u32::MAX")
            .to_be_bytes(),
    );
    framed.extend_from_slice(payload.as_bytes());
    framed
}

/// The request-document version that carries one file's patch.
///
/// A version of its own, and a request of its own, because the status
/// document's shape *is* the promise that the read names nothing — "no path,
/// no revision, no argument". Adding a path to it would retire that promise
/// for the changes tab too.
///
/// What makes a path admissible here is on the far side: the gateway lists the
/// repository itself and refuses a path its own listing did not produce. This
/// phone chooses among what the repository offered.
pub const GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_DIFF: u16 = 10;

/// The patch answer-document version this build understands.
pub const SUPPORTED_SOURCE_CONTROL_DIFF_VERSION: u16 = 1;

/// The framed document that asks for one file's patch.
#[must_use]
pub fn file_diff_request(
    request_id: &str,
    session_id: &str,
    workspace_id: &str,
    path: &str,
    commit: Option<&str>,
) -> Vec<u8> {
    let mut question = serde_json::json!({
        "request_id": request_id,
        "session_id": session_id,
        "workspace_id": workspace_id,
        "path": path,
    });
    if let Some(commit) = commit {
        question["commit"] = serde_json::Value::String(commit.to_string());
    }
    let payload = serde_json::json!({
        "gateway_request_version": GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_DIFF,
        "request": { "source_control_file_diff": question }
    })
    .to_string();
    let mut framed = Vec::with_capacity(LENGTH_PREFIX_BYTES + payload.len());
    framed.extend_from_slice(
        &u32::try_from(payload.len())
            .expect("a bounded path and three identifiers are far below u32::MAX")
            .to_be_bytes(),
    );
    framed.extend_from_slice(payload.as_bytes());
    framed
}

/// What the box answered about one file.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct FileDiffDocument {
    pub gateway_source_control_diff_version: u16,
    /// The path that was asked for, echoed back.
    #[serde(default)]
    pub path: String,
    /// From the listing that admitted the path. Absent means nobody counted.
    #[serde(default)]
    pub added: Option<u32>,
    #[serde(default)]
    pub deleted: Option<u32>,
    #[serde(flatten)]
    pub body: FileDiffBody,
}

/// One document whatever happened.
///
/// `Binary` is not an empty `Read`. An empty body means the file did not
/// change, and drawing that for a PNG claims the image is identical when
/// nobody compared it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileDiffBody {
    Read {
        #[serde(default)]
        patch: String,
        #[serde(default)]
        truncated: bool,
    },
    Binary,
    Unavailable {
        reason: String,
    },
}

/// Read the one document the gateway answers a patch request with.
///
/// The same shape as [`read`], and separate for the same reason the two
/// requests are separate: one envelope per question. Folding them would mean
/// deciding which document to parse from the request kind, and a wrong branch
/// there leaves the stream misaligned rather than merely wrong.
pub fn read_file_diff<R: Read>(
    source: &mut R,
    maximum: usize,
) -> Result<FileDiffDocument, SourceControlError> {
    let payload = read_framed(source, maximum)?;
    if let Some((code, message)) = refusal_in(&payload) {
        return Err(if code == "unsupported_protocol_version" {
            SourceControlError::Unsupported { message }
        } else {
            SourceControlError::Refused { code, message }
        });
    }
    let document: FileDiffDocument =
        serde_json::from_slice(&payload).map_err(|error| SourceControlError::Malformed {
            detail: error.to_string(),
        })?;
    if document.gateway_source_control_diff_version != SUPPORTED_SOURCE_CONTROL_DIFF_VERSION {
        return Err(SourceControlError::UnsupportedVersion {
            found: document.gateway_source_control_diff_version,
            supported: SUPPORTED_SOURCE_CONTROL_DIFF_VERSION,
        });
    }
    Ok(document)
}

/// What the box answered.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SourceControlDocument {
    pub gateway_source_control_version: u16,
    #[serde(flatten)]
    pub body: SourceControlBody,
}

/// One document whatever happened.
///
/// `NotVersioned` is a fact and not a failure: a directory nothing versions is
/// a complete answer, and reporting it as an error sends somebody looking for a
/// network problem.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceControlBody {
    Read(Box<SourceControlSnapshot>),
    NotVersioned,
    Unavailable { reason: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SourceControlSnapshot {
    /// Which reader answered. Named so a second one could exist without this
    /// side having to guess.
    pub vcs: String,
    pub root: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub ahead: Option<u32>,
    #[serde(default)]
    pub behind: Option<u32>,
    #[serde(default)]
    pub base_ref: Option<String>,
    /// What the file list was measured against — `merge_base` or `head`. The
    /// counts above answer a different question, and one screen must not
    /// present the two as one.
    pub comparison: String,
    #[serde(default)]
    pub files: Vec<SourceControlFile>,
    #[serde(default)]
    pub truncated: bool,
    /// The box actually read the file list. Absent from a version-8 answer,
    /// where it was always true — the file list was the only thing v8 could
    /// be asked for. See [`SourceControlBody`] for why absent is not false
    /// everywhere else.
    #[serde(default)]
    pub files_read: bool,
    /// Absent means this tab did not ask. An older box sends neither key, and
    /// the screen says so rather than drawing an empty list as "none".
    #[serde(default)]
    pub commits: Option<SourceControlCommits>,
    #[serde(default)]
    pub review: Option<SourceControlReview>,
}

/// What the commits tab got.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceControlCommits {
    Read {
        #[serde(default)]
        commits: Vec<SourceControlCommitRow>,
        #[serde(default)]
        truncated: bool,
    },
    Unavailable {
        reason: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SourceControlCommitRow {
    pub short_sha: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub when: String,
}

/// What the pull-request tab got.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceControlReview {
    Open {
        number: u64,
        #[serde(default)]
        title: String,
        #[serde(default)]
        state: String,
        #[serde(default)]
        url: String,
        #[serde(default)]
        is_draft: bool,
        #[serde(default)]
        base_ref: String,
    },
    /// Asked, and there is none yet — the state the create button exists for.
    None,
    Unavailable {
        reason: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SourceControlFile {
    pub path: String,
    pub status: String,
    #[serde(default)]
    pub old_path: Option<String>,
    /// Absent for a binary or untracked file. Absent, not zero.
    #[serde(default)]
    pub added: Option<u32>,
    #[serde(default)]
    pub deleted: Option<u32>,
}

/// Why a read could not be had.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SourceControlError {
    /// The box does not serve this question. Its own variant because the fix
    /// is on that box — update its `hmux` — and every other failure here sends
    /// the person somewhere else entirely.
    Unsupported {
        message: String,
    },
    Refused {
        code: String,
        message: String,
    },
    UnsupportedVersion {
        found: u16,
        supported: u16,
    },
    Malformed {
        detail: String,
    },
    Io {
        detail: String,
    },
}

impl std::fmt::Display for SourceControlError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported { .. } => write!(
                formatter,
                "이 상자의 hmux가 오래되어 변경 목록을 읽지 못합니다"
            ),
            Self::Refused { message, .. } => {
                write!(formatter, "서버가 변경 목록을 거절했습니다: {message}")
            }
            Self::UnsupportedVersion { found, supported } => write!(
                formatter,
                "the server speaks source-control version {found}; this build understands {supported}"
            ),
            Self::Malformed { detail } => write!(formatter, "malformed source control answer: {detail}"),
            Self::Io { detail } => write!(formatter, "could not read the source control answer: {detail}"),
        }
    }
}

impl std::error::Error for SourceControlError {}

impl SourceControlError {
    /// A stable code for callers that branch rather than display.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unsupported { .. } => "unsupported_protocol_version",
            Self::Refused { .. } => "refused",
            Self::UnsupportedVersion { .. } => "unsupported_source_control_version",
            Self::Malformed { .. } => "malformed",
            Self::Io { .. } => "io",
        }
    }
}

/// Read the one document the gateway answers with.
///
/// A second document is malformed rather than ignored: this question has one
/// answer, and a stream that carries two is not the protocol this build is
/// speaking.
///
/// There is no downgrade retry *here*, and there does not need to be. The
/// older way to ask exists only for the changes tab, and [`request`] already
/// sends exactly it for that want — so a box that refuses version 9 is a box
/// being asked for commits or a review, which it genuinely cannot answer.
/// [`SourceControlError::Unsupported`] is the honest end of that road: the fix
/// is on that box, and the screen says so. Retrying at version 8 would fetch
/// the changed files and draw them under a heading that asked for something
/// else.
pub fn read<R: Read>(
    source: &mut R,
    maximum: usize,
) -> Result<SourceControlDocument, SourceControlError> {
    let payload = read_framed(source, maximum)?;

    // The refusal is tried first here, unlike the listing: an old box refuses
    // this question by version, and that is the expected answer from every box
    // whose hmux predates the reader — not an exceptional one.
    if let Some((code, message)) = refusal_in(&payload) {
        return Err(if code == "unsupported_protocol_version" {
            SourceControlError::Unsupported { message }
        } else {
            SourceControlError::Refused { code, message }
        });
    }

    let document: SourceControlDocument =
        serde_json::from_slice(&payload).map_err(|error| SourceControlError::Malformed {
            detail: error.to_string(),
        })?;
    if document.gateway_source_control_version != SUPPORTED_SOURCE_CONTROL_VERSION {
        return Err(SourceControlError::UnsupportedVersion {
            found: document.gateway_source_control_version,
            supported: SUPPORTED_SOURCE_CONTROL_VERSION,
        });
    }
    Ok(document)
}

/// One length-prefixed document off the channel, bounded.
fn read_framed<R: Read>(source: &mut R, maximum: usize) -> Result<Vec<u8>, SourceControlError> {
    let mut prefix = [0_u8; LENGTH_PREFIX_BYTES];
    match read_or_end(source, &mut prefix)? {
        ReadEnd::Filled => {}
        ReadEnd::Ended | ReadEnd::Partial => {
            return Err(SourceControlError::Malformed {
                detail: "the box closed before answering".to_string(),
            });
        }
    }
    let length = u32::from_be_bytes(prefix) as usize;
    if length > maximum {
        return Err(SourceControlError::Malformed {
            detail: format!("the box announced a {length}-byte answer over the {maximum}-byte cap"),
        });
    }
    let mut payload = vec![0_u8; length];
    match read_or_end(source, &mut payload)? {
        ReadEnd::Filled => {}
        ReadEnd::Ended | ReadEnd::Partial => {
            return Err(SourceControlError::Malformed {
                detail: "the answer ended mid-document".to_string(),
            });
        }
    }
    Ok(payload)
}

fn read_or_end<R: Read>(source: &mut R, buffer: &mut [u8]) -> Result<ReadEnd, SourceControlError> {
    read_exact_or_end(source, buffer).map_err(|error| match error {
        CatalogError::Io { detail } => SourceControlError::Io { detail },
        other => SourceControlError::Malformed {
            detail: other.to_string(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn framed(payload: &str) -> Vec<u8> {
        let mut bytes = (payload.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(payload.as_bytes());
        bytes
    }

    /// The request carries three identifiers and nothing else. A path here
    /// would turn a directory read into a command channel, and the far end
    /// refuses unknown fields — so an accidental one becomes a dead feature
    /// rather than a dangerous one, which is still worth catching here.
    #[test]
    fn the_request_carries_three_identifiers_and_no_path() {
        let bytes = request("r-1", "s-1", "w-1", Want::Changes);
        let payload = String::from_utf8(bytes[LENGTH_PREFIX_BYTES..].to_vec()).expect("utf8");

        assert!(payload.contains(r#""gateway_request_version":8"#));
        assert!(payload.contains(r#""session_id":"s-1""#));
        assert!(!payload.contains("path"));
        assert!(!payload.contains("args"));
    }

    /// The changes tab keeps speaking the version every box already serves.
    ///
    /// This is the assertion that stops a phone update from turning every
    /// un-updated box from "answers one tab" into "answers nothing": there IS
    /// an older way to ask this one, it returns the same answer, and asking the
    /// new way buys nothing.
    #[test]
    fn the_changes_tab_still_asks_the_way_every_box_already_answers() {
        let bytes = request("r-1", "s-1", "w-1", Want::Changes);
        let payload = String::from_utf8(bytes[LENGTH_PREFIX_BYTES..].to_vec()).expect("utf8");

        assert!(payload.contains(r#""gateway_request_version":8"#));
        assert!(!payload.contains("want"));
    }

    /// The two newer tabs name what they want, at the version that carries it.
    #[test]
    fn the_newer_tabs_name_their_question_at_their_own_version() {
        for (want, wire) in [
            (Want::Commits, "commits"),
            (Want::PullRequest, "pull_request"),
        ] {
            let bytes = request("r-1", "s-1", "w-1", want);
            let payload = String::from_utf8(bytes[LENGTH_PREFIX_BYTES..].to_vec()).expect("utf8");

            assert!(payload.contains(r#""gateway_request_version":9"#), "{wire}");
            assert!(payload.contains(&format!(r#""want":"{wire}""#)), "{wire}");
            // Still no way to name a directory or an argument.
            assert!(!payload.contains("path"), "{wire}");
            assert!(!payload.contains("args"), "{wire}");
        }
    }

    /// An answer that carries commits reaches the caller as commits, and an
    /// answer that carries none of the new keys — every box in the field today
    /// — still parses.
    #[test]
    fn the_new_answers_are_read_and_an_old_box_still_parses() {
        let with_commits = framed(
            r#"{"gateway_source_control_version":1,"request_id":"r-1","session_id":"s-1","workspace_id":"w-1","kind":"read","vcs":"git","root":"/repo","branch":"fix/payment-retry","comparison":"none","files":[],"truncated":false,"files_read":false,"commits":{"kind":"read","commits":[{"short_sha":"1fb0321","subject":"size the guard","author":"kattpish","when":"2 hours ago"}],"truncated":false}}"#,
        );
        let SourceControlBody::Read(snapshot) = read(&mut with_commits.as_slice(), 1 << 20)
            .expect("read")
            .body
        else {
            panic!("a read answer");
        };
        assert!(!snapshot.files_read);
        let Some(SourceControlCommits::Read { commits, .. }) = snapshot.commits else {
            panic!("the commits tab must carry commits");
        };
        assert_eq!(commits[0].short_sha, "1fb0321");

        // The shape every box in the field sends today.
        let old_box = framed(
            r#"{"gateway_source_control_version":1,"request_id":"r-1","session_id":"s-1","workspace_id":"w-1","kind":"read","vcs":"git","root":"/repo","comparison":"merge_base","files":[],"truncated":false}"#,
        );
        let SourceControlBody::Read(snapshot) =
            read(&mut old_box.as_slice(), 1 << 20).expect("read").body
        else {
            panic!("a read answer");
        };
        assert!(snapshot.commits.is_none());
        assert!(snapshot.review.is_none());
    }

    /// "No review yet" is the state the create button exists for, and it must
    /// not arrive looking like a failure.
    #[test]
    fn a_branch_with_no_review_is_told_apart_from_a_review_that_could_not_be_read() {
        let none = framed(
            r#"{"gateway_source_control_version":1,"request_id":"r-1","session_id":"s-1","workspace_id":"w-1","kind":"read","vcs":"git","root":"/repo","comparison":"none","files":[],"truncated":false,"review":{"kind":"none"}}"#,
        );
        let unavailable = framed(
            r#"{"gateway_source_control_version":1,"request_id":"r-1","session_id":"s-1","workspace_id":"w-1","kind":"read","vcs":"git","root":"/repo","comparison":"none","files":[],"truncated":false,"review":{"kind":"unavailable","reason":"not_authenticated"}}"#,
        );

        let body = read(&mut none.as_slice(), 1 << 20).expect("read").body;
        let SourceControlBody::Read(snapshot) = body else {
            panic!("a read answer");
        };
        assert_eq!(snapshot.review, Some(SourceControlReview::None));

        let body = read(&mut unavailable.as_slice(), 1 << 20)
            .expect("read")
            .body;
        let SourceControlBody::Read(snapshot) = body else {
            panic!("a read answer");
        };
        assert_eq!(
            snapshot.review,
            Some(SourceControlReview::Unavailable {
                reason: "not_authenticated".to_string()
            })
        );
    }

    #[test]
    fn a_read_answer_carries_its_files_and_counts() {
        let bytes = framed(
            r#"{"gateway_source_control_version":1,"request_id":"r-1","session_id":"s-1","workspace_id":"w-1","kind":"read","vcs":"git","root":"/repo","branch":"fix/payment-retry","ahead":2,"behind":0,"base_ref":"main","comparison":"merge_base","files":[{"path":"src/app.ts","status":"M","added":14,"deleted":3}],"truncated":false}"#,
        );

        let document = read(&mut bytes.as_slice(), 1 << 20).expect("read");

        let SourceControlBody::Read(snapshot) = document.body else {
            panic!("a read answer");
        };
        assert_eq!(snapshot.branch.as_deref(), Some("fix/payment-retry"));
        assert_eq!(snapshot.comparison, "merge_base");
        assert_eq!(snapshot.files[0].added, Some(14));
    }

    /// A binary file's counts are absent on the wire, and must stay absent
    /// here — `Some(0)` would draw `+0 −0` for a file that changed.
    #[test]
    fn absent_counts_stay_absent() {
        let bytes = framed(
            r#"{"gateway_source_control_version":1,"request_id":"r-1","session_id":"s-1","workspace_id":"w-1","kind":"read","vcs":"git","root":"/repo","comparison":"head","files":[{"path":"logo.png","status":"M"}],"truncated":false}"#,
        );

        let document = read(&mut bytes.as_slice(), 1 << 20).expect("read");

        let SourceControlBody::Read(snapshot) = document.body else {
            panic!("a read answer");
        };
        assert!(snapshot.files[0].added.is_none());
        assert!(snapshot.branch.is_none());
    }

    /// A directory nothing versions is a complete answer.
    #[test]
    fn a_directory_with_no_repository_is_a_fact_not_an_error() {
        let bytes = framed(
            r#"{"gateway_source_control_version":1,"request_id":"r-1","session_id":"s-1","workspace_id":"w-1","kind":"not_versioned"}"#,
        );

        let document = read(&mut bytes.as_slice(), 1 << 20).expect("read");

        assert_eq!(document.body, SourceControlBody::NotVersioned);
    }

    /// An old box refuses by version. That is the expected answer from every
    /// box whose hmux predates the reader, and its fix is on that box — so it
    /// gets its own variant instead of being folded into "refused".
    #[test]
    fn an_old_box_is_told_apart_from_a_box_that_said_no() {
        let old = framed(
            r#"{"body":{"kind":"error","payload":{"code":"unsupported_protocol_version","message":"…"}}}"#,
        );
        let refused = framed(
            r#"{"body":{"kind":"error","payload":{"code":"identity_mismatch","message":"…"}}}"#,
        );

        assert!(matches!(
            read(&mut old.as_slice(), 1 << 20),
            Err(SourceControlError::Unsupported { .. })
        ));
        assert!(matches!(
            read(&mut refused.as_slice(), 1 << 20),
            Err(SourceControlError::Refused { .. })
        ));
    }

    #[test]
    fn a_newer_answer_version_is_refused_rather_than_guessed() {
        let bytes = framed(
            r#"{"gateway_source_control_version":2,"request_id":"r-1","session_id":"s-1","workspace_id":"w-1","kind":"not_versioned"}"#,
        );

        assert!(matches!(
            read(&mut bytes.as_slice(), 1 << 20),
            Err(SourceControlError::UnsupportedVersion { found: 2, .. })
        ));
    }
}
