//! 책상에서 폰에게 건네는 것 — QR 이 나르는 문서.
//!
//! # 왜 `hmux-pair:` 가 아닌가
//!
//! 이름이 비슷하다고 같은 것이 아니다. `hmux-pair:1` 은 SSH 서버의 주소와
//! 호스트 키를, `hmux-pair:2` 는 그것을 코드로 봉한 것을 담는다 — 둘 다 sshd 가
//! 저쪽에 있다는 것을 전제한다. 여기에는 sshd 가 없다. 폰은 앱이 띄운 TLS
//! 리스너에 붙고, 신뢰의 출발점은 호스트 키가 아니라 인증서 지문이다.
//!
//! 게다가 `hmux-client::offline_pairing` 의 주석은 `hmux-pair:3` 을 **그 방식의
//! 다음 매개변수 집합**을 위해 이미 예약해 두었다. 거기에 다른 전송을 끼워
//! 넣으면 판 번호가 두 가지를 뜻하게 된다.
//!
//! 그래서 다른 이름공간이다: `dure-hub:1`. 폰은 접두만 보고 어느 길로 갈지
//! 정할 수 있다.
//!
//! # 왜 base64(JSON) 한 덩이인가
//!
//! 지문은 `SHA256:<표준 base64>` 라 `+` 와 `/` 를 담는다. 질의 문자열에 그대로
//! 넣으면 `+` 를 공백으로 읽는 파서가 있고, 그때 폰은 **형식은 맞고 값이 틀린**
//! 지문을 고정한다 — 붙지 않는 것으로 끝나면 다행이고, 파서가 관대하면 아무
//! 기계나 받아들이는 쪽으로 틀어진다. 한 덩이로 감싸면 그 부류가 통째로 사라진다.
//!
//! 나중에 항목이 늘어나는 것도 값싸진다. 릴레이 전송이 더할
//! `relay_endpoint`/`server_id` 가 그 경우인데, 그것은 **판을 올린다**
//! (`dure-hub:2`) — 옛 폰은 모르는 필드를 무시할 수 있지만 릴레이로 갈 줄은
//! 모르고, 무시한 채 붙어서 실패하면 "QR 이 잘못됐다" 로 읽힌다. 직접 서버
//! 초대를 더한 `dure-hub:3`도 같은 이유로 판을 올린다. 설계는
//! `crates/dure-relay/src/lib.rs`.

use crate::frame::FrameError;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

// 지문의 모양과 계산은 [`crate::fingerprint`] 하나가 소유한다. 여기서 다시
// 정의하면 QR 을 검사하는 규칙과 붙을 때 비교하는 규칙이 갈릴 수 있고, 그 둘이
// 갈리면 스캔은 되는데 접속만 안 되는 상태가 된다.
pub use crate::fingerprint::is_fingerprint;

/// 이 빌드가 **만드는** 판.
///
/// 직접 서버 페어링 초대를 나르기 시작하면서 올렸다. 옛 폰이 필드를 무시하면
/// 노트북이 꺼진 뒤 원격 서버까지 함께 끊기므로, 판을 올려 업데이트를 요구한다.
pub const PAIRING_SCHEME: &str = "dure-hub:3";

/// 직접 SSH/Tailscale 페어링 초대를 싣기 전 판. **읽기만 한다.**
pub const PAIRING_SCHEME_V2: &str = "dure-hub:2";

/// 릴레이 이전의 판. **읽기만 한다.**
///
/// 새 폰이 옛 노트북의 QR 을 스캔하는 것은 정상적인 상황이다 — 업데이트 순서를
/// 사용자가 고르지 않는다. 그 QR 에는 릴레이 주소가 없으므로 직결만 가능하고,
/// 화면이 그렇게 말하면 된다.
pub const PAIRING_SCHEME_V1: &str = "dure-hub:1";

/// 판을 뺀 이름. **흐름을 고르는 것은 이쪽이다.**
///
/// 판까지 붙여서 고르면, 릴레이 전송이 더할 `dure-hub:2` QR 을 옛 앱이 "이 앱의
/// 페어링 코드가 아닙니다" 로 읽는다 — 사용자는 QR 이 잘못된 줄 알고 다시
/// 만들러 간다. 정작 필요한 문장은 "앱이 낡았습니다" 다. `hmux-pair:` 를
/// 따로 알아보는 이유와 같은 이유이고, 같은 종류의 오진이다.
pub const PAIRING_NAMESPACE: &str = "dure-hub:";

/// SSH 쪽 페어링 코드의 접두. 사람이 잘못된 QR 을 스캔하는 것은 흔하고, 그때
/// "형식이 틀렸다" 보다 "그건 다른 페어링입니다" 가 쓸모 있다.
const SSH_PAIRING_PREFIX: &str = "hmux-pair:";

/// 폰이 받아 가는 것 전부.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HubOffer {
    /// 붙을 곳. `호스트:포트`.
    pub endpoint: String,
    /// 고정할 인증서 지문. 이 값이 이 페이로드의 요점이다 — 나머지는 없어도
    /// 다시 물어볼 수 있지만, 이것이 틀리면 폰은 엉뚱한 기계를 믿는다.
    pub fingerprint: String,
    /// 이 폰 전용 토큰.
    pub token: String,
    /// 이 컴퓨터의 이름. 폰의 서버 목록에 이 이름으로 뜬다. 기기 이름이 아니다 —
    /// 기기 이름은 노트북 쪽 목록에 남는다.
    pub box_label: String,
    /// 릴레이의 주소. 같은 와이파이 밖에서 이 컴퓨터에 닿는 유일한 길이다.
    ///
    /// 없을 수 있다: 릴레이를 끈 노트북, 그리고 `dure-hub:1` QR. 없으면 폰은
    /// 직결만 시도하고, 화면이 "같은 네트워크에서만 연결됩니다" 를 말한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay_endpoint: Option<String>,
    /// 릴레이에서 이 컴퓨터를 찾는 이름. [`Self::relay_endpoint`] 와 함께 온다.
    ///
    /// 인증서 지문이 아니다 — 지문을 주소로 쓰면 인증서를 회전하는 순간 이
    /// QR 로 페어링한 폰 전부가 길을 잃는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    /// 이 폰이 노트북과 무관하게 SSH/Tailscale 서버에 붙게 하는 기존 온라인 초대.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direct_pairing_payload: Option<String>,
}

/// 토큰을 찍지 않는다. [`crate::hello::HubHello`] 와 같은 이유다.
impl std::fmt::Debug for HubOffer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HubOffer")
            .field("endpoint", &self.endpoint)
            .field("fingerprint", &self.fingerprint)
            .field("token", &"<가려짐>")
            .field("box_label", &self.box_label)
            .finish()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum OfferError {
    /// 이 앱의 페어링 페이로드가 아니다.
    NotAnOffer,
    /// SSH 쪽 페어링 코드다. 다른 흐름이다.
    SshPairing,
    /// 이 앱의 페어링 코드이긴 한데, 이 빌드가 모르는 판이다.
    NewerVersion,
    Malformed(&'static str),
}

impl std::fmt::Display for OfferError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAnOffer => write!(
                formatter,
                "이 앱의 페어링 코드가 아닙니다 ({PAIRING_SCHEME} 로 시작해야 합니다)"
            ),
            Self::SshPairing => write!(
                formatter,
                "이건 SSH 서버 페어링 코드입니다. 이 컴퓨터에 연결하려면 설정의 \
                 '폰 연결' 화면에 뜬 QR 을 스캔하세요"
            ),
            Self::NewerVersion => write!(
                formatter,
                "이 페어링 코드는 더 새로운 앱이 필요합니다. 앱을 업데이트하세요"
            ),
            Self::Malformed(detail) => {
                write!(formatter, "페어링 코드를 읽을 수 없습니다: {detail}")
            }
        }
    }
}

impl std::error::Error for OfferError {}

impl From<FrameError> for OfferError {
    fn from(_: FrameError) -> Self {
        Self::Malformed("본문이 이 판의 JSON 이 아닙니다")
    }
}

/// 폰에게 보여줄 문자열.
#[must_use]
pub fn encode(offer: &HubOffer) -> String {
    let body = serde_json::to_vec(offer).expect("HubOffer 는 언제나 직렬화된다");
    format!(
        "{PAIRING_SCHEME}?o={}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body)
    )
}

/// 폰이 스캔한 것을 읽는다.
///
/// 읽은 뒤 값을 검사한다. 형식만 맞고 지문이 비어 있는 페이로드를 통과시키면
/// 폰은 아무것도 고정하지 않은 채 붙고, 그 상태에서는 아무 기계나 이 컴퓨터인
/// 척할 수 있다 — 페어링이 하는 일이 정확히 그것을 막는 것이다.
pub fn decode(text: &str) -> Result<HubOffer, OfferError> {
    let text = text.trim();
    if text.starts_with(SSH_PAIRING_PREFIX) {
        return Err(OfferError::SshPairing);
    }
    if !text.starts_with(PAIRING_NAMESPACE) {
        return Err(OfferError::NotAnOffer);
    }
    // 이 빌드가 읽는 판 전부를 시도한다. 어느 것도 아니면 이름공간은 맞으나
    // 판이 새로운 것 — 이 앱의 코드이되 이 빌드가 못 읽는다.
    let (scheme, encoded) = [PAIRING_SCHEME, PAIRING_SCHEME_V2, PAIRING_SCHEME_V1]
        .iter()
        .find_map(|scheme| {
            text.strip_prefix(*scheme)
                .and_then(|rest| rest.strip_prefix("?o="))
                .map(|encoded| (*scheme, encoded))
        })
        .ok_or(OfferError::NewerVersion)?;

    let body = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| OfferError::Malformed("본문이 base64 가 아닙니다"))?;
    let offer: HubOffer = serde_json::from_slice(&body)
        .map_err(|_| OfferError::Malformed("본문이 이 판의 JSON 이 아닙니다"))?;

    validate(&offer)?;
    if scheme == PAIRING_SCHEME && offer.direct_pairing_payload.is_none() {
        return Err(OfferError::Malformed("직접 서버 페어링 초대가 없습니다"));
    }
    Ok(offer)
}

/// 스캔한 것이 이 흐름의 QR 인지. 화면이 어느 길로 보낼지 정하는 데 쓴다.
///
/// 여기서 여는 것이 아니라 **어느 흐름인지만** 판별한다 — `hmux-pair:` 를
/// 스캔한 사람에게 이 흐름의 오류를 보여주면 QR 이 잘못된 것으로 읽힌다.
#[must_use]
pub fn is_hub_offer(text: &str) -> bool {
    text.trim().starts_with(PAIRING_NAMESPACE)
}

fn validate(offer: &HubOffer) -> Result<(), OfferError> {
    if split_endpoint(&offer.endpoint).is_none() {
        return Err(OfferError::Malformed("주소가 호스트:포트 모양이 아닙니다"));
    }
    if !is_fingerprint(&offer.fingerprint) {
        return Err(OfferError::Malformed(
            "인증서 지문이 없거나 모양이 다릅니다",
        ));
    }
    if offer.token.is_empty() {
        return Err(OfferError::Malformed("기기 토큰이 비어 있습니다"));
    }
    // 릴레이 주소와 `server_id` 는 **둘 다 있거나 둘 다 없어야** 한다. 하나만
    // 있으면 폰은 릴레이로 갈 수 있다고 믿고 갈 곳이나 부를 이름 중 하나를
    // 모르는 상태가 된다 — 그 실패는 밖에 나가서야 드러난다.
    match (&offer.relay_endpoint, &offer.server_id) {
        (Some(endpoint), Some(server_id)) => {
            if split_endpoint(endpoint).is_none() {
                return Err(OfferError::Malformed(
                    "릴레이 주소가 호스트:포트 모양이 아닙니다",
                ));
            }
            if server_id.is_empty() {
                return Err(OfferError::Malformed("릴레이 서버 id 가 비어 있습니다"));
            }
        }
        (None, None) => {}
        _ => {
            return Err(OfferError::Malformed(
                "릴레이 주소와 서버 id 중 하나만 있습니다",
            ));
        }
    }
    if let Some(payload) = &offer.direct_pairing_payload {
        if !payload.starts_with("hmux-pair:1?") {
            return Err(OfferError::Malformed(
                "직접 서버 페어링 초대가 온라인 코드가 아닙니다",
            ));
        }
    }
    Ok(())
}

/// `호스트:포트` 를 가른다.
///
/// **폰의 다이얼러도 이 함수를 쓴다.** 두 벌로 두면 QR 이 받아들인 주소를
/// 다이얼러가 거부하거나(붙지 않는다) 그 반대가 되고, 어느 쪽이든 "스캔은
/// 됐는데 연결만 안 되는" 상태다. 이 크레이트가 존재하는 이유가 그것이다.
///
/// `rsplit_once`: 뒤에서 자른다. 앞에서 자르면 `[fe80::1]:47823` 이 첫 콜론에서
/// 갈리고, IPv6 주소가 통째로 거부된다.
#[must_use]
pub fn split_endpoint(endpoint: &str) -> Option<(&str, u16)> {
    let (host, port) = endpoint.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    Some((host, port.parse::<u16>().ok()?))
}

/// 대괄호를 벗긴 호스트.
///
/// 대괄호는 주소 표기이지 이름의 일부가 아니다. 짝이 맞을 때만 벗긴다 —
/// `trim` 으로 벗기면 `[fe80::1` 같은 잘린 값도 조용히 통과한다.
#[must_use]
pub fn bare_host(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer() -> HubOffer {
        HubOffer {
            endpoint: "192.168.0.12:47823".to_string(),
            // 손으로 만든 43자가 아니라 실제 계산 결과. 픽스처가 진짜 모양을
            // 쓰지 않으면 검사 규칙이 실제 값과 어긋나도 시험이 통과한다.
            fingerprint: crate::fingerprint::of_der(b"the laptop's certificate"),
            token: "token-1".to_string(),
            box_label: "노트북".to_string(),
            relay_endpoint: Some("relay.example:8787".to_string()),
            server_id: Some("server-1".to_string()),
            direct_pairing_payload: Some(
                "hmux-pair:1?a=192.168.0.12&p=47821&t=token&k=ssh-ed25519&f=fingerprint&e=1"
                    .to_string(),
            ),
        }
    }

    /// 릴레이를 끈 노트북. 직결 주소만 나른다.
    fn direct_only() -> HubOffer {
        HubOffer {
            relay_endpoint: None,
            server_id: None,
            ..offer()
        }
    }

    #[test]
    fn a_relayless_offer_round_trips_without_inventing_fields() {
        let encoded = encode(&direct_only());
        assert_eq!(decode(&encoded).expect("decodes"), direct_only());
        // 없는 것은 `null` 로도 나가지 않는다 — QR 은 작을수록 스캔이 쉽다.
        assert!(!encoded.contains("relay"), "{encoded}");
    }

    /// 새 폰이 옛 노트북의 QR 을 읽는 것은 정상 상황이다. 업데이트 순서를
    /// 사용자가 고르지 않는다.
    #[test]
    fn a_v1_payload_still_reads_with_no_relay() {
        let legacy = HubOffer {
            direct_pairing_payload: None,
            ..direct_only()
        };
        let body = serde_json::to_vec(&legacy).expect("직렬화");
        let v1 = format!(
            "{PAIRING_SCHEME_V1}?o={}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body)
        );

        let read = decode(&v1).expect("옛 판도 읽는다");

        assert_eq!(read.relay_endpoint, None);
        assert_eq!(read.endpoint, direct_only().endpoint);
    }

    #[test]
    fn a_v2_payload_still_reads_without_direct_pairing() {
        let legacy = HubOffer {
            direct_pairing_payload: None,
            ..offer()
        };
        let body = serde_json::to_vec(&legacy).expect("직렬화");
        let v2 = format!(
            "{PAIRING_SCHEME_V2}?o={}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body)
        );

        assert_eq!(decode(&v2).expect("v2도 읽는다"), legacy);
    }

    #[test]
    fn this_build_emits_the_current_version() {
        assert!(encode(&offer()).starts_with(PAIRING_SCHEME));
    }

    #[test]
    fn one_qr_carries_the_existing_direct_server_pairing_invitation() {
        let mut combined = offer();
        combined.direct_pairing_payload = Some(
            "hmux-pair:1?a=192.168.0.12&p=47821&t=token&k=ssh-ed25519&f=fingerprint&e=1"
                .to_string(),
        );

        let read = decode(&encode(&combined)).expect("combined offer decodes");

        assert_eq!(read.direct_pairing_payload, combined.direct_pairing_payload);
        assert!(encode(&combined).starts_with("dure-hub:3"));
    }

    #[test]
    fn current_offer_refuses_a_non_online_direct_pairing_code() {
        let mut broken = offer();
        broken.direct_pairing_payload = Some("hmux-pair:2?s=sealed".to_string());

        assert!(matches!(
            decode(&encode(&broken)),
            Err(OfferError::Malformed(_))
        ));
    }

    /// 릴레이 주소와 서버 id 중 하나만 있으면, 폰은 밖에 나가서야 갈 곳이나
    /// 부를 이름 하나가 없다는 것을 알게 된다.
    #[test]
    fn half_a_relay_is_refused_rather_than_carried() {
        for broken in [
            HubOffer {
                server_id: None,
                ..offer()
            },
            HubOffer {
                relay_endpoint: None,
                ..offer()
            },
        ] {
            assert!(
                matches!(decode(&encode(&broken)), Err(OfferError::Malformed(_))),
                "{broken:?}"
            );
        }
    }

    #[test]
    fn a_relay_address_that_cannot_be_dialled_is_refused() {
        let broken = HubOffer {
            relay_endpoint: Some("relay.example".to_string()),
            ..offer()
        };
        assert!(matches!(
            decode(&encode(&broken)),
            Err(OfferError::Malformed(_))
        ));
    }

    #[test]
    fn round_trips_between_the_two_halves() {
        assert_eq!(decode(&encode(&offer())).expect("decodes"), offer());
    }

    #[test]
    fn tolerates_surrounding_whitespace() {
        let scanned = format!("  {}\n", encode(&offer()));
        assert_eq!(decode(&scanned).expect("decodes"), offer());
    }

    /// 스캐너가 SSH 쪽 QR 을 물어왔을 때 다른 문장이 나온다는 것.
    #[test]
    fn names_the_ssh_pairing_code_as_a_different_flow() {
        assert_eq!(
            decode("hmux-pair:1?a=host&p=22").expect_err("ssh"),
            OfferError::SshPairing
        );
    }

    #[test]
    fn rejects_something_that_is_not_a_pairing_code() {
        assert_eq!(
            decode("https://example.com").expect_err("not an offer"),
            OfferError::NotAnOffer
        );
    }

    #[test]
    fn rejects_an_offer_with_no_fingerprint() {
        let mut broken = offer();
        broken.fingerprint = String::new();
        assert!(matches!(
            decode(&encode(&broken)),
            Err(OfferError::Malformed(_))
        ));
    }

    /// 잘린 지문을 고정하지 않는다는 것. 이것이 통과하면 폰은 비교할 것이 없는
    /// 값을 들고 붙는다.
    #[test]
    fn rejects_a_truncated_fingerprint() {
        let mut broken = offer();
        broken.fingerprint = "SHA256:abc".to_string();
        assert!(matches!(
            decode(&encode(&broken)),
            Err(OfferError::Malformed(_))
        ));
    }

    #[test]
    fn rejects_an_offer_with_no_token() {
        let mut broken = offer();
        broken.token = String::new();
        assert!(matches!(
            decode(&encode(&broken)),
            Err(OfferError::Malformed(_))
        ));
    }

    #[test]
    fn rejects_an_endpoint_without_a_port() {
        let mut broken = offer();
        broken.endpoint = "192.168.0.12".to_string();
        assert!(matches!(
            decode(&encode(&broken)),
            Err(OfferError::Malformed(_))
        ));
    }

    /// IPv6 주소가 첫 콜론에서 갈려 거부되지 않는다는 것.
    #[test]
    fn accepts_a_bracketed_ipv6_endpoint() {
        let mut ipv6 = offer();
        ipv6.endpoint = "[fe80::1]:47823".to_string();
        assert_eq!(decode(&encode(&ipv6)).expect("decodes"), ipv6);
    }

    #[test]
    fn recognises_its_own_scheme_without_decoding() {
        assert!(is_hub_offer(&encode(&offer())));
        assert!(!is_hub_offer("hmux-pair:1?a=host"));
    }

    /// 토큰이 `Debug` 로 새지 않는다는 것.
    #[test]
    fn debug_withholds_the_token() {
        let mut secret = offer();
        secret.direct_pairing_payload = Some("hmux-pair:1?t=nested-secret".to_string());
        let rendered = format!("{secret:?}");
        assert!(!rendered.contains("token-1"), "{rendered}");
        assert!(!rendered.contains("nested-secret"), "{rendered}");
    }
}
