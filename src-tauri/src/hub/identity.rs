//! 허브가 자신을 증명하는 것과, 폰이 자신을 증명하는 것.
//!
//! 폰은 이 앱이 띄운 리스너에 붙는다. SSH 가 아니므로 sshd 가 주던 두 가지를
//! 우리가 져야 한다: 폰이 **맞는 기계**에 붙었다는 것과, 붙은 쪽이 **허락받은
//! 기기**라는 것.
//!
//! - 기계의 증명: 자체 서명 인증서. 페어링 때 그 지문을 폰이 고정하고, 이후
//!   지문이 다르면 붙지 않는다. 인증서 기관이 없으므로 신뢰의 출발점은 책상에서
//!   QR 을 스캔한 그 순간 하나뿐이다 — SSH 호스트 키를 고정하는 것과 같은 모양이고,
//!   폰은 이미 그 방식을 쓰고 있다.
//! - 기기의 증명: 기기마다 다른 토큰. 상수 시간으로 비교한다.
//!
//! # 인증서를 왜 만들어 두고 재사용하나
//!
//! 앱을 켤 때마다 새로 만들면 지문이 매번 바뀌고, 폰이 고정해 둔 값과 어긋나
//! 페어링이 켤 때마다 깨진다. 그래서 한 번 만들어 앱 데이터 디렉터리에 두고
//! 재사용한다 — 그 파일이 이 기계의 신원이다.
//!
//! # 토큰을 왜 기기마다 두나
//!
//! 하나를 공유하면 기기 하나를 취소할 때 나머지가 함께 죽는다. `hmux pair
//! revoke` 가 서버별로 키를 지우는 것과 같은 이유다.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use subtle::ConstantTimeEq as _;

/// 인증서와 그 개인키. 파일에서 읽거나 새로 만든다.
pub struct HubCertificate {
    /// DER. rustls 가 그대로 받는다.
    pub der: Vec<u8>,
    /// PKCS#8 DER.
    pub private_key_der: Vec<u8>,
}

/// 개인키를 찍지 않는다.
///
/// `#[derive(Debug)]` 였다면 이 구조체를 로그에 넣는 순간 개인키 바이트가
/// 함께 나간다 — 그 키를 가진 쪽은 이 기계인 척할 수 있고, 폰은 지문만 보고
/// 믿는다. 지문은 어차피 공개값이라 그것만 보여준다.
impl std::fmt::Debug for HubCertificate {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HubCertificate")
            .field("fingerprint", &self.fingerprint())
            .field("private_key_der", &"<redacted>")
            .finish()
    }
}

impl HubCertificate {
    /// 폰이 고정하는 값. `SHA256:<base64>` — 이 저장소가 SSH 호스트 키 지문에
    /// 쓰는 것과 같은 표기라, 화면과 페이로드가 한 가지 모양만 다룬다.
    ///
    /// DER 전체를 해싱한다. 공개키만 해싱하는 방식(SPKI 고정)도 있지만, 그러면
    /// 같은 키로 다른 이름의 인증서를 만든 것을 같은 것으로 본다. 여기서는
    /// 인증서가 곧 이 기계이므로 구별하는 편이 맞다.
    #[must_use]
    pub fn fingerprint(&self) -> String {
        fingerprint_of_der(&self.der)
    }
}

/// DER 한 덩이의 지문.
///
/// 계산은 [`dure_hub_protocol::fingerprint::of_der`] 하나가 소유한다. 폰은 붙을
/// 때마다 상대가 내민 인증서에서 같은 값을 다시 계산해 비교하므로, 두 계산이
/// 갈리면 QR 스캔은 되는데 접속만 안 되는 상태가 된다 — 그 화면은 "이 컴퓨터가
/// 아닙니다" 라고 말하고, 사용자는 네트워크를 의심하게 된다.
pub use dure_hub_protocol::fingerprint::of_der as fingerprint_of_der;

#[derive(Debug)]
pub enum IdentityError {
    Io(std::io::Error),
    /// 인증서를 만들지 못했다.
    Generate(String),
    /// 저장된 파일이 인증서가 아니다.
    Corrupt(&'static str),
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "Could not access the hub identity file: {error}"),
            Self::Generate(detail) => write!(formatter, "Could not generate a certificate: {detail}"),
            Self::Corrupt(detail) => write!(
                formatter,
                "Could not read the saved hub identity: {detail}. Deleting the file regenerates it, but paired devices must be paired again with the new fingerprint"
            ),
        }
    }
}

impl std::error::Error for IdentityError {}

impl From<std::io::Error> for IdentityError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

fn certificate_path(root: &Path) -> PathBuf {
    root.join("hub-certificate.der")
}

fn key_path(root: &Path) -> PathBuf {
    root.join("hub-certificate-key.der")
}

fn server_id_path(root: &Path) -> PathBuf {
    root.join("hub-server-id")
}

/// 릴레이에서 이 기계를 찾는 이름.
///
/// # 왜 인증서 지문이 아닌가
///
/// 지문을 그대로 랑데부 주소로 쓰면 식별자가 하나로 줄어 깔끔해 보이지만,
/// 인증서를 회전하는 순간 주소가 같이 움직여서 페어링된 폰 전부가 길을 잃는다.
/// **신원과 주소는 다른 수명을 가진다.**
///
/// The identifier must be unguessable: knowing it lets a relay caller probe
/// whether this hub is online. The QR invitation discloses it to the recipient.
pub fn load_or_create_server_id(root: &Path) -> Result<String, IdentityError> {
    let path = server_id_path(root);
    if path.is_file() {
        let stored = std::fs::read_to_string(&path)?;
        let stored = stored.trim().to_string();
        // 빈 파일은 "아직 없음" 이 아니라 **망가진 상태**다. 조용히 새로
        // 만들면 릴레이에 등록된 이름이 바뀌고, 폰들은 이유 없이 못 붙는다.
        if stored.is_empty() {
            return Err(IdentityError::Corrupt("The saved server ID is empty"));
        }
        return Ok(stored);
    }

    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| IdentityError::Generate(format!("Could not read random bytes: {error}")))?;
    let server_id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, &server_id)?;
    Ok(server_id)
}

/// 이 기계의 인증서. 없으면 만들고, 있으면 그대로 쓴다.
///
/// 만들 때 개인키를 0600 으로 쓴다. 앱 데이터 디렉터리는 보통 사용자만 읽을 수
/// 있지만, 그 가정에 기대지 않고 직접 좁힌다 — 이 키를 가진 쪽은 이 기계인
/// 척할 수 있고, 폰은 지문만 보고 믿는다.
pub fn load_or_create_certificate(root: &Path) -> Result<HubCertificate, IdentityError> {
    let certificate = certificate_path(root);
    let key = key_path(root);
    if certificate.is_file() && key.is_file() {
        let der = std::fs::read(&certificate)?;
        let private_key_der = std::fs::read(&key)?;
        if der.is_empty() || private_key_der.is_empty() {
            return Err(IdentityError::Corrupt("The file is empty"));
        }
        return Ok(HubCertificate {
            der,
            private_key_der,
        });
    }

    std::fs::create_dir_all(root)?;
    // 이름은 아무 이름이나 되지 않는다. 폰이 지문을 고정하므로 이름 검증은 하지
    // 않지만, rustls 가 인증서를 만들려면 SAN 이 하나는 있어야 한다.
    let mut params = rcgen::CertificateParams::new(vec!["hebbian-hub.local".to_string()])
        .map_err(|error| IdentityError::Generate(error.to_string()))?;
    params.distinguished_name = rcgen::DistinguishedName::new();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "Hebbian hub");

    let key_pair =
        rcgen::KeyPair::generate().map_err(|error| IdentityError::Generate(error.to_string()))?;
    let generated = params
        .self_signed(&key_pair)
        .map_err(|error| IdentityError::Generate(error.to_string()))?;

    let der = generated.der().to_vec();
    let private_key_der = key_pair.serialize_der();

    write_private(&key, &private_key_der)?;
    std::fs::write(&certificate, &der)?;
    Ok(HubCertificate {
        der,
        private_key_der,
    })
}

/// 소유자만 읽을 수 있게 쓴다. 개인키와 기기 토큰이 같은 값어치라 같은 함수를
/// 쓴다 — 둘 중 하나만 새어도 이 허브에 붙을 수 있다.
pub(super) fn write_private(path: &Path, bytes: &[u8]) -> Result<(), IdentityError> {
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        // `create_new` 이 아니라 `create(true).truncate(true)`: 여기 오는 경로는
        // 파일이 없을 때뿐이지만, 반쯤 쓰다 만 파일이 남아 있었다면 덮어써야
        // 한다 — 그 상태로 두면 매번 "비어 있습니다" 로 실패한다.
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(bytes)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)?;
        Ok(())
    }
}

/// 페어링된 기기 하나가 이 허브에 자신을 증명하는 값.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeviceToken {
    /// 기기 id. 취소할 때 이것으로 고른다.
    pub device_id: String,
    /// 사람이 읽는 이름.
    pub label: String,
    /// base64url. 폰이 붙을 때 이 값을 보낸다.
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push: Option<dure_hub_protocol::push::PushSubscription>,
}

/// 새 기기 토큰. 32바이트 OS 난수.
///
/// 시드된 생성기를 쓰지 않는다 — fork 나 스냅샷이 사용자 공간 상태를 복제할 수
/// 있고, 같은 토큰이 두 기기에 나가면 취소가 무엇을 취소하는지 알 수 없게 된다.
pub fn mint_token(device_id: String, label: String) -> Result<DeviceToken, IdentityError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| IdentityError::Generate(format!("Could not read random bytes: {error}")))?;
    Ok(DeviceToken {
        device_id,
        label,
        token: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes),
        push: None,
    })
}

/// 제시된 토큰이 등록된 기기 중 하나인지.
///
/// **상수 시간 비교**를 쓰는 이유: 보통의 `==` 는 첫 다른 바이트에서 멈추므로,
/// 붙었다 끊기는 시간을 재는 것만으로 토큰을 한 바이트씩 알아낼 수 있다. 이
/// 리스너는 네트워크에 열려 있고 공격자가 원하는 만큼 시도할 수 있다.
///
/// 길이가 다르면 즉시 실패하는 것은 상수 시간이 아니지만 문제되지 않는다 —
/// 토큰 길이는 비밀이 아니고 페이로드 형식에서 이미 드러난다.
#[must_use]
pub fn authenticate<'a>(
    presented: &str,
    devices: &'a [DeviceToken],
) -> Option<&'a DeviceToken> {
    let presented = presented.as_bytes();
    let mut found = None;
    for device in devices {
        let known = device.token.as_bytes();
        if known.len() != presented.len() {
            continue;
        }
        // 찾은 뒤에도 순회를 멈추지 않는다. 일찍 빠져나가면 몇 번째 기기가
        // 맞았는지가 시간으로 드러나고, 그건 등록 순서에 대한 정보다.
        if known.ct_eq(presented).into() {
            found = Some(device);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_certificate_is_created_once_and_reused() {
        let root = tempfile::tempdir().unwrap();

        let first = load_or_create_certificate(root.path()).expect("first run creates one");
        let second = load_or_create_certificate(root.path()).expect("second run reuses it");

        // 켤 때마다 새로 만들면 지문이 바뀌고, 폰이 고정해 둔 값과 어긋나
        // 페어링이 켤 때마다 깨진다.
        assert_eq!(first.fingerprint(), second.fingerprint());
        assert_eq!(first.der, second.der);
    }

    #[test]
    fn the_fingerprint_is_the_shape_the_phone_already_pins() {
        let root = tempfile::tempdir().unwrap();
        let certificate = load_or_create_certificate(root.path()).unwrap();

        let fingerprint = certificate.fingerprint();

        assert!(fingerprint.starts_with("SHA256:"), "{fingerprint}");
        // base64(32바이트) = 43자, 패딩 없음.
        assert_eq!(fingerprint.len(), "SHA256:".len() + 43, "{fingerprint}");
        assert_eq!(fingerprint, fingerprint_of_der(&certificate.der));
    }

    /// 다른 기계는 다른 지문이어야 한다 — 아니면 고정이 아무것도 구별하지 못한다.
    #[test]
    fn two_machines_do_not_share_a_fingerprint() {
        let one = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();

        let first = load_or_create_certificate(one.path()).unwrap();
        let second = load_or_create_certificate(other.path()).unwrap();

        assert_ne!(first.fingerprint(), second.fingerprint());
    }

    #[cfg(unix)]
    #[test]
    fn the_private_key_is_not_readable_by_others() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = tempfile::tempdir().unwrap();
        load_or_create_certificate(root.path()).unwrap();

        let mode = std::fs::metadata(key_path(root.path()))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;

        // 이 키를 가진 쪽은 이 기계인 척할 수 있고, 폰은 지문만 보고 믿는다.
        assert_eq!(mode, 0o600, "{mode:o}");
    }

    /// Reject incomplete stored identity files as corrupt.
    #[test]
    fn an_empty_stored_certificate_is_named_rather_than_used() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path()).unwrap();
        std::fs::write(certificate_path(root.path()), b"").unwrap();
        std::fs::write(key_path(root.path()), b"").unwrap();

        let error = load_or_create_certificate(root.path()).unwrap_err();

        assert!(matches!(error, IdentityError::Corrupt(_)));
    }

    #[test]
    fn a_minted_token_is_unpredictable_and_unique() {
        let first = mint_token("a".into(), "폰".into()).unwrap();
        let second = mint_token("b".into(), "태블릿".into()).unwrap();

        assert_ne!(first.token, second.token);
        // base64url(32바이트) = 43자.
        assert_eq!(first.token.len(), 43, "{}", first.token);
    }

    #[test]
    fn the_right_token_names_the_device_that_holds_it() {
        let phone = mint_token("phone".into(), "폰".into()).unwrap();
        let tablet = mint_token("tablet".into(), "태블릿".into()).unwrap();
        let devices = vec![phone.clone(), tablet.clone()];

        assert_eq!(
            authenticate(&phone.token, &devices).map(|d| d.device_id.as_str()),
            Some("phone")
        );
        assert_eq!(
            authenticate(&tablet.token, &devices).map(|d| d.device_id.as_str()),
            Some("tablet")
        );
    }

    #[test]
    fn a_wrong_token_authenticates_nothing() {
        let phone = mint_token("phone".into(), "폰".into()).unwrap();
        let devices = vec![phone.clone()];

        for wrong in [
            "",
            "short",
            // 한 글자만 다른 값. 상수 시간 비교가 실제로 비교하는지 본다.
            &format!("{}x", &phone.token[..phone.token.len() - 1]),
            &"A".repeat(43),
        ] {
            assert!(authenticate(wrong, &devices).is_none(), "{wrong:?}");
        }
    }

    /// 기기를 지우면 그 토큰이 죽고, 나머지는 살아 있어야 한다. 하나를 공유하면
    /// 기기 하나를 취소할 때 나머지가 함께 죽는다.
    #[test]
    fn revoking_one_device_leaves_the_others_working() {
        let phone = mint_token("phone".into(), "폰".into()).unwrap();
        let tablet = mint_token("tablet".into(), "태블릿".into()).unwrap();

        let remaining = vec![tablet.clone()];

        assert!(authenticate(&phone.token, &remaining).is_none());
        assert!(authenticate(&tablet.token, &remaining).is_some());
    }

    #[test]
    fn no_device_means_nothing_authenticates() {
        let phone = mint_token("phone".into(), "폰".into()).unwrap();
        assert!(authenticate(&phone.token, &[]).is_none());
    }
}
