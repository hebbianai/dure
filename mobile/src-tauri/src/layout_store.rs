//! 노트북 사이드바의 묶음을, 폰이 노트북 없이도 그릴 수 있게 기억하는 곳.
//!
//! # 왜 폰이 이것을 저장하는가
//!
//! 데스크탑("Workspace", "Onchain", "Artrooms")은 사용자가 노트북 앱에서 만든
//! 것이고, 그 구조는 노트북에 붙어야만 받을 수 있다. 그런데 폰이 붙을 수 있는
//! 세션은 노트북이 꺼진 뒤에도 남아 있다 — SSH 로 등록한 서버의 세션은 노트북을
//! 거치지 않는다.
//!
//! 구조를 기억해 두지 않으면 노트북이 꺼진 순간 폰의 목록은 묶음 없는 한 덩이로
//! 무너진다. 사용자가 정리해 둔 것이 노트북의 전원 상태에 따라 나타났다 사라지는
//! 셈이고, 그건 정리한 사람이 보려던 화면이 아니다. 기억해 두면 목록은 늘 같은
//! 모양으로 서 있고, **닿지 못하는 줄만 비활성**이 된다.
//!
//! # [`crate::hub_store`] 와 왜 따로인가
//!
//! 그쪽은 **비밀**을 담는다(기기 토큰). 이쪽은 화면 모양만 담는다. 한 파일에
//! 섞으면 화면 모양이 바뀔 때마다 토큰이 든 파일을 다시 쓰게 되고, 저장 중에
//! 죽으면 잃는 것이 "묶음"이 아니라 "페어링"이 된다.
//!
//! # 허브마다 따로 기억한다
//!
//! 노트북 두 대를 페어링한 사람은 사이드바도 두 벌이다. 한 표에 합쳐 담으면
//! 나중에 붙은 쪽이 앞의 것을 덮고, 그 손실은 다음에 그 노트북에 붙기 전까지
//! 보이지 않는다.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;

/// 이 문서의 판. 모르는 판은 거부한다.
pub const LAYOUT_STORE_VERSION: u32 = 1;

/// 표를 기억할 수 있는 허브 수의 상한. [`crate::hub_store`] 와 같은 값이다 —
/// 페어링할 수 있는 수보다 표가 많을 수는 없다.
const MAX_HUBS: usize = 32;

/// 허브 하나의 표에 담을 수 있는 세션 수의 상한.
///
/// 사이드바에 이만큼의 세션이 실제로 있을 수는 없다. 상한이 있는 이유는 저쪽이
/// 보내는 값이고, 폰의 디스크가 저쪽이 보낸 크기만큼 자라면 안 되기 때문이다.
const MAX_PLACEMENTS: usize = 4_096;

/// 세션 하나가 사이드바에서 앉아 있던 자리.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Placement {
    pub desktop: String,
    pub project: String,
    pub order: u32,
    /// 그 세션이 올라앉은 git 브랜치. 노트북이 안 실어 보냈으면 `None` — 옛 판을
    /// 보낸 노트북도 그대로 읽히도록 `default` 다.
    #[serde(default)]
    pub branch: Option<String>,
}

/// 노트북 한 대의 사이드바 모양.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubLayout {
    /// hmux 세션 id → 자리.
    ///
    /// `BTreeMap` 인 이유는 순서가 아니라 **파일이 안 흔들리게** 하려는 것이다.
    /// `HashMap` 은 실행마다 다른 순서로 직렬화되므로, 같은 표를 다시 저장해도
    /// 파일 내용이 매번 달라진다.
    pub placements: BTreeMap<String, Placement>,
    /// 데스크탑이 사이드바에 선 순서. 이름만으로는 순서를 알 수 없다.
    pub desktop_order: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct LayoutDocument {
    pub version: u32,
    /// 허브 id(인증서 지문) → 그 노트북의 사이드바 모양.
    pub hubs: BTreeMap<String, HubLayout>,
}

impl Default for LayoutDocument {
    fn default() -> Self {
        Self {
            version: LAYOUT_STORE_VERSION,
            hubs: BTreeMap::new(),
        }
    }
}

#[derive(Debug)]
pub enum LayoutStoreError {
    Unreadable(String),
    UnsupportedVersion { found: u32 },
    TooMany,
    Io(io::Error),
}

impl std::fmt::Display for LayoutStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable(detail) => {
                write!(formatter, "저장된 묶음을 읽을 수 없습니다: {detail}")
            }
            Self::UnsupportedVersion { found } => write!(
                formatter,
                "이 앱이 읽지 못하는 저장 형식입니다: {found} (이 빌드는 \
                 {LAYOUT_STORE_VERSION})"
            ),
            Self::TooMany => write!(formatter, "기억할 수 있는 묶음의 크기를 넘었습니다"),
            Self::Io(error) => write!(formatter, "묶음을 저장하지 못했습니다: {error}"),
        }
    }
}

impl std::error::Error for LayoutStoreError {}

impl LayoutStoreError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unreadable(_) => "layout_store_unreadable",
            Self::UnsupportedVersion { .. } => "layout_store_unsupported_version",
            Self::TooMany => "layout_store_too_many",
            Self::Io(_) => "layout_store_io",
        }
    }
}

/// 읽되, **읽을 수 없는 파일은 빈 문서로 친다.**
///
/// [`load`] 와 다른 점이 이 함수의 전부다. 이 파일은 캐시이고 진실은 노트북에
/// 있다. 깨진 JSON 하나 때문에 읽기를 거부하면 그 폰은 다시 쓰지도 못하고
/// (`remember` 가 먼저 읽는다) 지우지도 못해서 — 묶음 기능이 영영 죽는다.
/// 잃는 것은 **다른 노트북들의 캐시**뿐이고, 그건 그 노트북에 다음에 붙을 때
/// 다시 온다.
///
/// 판이 다른 것(`UnsupportedVersion`)은 이렇게 삼키지 않는다. 그건 깨진 파일이
/// 아니라 **더 새 빌드가 쓴 멀쩡한 파일**이고, 조용히 덮어쓰면 되돌리는 날
/// 무엇을 잃었는지 아무도 모른다.
pub fn load_or_reset(path: &Path) -> Result<LayoutDocument, LayoutStoreError> {
    match load(path) {
        Err(LayoutStoreError::Unreadable(_)) => Ok(LayoutDocument::default()),
        other => other,
    }
}

/// 없으면 빈 문서. "아직 아무것도 없음" 은 오류가 아니다.
pub fn load(path: &Path) -> Result<LayoutDocument, LayoutStoreError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(LayoutDocument::default())
        }
        Err(error) => return Err(LayoutStoreError::Io(error)),
    };
    let document: LayoutDocument = serde_json::from_slice(&bytes)
        .map_err(|error| LayoutStoreError::Unreadable(error.to_string()))?;
    if document.version != LAYOUT_STORE_VERSION {
        return Err(LayoutStoreError::UnsupportedVersion {
            found: document.version,
        });
    }
    Ok(document)
}

pub fn save(path: &Path, document: &LayoutDocument) -> Result<(), LayoutStoreError> {
    if document.hubs.len() > MAX_HUBS {
        return Err(LayoutStoreError::TooMany);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(LayoutStoreError::Io)?;
    }
    let body = serde_json::to_vec_pretty(document)
        .map_err(|error| LayoutStoreError::Unreadable(error.to_string()))?;
    // 임시 파일에 쓰고 갈아끼운다. 그대로 덮어쓰다 죽으면 반쯤 쓰인 JSON 이
    // 남고, 그 폰은 다음 실행부터 묶음을 통째로 못 읽는다.
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, &body).map_err(LayoutStoreError::Io)?;
    fs::rename(&temporary, path).map_err(LayoutStoreError::Io)
}

/// 붙어서 받은 표를 기억한다.
///
/// # 못 받았으면 지우지 않는다
///
/// `layout` 이 `None` 인 것은 **"사이드바가 비었다" 가 아니라 "화면이 아직 안
/// 보냈다"** 는 뜻이다(`dure_hub_protocol::catalog::CatalogLayout` 머리말). 방금
/// 켠 노트북에 붙으면 실제로 이 값이 없이 온다. 그때 기억을 지우면 사용자는
/// 노트북을 켠 순간 자기가 정리한 묶음이 사라지는 것을 본다 — 노트북이 꺼져
/// 있는 동안에는 멀쩡히 보이던 것이.
///
/// # 받았으면 통째로 갈아낀다
///
/// 합치지 않는다. 사이드바에서 지운 세션이 합치기 때문에 폰에 남으면, 지운
/// 사람이 그것을 폰에서 지울 방법이 없다.
pub fn remember(
    document: &mut LayoutDocument,
    hub_id: &str,
    layout: Option<HubLayout>,
) -> Result<(), LayoutStoreError> {
    let Some(layout) = layout else {
        return Ok(());
    };
    if layout.placements.len() > MAX_PLACEMENTS {
        return Err(LayoutStoreError::TooMany);
    }
    if !document.hubs.contains_key(hub_id) && document.hubs.len() >= MAX_HUBS {
        return Err(LayoutStoreError::TooMany);
    }
    document.hubs.insert(hub_id.to_string(), layout);
    Ok(())
}

/// 페어링을 지운 컴퓨터의 표도 지운다. 지운 것이 있었으면 `true`.
///
/// 남겨 두면 사용자가 잊으라고 한 컴퓨터의 구조가 목록을 계속 묶는다.
pub fn forget(document: &mut LayoutDocument, hub_id: &str) -> bool {
    document.hubs.remove(hub_id).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn placement(desktop: &str, project: &str, order: u32) -> Placement {
        Placement {
            desktop: desktop.to_string(),
            project: project.to_string(),
            order,
            branch: None,
        }
    }

    /// 저장했다 읽으면 브랜치가 살아 있어야 한다.
    ///
    /// `#[serde(default)]` 때문에 이 필드가 빠져도 읽기는 성공한다 — 조용히
    /// 사라지는 값이라, 없어진 것을 알아채는 자리는 이 시험뿐이다.
    #[test]
    fn a_remembered_placement_keeps_its_branch() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("layouts.json");
        let mut document = LayoutDocument::default();
        let mut seats = layout("hmux-1", "Workspace");
        seats
            .placements
            .get_mut("hmux-1")
            .expect("방금 넣었다")
            .branch = Some("fix/payment-retry".to_string());
        remember(&mut document, "SHA256:a", Some(seats)).unwrap();

        save(&path, &document).unwrap();

        assert_eq!(
            load(&path).unwrap().hubs["SHA256:a"].placements["hmux-1"]
                .branch
                .as_deref(),
            Some("fix/payment-retry")
        );
    }

    fn layout(session_id: &str, desktop: &str) -> HubLayout {
        HubLayout {
            placements: BTreeMap::from([(
                session_id.to_string(),
                placement(desktop, "agent-ide", 0),
            )]),
            desktop_order: vec![desktop.to_string()],
        }
    }

    #[test]
    fn a_missing_file_is_an_empty_document_not_an_error() {
        let root = tempfile::tempdir().unwrap();
        let document = load(&root.path().join("layouts.json")).expect("없는 것은 오류가 아니다");
        assert!(document.hubs.is_empty());
        assert_eq!(document.version, LAYOUT_STORE_VERSION);
    }

    #[test]
    fn what_is_saved_is_what_is_read_back() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("layouts.json");
        let mut document = LayoutDocument::default();
        remember(&mut document, "SHA256:a", Some(layout("s-1", "Workspace"))).unwrap();

        save(&path, &document).unwrap();

        assert_eq!(load(&path).unwrap(), document);
    }

    /// 이 시험이 이 파일에서 제일 중요하다.
    ///
    /// 방금 켠 노트북에는 화면이 뜨기 전에 붙을 수 있고, 그때 표가 없이 온다.
    /// 그것을 "사이드바가 비었다" 로 읽고 지우면, 사용자는 노트북을 **켠**
    /// 순간 자기가 정리한 묶음이 사라지는 것을 본다.
    #[test]
    fn a_catalog_without_a_layout_leaves_the_memory_alone() {
        let mut document = LayoutDocument::default();
        remember(&mut document, "SHA256:a", Some(layout("s-1", "Workspace"))).unwrap();

        remember(&mut document, "SHA256:a", None).unwrap();

        assert_eq!(
            document.hubs.get("SHA256:a"),
            Some(&layout("s-1", "Workspace"))
        );
    }

    /// 반대쪽. **빈 표**는 "사이드바를 비웠다" 라는 사실이고, 그것은 기억해야
    /// 한다. 이것과 위의 `None` 을 같게 다루면 둘 중 하나가 반드시 틀린다.
    #[test]
    fn an_empty_layout_is_remembered_as_empty() {
        let mut document = LayoutDocument::default();
        remember(&mut document, "SHA256:a", Some(layout("s-1", "Workspace"))).unwrap();

        remember(&mut document, "SHA256:a", Some(HubLayout::default())).unwrap();

        assert_eq!(document.hubs.get("SHA256:a"), Some(&HubLayout::default()));
    }

    /// 사이드바에서 지운 세션이 합치기 때문에 폰에 남으면, 지운 사람이 그것을
    /// 폰에서 지울 방법이 없다.
    #[test]
    fn a_new_layout_replaces_the_old_one_entirely() {
        let mut document = LayoutDocument::default();
        remember(&mut document, "SHA256:a", Some(layout("s-1", "Workspace"))).unwrap();

        remember(&mut document, "SHA256:a", Some(layout("s-2", "Onchain"))).unwrap();

        let stored = document.hubs.get("SHA256:a").unwrap();
        assert!(!stored.placements.contains_key("s-1"));
        assert_eq!(stored.desktop_order, vec!["Onchain".to_string()]);
    }

    /// 노트북 두 대를 페어링한 사람은 사이드바도 두 벌이다. 한 표에 합치면
    /// 나중에 붙은 쪽이 앞의 것을 덮는다.
    #[test]
    fn two_laptops_keep_two_tables() {
        let mut document = LayoutDocument::default();
        remember(&mut document, "SHA256:a", Some(layout("s-1", "Workspace"))).unwrap();
        remember(&mut document, "SHA256:b", Some(layout("s-2", "Onchain"))).unwrap();

        assert_eq!(document.hubs.len(), 2);
        assert_eq!(
            document.hubs["SHA256:a"].desktop_order,
            vec!["Workspace".to_string()]
        );
    }

    /// 남겨 두면 사용자가 잊으라고 한 컴퓨터의 구조가 목록을 계속 묶는다.
    #[test]
    fn forgetting_a_hub_forgets_its_table() {
        let mut document = LayoutDocument::default();
        remember(&mut document, "SHA256:a", Some(layout("s-1", "Workspace"))).unwrap();

        assert!(forget(&mut document, "SHA256:a"));
        assert!(
            !forget(&mut document, "SHA256:a"),
            "두 번째는 지울 것이 없다"
        );
        assert!(document.hubs.is_empty());
    }

    #[test]
    fn the_store_is_bounded_by_hub_count() {
        let mut document = LayoutDocument::default();
        for index in 0..MAX_HUBS {
            remember(
                &mut document,
                &format!("SHA256:{index}"),
                Some(layout("s-1", "Workspace")),
            )
            .unwrap();
        }
        assert!(matches!(
            remember(
                &mut document,
                "SHA256:one-too-many",
                Some(layout("s-1", "Workspace"))
            ),
            Err(LayoutStoreError::TooMany)
        ));
    }

    /// 상한에 닿은 뒤에도 **이미 아는 컴퓨터**의 표는 갱신되어야 한다. 아니면
    /// 그 폰은 다시 페어링을 지우기 전까지 낡은 묶음에 갇힌다.
    #[test]
    fn a_known_hub_updates_even_at_the_ceiling() {
        let mut document = LayoutDocument::default();
        for index in 0..MAX_HUBS {
            remember(
                &mut document,
                &format!("SHA256:{index}"),
                Some(layout("s-1", "Workspace")),
            )
            .unwrap();
        }

        remember(&mut document, "SHA256:0", Some(layout("s-9", "Onchain"))).unwrap();

        assert_eq!(
            document.hubs["SHA256:0"].desktop_order,
            vec!["Onchain".to_string()]
        );
    }

    /// 표 크기는 저쪽이 정한다. 폰의 디스크가 저쪽이 보낸 크기만큼 자라면 안 된다.
    #[test]
    fn one_table_is_bounded_too() {
        let mut oversized = HubLayout::default();
        for index in 0..=MAX_PLACEMENTS {
            oversized
                .placements
                .insert(format!("s-{index}"), placement("Workspace", "agent-ide", 0));
        }
        assert!(matches!(
            remember(&mut LayoutDocument::default(), "SHA256:a", Some(oversized)),
            Err(LayoutStoreError::TooMany)
        ));
    }

    /// 캐시 하나가 깨졌다고 묶음 기능이 영영 죽으면 안 된다. 진실은 노트북에
    /// 있고, 이 폰은 다음 연결에서 전부 다시 받는다.
    #[test]
    fn an_unreadable_file_starts_over_instead_of_locking_the_feature() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("layouts.json");
        fs::write(&path, b"{ this is not json").unwrap();

        assert!(matches!(load(&path), Err(LayoutStoreError::Unreadable(_))));
        assert!(load_or_reset(&path).unwrap().hubs.is_empty());
    }

    /// 더 새 빌드가 쓴 멀쩡한 파일이다. 조용히 덮어쓰면 되돌리는 날 무엇을
    /// 잃었는지 아무도 모른다 — 깨진 파일과 같게 다루지 않는다.
    #[test]
    fn a_newer_version_is_not_reset_even_by_the_forgiving_read() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("layouts.json");
        fs::write(&path, br#"{"version":999,"hubs":{}}"#).unwrap();

        assert!(matches!(
            load_or_reset(&path),
            Err(LayoutStoreError::UnsupportedVersion { found: 999 })
        ));
    }

    #[test]
    fn an_unknown_version_is_named_rather_than_silently_reset() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("layouts.json");
        fs::write(&path, br#"{"version":999,"hubs":{}}"#).unwrap();

        assert!(matches!(
            load(&path),
            Err(LayoutStoreError::UnsupportedVersion { found: 999 })
        ));
    }

    /// 반쯤 쓰인 파일을 남기지 않는다.
    #[test]
    fn saving_leaves_no_temporary_file_behind() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("layouts.json");
        let mut document = LayoutDocument::default();
        remember(&mut document, "SHA256:a", Some(layout("s-1", "Workspace"))).unwrap();

        save(&path, &document).unwrap();

        assert!(path.is_file());
        assert!(!path.with_extension("json.tmp").exists());
    }

    /// 같은 내용의 표는 언제나 같은 바이트로 저장된다.
    ///
    /// 넣은 순서를 뒤집어서 만드는 것이 요점이다. `HashMap` 이면 두 표는 서로
    /// 다른 순서로 직렬화되고(인스턴스마다 해시 씨앗이 다르다), 그러면 저쪽이
    /// 같은 사이드바를 다시 보내기만 해도 폰은 파일을 다시 쓴다. 한 번 만든 맵을
    /// 두 번 직렬화하는 시험은 `HashMap` 으로도 통과하므로 아무것도 잡지 않는다.
    #[test]
    fn the_same_table_serializes_the_same_way_regardless_of_insertion_order() {
        let mut forward = HubLayout::default();
        for index in 0..64 {
            forward.placements.insert(
                format!("s-{index}"),
                placement("Workspace", "agent-ide", index),
            );
        }
        let mut backward = HubLayout::default();
        for index in (0..64).rev() {
            backward.placements.insert(
                format!("s-{index}"),
                placement("Workspace", "agent-ide", index),
            );
        }

        assert_eq!(
            serde_json::to_vec(&forward).unwrap(),
            serde_json::to_vec(&backward).unwrap()
        );
    }
}
