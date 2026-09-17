//! Claude 실측 rate-limit 수집기 설치/해제.
//!
//! Claude Code 로컬 로그에는 provider가 계산한 한도 %가 없다. 공식 statusLine
//! 훅의 stdin JSON에는 `rate_limits.five_hour/seven_day.{used_percentage,
//! resets_at}`가 실측으로 온다(Pro/Max, 첫 응답 이후). 여기서는 그 값을
//! `~/.dure/claude-rate-limits.json` 캐시로 남기는 수집 스크립트를
//! `~/.claude/settings.json`의 statusLine으로 설치한다 — Keychain/비공개 API
//! 없이 정직한 실측 %를 얻는 경로.
//!
//! 원칙: 사용자가 이미 자기 statusLine을 쓰고 있으면 절대 덮어쓰지 않는다
//! (상태 "foreign"으로 보고만 한다). 설치/해제는 우리 스크립트일 때만.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// settings.json statusLine command에서 우리 것임을 식별하는 마커.
const COLLECTOR_MARKER: &str = "/claude-statusline-collector";

const COLLECTOR_SCRIPT: &str = r#"#!/usr/bin/env python3
# Dure Claude rate-limit collector (auto-generated — hand edits are overwritten).
# Claude Code statusLine stdin JSON의 rate_limits를 캐시로 남긴다. 출력은 없어
# 상태줄에는 아무것도 표시되지 않는다.
#
# 계정별 캐시: Claude의 transcript 저장소(~/.claude/projects)는 계정 오버레이가
# 심링크로 공유하므로 로그만으로는 계정 귀속이 불가능하다. 반면 이 훅은 실제로
# 그 계정의 CLAUDE_CONFIG_DIR 안에서 돌고 있으므로, 자기 프로필 키를 알고 있다 —
# 계정별 한도 %를 정확히 가를 수 있는 유일한 지점이다.
import json, os, sys, tempfile, time

ACCOUNT_ROOT = os.path.realpath(os.path.expanduser("~/.dure/accounts"))


def profile_key():
    """이 훅이 도는 credential 프로필 키. 우리 계정 루트 바로 아래일 때만
    그 디렉터리 이름을 쓰고, 그 밖(미설정·사용자 지정 경로)은 'default'."""
    cfg = os.environ.get("CLAUDE_CONFIG_DIR") or ""
    if not cfg:
        return "default"
    cfg = os.path.realpath(os.path.abspath(os.path.expanduser(cfg)))
    if os.path.dirname(cfg) != ACCOUNT_ROOT:
        return "default"
    leaf = os.path.basename(cfg)
    ok = leaf and all(c.isalnum() or c in "._-" for c in leaf) and not leaf.startswith(".")
    return leaf if ok else "default"


def write_json(path, payload):
    directory = os.path.dirname(path)
    tmp = None
    try:
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=directory, prefix=".rate-limits-")
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f)
        os.replace(tmp, path)
        tmp = None
    except Exception:
        pass
    finally:
        # mkstemp는 실패해도 파일을 남긴다 — 상태줄 훅은 매 응답마다 도므로
        # 정리하지 않으면 잔여물이 계속 쌓인다.
        if tmp:
            try:
                os.unlink(tmp)
            except Exception:
                pass


try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
rl = data.get("rate_limits")
if not isinstance(rl, dict) or not rl:
    sys.exit(0)
payload = {"captured_at": int(time.time()), "rate_limits": rl}
home = os.path.expanduser("~")
write_json(os.path.join(home, ".dure/usage/claude-rate-limits", profile_key() + ".json"), payload)
# 레거시 전역 캐시도 계속 쓴다 — 구버전 리더와의 호환.
write_json(os.path.join(home, ".dure/claude-rate-limits.json"), payload)
"#;

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum CollectorState {
    /// 우리 수집기가 statusLine으로 설치돼 있음
    Installed,
    /// statusLine 미설정 — 설치 가능
    NotInstalled,
    /// 사용자가 다른 statusLine을 쓰는 중 — 건드리지 않는다
    Foreign,
}

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Could not find the home directory".to_string())
}

fn settings_path(home: &Path) -> PathBuf {
    home.join(".claude/settings.json")
}

fn script_path(home: &Path) -> PathBuf {
    crate::app_home::app_root_under(home).join("claude-statusline-collector.py")
}

fn read_settings(path: &Path) -> Result<serde_json::Value, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|e| format!("Could not parse settings.json; it will not be modified: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Ok(serde_json::Value::Object(Default::default()))
        }
        Err(e) => Err(format!("Could not read settings.json: {e}")),
    }
}

/// settings의 statusLine 상태 분류 (순수 로직 — 테스트 대상).
pub(crate) fn statusline_state(settings: &serde_json::Value) -> CollectorState {
    let Some(status_line) = settings.get("statusLine").filter(|v| !v.is_null()) else {
        return CollectorState::NotInstalled;
    };
    let command = status_line.get("command").and_then(|c| c.as_str()).unwrap_or("");
    if command.contains(COLLECTOR_MARKER) {
        CollectorState::Installed
    } else {
        CollectorState::Foreign
    }
}

/// statusLine에 수집기를 심는다 (순수 로직). foreign이면 거부.
pub(crate) fn plan_install(
    settings: &mut serde_json::Value,
    command: &str,
) -> Result<(), String> {
    match statusline_state(settings) {
        CollectorState::Foreign => Err(
            "A different statusLine is already configured and will not be overwritten. Integrate it manually in ~/.claude/settings.json."
                .to_string(),
        ),
        _ => {
            let Some(obj) = settings.as_object_mut() else {
                return Err("The top-level value in settings.json is not an object".to_string());
            };
            obj.insert(
                "statusLine".to_string(),
                serde_json::json!({ "type": "command", "command": command }),
            );
            Ok(())
        }
    }
}

/// 우리 수집기만 제거한다 (순수 로직). 제거했으면 true.
pub(crate) fn plan_uninstall(settings: &mut serde_json::Value) -> bool {
    if statusline_state(settings) != CollectorState::Installed {
        return false;
    }
    if let Some(obj) = settings.as_object_mut() {
        obj.remove("statusLine");
        return true;
    }
    false
}

/// Claude 계정 오버레이의 settings.json 경로들. 계정마다 CLAUDE_CONFIG_DIR가
/// 다르므로 canonical settings.json만 고쳐서는 그 계정 세션의 statusLine이
/// 설치되지 않는다 — 계정별 실측 %가 영영 수집되지 않는 원인.
fn claude_account_settings(home: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(crate::app_home::app_root_under(home).join("accounts")) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("claude-"))
        })
        .map(|path| path.join("settings.json"))
        .collect();
    out.sort();
    out
}

/// 계정 오버레이에 수집기를 전파한다. 최선 노력 — 사용자가 그 계정에 자기
/// statusLine을 뒀으면(foreign) 절대 건드리지 않고 건너뛴다. 계정은 설치
/// 이후에도 새로 생기므로 상태 조회 때마다 다시 맞춘다.
fn propagate_to_accounts(home: &Path, command: &str) {
    for path in claude_account_settings(home) {
        let Ok(mut settings) = read_settings(&path) else { continue };
        if statusline_state(&settings) != CollectorState::NotInstalled {
            continue;
        }
        if plan_install(&mut settings, command).is_ok() {
            let _ = write_settings(&path, &settings);
        }
    }
}

/// 우리 수집기만 계정 오버레이에서 제거한다 (foreign·미설치는 건드리지 않음).
fn revoke_from_accounts(home: &Path) {
    for path in claude_account_settings(home) {
        let Ok(mut settings) = read_settings(&path) else { continue };
        if plan_uninstall(&mut settings) {
            let _ = write_settings(&path, &settings);
        }
    }
}

/// 디스크의 수집 스크립트를 현재 버전으로 맞춘다. 스크립트는 자동 생성물이라
/// 앱이 업데이트되면 내용이 바뀐다 — 재설치를 사용자에게 시키지 않으려면
/// 설치돼 있는 동안 스스로 최신을 유지해야 한다(계정별 캐시 도입이 그 예).
fn ensure_script_current(script: &Path) {
    if std::fs::read_to_string(script).is_ok_and(|current| current == COLLECTOR_SCRIPT) {
        return;
    }
    if let Some(parent) = script.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if std::fs::write(script, COLLECTOR_SCRIPT).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(script, std::fs::Permissions::from_mode(0o755));
    }
}

fn write_settings(path: &Path, settings: &serde_json::Value) -> Result<(), String> {
    let pretty = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    // 원자적 교체 — statusLine은 모든 Claude 세션이 읽는 파일이다.
    let tmp = path.with_extension("json.hebbian-tmp");
    std::fs::write(&tmp, pretty + "\n").map_err(|e| format!("Could not write settings.json: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Could not replace settings.json: {e}"))
}

fn collector_command(script: &Path) -> String {
    // 공백 경로에도 안전하게 — statusLine command는 셸로 실행된다.
    format!("\"{}\"", script.to_string_lossy())
}

#[tauri::command(async)]
pub fn claude_collector_status() -> Result<CollectorState, String> {
    let home = home_dir()?;
    let settings = read_settings(&settings_path(&home))?;
    let state = statusline_state(&settings);
    if state == CollectorState::Installed {
        // 설치돼 있는 동안은 스스로 최신을 유지한다: 스크립트 갱신 + 설치
        // 이후에 생긴 계정 오버레이로의 전파.
        let script = script_path(&home);
        ensure_script_current(&script);
        propagate_to_accounts(&home, &collector_command(&script));
    }
    Ok(state)
}

#[tauri::command(async)]
pub fn claude_collector_install() -> Result<CollectorState, String> {
    let home = home_dir()?;
    let script = script_path(&home);
    // foreign 거부를 파일 산출보다 먼저 — 거부 시 잔여물(스크립트/백업)을 안 남긴다.
    let settings_file = settings_path(&home);
    let mut settings = read_settings(&settings_file)?;
    let command = collector_command(&script);
    plan_install(&mut settings, &command)?;

    if let Some(parent) = script.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create the app data directory: {e}"))?;
    }
    std::fs::write(&script, COLLECTOR_SCRIPT).map_err(|e| format!("Could not write the collector script: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Could not set collector script permissions: {e}"))?;
    }

    // 처음 설치할 때만 원본을 남겨둔다 — 설치 반복으로 백업이 덮이지 않게.
    let backup = settings_file.with_extension("json.hebbian-backup");
    if settings_file.exists() && !backup.exists() {
        std::fs::copy(&settings_file, &backup).map_err(|e| format!("Could not back up settings: {e}"))?;
    }
    if let Some(parent) = settings_file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Could not create ~/.claude: {e}"))?;
    }
    write_settings(&settings_file, &settings)?;
    propagate_to_accounts(&home, &command);
    Ok(CollectorState::Installed)
}

#[tauri::command(async)]
pub fn claude_collector_uninstall() -> Result<CollectorState, String> {
    let home = home_dir()?;
    let settings_file = settings_path(&home);
    let mut settings = read_settings(&settings_file)?;
    if plan_uninstall(&mut settings) {
        write_settings(&settings_file, &settings)?;
    }
    revoke_from_accounts(&home);
    let _ = std::fs::remove_file(script_path(&home));
    Ok(statusline_state(&settings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_settings_is_not_installed_and_installs() {
        let mut s = json!({});
        assert_eq!(statusline_state(&s), CollectorState::NotInstalled);
        plan_install(&mut s, "/Users/x/.dure/claude-statusline-collector.py").unwrap();
        assert_eq!(statusline_state(&s), CollectorState::Installed);
        assert_eq!(s["statusLine"]["type"], "command");
    }

    #[test]
    fn install_preserves_other_settings_keys() {
        let mut s = json!({"model": "fable", "hooks": {"Stop": []}});
        plan_install(&mut s, "/h/.dure/claude-statusline-collector.py").unwrap();
        assert_eq!(s["model"], "fable");
        assert!(s["hooks"]["Stop"].is_array());
    }

    #[test]
    fn foreign_statusline_is_reported_and_never_overwritten() {
        let mut s = json!({"statusLine": {"type": "command", "command": "~/bin/my-status.sh"}});
        assert_eq!(statusline_state(&s), CollectorState::Foreign);
        assert!(plan_install(&mut s, "/h/.dure/claude-statusline-collector.py").is_err());
        assert_eq!(s["statusLine"]["command"], "~/bin/my-status.sh");
    }

    #[test]
    fn quoted_command_path_still_classifies_as_ours() {
        // 설치 시 공백 경로 대비로 경로를 인용한다 — 마커 판별이 유지돼야 한다.
        let mut s = json!({});
        plan_install(&mut s, "\"/Users/a b/.dure/claude-statusline-collector.py\"").unwrap();
        assert_eq!(statusline_state(&s), CollectorState::Installed);
    }

    #[test]
    fn null_statusline_counts_as_not_installed() {
        let s = json!({"statusLine": null});
        assert_eq!(statusline_state(&s), CollectorState::NotInstalled);
    }

    #[test]
    fn reinstall_is_idempotent() {
        let mut s = json!({});
        plan_install(&mut s, "/h/.dure/claude-statusline-collector.py").unwrap();
        plan_install(&mut s, "/h/.dure/claude-statusline-collector.py").unwrap();
        assert_eq!(statusline_state(&s), CollectorState::Installed);
    }

    fn account(home: &Path, leaf: &str, settings: serde_json::Value) -> PathBuf {
        let dir = home.join(".dure/accounts").join(leaf);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        std::fs::write(&path, settings.to_string()).unwrap();
        path
    }

    /// 계정 오버레이는 CLAUDE_CONFIG_DIR가 달라 canonical settings.json을 읽지
    /// 않는다 — 전파하지 않으면 그 계정의 실측 %가 영영 수집되지 않는다.
    #[test]
    fn propagate_installs_into_claude_account_overlays_only() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let mine = account(home, "claude-second", json!({"model": "fable"}));
        let codex = account(home, "codex-crispy", json!({}));
        propagate_to_accounts(home, "\"/h/.dure/claude-statusline-collector.py\"");

        let updated: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&mine).unwrap()).unwrap();
        assert_eq!(statusline_state(&updated), CollectorState::Installed);
        assert_eq!(updated["model"], "fable", "기존 키를 보존해야 한다");
        let untouched: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&codex).unwrap()).unwrap();
        assert!(untouched.get("statusLine").is_none(), "codex 계정은 대상이 아니다");
    }

    #[test]
    fn propagate_never_overwrites_a_foreign_account_statusline() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let path = account(
            home,
            "claude-second",
            json!({"statusLine": {"type": "command", "command": "~/bin/mine.sh"}}),
        );
        propagate_to_accounts(home, "\"/h/.dure/claude-statusline-collector.py\"");
        let after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["statusLine"]["command"], "~/bin/mine.sh");
    }

    #[test]
    fn revoke_removes_ours_from_accounts_and_leaves_foreign() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let ours = account(
            home,
            "claude-second",
            json!({"statusLine": {"type": "command", "command": "/h/.dure/claude-statusline-collector.py"}}),
        );
        let foreign = account(
            home,
            "claude-third",
            json!({"statusLine": {"type": "command", "command": "~/bin/mine.sh"}}),
        );
        revoke_from_accounts(home);
        let ours_after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&ours).unwrap()).unwrap();
        assert!(ours_after.get("statusLine").is_none());
        let foreign_after: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&foreign).unwrap()).unwrap();
        assert_eq!(foreign_after["statusLine"]["command"], "~/bin/mine.sh");
    }

    /// 스크립트는 자동 생성물이다 — 앱이 바뀌면 재설치 없이 스스로 최신이 돼야
    /// 계정별 캐시 같은 변경이 기존 설치에도 적용된다.
    #[test]
    fn ensure_script_current_rewrites_a_stale_script() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("nested/collector.py");
        std::fs::create_dir_all(script.parent().unwrap()).unwrap();
        std::fs::write(&script, "# old version\n").unwrap();
        ensure_script_current(&script);
        assert_eq!(std::fs::read_to_string(&script).unwrap(), COLLECTOR_SCRIPT);
    }

    #[test]
    fn uninstall_removes_only_ours() {
        let mut ours = json!({"statusLine": {"type": "command", "command": "/h/.dure/claude-statusline-collector.py"}, "model": "fable"});
        assert!(plan_uninstall(&mut ours));
        assert!(ours.get("statusLine").is_none());
        assert_eq!(ours["model"], "fable");

        let mut foreign = json!({"statusLine": {"type": "command", "command": "~/bin/my.sh"}});
        assert!(!plan_uninstall(&mut foreign));
        assert!(foreign.get("statusLine").is_some());
    }
}
