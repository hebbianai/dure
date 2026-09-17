use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RootIdentity {
    device: u64,
    inode: u64,
}

impl RootIdentity {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RootProbe {
    Current,
    MissingOrReplaced,
    Uncertain,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RootLifetimeDecision {
    Continue,
    Retire,
}

/// Pins the directory inode that one Host used to publish discovery.
pub(crate) struct DiscoveryRootGeneration {
    _root_handle: File,
    expected: RootIdentity,
}

impl DiscoveryRootGeneration {
    pub(crate) fn capture(path: &Path) -> io::Result<Self> {
        let root_handle = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(path)?;
        let expected = RootIdentity::from_metadata(&root_handle.metadata()?);
        let path_metadata = fs::symlink_metadata(path)?;
        if !path_metadata.is_dir() || RootIdentity::from_metadata(&path_metadata) != expected {
            return Err(io::Error::other(
                "discovery root identity changed while its lifetime fence was captured",
            ));
        }
        Ok(Self {
            _root_handle: root_handle,
            expected,
        })
    }

    pub(crate) fn is_retired(&self, path: &Path) -> bool {
        self.probe(path) == RootProbe::MissingOrReplaced
    }

    fn probe(&self, path: &Path) -> RootProbe {
        match fs::symlink_metadata(path) {
            Ok(metadata)
                if metadata.is_dir() && RootIdentity::from_metadata(&metadata) == self.expected =>
            {
                RootProbe::Current
            }
            Ok(_) => RootProbe::MissingOrReplaced,
            Err(error) if error.kind() == io::ErrorKind::NotFound => RootProbe::MissingOrReplaced,
            Err(_) => RootProbe::Uncertain,
        }
    }
}

/// Retires a Host only after its pinned root generation is continuously gone.
///
/// Any read error other than `NotFound` is uncertain evidence and resets the
/// grace period, so a transient production filesystem error cannot retire a
/// healthy Host.
pub(crate) struct DiscoveryRootLifetime {
    generation: Arc<DiscoveryRootGeneration>,
    unavailable_since: Option<Instant>,
    grace: Duration,
}

impl DiscoveryRootLifetime {
    pub(crate) fn new(generation: Arc<DiscoveryRootGeneration>, grace: Duration) -> Self {
        Self {
            generation,
            unavailable_since: None,
            grace,
        }
    }

    pub(crate) fn inspect(&mut self, path: &Path, now: Instant) -> RootLifetimeDecision {
        let probe = self.generation.probe(path);
        self.record(probe, now)
    }

    fn record(&mut self, probe: RootProbe, now: Instant) -> RootLifetimeDecision {
        match probe {
            RootProbe::Current | RootProbe::Uncertain => {
                self.unavailable_since = None;
                RootLifetimeDecision::Continue
            }
            RootProbe::MissingOrReplaced => {
                let unavailable_since = self.unavailable_since.get_or_insert(now);
                if now.saturating_duration_since(*unavailable_since) >= self.grace {
                    RootLifetimeDecision::Retire
                } else {
                    RootLifetimeDecision::Continue
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continuous_absence_retires_only_after_the_grace_period() {
        let state = tempfile::tempdir().unwrap();
        let root = state.path().join("discovery");
        fs::create_dir(&root).unwrap();
        let grace = Duration::from_secs(2);
        let start = Instant::now();
        let generation = Arc::new(DiscoveryRootGeneration::capture(&root).unwrap());
        let mut lifetime = DiscoveryRootLifetime::new(generation, grace);

        fs::remove_dir(&root).unwrap();
        assert_eq!(
            lifetime.inspect(&root, start),
            RootLifetimeDecision::Continue
        );
        assert_eq!(
            lifetime.inspect(&root, start + grace - Duration::from_millis(1)),
            RootLifetimeDecision::Continue
        );
        assert_eq!(
            lifetime.inspect(&root, start + grace),
            RootLifetimeDecision::Retire
        );
    }

    #[test]
    fn replacement_directory_does_not_adopt_the_old_host() {
        let state = tempfile::tempdir().unwrap();
        let root = state.path().join("discovery");
        fs::create_dir(&root).unwrap();
        let grace = Duration::from_secs(2);
        let start = Instant::now();
        let generation = Arc::new(DiscoveryRootGeneration::capture(&root).unwrap());
        let mut lifetime = DiscoveryRootLifetime::new(generation, grace);

        fs::remove_dir(&root).unwrap();
        fs::create_dir(&root).unwrap();
        assert_eq!(
            lifetime.inspect(&root, start),
            RootLifetimeDecision::Continue
        );
        assert_eq!(
            lifetime.inspect(&root, start + grace),
            RootLifetimeDecision::Retire
        );
    }

    #[test]
    fn uncertain_probe_resets_a_pending_retirement() {
        let state = tempfile::tempdir().unwrap();
        let root = state.path().join("discovery");
        fs::create_dir(&root).unwrap();
        let grace = Duration::from_secs(2);
        let start = Instant::now();
        let generation = Arc::new(DiscoveryRootGeneration::capture(&root).unwrap());
        let mut lifetime = DiscoveryRootLifetime::new(generation, grace);

        assert_eq!(
            lifetime.record(RootProbe::MissingOrReplaced, start),
            RootLifetimeDecision::Continue
        );
        assert_eq!(
            lifetime.record(RootProbe::Uncertain, start + grace),
            RootLifetimeDecision::Continue
        );
        assert_eq!(
            lifetime.record(RootProbe::MissingOrReplaced, start + grace * 2),
            RootLifetimeDecision::Continue
        );
        assert_eq!(
            lifetime.record(RootProbe::MissingOrReplaced, start + grace * 3),
            RootLifetimeDecision::Retire
        );
    }
}
