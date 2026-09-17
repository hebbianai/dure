use crate::remote_path::RemotePosixPath;

pub(crate) const HOST_LOCATION_PROBE: &str = r#"set -eu
hmux_location_home=$(CDPATH= cd -- "$HOME" && pwd -P)
printf 'home=%s\n' "$hmux_location_home"
hmux_location_runtime=$(readlink -f "$hmux_location_home/.local/bin/hmux-runtime" 2>/dev/null) || hmux_location_runtime=
if [ -n "$hmux_location_runtime" ] && [ -f "$hmux_location_runtime" ] && [ -x "$hmux_location_runtime" ]; then
  printf 'runtime=%s\n' "$hmux_location_runtime"
else
  hmux_location_runtime=
fi"#;

/// Location observation never installs, activates or executes a runtime.
/// A new host still has a usable home when no native session can be launched.
pub(crate) fn observed_host_location(
    session: &ssh2::Session,
) -> Result<(RemotePosixPath, Option<RemotePosixPath>), String> {
    let result = crate::ssh::exec_on(session, HOST_LOCATION_PROBE)?;
    if result.code != 0 {
        return Err(format!(
            "remote_hmux_home_unavailable: {}",
            result.stderr.trim()
        ));
    }
    let home = result
        .stdout
        .lines()
        .find_map(remote_home_of)
        .ok_or_else(|| {
            "remote_hmux_home_unavailable: canonical home was not observed".to_string()
        })?;
    let runtime = result.stdout.lines().find_map(remote_runtime_of);
    Ok((home, runtime))
}

pub(crate) fn remote_home_of(line: &str) -> Option<RemotePosixPath> {
    remote_absolute_path_of(line, "home=")
}

pub(crate) fn remote_runtime_of(line: &str) -> Option<RemotePosixPath> {
    remote_absolute_path_of(line, "runtime=")
}

fn remote_absolute_path_of(line: &str, prefix: &str) -> Option<RemotePosixPath> {
    RemotePosixPath::from_absolute(line.strip_prefix(prefix)?).ok()
}
