use crate::{managed_hook_rendering, remote_path::RemotePosixPath};
use dure_app::{AgentProviderLaunchPlanV1, ProviderIdV1, ProviderRuntimeIntegrationV1};
use sha2::{Digest, Sha256};

const REMOTE_INTEGRATION_ROOT: &str = ".local/share/dure/provider-integrations";

// Both desktop-known files and the remote-private notify wrapper use this
// exact publication transaction. No user configuration is ever overwritten.
const EXACT_FILE_PUBLICATION_SCRIPT: &str = r#"set -eu
umask 077
root=$1
exact=$2
mode=$3
if [ -L "$root" ] || { [ -e "$root" ] && [ ! -d "$root" ]; }; then exit 65; fi
mkdir -p "$root"
chmod 700 "$root"
stage=$(mktemp "$root/.upload.XXXXXX")
cleanup() { [ -n "${stage:-}" ] && rm -f -- "$stage" || true; }
trap cleanup EXIT HUP INT TERM
cat > "$stage"
chmod "$mode" "$stage"
if [ -L "$exact" ] || { [ -e "$exact" ] && [ ! -f "$exact" ]; }; then exit 65; fi
if [ ! -e "$exact" ]; then ln "$stage" "$exact" 2>/dev/null || true; fi
if [ -L "$exact" ] || [ ! -f "$exact" ] || ! cmp -s "$stage" "$exact"; then exit 65; fi
chmod "$mode" "$exact"
rm -f -- "$stage"
stage=
trap - EXIT HUP INT TERM
"#;

// Config and notify argv never cross SSH stdout. Codex owns configuration
// precedence; this config-only process publishes only a private wrapper handle.
const CODEX_NOTIFY_PUBLICATION_SCRIPT: &str = r#"import hashlib, json, os, selectors, shlex, signal, subprocess, sys, time

def query(spec):
    environment = os.environ.copy()
    for key in spec['remove']: environment.pop(key, None)
    environment.update(spec['set'])
    selector = selectors.DefaultSelector()
    process = None
    try:
        process = subprocess.Popen(spec['command'], cwd=spec['cwd'], env=environment,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            start_new_session=True)
        selector.register(process.stdout, selectors.EVENT_READ)
        pending, total, expected = b'', 0, 1
        deadline = time.monotonic() + 5
        def send(request):
            process.stdin.write(json.dumps(request, separators=(',', ':')).encode() + b'\n')
            process.stdin.flush()
        send({'method': 'initialize', 'id': 1, 'params': {'clientInfo': {'name': 'dure_notify_config', 'version': '1'}}})
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining): raise ValueError('config_timeout')
            chunk = os.read(process.stdout.fileno(), 8192)
            if not chunk: raise ValueError('config_eof')
            total += len(chunk)
            if total > 1048576: raise ValueError('config_oversized')
            pending += chunk
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                try: response = json.loads(line)
                except Exception: raise ValueError('config_invalid') from None
                if not isinstance(response, dict): raise ValueError('config_invalid')
                if type(response.get('id')) is not int or response['id'] != expected: continue
                if 'error' in response: raise ValueError('config_unsupported')
                if expected == 1:
                    if not isinstance(response.get('result'), dict): raise ValueError('config_invalid')
                    send({'method': 'initialized', 'params': {}})
                    send({'method': 'config/read', 'id': 2, 'params': {'includeLayers': False, 'cwd': spec['cwd']}})
                    expected = 2
                else:
                    config = response.get('result', {}).get('config')
                    if not isinstance(config, dict) or 'notify' not in config: raise ValueError('config_invalid')
                    notify = config['notify']
                    if notify is None or notify == []: return []
                    if not isinstance(notify, list) or not all(isinstance(v, str) and '\0' not in v for v in notify) or not notify[0]:
                        raise ValueError('config_invalid')
                    return notify
    finally:
        selector.close()
        if process is not None:
            try: process.stdin.close()
            except OSError: pass
            try:
                process.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                # The unreaped direct child still owns this fresh process group.
                # Retire descendants too, never an existing provider session.
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            process.stdout.close()

try:
    spec = json.load(sys.stdin)
    notify = query(spec)
    wrapper = None
    if notify:
        contents = spec['wrapper_template'].replace('__DURE_NOTIFY_ARGV__', ' '.join(shlex.quote(v) for v in notify), 1).encode()
        wrapper = spec['root'] + '/' + hashlib.sha256(contents).hexdigest() + '.sh'
        subprocess.run(['/bin/sh', '-c', spec['publish_script'], 'dure-publish', spec['root'], wrapper, '700'],
            input=contents, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2, check=True)
    print(json.dumps({'wrapper': wrapper}, separators=(',', ':')))
except Exception as error:
    codes = ('config_timeout', 'config_eof', 'config_oversized', 'config_invalid', 'config_unsupported')
    print(str(error) if isinstance(error, ValueError) and str(error) in codes else 'config_or_publication_failed', file=sys.stderr)
    sys.exit(1)
"#;

#[derive(Debug, Eq, PartialEq)]
struct PlannedRemoteFile {
    exact_path: RemotePosixPath,
    contents: String,
    mode: u16,
    requires_python: bool,
}

#[derive(Debug, Eq, PartialEq)]
struct ClaudePublicationPlan {
    hook: PlannedRemoteFile,
    settings: PlannedRemoteFile,
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn exact_file(
    home: &RemotePosixPath,
    category: &str,
    extension: &str,
    contents: Vec<u8>,
    mode: u16,
    requires_python: bool,
) -> Result<PlannedRemoteFile, String> {
    let contents = String::from_utf8(contents)
        .map_err(|error| format!("remote_provider_integration_invalid: {error}"))?;
    let digest = sha256_hex(contents.as_bytes());
    Ok(PlannedRemoteFile {
        exact_path: home
            .join_relative(&format!("{REMOTE_INTEGRATION_ROOT}/{category}/{digest}.{extension}"))
            .map_err(|error| format!("remote_provider_integration_invalid: {error}"))?,
        contents,
        mode,
        requires_python,
    })
}

fn claude_publication_plan(
    runtime: &crate::remote_hmux_install::RemoteHmuxRuntimeLocation,
) -> Result<ClaudePublicationPlan, String> {
    let hook = exact_file(
        runtime.home(),
        "claude/hooks",
        "py",
        managed_hook_rendering::render_managed_provider_hook_script(runtime.executable().as_str())
            .map_err(|error| format!("remote_provider_integration_invalid: {error}"))?,
        0o700,
        true,
    )?;
    let mut settings = serde_json::to_vec_pretty(&managed_hook_rendering::claude_settings(
        hook.exact_path.as_str(),
    ))
    .map_err(|error| format!("remote_provider_integration_invalid: {error}"))?;
    settings.push(b'\n');
    let settings = exact_file(runtime.home(), "claude/settings", "json", settings, 0o600, false)?;
    Ok(ClaudePublicationPlan { hook, settings })
}

fn publish_exact_file(
    file: &PlannedRemoteFile,
    exec: &mut impl FnMut(&str, Option<&str>) -> Result<crate::ssh::ExecResult, String>,
) -> Result<(), String> {
    let root = file.exact_path.parent().ok_or_else(|| {
        "remote_provider_integration_invalid: exact path has no parent".to_string()
    })?;
    let command = format!(
        "{python}\n/bin/sh -c {script} dure-publish {root} {exact} {mode:o}",
        python = if file.requires_python {
            "command -v python3 >/dev/null 2>&1 || { printf '%s\\n' 'remote_provider_integration_python_unavailable' >&2; exit 127; }"
        } else {
            ""
        },
        root = crate::ssh::shell_quote(root.as_str()),
        exact = crate::ssh::shell_quote(file.exact_path.as_str()),
        script = crate::ssh::shell_quote(EXACT_FILE_PUBLICATION_SCRIPT),
        mode = file.mode,
    );
    let result = exec(&command, Some(&file.contents))
        .map_err(|error| format!("remote_provider_integration_publish_failed: {error}"))?;
    if result.code == 0 {
        return Ok(());
    }
    let detail = result.stderr.trim();
    Err(if detail.is_empty() {
        format!(
            "remote_provider_integration_publish_failed: remote command exited {}",
            result.code
        )
    } else {
        format!("remote_provider_integration_publish_failed: {detail}")
    })
}

pub(crate) fn ensure(
    opts: &crate::ssh::SshOptions,
    provider_id: &str,
    runtime: &crate::remote_hmux_install::RemoteHmuxRuntimeLocation,
    cwd: &str,
    environment: &hmux_client::ProviderStateEnvironment,
) -> Result<Option<ProviderRuntimeIntegrationV1>, String> {
    ensure_with(
        provider_id,
        runtime,
        cwd,
        environment,
        &mut |command, stdin| crate::ssh::exec_once_with_stdin(opts, command, stdin),
    )
}

fn ensure_with(
    provider_id: &str,
    runtime: &crate::remote_hmux_install::RemoteHmuxRuntimeLocation,
    cwd: &str,
    environment: &hmux_client::ProviderStateEnvironment,
    exec: &mut impl FnMut(&str, Option<&str>) -> Result<crate::ssh::ExecResult, String>,
) -> Result<Option<ProviderRuntimeIntegrationV1>, String> {
    if provider_id == "codex" {
        return Ok(match ensure_codex(runtime, cwd, environment, exec) {
            Ok(integration) => Some(integration),
            Err(code) => {
                eprintln!(
                    "remote_provider_integration_unavailable: Codex notify bridge {code}; preserving native launch and user notify"
                );
                None
            }
        });
    }
    if provider_id != "claude" {
        return Ok(None);
    }
    let plan = claude_publication_plan(runtime)?;
    publish_exact_file(&plan.hook, exec)?;
    publish_exact_file(&plan.settings, exec)?;
    let integration = ProviderRuntimeIntegrationV1::SettingsFile {
        path: plan.settings.exact_path.to_string(),
    };
    Ok(Some(integration))
}

fn ensure_codex(
    runtime: &crate::remote_hmux_install::RemoteHmuxRuntimeLocation,
    cwd: &str,
    environment: &hmux_client::ProviderStateEnvironment,
    exec: &mut impl FnMut(&str, Option<&str>) -> Result<crate::ssh::ExecResult, String>,
) -> Result<ProviderRuntimeIntegrationV1, &'static str> {
    let cwd = RemotePosixPath::from_absolute(cwd).map_err(|_| "cwd_invalid")?;
    let root = runtime
        .home()
        .join_relative(&format!("{REMOTE_INTEGRATION_ROOT}/codex/user-notify"))
        .map_err(|_| "path_invalid")?;
    let query_command = launch_command(
        "codex",
        AgentProviderLaunchPlanV1 {
            executable: "codex".into(),
            arguments: vec!["app-server".into()],
        },
        None,
        None,
    )
    .map_err(|_| "command_invalid")?;
    let spec = serde_json::to_string(&serde_json::json!({
        "command": query_command, "cwd": cwd.as_str(), "root": root.as_str(),
        "set": environment.values(), "remove": environment.removals(),
        "wrapper_template": managed_hook_rendering::CODEX_USER_NOTIFY_WRAPPER_TEMPLATE,
        "publish_script": EXACT_FILE_PUBLICATION_SCRIPT,
    }))
    .map_err(|_| "request_invalid")?;
    let result = exec(
        &format!(
            "python3 -c {}",
            crate::ssh::shell_quote(CODEX_NOTIFY_PUBLICATION_SCRIPT)
        ),
        Some(&spec),
    )
    .map_err(|_| "transport_failed")?;
    if result.code != 0 {
        return Err(match result.stderr.trim() {
            "config_timeout" => "config_timeout",
            "config_eof" => "config_eof",
            "config_oversized" => "config_oversized",
            "config_invalid" => "config_invalid",
            "config_unsupported" => "config_unsupported",
            _ => "config_or_publication_failed",
        });
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Published {
        wrapper: serde_json::Value,
    }
    let published: Published =
        serde_json::from_str(&result.stdout).map_err(|_| "publication_invalid")?;
    let wrapper = match published.wrapper {
        serde_json::Value::Null => None,
        serde_json::Value::String(path) => Some(path),
        _ => return Err("publication_invalid"),
    }
    .map(|path| {
        let prefix = format!("{root}/");
        let digest = path
            .strip_prefix(&prefix)
            .and_then(|v| v.strip_suffix(".sh"))
            .filter(|v| {
                v.len() == 64
                    && v.bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            })
            .ok_or("publication_invalid")?;
        root.join_relative(&format!("{digest}.sh"))
            .map_err(|_| "publication_invalid")
    })
    .transpose()?;
    let hook = exact_file(
        runtime.home(),
        "codex/hooks",
        "managed-codex.py",
        managed_hook_rendering::render_managed_provider_hook_script(runtime.executable().as_str())
            .map_err(|_| "hook_invalid")?,
        0o700,
        true,
    )
    .map_err(|_| "hook_invalid")?;
    publish_exact_file(&hook, exec).map_err(|_| "hook_publication_failed")?;
    let integration = ProviderRuntimeIntegrationV1::NotificationCommand {
        command: std::iter::once(hook.exact_path.to_string())
            .chain(wrapper.map(|v| v.to_string()))
            .collect(),
    };
    integration.validate().map_err(|_| "publication_invalid")?;
    Ok(integration)
}

pub(crate) fn launch_command(
    provider_id: &str,
    mut plan: AgentProviderLaunchPlanV1,
    integration: Option<&ProviderRuntimeIntegrationV1>,
    github_directory: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut arguments = match integration {
        Some(integration) => {
            let provider_id = ProviderIdV1::new(provider_id)
                .map_err(|error| format!("remote_hmux_provider_unsupported: {error}"))?;
            let render = if provider_id.as_str() == "codex" {
                dure_provider_adapter::provider_notification_arguments
            } else {
                dure_provider_adapter::provider_runtime_integration_arguments
            };
            render(&provider_id, integration)
                .map_err(|error| {
                    format!("remote_provider_integration_invalid: {}", error.as_str())
                })?
        }
        None => Vec::new(),
    };
    arguments.append(&mut plan.arguments);
    let executable = crate::ssh::shell_quote(&plan.executable);
    let command = std::iter::once(plan.executable)
        .chain(arguments)
        .map(|argument| crate::ssh::shell_quote(&argument))
        .collect::<Vec<_>>()
        .join(" ");
    let github_path = github_directory
        .map(|directory| format!("export PATH={}:\"$PATH\"; ", crate::ssh::shell_quote(directory)))
        .unwrap_or_default();
    let launch = format!(
        "if ! command -v {executable} >/dev/null 2>&1 && [ -s \"$HOME/.nvm/nvm.sh\" ]; then NVM_DIR=\"$HOME/.nvm\"; export NVM_DIR; . \"$NVM_DIR/nvm.sh\"; nvm use --silent node >/dev/null; fi; {github_path}command -v {executable} >/dev/null 2>&1 || exit 127; exec {command}"
    );
    Ok(vec!["/bin/sh".to_string(), "-lc".to_string(), launch])
}

#[cfg(test)]
mod tests {
    use super::*;

    struct CodexFixture {
        _root: tempfile::TempDir,
        home: std::path::PathBuf,
        environment: hmux_client::ProviderStateEnvironment,
        runtime: crate::remote_hmux_install::RemoteHmuxRuntimeLocation,
    }

    impl CodexFixture {
        fn new(mode: &str) -> Self {
            use std::os::unix::fs::PermissionsExt;

            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("Dure's home");
            let bin = home.join("bin");
            let profile = home.join("selected profile");
            for directory in [&bin, &profile, &home.join(".nvm")] {
                std::fs::create_dir_all(directory).unwrap();
            }
            // The adapter must consume config/read, not guess precedence by
            // reading either selected-user or project TOML itself.
            std::fs::write(
                profile.join("config.toml"),
                "notify = ['raw-user-must-not-run']\n",
            )
            .unwrap();
            std::fs::create_dir(home.join(".codex")).unwrap();
            std::fs::write(
                home.join(".codex/config.toml"),
                "notify = ['raw-project-must-not-run']\n",
            )
            .unwrap();
            let executable = |name: &str, contents: &str| {
                let path = bin.join(name);
                std::fs::write(&path, contents).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
                path
            };
            executable(
                "codex",
                r#"#!/usr/bin/env python3
import json, os, signal, subprocess, sys, time
from pathlib import Path
root = Path(os.environ['HOME'])
if sys.argv[1:] != ['app-server']:
    print(json.dumps(sys.argv[1:]))
    sys.exit(0)
(root / 'query-pid').write_text(str(os.getpid()))
config = json.loads((Path(os.environ['CODEX_HOME']) / 'fixture.json').read_text())
mode = config['mode']
if mode == 'eof': sys.exit(0)
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if method == 'initialize':
        reply = {'result': {}}
    elif method == 'thread/goal/get':
        reply = {'result': {'goal': None}}
    elif method == 'config/read':
        if os.path.realpath(request['params']['cwd']) != os.getcwd(): sys.exit(1)
        if mode == 'timeout':
            descendant = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
            (root / 'query-child-pid').write_text(str(descendant.pid))
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            time.sleep(30)
        if mode == 'unsupported': reply = {'error': {'code': -32601, 'message': 'private-notify-secret'}}
        elif mode == 'invalid': reply = {'result': {'config': {'notify': 'private-notify-secret'}}}
        elif mode == 'missing': reply = {'result': {'config': {}}}
        elif mode == 'oversized':
            print('x' * 1048577, flush=True)
            continue
        else: reply = {'result': {'config': {'notify': config['notify']}}}
    else: continue
    print(json.dumps({'id': request['id'], **reply}), flush=True)
"#,
            );
            let user = executable(
                "user notify",
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HOME/user-notify-result\"\n",
            );
            let runtime_path = executable(
                "hmux-runtime",
                r#"#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
frame = sys.stdin.buffer.read()
(Path(os.environ['HOME']) / 'report.json').write_bytes(frame[4:])
reply = json.dumps({'state': 'completed'}).encode()
sys.stdout.buffer.write(len(reply).to_bytes(4, 'big') + reply)
"#,
            );
            std::fs::write(
                home.join(".nvm/nvm.sh"),
                format!(
                    "PATH={}:$PATH; export PATH; nvm() {{ :; }}\n",
                    crate::ssh::shell_quote(bin.to_str().unwrap())
                ),
            )
            .unwrap();
            std::fs::write(
                profile.join("fixture.json"),
                serde_json::to_vec(&serde_json::json!({
                    "mode": mode, "notify": [user, "private-notify-secret", "space and 'quote"],
                }))
                .unwrap(),
            )
            .unwrap();
            let environment =
                hmux_client::ProviderStateEnvironment::new(std::collections::BTreeMap::from([(
                    "CODEX_HOME".into(),
                    profile.to_string_lossy().into_owned(),
                )]))
                .unwrap();
            let runtime = crate::remote_hmux_install::RemoteHmuxRuntimeLocation::fixture(
                home.to_str().unwrap(),
                runtime_path.to_str().unwrap(),
            );
            Self {
                _root: root,
                home,
                environment,
                runtime,
            }
        }

        fn command(&self, executable: &str) -> std::process::Command {
            let mut command = std::process::Command::new(executable);
            command
                .env_clear()
                .current_dir(&self.home)
                .env("HOME", &self.home)
                .env(
                    "PATH",
                    format!("{}:/usr/bin:/bin", self.home.join("bin").display()),
                )
                .env("DURE_HOME", self.home.join("dure"))
                .env("HMUX_DISCOVERY_ROOT", self.home.join("discovery"));
            command
        }

        fn ensure(&self, fail_publish: bool) -> Option<ProviderRuntimeIntegrationV1> {
            let mut calls = 0;
            ensure_with(
                "codex",
                &self.runtime,
                self.home.to_str().unwrap(),
                &self.environment,
                &mut |command, stdin| {
                    use std::io::Write;
                    calls += 1;
                    if fail_publish && calls == 2 {
                        return Err("private-notify-secret".into());
                    }
                    let mut child = self
                        .command("/bin/sh")
                        .args(["-c", command])
                        .stdin(std::process::Stdio::piped())
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        .spawn()
                        .unwrap();
                    child
                        .stdin
                        .take()
                        .unwrap()
                        .write_all(stdin.unwrap_or_default().as_bytes())
                        .unwrap();
                    let output = child.wait_with_output().unwrap();
                    assert!(
                        !String::from_utf8_lossy(&output.stdout).contains("private-notify-secret")
                    );
                    assert!(
                        !String::from_utf8_lossy(&output.stderr).contains("private-notify-secret")
                    );
                    Ok(crate::ssh::ExecResult {
                        code: output.status.code().unwrap_or(-1),
                        stdout: String::from_utf8(output.stdout).unwrap(),
                        stderr: String::from_utf8(output.stderr).unwrap(),
                    })
                },
            )
            .unwrap()
        }

        fn launch(&self, integration: Option<&ProviderRuntimeIntegrationV1>) -> Vec<String> {
            let command = launch_command(
                "codex",
                AgentProviderLaunchPlanV1 {
                    executable: self.home.join("bin/codex").to_string_lossy().into_owned(),
                    arguments: vec!["resume".into(), "conversation-fixture".into()],
                },
                integration,
                None,
            )
            .unwrap();
            let output = self
                .command(&command[0])
                .args(&command[1..])
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            serde_json::from_slice(&output.stdout).unwrap()
        }
    }

    #[test]
    fn remote_codex_completion_preserves_private_notify_without_hook_trust() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = CodexFixture::new("success");
        let integration = fixture
            .ensure(false)
            .expect("remote Codex must publish its completion bridge");
        let arguments = fixture.launch(Some(&integration));
        assert_eq!(arguments.len(), 4);
        assert_eq!(&arguments[2..], ["resume", "conversation-fixture"]);
        assert!(!arguments.join(" ").contains("private-notify-secret"));
        let ProviderRuntimeIntegrationV1::NotificationCommand { command } = integration else {
            panic!("expected notify");
        };
        assert_eq!(command.len(), 2);
        for path in &command {
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        let payload = r#"{"type":"agent-turn-complete","thread-id":"conversation-fixture","turn-id":"turn-fixture-1","last-assistant-message":"done"}"#;
        let output = fixture
            .command(&command[0])
            .args(&command[1..])
            .arg(payload)
            .envs(fixture.environment.values())
            .env("HMUX_SESSION_ID", "session-fixture")
            .env("HMUX_WORKSPACE_ID", "workspace-fixture")
            .env("HMUX_RUNNER_PRINCIPAL", "fixture-user")
            .env("HMUX_RUNNER_INSTANCE", "fixture-runner")
            .env("HMUX_CHANNEL_EPOCH", "1")
            .env("HMUX_HOST_INSTANCE_ID", "fixture-host")
            .env("HMUX_TERMINAL_EPOCH", "fixture-terminal")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            std::fs::read_to_string(fixture.home.join("user-notify-result")).unwrap(),
            format!("private-notify-secret\nspace and 'quote\n{payload}\n")
        );
        let report: serde_json::Value =
            serde_json::from_slice(&std::fs::read(fixture.home.join("report.json")).unwrap())
                .unwrap();
        assert_eq!(report["report"]["activity"], "waiting");
        assert_eq!(report["report"]["turn_completed"], true);
        assert_eq!(
            report["report"]["conversation_identity"]["conversation_id"],
            "conversation-fixture"
        );
    }

    #[test]
    fn remote_codex_preflight_failures_leave_native_launch_unchanged() {
        for mode in [
            "eof",
            "unsupported",
            "invalid",
            "missing",
            "oversized",
            "timeout",
        ] {
            let fixture = CodexFixture::new(mode);
            let started = std::time::Instant::now();
            let integration = fixture.ensure(false);
            assert!(integration.is_none(), "{mode}");
            assert!(
                fixture.home.join("query-pid").exists(),
                "{mode} must execute its config probe"
            );
            assert_eq!(
                fixture.launch(integration.as_ref()),
                fixture.launch(None),
                "{mode}"
            );
            assert!(
                started.elapsed() < std::time::Duration::from_secs(8),
                "{mode}"
            );
            for name in ["query-pid", "query-child-pid"] {
                if let Ok(pid) = std::fs::read_to_string(fixture.home.join(name)) {
                    let output = std::process::Command::new("ps")
                        .args(["-o", "stat=", "-p", pid.trim()])
                        .output()
                        .unwrap();
                    assert!(
                        output.stdout.is_empty()
                            || String::from_utf8_lossy(&output.stdout)
                                .trim()
                                .starts_with('Z'),
                        "leaked {mode} process {pid}"
                    );
                }
            }
        }
        let fixture = CodexFixture::new("success");
        let integration = fixture.ensure(true);
        assert!(integration.is_none());
        assert_eq!(fixture.launch(integration.as_ref()), fixture.launch(None));
    }

    #[test]
    fn remote_codex_requires_an_exact_publication_receipt() {
        let fixture = CodexFixture::new("success");
        for stdout in [
            "{}",
            r#"{"wrapper":17}"#,
            r#"{"wrapper":"/outside/notify.sh"}"#,
            r#"{"wrapper":null,"notify":["private-notify-secret"]}"#,
        ] {
            let mut calls = 0;
            let integration = ensure_with(
                "codex",
                &fixture.runtime,
                fixture.home.to_str().unwrap(),
                &fixture.environment,
                &mut |_, _| {
                    calls += 1;
                    Ok(crate::ssh::ExecResult {
                        code: 0,
                        stdout: stdout.into(),
                        stderr: String::new(),
                    })
                },
            )
            .unwrap();
            assert!(integration.is_none());
            assert_eq!(calls, 1, "an invalid receipt must not publish the reporter");
            assert_eq!(fixture.launch(integration.as_ref()), fixture.launch(None));
        }
    }

    #[test]
    fn remote_codex_keeps_confirmed_absent_notify_and_rejects_tampering() {
        let fixture = CodexFixture::new("success");
        let first = fixture.ensure(false).unwrap();
        assert_eq!(fixture.ensure(false), Some(first.clone()));
        let ProviderRuntimeIntegrationV1::NotificationCommand { command } = first else {
            panic!("notify");
        };
        std::fs::write(&command[1], "tampered fixture wrapper").unwrap();
        assert!(fixture.ensure(false).is_none());
        assert_eq!(
            std::fs::read_to_string(&command[1]).unwrap(),
            "tampered fixture wrapper"
        );
        for absent in [serde_json::Value::Null, serde_json::json!([])] {
            std::fs::write(
                fixture.home.join("selected profile/fixture.json"),
                serde_json::to_vec(&serde_json::json!({"mode":"success", "notify": absent}))
                    .unwrap(),
            )
            .unwrap();
            let integration = fixture.ensure(false).unwrap();
            let ProviderRuntimeIntegrationV1::NotificationCommand { command } = integration else {
                panic!("notify");
            };
            assert_eq!(command.len(), 1);
        }
    }

    fn runtime(executable: &str) -> crate::remote_hmux_install::RemoteHmuxRuntimeLocation {
        crate::remote_hmux_install::RemoteHmuxRuntimeLocation::fixture(
            "/home/developer",
            executable,
        )
    }

    #[test]
    fn claude_files_are_content_addressed_to_the_execution_side() {
        let first = claude_publication_plan(&runtime(
            "/home/developer/.local/share/hmux/versions/build-1/bin/hmux-runtime",
        ))
        .unwrap();
        let second = claude_publication_plan(&runtime(
            "/home/developer/.local/share/hmux/versions/build-2/bin/hmux-runtime",
        ))
        .unwrap();

        assert_ne!(first.hook.exact_path, second.hook.exact_path);
        assert_ne!(first.settings.exact_path, second.settings.exact_path);
        assert!(first
            .hook
            .contents
            .contains("versions/build-1/bin/hmux-runtime"));
        assert!(first.settings.contents.contains(first.hook.exact_path.as_str()));
        assert!(!first.settings.contents.contains("--hmux-direct"));
        assert!(!first.settings.contents.contains("127.0.0.1"));
        assert_eq!(first.hook.mode, 0o700);
        assert_eq!(first.settings.mode, 0o600);
        assert!(first.hook.requires_python);
        assert!(!first.settings.requires_python);
    }

    #[test]
    fn remote_hook_argv_runs_with_spaces_and_apostrophes_in_home() {
        use std::os::unix::fs::PermissionsExt;

        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path().join("Dure's home");
        let runtime = crate::remote_hmux_install::RemoteHmuxRuntimeLocation::fixture(
            home.to_str().unwrap(),
            &format!("{}/.local/bin/hmux-runtime", home.display()),
        );
        let plan = claude_publication_plan(&runtime).unwrap();
        // Materialize the remote plan in a disposable direct-exec fixture.
        let hook_path = std::path::PathBuf::from(plan.hook.exact_path.to_string());
        std::fs::create_dir_all(hook_path.parent().unwrap()).unwrap();
        std::fs::write(&hook_path, "#!/bin/sh\nprintf '%s\\n' remote-hook-ran \"$@\"\n")
            .unwrap();
        std::fs::set_permissions(&hook_path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let settings: serde_json::Value = serde_json::from_str(&plan.settings.contents).unwrap();
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "PreToolUse",
            "Stop",
            "Notification",
        ] {
            let hook = &settings["hooks"][event][0]["hooks"][0];
            let command = hook["command"].as_str().unwrap();
            let arguments = hook["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|argument| argument.as_str().unwrap());
            let output = std::process::Command::new(command)
                .args(arguments)
                .env_clear()
                .output()
                .unwrap_or_else(|error| panic!("{event} hook direct execution failed: {error}"));
            assert!(
                output.status.success(),
                "{event}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                output.stdout,
                b"remote-hook-ran\nclaude\n--managed-direct\n--terminal-events\n"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn remote_github_path_reaches_the_provider_and_its_shell_children() {
        let root = tempfile::tempdir().unwrap();
        let bridge = root.path().join("GitHub's bridge");
        std::fs::create_dir(&bridge).unwrap();
        let gh = bridge.join("gh");
        std::fs::write(&gh, "#!/bin/sh\necho desktop-issue-comment\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let plan = AgentProviderLaunchPlanV1 {
            executable: "/bin/sh".into(),
            arguments: vec!["-c".into(), "gh issue view 123 --comments".into()],
        };
        let command = launch_command("claude", plan, None, bridge.to_str()).unwrap();
        let output = std::process::Command::new(&command[0])
            .args(&command[1..])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"desktop-issue-comment\n");
    }

    #[test]
    fn launch_composes_typed_native_and_integration_arguments_once() {
        let integration = ProviderRuntimeIntegrationV1::SettingsFile {
            path: "/home/developer/Dure's hooks/settings.json".into(),
        };
        let command = launch_command(
            "claude",
            AgentProviderLaunchPlanV1 {
                executable: "claude".into(),
                arguments: vec!["--resume".into(), "conversation-1".into()],
            },
            Some(&integration),
            None,
        )
        .unwrap();
        assert_eq!(&command[..2], ["/bin/sh", "-lc"]);
        assert!(command[2].contains("'--settings'"));
        assert!(command[2].contains("Dure'\"'\"'s hooks/settings.json"));
        assert_eq!(command[2].matches("'--resume'").count(), 1);
        assert_eq!(command[2].matches("'conversation-1'").count(), 1);
    }
}
