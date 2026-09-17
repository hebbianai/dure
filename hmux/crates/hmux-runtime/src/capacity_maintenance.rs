//! One finite capacity pass, outside the Unix create broker's response path.

use fs2::FileExt;
use hmux_host::local_discovery::{DiscoveryGcPolicy, DiscoveryRoot};
use hmux_local_platform::private_storage;
use std::fs::File;
use std::io;
use std::os::fd::AsFd;
use std::path::Path;
use std::process::{Command, Stdio};

pub(crate) const SUBCOMMAND: &str = "internal-registration-maintenance";
const LEASE: &str = ".registration-maintenance.lock";

pub(crate) fn schedule(root: &Path) {
    // Best effort never changes the already-created generation's result.
    let _ = spawn(root);
}

fn spawn(root: &Path) -> crate::Result<()> {
    let discovery = DiscoveryRoot::open(root)?;
    let lease = private_storage::open_lock_file(&root.join(LEASE))?;
    if lease.try_lock_exclusive().is_err() {
        return Ok(());
    }
    if discovery.registration_capacity()?.used < DiscoveryGcPolicy::default().max_session_entries {
        return Ok(());
    }
    // Unix flock follows the inherited open-file description. Passing the
    // lease as stdin keeps single-flight ownership continuous across broker
    // exit, without a daemon, persistent task queue or PID-based ownership.
    // Keep the caller's process group so its QA guardian still owns this child.
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg(SUBCOMMAND)
        .arg(root)
        .env("HMUX_DISCOVERY_ROOT", root)
        .stdin(Stdio::from(lease))
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("HMUX_RUNTIME_TEST_CAPACITY_STDERR") {
        command.stderr(Stdio::from(File::create(path)?));
    }
    command.spawn()?;
    Ok(())
}

pub(crate) fn run(root: &Path) -> crate::Result<()> {
    DiscoveryRoot::open(root)?;
    let path = root.join(LEASE);
    let lease = File::from(io::stdin().as_fd().try_clone_to_owned()?);
    if private_storage::open_file_identity(&path, &lease)? != private_storage::file_identity(&path)?
    {
        return Err("capacity maintenance lease identity changed".into());
    }
    lease.try_lock_exclusive()?;
    let _ = crate::managed_abandonment::maintain_completed_create_lifecycles(root);
    hmux_client::maintain_registration_capacity(root)?;
    Ok(())
}
