//! 네트워크 왕복 없는 QR(v2)로 페어링하는 폰 쪽 절반.
//!
//! v1은 QR이 `host:port`를 적어주고 폰이 거기로 붙어 토큰을 증명한다 —
//! 같은 와이파이의 책상에서만 되는 일이다. v2는 노트북이 키쌍을 만들고 공개
//! 절반을 각 서버에 직접 설치한 뒤, 개인 절반과 서버 목록을 QR에 봉인한다.
//! 이 모듈은 그 QR을 연다. 어떤 소켓도 열지 않는다.
//!
//! # 봉인/해제 구현을 여기 두지 않는 이유
//!
//! [`hmux_client::offline_pairing`]에 있고 노트북도 같은 것을 쓴다. KDF 비용,
//! 필드 순서, 코드 정규화 규칙 중 하나라도 두 곳에서 갈리면 QR이 열리지 않고,
//! 그 사실은 책상에서 폰을 들고서야 드러난다. 2026-07-29에 이 저장소가 이미
//! 그 대가를 치렀다 — 강제 명령 문자열이 두 벌이었고 Tailscale 호스트에서만
//! 터졌다.
//!
//! # 왜 저장은 v1과 같은 경로인가
//!
//! 키를 서버 id마다 저장하고 서버를 채택하는 것은 [`crate::identity_store`]와
//! [`crate::server_store`]가 하던 그대로다. v2가 바꾸는 것은 키가 **어디서
//! 오는지**뿐이다: v1은 이 기기가 만들어 공개키를 보냈고, v2는 노트북이 만들어
//! 개인키를 QR로 건넨다. 그 뒤의 저장 규칙 — 서버 하나를 지워도 나머지 접근이
//! 사라지지 않게 서버별로 쓴다 — 은 같은 이유로 같다.

use crate::device_key;
use crate::identity_store::{self, KeyRole};
use crate::server_store::{self, KeyConfinement, ServerEntry, CONFINEMENT_FORCED_COMMAND};
use hmux_client::offline_pairing::{
    self, OfflineHost, OfflinePairingContents, OfflinePairingError, CODE_LENGTH,
};
use serde::Serialize;

/// 스캔한 텍스트가 v2 페이로드인지.
///
/// 화면이 코드 입력을 띄울지 말지 정하는 데 쓴다. 여기서 여는 것이 아니라
/// **어느 흐름인지만** 판별한다 — v1 QR을 스캔한 사람에게 코드를 물으면 답이
/// 없는 질문이 되고, v2 QR을 v1으로 다루면 "노트북에 연결할 수 없습니다"라는
/// 틀린 진단이 나온다.
#[must_use]
pub fn is_offline_payload(scanned: &str) -> bool {
    scanned
        .trim_start()
        .starts_with(offline_pairing::PAYLOAD_SCHEME)
}

/// 사용자가 입력한 코드를 정규화한다. 코드가 될 수 없으면 `None`.
///
/// 화면이 64MiB 유도를 걸기 *전에* 부르라고 노출한다. 여섯 글자가 아니거나
/// 알파벳 밖의 문자가 있으면 유도는 어차피 실패하고, 그 0.2초는 사용자가 오타를
/// 알아차리는 데 쓰는 게 낫다.
#[must_use]
pub fn normalize_code(typed: &str) -> Option<String> {
    offline_pairing::normalize_code(typed)
}

/// 코드 길이. 화면이 입력 칸을 그리는 데 쓴다.
#[must_use]
pub fn code_length() -> usize {
    CODE_LENGTH
}

/// QR이 담고 있었지만 쓸 수 없는 서버.
///
/// 이름을 밝힌다 — 목록에서 조용히 사라진 서버는 없는 서버로 읽히고, 주인이
/// 책상에 온 이유가 그 서버일 수 있다. v1의 `RefusedHost`와 같은 모양을 쓰는
/// 이유는 화면이 두 흐름을 한 코드로 그리기 때문이다.
#[derive(Debug, Serialize)]
pub struct RefusedOfflineHost {
    pub label: String,
    pub host: String,
    pub detail: String,
}

/// 열린 페이로드를 이 기기의 저장소에 반영한다.
///
/// 순수 함수로 분리한 이유: 어떤 서버를 채택하고 무엇을 거부하는지는 파일
/// 시스템 없이 검사할 수 있어야 하고, 그 판단이 이 흐름에서 가장 틀리기 쉬운
/// 부분이다.
#[must_use]
pub fn plan(contents: &OfflinePairingContents) -> OfflinePlan {
    let mut adopt = Vec::new();
    let mut refused = Vec::new();
    for host in &contents.hosts {
        match refusal_for(host) {
            Some(detail) => refused.push(RefusedOfflineHost {
                label: display_label(host),
                host: host.host.clone(),
                detail,
            }),
            None => adopt.push(to_entry(host)),
        }
    }
    OfflinePlan { adopt, refused }
}

#[derive(Debug)]
pub struct OfflinePlan {
    pub adopt: Vec<ServerEntry>,
    pub refused: Vec<RefusedOfflineHost>,
}

fn display_label(host: &OfflineHost) -> String {
    if host.label.trim().is_empty() {
        host.host.clone()
    } else {
        host.label.clone()
    }
}

/// 이 항목을 쓸 수 없는 이유, 없으면 `None`.
///
/// 지문이 없거나 모양이 다른 항목을 거부한다. 고정되지 않은 호스트는
/// `relay::ssh_config`가 어차피 거부하므로, 채택해 두면 목록에 있으면서 누를
/// 때마다 실패하는 줄이 된다 — 아예 못 받는 것보다 나쁘다.
fn refusal_for(host: &OfflineHost) -> Option<String> {
    if host.id.trim().is_empty() {
        return Some("서버 id가 비어 있습니다".into());
    }
    if host.host.trim().is_empty() {
        return Some("서버 주소가 비어 있습니다".into());
    }
    if host.username.trim().is_empty() {
        return Some("서버 계정이 비어 있습니다".into());
    }
    if host.port == 0 {
        return Some("서버 포트가 0입니다".into());
    }
    if !host.host_key_fingerprint.starts_with("SHA256:")
        || host.host_key_fingerprint.len() <= "SHA256:".len()
    {
        return Some(
            "호스트 키 지문이 없습니다 — 고정할 것이 없으면 이 기기는 연결하지 않습니다".into(),
        );
    }
    None
}

fn to_entry(host: &OfflineHost) -> ServerEntry {
    ServerEntry {
        id: host.id.clone(),
        label: display_label(host),
        host: host.host.trim().to_string(),
        port: host.port,
        username: host.username.trim().to_string(),
        host_key_fingerprint: host.host_key_fingerprint.trim().to_string(),
        paired: true,
        // 노트북이 강제 명령으로 심었다는 *의도*. 서버에서 실제로 적용됐는지는
        // 첫 목록 조회가 관측해 알려주고, 화면은 관측을 우선한다 — Tailscale
        // SSH 호스트에서는 이 의도가 사실이 아니다.
        attach_key_confinement: KeyConfinement(CONFINEMENT_FORCED_COMMAND.to_string()),
    }
}

/// QR과 코드로 페어링을 끝낸다.
///
/// 실패는 셋으로 나뉘고 각각 사용자가 할 일이 다르다: 이 QR이 v2가 아니다,
/// 코드가 맞지 않는다, 열렸는데 내용이 못 쓸 것이다.
pub fn complete(
    payload: &str,
    typed_code: &str,
    key_root: &std::path::Path,
    store_path: &std::path::Path,
) -> Result<(OfflinePlan, [u8; 32]), OfflinePairingError> {
    let contents = offline_pairing::open(payload, typed_code)?;
    let plan = plan(&contents);
    let seed = contents.private_key_seed;

    // 서버가 하나도 없으면 저장하지 않는다. 키만 남기고 서버는 없는 상태는
    // 화면에서 "페어링됨"으로 보이면서 아무 데도 못 붙는다.
    if plan.adopt.is_empty() {
        return Ok((plan, seed));
    }

    let pem = device_key::openssh_private_key_from_seed(&seed)
        .map_err(|_| OfflinePairingError::MalformedContents("QR 안의 키를 쓸 수 없습니다"))?;
    for entry in &plan.adopt {
        // 서버별로 쓴다. 한 파일을 공유하면 서버 하나를 지울 때 나머지 접근이
        // 함께 사라진다 — v1이 같은 이유로 같게 한다.
        identity_store::store(key_root, &entry.id, KeyRole::Attach, &pem)
            .map_err(|error| OfflinePairingError::MalformedContents(store_failure(error)))?;
    }
    server_store::adopt(store_path, plan.adopt.clone())
        .map_err(|error| OfflinePairingError::MalformedContents(adopt_failure(error)))?;
    Ok((plan, seed))
}

/// 저장 실패를 페이로드 오류 어휘로 옮긴다.
///
/// `&'static str`만 담을 수 있는 자리라 이유를 갈래로만 남긴다 — 원문은 호출부가
/// 로그로 남기고, 화면은 "기기에 저장하지 못했습니다"를 본다. 이 변환이 정보를
/// 잃는 것은 사실이고, 그래서 여기 적어 둔다.
fn store_failure(_error: identity_store::IdentityStoreError) -> &'static str {
    "이 기기에 키를 저장하지 못했습니다"
}

fn adopt_failure(_error: server_store::ServerStoreError) -> &'static str {
    "이 기기에 서버 목록을 저장하지 못했습니다"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(overrides: impl FnOnce(&mut OfflineHost)) -> OfflineHost {
        let mut host = OfflineHost {
            id: "gate1".into(),
            label: "Gate1".into(),
            host: "192.0.2.10".into(),
            port: 22,
            username: "gate1".into(),
            host_key_fingerprint: "SHA256:abcdefghijklmnop".into(),
        };
        overrides(&mut host);
        host
    }

    #[test]
    fn a_v2_payload_is_recognised_and_a_v1_one_is_not() {
        assert!(is_offline_payload("hmux-pair:2?s=AAAA&c=BBBB"));
        assert!(is_offline_payload("  hmux-pair:2?s=AAAA&c=BBBB"));

        // v1 QR 을 v2 로 다루면 "코드를 입력하세요"라고 묻게 되고, 그 QR 에는
        // 코드가 없다.
        assert!(!is_offline_payload(
            "hmux-pair:1?a=192.0.2.10&p=47823&t=abc"
        ));
        assert!(!is_offline_payload("https://example.com"));
        assert!(!is_offline_payload(""));
    }

    #[test]
    fn a_well_formed_host_is_adopted() {
        let contents = OfflinePairingContents {
            private_key_seed: [1u8; 32],
            hosts: vec![host(|_| {})],
        };

        let plan = plan(&contents);

        assert_eq!(plan.adopt.len(), 1);
        assert!(plan.refused.is_empty());
        assert_eq!(plan.adopt[0].id, "gate1");
        assert!(plan.adopt[0].paired);
    }

    /// 고정할 지문이 없으면 `relay::ssh_config`가 어차피 거부한다. 채택해 두면
    /// 목록에 있으면서 누를 때마다 실패하는 줄이 되고, 그건 아예 못 받는 것보다
    /// 나쁘다.
    #[test]
    fn a_host_with_no_pinnable_fingerprint_is_refused_by_name() {
        for fingerprint in ["", "SHA256:", "MD5:ab:cd", "abcdef"] {
            let contents = OfflinePairingContents {
                private_key_seed: [1u8; 32],
                hosts: vec![host(|h| h.host_key_fingerprint = fingerprint.into())],
            };

            let plan = plan(&contents);

            assert!(plan.adopt.is_empty(), "{fingerprint:?}");
            assert_eq!(plan.refused.len(), 1, "{fingerprint:?}");
            // 이름을 밝힌다 — 조용히 사라진 서버는 없는 서버로 읽힌다.
            assert_eq!(plan.refused[0].label, "Gate1");
            assert!(plan.refused[0].detail.contains("지문"));
        }
    }

    #[test]
    fn the_other_malformed_shapes_are_refused_too() {
        for (mutate, expected) in [
            (
                Box::new(|h: &mut OfflineHost| h.id = "  ".into())
                    as Box<dyn FnOnce(&mut OfflineHost)>,
                "id",
            ),
            (Box::new(|h: &mut OfflineHost| h.host = "".into()), "주소"),
            (
                Box::new(|h: &mut OfflineHost| h.username = "".into()),
                "계정",
            ),
            (Box::new(|h: &mut OfflineHost| h.port = 0), "포트"),
        ] {
            let contents = OfflinePairingContents {
                private_key_seed: [1u8; 32],
                hosts: vec![host(mutate)],
            };

            let plan = plan(&contents);

            assert!(plan.adopt.is_empty(), "{expected}");
            assert!(plan.refused[0].detail.contains(expected), "{expected}");
        }
    }

    /// 라벨이 없는 서버가 목록에서 빈 줄이 되면 사용자는 무엇을 누르는지 모른다.
    #[test]
    fn a_host_with_no_label_falls_back_to_its_address() {
        let contents = OfflinePairingContents {
            private_key_seed: [1u8; 32],
            hosts: vec![host(|h| h.label = "   ".into())],
        };

        let plan = plan(&contents);

        assert_eq!(plan.adopt[0].label, "192.0.2.10");
    }

    /// 나머지가 멀쩡하면 하나가 못 쓸 것이어도 페어링은 진행된다. 전부-또는-전무로
    /// 두면 지문 하나가 빠진 QR이 쓸 수 있는 서버까지 못 쓰게 만든다.
    #[test]
    fn one_unusable_host_does_not_refuse_the_rest() {
        let contents = OfflinePairingContents {
            private_key_seed: [1u8; 32],
            hosts: vec![
                host(|h| h.id = "good".into()),
                host(|h| {
                    h.id = "bad".into();
                    h.host_key_fingerprint = "".into();
                }),
            ],
        };

        let plan = plan(&contents);

        assert_eq!(plan.adopt.len(), 1);
        assert_eq!(plan.adopt[0].id, "good");
        assert_eq!(plan.refused.len(), 1);
    }

    /// 유도 비용을 치르기 전에 오타를 잡는다.
    #[test]
    fn a_code_that_cannot_be_one_is_rejected_before_the_kdf() {
        assert!(normalize_code("K7F2Q").is_none());
        assert!(normalize_code("K7F2QXX").is_none());
        assert!(normalize_code("K7F2Q!").is_none());
        // 사람이 화면을 보고 치는 방식은 통과한다.
        assert_eq!(normalize_code("k7f2-q0").as_deref(), Some("K7F2Q0"));
        assert_eq!(code_length(), 6);
    }

    /// 이 모듈이 존재하는 이유 전체를 한 테스트로.
    ///
    /// 노트북이 봉인한 것을 이 기기가 열고, 키를 서버별로 저장하고, 서버를
    /// 채택하는지. 봉인은 `hmux-client`의 같은 함수로 하므로 이 왕복이 통과하면
    /// 두 쪽이 같은 구현을 쓴다는 뜻이다 — KDF 비용이나 필드 순서가 갈렸다면
    /// 여기서 열리지 않는다.
    #[test]
    fn what_the_laptop_seals_this_device_opens_and_stores() {
        use hmux_client::offline_pairing::seal;

        let contents = OfflinePairingContents {
            private_key_seed: [7u8; 32],
            hosts: vec![
                host(|h| h.id = "gate1".into()),
                host(|h| {
                    h.id = "clink".into();
                    h.label = "Clink".into();
                    h.host = "server-b.example.com".into();
                    h.username = "ubuntu".into();
                }),
            ],
        };
        let code = "K7F2QX";
        let payload = seal(&contents, code, &[3u8; 16], &[5u8; 24]).expect("노트북이 봉인한다");

        let keys = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let store_path = store.path().join("servers.json");

        let (plan, seed) =
            complete(&payload, code, keys.path(), &store_path).expect("이 기기가 연다");

        assert_eq!(plan.adopt.len(), 2);
        assert!(plan.refused.is_empty());
        assert_eq!(seed, [7u8; 32]);

        // 서버별로 키가 있다. 한 파일을 공유하면 서버 하나를 지울 때 나머지
        // 접근이 함께 사라진다.
        for id in ["gate1", "clink"] {
            let stored = identity_store::load(keys.path(), id, KeyRole::Attach)
                .unwrap_or_else(|error| panic!("{id}: {error}"));
            assert!(stored.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        }

        // 두 서버의 키는 같은 개인키다 — 노트북이 하나를 만들어 모든 서버에
        // 같은 공개키를 심었기 때문이다.
        let first = identity_store::load(keys.path(), "gate1", KeyRole::Attach).unwrap();
        let second = identity_store::load(keys.path(), "clink", KeyRole::Attach).unwrap();
        assert_eq!(first, second);

        let document = server_store::load(&store_path).expect("서버 목록이 저장됐다");
        let ids: Vec<&str> = document.servers.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&"gate1") && ids.contains(&"clink"), "{ids:?}");
    }

    /// QR만 가진 사람은 아무것도 얻지 못한다. 이 성질이 v2 설계 전체를 지탱한다.
    #[test]
    fn the_qr_without_the_code_stores_nothing() {
        use hmux_client::offline_pairing::seal;

        let contents = OfflinePairingContents {
            private_key_seed: [9u8; 32],
            hosts: vec![host(|_| {})],
        };
        let payload = seal(&contents, "K7F2QX", &[3u8; 16], &[5u8; 24]).expect("봉인");

        let keys = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let store_path = store.path().join("servers.json");

        let error = complete(&payload, "K7F2QY", keys.path(), &store_path)
            .expect_err("틀린 코드는 열지 못한다");

        assert!(matches!(error, OfflinePairingError::WrongCodeOrTampered));
        // 실패한 시도가 키나 서버를 남기지 않는다. 남으면 화면이 "페어링됨"으로
        // 보이면서 아무 데도 못 붙는다.
        assert!(identity_store::load(keys.path(), "gate1", KeyRole::Attach).is_err());
        assert!(!store_path.exists());
    }
}
