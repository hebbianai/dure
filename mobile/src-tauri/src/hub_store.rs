//! 페어링한 허브를 폰이 기억하는 곳.
//!
//! QR 은 한 번만 스캔하는 것이 설계 목표다. 저장이 없으면 앱을 껐다 켤 때마다
//! 노트북 앞으로 돌아가야 하는데, 이 기능은 **노트북 앞에 없을 때** 쓰라고
//! 만든 것이다.
//!
//! # SSH 쪽 [`crate::server_store`] 와 왜 따로인가
//!
//! 담는 것이 다르다. 그쪽은 SSH 호스트와 키 confinement 를, 이쪽은 인증서
//! 지문과 기기 토큰과 릴레이 주소를 담는다. 한 문서에 섞으면 어느 전송의
//! 항목인지 필드로 구별해야 하고, 그러면 "SSH 인데 지문이 있는" 같은 표현
//! 불가능한 상태가 타입에 들어온다.
//!
//! # 지문이 바뀌면 지우지 않는다
//!
//! 노트북 앱을 재설치하면 인증서가 새로 만들어지고, 저장된 지문은 더 이상
//! 맞지 않는다. 그때 항목을 조용히 지우거나 새 지문으로 덮으면 **페어링이
//! 하는 일이 사라진다** — 폰이 아무 기계나 받아들이게 된다.
//!
//! 그대로 두고 붙을 때 실패시킨다. 화면은 "페어링한 그 컴퓨터가 아닙니다" 를
//! 말하고, 사용자가 지우고 다시 스캔하는 것이 유일한 회복이다.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::Path;

/// 이 문서의 판. 모르는 판은 거부한다.
pub const HUB_STORE_VERSION: u32 = 1;

/// 저장할 수 있는 허브 수의 상한.
///
/// 상한이 있는 이유는 QR 하나가 항목 하나를 만들고, 스캔은 실수로 반복되기
/// 때문이다. 없으면 파일이 조용히 자란다.
const MAX_HUBS: usize = 32;

/// 페어링한 컴퓨터 하나.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubEntry {
    /// 이 항목의 id. 인증서 지문을 쓴다 — **기계의 신원이 곧 항목의 신원**이고,
    /// 주소는 인터페이스마다 다르고 릴레이를 타면 또 달라진다.
    pub id: String,
    /// 화면에 뜨는 컴퓨터 이름.
    pub box_label: String,
    /// 구 QR 호환과 TLS 서버 이름용 주소. 폰은 이 사설 주소로 다이얼하지 않는다.
    pub endpoint: String,
    /// 고정할 인증서 지문. `id` 와 같은 값이지만 이름을 따로 둔다 — 하나는
    /// 저장소의 키이고 하나는 프로토콜이 검사하는 값이다.
    pub fingerprint: String,
    /// 이 폰 전용 토큰.
    pub token: String,
    /// 폰이 허브에 닿는 인터넷 경로. QR 이 나르지 않았으면 재페어링이 필요하다.
    #[serde(default)]
    pub relay_endpoint: Option<String>,
    #[serde(default)]
    pub server_id: Option<String>,
}

/// 토큰을 찍지 않는다. 그 값을 가진 쪽은 이 폰인 척할 수 있다.
impl std::fmt::Debug for HubEntry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HubEntry")
            .field("id", &self.id)
            .field("box_label", &self.box_label)
            .field("endpoint", &self.endpoint)
            .field("fingerprint", &self.fingerprint)
            .field("token", &"<가려짐>")
            .field("relay_endpoint", &self.relay_endpoint)
            .field("server_id", &self.server_id)
            .finish()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubDocument {
    pub version: u32,
    pub hubs: Vec<HubEntry>,
}

impl Default for HubDocument {
    fn default() -> Self {
        Self {
            version: HUB_STORE_VERSION,
            hubs: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub enum HubStoreError {
    Unreadable(String),
    UnsupportedVersion { found: u32 },
    TooMany,
    Io(io::Error),
}

impl std::fmt::Display for HubStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable(detail) => {
                write!(formatter, "저장된 컴퓨터 목록을 읽을 수 없습니다: {detail}")
            }
            Self::UnsupportedVersion { found } => write!(
                formatter,
                "이 앱이 읽지 못하는 저장 형식입니다: {found} (이 빌드는 {HUB_STORE_VERSION})"
            ),
            Self::TooMany => write!(formatter, "저장할 수 있는 컴퓨터 수를 넘었습니다"),
            Self::Io(error) => write!(formatter, "저장소를 쓰지 못했습니다: {error}"),
        }
    }
}

impl std::error::Error for HubStoreError {}

impl HubStoreError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unreadable(_) => "hub_store_unreadable",
            Self::UnsupportedVersion { .. } => "hub_store_unsupported_version",
            Self::TooMany => "hub_store_too_many",
            Self::Io(_) => "hub_store_io",
        }
    }
}

/// 없으면 빈 문서. "아직 아무것도 없음" 은 오류가 아니다.
pub fn load(path: &Path) -> Result<HubDocument, HubStoreError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(HubDocument::default()),
        Err(error) => return Err(HubStoreError::Io(error)),
    };
    let document: HubDocument = serde_json::from_slice(&bytes)
        .map_err(|error| HubStoreError::Unreadable(error.to_string()))?;
    if document.version != HUB_STORE_VERSION {
        return Err(HubStoreError::UnsupportedVersion {
            found: document.version,
        });
    }
    Ok(document)
}

pub fn save(path: &Path, document: &HubDocument) -> Result<(), HubStoreError> {
    if document.hubs.len() > MAX_HUBS {
        return Err(HubStoreError::TooMany);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(HubStoreError::Io)?;
    }
    let body = serde_json::to_vec_pretty(document)
        .map_err(|error| HubStoreError::Unreadable(error.to_string()))?;
    // 임시 파일에 쓰고 갈아끼운다. 그대로 덮어쓰다 죽으면 반쯤 쓰인 JSON 이
    // 남고, 그 폰은 다음 실행부터 목록을 통째로 못 읽는다.
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, &body).map_err(HubStoreError::Io)?;
    fs::rename(&temporary, path).map_err(HubStoreError::Io)
}

/// 같은 기계면 덮어쓰고, 아니면 더한다.
///
/// 같은지는 **지문**으로 본다. 노트북의 주소는 인터페이스나 네트워크가 바뀌면
/// 달라지므로, 주소로 보면 같은 컴퓨터가 목록에 여러 줄로 쌓인다.
pub fn upsert(document: &mut HubDocument, entry: HubEntry) -> Result<(), HubStoreError> {
    if let Some(existing) = document.hubs.iter_mut().find(|row| row.id == entry.id) {
        *existing = entry;
        return Ok(());
    }
    if document.hubs.len() >= MAX_HUBS {
        return Err(HubStoreError::TooMany);
    }
    document.hubs.push(entry);
    Ok(())
}

/// 지웠으면 `true`.
pub fn remove(document: &mut HubDocument, id: &str) -> bool {
    let before = document.hubs.len();
    document.hubs.retain(|row| row.id != id);
    document.hubs.len() != before
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(fingerprint: &str, label: &str) -> HubEntry {
        HubEntry {
            id: fingerprint.to_string(),
            box_label: label.to_string(),
            endpoint: "192.168.0.12:47823".to_string(),
            fingerprint: fingerprint.to_string(),
            token: "token-1".to_string(),
            relay_endpoint: Some("relay.example:8787".to_string()),
            server_id: Some("server-1".to_string()),
        }
    }

    #[test]
    fn a_missing_file_is_an_empty_list_not_an_error() {
        let root = tempfile::tempdir().unwrap();
        let document = load(&root.path().join("hubs.json")).expect("없는 것은 오류가 아니다");
        assert!(document.hubs.is_empty());
        assert_eq!(document.version, HUB_STORE_VERSION);
    }

    #[test]
    fn what_is_saved_is_what_is_read_back() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("hubs.json");
        let mut document = HubDocument::default();
        upsert(&mut document, entry("SHA256:a", "노트북")).unwrap();

        save(&path, &document).unwrap();

        assert_eq!(load(&path).unwrap(), document);
    }

    /// 같은 컴퓨터를 다시 스캔하는 것은 흔하다(토큰이 새로 발급된다). 주소로
    /// 보면 네트워크가 바뀐 같은 컴퓨터가 두 줄이 된다.
    #[test]
    fn rescanning_the_same_machine_replaces_rather_than_duplicates() {
        let mut document = HubDocument::default();
        upsert(&mut document, entry("SHA256:a", "노트북")).unwrap();

        let mut moved = entry("SHA256:a", "노트북");
        moved.endpoint = "10.0.0.5:51000".to_string();
        moved.token = "token-2".to_string();
        upsert(&mut document, moved).unwrap();

        assert_eq!(document.hubs.len(), 1);
        assert_eq!(document.hubs[0].endpoint, "10.0.0.5:51000");
        assert_eq!(document.hubs[0].token, "token-2");
    }

    #[test]
    fn two_machines_are_two_rows() {
        let mut document = HubDocument::default();
        upsert(&mut document, entry("SHA256:a", "노트북")).unwrap();
        upsert(&mut document, entry("SHA256:b", "데스크탑")).unwrap();
        assert_eq!(document.hubs.len(), 2);
    }

    #[test]
    fn removing_names_whether_it_removed_anything() {
        let mut document = HubDocument::default();
        upsert(&mut document, entry("SHA256:a", "노트북")).unwrap();

        assert!(remove(&mut document, "SHA256:a"));
        assert!(
            !remove(&mut document, "SHA256:a"),
            "두 번째는 지울 것이 없다"
        );
        assert!(document.hubs.is_empty());
    }

    #[test]
    fn an_unknown_version_is_named_rather_than_silently_reset() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("hubs.json");
        fs::write(&path, br#"{"version":999,"hubs":[]}"#).unwrap();

        assert!(matches!(
            load(&path),
            Err(HubStoreError::UnsupportedVersion { found: 999 })
        ));
    }

    /// 반쯤 쓰인 파일을 남기지 않는다는 것. 그대로 덮어쓰면 저장 중 죽은 폰이
    /// 다음 실행부터 목록을 통째로 못 읽는다.
    #[test]
    fn saving_leaves_no_temporary_file_behind() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("hubs.json");
        let mut document = HubDocument::default();
        upsert(&mut document, entry("SHA256:a", "노트북")).unwrap();

        save(&path, &document).unwrap();

        assert!(path.is_file());
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn the_store_is_bounded() {
        let mut document = HubDocument::default();
        for index in 0..MAX_HUBS {
            upsert(&mut document, entry(&format!("SHA256:{index}"), "노트북")).unwrap();
        }
        assert!(matches!(
            upsert(&mut document, entry("SHA256:one-too-many", "노트북")),
            Err(HubStoreError::TooMany)
        ));
    }

    #[test]
    fn debug_withholds_the_token() {
        let rendered = format!("{:?}", entry("SHA256:a", "노트북"));
        assert!(!rendered.contains("token-1"), "{rendered}");
    }
}
