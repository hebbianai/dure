//! 책상에서 폰에게 건네는 것.
//!
//! # 왜 `hmux-pair:` 가 아닌가
//!
//! 이름이 비슷하다고 같은 것이 아니다. `hmux-pair:1` 은 SSH 서버의 주소와
//! 호스트 키를, `hmux-pair:2` 는 그것을 코드로 봉한 것을 담는다 — 둘 다 sshd 가
//! 저쪽에 있다는 것을 전제한다. 여기에는 sshd 가 없다. 폰은 이 앱이 띄운 TLS
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
//! 나중에 항목이 늘어나는 것도 값싸진다: JSON 에 필드를 더하면 되고, 옛 폰은
//! 모르는 필드를 무시한다.

use super::identity::DeviceToken;
// QR 이 나르는 문서와 그 검사는 `dure-hub-protocol` 이 소유한다. 이 페이로드는
// **폰이 읽으려고** 존재하므로 쓰는 쪽과 읽는 쪽이 한 정의를 봐야 한다. 여기
// 남는 것은 켜져 있는 허브에서 그 문서를 만드는 일뿐.
pub use dure_hub_protocol::offer::{
    decode, encode, is_fingerprint, is_hub_offer, HubOffer, OfferError, PAIRING_SCHEME,
};

/// 켜져 있는 허브와 방금 만든 토큰으로 제안 하나를 만든다.
/// `relay` 는 릴레이에 등록되어 있을 때의 `(주소, server_id)`.
///
/// 등록되지 않았으면 `None` 이다. 그 경우 QR 은 직결 주소만 나르고, 폰은 같은
/// 네트워크에서만 붙는다 — 릴레이가 아직 안 붙었는데 주소를 실으면 폰이 밖에서
/// 붙을 수 있다고 믿고 실패한다.
#[must_use]
pub fn offer_for(
    address: &str,
    port: u16,
    fingerprint: &str,
    device: &DeviceToken,
    box_label: &str,
    relay: Option<(&str, &str)>,
    direct_pairing_payload: &str,
) -> HubOffer {
    HubOffer {
        endpoint: format!("{address}:{port}"),
        fingerprint: fingerprint.to_string(),
        token: device.token.clone(),
        box_label: box_label.to_string(),
        relay_endpoint: relay.map(|(endpoint, _)| endpoint.to_string()),
        server_id: relay.map(|(_, server_id)| server_id.to_string()),
        direct_pairing_payload: Some(direct_pairing_payload.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::identity::{load_or_create_certificate, mint_token};

    fn direct_pairing() -> &'static str {
        "hmux-pair:1?a=192.168.0.7&p=47821&t=dGVzdC10b2tlbi12YWx1ZS1oZXJlLTMyLWJ5dGVz&k=ssh-ed25519&f=abcdEFGH-_1234abcdEFGH-_1234abcdEFGH-_123&e=1800000000000"
    }

    fn offer() -> HubOffer {
        HubOffer {
            endpoint: "192.168.0.7:47823".into(),
            fingerprint: format!("SHA256:{}", "A".repeat(43)),
            token: "B".repeat(43),
            box_label: "내 노트북".into(),
            relay_endpoint: Some("relay.example:8787".into()),
            server_id: Some("server-1".into()),
            direct_pairing_payload: Some(direct_pairing().into()),
        }
    }

    #[test]
    fn what_the_laptop_shows_is_what_the_phone_reads() {
        let round_tripped = decode(&encode(&offer())).expect("읽힌다");

        assert_eq!(round_tripped, offer());
    }

    /// 진짜 인증서의 지문이 통과해야 한다. 손으로 만든 픽스처만 시험하면
    /// `is_fingerprint` 가 실제 값과 어긋나도 알 수 없다.
    #[test]
    fn a_real_certificate_fingerprint_passes_validation() {
        let root = tempfile::tempdir().unwrap();
        let certificate = load_or_create_certificate(root.path()).unwrap();
        let device = mint_token("phone".into(), "폰".into()).unwrap();

        let made = offer_for(
            "192.168.0.7",
            47823,
            &certificate.fingerprint(),
            &device,
            "내 노트북",
            Some(("relay.example:8787", "server-1")),
            direct_pairing(),
        );

        let read = decode(&encode(&made)).expect("진짜 지문이 통과해야 한다");
        assert_eq!(read.fingerprint, certificate.fingerprint());
        assert_eq!(read.token, device.token);
        assert_eq!(read.endpoint, "192.168.0.7:47823");
    }

    /// 잘못된 QR 을 스캔하는 것은 흔하다. 그때 "형식이 틀렸다" 는 사람을 어디로도
    /// 보내지 않는다.
    #[test]
    fn an_ssh_pairing_code_says_which_flow_it_belongs_to() {
        for ssh in [
            "hmux-pair:1?a=10.0.0.1&p=22&t=x&k=y&f=z&e=1",
            "hmux-pair:2?s=abc&c=def",
        ] {
            let error = decode(ssh).unwrap_err();
            assert_eq!(error, OfferError::SshPairing, "{ssh}");
            assert!(error.to_string().contains("SSH"), "{error}");
        }
    }

    #[test]
    fn something_else_entirely_is_not_an_offer() {
        for other in ["", "hello", "https://example.com"] {
            assert_eq!(
                decode(other).unwrap_err(),
                OfferError::NotAnOffer,
                "{other}"
            );
        }
    }

    /// 아직 오지 않은 판의 QR 을 스캔한 앱은 "이 앱의 코드가 아니다" 가 아니라
    /// "앱이 낡았다" 를 말해야 한다 — 전자는 사용자를 QR 을 다시 만들러 보낸다.
    ///
    /// 이 빌드가 읽는 판(1, 2, 3)이 늘 때마다 여기 숫자도 올라간다. 그게 의도다:
    /// 판을 더하면서 이 시험을 보게 되고, 그때 "옛 앱에게 무엇으로 보이는가" 를
    /// 다시 생각하게 된다.
    #[test]
    fn a_newer_payload_version_says_the_app_is_old_rather_than_the_code_wrong() {
        assert_eq!(
            decode("dure-hub:4?o=abc").unwrap_err(),
            OfferError::NewerVersion
        );
    }

    /// 이 시험이 이 모듈에서 가장 중요하다. 지문 없는 제안을 통과시키면 폰은
    /// 아무것도 고정하지 않은 채 붙고, 그 상태에서는 아무 기계나 이 컴퓨터인
    /// 척할 수 있다.
    #[test]
    fn an_offer_without_a_usable_fingerprint_is_refused() {
        for broken in [
            "",
            "SHA256:",
            // 잘린 지문. 접두만 보면 통과한다.
            "SHA256:AAAA",
            // 접두가 없다.
            &"A".repeat(43),
            // SSH 호스트 키 지문의 다른 표기.
            "MD5:aa:bb:cc",
        ] {
            let mut broken_offer = offer();
            broken_offer.fingerprint = broken.to_string();

            let error = decode(&encode(&broken_offer)).unwrap_err();

            assert!(
                matches!(error, OfferError::Malformed(_)),
                "{broken:?} 가 통과했다"
            );
        }
    }

    #[test]
    fn an_offer_without_a_token_is_refused() {
        let mut broken = offer();
        broken.token = String::new();

        assert!(matches!(
            decode(&encode(&broken)).unwrap_err(),
            OfferError::Malformed(_)
        ));
    }

    #[test]
    fn an_address_the_phone_cannot_dial_is_refused() {
        for broken in [
            "",
            "192.168.0.7",
            ":47823",
            "192.168.0.7:",
            "192.168.0.7:칠",
        ] {
            let mut broken_offer = offer();
            broken_offer.endpoint = broken.to_string();

            assert!(
                matches!(
                    decode(&encode(&broken_offer)).unwrap_err(),
                    OfferError::Malformed(_)
                ),
                "{broken:?} 가 통과했다"
            );
        }
    }

    /// IPv6 도 담긴다. `rsplit_once(':')` 를 쓰는 이유가 이것이다 — 앞에서 자르면
    /// `[fe80::1]:47823` 의 첫 콜론에서 갈린다.
    #[test]
    fn an_ipv6_address_survives_the_round_trip() {
        let mut ipv6 = offer();
        ipv6.endpoint = "[fe80::1]:47823".into();

        assert_eq!(decode(&encode(&ipv6)).unwrap().endpoint, "[fe80::1]:47823");
    }

    /// 잘린 QR 은 조용히 반쪽 값이 되는 대신 실패해야 한다.
    #[test]
    fn a_truncated_payload_fails_rather_than_yielding_half_an_offer() {
        let full = encode(&offer());

        for cut in [full.len() / 2, full.len() - 4, full.len() - 1] {
            assert!(
                decode(&full[..cut]).is_err(),
                "{cut} 에서 잘린 것이 통과했다"
            );
        }
    }

    /// QR 하나에 들어가는 크기로 남아야 한다. 문자열 길이가 아니라 실제 인코더의
    /// 모듈 폭을 본다 — 같은 글자 수도 정정 수준과 인코딩에 따라 밀도가 달라진다.
    #[test]
    fn the_payload_stays_small_enough_to_scan_comfortably() {
        let encoded = encode(&offer());
        let matrix = crate::mobile_pairing::mobile_pairing_qr(encoded).expect("QR로 만든다");

        assert!(matrix.size <= 89, "{} 모듈", matrix.size);
    }
}
