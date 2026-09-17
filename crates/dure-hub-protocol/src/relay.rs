//! 폰과 허브를 만나게 해 주는 제3자에게 하는 말.
//!
//! 릴레이는 **바이트 라우터**다. 두 소켓을 이어 주고, 이어 준 뒤로는 흐르는
//! 것을 해석하지 않는다 — 해석할 수도 없다. 폰과 허브 사이에는 지문이 고정된
//! TLS 가 서고, 릴레이는 허브의 개인키를 가진 적이 없다. zero-knowledge 가
//! 운영 약속이 아니라 구조인 이유가 그것이고, 우리가 그 릴레이를 직접
//! 운영하기 때문에 그 구분이 중요하다.
//!
//! ```text
//! [허브가 켜질 때 — 한 번, 계속 유지]
//!   허브 ─ Hello{HubControl, server_id} ──▶ 릴레이
//!        ◀── Challenge{nonce}
//!        ─ Proof{인증서, 서명} ──▶
//!        ◀── Registered
//!
//! [폰이 붙을 때]
//!   폰   ─ Hello{Client, server_id} ──▶ 릴레이
//!   허브 ◀── Incoming{connection_id}      (control 연결로)
//!   허브 ─ Hello{HubData, connection_id} ──▶ 릴레이   (새 소켓)
//!   양쪽 ◀── Paired
//!   그 뒤로는 바이트. 그 위에서 폰과 허브가 TLS 를 세운다.
//! ```
//!
//! # 왜 아웃바운드만 쓰나
//!
//! 노트북도 폰도 릴레이 쪽으로 **나간다**. 포트 개방도, UPnP 도, 시스템
//! 스위치도 요구하지 않는다 — 그 요구가 없어지는 것이 이 전송의 존재 이유다.
//!
//! # `connection_id` 는 소지가 곧 자격이다
//!
//! 릴레이가 만들어 **등록된 허브의 control 연결로만** 보낸다. 그것을 들고 오는
//! 데이터 연결은 그 허브로 취급된다. 추측 불가능해야 하고(128비트 이상 난수),
//! 한 번 쓰면 사라지며, 짧게 만료된다.
//!
//! 이 값이 새더라도 **사칭은 되지 않는다**: 폰은 그 위에서 인증서 지문을
//! 고정하므로 가짜 허브는 TLS 에서 떨어진다. 새서 생기는 피해는 그 연결 하나를
//! 가로채 아무 말도 못 하고 끊기는 것뿐이다.

use crate::frame::FrameError;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// 이 빌드가 말하는 판.
pub const RELAY_PROTOCOL_VERSION: u16 = 1;

/// 릴레이와 주고받는 제어 프레임 하나의 상한.
///
/// 여기 오가는 것 중 가장 큰 것이 인증서 DER 과 서명이고, 합쳐도 2KiB 를
/// 넘지 않는다. 상한이 인사와 같은 크기인 이유는 같은 성격이기 때문이다 —
/// 아직 아무것도 증명하지 않은 쪽이 보내는 바이트다.
pub const MAX_RELAY_FRAME_BYTES: usize = 8 * 1024;

/// 등록 서명이 덮는 문서의 이름. 다른 문맥의 서명이 여기 재사용되지 않도록
/// transcript 맨 앞에 박힌다.
const REGISTRATION_CONTEXT: &[u8] = b"dure-relay-register:1";

/// 릴레이에 붙는 쪽이 자기가 누구라고 말하는가.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelayRole {
    /// 세션을 가진 기계. control 연결 하나를 계속 들고 있는다.
    HubControl,
    /// 그 기계가 폰 하나를 받으려고 새로 여는 연결.
    ///
    /// control 연결에 다중화하지 않는다. 다중화하면 릴레이 안에 프레이밍과
    /// 흐름 제어와 헤드오브라인 차단이 생기고, 그 순간 릴레이는 바이트
    /// 라우터가 아니라 프로토콜을 아는 참여자가 된다.
    HubData,
    /// 붙으려는 폰.
    Client,
}

/// 붙자마자 보내는 것.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayHello {
    pub relay_protocol_version: u16,
    pub role: RelayRole,
    /// 어느 기계를 찾는가/어느 기계인가.
    pub server_id: String,
    /// [`RelayRole::HubData`] 일 때만. 릴레이가 control 로 알려 준 값.
    #[serde(default)]
    pub connection_id: Option<String>,
}

/// 릴레이가 허브에게 내는 난수. 이것에 서명해야 등록된다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayChallenge {
    pub relay_protocol_version: u16,
    /// base64(URL-safe, 패딩 없음).
    pub nonce: String,
}

/// 허브가 자기 `server_id` 에 대한 권리를 증명하는 것.
///
/// 새 비밀을 만들지 않는다 — 이미 있는 인증서 개인키로 서명한다. 폰이 고정하는
/// 것과 같은 키라, 등록을 통과한 쪽은 폰이 믿는 그 기계다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RelayProof {
    /// base64(표준, 패딩 없음). 릴레이가 여기서 공개키를 꺼내 서명을 본다.
    pub certificate_der: String,
    /// base64(표준, 패딩 없음). [`registration_transcript`] 에 대한 서명.
    pub signature: String,
}

/// 릴레이가 control 연결로 흘리는 것. 등록 이후에는 [`Self::Incoming`] 이
/// 계속 온다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum RelayControlEvent {
    Registered,
    /// 폰 하나가 와 있다. 이 값을 들고 데이터 연결을 열어라.
    Incoming {
        connection_id: String,
    },
    /// 아무 일도 없다는 말.
    ///
    /// 등록 뒤 control 연결은 폰이 올 때까지 조용하다. 그 침묵이 두 가지를
    /// 만든다: 앞에 프록시가 있으면 유휴 연결을 끊어 버리고(Fly·Railway 같은
    /// PaaS 가 그렇다), 릴레이가 조용히 죽어도 노트북이 알아채지 못한다 —
    /// 자기가 등록돼 있다고 믿은 채 영원히 앉아 있게 된다.
    ///
    /// 릴레이가 보낸다. 노트북이 보내지 않는 이유: 릴레이의 control 스레드는
    /// 끊김만 기다리며 read 에 들어가 있고, 거기서 바이트가 오면 프로토콜
    /// 위반으로 끊는다. 한 방향이면 두 문제 모두 풀린다.
    Ping,
    Rejected {
        reason: RelayRejection,
    },
}

/// 붙기를 거절하는 이유.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelayRejection {
    /// 이 빌드가 말하지 않는 판.
    UnsupportedVersion,
    /// 서명이 인증서의 것이 아니다.
    BadProof,
    /// 이 `server_id` 는 다른 인증서로 이미 고정되어 있다.
    ///
    /// 인증서를 회전하면 여기 걸린다. 회복 경로는 아직 정해지지 않았다 —
    /// 설계 문서의 "아직 정하지 않은 것" 참조.
    FingerprintChanged,
    /// 상한에 걸렸다.
    TooManyConnections,
    /// 형식이 틀렸다.
    Malformed,
}

/// 폰(또는 허브의 데이터 연결)에게 주는 답.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "answer", rename_all = "snake_case")]
pub enum RelayAnswer {
    /// 이어졌다. **이 프레임 다음부터는 바이트다** — 양쪽 모두 이것 하나를
    /// 읽고 나서 raw 로 넘어간다.
    Paired,
    Unavailable {
        reason: RelayUnavailable,
    },
}

/// 지금은 안 되는 이유.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelayUnavailable {
    /// 그런 `server_id` 로 등록한 기계가 없다.
    Unknown,
    /// 등록은 되어 있었지만 지금 control 연결이 없다. 노트북이 꺼져 있다.
    ///
    /// [`Self::Unknown`] 과 구별해서 답한다. 구별하지 않으면 폰이 사용자에게
    /// "컴퓨터가 꺼져 있습니다" 를 말할 수 없고, 그 문장은 밖에서 폰을 꺼낸
    /// 사람이 가장 먼저 알아야 하는 것이다. 이 구별은 `server_id` 를 아는
    /// 쪽에게 그 노트북의 온라인 여부를 알려 준다 — 그 값은 QR 로만 나가므로
    /// 대상은 이미 QR 을 본 사람이고, 설계 문서가 그 누출을 적어 두었다.
    Offline,
    /// 허브가 데이터 연결을 제때 열지 않았다.
    Timeout,
    /// 상한에 걸렸다.
    Busy,
}

/// 서명이 덮는 바이트. **양쪽이 이 함수를 쓴다.**
///
/// 길이 접두를 붙이는 이유: 이어 붙이기만 하면 `server_id="ab"`+`nonce="c"` 와
/// `server_id="a"`+`nonce="bc"` 가 같은 바이트가 된다. 그 둘이 같아지면 한
/// 문맥에서 받은 서명이 다른 문맥에서 통한다.
///
/// 맨 앞의 문맥 문자열은 이 저장소의 다른 서명이 여기 재사용되지 않게 한다.
#[must_use]
pub fn registration_transcript(server_id: &str, nonce: &[u8]) -> Vec<u8> {
    let mut transcript = Vec::new();
    push_field(&mut transcript, REGISTRATION_CONTEXT);
    push_field(&mut transcript, server_id.as_bytes());
    push_field(&mut transcript, nonce);
    transcript
}

/// 길이(빅엔디언 u32) + 값.
fn push_field(transcript: &mut Vec<u8>, value: &[u8]) {
    // `as u32` 가 아니다. 4GiB 짜리 필드는 오지 않지만, 잘린 길이가 조용히
    // 들어가면 서로 다른 입력이 같은 transcript 를 만든다.
    let length = u32::try_from(value.len()).expect("transcript 필드는 u32 에 담긴다");
    transcript.extend_from_slice(&length.to_be_bytes());
    transcript.extend_from_slice(value);
}

/// 릴레이가 내는 난수의 표기. 허브는 이것을 풀어 [`registration_transcript`] 에
/// 넣는다.
pub fn encode_nonce(nonce: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(nonce)
}

/// [`encode_nonce`] 를 되돌린다.
pub fn decode_nonce(nonce: &str) -> Result<Vec<u8>, FrameError> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(nonce)
        .map_err(|_| FrameError::Malformed("난수가 base64 가 아닙니다"))
}

/// 인증서와 서명의 표기.
pub fn encode_bytes(value: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD_NO_PAD.encode(value)
}

/// [`encode_bytes`] 를 되돌린다.
pub fn decode_bytes(value: &str) -> Result<Vec<u8>, FrameError> {
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(value)
        .map_err(|_| FrameError::Malformed("값이 base64 가 아닙니다"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame;

    #[test]
    fn a_hello_round_trips_through_a_frame() {
        let hello = RelayHello {
            relay_protocol_version: RELAY_PROTOCOL_VERSION,
            role: RelayRole::Client,
            server_id: "server-1".to_string(),
            connection_id: None,
        };
        let framed = frame::encode(&hello, MAX_RELAY_FRAME_BYTES).expect("encodes");
        let decoded: RelayHello =
            frame::read(&mut framed.as_slice(), MAX_RELAY_FRAME_BYTES).expect("reads");
        assert_eq!(decoded, hello);
    }

    /// 데이터 연결의 인사는 `connection_id` 를 나른다.
    #[test]
    fn a_data_hello_carries_the_connection_it_answers() {
        let hello = RelayHello {
            relay_protocol_version: RELAY_PROTOCOL_VERSION,
            role: RelayRole::HubData,
            server_id: "server-1".to_string(),
            connection_id: Some("conn-1".to_string()),
        };
        let framed = frame::encode(&hello, MAX_RELAY_FRAME_BYTES).expect("encodes");
        let decoded: RelayHello =
            frame::read(&mut framed.as_slice(), MAX_RELAY_FRAME_BYTES).expect("reads");
        assert_eq!(decoded.connection_id.as_deref(), Some("conn-1"));
        assert_eq!(decoded.role, RelayRole::HubData);
    }

    /// 옛 인사에 `connection_id` 가 없어도 읽힌다 — `#[serde(default)]` 가 그
    /// 자리에 있는 이유.
    #[test]
    fn a_hello_without_a_connection_id_still_reads() {
        let body = serde_json::json!({
            "relay_protocol_version": RELAY_PROTOCOL_VERSION,
            "role": "client",
            "server_id": "server-1",
        });
        let decoded: RelayHello = serde_json::from_value(body).expect("reads");
        assert_eq!(decoded.connection_id, None);
    }

    #[test]
    fn control_events_round_trip() {
        for event in [
            RelayControlEvent::Registered,
            RelayControlEvent::Incoming {
                connection_id: "conn-1".to_string(),
            },
            RelayControlEvent::Rejected {
                reason: RelayRejection::BadProof,
            },
        ] {
            let framed = frame::encode(&event, MAX_RELAY_FRAME_BYTES).expect("encodes");
            let decoded: RelayControlEvent =
                frame::read(&mut framed.as_slice(), MAX_RELAY_FRAME_BYTES).expect("reads");
            assert_eq!(decoded, event);
        }
    }

    #[test]
    fn answers_round_trip() {
        for answer in [
            RelayAnswer::Paired,
            RelayAnswer::Unavailable {
                reason: RelayUnavailable::Offline,
            },
            RelayAnswer::Unavailable {
                reason: RelayUnavailable::Unknown,
            },
        ] {
            let framed = frame::encode(&answer, MAX_RELAY_FRAME_BYTES).expect("encodes");
            let decoded: RelayAnswer =
                frame::read(&mut framed.as_slice(), MAX_RELAY_FRAME_BYTES).expect("reads");
            assert_eq!(decoded, answer);
        }
    }

    /// 폰이 "꺼져 있다" 와 "그런 기계 없다" 를 구별해 받을 수 있어야 한다.
    /// 하나로 뭉치면 밖에서 폰을 꺼낸 사람에게 할 말이 없어진다.
    #[test]
    fn offline_and_unknown_are_different_answers_on_the_wire() {
        let offline = serde_json::to_string(&RelayAnswer::Unavailable {
            reason: RelayUnavailable::Offline,
        })
        .expect("직렬화");
        let unknown = serde_json::to_string(&RelayAnswer::Unavailable {
            reason: RelayUnavailable::Unknown,
        })
        .expect("직렬화");
        assert_ne!(offline, unknown);
    }

    #[test]
    fn the_nonce_survives_the_round_trip() {
        let nonce = [0u8, 1, 2, 250, 251, 252, 253, 254, 255];
        assert_eq!(
            decode_nonce(&encode_nonce(&nonce)).expect("decodes"),
            nonce.to_vec()
        );
    }

    /// 이 시험이 이 모듈에서 가장 중요하다.
    ///
    /// 길이 접두가 없으면 아래 두 입력이 같은 바이트를 만들고, 한 문맥에서 받은
    /// 서명이 다른 문맥에서 통한다.
    #[test]
    fn the_transcript_cannot_be_confused_by_shifting_the_boundary() {
        assert_ne!(
            registration_transcript("ab", b"c"),
            registration_transcript("a", b"bc")
        );
    }

    #[test]
    fn the_transcript_is_stable_for_the_same_input() {
        assert_eq!(
            registration_transcript("server-1", b"nonce"),
            registration_transcript("server-1", b"nonce")
        );
    }

    /// 문맥 문자열이 맨 앞에 있어야 다른 서명이 재사용되지 않는다.
    #[test]
    fn the_transcript_names_its_own_context_first() {
        let transcript = registration_transcript("server-1", b"nonce");
        let prefix_length = u32::try_from(REGISTRATION_CONTEXT.len()).expect("fits");
        assert_eq!(transcript[..4], prefix_length.to_be_bytes());
        assert_eq!(
            &transcript[4..4 + REGISTRATION_CONTEXT.len()],
            REGISTRATION_CONTEXT
        );
    }

    /// 바이트 표기가 인증서 지문과 같은 알파벳(표준 base64)이어야 한다 —
    /// 릴레이가 받은 DER 로 지문을 다시 계산하기 때문이다.
    #[test]
    fn certificate_bytes_survive_the_round_trip() {
        let der = b"\x30\x82\x01\x0a some DER-ish bytes \xff\xfe";
        assert_eq!(decode_bytes(&encode_bytes(der)).expect("decodes"), der);
    }
}
