#[derive(Debug, Eq, PartialEq)]
pub(crate) enum RemotePlatformError {
    Probe(String),
    Unsupported { system: String, machine: String },
}

/// Deliberately a table with no default: a guessed target that installs and
/// then cannot execute fails after `current` has moved, on a box nobody is
/// watching. Intel Macs stay out until something builds and tests that target.
pub(crate) fn select_remote_triple(
    system: &str,
    machine: &str,
) -> Result<&'static str, RemotePlatformError> {
    match (system, machine) {
        ("Linux", "x86_64" | "amd64") => Ok("x86_64-unknown-linux-musl"),
        ("Linux", "aarch64" | "arm64") => Ok("aarch64-unknown-linux-musl"),
        ("Darwin", "arm64") => Ok("aarch64-apple-darwin"),
        _ => Err(RemotePlatformError::Unsupported {
            system: system.to_string(),
            machine: machine.to_string(),
        }),
    }
}

#[cfg(not(windows))]
pub(crate) fn detect_remote_triple(
    opts: &crate::ssh::SshOptions,
) -> Result<&'static str, RemotePlatformError> {
    let session = crate::ssh::acquire(opts).map_err(RemotePlatformError::Probe)?;
    detect_remote_triple_on(&session)
}

pub(crate) fn detect_remote_triple_on(
    session: &ssh2::Session,
) -> Result<&'static str, RemotePlatformError> {
    let result = crate::ssh::exec_on(
        session,
        "printf 'dure_remote_platform=1\\nsystem=%s\\nmachine=%s\\n' \"$(uname -s)\" \"$(uname -m)\"",
    )
    .map_err(RemotePlatformError::Probe)?;
    if result.code != 0 {
        return Err(RemotePlatformError::Probe(format!(
            "remote command exited {}: {}",
            result.code,
            result.stderr.trim()
        )));
    }
    let mut marker = false;
    let mut system = None;
    let mut machine = None;
    for line in result.stdout.lines() {
        match line {
            "dure_remote_platform=1" => marker = true,
            _ if line.starts_with("system=") => system = line.strip_prefix("system="),
            _ if line.starts_with("machine=") => machine = line.strip_prefix("machine="),
            _ => {}
        }
    }
    if !marker {
        return Err(RemotePlatformError::Probe(
            "remote platform marker is absent".to_string(),
        ));
    }
    select_remote_triple(system.unwrap_or_default(), machine.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_only_bundled_targets() {
        for (system, machine, triple) in [
            ("Linux", "x86_64", "x86_64-unknown-linux-musl"),
            ("Linux", "amd64", "x86_64-unknown-linux-musl"),
            ("Linux", "aarch64", "aarch64-unknown-linux-musl"),
            ("Linux", "arm64", "aarch64-unknown-linux-musl"),
            ("Darwin", "arm64", "aarch64-apple-darwin"),
        ] {
            assert_eq!(select_remote_triple(system, machine).unwrap(), triple);
        }
    }

    #[test]
    fn refuses_platforms_without_a_bundled_target() {
        for (system, machine) in [
            ("Darwin", "x86_64"),
            ("FreeBSD", "amd64"),
            ("Linux", "riscv64"),
            ("", ""),
        ] {
            assert_eq!(
                select_remote_triple(system, machine),
                Err(RemotePlatformError::Unsupported {
                    system: system.to_string(),
                    machine: machine.to_string(),
                })
            );
        }
    }
}
