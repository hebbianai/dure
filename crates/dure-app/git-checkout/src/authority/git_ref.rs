use super::*;
use std::path::{Path, PathBuf};
use std::process::Output;

fn authority_git(
    repository: &Path,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<Output, GitCheckoutUseError> {
    super::super::git_process::capture_git_output(
        repository,
        args,
        input,
        super::super::git_process::GIT_TIMEOUT,
    )
    .map_err(|cause| GitCheckoutUseError::new("checkout_use_git_failed", cause.message))
}

fn successful_output(
    repository: &Path,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<Vec<u8>, GitCheckoutUseError> {
    let output = authority_git(repository, args, input)?;
    if !output.status.success() {
        return Err(GitCheckoutUseError::new(
            "checkout_use_git_failed",
            format!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&output.stderr).trim_end_matches(['\r', '\n'])
            ),
        ));
    }
    Ok(output.stdout)
}

fn one_git_line(bytes: Vec<u8>, context: &str) -> Result<String, GitCheckoutUseError> {
    let value = String::from_utf8(bytes)
        .map_err(|_| GitCheckoutUseError::new("checkout_use_git_failed", context))?;
    let value = value
        .strip_suffix('\n')
        .ok_or_else(|| GitCheckoutUseError::new("checkout_use_git_failed", context))?;
    #[cfg(windows)]
    let value = value.strip_suffix('\r').unwrap_or(value);
    if value.is_empty() || value.contains(['\r', '\n']) {
        return Err(GitCheckoutUseError::new("checkout_use_git_failed", context));
    }
    Ok(value.to_string())
}

fn hash_bytes(repository: &Path, bytes: &[u8], write: bool) -> Result<String, GitCheckoutUseError> {
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(GitCheckoutUseError::new(
            "checkout_use_record_too_large",
            "checkout-use hash input exceeded the bounded record size",
        ));
    }
    let args = if write {
        vec!["hash-object", "-w", "--stdin"]
    } else {
        vec!["hash-object", "--stdin"]
    };
    let oid = one_git_line(
        successful_output(repository, &args, Some(bytes))?,
        "git hash-object returned an invalid object id",
    )?;
    if !oid
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(GitCheckoutUseError::new(
            "checkout_use_git_failed",
            "git hash-object returned a non-canonical object id",
        ));
    }
    Ok(oid)
}

pub(super) fn digest_fields(
    repository: &Path,
    domain: &[u8],
    fields: &[&str],
) -> Result<String, GitCheckoutUseError> {
    let mut bytes = Vec::with_capacity(
        domain.len() + 1 + fields.iter().map(|field| field.len() + 1).sum::<usize>(),
    );
    bytes.extend_from_slice(domain);
    bytes.push(0);
    for field in fields {
        if field.as_bytes().contains(&0) {
            return Err(request_error(
                "checkout-use digest fields must not contain NUL",
            ));
        }
        bytes.extend_from_slice(field.as_bytes());
        bytes.push(0);
    }
    hash_bytes(repository, &bytes, false)
}

#[derive(Clone)]
pub(super) struct TrustedLocator(String);

impl TrustedLocator {
    pub(super) fn parse(value: &str, label: &str) -> Result<Self, GitCheckoutUseError> {
        if !super::super::bounded_absolute_locator(value) {
            return Err(request_error(format!(
                "{label} must be absolute, normal, and within its shared bound"
            )));
        }
        Ok(Self(value.to_string()))
    }

    pub(super) fn parse_path(path: &Path, label: &str) -> Result<Self, GitCheckoutUseError> {
        let value = path
            .to_str()
            .ok_or_else(|| request_error(format!("{label} must be UTF-8")))?;
        Self::parse(value, label)
    }

    pub(super) fn from_validated(value: String) -> Self {
        debug_assert!(super::super::bounded_absolute_locator(&value));
        Self(value)
    }

    pub(super) fn as_path(&self) -> &Path {
        Path::new(&self.0)
    }
}

#[derive(Clone)]
pub(super) struct Authority {
    pub(super) repository: PathBuf,
    pub(super) git_common_dir: PathBuf,
    pub(super) canonical_path: String,
    pub(super) path_digest: String,
    pub(super) reference: String,
    pub(super) oid_width: usize,
}

impl Authority {
    pub(super) fn from_trusted(
        repository: &TrustedLocator,
        canonical_path: TrustedLocator,
    ) -> Result<Self, GitCheckoutUseError> {
        let repository = super::super::observe_repository(repository.as_path())
            .map_err(|cause| instance_error(cause, InstanceErrorContext::Git))?;
        let repository_path = repository.checkout_root;
        let git_common_dir = repository.git_common_dir;
        let canonical_path = canonical_path.0;
        let path_digest = digest_fields(&repository_path, PATH_DOMAIN, &[&canonical_path])?;
        let oid_width = path_digest.len();
        if !matches!(oid_width, 40 | 64) {
            return Err(GitCheckoutUseError::new(
                "checkout_use_git_failed",
                "Git returned an unsupported object-id width",
            ));
        }
        Ok(Self {
            repository: repository_path,
            git_common_dir,
            canonical_path,
            reference: format!("{REF_PREFIX}{path_digest}"),
            path_digest,
            oid_width,
        })
    }

    pub(super) fn for_validated_instance(
        repository: &TrustedLocator,
        instance: &ValidatedGitCheckoutInstance,
    ) -> Result<(Self, String), GitCheckoutUseError> {
        let instance = instance.as_instance();
        let authority = Self::from_trusted(
            repository,
            TrustedLocator::from_validated(instance.canonical_path.clone()),
        )?;
        let common = path_string(&authority.git_common_dir, "Git common directory")
            .map_err(|cause| instance_error(cause, InstanceErrorContext::Git))?;
        if common != instance.git_common_dir {
            return Err(instance_conflict());
        }
        let instance_digest = digest_fields(
            &authority.repository,
            INSTANCE_DOMAIN,
            &[
                &instance.schema_version.to_string(),
                &instance.canonical_path,
                &instance.git_common_dir,
                &instance.git_dir,
                &instance.instance_token,
            ],
        )?;
        Ok((authority, instance_digest))
    }

    #[cfg(test)]
    pub(super) fn for_instance(
        repository: &Path,
        instance: &GitCheckoutInstanceV1,
    ) -> Result<(Self, String), GitCheckoutUseError> {
        let repository = TrustedLocator::parse_path(repository, "repository path")?;
        let instance = ValidatedGitCheckoutInstance::parse(instance)
            .map_err(|cause| instance_error(cause, InstanceErrorContext::Request))?;
        Self::for_validated_instance(&repository, &instance)
    }

    pub(super) fn valid_oid(&self, value: &str) -> bool {
        value.len() == self.oid_width
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    }
}

pub(super) fn read_state(
    authority: &Authority,
) -> Result<Option<LoadedState>, GitCheckoutUseError> {
    let format = "%(refname)%00%(objectname)%00%(objecttype)%00%(symref)%00";
    let output = successful_output(
        &authority.repository,
        &[
            "for-each-ref",
            "--count=2",
            &format!("--format={format}"),
            &authority.reference,
        ],
        None,
    )?;
    if output.is_empty() {
        return Ok(None);
    }
    let output = output.strip_suffix(b"\n").unwrap_or(&output);
    let fields = output.split(|byte| *byte == 0).collect::<Vec<_>>();
    if fields.len() != 5
        || !fields[4].is_empty()
        || fields[0] != authority.reference.as_bytes()
        || fields[2] != b"blob"
        || !fields[3].is_empty()
    {
        return Err(state_error(
            "checkout-use ref is duplicated, symbolic, or not a direct blob ref",
        ));
    }
    let oid = std::str::from_utf8(fields[1])
        .map_err(|_| state_error("checkout-use ref has a non-ASCII object id"))?
        .to_string();
    if !authority.valid_oid(&oid) {
        return Err(state_error(
            "checkout-use ref has the wrong Git object-id width",
        ));
    }
    let size = one_git_line(
        successful_output(&authority.repository, &["cat-file", "-s", &oid], None)?,
        "git cat-file returned an invalid checkout-use blob size",
    )?;
    let parsed_size = size
        .parse::<usize>()
        .ok()
        .filter(|parsed| parsed.to_string() == size)
        .ok_or_else(|| state_error("checkout-use blob size is not canonical decimal"))?;
    if parsed_size == 0 || parsed_size > MAX_RECORD_BYTES {
        return Err(GitCheckoutUseError::new(
            "checkout_use_record_too_large",
            "checkout-use blob is empty or exceeds the bounded record size",
        ));
    }
    let bytes = successful_output(&authority.repository, &["cat-file", "blob", &oid], None)?;
    if bytes.len() != parsed_size {
        return Err(state_error(
            "checkout-use blob length disagrees with its immutable Git object size",
        ));
    }
    let state = decode_state(authority, &bytes)?;
    Ok(Some(LoadedState { oid, state }))
}

pub(super) fn compare_and_swap(
    authority: &Authority,
    expected_oid: Option<&str>,
    state: &State,
) -> Result<bool, GitCheckoutUseError> {
    compare_and_swap_using(authority, expected_oid, state, |args| {
        authority_git(&authority.repository, args, None)
    })
}

pub(super) fn compare_and_swap_using(
    authority: &Authority,
    expected_oid: Option<&str>,
    state: &State,
    commit: impl FnOnce(&[&str]) -> Result<Output, GitCheckoutUseError>,
) -> Result<bool, GitCheckoutUseError> {
    debug_assert_eq!(validate_state(authority, state), Ok(()));
    let bytes = encode_state(state)?;
    let new_oid = hash_bytes(&authority.repository, &bytes, true)?;
    if !authority.valid_oid(&new_oid) {
        return Err(GitCheckoutUseError::new(
            "checkout_use_git_failed",
            "Git wrote a checkout-use state with the wrong object-id width",
        ));
    }
    let zero = "0".repeat(authority.oid_width);
    let expected = expected_oid.unwrap_or(&zero);
    let output = commit(&[
        "update-ref",
        "--no-deref",
        &authority.reference,
        &new_oid,
        expected,
    ])?;
    if output.status.success() {
        return Ok(true);
    }
    let current = read_state(authority)?;
    if current.as_ref().map(|loaded| loaded.oid.as_str()) != expected_oid {
        return Ok(false);
    }
    Err(GitCheckoutUseError::new(
        "checkout_use_git_failed",
        format!(
            "Git refused checkout-use CAS: {}",
            String::from_utf8_lossy(&output.stderr).trim_end_matches(['\r', '\n'])
        ),
    ))
}
