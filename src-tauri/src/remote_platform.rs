#[derive(Debug, Eq, PartialEq)]
pub(crate) enum RemotePlatformError {
    Probe(String),
    Unsupported { system: String, machine: String },
}

pub(crate) fn select_linux_triple(
    system: &str,
    machine: &str,
) -> Result<&'static str, RemotePlatformError> {
    match (system, machine) {
        ("Linux", "x86_64" | "amd64") => Ok("x86_64-unknown-linux-musl"),
        ("Linux", "aarch64" | "arm64") => Ok("aarch64-unknown-linux-musl"),
        _ => Err(RemotePlatformError::Unsupported {
            system: system.to_string(),
            machine: machine.to_string(),
        }),
    }
}

#[cfg(not(windows))]
pub(crate) fn detect_linux_triple(
    opts: &crate::ssh::SshOptions,
) -> Result<&'static str, RemotePlatformError> {
    let session = crate::ssh::acquire(opts).map_err(RemotePlatformError::Probe)?;
    detect_linux_triple_on(&session)
}

pub(crate) fn detect_linux_triple_on(
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
    select_linux_triple(system.unwrap_or_default(), machine.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_only_bundled_linux_targets() {
        assert_eq!(
            select_linux_triple("Linux", "x86_64").unwrap(),
            "x86_64-unknown-linux-musl"
        );
        assert_eq!(
            select_linux_triple("Linux", "arm64").unwrap(),
            "aarch64-unknown-linux-musl"
        );
        assert!(select_linux_triple("Darwin", "arm64").is_err());
    }
}
