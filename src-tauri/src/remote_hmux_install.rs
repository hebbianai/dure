use crate::remote_path::RemotePosixPath;
use crate::ssh::host_location::{remote_home_of, remote_runtime_of, HOST_LOCATION_PROBE};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::Manager;

const MAX_INSTALLER_BYTES: u64 = 256 * 1024;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024;
const MAX_BINARY_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Eq, PartialEq)]
enum InstallPlan {
    Current,
    Activate,
    Install,
}

/// 한 상자에 무슨 일이 있었나.
///
/// 셋을 하나로 접으면 "이미 최신이라 아무것도 안 했다" 가 실패와 구별되지
/// 않는다 — 화면은 잘 되어 있는 상자를 빨갛게 그리게 된다.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProvisionOutcome {
    /// 이미 이 빌드를 돌리고 있었다.
    ///
    /// 빠른 경로로 왔다면 왕복 한 번만 썼다. 느린 경로로 왔다면 설치
    /// 스크립트는 올라갔지만 hmux 바이너리는 하나도 안 올렸다 — 그 둘을
    /// 갈라 말하지 않는 이유는, 화면이 물어보는 것이 "이 상자가 최신인가"
    /// 하나이기 때문이다.
    AlreadyCurrent,
    /// 바이트는 이미 있었고 `current` 만 옮겼다.
    Activated,
    /// 올려서 설치했다.
    Installed,
}

/// 무슨 일이 있었는지와, 무엇으로 맞췄는지.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Provisioned {
    pub(crate) outcome: ProvisionOutcome,
    pub(crate) build_id: String,
    pub(crate) target_triple: String,
    #[serde(skip_serializing)]
    runtime: RemoteHmuxRuntimeLocation,
}

impl Provisioned {
    pub(crate) fn runtime(&self) -> &RemoteHmuxRuntimeLocation {
        &self.runtime
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RemoteHmuxRuntimeLocation {
    home: RemotePosixPath,
    executable: RemotePosixPath,
}

impl RemoteHmuxRuntimeLocation {
    fn versioned(home: RemotePosixPath, build_id: &str) -> Result<Self, String> {
        let executable = home
            .join_relative(&format!(".local/share/hmux/versions/{build_id}/bin/hmux-runtime"))
            .map_err(|error| format!("remote_hmux_provision_runtime_invalid: {error}"))?;
        Ok(Self { home, executable })
    }

    fn observed(home: RemotePosixPath, executable: RemotePosixPath) -> Self {
        Self { home, executable }
    }

    pub(crate) fn home(&self) -> &RemotePosixPath {
        &self.home
    }

    pub(crate) fn executable(&self) -> &RemotePosixPath {
        &self.executable
    }

    #[cfg(test)]
    pub(crate) fn fixture(home: &str, executable: &str) -> Self {
        Self {
            home: RemotePosixPath::from_absolute(home)
                .expect("remote home path fixture must be absolute"),
            executable: RemotePosixPath::from_absolute(executable)
                .expect("remote executable path fixture must be absolute"),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallManifest {
    schema_version: u16,
    build_id: String,
    package_version: String,
    profile: String,
    target_triple: String,
    protocol: InstallProtocol,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallProtocol {
    minimum: String,
    maximum: String,
}

struct BundledHmux {
    build_id: String,
    cli: Vec<u8>,
    digest: String,
    installer: Vec<u8>,
    manifest: Vec<u8>,
    runtime: Vec<u8>,
}

fn sha256_hex(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn tree_digest(manifest: &[u8], cli: &[u8], runtime: &[u8]) -> String {
    sha256_hex(
        format!(
            "{}  install.json\n{}  bin/hmux\n{}  bin/hmux-runtime\n",
            sha256_hex(manifest),
            sha256_hex(cli),
            sha256_hex(runtime)
        )
        .as_bytes(),
    )
}

fn plan_install(
    build_id: &str,
    expected_digest: &str,
    current: Option<&str>,
    installed_digest: Option<&str>,
) -> Result<InstallPlan, String> {
    let Some(installed_digest) = installed_digest else {
        return Ok(InstallPlan::Install);
    };
    if installed_digest != expected_digest {
        return Err(format!(
            "remote_hmux_provision_build_id_conflict: {build_id} is installed with different bytes"
        ));
    }
    if current == Some(&format!("versions/{build_id}")) {
        Ok(InstallPlan::Current)
    } else {
        Ok(InstallPlan::Activate)
    }
}

fn read_bounded(path: &Path, max_bytes: u64, label: &str) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("remote_hmux_provision_bundle_unavailable: {label}: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > max_bytes
    {
        return Err(format!(
            "remote_hmux_provision_bundle_invalid: {label} is not a bounded regular file"
        ));
    }
    std::fs::read(path)
        .map_err(|error| format!("remote_hmux_provision_bundle_unavailable: {label}: {error}"))
}

fn safe_build_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'+' | b'-'))
        })
}

/// The small part of the bundle: enough to know which build this app carries.
/// The unattended currency sweep asks this of every paired box; reading and
/// hashing two binaries per box for an answer that is almost always "already
/// current" is what [`BundledManifest::binaries`] defers.
struct BundledManifest {
    build_id: String,
    installer: Vec<u8>,
    manifest: Vec<u8>,
    root: std::path::PathBuf,
}

fn load_manifest<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    triple: &str,
) -> Result<BundledManifest, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("remote_hmux_provision_bundle_unavailable: {error}"))?;
    let root = resource_dir.join("resources/hmux-remote").join(triple);
    let installer = read_bounded(
        &resource_dir.join("resources/install-hmux.sh"),
        MAX_INSTALLER_BYTES,
        "installer",
    )?;
    let manifest = read_bounded(&root.join("install.json"), MAX_MANIFEST_BYTES, "manifest")?;
    let parsed: InstallManifest = serde_json::from_slice(&manifest)
        .map_err(|error| format!("remote_hmux_provision_bundle_invalid: manifest: {error}"))?;
    if parsed.schema_version != 1
        || !safe_build_id(&parsed.build_id)
        || parsed.package_version.is_empty()
        || parsed.profile != "release"
        || parsed.target_triple != triple
        || parsed.protocol.minimum != "1.0"
        || parsed.protocol.maximum != "1.0"
    {
        return Err("remote_hmux_provision_bundle_invalid: manifest contract mismatch".to_string());
    }
    Ok(BundledManifest {
        build_id: parsed.build_id,
        installer,
        manifest,
        root,
    })
}

impl BundledManifest {
    fn binaries(self) -> Result<BundledHmux, String> {
        let cli = read_bounded(&self.root.join("bin/hmux"), MAX_BINARY_BYTES, "hmux")?;
        let runtime = read_bounded(
            &self.root.join("bin/hmux-runtime"),
            MAX_BINARY_BYTES,
            "hmux-runtime",
        )?;
        Ok(BundledHmux {
            build_id: self.build_id,
            digest: tree_digest(&self.manifest, &cli, &runtime),
            installer: self.installer,
            manifest: self.manifest,
            cli,
            runtime,
        })
    }
}

fn exec_checked(
    opts: &crate::ssh::SshOptions,
    command: &str,
    code: &str,
) -> Result<crate::ssh::ExecResult, String> {
    let result =
        crate::ssh::exec_once(opts, command).map_err(|error| format!("{code}: {error}"))?;
    if result.code == 0 {
        return Ok(result);
    }
    let detail = result.stderr.trim();
    Err(if detail.is_empty() {
        format!("{code}: remote command exited {}", result.code)
    } else {
        format!("{code}: {detail}")
    })
}

fn platform(opts: &crate::ssh::SshOptions) -> Result<&'static str, String> {
    match crate::remote_platform::detect_linux_triple(opts) {
        Ok(triple) => Ok(triple),
        Err(crate::remote_platform::RemotePlatformError::Probe(detail)) => {
            Err(format!("remote_hmux_provision_platform_failed: {detail}"))
        }
        Err(crate::remote_platform::RemotePlatformError::Unsupported { system, machine }) => Err(
            format!(
                "remote_hmux_provision_unsupported_platform: no bundled Hmux for {system} {machine}"
            ),
        ),
    }
}

struct PreparedStaging {
    path: String,
    home: RemotePosixPath,
}

fn prepare_staging(opts: &crate::ssh::SshOptions) -> Result<PreparedStaging, String> {
    let result = exec_checked(
        opts,
        "set -eu; umask 077; home=$(CDPATH= cd -- \"$HOME\" && pwd -P); hmux_staging=$(mktemp -d /tmp/dure-hmux-provision.XXXXXX); chmod 700 \"$hmux_staging\"; mkdir -m 700 \"$hmux_staging/tree\" \"$hmux_staging/tree/bin\"; printf 'home=%s\\nstaging=%s\\n' \"$home\" \"$hmux_staging\"",
        "remote_hmux_provision_stage_failed",
    )?;
    let staging = result
        .stdout
        .lines()
        .find_map(|line| line.strip_prefix("staging="))
        .unwrap_or_default();
    let suffix = staging
        .strip_prefix("/tmp/dure-hmux-provision.")
        .unwrap_or_default();
    if suffix.len() != 6 || !suffix.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err(
            "remote_hmux_provision_stage_failed: remote staging path is invalid".to_string(),
        );
    }
    let home = result
        .stdout
        .split('\n')
        .find_map(remote_home_of)
        .ok_or_else(|| {
            "remote_hmux_provision_stage_failed: remote home is unavailable".to_string()
        })?;
    Ok(PreparedStaging {
        path: staging.to_string(),
        home,
    })
}

fn upload(opts: &crate::ssh::SshOptions, path: String, bytes: &[u8]) -> Result<(), String> {
    crate::ssh::upload_once(opts, &path, bytes.to_vec())
        .map(|_| ())
        .map_err(|error| format!("remote_hmux_provision_upload_failed: {error}"))
}

fn current_and_installed_digest(
    opts: &crate::ssh::SshOptions,
    staging: &str,
    bundle: &BundledHmux,
) -> Result<(Option<String>, Option<String>), String> {
    let build = crate::ssh::shell_quote(&bundle.build_id);
    let probe = exec_checked(
        opts,
        &format!(
            "set -eu; hmux_root=\"$HOME/.local/share/hmux\"; if [ -L \"$hmux_root/current\" ]; then printf 'current=%s\\n' \"$(readlink \"$hmux_root/current\")\"; fi; if [ -e \"$hmux_root/versions\"/{build} ] || [ -L \"$hmux_root/versions\"/{build} ]; then printf 'installed=1\\n'; fi"
        ),
        "remote_hmux_provision_probe_failed",
    )?;
    let current = probe
        .stdout
        .lines()
        .find_map(|line| line.strip_prefix("current="))
        .map(str::to_string);
    if !probe.stdout.lines().any(|line| line == "installed=1") {
        return Ok((current, None));
    }
    let digest = exec_checked(
        opts,
        &format!(
            "HMUX_PREBUILT_DIR=\"$HOME/.local/share/hmux/versions\"/{build} sh {} --print-prebuilt-digest",
            crate::ssh::shell_quote(&format!("{staging}/install-hmux.sh"))
        ),
        "remote_hmux_provision_installed_build_unreadable",
    )?
    .stdout
    .trim()
    .to_string();
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("remote_hmux_provision_installed_build_unreadable: invalid digest".to_string());
    }
    Ok((current, Some(digest)))
}

fn ensure_inner(
    opts: &crate::ssh::SshOptions,
    staging: &str,
    bundle: BundledHmux,
) -> Result<ProvisionOutcome, String> {
    let installer_path = format!("{staging}/install-hmux.sh");
    upload(opts, installer_path.clone(), &bundle.installer)?;
    exec_checked(
        opts,
        &format!("chmod 700 {}", crate::ssh::shell_quote(&installer_path)),
        "remote_hmux_provision_stage_failed",
    )?;
    let (current, installed_digest) = current_and_installed_digest(opts, staging, &bundle)?;
    let plan = plan_install(
        &bundle.build_id,
        &bundle.digest,
        current.as_deref(),
        installed_digest.as_deref(),
    )?;
    let outcome = match plan {
        InstallPlan::Current | InstallPlan::Activate => {
            exec_checked(
                opts,
                &format!(
                    "HMUX_EXPECTED_DIGEST={} HMUX_PREBUILT_DIR=\"$HOME/.local/share/hmux/versions\"/{} HMUX_INSTALL_LOCK_WAIT_SECONDS=15 sh {}",
                    crate::ssh::shell_quote(&bundle.digest),
                    crate::ssh::shell_quote(&bundle.build_id),
                    crate::ssh::shell_quote(&installer_path)
                ),
                "remote_hmux_provision_install_refused",
            )?;
            if plan == InstallPlan::Current {
                ProvisionOutcome::AlreadyCurrent
            } else {
                ProvisionOutcome::Activated
            }
        }
        InstallPlan::Install => {
            let tree = format!("{staging}/tree");
            upload(opts, format!("{tree}/install.json"), &bundle.manifest)?;
            upload(opts, format!("{tree}/bin/hmux"), &bundle.cli)?;
            upload(opts, format!("{tree}/bin/hmux-runtime"), &bundle.runtime)?;
            exec_checked(
                opts,
                &format!(
                    "chmod 644 {manifest}; chmod 755 {cli} {runtime}; HMUX_EXPECTED_DIGEST={digest} HMUX_PREBUILT_DIR={tree} HMUX_INSTALL_LOCK_WAIT_SECONDS=15 sh {installer}",
                    manifest = crate::ssh::shell_quote(&format!("{tree}/install.json")),
                    cli = crate::ssh::shell_quote(&format!("{tree}/bin/hmux")),
                    runtime = crate::ssh::shell_quote(&format!("{tree}/bin/hmux-runtime")),
                    digest = crate::ssh::shell_quote(&bundle.digest),
                    tree = crate::ssh::shell_quote(&tree),
                    installer = crate::ssh::shell_quote(&installer_path),
                ),
                "remote_hmux_provision_install_refused",
            )?;
            ProvisionOutcome::Installed
        }
    };
    // 갈래 **뒤에** 둔다. 아무것도 안 한 상자도 이 증명을 통과해야 한다 —
    // 그래야 "이미 최신" 이 심볼릭 링크가 가리키는 곳이 아니라 실제로 돈 명령이
    // 된다.
    exec_checked(
        opts,
        "\"$HOME/.local/bin/hmux\" --version >/dev/null && \"$HOME/.local/bin/hmux-runtime\" --no-autostart hmux-build-info >/dev/null",
        "remote_hmux_provision_command_unavailable",
    )?;
    Ok(outcome)
}

/// Installation currency needs the executed build ID, not merely its path.
/// Keep this optional fast path in one SSH command; uncertain observations
/// still defer to the existing full installer without becoming authority.
fn currency_probe(opts: &crate::ssh::SshOptions) -> CurrencyProbe {
    let command = format!(
        r#"{HOST_LOCATION_PROBE}
if [ -L "$hmux_location_home/.local/bin/hmux" ]; then printf 'versioned=1\n'
elif [ -e "$hmux_location_home/.local/bin/hmux" ]; then printf 'versioned=0\n'; fi
if [ -n "$hmux_location_runtime" ]; then "$hmux_location_runtime" --no-autostart hmux-build-info 2>/dev/null || true; fi"#
    );
    let Ok(result) = crate::ssh::exec_once(opts, &command) else {
        return CurrencyProbe::default();
    };
    if result.code != 0 {
        return CurrencyProbe::default();
    }
    let mut probe = CurrencyProbe::default();
    for line in result.stdout.split('\n') {
        match line.trim() {
            "versioned=1" => probe.versioned_command = Some(true),
            "versioned=0" => probe.versioned_command = Some(false),
            _ => {}
        }
        if let Some(build) = build_id_of(line) {
            probe.executing_build = Some(build);
        }
        if let Some(home) = remote_home_of(line) {
            probe.home = Some(home);
        }
        if let Some(runtime) = remote_runtime_of(line) {
            probe.runtime = Some(runtime);
        }
    }
    probe
}

#[derive(Debug, Default, Eq, PartialEq)]
struct CurrencyProbe {
    /// The build id the box's runtime reports executing. `None` when it could
    /// not be read at all.
    executing_build: Option<String>,
    /// Whether `~/.local/bin/hmux` is a symlink into the versioned store.
    /// `Some(false)` means somebody put their own binary there by hand, and
    /// installing would displace it. `None` when there is nothing there.
    versioned_command: Option<bool>,
    /// Canonical execution-side home used for content-addressed provider
    /// integrations without another SSH round trip.
    home: Option<RemotePosixPath>,
    /// Canonical path of the runtime that emitted `executing_build`.
    runtime: Option<RemotePosixPath>,
}

/// The `buildId` out of one `hmux-build-info` line.
///
/// Parsed by hand rather than with serde: the line is one flat object this
/// repository emits itself, and a probe that must never fail should not gain a
/// way to fail on an unexpected sibling field.
fn build_id_of(line: &str) -> Option<String> {
    let rest = line.split_once("\"buildId\":\"")?.1;
    let (build, _) = rest.split_once('"')?;
    (!build.is_empty()).then(|| build.to_string())
}

pub(crate) fn ensure<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    opts: &crate::ssh::SshOptions,
) -> Result<Provisioned, String> {
    let triple = platform(opts)?;
    let bundle = load_manifest(app, triple)?;
    let build_id = bundle.build_id.clone();

    let probe = currency_probe(opts);
    // Somebody's own binary sits where the versioned command goes. The
    // installer would move it aside (`preserve_pre_versioned_command`) and take
    // the name; that is a reasonable thing to do when a person asked, and not
    // a reasonable thing to do on a timer.
    if probe.versioned_command == Some(false) {
        return Err(
            "remote_hmux_provision_install_refused: this box has a hand-installed hmux at              ~/.local/bin/hmux; installing would displace it"
                .to_string(),
        );
    }
    // Already running exactly this build. Answering here is the difference
    // between one round trip and eight-plus-an-upload, which is what lets this
    // run without a person watching.
    if probe.versioned_command == Some(true)
        && probe.executing_build.as_deref() == Some(build_id.as_str())
    {
        if let (Some(home), Some(runtime)) = (probe.home, probe.runtime) {
            return Ok(Provisioned {
                outcome: ProvisionOutcome::AlreadyCurrent,
                runtime: RemoteHmuxRuntimeLocation::observed(home, runtime),
                build_id,
                target_triple: triple.to_string(),
            });
        }
    }

    let bundle = bundle.binaries()?;
    let staging = prepare_staging(opts)?;
    let result = RemoteHmuxRuntimeLocation::versioned(staging.home, &build_id)
        .and_then(|runtime| {
            ensure_inner(opts, &staging.path, bundle).map(|outcome| Provisioned {
                outcome,
                runtime,
                build_id,
                target_triple: triple.to_string(),
            })
        });
    let _ = crate::ssh::exec_once(
        opts,
        &format!("rm -rf -- {}", crate::ssh::shell_quote(&staging.path)),
    );
    result
}

// Creation cannot depend on the delayed fleet sweep. Probe the actual command
// before consulting bundled targets, so an existing runtime on another platform
// or installed by its owner remains usable without an automatic replacement.
const AVAILABILITY_PROBE: &str = r#"
if [ ! -e "$HOME/.local/bin/hmux" ] && [ ! -L "$HOME/.local/bin/hmux" ]; then
  printf 'missing\n'
elif [ -x "$HOME/.local/bin/hmux" ]; then
  "$HOME/.local/bin/hmux" --version >/dev/null && printf 'ready\n'
else
  printf 'remote Hmux command exists but is not executable\n' >&2
  exit 1
fi
"#;

pub(crate) fn ensure_available<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    opts: &crate::ssh::SshOptions,
) -> Result<(), String> {
    prepare_available_command(crate::ssh::exec_once(opts, AVAILABILITY_PROBE), || {
        ensure(app, opts).map(|_| ())
    })
}

fn prepare_available_command(
    probe: Result<crate::ssh::ExecResult, String>,
    install: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let probe = probe?;
    if probe.code != 0 {
        return Err(format!(
            "remote_hmux_provision_command_unavailable: {}",
            probe.stderr.trim()
        ));
    }
    match probe.stdout.trim() {
        "ready" => Ok(()),
        "missing" => install(),
        _ => Err("remote_hmux_provision_probe_failed: invalid command availability receipt".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn availability_probe(home: &Path) -> Result<crate::ssh::ExecResult, String> {
        let output = std::process::Command::new("sh")
            .args(["-c", AVAILABILITY_PROBE])
            .env("HOME", home)
            .output()
            .map_err(|error| error.to_string())?;
        Ok(crate::ssh::ExecResult {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8(output.stdout).unwrap(),
            stderr: String::from_utf8(output.stderr).unwrap(),
        })
    }

    #[cfg(unix)]
    fn install_test_command(home: &Path, contents: &str) {
        use std::os::unix::fs::PermissionsExt;
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let command = bin.join("hmux");
        std::fs::write(&command, contents).unwrap();
        std::fs::set_permissions(command, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn absent_command_is_installed_before_creation_can_continue() {
        let home = tempfile::tempdir().unwrap();
        assert!(!home.path().join(".local").exists());
        prepare_available_command(availability_probe(home.path()), || {
            install_test_command(home.path(), "#!/bin/sh\nexit 0\n");
            Ok(())
        })
        .unwrap();
        assert_eq!(availability_probe(home.path()).unwrap().stdout.trim(), "ready");
    }

    #[cfg(unix)]
    #[test]
    fn existing_command_is_used_without_loading_a_bundle_or_replacing_it() {
        let home = tempfile::tempdir().unwrap();
        install_test_command(home.path(), "#!/bin/sh\nexit 0\n");
        prepare_available_command(availability_probe(home.path()), || {
            panic!("a working runtime must not be reinstalled");
        })
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn installation_failure_prevents_creation_and_is_preserved() {
        let home = tempfile::tempdir().unwrap();
        let failure = "remote_hmux_provision_bundle_unavailable: missing target".to_string();
        assert_eq!(
            prepare_available_command(availability_probe(home.path()), || Err(failure.clone())),
            Err(failure)
        );
        assert!(!home.path().join(".local").exists());
    }

    #[cfg(unix)]
    #[test]
    fn broken_or_unreachable_commands_are_not_mistaken_for_an_uninstalled_host() {
        let home = tempfile::tempdir().unwrap();
        install_test_command(
            home.path(),
            "#!/bin/sh\nprintf 'broken runtime' >&2\nexit 127\n",
        );
        let error = prepare_available_command(availability_probe(home.path()), || {
            panic!("a failing existing command must not be overwritten");
        })
        .unwrap_err();
        assert!(error.contains("broken runtime"));
        assert_eq!(
            prepare_available_command(Err("SSH authentication failed".into()), || {
                panic!("an unreachable host must not be provisioned");
            }),
            Err("SSH authentication failed".into())
        );
    }

    /// The fast path reads one line of the box's own answer. Everything about
    /// automatic provisioning rests on this being right, so it is pinned here
    /// rather than only exercised through SSH.
    #[test]
    fn the_executing_build_is_read_out_of_one_build_info_line() {
        assert_eq!(
            build_id_of(
                r#"{"schemaVersion":1,"product":"hmux","binary":"hmux-runtime","buildId":"0.1.4+dev.abc.def"}"#
            )
            .as_deref(),
            Some("0.1.4+dev.abc.def")
        );
        // A sibling field this build has never seen must not make the probe
        // fail — it would send an already-current box down the slow path
        // forever.
        assert_eq!(
            build_id_of(r#"{"buildId":"0.1.4+x","somethingNew":true}"#).as_deref(),
            Some("0.1.4+x")
        );
        // Nothing to read is not an empty build id.
        assert_eq!(build_id_of(r#"{"buildId":""}"#), None);
        assert_eq!(build_id_of("versioned=1"), None);
        assert_eq!(build_id_of(""), None);
    }

    #[test]
    fn canonical_home_derives_the_versioned_runtime_path() {
        assert_eq!(
            remote_home_of("home=/home/developer")
                .as_ref()
                .map(RemotePosixPath::as_str),
            Some("/home/developer")
        );
        assert_eq!(remote_home_of("home=relative"), None);
        assert_eq!(
            remote_runtime_of(
                "runtime=/home/developer/.local/share/hmux/versions/build-1/bin/hmux-runtime",
            )
            .as_ref()
            .map(RemotePosixPath::as_str),
            Some("/home/developer/.local/share/hmux/versions/build-1/bin/hmux-runtime")
        );
        assert_eq!(remote_runtime_of("runtime=relative"), None);
        let provisioned = Provisioned {
            outcome: ProvisionOutcome::AlreadyCurrent,
            build_id: "build-1".into(),
            target_triple: "x86_64-unknown-linux-gnu".into(),
            runtime: RemoteHmuxRuntimeLocation::versioned(
                RemotePosixPath::from_absolute("/home/developer").unwrap(),
                "build-1",
            )
            .expect("runtime path must be valid"),
        };
        assert_eq!(
            provisioned.runtime().executable().as_str(),
            "/home/developer/.local/share/hmux/versions/build-1/bin/hmux-runtime"
        );
    }

    #[test]
    fn computes_the_installer_tree_digest() {
        assert_eq!(
            tree_digest(b"manifest\n", b"cli\n", b"runtime\n"),
            "9b56d96ed0158467d20658afc027587629a0e5aced60c40554509ca89597da1c"
        );
    }

    #[test]
    fn plans_no_upload_for_the_exact_current_build() {
        assert_eq!(
            plan_install(
                "build-1",
                "digest-1",
                Some("versions/build-1"),
                Some("digest-1")
            )
            .unwrap(),
            InstallPlan::Current
        );
        assert_eq!(
            plan_install("build-1", "digest-1", None, None).unwrap(),
            InstallPlan::Install
        );
        assert!(plan_install("build-1", "digest-1", None, Some("other")).is_err());
    }
    /// 이미 최신인 상자는 **아무것도 안 올린다**. 그 갈래가 설치와 같은 값으로
    /// 접히면 잘 되어 있는 상자가 화면에 실패처럼 뜨고, 사용자는 고칠 것이 없는
    /// 것을 고치려 든다.
    #[test]
    fn the_three_plans_stay_three_different_answers() {
        assert_ne!(ProvisionOutcome::AlreadyCurrent, ProvisionOutcome::Installed);
        assert_ne!(ProvisionOutcome::AlreadyCurrent, ProvisionOutcome::Activated);
        assert_ne!(ProvisionOutcome::Activated, ProvisionOutcome::Installed);
    }

    /// 화면이 갈래를 문자열로 받으므로, 그 세 이름이 이름이다.
    #[test]
    fn the_outcome_travels_under_the_name_the_screen_reads() {
        let names: Vec<String> = [
            ProvisionOutcome::AlreadyCurrent,
            ProvisionOutcome::Activated,
            ProvisionOutcome::Installed,
        ]
        .into_iter()
        .map(|outcome| serde_json::to_string(&outcome).expect("serialize"))
        .collect();

        assert_eq!(names, vec!["\"alreadyCurrent\"", "\"activated\"", "\"installed\""]);
    }

}
