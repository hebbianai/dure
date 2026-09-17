//! 허브가 자기 `server_id` 에 대한 권리를 증명하는 것을 검사한다.
//!
//! # 왜 검사하나 — 사칭이 아니라 도달 불가를 막는 것이다
//!
//! `server_id` 를 아는 쪽이 먼저 등록해 버리면 그 폰의 연결을 자기가 받는다.
//! 그래도 **사칭은 되지 않는다** — 폰은 그 위에서 인증서 지문을 고정하므로 가짜
//! 허브는 TLS 에서 떨어진다. 남는 피해는 주인이 자기 노트북에 못 붙는 것이고,
//! 그것은 사용자에게 고장과 구별되지 않는다. 막는 값이 싸므로 막는다.
//!
//! # 새 비밀을 만들지 않는다
//!
//! 이미 있는 인증서 개인키로 서명한다. 폰이 고정하는 것과 같은 키라, 등록을
//! 통과한 쪽은 폰이 믿는 바로 그 기계다. 별도의 등록용 토큰을 두면 그것을
//! 배포하고 회전할 자리가 하나 더 생기고, 그 자리는 지금 아무 데도 없다.

use dure_hub_protocol::fingerprint;
use dure_hub_protocol::relay::{RelayProof, RelayRejection, registration_transcript};
use rustls_pki_types::{CertificateDer, SignatureVerificationAlgorithm};

/// 받아들이는 서명 알고리즘.
///
/// 목록을 좁게 두는 것이 의도다. 허브의 인증서는 `rcgen` 기본값(ECDSA
/// P-256/SHA-256)으로 만들어지고, Ed25519 는 그 기본값이 바뀔 때를 위해 열어
/// 둔다. 넓히려면 여기 한 줄을 더하는 **보이는 편집**이어야 한다 — 약한
/// 알고리즘이 조용히 통과하는 경로를 만들지 않는다.
const ACCEPTED: &[&dyn SignatureVerificationAlgorithm] = &[
    webpki::ring::ECDSA_P256_SHA256,
    webpki::ring::ECDSA_P384_SHA384,
    webpki::ring::ED25519,
];

/// 증명이 통과하면 이 인증서의 지문.
///
/// 지문을 돌려주는 이유: 호출부가 DER 을 다시 만지지 않고 등록부에 넣을 수
/// 있어야 하고, 그 값이 폰이 고정한 것과 **같은 함수**로 계산되어야 한다.
pub fn verify(
    server_id: &str,
    nonce: &[u8],
    proof: &RelayProof,
) -> Result<VerifiedHub, RelayRejection> {
    let certificate_der = dure_hub_protocol::relay::decode_bytes(&proof.certificate_der)
        .map_err(|_| RelayRejection::Malformed)?;
    let signature = dure_hub_protocol::relay::decode_bytes(&proof.signature)
        .map_err(|_| RelayRejection::Malformed)?;

    let der = CertificateDer::from(certificate_der.clone());
    let certificate =
        webpki::EndEntityCert::try_from(&der).map_err(|_| RelayRejection::Malformed)?;
    let transcript = registration_transcript(server_id, nonce);

    // 하나라도 통과하면 된다. 어느 것으로 통과했는지는 기록하지 않는다 —
    // 인증서가 알고리즘을 정하고, 우리는 목록 안인지만 본다.
    let verified = ACCEPTED.iter().any(|algorithm| {
        certificate
            .verify_signature(*algorithm, &transcript, &signature)
            .is_ok()
    });
    if !verified {
        return Err(RelayRejection::BadProof);
    }

    Ok(VerifiedHub {
        fingerprint: fingerprint::of_der(&certificate_der),
    })
}

/// 증명을 통과한 허브에 대해 릴레이가 아는 것 전부.
///
/// 인증서 자체는 들고 있지 않는다. 라우팅에 필요한 것은 지문뿐이고, 필요 없는
/// 것을 들고 있으면 언젠가 쓰게 된다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedHub {
    pub fingerprint: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use dure_hub_protocol::relay::encode_bytes;
    use ring::rand::SystemRandom;
    use ring::signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair};

    /// 진짜 자체 서명 인증서와 그 키로 진짜 서명을 만든다.
    ///
    /// 손으로 만든 바이트로 시험하면 "우리 코드가 우리 코드를 통과시킨다" 만
    /// 증명된다. 허브가 실제로 쥐게 될 것과 같은 종류여야 한다.
    fn hub_certificate() -> (Vec<u8>, EcdsaKeyPair) {
        let certified =
            rcgen::generate_simple_self_signed(vec!["hub.invalid".to_string()]).expect("인증서");
        let der = certified.cert.der().to_vec();
        let key_der = certified.key_pair.serialize_der();
        let key = EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_ASN1_SIGNING,
            &key_der,
            &SystemRandom::new(),
        )
        .expect("rcgen 기본값은 P-256 이다");
        (der, key)
    }

    fn sign(key: &EcdsaKeyPair, server_id: &str, nonce: &[u8]) -> String {
        let transcript = registration_transcript(server_id, nonce);
        let signature = key.sign(&SystemRandom::new(), &transcript).expect("서명");
        encode_bytes(signature.as_ref())
    }

    #[test]
    fn a_hub_that_holds_the_private_key_registers() {
        let (der, key) = hub_certificate();
        let nonce = b"a relay-issued nonce";
        let proof = RelayProof {
            certificate_der: encode_bytes(&der),
            signature: sign(&key, "server-1", nonce),
        };

        let verified = verify("server-1", nonce, &proof).expect("자기 키로 서명했다");

        assert_eq!(verified.fingerprint, fingerprint::of_der(&der));
    }

    /// 이 시험이 이 파일의 존재 이유다. 인증서만 베낀 쪽 — 공개값이므로 누구나
    /// 가질 수 있다 — 이 그 `server_id` 를 차지하지 못해야 한다.
    #[test]
    fn copying_the_certificate_without_the_key_does_not_register() {
        let (victim_der, _) = hub_certificate();
        let (_, attacker_key) = hub_certificate();
        let nonce = b"a relay-issued nonce";
        let proof = RelayProof {
            certificate_der: encode_bytes(&victim_der),
            signature: sign(&attacker_key, "server-1", nonce),
        };

        assert_eq!(
            verify("server-1", nonce, &proof).expect_err("남의 인증서"),
            RelayRejection::BadProof
        );
    }

    /// 한 난수에 대한 서명이 다른 난수에 통하면 재생 공격이 된다.
    #[test]
    fn a_signature_for_another_nonce_is_refused() {
        let (der, key) = hub_certificate();
        let proof = RelayProof {
            certificate_der: encode_bytes(&der),
            signature: sign(&key, "server-1", b"the nonce it was given"),
        };

        assert_eq!(
            verify("server-1", b"a different nonce", &proof).expect_err("다른 난수"),
            RelayRejection::BadProof
        );
    }

    /// `server_id` 도 서명이 덮는다. 안 덮으면 한 기계의 등록 증명을 떼어
    /// 다른 `server_id` 에 붙일 수 있다.
    #[test]
    fn a_signature_for_another_server_id_is_refused() {
        let (der, key) = hub_certificate();
        let nonce = b"a relay-issued nonce";
        let proof = RelayProof {
            certificate_der: encode_bytes(&der),
            signature: sign(&key, "server-1", nonce),
        };

        assert_eq!(
            verify("server-2", nonce, &proof).expect_err("다른 서버"),
            RelayRejection::BadProof
        );
    }

    #[test]
    fn something_that_is_not_a_certificate_is_malformed_rather_than_bad_proof() {
        let proof = RelayProof {
            certificate_der: encode_bytes(b"not a certificate"),
            signature: encode_bytes(b"not a signature"),
        };

        assert_eq!(
            verify("server-1", b"nonce", &proof).expect_err("인증서가 아니다"),
            RelayRejection::Malformed
        );
    }

    #[test]
    fn a_body_that_is_not_base64_is_malformed() {
        let proof = RelayProof {
            certificate_der: "!!! not base64 !!!".to_string(),
            signature: "!!!".to_string(),
        };

        assert_eq!(
            verify("server-1", b"nonce", &proof).expect_err("base64 가 아니다"),
            RelayRejection::Malformed
        );
    }
}
