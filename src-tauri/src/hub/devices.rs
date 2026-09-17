//! 페어링된 기기 목록. 파일 하나가 진실이다.
//!
//! # 왜 메모리에 캐시하지 않나
//!
//! 캐시하면 진실이 둘이 된다: 돌고 있는 리스너가 켤 때 읽은 목록과, 설정 화면이
//! 방금 쓴 파일. 그 둘이 갈라지는 순간이 정확히 취소가 일어나는 순간이다 —
//! "기기를 지웠는데 계속 붙는다" 는 이 종류의 버그다.
//!
//! 그래서 연결마다 파일을 다시 읽는다. 몇백 바이트짜리 JSON 이고 연결은 사람이
//! 만드는 빈도로만 생기므로, 이 읽기가 비용이 되는 지점은 없다. 대신 등록과
//! 취소는 다음 연결부터 즉시 반영된다.
//!
//! # 왜 목록 전체를 다시 쓰나
//!
//! 추가만 하는 형식(append-only)이면 취소가 "지운다" 가 아니라 "지웠다고 적는다"
//! 가 되고, 그 기록을 못 읽으면 취소가 풀린다. 취소는 실패해도 안전한 쪽으로
//! 기울어야 하므로, 남길 것만 적고 통째로 바꿔 쓴다.

use super::identity::{self, DeviceToken, IdentityError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const DEVICES_FILE: &str = "hub-devices.json";

/// 이 형식의 판. 모르는 판은 읽지 않는다 — 잘못 읽으면 등록된 기기를 조용히
/// 잃거나, 더 나쁘게는 취소한 기기를 되살린다.
const DEVICES_VERSION: u16 = 1;

#[derive(Serialize, Deserialize)]
struct DevicesFile {
    hub_devices_version: u16,
    devices: Vec<DeviceToken>,
}

/// 화면이 보는 기기. 토큰은 여기 없다.
///
/// 토큰이 프런트엔드로 나가는 유일한 순간은 방금 만들어 QR 에 실을 때 하나뿐이다
/// (`register` 의 반환값). 목록 조회가 토큰을 함께 주면 그 값이 화면 상태와
/// 개발자 도구와 로그에 계속 살아 있게 된다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PairedDevice {
    pub device_id: String,
    pub label: String,
}

/// 기기 목록 파일과 그 위의 쓰기 직렬화.
pub struct DeviceRegistry {
    path: PathBuf,
    /// 두 등록이 겹쳐 하나가 다른 하나를 덮어쓰는 것을 막는다. 읽기는 잠그지
    /// 않는다 — 읽기는 파일 하나를 통째로 읽으므로 반쯤 읽힌 상태가 없다.
    write_lock: Mutex<()>,
}

impl DeviceRegistry {
    pub(super) fn root(&self) -> &Path {
        self.path
            .parent()
            .expect("Device registry is constructed under a root")
    }

    #[must_use]
    pub fn new(root: &Path) -> Self {
        Self {
            path: root.join(DEVICES_FILE),
            write_lock: Mutex::new(()),
        }
    }

    /// 지금 등록된 기기 전부. 파일이 없으면 빈 목록이다 — 아직 아무도 붙지
    /// 않았다는 뜻이고, 오류가 아니다.
    pub fn load(&self) -> Result<Vec<DeviceToken>, IdentityError> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(IdentityError::Io(error)),
        };
        let file: DevicesFile = serde_json::from_slice(&bytes)
            .map_err(|_| IdentityError::Corrupt("The device list is not valid JSON"))?;
        if file.hub_devices_version != DEVICES_VERSION {
            return Err(IdentityError::Corrupt("Unsupported device list version"));
        }
        Ok(file.devices)
    }

    /// 화면에 보여줄 목록.
    pub fn list(&self) -> Result<Vec<PairedDevice>, IdentityError> {
        Ok(self
            .load()?
            .into_iter()
            .map(|device| PairedDevice {
                device_id: device.device_id,
                label: device.label,
            })
            .collect())
    }

    /// 새 기기를 등록하고 그 토큰을 돌려준다.
    ///
    /// 돌려주는 값에 토큰이 들어 있는 유일한 자리다 — 호출부는 이것을 QR 에
    /// 실어 보내고 버려야 한다. 다시 물어볼 방법은 없다(파일에만 남는다).
    pub fn register(&self, label: String) -> Result<DeviceToken, IdentityError> {
        let guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut devices = self.load()?;
        let minted = identity::mint_token(new_device_id()?, label)?;
        devices.push(minted.clone());
        // 파일에 남긴 뒤에 돌려준다. 순서가 반대면 저장에 실패했을 때 폰은
        // 재시작하면 죽는 토큰을 QR 로 받아 간다.
        self.save(&devices)?;
        drop(guard);
        Ok(minted)
    }

    /// 기기 하나를 지운다. 없던 기기면 `false` — 오류가 아니다. 취소 버튼을 두
    /// 번 누른 것은 실패가 아니다.
    pub fn revoke(&self, device_id: &str) -> Result<bool, IdentityError> {
        let guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let devices = self.load()?;
        let before = devices.len();
        let remaining: Vec<DeviceToken> = devices
            .into_iter()
            .filter(|device| device.device_id != device_id)
            .collect();
        let changed = remaining.len() != before;
        if changed {
            self.save(&remaining)?;
        }
        drop(guard);
        Ok(changed)
    }

    /// Recheck pairing under the same writer lock as revocation. An older
    /// authenticated connection must never recreate a revoked subscription.
    pub fn set_push(
        &self,
        pairing_token: &str,
        subscription: Option<dure_hub_protocol::push::PushSubscription>,
    ) -> Result<(), IdentityError> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut devices = self.load()?;
        let id = identity::authenticate(pairing_token, &devices)
            .ok_or(IdentityError::Corrupt("Device pairing was revoked"))?
            .device_id.clone();
        let device = devices
            .iter_mut()
            .find(|device| device.device_id == id)
            .ok_or(IdentityError::Corrupt("Device pairing was revoked"))?;
        device.push = subscription;
        self.save(&devices)
    }

    /// APNs may retire a token while the phone concurrently registers a new
    /// one. Remove only the exact registration the rejected send used.
    pub fn retire_push(
        &self,
        device_id: &str,
        rejected: &dure_hub_protocol::push::PushSubscription,
    ) -> Result<(), IdentityError> {
        let _guard = self
            .write_lock
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut devices = self.load()?;
        if let Some(device) = devices.iter_mut().find(|device| device.device_id == device_id) {
            if device.push.as_ref() == Some(rejected) {
                device.push = None;
                self.save(&devices)?;
            }
        }
        Ok(())
    }

    fn save(&self, devices: &[DeviceToken]) -> Result<(), IdentityError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_vec_pretty(&DevicesFile {
            hub_devices_version: DEVICES_VERSION,
            devices: devices.to_vec(),
        })
        .map_err(|error| IdentityError::Generate(error.to_string()))?;
        // Readers keep a complete snapshot while token or consent changes.
        // Reuse the private writer, then publish the new file atomically.
        let temporary = tempfile::NamedTempFile::new_in(self.root())?;
        identity::write_private(temporary.path(), &body)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&self.path)
            .map_err(|error| IdentityError::Io(error.error))?;
        Ok(())
    }
}

/// 새 기기 id. 난수인 이유: 이름이나 순번을 쓰면 같은 이름의 폰 두 대가 같은
/// id 를 갖고, 하나를 취소할 때 다른 하나가 함께 죽는다.
fn new_device_id() -> Result<String, IdentityError> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes)
        .map_err(|error| IdentityError::Generate(format!("Could not read random bytes: {error}")))?;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("device_{hex}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_registered_is_an_empty_list_rather_than_an_error() {
        let root = tempfile::tempdir().unwrap();
        let registry = DeviceRegistry::new(root.path());

        assert_eq!(registry.load().unwrap(), Vec::new());
        assert_eq!(registry.list().unwrap(), Vec::new());
    }

    #[test]
    fn a_registered_device_survives_a_restart() {
        let root = tempfile::tempdir().unwrap();
        let minted = DeviceRegistry::new(root.path())
            .register("내 폰".into())
            .expect("등록된다");

        // 다른 인스턴스 — 앱을 껐다 켠 것과 같다.
        let reopened = DeviceRegistry::new(root.path());

        assert_eq!(reopened.load().unwrap(), vec![minted]);
    }

    /// 진실이 파일 하나여야 한다. 리스너가 들고 있는 인스턴스와 설정 화면이 쓰는
    /// 인스턴스가 다른 목록을 보면, 그 순간이 정확히 취소가 일어나는 순간이다.
    #[test]
    fn one_instance_sees_what_another_just_wrote() {
        let root = tempfile::tempdir().unwrap();
        let listener_side = DeviceRegistry::new(root.path());
        let settings_side = DeviceRegistry::new(root.path());

        assert!(listener_side.load().unwrap().is_empty());
        let minted = settings_side.register("폰".into()).unwrap();

        assert_eq!(listener_side.load().unwrap(), vec![minted.clone()]);

        settings_side.revoke(&minted.device_id).unwrap();
        assert!(listener_side.load().unwrap().is_empty());
    }

    #[test]
    fn revoking_one_leaves_the_others() {
        let root = tempfile::tempdir().unwrap();
        let registry = DeviceRegistry::new(root.path());
        let phone = registry.register("폰".into()).unwrap();
        let tablet = registry.register("태블릿".into()).unwrap();

        assert!(registry.revoke(&phone.device_id).unwrap());

        assert_eq!(registry.load().unwrap(), vec![tablet]);
    }

    /// 취소 버튼을 두 번 누른 것은 실패가 아니다.
    #[test]
    fn revoking_an_unknown_device_says_nothing_changed_rather_than_failing() {
        let root = tempfile::tempdir().unwrap();
        let registry = DeviceRegistry::new(root.path());
        registry.register("폰".into()).unwrap();

        assert!(!registry.revoke("device_없음").unwrap());
        assert_eq!(registry.load().unwrap().len(), 1);
    }

    #[test]
    fn two_devices_never_share_an_id_or_a_token() {
        let root = tempfile::tempdir().unwrap();
        let registry = DeviceRegistry::new(root.path());

        // 같은 이름을 준다 — 이름으로 id 를 만들면 여기서 겹친다.
        let first = registry.register("폰".into()).unwrap();
        let second = registry.register("폰".into()).unwrap();

        assert_ne!(first.device_id, second.device_id);
        assert_ne!(first.token, second.token);
        assert_eq!(registry.load().unwrap().len(), 2);
    }

    /// 목록 조회는 토큰을 주지 않는다. 주면 그 값이 화면 상태와 개발자 도구와
    /// 로그에 계속 살아 있게 된다.
    #[test]
    fn listing_devices_does_not_hand_out_their_tokens() {
        let root = tempfile::tempdir().unwrap();
        let registry = DeviceRegistry::new(root.path());
        let phone = registry.register("내 폰".into()).unwrap();

        let listed = registry.list().unwrap();

        assert_eq!(
            listed,
            vec![PairedDevice {
                device_id: phone.device_id,
                label: "내 폰".into()
            }]
        );
        let rendered = serde_json::to_string(&listed).unwrap();
        assert!(!rendered.contains(&phone.token), "{rendered}");
    }

    /// 읽을 수 없는 파일을 빈 목록으로 취급하면 등록된 기기를 조용히 잃는다 —
    /// 그리고 다음 등록이 그 파일을 덮어써 되돌릴 수 없게 만든다.
    #[test]
    fn an_unreadable_list_is_named_rather_than_treated_as_empty() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(DEVICES_FILE), "{ 이건 JSON 이 아니다").unwrap();
        let registry = DeviceRegistry::new(root.path());

        assert!(matches!(
            registry.load().unwrap_err(),
            IdentityError::Corrupt(_)
        ));
        assert!(registry.register("폰".into()).is_err());
    }

    #[test]
    fn a_version_this_build_does_not_know_is_refused() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join(DEVICES_FILE),
            serde_json::to_vec(&serde_json::json!({
                "hub_devices_version": 999,
                "devices": [],
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(matches!(
            DeviceRegistry::new(root.path()).load().unwrap_err(),
            IdentityError::Corrupt(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn the_list_is_not_readable_by_others() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = tempfile::tempdir().unwrap();
        let registry = DeviceRegistry::new(root.path());
        registry.register("폰".into()).unwrap();

        let mode = std::fs::metadata(root.path().join(DEVICES_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;

        // 토큰이 들어 있다 — 개인키와 같은 값어치다.
        assert_eq!(mode, 0o600, "{mode:o}");
    }
}
