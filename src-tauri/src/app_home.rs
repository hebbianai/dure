//! Dure 앱 홈(`~/.dure`) 해석 — writable user state의 단일 진실.
//!
//! `~/.hebbian`은 마이그레이션 도구가 제한적으로 읽는 legacy 입력일 뿐이다.
//! 앱의 일반 read/write 경로가 legacy 존재 여부로 authority를 바꾸면 두 루트에
//! 새 상태가 갈라지므로 이 resolver는 항상 canonical `~/.dure`를 돌려준다.
//!
//! env 오버라이드는 `DURE_HOME` 하나만 받는다. `HEBBIAN_HOME`은 이미 hmux
//! discovery 해석에서 "portable 데이터 루트"(하위에 `state/...`를 join)라는
//! 다른 의미로 쓰이고 있어, 여기서 앱 루트로 재해석하면 같은 변수 하나가 두
//! 계층에서 다른 뜻이 된다.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[cfg(test)]
pub(crate) static ENVIRONMENT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Resolve under the explicit home without reading ambient environment.
/// Fixtures must retain their supplied isolation boundary. Callers validate or
/// create this canonical path and fail closed on unsafe entries; legacy state
/// must never become a fallback write destination.
pub fn app_root_under(home: &Path) -> PathBuf {
    dure_session_runtime::host_command::application_home_under(home)
}

/// env 오버라이드 해석 — 순수 함수(테스트용으로 값 주입).
/// 빈 문자열은 미지정으로 본다(러너 픽스처 사고와 같은 규칙).
fn override_from(dure_home: Option<OsString>) -> Option<PathBuf> {
    dure_session_runtime::host_command::application_home_override(dure_home)
}

/// 어떤 규칙이 앱 루트를 정했는가 — 설정 › 데이터 위치가 사용자에게 보여준다.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppRootSource {
    /// DURE_HOME env가 지정
    EnvOverride,
    /// canonical ~/.dure 위치. wire 값 `renamed`는 기존 frontend 계약과 호환한다.
    Renamed,
}

/// 실행 환경의 앱 루트와 그 근거. `DURE_HOME` > `$HOME` 아래 선택.
pub fn app_root_resolution() -> Result<(PathBuf, AppRootSource), String> {
    if let Some(overridden) = override_from(std::env::var_os("DURE_HOME")) {
        return Ok((overridden, AppRootSource::EnvOverride));
    }
    let home = dirs::home_dir().ok_or_else(|| "Could not find the home directory".to_string())?;
    Ok((app_root_under(&home), AppRootSource::Renamed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_the_canonical_dure_directory() {
        let temporary = tempfile::tempdir().unwrap();
        assert_eq!(
            app_root_under(temporary.path()),
            temporary.path().join(".dure"),
        );
    }

    #[test]
    fn legacy_state_is_never_selected_as_a_writable_root() {
        let temporary = tempfile::tempdir().unwrap();
        let legacy = temporary.path().join(".hebbian");
        std::fs::create_dir(&legacy).unwrap();
        std::fs::write(legacy.join("migration-input"), b"legacy").unwrap();
        assert_eq!(
            app_root_under(temporary.path()),
            temporary.path().join(".dure"),
        );
        assert_eq!(
            std::fs::read(legacy.join("migration-input")).unwrap(),
            b"legacy"
        );
    }

    #[test]
    fn unsafe_canonical_entry_does_not_redirect_writes_to_legacy() {
        let temporary = tempfile::tempdir().unwrap();
        std::fs::write(temporary.path().join(".dure"), b"x").unwrap();
        std::fs::create_dir(temporary.path().join(".hebbian")).unwrap();
        assert_eq!(
            app_root_under(temporary.path()),
            temporary.path().join(".dure"),
        );
    }

    #[test]
    fn explicit_override_wins_and_empty_is_unset() {
        assert_eq!(
            override_from(Some(OsString::from("/tmp/portable"))),
            Some(PathBuf::from("/tmp/portable")),
        );
        assert_eq!(override_from(Some(OsString::new())), None);
        assert_eq!(override_from(None), None);
    }
}
