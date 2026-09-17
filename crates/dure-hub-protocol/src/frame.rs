//! 길이 접두 프레임 하나.
//!
//! 허브 위를 흐르는 모든 문서가 같은 봉투를 쓴다: 빅엔디언 `u32` 길이 뒤에
//! JSON 본문. HTTP 가 아닌 이유는 [`crate`] 머리말에 있다.
//!
//! # 왜 상한을 호출부가 넘기나
//!
//! 인사와 목록은 다른 크기를 가진다. 하나로 묶으면 인사에 목록만 한 상한이
//! 걸리고, 인사는 **아직 아무것도 증명하지 않은 쪽**이 보내는 유일한 바이트다.
//! 그쪽 상한이 목록을 따라 커지는 것은 그 자체로 회귀라, 상한은 문서마다
//! 따로 정하고 이 모듈은 강제만 한다.

use serde::Serialize;
use serde::de::DeserializeOwned;
use std::io::Read;

/// 인증 프레임 하나의 상한.
///
/// 토큰 하나와 판 번호가 들어갈 뿐이라 넉넉해도 작다. 상한이 있는 이유는 인증
/// 전에 읽는 유일한 바이트이기 때문이다 — 없으면 아직 아무것도 증명하지 않은
/// 쪽이 이 프로세스의 메모리를 원하는 만큼 쓰게 만들 수 있다.
pub const MAX_HELLO_BYTES: usize = 8 * 1024;

/// 목록 프레임 하나의 상한.
///
/// 인사보다 큰 이유는 여러 상자의 세션이 한 문서에 담기기 때문이다. 폰이 읽는
/// 쪽에도 상한이 필요하다: 폰은 인증서 지문으로 상대가 자기 노트북인 것까지만
/// 알지, 그 노트북의 앱이 정상인지는 모른다.
pub const MAX_CATALOG_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// **한 바이트도 오기 전에** 상대가 깨끗이 끊었다.
    ///
    /// 시간 초과나 중간 끊김과 구별하는 이유: 이 저장소의 두 리스너는 받아들이지
    /// 않은 상대에게 아무 말도 하지 않고 끊는다. 그러니 이것은 흔히 **거절**의
    /// 모양이고, 네트워크 문제와 같은 문장으로 보고하면 사용자를 와이파이를
    /// 보러 보낸다 — 또는 그 반대로, 잠깐 끊긴 사람에게 재페어링을 시킨다.
    Closed,
    /// 기다리다 마감을 넘겼다. 상대는 아직 살아 있을 수 있다.
    TimedOut,
    /// 읽는 도중 끊겼다. 봉투의 절반만 왔다.
    Truncated(&'static str),
    /// 길이가 0 이거나 상한을 넘는다.
    OutOfRange { length: usize, limit: usize },
    /// 봉투는 맞는데 본문이 이 판의 JSON 이 아니다.
    Malformed(&'static str),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => write!(formatter, "상대가 아무것도 보내지 않고 연결을 닫았습니다"),
            Self::TimedOut => write!(formatter, "상대가 제때 답하지 않았습니다"),
            Self::Truncated(detail) => write!(formatter, "프레임을 다 읽지 못했습니다: {detail}"),
            Self::OutOfRange { length, limit } => write!(
                formatter,
                "프레임 길이가 범위를 벗어났습니다: {length} (상한 {limit})"
            ),
            Self::Malformed(detail) => {
                write!(formatter, "프레임 본문을 읽을 수 없습니다: {detail}")
            }
        }
    }
}

impl std::error::Error for FrameError {}

/// 문서 하나를 봉투에 넣는다.
///
/// 상한을 여기서도 검사한다. 보내는 쪽이 검사하지 않으면 상대가 거부할 것을
/// 만들어 보내게 되고, 그 실패는 받는 쪽 로그에만 남는다.
pub fn encode<T: Serialize>(value: &T, limit: usize) -> Result<Vec<u8>, FrameError> {
    let body = serde_json::to_vec(value).map_err(|_| FrameError::Malformed("직렬화 실패"))?;
    if body.is_empty() || body.len() > limit {
        return Err(FrameError::OutOfRange {
            length: body.len(),
            limit,
        });
    }
    // `as u32` 가 아니라 검사된 변환. 위의 상한이 언젠가 u32 를 넘게 잡히면
    // 잘린 길이가 조용히 나가고, 받는 쪽은 본문 중간을 다음 프레임의 시작으로
    // 읽는다.
    let length = u32::try_from(body.len()).map_err(|_| FrameError::OutOfRange {
        length: body.len(),
        limit,
    })?;
    let mut framed = Vec::with_capacity(4 + body.len());
    framed.extend_from_slice(&length.to_be_bytes());
    framed.extend_from_slice(&body);
    Ok(framed)
}

/// 봉투 하나를 읽어 문서를 꺼낸다.
///
/// 스트림을 제네릭으로 받는 이유: TLS 소켓 위에서 도는 것이 본래 쓰임이지만,
/// 그 판단 — 길이 상한, 잘린 본문 — 은 TLS 없이 시험할 수 있어야 한다.
/// 핸드셰이크를 세우지 않으면 시험할 수 없는 코드는 시험되지 않는다.
pub fn read<T: DeserializeOwned, R: Read>(reader: &mut R, limit: usize) -> Result<T, FrameError> {
    let payload = read_bytes(reader, limit)?;
    serde_json::from_slice(&payload).map_err(|_| FrameError::Malformed("이 판의 JSON 이 아닙니다"))
}

/// 봉투 하나의 본문을 바이트로. 판을 먼저 보고 나서 구조체로 풀고 싶을 때 쓴다.
///
/// 판 검사가 엄격한 역직렬화 **뒤에** 오면, 판이 실제로 갈린 날 — 필드가 사라진
/// 날 — 상대는 "이 판의 JSON 이 아닙니다" 를 받는다. 판 번호를 둔 이유가 정확히
/// 그때 "한쪽이 낡았습니다" 를 말하는 것인데 말이다.
pub fn read_bytes<R: Read>(reader: &mut R, limit: usize) -> Result<Vec<u8>, FrameError> {
    let mut length = [0u8; 4];
    fill(reader, &mut length, "길이를 읽지 못했습니다")?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > limit {
        return Err(FrameError::OutOfRange { length, limit });
    }
    // 상한을 통과한 길이만 할당한다. 먼저 할당하고 검사하면 상한이 있으나 마나다.
    let mut payload = vec![0u8; length];
    fill(reader, &mut payload, "본문을 다 읽지 못했습니다").map_err(|error| match error {
        // 접두는 왔는데 본문이 한 바이트도 안 온 것은 "아무것도 안 보내고
        // 끊었다" 가 아니다. 이미 말을 시작한 상대가 중간에 사라진 것이다.
        FrameError::Closed => FrameError::Truncated("본문을 다 읽지 못했습니다"),
        other => other,
    })?;
    Ok(payload)
}

/// `read_exact` 대신 손으로 채운다.
///
/// `read_exact` 는 "한 바이트도 안 왔다" 와 "절반만 왔다" 와 "시간이 초과됐다" 를
/// 구별해 주지 않는다. 셋은 사용자에게 서로 다른 문장이어야 한다
/// ([`FrameError::Closed`] 참조).
fn fill<R: Read>(
    reader: &mut R,
    buffer: &mut [u8],
    detail: &'static str,
) -> Result<(), FrameError> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) if filled == 0 => return Err(FrameError::Closed),
            Ok(0) => return Err(FrameError::Truncated(detail)),
            Ok(read) => filled += read,
            // 신호에 깨진 것은 실패가 아니다. 여기서 끊으면 소켓이 멀쩡한데도
            // 붙지 않는 상태가 드물게 재현된다.
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                return Err(FrameError::TimedOut);
            }
            Err(_) => return Err(FrameError::Truncated(detail)),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
    struct Doc {
        value: String,
    }

    fn doc(value: &str) -> Doc {
        Doc {
            value: value.to_string(),
        }
    }

    #[test]
    fn round_trips() {
        let framed = encode(&doc("안녕"), MAX_HELLO_BYTES).expect("encodes");
        let decoded: Doc = read(&mut framed.as_slice(), MAX_HELLO_BYTES).expect("reads");
        assert_eq!(decoded, doc("안녕"));
    }

    #[test]
    fn length_prefix_is_big_endian() {
        let framed = encode(&doc("x"), MAX_HELLO_BYTES).expect("encodes");
        let body_length = framed.len() - 4;
        assert_eq!(
            framed[..4],
            u32::try_from(body_length).expect("fits").to_be_bytes()
        );
    }

    /// 리틀엔디언으로 읽는 구현과 붙었을 때 조용히 통과하지 않는다는 것.
    ///
    /// 짧은 본문은 두 표기의 차이가 "엄청 큰 수" 대 "작은 수" 라서, 상한이
    /// 그 실수를 잡는다. 그 성질을 시험이 들고 있어야 상한을 키울 때 드러난다.
    #[test]
    fn byte_swapped_length_is_rejected() {
        let mut framed = encode(&doc("x"), MAX_HELLO_BYTES).expect("encodes");
        framed[..4].reverse();
        let outcome: Result<Doc, _> = read(&mut framed.as_slice(), MAX_HELLO_BYTES);
        assert!(matches!(outcome, Err(FrameError::OutOfRange { .. })));
    }

    #[test]
    fn rejects_length_over_limit_without_allocating_it() {
        // 4GiB 를 요구하는 접두. 본문은 없다 — 상한 검사가 할당보다 먼저라면
        // 이 시험은 즉시 끝나고, 순서가 뒤집히면 4GiB 를 잡으려 든다.
        let framed = [0xFF, 0xFF, 0xFF, 0xFF];
        let outcome: Result<Doc, _> = read(&mut framed.as_slice(), MAX_HELLO_BYTES);
        assert_eq!(
            outcome.expect_err("over limit"),
            FrameError::OutOfRange {
                length: u32::MAX as usize,
                limit: MAX_HELLO_BYTES,
            }
        );
    }

    #[test]
    fn rejects_zero_length() {
        let framed = [0u8; 4];
        let outcome: Result<Doc, _> = read(&mut framed.as_slice(), MAX_HELLO_BYTES);
        assert!(matches!(
            outcome,
            Err(FrameError::OutOfRange { length: 0, .. })
        ));
    }

    #[test]
    fn rejects_body_shorter_than_prefix_claims() {
        let mut framed = encode(&doc("hello"), MAX_HELLO_BYTES).expect("encodes");
        framed.pop();
        let outcome: Result<Doc, _> = read(&mut framed.as_slice(), MAX_HELLO_BYTES);
        assert!(matches!(outcome, Err(FrameError::Truncated(_))));
    }

    #[test]
    fn encode_refuses_a_body_over_the_limit() {
        let big = doc(&"가".repeat(MAX_HELLO_BYTES));
        let outcome = encode(&big, MAX_HELLO_BYTES);
        assert!(matches!(outcome, Err(FrameError::OutOfRange { .. })));
    }

    /// 한 스트림에 두 프레임이 연달아 있어도 경계가 정확하다는 것.
    ///
    /// 목록 뒤에 무엇이 오든(슬라이스 5 의 attach 가 그렇게 된다) 첫 프레임을
    /// 읽고 남은 바이트가 그대로 남아 있어야 한다.
    #[test]
    fn leaves_the_next_frame_in_the_stream() {
        let mut stream = encode(&doc("first"), MAX_HELLO_BYTES).expect("encodes");
        stream.extend_from_slice(&encode(&doc("second"), MAX_HELLO_BYTES).expect("encodes"));

        let mut cursor = stream.as_slice();
        let first: Doc = read(&mut cursor, MAX_HELLO_BYTES).expect("first");
        let second: Doc = read(&mut cursor, MAX_HELLO_BYTES).expect("second");
        assert_eq!(first, doc("first"));
        assert_eq!(second, doc("second"));
    }
}
