//! 이 기계가 폰의 SSH 를 받을 준비가 됐는지, 그리고 어떤 자세로 받는지.
//!
//! 허브 구조에서 폰은 노트북에 SSH 로 붙는다. 그러려면 sshd 가 떠 있어야 하고,
//! 지금은 그것이 꺼져 있을 때 사용자가 알 방법이 없다 — 페어링이 "호스트 키가
//! 없습니다" 로 실패하고 나서야 알게 되고, 그 문장만으로는 무엇을 켜야 하는지
//! 알 수 없다.
//!
//! # 루트 없이 읽는다
//!
//! `systemsetup -getremotelogin` 은 루트를 요구한다. 대신 두 가지 관측으로
//! 대신한다: 호스트 키 파일의 존재와 `launchctl` 이 보고하는 서비스 상태.
//! 호스트 키는 sshd 가 처음 켜질 때 생성되고 꺼도 남으므로 그것만으로는
//! "한 번이라도 켠 적 있다" 밖에 알 수 없다 — 그래서 둘을 함께 본다.
//!
//! # 이 모듈이 sshd 설정을 고치지 않는 이유
//!
//! 비밀번호 인증을 끄는 것이 옳은 자세이고 화면은 그렇게 말한다. 그래도 앱이
//! `sshd_config` 를 쓰고 sshd 를 재시작하지는 않는다. 잘못 쓰면 사용자가 자기
//! 기계에 SSH 로 들어갈 수 없게 되고, 그건 앱이 만들 수 있는 가장 되돌리기
//! 어려운 상태다. 이 앱에는 관리자 권한 승격 전례도 없다 — `osascript` 는 알림에만
//! 쓰인다. 시스템 설정 창을 열어 주고 명령을 보여주는 것이 플랫폼 방식이고,
//! 사용자가 무엇을 바꾸는지 알고 바꾸게 된다.

use serde::Serialize;

/// 이 기계의 SSH 수신 자세.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct RemoteLoginPosture {
    /// sshd 가 지금 돌고 있는지. `None` 은 확인하지 못했다는 뜻이다 —
    /// `false` 로 떨어뜨리면 켜져 있는데 꺼졌다고 말하게 된다.
    pub running: Option<bool>,
    /// 호스트 키가 있는지. 폰이 고정할 대상이고, 없으면 페어링이 여기서 멈춘다.
    pub has_host_key: bool,
    /// 있으면 폰이 QR 로 받는 그 지문. `ssh-keygen -lf` 가 찍는 것과 같은 문자열.
    pub host_key_fingerprint: Option<String>,
    /// 비밀번호 인증이 열려 있는지. `None` 은 설정을 읽지 못했다는 뜻이다.
    ///
    /// 켜져 있으면 폰 키와 무관하게 계정 비밀번호로 SSH 가 열린다 — 폰 키에
    /// 강제 명령을 걸어 둔 것과 별개의 문이고, 화면이 그 구분을 말해야 한다.
    pub password_authentication: Option<bool>,
    /// macOS 애플리케이션 방화벽이 켜져 있는지.
    pub firewall_enabled: Option<bool>,
}

/// sshd 가 처음 켜질 때 만들어지는 키들. 선호 순서는 `hmux pair` 와 같다 —
/// 두 곳이 다른 키를 고르면 화면이 보여준 지문과 폰이 고정하는 지문이 달라진다.
#[cfg(target_os = "macos")]
const HOST_KEY_CANDIDATES: &[&str] = &[
    "/etc/ssh/ssh_host_ed25519_key.pub",
    "/etc/ssh/ssh_host_ecdsa_key.pub",
    "/etc/ssh/ssh_host_rsa_key.pub",
];

#[cfg(target_os = "macos")]
fn first_host_key() -> Option<std::path::PathBuf> {
    HOST_KEY_CANDIDATES
        .iter()
        .map(std::path::PathBuf::from)
        .find(|path| path.is_file())
}

/// `ssh-keygen -lf` 로 지문을 읽는다.
///
/// 직접 계산하지 않는 이유: `hmux pair` 가 폰에 넘기는 값과 **같은 도구**가 찍은
/// 문자열이어야 한다. 우리가 base64 나 해시 변종을 하나 잘못 골라도 화면에는
/// 그럴듯한 지문이 보이고, 폰이 고정에 실패할 때까지 아무도 모른다.
#[cfg(target_os = "macos")]
fn fingerprint_of(path: &std::path::Path) -> Option<String> {
    let output = std::process::Command::new("ssh-keygen")
        .arg("-lf")
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout);
    // `256 SHA256:… comment (ED25519)` — 두 번째 필드가 지문이다.
    line.split_whitespace().nth(1).map(str::to_string)
}

/// sshd 가 돌고 있는지.
///
/// `launchctl print` 는 서비스가 로드돼 있으면 성공하고 없으면 실패한다. 종료
/// 코드만 보고 출력을 파싱하지 않는 이유: 그 출력 형식은 macOS 버전마다 바뀌고,
/// 우리가 필요한 것은 있다/없다 한 비트다.
#[cfg(target_os = "macos")]
fn sshd_running() -> Option<bool> {
    let output = std::process::Command::new("launchctl")
        .args(["print", "system/com.openssh.sshd"])
        .output()
        .ok()?;
    Some(output.status.success())
}

/// 비밀번호 인증이 열려 있는지, sshd 자신에게 물어본다.
///
/// `sshd -T` 는 `sshd_config` 와 `sshd_config.d/*` 를 모두 합친 **실효 설정**을
/// 찍는다. 파일을 직접 grep 하면 주석 처리된 기본값(이 맥의 경우
/// `#PasswordAuthentication yes`)을 놓치거나, `sshd_config.d` 의 덮어쓰기를
/// 놓친다 — 둘 다 화면이 반대로 말하게 만든다.
///
/// `sshd -T` 는 보통 루트를 요구한다. 실패하면 `None` 이고 화면은 "확인하지
/// 못했습니다" 라고 말한다 — 안전한 쪽으로 추측하지 않는다. "꺼져 있다" 고
/// 추측하면 열린 문을 닫혔다고 말하는 것이고, "켜져 있다" 고 추측하면 이미
/// 굳혀 둔 사용자에게 틀린 경고를 준다.
#[cfg(target_os = "macos")]
fn password_authentication() -> Option<bool> {
    let output = std::process::Command::new("/usr/sbin/sshd")
        .arg("-T")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    parse_password_authentication(&text)
}

/// `sshd -T` 출력에서 `passwordauthentication` 값을 읽는다.
///
/// 순수 함수로 분리해 두는 이유: 루트가 없는 개발 기계에서는 위 함수가 항상
/// `None` 이라 파싱이 한 번도 실행되지 않고, 그러면 형식이 바뀌었을 때 알 수
/// 없다.
#[cfg(any(target_os = "macos", test))]
pub fn parse_password_authentication(effective_config: &str) -> Option<bool> {
    for line in effective_config.lines() {
        let mut parts = line.split_whitespace();
        // `sshd -T` 는 키를 전부 소문자로 찍는다.
        if parts.next()? == "passwordauthentication" {
            return match parts.next()? {
                "yes" => Some(true),
                "no" => Some(false),
                _ => None,
            };
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn firewall_enabled() -> Option<bool> {
    let output = std::process::Command::new("/usr/libexec/ApplicationFirewall/socketfilterfw")
        .arg("--getglobalstate")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
    if text.contains("enabled") {
        Some(true)
    } else if text.contains("disabled") {
        Some(false)
    } else {
        None
    }
}

#[tauri::command]
pub fn remote_login_posture() -> RemoteLoginPosture {
    #[cfg(target_os = "macos")]
    {
        let host_key = first_host_key();
        RemoteLoginPosture {
            running: sshd_running(),
            has_host_key: host_key.is_some(),
            host_key_fingerprint: host_key.as_deref().and_then(fingerprint_of),
            password_authentication: password_authentication(),
            firewall_enabled: firewall_enabled(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // 이 화면은 macOS 의 원격 로그인 스위치를 설명한다. 다른 플랫폼에서는
        // 아무것도 주장하지 않는다 — sshd 를 켜는 방법이 배포판마다 다르고,
        // 틀린 안내가 안내 없음보다 나쁘다.
        RemoteLoginPosture {
            running: None,
            has_host_key: false,
            host_key_fingerprint: None,
            password_authentication: None,
            firewall_enabled: None,
        }
    }
}

/// 시스템 설정의 공유 창을 연다. 원격 로그인 스위치가 거기 있다.
///
/// 앱이 켜 주지 않는 이유는 모듈 주석에 있다. 여는 것까지가 이 앱의 몫이다.
#[tauri::command]
pub fn open_sharing_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // 두 개를 순서대로 시도한다: 새 이름(Ventura+)과 옛 pane. 하나만 쓰면
        // macOS 버전에 따라 아무 창도 열리지 않고, 사용자에게는 버튼이 고장난
        // 것으로 보인다.
        const TARGETS: &[&str] = &[
            "x-apple.systempreferences:com.apple.Sharing-Settings.extension",
            "x-apple.systempreferences:com.apple.preferences.sharing",
        ];
        let mut last = String::new();
        for target in TARGETS {
            match std::process::Command::new("open").arg(target).output() {
                Ok(output) if output.status.success() => return Ok(()),
                Ok(output) => {
                    last = String::from_utf8_lossy(&output.stderr).trim().to_string();
                }
                Err(error) => last = error.to_string(),
            }
        }
        Err(if last.is_empty() {
            "Could not open Sharing settings".to_string()
        } else {
            last
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Sharing settings can only be opened on macOS".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `sshd -T` 는 루트를 요구해서 개발 기계에서는 실행되지 않는다. 파싱을
    /// 따로 시험하지 않으면 형식이 바뀌었을 때 알 수 없다.
    #[test]
    fn the_effective_config_is_read_rather_than_the_file() {
        let sample = "port 22\npasswordauthentication no\npermitrootlogin no\n";
        assert_eq!(parse_password_authentication(sample), Some(false));

        let open = "port 22\npasswordauthentication yes\n";
        assert_eq!(parse_password_authentication(open), Some(true));
    }

    /// 값을 못 읽었으면 `None` 이다. 어느 쪽으로도 추측하지 않는다 — 열린 문을
    /// 닫혔다고 말하거나, 이미 굳혀 둔 사용자에게 틀린 경고를 주게 된다.
    #[test]
    fn an_unreadable_value_is_unknown_rather_than_guessed() {
        for text in [
            "",
            "port 22\n",
            "passwordauthentication\n",
            "passwordauthentication maybe\n",
            // 주석 처리된 기본값은 `sshd -T` 출력에 나타나지 않는다. 파일을
            // grep 하던 초안이 여기서 틀렸다: 이 맥의 sshd_config 에는
            // `#PasswordAuthentication yes` 만 있어서 "설정 없음" 으로 읽혔지만
            // 실효값은 yes 다.
            "#passwordauthentication yes\n",
        ] {
            assert_eq!(parse_password_authentication(text), None, "{text:?}");
        }
    }

    /// 접두사가 같은 다른 키를 잡으면 안 된다.
    #[test]
    fn a_similarly_named_option_is_not_mistaken_for_it() {
        let sample = "passwordauthentication_extra yes\nkbdinteractiveauthentication yes\n";
        assert_eq!(parse_password_authentication(sample), None);
    }

    /// 지문은 `ssh-keygen` 이 찍은 두 번째 필드다. 우리가 계산하지 않는다.
    #[test]
    fn the_fingerprint_field_is_the_one_ssh_keygen_prints() {
        let line = "256 SHA256:oNHiIEYQVRhn6eXM4a5EF1/KCD8yK/IOXk1bsUQftU0 root@host (ED25519)";
        assert_eq!(
            line.split_whitespace().nth(1),
            Some("SHA256:oNHiIEYQVRhn6eXM4a5EF1/KCD8yK/IOXk1bsUQftU0")
        );
    }

    /// 이 기계에서 부르는 것 자체가 죽지 않아야 한다. 값은 기계 상태에 따라
    /// 다르므로 단언하지 않고, 호스트 키가 있으면 지문도 함께 있는지만 본다 —
    /// 둘이 어긋나면 화면이 "준비됐다" 면서 고정할 값을 못 보여준다.
    #[test]
    fn reading_the_posture_does_not_panic_and_stays_internally_consistent() {
        let posture = remote_login_posture();
        if posture.has_host_key {
            assert!(
                posture.host_key_fingerprint.is_some(),
                "호스트 키가 있으면 지문도 읽혀야 한다: {posture:?}"
            );
        } else {
            assert!(posture.host_key_fingerprint.is_none(), "{posture:?}");
        }
    }
}
