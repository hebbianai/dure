//! Reading what a directory's version control says about it.
//!
//! # Why this lives in the CLI and not in the protocol crates
//!
//! Version control is a property of a *directory*, not a session runtime fact.
//! Hmux identifies sessions by versioned identity and capability and knows
//! nothing about repositories; putting a VCS concept in `hmux-client`,
//! `hmux-host` or `hmux-runtime` would put a domain conditional in the neutral
//! core, which the workspace charter forbids. What the gateway does here is
//! what a person with that key could already do by hand on that box: run a
//! reader in a directory and report what it said.
//!
//! Spawning a program Hmux does not ship is not new to this crate — the
//! pairing installer already does it. What is new is that a remote request can
//! cause it, so the bounds below are the interesting part of this module.
//!
//! # What bounds it
//!
//! - **No path from the caller.** [`read`] takes the directory the *Host*
//!   reported for that session. Nothing a client sends reaches this module.
//! - **Fixed argv.** Every program name, flag and subcommand is a literal here.
//!   The only interpolated values are the directory (from the Host) and two
//!   revisions this module itself derived from the repository.
//! - **A repository cannot make this run something else.** `core.fsmonitor`,
//!   `core.hooksPath`, `diff.external`, the pager and the ask-pass helpers are
//!   all forced off on the command line, which beats `.git/config`, and the
//!   `GIT_*` environment that could re-enable them is cleared — `GIT_CONFIG_COUNT`
//!   included, because that one outranks `-c`.
//! - **One wall clock for the whole read**, and a byte ceiling per command.
//!   A repository with a million changed files cannot turn one request into an
//!   unbounded answer.
//!
//! Nothing from the repository is ever returned as a *reason*: refusals are a
//! closed set of `&'static str` minted in this file, so a branch name or a
//! stderr line cannot become a sentence on someone's phone.

use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// What one command may print before this module stops believing it.
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;

/// How many files travel. Beyond this the answer is marked truncated rather
/// than grown — a phone screen cannot use ten thousand rows, and an unbounded
/// document is a way to make one request expensive.
pub(crate) const MAX_FILES: usize = 1_000;

/// How many commits travel. Matches the laptop's own `--max-count=200`
/// (`src-tauri/src/diff.rs`) so one screen does not show a different-length
/// list depending on which side answered.
const MAX_COMMITS: usize = 200;

/// How much of one file's patch travels.
///
/// Smaller than [`MAX_OUTPUT_BYTES`] on purpose: this value has to survive JSON
/// escaping into a gateway frame whose ceiling is 1 MiB, and a diff is mostly
/// newlines and quotes — the two characters that escape to two bytes each. A
/// patch above this is cut at a line boundary and marked truncated; a patch
/// above the reader's own ceiling is `output_too_large`, which is a different
/// sentence because it is a different fact (nobody read it at all).
pub(crate) const MAX_PATCH_BYTES: usize = 256 * 1024;

/// The longest branch name this module will hand to another program.
///
/// The same bound the gateway puts on every identifier it accepts. A name
/// longer than this is not a name anybody typed.
const MAX_BRANCH_BYTES: usize = 256;

/// How long the forge may take. It crosses the network, unlike every git shape
/// here, so it gets its own ceiling inside the caller's total budget.
const FORGE_BUDGET: Duration = Duration::from_secs(8);

/// The reader's own name. A literal, never composed.
const READER: &str = "git";

/// Settings forced on the command line, where `.git/config` cannot reach them.
///
/// Every one of these is a way a repository — or this box's own owner — could
/// otherwise run a program of its choosing when someone merely *reads* it.
///
/// `log.showSignature` is the one that is not about a hostile repository.
/// `.git/config` does not travel with a clone, so the realistic trigger is the
/// box owner having turned signature display on for themselves. `git log` then
/// spawns `gpg.program` on whatever signature bytes are in the commit object —
/// bytes a remote key just asked to have read. Measured on git 2.55.0: with
/// only the settings above, a forged `gpgsig` header ran the configured
/// program; with this line and `--no-show-signature` on the `log` argv, it did
/// not. The other three shapes this module runs (`rev-parse`, `status`,
/// `diff`) never reach it, so `git log` is the argv that opened the door.
const HARDENING: &[&str] = &[
    "--no-pager",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.alternateRefsCommand=",
    "-c",
    "core.askPass=",
    "-c",
    "core.pager=cat",
    "-c",
    "diff.external=",
    "-c",
    "log.showSignature=false",
];

/// Environment that could re-enable what [`HARDENING`] turned off, or point the
/// reader at another repository entirely.
const CLEARED_ENVIRONMENT: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_EXEC_PATH",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_COUNT",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_EXTERNAL_DIFF",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_PROXY_COMMAND",
];

/// Which tab is asking.
///
/// Declared by value rather than imported: `hmux` is its own Cargo workspace
/// and depends on none of the app's protocol crates, and the charter keeps it
/// that way. It mirrors the hub's `GitStatusWant` in shape, and the gateway's
/// request version is what keeps the two from drifting silently — a box that
/// does not know a want refuses the version that carries it.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum Want {
    /// What is uncommitted. The tab that opens first, and the only question a
    /// gateway request version 8 could ask.
    #[default]
    Changes,
    /// The commits since the base ref.
    Commits,
    /// The review open on this branch. The only one that leaves the box.
    PullRequest,
}

/// One commit, in the shape the phone draws a row from.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Commit {
    pub short_sha: String,
    pub subject: String,
    pub author: String,
    /// Already human ("2 hours ago"), made here with `--date=relative` for the
    /// same reason the laptop does: the phone must not have to reconcile two
    /// clocks to draw a row.
    pub when: String,
}

/// What the commits tab got. Three states, not two — "none since the base ref"
/// and "could not read" send a person to different places.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Commits {
    Read {
        commits: Vec<Commit>,
        truncated: bool,
    },
    Unavailable(&'static str),
}

/// The review open on a branch, as the host names it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PullRequest {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub is_draft: bool,
    pub base_ref: String,
}

/// What the pull-request tab got.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Review {
    /// Boxed: a review is six strings and the other two variants are a word,
    /// so inlining it would make every `Review` the size of its largest case.
    Open(Box<PullRequest>),
    /// Asked, and there is no review yet. This is the state the create button
    /// exists for, so it must not be folded into `Unavailable`.
    None,
    Unavailable(&'static str),
}

/// What a read produced.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Read(Snapshot),
    /// The directory exists and is not under version control. A fact, not a
    /// failure — a screen that draws this as an error sends somebody looking
    /// for a network problem.
    NotVersioned,
    /// The read could not happen. The reason is one of a closed set.
    Unavailable(&'static str),
}

/// What the repository said.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct Snapshot {
    /// The repository root, which may be above the session's directory.
    pub root: String,
    /// The current branch. Absent on a detached HEAD — absent, not invented.
    pub branch: Option<String>,
    /// Commits ahead of / behind the branch's own upstream. Absent when there
    /// is no upstream; never zero as a stand-in for "unknown".
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    /// The ref the file list was compared against, and how.
    pub base_ref: Option<String>,
    /// `merge_base` when the list is everything since the fork point,
    /// `head` when it is only what is uncommitted. One screen must never
    /// present the two as the same question.
    pub comparison: Comparison,
    pub files: Vec<FileChange>,
    /// Some files were dropped to keep the answer bounded.
    pub truncated: bool,
    /// The file list was actually read. Only [`Want::Changes`] reads it, so the
    /// other tabs answer with an empty list they never asked to fill — and a
    /// screen that draws that as "0 changed" claims a worktree is clean on the
    /// strength of a question nobody asked.
    pub files_read: bool,
    /// `None` means this tab did not ask.
    pub commits: Option<Commits>,
    /// `None` means this tab did not ask.
    pub review: Option<Review>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum Comparison {
    /// Compared against the merge base with the repository's default branch.
    #[default]
    MergeBase,
    /// Compared against HEAD — uncommitted work only, because no base ref
    /// could be resolved.
    Head,
}

impl Comparison {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::MergeBase => "merge_base",
            Self::Head => "head",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct FileChange {
    pub path: String,
    /// git's own status letter, or `?` for an untracked file.
    pub status: String,
    /// Where a renamed file came from. The half that says what moved.
    pub old_path: Option<String>,
    /// Absent for a binary file. Absent, not zero: `+0 −0` reads as
    /// "unchanged" for a file that changed.
    pub added: Option<u32>,
    pub deleted: Option<u32>,
}

/// Read `directory` for one tab, spending no more than `budget` in total.
///
/// The branch card is drawn above every tab, so the root, the status and the
/// base ref are read whatever the want. Only the tab's own question is paid
/// for beyond that — the phone asks per tab precisely so nobody who never
/// opens the commits tab pays for a `git log` on every refresh.
pub(crate) fn read(directory: &Path, want: Want, budget: Duration) -> Outcome {
    if !directory.is_absolute() {
        return Outcome::Unavailable("directory_missing");
    }
    if !directory.is_dir() {
        return Outcome::Unavailable("directory_missing");
    }
    let deadline = Instant::now() + budget;
    let run = |arguments: &[&str]| run_reader(directory, arguments, deadline);

    let root = match run(&["rev-parse", "--show-toplevel"]) {
        Ok(output) => output.trim().to_string(),
        Err(Failure::NotVersioned) => return Outcome::NotVersioned,
        Err(other) => return Outcome::Unavailable(other.reason()),
    };
    if root.is_empty() {
        return Outcome::NotVersioned;
    }

    let status = match run(&["status", "--porcelain=v2", "--branch", "-z"]) {
        Ok(output) => output,
        Err(Failure::NotVersioned) => return Outcome::NotVersioned,
        Err(other) => return Outcome::Unavailable(other.reason()),
    };
    let mut snapshot = parse_status(&status);
    snapshot.root = root;

    // The file list is everything since the fork point when a base ref exists,
    // and only the uncommitted work when it does not. Which one it is travels
    // with it — the counts above answer a different question (the upstream),
    // and one screen must not present two questions as one list.
    let (revision, comparison, base_ref) = match base_revision(directory, deadline) {
        Some((merge_base, base_ref)) => (merge_base, Comparison::MergeBase, Some(base_ref)),
        None => ("HEAD".to_string(), Comparison::Head, None),
    };
    snapshot.comparison = comparison;
    snapshot.base_ref = base_ref;

    match want {
        Want::Changes => {
            match run(&[
                "diff",
                "--raw",
                "--numstat",
                "-z",
                "-M",
                "--no-ext-diff",
                &revision,
                "--",
            ]) {
                Ok(output) => merge_tracked(&mut snapshot, parse_raw_numstat(&output)),
                Err(Failure::NotVersioned) => return Outcome::NotVersioned,
                Err(other) => return Outcome::Unavailable(other.reason()),
            }

            if snapshot.files.len() > MAX_FILES {
                snapshot.files.truncate(MAX_FILES);
                snapshot.truncated = true;
            }
            snapshot.files_read = true;
        }
        Want::Commits => {
            // The untracked paths `parse_status` collected are not this tab's
            // answer, and leaving them would make the branch card count files
            // this read never compared.
            snapshot.files.clear();
            snapshot.commits = Some(read_commits(directory, &revision, deadline));
        }
        Want::PullRequest => {
            snapshot.files.clear();
            snapshot.review = Some(read_review(directory, snapshot.branch.as_deref(), deadline));
        }
    }
    Outcome::Read(snapshot)
}

/// The commits between the base ref and HEAD.
///
/// The argv is byte-identical to the laptop's (`src-tauri/src/diff.rs`) so the
/// same commit cannot render differently depending on which side answered —
/// `--date=relative` included, because that is where "2 hours ago" is made.
/// `--no-show-signature` is not cosmetic: see [`HARDENING`].
fn read_commits(directory: &Path, revision: &str, deadline: Instant) -> Commits {
    let range = format!("{revision}..HEAD");
    let output = match run_reader(
        directory,
        &[
            "log",
            "--no-color",
            "--no-show-signature",
            "--date=relative",
            "--max-count=200",
            "--format=%h\x1f%s\x1f%an\x1f%ad",
            &range,
        ],
        deadline,
    ) {
        Ok(output) => output,
        Err(failure) => return Commits::Unavailable(failure.commits_reason()),
    };

    let mut commits = Vec::new();
    for line in output.lines() {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.split('\x1f');
        let short_sha = parts.next().unwrap_or_default().to_string();
        // A record with no sha is not a commit. Skipping is what the laptop
        // does, and inventing one would put a blank row on the screen.
        if short_sha.is_empty() {
            continue;
        }
        commits.push(Commit {
            short_sha,
            subject: parts.next().unwrap_or_default().to_string(),
            author: parts.next().unwrap_or_default().to_string(),
            when: parts.next().unwrap_or_default().to_string(),
        });
    }
    let truncated = commits.len() > MAX_COMMITS;
    commits.truncate(MAX_COMMITS);
    Commits::Read { commits, truncated }
}

/// The review open on this branch, asked of the code host.
///
/// # Why this one is different from every other read here
///
/// `git` is local, reads only this box's disk, and runs inside [`HARDENING`].
/// `gh` is none of those. It spends the box owner's stored host credentials on
/// an outbound request, and it shells out to `git` itself with none of the
/// settings this module forces. So it gets its own envelope, its own budget,
/// and a branch name that has been checked before it is allowed to become argv.
///
/// Nothing from the host becomes a sentence: the reasons are `&'static str`
/// minted here, matching the laptop's `ForgeUnavailable` so one screen can
/// branch the same way whichever side answered.
fn read_review(directory: &Path, branch: Option<&str>, deadline: Instant) -> Review {
    let Some(branch) = branch.filter(|branch| is_argv_safe_branch(branch)) else {
        // A detached HEAD has no review to speak of, and a name this module
        // will not hand to another program is the same dead end for this tab.
        return Review::Unavailable("not_hosted");
    };
    let output = match run_forge(
        directory,
        &[
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "all",
            "--limit",
            "1",
            "--json",
            "number,title,state,url,isDraft,baseRefName",
        ],
        deadline,
    ) {
        Ok(output) => output,
        Err(reason) => return Review::Unavailable(reason),
    };
    // `pr list` answers an empty array for "no review", where `pr view` exits
    // non-zero — which is why this is the shape asked for.
    let Ok(rows) = serde_json::from_str::<Vec<ForgeRow>>(&output) else {
        return Review::Unavailable("failed");
    };
    match rows.into_iter().next() {
        Some(row) => Review::Open(Box::new(PullRequest {
            number: row.number,
            title: row.title,
            state: row.state,
            url: row.url,
            is_draft: row.is_draft,
            base_ref: row.base_ref_name,
        })),
        None => Review::None,
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForgeRow {
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
    base_ref_name: String,
}

/// Whether a branch name may be handed to another program as an argument.
///
/// `Command::args` already rules out shell injection — nothing is ever split by
/// a shell here. What it does not rule out is *option* injection: a ref really
/// can be called `-oops` (`git update-ref refs/heads/-oops` makes one, and a
/// clone carries it), and `gh pr list --head -oops` reads that as a flag. The
/// name comes from `git status --branch` rather than from the request, which
/// is what makes this a bound on the repository instead of on the caller.
fn is_argv_safe_branch(branch: &str) -> bool {
    !branch.is_empty()
        && branch.len() <= MAX_BRANCH_BYTES
        && !branch.starts_with('-')
        && !branch.contains(|character: char| character.is_control())
}

/// Run `gh`, bounded by the smaller of its own ceiling and the caller's
/// remaining budget.
///
/// Deliberately not routed through [`run_reader`]: that function's contract is
/// about `git`, and passing `gh` through it would silently claim the same
/// guarantees for a program that does not have them.
fn run_forge(
    directory: &Path,
    arguments: &[&str],
    deadline: Instant,
) -> Result<String, &'static str> {
    let now = Instant::now();
    if now >= deadline {
        return Err("timed_out");
    }
    let deadline = deadline.min(now + FORGE_BUDGET);

    let mut command = Command::new("gh");
    command.current_dir(directory);
    command.args(arguments);
    // A prompt would hang a request nobody is watching. `gh` reads these and
    // fails instead of asking.
    command.env("GH_PROMPT_DISABLED", "1");
    command.env("GH_NO_UPDATE_NOTIFIER", "1");
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("reader_missing");
        }
        Err(_) => return Err("failed"),
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out = std::thread::spawn(move || drain(stdout));
    let err = std::thread::spawn(move || drain(stderr));

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };

    let stdout = out.join().unwrap_or(Err(Failure::ReaderFailed));
    // Read so the pipe cannot wedge the child. Kept only long enough to tell
    // three failures apart, then dropped — the host's text never travels.
    let stderr = err.join().unwrap_or(Err(Failure::ReaderFailed));

    let Some(status) = status else {
        return Err("timed_out");
    };
    let stdout = stdout.map_err(|_| "failed")?;
    if status.success() {
        return Ok(stdout);
    }
    // `gh` gives one exit code for all of these, and the difference is exactly
    // what the person needs: log in, or this is not a hosted repository.
    let stderr = stderr.unwrap_or_default().to_ascii_lowercase();
    if stderr.contains("not logged into") || stderr.contains("authentication") {
        return Err("not_authenticated");
    }
    if stderr.contains("could not determine") || stderr.contains("no git remote") {
        return Err("not_hosted");
    }
    Err("failed")
}

/// What one file's patch read produced.
///
/// `Binary` is not a failure. A screen that draws it as one sends somebody
/// looking for a broken repository when the honest answer is that a PNG has no
/// lines to show.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DiffOutcome {
    Read {
        patch: String,
        truncated: bool,
        /// From the same numstat row that admitted the path. Absent means the
        /// reader did not count — never zero as a stand-in.
        added: Option<u32>,
        deleted: Option<u32>,
    },
    Binary,
    /// The reason is one of a closed set minted in this file.
    Unavailable(&'static str),
}

/// Whether a value may be handed to another program as a revision.
///
/// Hexadecimal and nothing else. That single property is what makes a
/// caller-supplied revision admissible at all: hex cannot begin with `-`, so it
/// cannot become a flag; it cannot contain a `/` or a `..`, so it cannot become
/// a path or a range; and it cannot name a branch, so it cannot reach a ref
/// whose own name is hostile. The length bounds match git's own — four is the
/// shortest abbreviation git will resolve, forty is a full SHA-1.
fn is_argv_safe_sha(revision: &str) -> bool {
    (4..=40).contains(&revision.len())
        && revision
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

/// Read one file's patch, spending no more than `budget` in total.
///
/// # Why a path from the caller is admissible here
///
/// [`read`] takes nothing from the request and says so in this module's
/// preamble. This function takes a path, and what keeps that from being a
/// command channel is not a character check — it is that the path must appear
/// in a list **this box just produced**. The reader runs its own `diff` (or
/// `show`) first, and a path that is not in that answer is refused before any
/// second command is composed. The caller chooses among what the repository
/// offered; it never names something the repository did not.
///
/// The same rule covers `commit`: it is a short SHA the commits read handed
/// out, and [`is_argv_safe_sha`] proves the shape before it becomes argv.
pub(crate) fn read_file_diff(
    directory: &Path,
    path: &str,
    commit: Option<&str>,
    budget: Duration,
) -> DiffOutcome {
    if !directory.is_absolute() || !directory.is_dir() {
        return DiffOutcome::Unavailable("directory_missing");
    }
    if path.is_empty() {
        return DiffOutcome::Unavailable("path_not_listed");
    }
    if let Some(commit) = commit {
        if !is_argv_safe_sha(commit) {
            return DiffOutcome::Unavailable("commit_unreadable");
        }
    }
    let deadline = Instant::now() + budget;

    // Everything below runs at the repository root, because that is what the
    // paths in a `--raw` answer are relative to. The session's directory can be
    // any subdirectory, and a pathspec resolved against it would silently miss
    // every file outside it.
    let root = match run_reader(directory, &["rev-parse", "--show-toplevel"], deadline) {
        Ok(output) => output.trim().to_string(),
        Err(Failure::NotVersioned) => return DiffOutcome::Unavailable("not_versioned"),
        Err(other) => return DiffOutcome::Unavailable(other.reason()),
    };
    if root.is_empty() {
        return DiffOutcome::Unavailable("not_versioned");
    }
    let root = Path::new(&root);

    let (listing, patch_argv_head) = match commit {
        // One commit's own change. `--format=` keeps the message out of the
        // patch: the screen already has it from the commit list, and printing
        // it here would put repository text at the top of a body the phone
        // renders as code.
        Some(sha) => (
            vec![
                "show",
                "--format=",
                "--raw",
                "--numstat",
                "-z",
                "-M",
                "--no-ext-diff",
                sha,
            ],
            vec![
                "show",
                "--format=",
                "--no-color",
                "--no-ext-diff",
                "-M",
                sha,
            ],
        ),
        None => {
            let Some((revision, _)) = base_revision(root, deadline) else {
                // No base ref resolved, so the list the phone is looking at was
                // built against HEAD. Say that rather than answering about a
                // comparison it did not ask for.
                return read_file_diff_against(root, "HEAD", path, deadline);
            };
            return read_file_diff_against(root, &revision, path, deadline);
        }
    };
    diff_one(root, &listing, &patch_argv_head, path, deadline)
}

/// The uncommitted half: everything since `revision`, plus the untracked files
/// that comparison cannot see.
fn read_file_diff_against(
    root: &Path,
    revision: &str,
    path: &str,
    deadline: Instant,
) -> DiffOutcome {
    let listing = vec![
        "diff",
        "--raw",
        "--numstat",
        "-z",
        "-M",
        "--no-ext-diff",
        revision,
        "--",
    ];
    let patch = vec!["diff", "--no-color", "--no-ext-diff", "-M", revision];
    match diff_one(root, &listing, &patch, path, deadline) {
        // A file git has never seen is in the phone's list — the status walk
        // put it there — but no comparison against a revision can show it.
        // Falling back is what makes tapping such a row work at all.
        DiffOutcome::Unavailable("path_not_listed") => untracked_diff(root, path, deadline),
        other => other,
    }
}

/// Run the listing, admit the path, then read exactly that path's patch.
fn diff_one(
    root: &Path,
    listing: &[&str],
    patch_argv_head: &[&str],
    path: &str,
    deadline: Instant,
) -> DiffOutcome {
    let listed = match run_reader(root, listing, deadline) {
        Ok(output) => parse_raw_numstat(&output),
        Err(Failure::NotVersioned) => return DiffOutcome::Unavailable("not_versioned"),
        Err(other) => return DiffOutcome::Unavailable(other.reason()),
    };
    let Some(file) = listed.into_iter().find(|file| file.path == path) else {
        return DiffOutcome::Unavailable("path_not_listed");
    };
    // A binary file has no body to read, and asking for one spends a command to
    // be told so. The numstat row already said it: both counts absent.
    if file.added.is_none() && file.deleted.is_none() {
        return DiffOutcome::Binary;
    }

    let mut argv: Vec<&str> = patch_argv_head.to_vec();
    argv.push("--");
    argv.push(&file.path);
    // A rename's patch lives under both names; asking for only the new one
    // gives an empty body for the very row that says something moved.
    if let Some(old) = file.old_path.as_deref() {
        argv.push(old);
    }
    match run_reader(root, &argv, deadline) {
        Ok(patch) => bounded(patch, file.added, file.deleted),
        Err(Failure::NotVersioned) => DiffOutcome::Unavailable("not_versioned"),
        Err(other) => DiffOutcome::Unavailable(other.reason()),
    }
}

/// A file git has never tracked, compared against nothing.
///
/// `--no-index` is the only shape that shows one, and it exits non-zero when
/// the two sides differ — which is every call that has anything to report. So
/// this is the one place that reads a patch without [`run_reader`]'s
/// success-means-zero rule, and it recovers the ± counts by counting the body
/// rather than by asking again.
fn untracked_diff(root: &Path, path: &str, deadline: Instant) -> DiffOutcome {
    // The path is not from a diff listing here, so it is admitted by the status
    // walk instead — the same rule, a different reader.
    let status = match run_reader(root, &["status", "--porcelain=v2", "-z"], deadline) {
        Ok(output) => output,
        Err(Failure::NotVersioned) => return DiffOutcome::Unavailable("not_versioned"),
        Err(other) => return DiffOutcome::Unavailable(other.reason()),
    };
    let untracked = parse_status(&status)
        .files
        .into_iter()
        .any(|file| file.path == path && file.status == "?");
    if !untracked {
        return DiffOutcome::Unavailable("path_not_listed");
    }
    let absolute = root.join(path);
    let Some(absolute) = absolute.to_str() else {
        return DiffOutcome::Unavailable("path_not_listed");
    };
    // `--no-index` exits 1 for "they differ", which is every call that has
    // anything to report. Every other shape here reports trouble that way, so the
    // relaxation is passed in rather than made a property of the reader.
    match run_reader_with(
        root,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-index",
            "--",
            "/dev/null",
            absolute,
        ],
        deadline,
        ExitPolicy::DifferencesAreAnswers,
    ) {
        Ok(patch) => {
            let added = u32::try_from(
                patch
                    .lines()
                    .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
                    .count(),
            )
            .ok();
            bounded(patch, added, Some(0))
        }
        Err(failure) => DiffOutcome::Unavailable(failure.reason()),
    }
}

/// Cut at a line boundary and say so, or hand the body over whole.
fn bounded(patch: String, added: Option<u32>, deleted: Option<u32>) -> DiffOutcome {
    if patch.len() <= MAX_PATCH_BYTES {
        return DiffOutcome::Read {
            patch,
            truncated: false,
            added,
            deleted,
        };
    }
    let mut end = MAX_PATCH_BYTES;
    while end > 0 && !patch.is_char_boundary(end) {
        end -= 1;
    }
    // Half a line is content the repository does not contain. When one line is
    // longer than the whole ceiling there is no boundary to find, and the char
    // boundary is the most that can be honoured.
    let cut = patch[..end].rfind('\n').map_or(end, |index| index + 1);
    DiffOutcome::Read {
        patch: patch[..cut].to_string(),
        truncated: true,
        added,
        deleted,
    }
}

/// The merge base with the repository's default branch, and the ref it used.
fn base_revision(directory: &Path, deadline: Instant) -> Option<(String, String)> {
    let run = |arguments: &[&str]| run_reader(directory, arguments, deadline);
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(head) = run(&["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]) {
        if let Some(short) = head.trim().strip_prefix("refs/remotes/") {
            if !short.is_empty() {
                candidates.push(short.to_string());
            }
        }
    }
    for fallback in ["origin/main", "origin/master", "main", "master"] {
        candidates.push(fallback.to_string());
    }
    for candidate in candidates {
        let commit = format!("{candidate}^{{commit}}");
        if run(&["rev-parse", "--verify", "--quiet", &commit]).is_err() {
            continue;
        }
        if let Ok(merge_base) = run(&["merge-base", &candidate, "HEAD"]) {
            let merge_base = merge_base.trim().to_string();
            if !merge_base.is_empty() {
                return Some((merge_base, candidate));
            }
        }
    }
    None
}

/// Why a command did not produce an answer.
enum Failure {
    NotVersioned,
    TimedOut,
    ReaderMissing,
    ReaderFailed,
    OutputTooLarge,
}

impl Failure {
    /// The same failure, named for the commits tab. A screen that shows one
    /// sentence for "the file list timed out" and "the commit list timed out"
    /// sends a person to look in the wrong place.
    fn commits_reason(&self) -> &'static str {
        match self {
            Self::NotVersioned => "not_versioned",
            Self::TimedOut => "timed_out",
            Self::ReaderMissing => "reader_missing",
            Self::ReaderFailed => "reader_failed",
            Self::OutputTooLarge => "output_too_large",
        }
    }

    fn reason(&self) -> &'static str {
        match self {
            // Never reported as a reason — the caller turns it into a fact.
            Self::NotVersioned => "not_versioned",
            Self::TimedOut => "timed_out",
            Self::ReaderMissing => "reader_missing",
            Self::ReaderFailed => "reader_failed",
            Self::OutputTooLarge => "output_too_large",
        }
    }
}

/// What a non-zero exit means for one argv.
///
/// Only `diff --no-index` needs the second value, and it is passed in rather
/// than inferred: relaxing the rule for every shape would turn a failed read
/// into an empty patch, which draws as a file that did not change.
#[derive(Clone, Copy, Eq, PartialEq)]
enum ExitPolicy {
    Strict,
    DifferencesAreAnswers,
}

fn run_reader(directory: &Path, arguments: &[&str], deadline: Instant) -> Result<String, Failure> {
    run_reader_with(directory, arguments, deadline, ExitPolicy::Strict)
}

fn run_reader_with(
    directory: &Path,
    arguments: &[&str],
    deadline: Instant,
    exits: ExitPolicy,
) -> Result<String, Failure> {
    if Instant::now() >= deadline {
        return Err(Failure::TimedOut);
    }
    let mut command = Command::new(READER);
    command.current_dir(directory);
    command.args(HARDENING);
    command.args(arguments);
    for name in CLEARED_ENVIRONMENT {
        command.env_remove(name);
    }
    // Config counted through the environment outranks `-c`, so the count is
    // cleared above; the individual pairs are cleared here because their names
    // are indexed rather than fixed.
    for (name, _) in std::env::vars_os() {
        let text = name.to_string_lossy();
        if text.starts_with("GIT_CONFIG_KEY_") || text.starts_with("GIT_CONFIG_VALUE_") {
            command.env_remove(name);
        }
    }
    command.env("GIT_OPTIONAL_LOCKS", "0");
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GIT_PAGER", "cat");
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(Failure::ReaderMissing);
        }
        Err(_) => return Err(Failure::ReaderFailed),
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out = std::thread::spawn(move || drain(stdout));
    let err = std::thread::spawn(move || drain(stderr));

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };

    let stdout = out.join().unwrap_or(Err(Failure::ReaderFailed));
    // Read so the pipe cannot fill and wedge the child, then dropped: a
    // repository's error text must never become a sentence on a phone.
    let _ = err.join();

    let Some(status) = status else {
        return Err(Failure::TimedOut);
    };
    let stdout = stdout?;
    if status.success() {
        return Ok(stdout);
    }
    // 128 is what the reader answers for "not a repository" among other
    // things; the caller distinguishes by which command asked.
    if status.code() == Some(128) {
        return Err(Failure::NotVersioned);
    }
    if exits == ExitPolicy::DifferencesAreAnswers && status.code() == Some(1) {
        return Ok(stdout);
    }
    Err(Failure::ReaderFailed)
}

fn drain(stream: Option<impl std::io::Read>) -> Result<String, Failure> {
    let Some(mut stream) = stream else {
        return Err(Failure::ReaderFailed);
    };
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                if buffer.len() + read > MAX_OUTPUT_BYTES {
                    return Err(Failure::OutputTooLarge);
                }
                buffer.extend_from_slice(&chunk[..read]);
            }
            Err(_) => return Err(Failure::ReaderFailed),
        }
    }
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

/// `status --porcelain=v2 --branch -z`: the branch line, the upstream counts,
/// and every untracked path. Tracked changes come from the diff instead, which
/// is the only source with ± line counts.
fn parse_status(output: &str) -> Snapshot {
    let mut snapshot = Snapshot::default();
    for record in output.split('\0') {
        if record.is_empty() {
            continue;
        }
        if let Some(head) = record.strip_prefix("# branch.head ") {
            let head = head.trim();
            // git says "(detached)" when there is no branch. A name we made up
            // would be worse than none.
            if !head.is_empty() && head != "(detached)" {
                snapshot.branch = Some(head.to_string());
            }
        } else if let Some(divergence) = record.strip_prefix("# branch.ab ") {
            for part in divergence.split_whitespace() {
                if let Some(ahead) = part.strip_prefix('+') {
                    snapshot.ahead = ahead.parse().ok();
                } else if let Some(behind) = part.strip_prefix('-') {
                    snapshot.behind = behind.parse().ok();
                }
            }
        } else if let Some(path) = record.strip_prefix("? ") {
            if !path.is_empty() {
                snapshot.files.push(FileChange {
                    path: path.to_string(),
                    status: "?".to_string(),
                    old_path: None,
                    // Nobody counted an untracked file's lines. Absent, not zero.
                    added: None,
                    deleted: None,
                });
            }
        }
    }
    snapshot
}

/// `diff --raw --numstat -z`: the raw block gives status letters, the numstat
/// block gives ± counts. Ported from the desktop reader, whose rename handling
/// (an empty third field means two more records follow) is the part that is
/// easy to get wrong.
fn parse_raw_numstat(output: &str) -> Vec<FileChange> {
    let mut statuses: HashMap<String, String> = HashMap::new();
    let mut rows: Vec<FileChange> = Vec::new();
    let mut records = output.split('\0');
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if let Some(meta) = record.strip_prefix(':') {
            let letter = meta
                .split_whitespace()
                .last()
                .and_then(|field| field.chars().next())
                .unwrap_or('M');
            if letter == 'R' || letter == 'C' {
                let _old = records.next().unwrap_or("");
                let new = records.next().unwrap_or("");
                statuses.insert(new.to_string(), letter.to_string());
            } else {
                let path = records.next().unwrap_or("");
                statuses.insert(path.to_string(), letter.to_string());
            }
            continue;
        }
        let mut fields = record.splitn(3, '\t');
        // A binary file prints `-` for both counts; that parse fails and the
        // count stays absent, which is the answer.
        let added = fields.next().unwrap_or("").trim().parse::<u32>().ok();
        let deleted = fields.next().unwrap_or("").trim().parse::<u32>().ok();
        let path = fields.next().unwrap_or("");
        if path.is_empty() {
            let old = records.next().unwrap_or("").to_string();
            let new = records.next().unwrap_or("").to_string();
            if !new.is_empty() {
                rows.push(FileChange {
                    path: new,
                    status: "R".to_string(),
                    old_path: Some(old),
                    added,
                    deleted,
                });
            }
        } else {
            rows.push(FileChange {
                path: path.to_string(),
                status: "M".to_string(),
                old_path: None,
                added,
                deleted,
            });
        }
    }
    for row in &mut rows {
        if let Some(letter) = statuses.get(&row.path) {
            row.status = letter.clone();
        }
    }
    rows
}

/// Tracked changes go in front of the untracked ones the status walk found.
fn merge_tracked(snapshot: &mut Snapshot, mut tracked: Vec<FileChange>) {
    let known: std::collections::HashSet<&String> = tracked
        .iter()
        .map(|file| &file.path)
        .collect::<Vec<_>>()
        .into_iter()
        .collect();
    let untracked: Vec<FileChange> = snapshot
        .files
        .drain(..)
        .filter(|file| !known.contains(&file.path))
        .collect();
    tracked.extend(untracked);
    snapshot.files = tracked;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The branch line, the upstream counts, and untracked paths — the three
    /// things only `status` knows.
    #[test]
    fn a_status_walk_reads_the_branch_the_counts_and_untracked_paths() {
        let recorded = "# branch.oid abc123\0# branch.head fix/payment-retry\0\
# branch.upstream origin/fix/payment-retry\0# branch.ab +2 -1\0? notes.md\0";

        let snapshot = parse_status(recorded);

        assert_eq!(snapshot.branch.as_deref(), Some("fix/payment-retry"));
        assert_eq!(snapshot.ahead, Some(2));
        assert_eq!(snapshot.behind, Some(1));
        assert_eq!(snapshot.files.len(), 1);
        assert_eq!(snapshot.files[0].path, "notes.md");
        assert_eq!(snapshot.files[0].status, "?");
        // Nobody counted an untracked file's lines. Absent, not zero.
        assert!(snapshot.files[0].added.is_none());
    }

    /// A detached HEAD has no branch name. A name we invented would be worse
    /// than none — the phone draws nothing.
    #[test]
    fn a_detached_head_has_no_branch_rather_than_a_made_up_one() {
        let snapshot = parse_status("# branch.oid abc123\0# branch.head (detached)\0");

        assert!(snapshot.branch.is_none());
    }

    /// No upstream means no counts. Zero would be a claim that the branch is
    /// level with something it is not tracking.
    #[test]
    fn no_upstream_means_no_counts_rather_than_zero() {
        let snapshot = parse_status("# branch.head main\0");

        assert!(snapshot.ahead.is_none());
        assert!(snapshot.behind.is_none());
    }

    #[test]
    fn a_diff_carries_status_letters_and_line_counts() {
        let recorded = ":100644 100644 aaa bbb M\0src/app.ts\0\
:100644 100644 ccc ddd A\0src/new.ts\0\
14\t3\tsrc/app.ts\0\
9\t0\tsrc/new.ts\0";

        let files = parse_raw_numstat(recorded);

        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/app.ts");
        assert_eq!(files[0].status, "M");
        assert_eq!(files[0].added, Some(14));
        assert_eq!(files[0].deleted, Some(3));
        assert_eq!(files[1].status, "A");
    }

    /// A rename spends three records in each block. Getting this wrong shifts
    /// every following file by one, which looks like data rather than a bug.
    #[test]
    fn a_rename_carries_the_path_it_came_from() {
        let recorded = ":100644 100644 aaa bbb R100\0src/old.ts\0src/new.ts\0\
:100644 100644 ccc ddd M\0other.ts\0\
2\t0\t\0src/old.ts\0src/new.ts\0\
1\t1\tother.ts\0";

        let files = parse_raw_numstat(recorded);

        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "src/new.ts");
        assert_eq!(files[0].old_path.as_deref(), Some("src/old.ts"));
        assert_eq!(files[0].status, "R");
        // The file after the rename must still be itself.
        assert_eq!(files[1].path, "other.ts");
        assert_eq!(files[1].status, "M");
    }

    /// A binary file prints `-` for both counts. Parsing that as 0 would draw
    /// `+0 −0` for a file that changed.
    #[test]
    fn a_binary_file_has_no_counts_rather_than_zero() {
        let files = parse_raw_numstat(":100644 100644 aaa bbb M\0logo.png\0-\t-\tlogo.png\0");

        assert_eq!(files.len(), 1);
        assert!(files[0].added.is_none());
        assert!(files[0].deleted.is_none());
    }

    /// A file the diff already listed must not appear a second time from the
    /// untracked walk.
    #[test]
    fn tracked_changes_do_not_duplicate_the_untracked_walk() {
        let mut snapshot = parse_status("# branch.head main\0? notes.md\0? src/app.ts\0");
        let tracked =
            parse_raw_numstat(":100644 100644 aaa bbb M\0src/app.ts\0 1\t1\tsrc/app.ts\0");

        merge_tracked(&mut snapshot, tracked);

        let paths: Vec<&str> = snapshot
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        assert_eq!(paths, vec!["src/app.ts", "notes.md"]);
    }

    /// A repository built here, read here. The parsers above are checked
    /// against recorded bytes; this is the one that would notice if the
    /// arguments themselves stopped producing those bytes.
    #[test]
    fn a_real_repository_answers_with_its_branch_and_its_changed_files() {
        let root = tempfile::tempdir().expect("temp dir");
        let repository = root.path().canonicalize().expect("canonical");
        git(&repository, &["init", "--initial-branch=main"]);
        git(
            &repository,
            &["config", "user.email", "reader@example.invalid"],
        );
        git(&repository, &["config", "user.name", "reader"]);
        std::fs::write(repository.join("kept.txt"), "one\ntwo\n").expect("write");
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-m", "first"]);
        git(&repository, &["checkout", "-b", "fix/payment-retry"]);
        std::fs::write(repository.join("kept.txt"), "one\ntwo\nthree\n").expect("write");
        std::fs::write(repository.join("fresh.txt"), "new\n").expect("write");

        let Outcome::Read(snapshot) = read(&repository, Want::Changes, Duration::from_secs(30))
        else {
            panic!("a repository must read");
        };

        assert_eq!(snapshot.branch.as_deref(), Some("fix/payment-retry"));
        assert_eq!(snapshot.base_ref.as_deref(), Some("main"));
        assert_eq!(snapshot.comparison, Comparison::MergeBase);
        let kept = snapshot
            .files
            .iter()
            .find(|file| file.path == "kept.txt")
            .expect("the changed file");
        assert_eq!(kept.added, Some(1));
        assert_eq!(kept.deleted, Some(0));
        // The untracked file is a change too, with no counts.
        let fresh = snapshot
            .files
            .iter()
            .find(|file| file.path == "fresh.txt")
            .expect("the untracked file");
        assert_eq!(fresh.status, "?");
        assert!(fresh.added.is_none());
        assert!(!snapshot.truncated);
    }

    /// A repository with the three shapes one file's patch has to survive: a
    /// tracked edit, a file git has never seen, and something binary.
    fn diff_fixture(root: &Path) -> std::path::PathBuf {
        let repository = root.canonicalize().expect("canonical");
        git(&repository, &["init", "--initial-branch=main"]);
        git(
            &repository,
            &["config", "user.email", "reader@example.invalid"],
        );
        git(&repository, &["config", "user.name", "reader"]);
        std::fs::write(repository.join("kept.txt"), "one\ntwo\n").expect("write");
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-m", "first"]);
        git(&repository, &["checkout", "-b", "fix/payment-retry"]);
        std::fs::write(repository.join("kept.txt"), "one\ntwo\nthree\n").expect("write");
        std::fs::write(repository.join("fresh.txt"), "new\n").expect("write");
        std::fs::write(repository.join("logo.png"), [0_u8, 1, 2, 0, 3]).expect("write");
        git(&repository, &["add", "logo.png"]);
        repository
    }

    /// The patch of one file, and only that file.
    #[test]
    fn a_file_diff_reads_one_files_patch() {
        let root = tempfile::tempdir().expect("temp dir");
        let repository = diff_fixture(root.path());

        let DiffOutcome::Read {
            patch,
            truncated,
            added,
            deleted,
        } = read_file_diff(&repository, "kept.txt", None, Duration::from_secs(30))
        else {
            panic!("a listed file must read");
        };

        assert!(patch.contains("+three"), "the edit is missing:\n{patch}");
        // Another file's body here would put a title and a content from two
        // different files on one screen.
        assert!(!patch.contains("new"), "another file leaked in:\n{patch}");
        assert!(!truncated);
        assert_eq!(added, Some(1));
        assert_eq!(deleted, Some(0));
    }

    /// A file git has never seen is in the phone's list — the status walk put
    /// it there — and no comparison against a revision can show it. Without the
    /// `--no-index` fallback, tapping that row answers "not in this comparison"
    /// about a row the same reader produced.
    #[test]
    fn a_file_diff_covers_an_untracked_file() {
        let root = tempfile::tempdir().expect("temp dir");
        let repository = diff_fixture(root.path());

        let DiffOutcome::Read { patch, added, .. } =
            read_file_diff(&repository, "fresh.txt", None, Duration::from_secs(30))
        else {
            panic!("an untracked file must read");
        };

        assert!(patch.contains("+new"), "the body is empty:\n{patch}");
        assert_eq!(added, Some(1));
    }

    /// The path is admitted by a listing this box just produced. Anything else
    /// stops before a second command is composed.
    #[test]
    fn a_file_diff_refuses_a_path_the_listing_did_not_produce() {
        let root = tempfile::tempdir().expect("temp dir");
        let repository = diff_fixture(root.path());

        for candidate in ["../../etc/passwd", "kept.txt.orig", "", "-o"] {
            assert_eq!(
                read_file_diff(&repository, candidate, None, Duration::from_secs(30)),
                DiffOutcome::Unavailable("path_not_listed"),
                "{candidate} was admitted"
            );
        }
    }

    /// Hexadecimal is the whole of what makes a caller-supplied revision safe.
    #[test]
    fn a_file_diff_refuses_a_revision_that_is_not_hexadecimal() {
        let root = tempfile::tempdir().expect("temp dir");
        let repository = diff_fixture(root.path());

        for candidate in [
            "--output=/tmp/x",
            "HEAD",
            "main..HEAD",
            "abc",
            "refs/heads/main",
        ] {
            assert_eq!(
                read_file_diff(
                    &repository,
                    "kept.txt",
                    Some(candidate),
                    Duration::from_secs(30)
                ),
                DiffOutcome::Unavailable("commit_unreadable"),
                "{candidate} was admitted as a revision"
            );
        }
    }

    /// A binary file is read successfully and has no body. Not a failure, and
    /// not an empty patch — a screen that draws either would claim the image
    /// is unchanged.
    #[test]
    fn a_file_diff_reports_a_binary_file_without_a_body() {
        let root = tempfile::tempdir().expect("temp dir");
        let repository = diff_fixture(root.path());

        assert_eq!(
            read_file_diff(&repository, "logo.png", None, Duration::from_secs(30)),
            DiffOutcome::Binary
        );
    }

    /// One commit's own change, asked for by the short SHA the commits read
    /// handed out.
    #[test]
    fn a_file_diff_of_a_commit_excludes_the_worktree() {
        let root = tempfile::tempdir().expect("temp dir");
        let repository = diff_fixture(root.path());
        git(&repository, &["add", "kept.txt"]);
        git(&repository, &["commit", "-m", "second"]);
        std::fs::write(repository.join("kept.txt"), "one\ntwo\nthree\nfour\n").expect("write");
        let head = git_output(&repository, &["rev-parse", "--short", "HEAD"]);

        let DiffOutcome::Read { patch, .. } = read_file_diff(
            &repository,
            "kept.txt",
            Some(head.trim()),
            Duration::from_secs(30),
        ) else {
            panic!("a committed file must read");
        };

        assert!(
            patch.contains("+three"),
            "the commit's change is missing:\n{patch}"
        );
        // A file opened from a commit that shows what is on disk right now is
        // drawing a different moment than the one asked about.
        assert!(!patch.contains("+four"), "the worktree leaked in:\n{patch}");
    }

    /// The reader runs at the repository root, so a session standing in a
    /// subdirectory still resolves the root-relative paths its own list gave.
    #[test]
    fn a_file_diff_works_from_a_subdirectory_of_the_repository() {
        let root = tempfile::tempdir().expect("temp dir");
        let repository = diff_fixture(root.path());
        std::fs::create_dir(repository.join("sub")).expect("mkdir");

        let DiffOutcome::Read { patch, .. } = read_file_diff(
            &repository.join("sub"),
            "kept.txt",
            None,
            Duration::from_secs(30),
        ) else {
            panic!("a subdirectory must resolve the root");
        };

        assert!(patch.contains("+three"), "the edit is missing:\n{patch}");
    }

    /// The commits tab reads the commits, and only the commits.
    ///
    /// The file list is cleared deliberately: this answer never compared the
    /// worktree, so carrying the untracked paths `status` happened to collect
    /// would let the branch card count files this read did not measure.
    #[test]
    fn the_commits_tab_answers_with_the_commits_since_the_base_ref() {
        let root = tempfile::tempdir().expect("temp dir");
        let repository = root.path().canonicalize().expect("canonical");
        git(&repository, &["init", "--initial-branch=main"]);
        git(
            &repository,
            &["config", "user.email", "reader@example.invalid"],
        );
        git(&repository, &["config", "user.name", "reader"]);
        std::fs::write(repository.join("kept.txt"), "one\n").expect("write");
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-m", "first"]);
        git(&repository, &["checkout", "-b", "fix/payment-retry"]);
        std::fs::write(repository.join("kept.txt"), "one\ntwo\n").expect("write");
        git(&repository, &["add", "."]);
        git(
            &repository,
            &["commit", "-m", "size the guard to this volume"],
        );
        // Untracked, so `status` sees it and this answer must still not count it.
        std::fs::write(repository.join("fresh.txt"), "new\n").expect("write");

        let Outcome::Read(snapshot) = read(&repository, Want::Commits, Duration::from_secs(30))
        else {
            panic!("a repository must read");
        };

        assert!(!snapshot.files_read);
        assert!(snapshot.files.is_empty());
        assert_eq!(snapshot.branch.as_deref(), Some("fix/payment-retry"));
        let Some(Commits::Read { commits, truncated }) = snapshot.commits else {
            panic!("the commits tab must carry commits");
        };
        assert!(!truncated);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "size the guard to this volume");
        assert_eq!(commits[0].author, "reader");
        assert!(!commits[0].short_sha.is_empty());
        // Made on this box so the phone never reconciles two clocks.
        assert!(commits[0].when.contains("ago") || commits[0].when.contains("second"));
    }

    /// A branch sitting exactly on its base has no commits, and that is an
    /// answer. `Commits::Read` with an empty list is how it is told apart from
    /// a read that could not happen.
    #[test]
    fn a_branch_at_its_base_answers_with_no_commits_rather_than_a_failure() {
        let root = tempfile::tempdir().expect("temp dir");
        let repository = root.path().canonicalize().expect("canonical");
        git(&repository, &["init", "--initial-branch=main"]);
        git(
            &repository,
            &["config", "user.email", "reader@example.invalid"],
        );
        git(&repository, &["config", "user.name", "reader"]);
        std::fs::write(repository.join("kept.txt"), "one\n").expect("write");
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-m", "first"]);
        git(&repository, &["checkout", "-b", "worktree/idle"]);

        let Outcome::Read(snapshot) = read(&repository, Want::Commits, Duration::from_secs(30))
        else {
            panic!("a repository must read");
        };

        assert_eq!(
            snapshot.commits,
            Some(Commits::Read {
                commits: Vec::new(),
                truncated: false
            })
        );
    }

    /// Reading a commit must never run a signature verifier.
    ///
    /// `git log` honours `log.showSignature`, and a box owner who turned it on
    /// for themselves would have a remote key spawning `gpg.program` on the
    /// signature bytes of a commit it just asked to have read. Measured on git
    /// 2.55.0: without the two settings this asserts, a forged `gpgsig` header
    /// ran the configured program.
    #[test]
    fn reading_commits_never_spawns_a_signature_verifier() {
        assert!(HARDENING.contains(&"log.showSignature=false"));

        let root = tempfile::tempdir().expect("temp dir");
        let repository = root.path().canonicalize().expect("canonical");
        git(&repository, &["init", "--initial-branch=main"]);
        git(
            &repository,
            &["config", "user.email", "reader@example.invalid"],
        );
        git(&repository, &["config", "user.name", "reader"]);
        std::fs::write(repository.join("kept.txt"), "one\n").expect("write");
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-m", "first"]);

        let sentinel = repository.join("verifier-ran");
        let program = repository.join("verifier.sh");
        std::fs::write(
            &program,
            format!("#!/bin/sh\ntouch {}\nexit 1\n", sentinel.display()),
        )
        .expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
        }
        git(&repository, &["config", "log.showSignature", "true"]);
        git(
            &repository,
            &["config", "gpg.program", &program.display().to_string()],
        );
        // A commit object carrying a signature header, which is what makes the
        // verifier run at all. It must be a CHILD of the base ref, or the
        // `merge_base..HEAD` range is empty and `git log` never reads it —
        // which would make this test pass without the setting it is guarding.
        let tree = git_output(&repository, &["rev-parse", "HEAD^{tree}"])
            .trim()
            .to_string();
        let base = git_output(&repository, &["rev-parse", "HEAD"])
            .trim()
            .to_string();
        let object = format!(
            "tree {tree}\nparent {base}\nauthor reader <reader@example.invalid> 0 +0000\ncommitter reader <reader@example.invalid> 0 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n bogus\n -----END PGP SIGNATURE-----\n\nsigned\n"
        );
        let signed = hash_commit_object(&repository, &object);
        git(&repository, &["checkout", "-B", "worktree/signed", &signed]);

        let _ = read(&repository, Want::Commits, Duration::from_secs(30));

        assert!(
            !sentinel.exists(),
            "reading commits must not run the configured signature verifier"
        );
    }

    /// A branch really can be called `-x`, and `gh pr list --head -x` reads
    /// that as a flag. `Command::args` stops a shell from splitting it; it does
    /// not stop the receiving program from parsing it.
    #[test]
    fn a_branch_name_that_looks_like_a_flag_never_becomes_argv() {
        assert!(is_argv_safe_branch("fix/payment-retry"));
        assert!(!is_argv_safe_branch("-oops"));
        assert!(!is_argv_safe_branch("--version"));
        assert!(!is_argv_safe_branch(""));
        assert!(!is_argv_safe_branch("has\nnewline"));
        assert!(!is_argv_safe_branch(&"x".repeat(MAX_BRANCH_BYTES + 1)));
    }

    /// A detached HEAD has no branch, so there is no review to ask about — and
    /// the reader must answer that rather than spawning `gh` with nothing.
    #[test]
    fn a_review_is_not_asked_for_without_a_branch_to_ask_about() {
        let root = tempfile::tempdir().expect("temp dir");
        let repository = root.path().canonicalize().expect("canonical");

        assert_eq!(
            read_review(&repository, None, Instant::now() + Duration::from_secs(5)),
            Review::Unavailable("not_hosted")
        );
    }

    /// A directory with no repository is a fact, not a failure. Drawing it as
    /// an error sends somebody looking for a network problem.
    #[test]
    fn a_plain_directory_is_not_versioned_rather_than_unavailable() {
        let root = tempfile::tempdir().expect("temp dir");
        let plain = root.path().canonicalize().expect("canonical");

        assert_eq!(
            read(&plain, Want::Changes, Duration::from_secs(30)),
            Outcome::NotVersioned
        );
    }

    /// **The sentinel.** A repository can name a program in its own config and
    /// have a mere *read* run it. Asserting the argv would only prove what this
    /// module intends; this proves what the reader actually did.
    #[cfg(unix)]
    #[test]
    fn a_repository_cannot_make_a_read_run_its_own_program() {
        let root = tempfile::tempdir().expect("temp dir");
        let repository = root.path().canonicalize().expect("canonical");
        git(&repository, &["init", "--initial-branch=main"]);
        git(
            &repository,
            &["config", "user.email", "reader@example.invalid"],
        );
        git(&repository, &["config", "user.name", "reader"]);
        std::fs::write(repository.join("kept.txt"), "one\n").expect("write");
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-m", "first"]);

        let sentinel = repository.join("fsmonitor-ran");
        let hook = repository.join("hook.sh");
        std::fs::write(
            &hook,
            format!("#!/bin/sh\ntouch {}\nexit 1\n", sentinel.display()),
        )
        .expect("write hook");
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        git(
            &repository,
            &["config", "core.fsmonitor", hook.to_str().expect("utf8")],
        );
        std::fs::write(repository.join("kept.txt"), "one\ntwo\n").expect("write");

        let _ = read(&repository, Want::Changes, Duration::from_secs(30));

        assert!(
            !sentinel.exists(),
            "the repository's own program ran during a read"
        );
    }

    /// A fixture git process that cannot see the machine's own configuration.
    /// Global settings such as `commit.gpgsign` otherwise leak in and make
    /// fixture commits demand a signing key the test environment lacks. Each
    /// fixture repository sets its own local identity, which survives this.
    fn fixture_git(directory: &Path, arguments: &[&str]) -> Command {
        let mut command = Command::new("git");
        command
            .current_dir(directory)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .args(arguments)
            .stdin(Stdio::null());
        command
    }

    /// The fixture's own reader. Deliberately *not* the hardened one — a
    /// fixture that cannot set `core.fsmonitor` could not test that it is
    /// ignored.
    fn git(directory: &Path, arguments: &[&str]) {
        let status = fixture_git(directory, arguments)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("the fixture needs git");
        assert!(status.success(), "fixture git {arguments:?} failed");
    }

    /// The same, but keeping what it printed.
    fn git_output(directory: &Path, arguments: &[&str]) -> String {
        let output = fixture_git(directory, arguments)
            .output()
            .expect("the fixture needs git");
        assert!(output.status.success(), "fixture git {arguments:?} failed");
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    /// Writes a commit object verbatim, which is the only way to get a
    /// signature header onto one without a real key.
    fn hash_commit_object(directory: &Path, object: &str) -> String {
        let mut child = fixture_git(directory, &["hash-object", "-t", "commit", "-w", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the fixture needs git");
        {
            use std::io::Write as _;
            child
                .stdin
                .as_mut()
                .expect("stdin")
                .write_all(object.as_bytes())
                .expect("write the object");
        }
        let output = child.wait_with_output().expect("hash-object");
        assert!(output.status.success(), "fixture hash-object failed");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn a_directory_that_is_not_absolute_is_refused_before_anything_runs() {
        let outcome = read(
            Path::new("relative/path"),
            Want::Changes,
            Duration::from_secs(1),
        );

        assert_eq!(outcome, Outcome::Unavailable("directory_missing"));
    }
}
