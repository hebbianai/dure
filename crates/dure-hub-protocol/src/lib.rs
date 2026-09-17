//! 폰과 Dure 허브가 **같은 바이트를 뜻하고 같은 TLS 스트림을 나누게** 하는 곳.
//!
//! 이 크레이트에는 판단이 없다. 등록된 기기가 누구인지, 인증서가 믿을 만한지,
//! 어떤 세션을 보여줄지는 각 쪽이 정한다. 여기 있는 것은 그 판단이 오가는
//! **문서의 모양**뿐이다.
//!
//! # 왜 따로 있나
//!
//! 폰은 `src-tauri` 에 의존할 수 없다. 그것은 데스크탑 Tauri 앱이고, 링크하면
//! hmux 로컬 런타임 세계가 통째로 폰 빌드에 딸려 온다 — `mobile/src-tauri` 가
//! `default-features = false` 로 막고 있는 바로 그것이다.
//!
//! 남는 선택지는 둘이었다: 폰에 와이어 포맷을 한 벌 더 쓰거나, 양쪽이 링크하는
//! 크레이트로 빼거나. 이 저장소는 전자의 값을 이미 치렀다 —
//! `mobile/src-tauri/src/offline_pairing.rs` 머리말이 적어 둔 2026-07-29 사고에서
//! 강제 명령 문자열이 두 벌이었고, 두 벌이 갈렸다는 사실은 Tailscale 호스트에서만
//! 드러났다. 필드 순서 하나가 갈리면 QR 이 열리지 않고, 그 사실은 책상에서 폰을
//! 들고서야 보인다.
//!
//! # 무엇이 여기 없나
//!
//! - **기기 인증** — 토큰 비교는 등록된 목록을 아는 쪽(`src-tauri/src/hub`)의 것.
//! - **인증서와 지문 계산** — 기계의 신원이고, 개인키를 쥔 쪽에만 있어야 한다.
//! - **`SessionDescriptor` → [`catalog::HubCatalogEntry`] 변환** — hmux 타입을
//!   아는 쪽에 남는다. 폰은 hmux 서술자를 링크하지 않는다.
//!
//! 셋 다 "이 문서를 만들거나 받아들일 자격" 에 관한 것이고, 자격은 문서와 같은
//! 곳에 두지 않는다. [`tls`]도 암호 설정이나 인증 판단은 하지 않고, 이미 인증된
//! rustls 스트림을 읽기/쓰기 절반으로 기계적으로 나누기만 한다.

pub mod catalog;
pub mod file_diff;
pub mod fingerprint;
pub mod folder_browser;
pub mod frame;
pub mod git_status;
pub mod hello;
pub mod launch_offer;
pub mod offer;
pub mod push;
pub mod relay;
pub mod session_file;
pub mod start_agent;
pub mod tls;

pub use catalog::{HUB_CATALOG_VERSION, HubCatalog, HubCatalogEntry, UnreachableBox};
pub use file_diff::{HUB_FILE_DIFF_VERSION, HubFileDiffResult};
pub use folder_browser::{FolderEntry, HUB_FOLDER_BROWSER_VERSION, HubFolderBrowserResult};
pub use frame::{FrameError, MAX_CATALOG_BYTES, MAX_HELLO_BYTES};
pub use git_status::{
    BranchFacts, GitBranch, GitChecks, GitCommit, GitFileChange, GitReview, GitReviewer,
    HUB_GIT_STATUS_VERSION, HubGitStatusResult,
};
pub use hello::{HUB_HELLO_VERSION, HubHello, HubHelloAck, HubRequest};
pub use offer::{HubOffer, OfferError, PAIRING_SCHEME};
