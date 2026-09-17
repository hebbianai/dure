#[cfg(feature = "local-runtime")]
use crate::ClientError;
#[cfg(feature = "local-runtime")]
use std::ffi::OsString;
#[cfg(feature = "local-runtime")]
use std::path::{Path, PathBuf};

pub const DURE_HOME_ENV: &str = "DURE_HOME";
pub const DEFAULT_DISCOVERY_RELATIVE_PATH: &str = ".dure/state/hmux-hosts";
#[cfg(feature = "local-runtime")]
pub(crate) const DURE_HOME_DISCOVERY_RELATIVE_PATH: &str = "state/hmux-hosts";
#[cfg(feature = "local-runtime")]
const LEGACY_PORTABLE_DISCOVERY_RELATIVE_PATH: &str = "state/hebbian-agent/hmux-hosts";
#[cfg(feature = "local-runtime")]
const LEGACY_STANDARD_DISCOVERY_RELATIVE_PATH: &str = "hebbian/hebbian-agent/hmux-hosts";
#[cfg(feature = "local-runtime")]
pub(crate) const MAX_READ_ONLY_DISCOVERY_ROOTS: usize = 2;

#[cfg(feature = "local-runtime")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DiscoveryRootPlan {
    pub(crate) canonical: PathBuf,
    pub(crate) read_only: Vec<PathBuf>,
}

#[cfg(feature = "local-runtime")]
pub(crate) fn discovery_root_plan_from_environment() -> Result<DiscoveryRootPlan, ClientError> {
    use std::env;

    resolve_discovery_root_plan(
        env::var_os(crate::DISCOVERY_ROOT_ENV),
        env::var_os(DURE_HOME_ENV),
        dirs::home_dir(),
        env::var_os("HEBBIAN_HOME"),
        dirs::state_dir(),
        dirs::data_local_dir(),
        dirs::data_dir(),
    )
}

#[cfg(feature = "local-runtime")]
pub(crate) fn resolve_discovery_root_plan(
    configured: Option<OsString>,
    dure_home: Option<OsString>,
    home_dir: Option<PathBuf>,
    legacy_hebbian_home: Option<OsString>,
    legacy_state_dir: Option<PathBuf>,
    legacy_data_local_dir: Option<PathBuf>,
    legacy_data_dir: Option<PathBuf>,
) -> Result<DiscoveryRootPlan, ClientError> {
    if configured.is_some() {
        return Ok(DiscoveryRootPlan {
            canonical: crate::error::path_from_env(configured)?,
            read_only: Vec::new(),
        });
    }

    let canonical = match dure_home.filter(|value| !value.is_empty()) {
        Some(dure_home) => PathBuf::from(dure_home).join(DURE_HOME_DISCOVERY_RELATIVE_PATH),
        None => home_dir
            .ok_or(ClientError::HomeDirectoryUnavailable)?
            .join(DEFAULT_DISCOVERY_RELATIVE_PATH),
    };
    let mut read_only = Vec::with_capacity(MAX_READ_ONLY_DISCOVERY_ROOTS);
    if let Some(legacy_home) = legacy_hebbian_home.filter(|value| !value.is_empty()) {
        push_unique_legacy(
            &canonical,
            &mut read_only,
            PathBuf::from(legacy_home).join(LEGACY_PORTABLE_DISCOVERY_RELATIVE_PATH),
        )?;
    }
    if let Some(legacy_root) = legacy_state_dir
        .or(legacy_data_local_dir)
        .or(legacy_data_dir)
    {
        push_unique_legacy(
            &canonical,
            &mut read_only,
            legacy_root.join(LEGACY_STANDARD_DISCOVERY_RELATIVE_PATH),
        )?;
    }
    Ok(DiscoveryRootPlan {
        canonical,
        read_only,
    })
}

#[cfg(feature = "local-runtime")]
pub(crate) fn validate_read_only_discovery_roots(
    canonical: &Path,
    roots: Vec<PathBuf>,
) -> Result<Vec<PathBuf>, ClientError> {
    let mut bounded = Vec::with_capacity(roots.len().min(MAX_READ_ONLY_DISCOVERY_ROOTS));
    for root in roots {
        push_unique_legacy(canonical, &mut bounded, root)?;
    }
    Ok(bounded)
}

#[cfg(feature = "local-runtime")]
fn push_unique_legacy(
    canonical: &Path,
    roots: &mut Vec<PathBuf>,
    candidate: PathBuf,
) -> Result<(), ClientError> {
    if candidate == canonical || roots.contains(&candidate) {
        return Ok(());
    }
    if roots.len() >= MAX_READ_ONLY_DISCOVERY_ROOTS {
        return Err(ClientError::TooManyDiscoveryRoots {
            maximum: MAX_READ_ONLY_DISCOVERY_ROOTS,
        });
    }
    roots.push(candidate);
    Ok(())
}

#[cfg(all(test, feature = "local-runtime"))]
mod tests {
    use super::*;

    #[test]
    fn explicit_hmux_root_disables_environment_migration() {
        let plan = resolve_discovery_root_plan(
            Some(OsString::from("/fixture/exact")),
            Some(OsString::from("/dure")),
            Some(PathBuf::from("/home/tester")),
            Some(OsString::from("/hebbian")),
            Some(PathBuf::from("/state")),
            Some(PathBuf::from("/local-data")),
            Some(PathBuf::from("/data")),
        )
        .unwrap();

        assert_eq!(plan.canonical, PathBuf::from("/fixture/exact"));
        assert!(plan.read_only.is_empty());
    }

    #[test]
    fn empty_explicit_hmux_root_is_refused() {
        let error = resolve_discovery_root_plan(
            Some(OsString::new()),
            Some(OsString::from("/dure")),
            Some(PathBuf::from("/home/tester")),
            None,
            None,
            None,
            None,
        )
        .unwrap_err();

        assert!(matches!(error, ClientError::InvalidDiscoveryRoot));
    }

    #[test]
    fn dure_home_is_the_only_portable_canonical_root() {
        let plan = resolve_discovery_root_plan(
            None,
            Some(OsString::from("/dure")),
            Some(PathBuf::from("/home/tester")),
            Some(OsString::from("/hebbian")),
            Some(PathBuf::from("/state")),
            None,
            None,
        )
        .unwrap();

        assert_eq!(plan.canonical, PathBuf::from("/dure/state/hmux-hosts"));
        assert_eq!(
            plan.read_only,
            vec![
                PathBuf::from("/hebbian/state/hebbian-agent/hmux-hosts"),
                PathBuf::from("/state/hebbian/hebbian-agent/hmux-hosts"),
            ]
        );
    }

    #[test]
    fn home_fallback_uses_dot_dure_instead_of_xdg_state() {
        let plan = resolve_discovery_root_plan(
            None,
            None,
            Some(PathBuf::from("/home/tester")),
            None,
            Some(PathBuf::from("/home/tester/.local/state")),
            None,
            None,
        )
        .unwrap();

        assert_eq!(
            plan.canonical,
            PathBuf::from("/home/tester/.dure/state/hmux-hosts")
        );
        assert_eq!(
            plan.read_only,
            vec![PathBuf::from(
                "/home/tester/.local/state/hebbian/hebbian-agent/hmux-hosts"
            )]
        );
    }

    #[test]
    fn legacy_roots_are_deduplicated_and_bounded() {
        let canonical = PathBuf::from("/dure/state/hmux-hosts");
        assert_eq!(
            validate_read_only_discovery_roots(
                &canonical,
                vec![
                    PathBuf::from("/legacy/a"),
                    PathBuf::from("/legacy/a"),
                    canonical.clone(),
                ],
            )
            .unwrap(),
            vec![PathBuf::from("/legacy/a")]
        );

        let error = validate_read_only_discovery_roots(
            &canonical,
            (0..=MAX_READ_ONLY_DISCOVERY_ROOTS)
                .map(|index| PathBuf::from(format!("/legacy/{index}")))
                .collect(),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            ClientError::TooManyDiscoveryRoots {
                maximum: MAX_READ_ONLY_DISCOVERY_ROOTS
            }
        ));
    }
}
