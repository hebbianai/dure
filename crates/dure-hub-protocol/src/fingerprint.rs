//! 폰이 고정하는 값 — 어떻게 계산하고, 어떤 모양인지.
//!
//! 인증서 기관이 없으므로 신뢰의 출발점은 책상에서 QR 을 스캔한 그 순간
//! 하나뿐이다. 그 순간 폰이 받아 적는 것이 이 값이고, 이후 폰은 붙을 때마다
//! 상대가 내민 인증서에서 같은 값을 다시 계산해 비교한다.
//!
//! **양쪽이 같은 함수를 써야 한다.** 한쪽이 DER 전체를 해싱하고 다른 쪽이
//! 공개키만 해싱하면, 값은 둘 다 `SHA256:` 로 시작하는 43자라 모양 검사를
//! 통과하고 비교에서만 틀린다 — 화면에는 "이 컴퓨터가 아닙니다" 로 뜨고,
//! 사용자는 네트워크나 폰을 의심하게 된다.

use base64::Engine as _;
use sha2::{Digest as _, Sha256};

/// 값 앞에 붙는 표기. 이 저장소가 SSH 호스트 키 지문에 쓰는 것과 같은 모양이라,
/// 화면과 페이로드가 한 가지 모양만 다룬다.
pub const PREFIX: &str = "SHA256:";

/// base64(32바이트), 패딩 없음.
const DIGEST_LENGTH: usize = 43;

/// DER 한 덩이의 지문.
///
/// DER **전체**를 해싱한다. 공개키만 해싱하는 방식(SPKI 고정)도 있지만, 그러면
/// 같은 키로 다른 이름의 인증서를 만든 것을 같은 것으로 본다. 여기서는 인증서가
/// 곧 그 기계이므로 구별하는 편이 맞다.
#[must_use]
pub fn of_der(der: &[u8]) -> String {
    format!(
        "{PREFIX}{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(der))
    )
}

/// [`of_der`] 가 만드는 모양인지.
///
/// 길이까지 본다. `SHA256:` 로 시작하기만 하면 통과시키면, 잘린 QR 이 만든 짧은
/// 지문을 폰이 그대로 고정하고 아무것도 비교하지 못한다.
#[must_use]
pub fn is_fingerprint(value: &str) -> bool {
    value
        .strip_prefix(PREFIX)
        .is_some_and(|digest| digest.len() == DIGEST_LENGTH)
}

/// 이 DER 이 고정해 둔 지문의 것인지.
///
/// # 왜 상수 시간 비교가 아닌가
///
/// 지문은 비밀이 아니다 — QR 에 실려 나가고 설정 화면에 그대로 보인다. 상수
/// 시간 비교는 **비밀**을 비교할 때 필요하고(기기 토큰이 그 경우다), 공개값에
/// 쓰면 지키는 것 없이 "여기 비밀이 있다" 는 인상만 남는다.
///
/// 고정된 값이 모양부터 틀리면 무조건 거부한다. 빈 문자열이 빈 문자열과 같아서
/// 통과하는 상태 — 아무것도 고정하지 않은 폰이 아무 기계나 받아들이는 상태 —
/// 가 이 함수에서 만들어질 수 있는 유일한 재앙이다.
#[must_use]
pub fn matches(der: &[u8], pinned: &str) -> bool {
    is_fingerprint(pinned) && of_der(der) == pinned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fingerprint_has_the_shape_the_validator_accepts() {
        assert!(is_fingerprint(&of_der(b"some certificate bytes")));
    }

    #[test]
    fn different_bytes_give_different_fingerprints() {
        assert_ne!(of_der(b"machine a"), of_der(b"machine b"));
    }

    #[test]
    fn the_same_bytes_give_the_same_fingerprint() {
        assert_eq!(of_der(b"machine a"), of_der(b"machine a"));
    }

    /// 표준 base64 다. URL-safe 로 계산하면 `+`/`/` 가 `-`/`_` 로 바뀌어 같은
    /// 인증서가 다른 지문을 갖는다.
    #[test]
    fn the_digest_is_standard_base64_without_padding() {
        let value = of_der(b"x");
        let digest = value.strip_prefix(PREFIX).expect("접두가 있다");
        assert_eq!(digest.len(), DIGEST_LENGTH);
        assert!(!digest.contains('='), "{digest}");
        assert_eq!(
            base64::engine::general_purpose::STANDARD_NO_PAD
                .decode(digest)
                .expect("표준 base64 로 다시 읽힌다")
                .len(),
            32
        );
    }

    #[test]
    fn the_matching_certificate_is_accepted() {
        let der = b"the laptop's certificate";
        assert!(matches(der, &of_der(der)));
    }

    #[test]
    fn another_machines_certificate_is_refused() {
        assert!(!matches(b"someone else", &of_der(b"the laptop")));
    }

    /// 아무것도 고정하지 않은 폰이 아무 기계나 받아들이지 않는다는 것.
    ///
    /// 이 시험이 이 모듈에서 가장 중요하다. `of_der(der) == pinned` 만 있으면
    /// 빈 지문은 어떤 인증서와도 다르므로 우연히 통과하지 않지만, 모양 검사를
    /// 빼는 리팩터가 그 우연에 기대게 된다.
    #[test]
    fn a_pin_that_is_not_a_fingerprint_never_matches() {
        for broken in ["", "SHA256:", "SHA256:abc", "그냥 문자열"] {
            assert!(!matches(b"anything", broken), "{broken}");
        }
    }
}
