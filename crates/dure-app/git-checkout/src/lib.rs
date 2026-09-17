//! Exact capture-and-remove authority for one local linked Git worktree.
//!
//! Branch and HEAD are intentionally absent from the receipt: they are mutable
//! checkout state. The canonical path is retained because it is also the
//! caller's frozen removal scope. A moved or replacement checkout must be
//! selected and stopped again before it can be removed.

pub use dure_app_protocol::{
    GIT_CHECKOUT_SCHEMA_VERSION_V1, GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
    GitCheckoutCaptureRequestV1, GitCheckoutCreationReservationV1, GitCheckoutInstanceV1,
    GitCheckoutLocationV1, GitCheckoutPathObservationV1, GitCheckoutRegistrationV1,
    GitCheckoutRemovalOutcomeV1,
    GitCheckoutRemovalPermitV1, GitCheckoutRemovalPolicyV1, GitCheckoutRemovalReceiptV1,
    GitCheckoutRemovalRequestV1, GitCheckoutUseActionV1, GitCheckoutUseClaimV1,
    GitCheckoutUseOutcomeV1, GitCheckoutUsePhaseV1, GitCheckoutUsePhysicalRemovalRequestV1,
    GitCheckoutUseReceiptV1, GitCheckoutUseRequestV1, GitCheckoutUseRevisionV1,
    MAX_GIT_CHECKOUT_USE_ACTIVE_CLAIMS_V1, MAX_GIT_CHECKOUT_USE_PATH_BYTES_V1,
    MAX_GIT_CHECKOUT_USE_REVISION_V1,
};
use fs2::FileExt as _;
use serde::Serialize;
use std::fmt::Write as _;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::process::Command;

mod git_process;
#[cfg(test)]
use git_process::scrub_git_environment;
use git_process::{checkout_is_clean_for_plain_remove, git_output};
#[cfg(all(test, unix))]
use git_process::{checkout_is_clean_with_timeout, git_output_with_timeout};

mod authority;
#[cfg(unix)]
pub use authority::{
    AdmittedGitCheckoutCreation, GitCheckoutCreationOperation, prepare_git_checkout_creation,
};
pub use authority::{
    AdmittedGitCheckoutRemoval, GitCheckoutRemovalOperation, GitCheckoutUseError,
    apply_git_checkout_use, capture_git_checkout_registration, claim_git_checkout_registration,
    read_git_checkout_claims, read_working_directory_claims, release_git_checkout_registration,
    release_working_directory, remove_git_checkout_with_permit, retain_working_directory,
};

pub const INSTANCE_TOKEN_FILE: &str = "dure-worktree-instance-v1";
const INSTANCE_TOKEN_LOCK_FILE: &str = "dure-worktree-instance-v1.lock";
const INSTANCE_TOKEN_PREFIX: &str = "dwt1_";
const INSTANCE_TOKEN_RANDOM_BYTES: usize = 16;
const INSTANCE_TOKEN_BYTES: u64 =
    (INSTANCE_TOKEN_PREFIX.len() + INSTANCE_TOKEN_RANDOM_BYTES * 2) as u64;
const MAX_LOCATION_PATHS: usize = 256;
const MAX_GIT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheckoutInstanceError {
    pub code: &'static str,
    pub message: String,
}

/// Semantic outcome of a failed exact-checkout removal.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitCheckoutRemovalFailureDisposition {
    Retryable,
    Rejected,
    CheckoutReplaced,
}

impl GitCheckoutInstanceError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// Classifies errors returned by [`remove_git_checkout_instance`].
    pub fn removal_failure_disposition(&self) -> GitCheckoutRemovalFailureDisposition {
        match self.code {
            "worktree_identity_changed" => GitCheckoutRemovalFailureDisposition::CheckoutReplaced,
            "worktree_request_invalid" => GitCheckoutRemovalFailureDisposition::Rejected,
            _ => GitCheckoutRemovalFailureDisposition::Retryable,
        }
    }
}

impl std::fmt::Display for GitCheckoutInstanceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for GitCheckoutInstanceError {}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CheckoutObservation {
    canonical_path: PathBuf,
    git_common_dir: PathBuf,
    git_dir: PathBuf,
}

pub fn locate_checkout(path: &Path) -> Result<GitCheckoutLocationV1, GitCheckoutInstanceError> {
    let requested = canonical(path, "checkout location")?;
    locate_canonical_checkout(&requested)
}

fn locate_canonical_checkout(
    requested: &Path,
) -> Result<GitCheckoutLocationV1, GitCheckoutInstanceError> {
    let canonical_path = canonical_git_path(
        requested,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
        "checkout top level",
    )?;
    let git_common_dir = canonical_git_path(
        &canonical_path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        "Git common directory",
    )?;
    Ok(GitCheckoutLocationV1 {
        schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
        canonical_path: path_string(&canonical_path, "canonical checkout path")?,
        git_common_dir: path_string(&git_common_dir, "Git common directory")?,
    })
}

/// Resolves a bounded batch without turning an unresolvable path into a batch failure.
pub fn locate_checkouts(
    paths: &[String],
) -> Result<Vec<Option<GitCheckoutPathObservationV1>>, GitCheckoutInstanceError> {
    if paths.is_empty()
        || paths.len() > MAX_LOCATION_PATHS
        || paths.iter().any(|path| !bounded_absolute_locator(path))
    {
        return Err(GitCheckoutInstanceError::new(
            "worktree_request_invalid",
            "checkout location request is invalid or exceeds its bounded size",
        ));
    }
    Ok(paths
        .iter()
        .map(|path| match std::fs::canonicalize(path) {
            Ok(requested) => locate_canonical_checkout(&requested)
                .ok()
                .map(GitCheckoutPathObservationV1::Located),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Some(GitCheckoutPathObservationV1::Absent {
                    schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
                    absent_path: path.clone(),
                })
            }
            Err(_) => None,
        })
        .collect())
}

fn error(
    code: &'static str,
    context: &str,
    detail: impl std::fmt::Display,
) -> GitCheckoutInstanceError {
    GitCheckoutInstanceError::new(code, format!("{context}: {detail}"))
}

fn git_line(repository: &Path, args: &[&str]) -> Result<String, GitCheckoutInstanceError> {
    let output = git_output(repository, args)?;
    let output = String::from_utf8(output).map_err(|_| {
        GitCheckoutInstanceError::new(
            "worktree_non_utf8_identity",
            format!("git {} returned a non-UTF-8 identity", args.join(" ")),
        )
    })?;
    let value = output.strip_suffix('\n').ok_or_else(|| {
        GitCheckoutInstanceError::new(
            "worktree_git_failed",
            format!("git {} returned an unterminated identity", args.join(" ")),
        )
    })?;
    #[cfg(windows)]
    let value = value.strip_suffix('\r').unwrap_or(value);
    if value.is_empty() {
        return Err(GitCheckoutInstanceError::new(
            "worktree_git_failed",
            format!("git {} returned an empty identity", args.join(" ")),
        ));
    }
    Ok(value.to_string())
}

fn canonical(path: &Path, label: &str) -> Result<PathBuf, GitCheckoutInstanceError> {
    std::fs::canonicalize(path).map_err(|cause| {
        error(
            "worktree_path_unavailable",
            &format!("could not resolve {label} {}", path.display()),
            cause,
        )
    })
}

fn canonical_git_path(
    repository: &Path,
    args: &[&str],
    label: &str,
) -> Result<PathBuf, GitCheckoutInstanceError> {
    canonical(Path::new(&git_line(repository, args)?), label)
}

fn path_string(path: &Path, label: &str) -> Result<String, GitCheckoutInstanceError> {
    dunce::simplified(path)
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| {
            GitCheckoutInstanceError::new(
                "worktree_non_utf8_identity",
                format!("{label} is not UTF-8: {}", path.display()),
            )
        })
}

struct RepositoryObservation {
    checkout_root: PathBuf,
    git_common_dir: PathBuf,
}

fn observe_repository(
    repository: &Path,
) -> Result<RepositoryObservation, GitCheckoutInstanceError> {
    let repository = canonical(repository, "repository")?;
    let checkout_root = if git_line(&repository, &["rev-parse", "--is-bare-repository"])? == "true"
    {
        repository.clone()
    } else {
        canonical_git_path(
            &repository,
            &["rev-parse", "--path-format=absolute", "--show-toplevel"],
            "repository checkout root",
        )?
    };
    let git_common_dir = canonical_git_path(
        &repository,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        "Git common directory",
    )?;
    Ok(RepositoryObservation {
        checkout_root,
        git_common_dir,
    })
}

fn registered_worktree_paths(repository: &Path) -> Result<Vec<PathBuf>, GitCheckoutInstanceError> {
    let output = git_output(repository, &["worktree", "list", "--porcelain", "-z"])?;
    let mut paths = Vec::new();
    for field in output.split(|byte| *byte == 0) {
        let Some(raw_path) = field.strip_prefix(b"worktree ") else {
            continue;
        };
        let raw_path = std::str::from_utf8(raw_path).map_err(|_| {
            GitCheckoutInstanceError::new(
                "worktree_non_utf8_identity",
                "git worktree list returned a non-UTF-8 path",
            )
        })?;
        paths.push(PathBuf::from(raw_path));
    }
    Ok(paths)
}

fn observe_checkout(
    repository_common: &Path,
    checkout: &Path,
) -> Result<CheckoutObservation, GitCheckoutInstanceError> {
    let canonical_path = canonical(checkout, "checkout")?;
    let top_level = canonical_git_path(
        &canonical_path,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
        "checkout top level",
    )?;
    if top_level != canonical_path {
        return Err(GitCheckoutInstanceError::new(
            "worktree_path_not_exact",
            format!(
                "checkout path is not the exact worktree root: {}",
                canonical_path.display()
            ),
        ));
    }
    let git_common_dir = canonical_git_path(
        &canonical_path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        "Git common directory",
    )?;
    if git_common_dir != repository_common {
        return Err(GitCheckoutInstanceError::new(
            "worktree_foreign_repository",
            format!(
                "checkout belongs to a different repository: {}",
                canonical_path.display()
            ),
        ));
    }
    let git_dir = canonical_git_path(
        &canonical_path,
        &["rev-parse", "--path-format=absolute", "--absolute-git-dir"],
        "private worktree Git directory",
    )?;
    let worktrees_dir = canonical(
        &git_common_dir.join("worktrees"),
        "linked-worktree Git directory root",
    )?;
    if git_dir.parent() != Some(worktrees_dir.as_path()) {
        return Err(GitCheckoutInstanceError::new(
            "worktree_not_linked",
            format!(
                "checkout does not have one private linked-worktree Git directory: {}",
                canonical_path.display()
            ),
        ));
    }
    Ok(CheckoutObservation {
        canonical_path,
        git_common_dir,
        git_dir,
    })
}

fn ensure_registered(
    repository: &Path,
    checkout: &CheckoutObservation,
) -> Result<(), GitCheckoutInstanceError> {
    let mut matches = 0;
    for listed_path in registered_worktree_paths(repository)? {
        let Ok(listed_path) = std::fs::canonicalize(listed_path) else {
            continue;
        };
        if listed_path == checkout.canonical_path {
            matches += 1;
        }
    }
    if matches != 1 {
        return Err(GitCheckoutInstanceError::new(
            "worktree_not_registered",
            format!(
                "checkout is not one exact registered linked worktree: {}",
                checkout.canonical_path.display()
            ),
        ));
    }
    Ok(())
}

fn valid_instance_token(token: &str) -> bool {
    token
        .strip_prefix(INSTANCE_TOKEN_PREFIX)
        .is_some_and(|suffix| {
            suffix.len() == INSTANCE_TOKEN_RANDOM_BYTES * 2
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
}

fn fresh_instance_token() -> Result<String, GitCheckoutInstanceError> {
    let mut random = [0_u8; INSTANCE_TOKEN_RANDOM_BYTES];
    getrandom::fill(&mut random).map_err(|cause| {
        error(
            "worktree_token_unavailable",
            "could not generate a worktree instance token",
            cause,
        )
    })?;
    let mut token = String::with_capacity(INSTANCE_TOKEN_BYTES as usize);
    token.push_str(INSTANCE_TOKEN_PREFIX);
    for byte in random {
        write!(&mut token, "{byte:02x}").map_err(|cause| {
            error(
                "worktree_token_unavailable",
                "could not encode a worktree instance token",
                cause,
            )
        })?;
    }
    Ok(token)
}

fn open_regular(path: &Path) -> Result<File, GitCheckoutInstanceError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|cause| {
        error(
            "worktree_token_unavailable",
            &format!("could not open instance token {}", path.display()),
            cause,
        )
    })?;
    let metadata = file.metadata().map_err(|cause| {
        error(
            "worktree_token_unavailable",
            &format!("could not inspect instance token {}", path.display()),
            cause,
        )
    })?;
    if !metadata.is_file() || metadata.len() != INSTANCE_TOKEN_BYTES {
        return Err(GitCheckoutInstanceError::new(
            "worktree_token_invalid",
            format!(
                "instance token is not one exact bounded regular file: {}",
                path.display()
            ),
        ));
    }
    Ok(file)
}

fn read_instance_token(path: &Path) -> Result<String, GitCheckoutInstanceError> {
    let mut file = open_regular(path)?;
    let mut bytes = Vec::with_capacity(INSTANCE_TOKEN_BYTES as usize);
    Read::by_ref(&mut file)
        .take(INSTANCE_TOKEN_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|cause| {
            error(
                "worktree_token_unavailable",
                &format!("could not read instance token {}", path.display()),
                cause,
            )
        })?;
    let token = String::from_utf8(bytes).map_err(|_| {
        GitCheckoutInstanceError::new(
            "worktree_token_invalid",
            format!("instance token is not UTF-8: {}", path.display()),
        )
    })?;
    if !valid_instance_token(&token) {
        return Err(GitCheckoutInstanceError::new(
            "worktree_token_invalid",
            format!("instance token has an invalid format: {}", path.display()),
        ));
    }
    Ok(token)
}

fn open_token_lock(git_dir: &Path) -> Result<File, GitCheckoutInstanceError> {
    let path = git_dir.join(INSTANCE_TOKEN_LOCK_FILE);
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    let file = options.open(&path).map_err(|cause| {
        error(
            "worktree_token_unavailable",
            &format!("could not open instance-token lock {}", path.display()),
            cause,
        )
    })?;
    if !file
        .metadata()
        .map_err(|cause| {
            error(
                "worktree_token_unavailable",
                &format!("could not inspect instance-token lock {}", path.display()),
                cause,
            )
        })?
        .is_file()
    {
        return Err(GitCheckoutInstanceError::new(
            "worktree_token_invalid",
            format!(
                "instance-token lock is not a regular file: {}",
                path.display()
            ),
        ));
    }
    Ok(file)
}

fn create_instance_token(path: &Path, token: &str) -> Result<(), GitCheckoutInstanceError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600).custom_flags(libc::O_CLOEXEC);
    }
    let mut file = options.open(path).map_err(|cause| {
        error(
            "worktree_token_unavailable",
            &format!("could not create instance token {}", path.display()),
            cause,
        )
    })?;
    file.write_all(token.as_bytes()).map_err(|cause| {
        error(
            "worktree_token_unavailable",
            &format!("could not write instance token {}", path.display()),
            cause,
        )
    })?;
    file.sync_all().map_err(|cause| {
        error(
            "worktree_token_unavailable",
            &format!("could not persist instance token {}", path.display()),
            cause,
        )
    })?;
    if !file
        .metadata()
        .map_err(|cause| {
            error(
                "worktree_token_unavailable",
                &format!("could not inspect instance token {}", path.display()),
                cause,
            )
        })?
        .is_file()
    {
        return Err(GitCheckoutInstanceError::new(
            "worktree_token_invalid",
            format!("instance token is not a regular file: {}", path.display()),
        ));
    }
    Ok(())
}

fn load_or_create_instance_token(git_dir: &Path) -> Result<String, GitCheckoutInstanceError> {
    let lock = open_token_lock(git_dir)?;
    lock.lock_exclusive().map_err(|cause| {
        error(
            "worktree_token_unavailable",
            "could not lock the worktree instance token",
            cause,
        )
    })?;
    let path = git_dir.join(INSTANCE_TOKEN_FILE);
    match read_instance_token(&path) {
        Ok(token) => Ok(token),
        Err(cause) if cause.code == "worktree_token_unavailable" && !path.exists() => {
            let token = fresh_instance_token()?;
            create_instance_token(&path, &token)?;
            Ok(token)
        }
        Err(cause) => Err(cause),
    }
}

fn receipt(
    observation: &CheckoutObservation,
    instance_token: String,
) -> Result<GitCheckoutInstanceV1, GitCheckoutInstanceError> {
    Ok(GitCheckoutInstanceV1 {
        schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
        canonical_path: path_string(&observation.canonical_path, "canonical checkout path")?,
        git_common_dir: path_string(&observation.git_common_dir, "Git common directory")?,
        git_dir: path_string(&observation.git_dir, "private worktree Git directory")?,
        instance_token,
    })
}

fn ensure_repository_checkout_is_distinct(
    repository_checkout: &Path,
    checkout: &CheckoutObservation,
) -> Result<(), GitCheckoutInstanceError> {
    if repository_checkout == checkout.canonical_path {
        return Err(GitCheckoutInstanceError::new(
            "worktree_path_not_distinct",
            "linked worktree is the repository checkout itself",
        ));
    }
    Ok(())
}

enum InstanceTokenAccess {
    CreateIfMissing,
    ExistingOnly,
}

fn observe_git_checkout_instance_at(
    repository: &Path,
    checkout: &Path,
    token_access: InstanceTokenAccess,
) -> Result<GitCheckoutInstanceV1, GitCheckoutInstanceError> {
    let repository = observe_repository(repository)?;
    let before = observe_checkout(&repository.git_common_dir, checkout)?;
    ensure_repository_checkout_is_distinct(&repository.checkout_root, &before)?;
    ensure_registered(&repository.checkout_root, &before)?;
    let instance_token = match token_access {
        InstanceTokenAccess::CreateIfMissing => load_or_create_instance_token(&before.git_dir)?,
        InstanceTokenAccess::ExistingOnly => {
            read_instance_token(&before.git_dir.join(INSTANCE_TOKEN_FILE))?
        }
    };
    let after = observe_checkout(&repository.git_common_dir, checkout)?;
    ensure_repository_checkout_is_distinct(&repository.checkout_root, &after)?;
    ensure_registered(&repository.checkout_root, &after)?;
    if before != after
        || read_instance_token(&after.git_dir.join(INSTANCE_TOKEN_FILE))? != instance_token
    {
        return Err(GitCheckoutInstanceError::new(
            "worktree_identity_changed",
            "linked worktree identity changed while it was observed",
        ));
    }
    receipt(&after, instance_token)
}

fn capture_git_checkout_instance_at(
    repository: &Path,
    checkout: &Path,
) -> Result<GitCheckoutInstanceV1, GitCheckoutInstanceError> {
    observe_git_checkout_instance_at(repository, checkout, InstanceTokenAccess::CreateIfMissing)
}

fn reobserve_git_checkout_instance_at(
    repository: &Path,
    checkout: &Path,
) -> Result<GitCheckoutInstanceV1, GitCheckoutInstanceError> {
    observe_git_checkout_instance_at(repository, checkout, InstanceTokenAccess::ExistingOnly)
}

pub fn capture_git_checkout_instance(
    request: &GitCheckoutCaptureRequestV1,
) -> Result<GitCheckoutInstanceV1, GitCheckoutInstanceError> {
    if !bounded_absolute_locator(&request.repository_path)
        || !bounded_absolute_locator(&request.checkout_path)
    {
        return Err(GitCheckoutInstanceError::new(
            "worktree_request_invalid",
            "checkout capture request has an invalid locator",
        ));
    }
    capture_git_checkout_instance_at(
        Path::new(&request.repository_path),
        Path::new(&request.checkout_path),
    )
}

fn validate_expected(expected: &GitCheckoutInstanceV1) -> Result<(), GitCheckoutInstanceError> {
    if expected.schema_version != GIT_CHECKOUT_SCHEMA_VERSION_V1
        || [
            &expected.canonical_path,
            &expected.git_common_dir,
            &expected.git_dir,
        ]
        .into_iter()
        .any(|path| !bounded_absolute_locator(path))
        || !valid_instance_token(&expected.instance_token)
    {
        return Err(GitCheckoutInstanceError::new(
            "worktree_request_invalid",
            "captured linked-worktree instance is invalid",
        ));
    }
    let expected_worktrees_dir = Path::new(&expected.git_common_dir).join("worktrees");
    if Path::new(&expected.git_dir).parent() != Some(expected_worktrees_dir.as_path()) {
        return Err(GitCheckoutInstanceError::new(
            "worktree_request_invalid",
            "captured private Git directory is outside the linked-worktree admin root",
        ));
    }
    Ok(())
}

struct ValidatedGitCheckoutInstance(GitCheckoutInstanceV1);

impl ValidatedGitCheckoutInstance {
    fn parse(expected: &GitCheckoutInstanceV1) -> Result<Self, GitCheckoutInstanceError> {
        validate_expected(expected)?;
        Ok(Self(expected.clone()))
    }

    fn as_instance(&self) -> &GitCheckoutInstanceV1 {
        &self.0
    }

    fn into_instance(self) -> GitCheckoutInstanceV1 {
        self.0
    }
}

fn bounded_absolute_locator(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && value.len() <= MAX_GIT_CHECKOUT_USE_PATH_BYTES_V1
        && !value.as_bytes().contains(&0)
        && path.is_absolute()
        && !value
            .as_bytes()
            .split(|byte| {
                *byte == std::path::MAIN_SEPARATOR as u8 || (cfg!(windows) && *byte == b'/')
            })
            .any(|component| matches!(component, b"." | b".."))
        && !path.components().any(|component| {
            matches!(
                component,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
}

fn target_is_absent(expected: &GitCheckoutInstanceV1) -> Result<bool, GitCheckoutInstanceError> {
    match std::fs::symlink_metadata(&expected.canonical_path) {
        Ok(_) => Ok(false),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::symlink_metadata(&expected.git_dir) {
                Ok(_) => Err(GitCheckoutInstanceError::new(
                    "worktree_path_unavailable",
                    "captured linked worktree moved or became unavailable",
                )),
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(true),
                Err(cause) => Err(error(
                    "worktree_path_unavailable",
                    "could not re-observe the captured private Git directory",
                    cause,
                )),
            }
        }
        Err(cause) => Err(error(
            "worktree_path_unavailable",
            "could not re-observe the captured linked-worktree path",
            cause,
        )),
    }
}

fn exact_target_observation_error(cause: GitCheckoutInstanceError) -> GitCheckoutInstanceError {
    let code = match cause.code {
        "worktree_foreign_repository" | "worktree_not_linked" => "worktree_identity_changed",
        code => code,
    };
    error(
        code,
        "captured linked worktree could not be re-observed exactly",
        cause,
    )
}

enum GitCheckoutPhysicalRemovalError {
    RefusedBeforeInvocation(GitCheckoutInstanceError),
    Attempted(GitCheckoutInstanceError),
}

enum GitCheckoutRemovalPreflight {
    AlreadyAbsent,
    Ready(RepositoryObservation),
}

fn preflight_plain_removal(
    repository: &Path,
    expected: &ValidatedGitCheckoutInstance,
    policy: GitCheckoutRemovalPolicyV1,
) -> Result<GitCheckoutRemovalPreflight, GitCheckoutInstanceError> {
    let expected = expected.as_instance();
    let repository = observe_repository(repository).map_err(|cause| {
        error(
            cause.code,
            "captured repository identity could not be re-observed",
            cause,
        )
    })?;
    if path_string(&repository.checkout_root, "repository checkout root")?
        == expected.canonical_path
    {
        return Err(GitCheckoutInstanceError::new(
            "worktree_path_not_distinct",
            "captured linked worktree became the repository checkout itself",
        ));
    }
    if path_string(&repository.git_common_dir, "Git common directory")? != expected.git_common_dir {
        return Err(GitCheckoutInstanceError::new(
            "worktree_foreign_repository",
            "captured linked worktree belongs to a different current repository",
        ));
    }
    if target_is_absent(expected)? {
        return Ok(GitCheckoutRemovalPreflight::AlreadyAbsent);
    }
    let current = observe_checkout(
        &repository.git_common_dir,
        Path::new(&expected.canonical_path),
    )
    .map_err(exact_target_observation_error)?;
    ensure_registered(&repository.checkout_root, &current).map_err(|cause| {
        error(
            cause.code,
            "captured linked worktree is no longer registered exactly",
            cause,
        )
    })?;
    if path_string(&current.canonical_path, "canonical checkout path")? != expected.canonical_path {
        return Err(GitCheckoutInstanceError::new(
            "worktree_path_unavailable",
            "captured linked-worktree path no longer resolves exactly",
        ));
    }
    if path_string(&current.git_dir, "private worktree Git directory")? != expected.git_dir {
        return Err(GitCheckoutInstanceError::new(
            "worktree_identity_changed",
            "a different linked-worktree instance occupies the captured path",
        ));
    }
    let current_token =
        read_instance_token(&current.git_dir.join(INSTANCE_TOKEN_FILE)).map_err(|cause| {
            error(
                cause.code,
                "captured linked-worktree token is missing or invalid",
                cause,
            )
        })?;
    if current_token != expected.instance_token {
        return Err(GitCheckoutInstanceError::new(
            "worktree_identity_changed",
            "captured linked-worktree token changed",
        ));
    }
    if policy == GitCheckoutRemovalPolicyV1::RequireClean
        && !checkout_is_clean_for_plain_remove(Path::new(&expected.canonical_path))?
    {
        return Err(GitCheckoutInstanceError::new(
            "worktree_remove_failed",
            "plain git worktree remove requires a clean captured checkout",
        ));
    }
    Ok(GitCheckoutRemovalPreflight::Ready(repository))
}

fn remove_git_checkout_instance_at_classified(
    repository: &Path,
    expected: &ValidatedGitCheckoutInstance,
    policy: GitCheckoutRemovalPolicyV1,
) -> Result<GitCheckoutRemovalReceiptV1, GitCheckoutPhysicalRemovalError> {
    let repository = match preflight_plain_removal(repository, expected, policy) {
        Ok(GitCheckoutRemovalPreflight::Ready(repository)) => repository,
        Ok(GitCheckoutRemovalPreflight::AlreadyAbsent) => {
            return Ok(removal_receipt(
                expected.as_instance(),
                GitCheckoutRemovalOutcomeV1::AlreadyAbsent,
            ));
        }
        Err(cause) => {
            return Err(GitCheckoutPhysicalRemovalError::RefusedBeforeInvocation(
                cause,
            ));
        }
    };

    let target = expected.as_instance().canonical_path.as_str();
    let arguments = match policy {
        GitCheckoutRemovalPolicyV1::RequireClean => vec!["worktree", "remove", target],
        GitCheckoutRemovalPolicyV1::DiscardChanges => {
            vec!["worktree", "remove", "--force", target]
        }
    };
    git_output(&repository.checkout_root, &arguments)
        .map_err(|cause| {
            error(
                "worktree_remove_failed",
                "plain git worktree remove refused the captured checkout",
                cause,
            )
        })
        .map_err(GitCheckoutPhysicalRemovalError::Attempted)?;
    Ok(removal_receipt(
        expected.as_instance(),
        GitCheckoutRemovalOutcomeV1::Removed,
    ))
}

#[cfg(test)]
fn remove_git_checkout_instance_at(
    repository: &Path,
    expected: &GitCheckoutInstanceV1,
) -> Result<GitCheckoutRemovalReceiptV1, GitCheckoutInstanceError> {
    let expected = ValidatedGitCheckoutInstance::parse(expected)?;
    remove_git_checkout_instance_at_classified(
        repository,
        &expected,
        GitCheckoutRemovalPolicyV1::RequireClean,
    )
    .map_err(|cause| match cause {
        GitCheckoutPhysicalRemovalError::RefusedBeforeInvocation(cause)
        | GitCheckoutPhysicalRemovalError::Attempted(cause) => cause,
    })
}

pub fn remove_git_checkout_instance(
    request: &GitCheckoutRemovalRequestV1,
) -> Result<GitCheckoutRemovalReceiptV1, GitCheckoutInstanceError> {
    authority::remove_git_checkout_instance_admitted(
        Path::new(&request.repository_path),
        &request.instance,
        request.policy,
    )
}

fn removal_receipt(
    instance: &GitCheckoutInstanceV1,
    outcome: GitCheckoutRemovalOutcomeV1,
) -> GitCheckoutRemovalReceiptV1 {
    GitCheckoutRemovalReceiptV1 {
        schema_version: GIT_CHECKOUT_SCHEMA_VERSION_V1,
        outcome,
        instance: instance.clone(),
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
