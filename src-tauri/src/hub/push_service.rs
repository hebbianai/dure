//! Where this computer's phone alerts go, and what the push service's answers
//! mean (#660).
//!
//! Every build sends to the official service compiled in here. A fork or a
//! community build that runs its own service names it in
//! `hub-push-service.json` in the Hub root, beside `hub-devices.json`. The
//! person writes that file and this computer only reads it, again on every
//! use, so a change takes effect without a restart. A file that is present
//! but cannot be used turns alerts off: falling back to the official service
//! would hand a self-hoster's phone tokens to a service they chose not to use.
use super::commands::HubState;
use dure_hub_protocol::push::PushRefusal;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The official push service, as a base URL that ends in '/'. A source
/// constant like the default relay: the address is no secret, and community
/// and development builds should reach it with no build wiring.
pub const OFFICIAL_PUSH_SERVICE: &str = "https://push.dureai.dev/";

const OVERRIDE_FILE: &str = "hub-push-service.json";
const OVERRIDE_VERSION: u16 = 1;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OverrideFile {
    hub_push_service_version: u16,
    endpoint: String,
}

/// One request the push service serves, joined onto its base URL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushRoute {
    RegisterV1,
    SendV1,
}

impl PushRoute {
    fn path(self) -> &'static str {
        match self {
            Self::RegisterV1 => "v1/register",
            Self::SendV1 => "v1/send",
        }
    }
}

/// The push service this computer uses right now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedService {
    base: reqwest::Url,
    official: bool,
}

impl ResolvedService {
    pub fn url(&self, route: PushRoute) -> reqwest::Url {
        self.base
            .join(route.path())
            .expect("A route is a relative path under a validated HTTPS base")
    }
}

/// Reads which service to use. Absent override file: the official service.
/// An override that cannot be read or used: [`PushRefusal::NotConfigured`],
/// never the official service.
pub fn resolve(root: &Path) -> Result<ResolvedService, PushRefusal> {
    let bytes = match std::fs::read(root.join(OVERRIDE_FILE)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ResolvedService {
                base: base_url(OFFICIAL_PUSH_SERVICE)?,
                official: true,
            });
        }
        Err(_) => return Err(PushRefusal::NotConfigured),
    };
    let file: OverrideFile =
        serde_json::from_slice(&bytes).map_err(|_| PushRefusal::NotConfigured)?;
    if file.hub_push_service_version != OVERRIDE_VERSION {
        return Err(PushRefusal::NotConfigured);
    }
    Ok(ResolvedService {
        base: base_url(&file.endpoint)?,
        official: false,
    })
}

/// HTTPS with no credentials, query or fragment, normalized to end in '/' so
/// `https://host/push` serves `https://host/push/v1/send`.
fn base_url(endpoint: &str) -> Result<reqwest::Url, PushRefusal> {
    let mut url = reqwest::Url::parse(endpoint).map_err(|_| PushRefusal::NotConfigured)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(PushRefusal::NotConfigured);
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

/// How one request to the push service ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushAnswer {
    /// Taken: registered, or handed to APNs (also a duplicate or filtered
    /// event, which the service answers as done).
    Accepted,
    /// APNs no longer accepts the token. The exact subscription is retired.
    Retired,
    /// Sending the same request again will not pass until the phone, this
    /// computer or the service changes.
    Refused(PushRefusal),
    /// The service could not take it now; the same request may pass later.
    Unavailable(PushRefusal),
}

/// The meaning of the service's answer to `route`. `status` is None when no
/// HTTP answer arrived.
///
/// Every `/v1` answer is typed by its HTTP status alone. A forbidden
/// registration means the service did not authorize this computer, which
/// only a phone that hands it a grant can change.
pub fn read_answer(route: PushRoute, status: Option<u16>) -> PushAnswer {
    let Some(status) = status else {
        return PushAnswer::Unavailable(PushRefusal::ServiceUnreachable);
    };
    match status {
        200 | 202 => PushAnswer::Accepted,
        410 => PushAnswer::Retired,
        404 => PushAnswer::Refused(PushRefusal::ServiceOutdated),
        429 => PushAnswer::Unavailable(PushRefusal::RateLimited),
        403 => PushAnswer::Refused(match route {
            PushRoute::RegisterV1 => PushRefusal::PhoneUpdateRequired,
            PushRoute::SendV1 => PushRefusal::Refused,
        }),
        400..=499 => PushAnswer::Refused(PushRefusal::Refused),
        _ => PushAnswer::Unavailable(PushRefusal::ServiceUnreachable),
    }
}

/// Which service Settings names. Only a custom service is shown, because it
/// receives the alert tokens of every phone paired with this computer.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PushServiceStatus {
    Official,
    Custom { origin: String },
    NotConfigured,
}

pub fn status(root: &Path) -> PushServiceStatus {
    match resolve(root) {
        Ok(service) if service.official => PushServiceStatus::Official,
        Ok(service) => PushServiceStatus::Custom {
            origin: service.base.origin().ascii_serialization(),
        },
        Err(_) => PushServiceStatus::NotConfigured,
    }
}

#[tauri::command]
pub fn hub_push_service_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, HubState>,
) -> Result<PushServiceStatus, String> {
    Ok(status(state.registry(&app)?.root()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_override(root: &Path, endpoint: &str) {
        std::fs::write(
            root.join(OVERRIDE_FILE),
            serde_json::to_vec(&serde_json::json!({
                "hub_push_service_version": 1,
                "endpoint": endpoint,
            }))
            .unwrap(),
        )
        .unwrap();
    }

    fn send_url(root: &Path) -> Result<String, PushRefusal> {
        resolve(root).map(|service| service.url(PushRoute::SendV1).to_string())
    }

    #[test]
    fn without_an_override_both_routes_go_to_the_official_service() {
        let root = tempfile::tempdir().unwrap();
        let service = resolve(root.path()).unwrap();
        assert!(service.official);
        assert_eq!(
            service.url(PushRoute::RegisterV1).as_str(),
            "https://push.dureai.dev/v1/register"
        );
        assert_eq!(
            service.url(PushRoute::SendV1).as_str(),
            "https://push.dureai.dev/v1/send"
        );
        assert_eq!(status(root.path()), PushServiceStatus::Official);
    }

    #[test]
    fn a_custom_base_keeps_its_path_and_names_its_origin() {
        let root = tempfile::tempdir().unwrap();
        for (endpoint, expected) in [
            ("https://host.example", "https://host.example/v1/send"),
            (
                "https://host.example/push",
                "https://host.example/push/v1/send",
            ),
            (
                "https://host.example/push/",
                "https://host.example/push/v1/send",
            ),
            (
                "https://host.example:8443/a/b",
                "https://host.example:8443/a/b/v1/send",
            ),
        ] {
            write_override(root.path(), endpoint);
            assert_eq!(send_url(root.path()).unwrap(), expected, "{endpoint}");
            assert!(!resolve(root.path()).unwrap().official);
        }
        assert_eq!(
            status(root.path()),
            PushServiceStatus::Custom {
                origin: "https://host.example:8443".into()
            }
        );
    }

    #[test]
    fn an_override_that_cannot_be_used_turns_alerts_off_instead_of_falling_back() {
        let root = tempfile::tempdir().unwrap();
        for endpoint in [
            "http://host.example/",
            "https://user@host.example/",
            "https://user:secret@host.example/",
            "https://host.example/?topic=x",
            "https://host.example/?",
            "https://host.example/#x",
            "file:///etc/hosts",
            "not a url",
        ] {
            write_override(root.path(), endpoint);
            assert_eq!(
                send_url(root.path()),
                Err(PushRefusal::NotConfigured),
                "{endpoint}"
            );
        }
        let path = root.path().join(OVERRIDE_FILE);
        for body in [
            r#"{"hub_push_service_version": 2, "endpoint": "https://host.example/"}"#,
            r#"{"endpoint": "https://host.example/"}"#,
            r#"{"hub_push_service_version": 1, "endpoint": "https://host.example/", "extra": 1}"#,
            "{ not json",
            "",
        ] {
            std::fs::write(&path, body).unwrap();
            assert_eq!(
                send_url(root.path()),
                Err(PushRefusal::NotConfigured),
                "{body}"
            );
        }
        assert_eq!(status(root.path()), PushServiceStatus::NotConfigured);
        // Present but unreadable as a file.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert_eq!(send_url(root.path()), Err(PushRefusal::NotConfigured));
    }

    #[test]
    fn a_changed_override_is_read_on_the_next_use() {
        let root = tempfile::tempdir().unwrap();
        write_override(root.path(), "https://one.example/");
        assert_eq!(
            send_url(root.path()).unwrap(),
            "https://one.example/v1/send"
        );
        write_override(root.path(), "https://two.example/");
        assert_eq!(
            send_url(root.path()).unwrap(),
            "https://two.example/v1/send"
        );
        std::fs::remove_file(root.path().join(OVERRIDE_FILE)).unwrap();
        assert_eq!(
            send_url(root.path()).unwrap(),
            "https://push.dureai.dev/v1/send"
        );
    }

    #[test]
    fn each_answer_reads_as_one_outcome() {
        use PushAnswer::*;
        use PushRefusal::{PhoneUpdateRequired, RateLimited, ServiceOutdated, ServiceUnreachable};
        use PushRoute::*;
        let cases = [
            (SendV1, Some(200), Accepted),
            (SendV1, Some(202), Accepted),
            (RegisterV1, Some(200), Accepted),
            (SendV1, Some(410), Retired),
            (SendV1, Some(404), Refused(ServiceOutdated)),
            (RegisterV1, Some(404), Refused(ServiceOutdated)),
            (SendV1, Some(429), Unavailable(RateLimited)),
            (RegisterV1, Some(429), Unavailable(RateLimited)),
            (SendV1, Some(403), Refused(PushRefusal::Refused)),
            (RegisterV1, Some(403), Refused(PhoneUpdateRequired)),
            (SendV1, Some(413), Refused(PushRefusal::Refused)),
            (SendV1, Some(500), Unavailable(ServiceUnreachable)),
            (SendV1, Some(502), Unavailable(ServiceUnreachable)),
            (SendV1, Some(503), Unavailable(ServiceUnreachable)),
            (SendV1, Some(301), Unavailable(ServiceUnreachable)),
            (SendV1, Some(204), Unavailable(ServiceUnreachable)),
            (SendV1, None, Unavailable(ServiceUnreachable)),
            (RegisterV1, None, Unavailable(ServiceUnreachable)),
        ];
        for (route, status, expected) in cases {
            assert_eq!(read_answer(route, status), expected, "{route:?} {status:?}");
        }
    }

    #[test]
    fn the_status_names_its_kind_for_the_settings_page() {
        assert_eq!(
            serde_json::to_value(PushServiceStatus::Custom {
                origin: "https://host.example".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "custom", "origin": "https://host.example" })
        );
        assert_eq!(
            serde_json::to_value(PushServiceStatus::NotConfigured).unwrap(),
            serde_json::json!({ "kind": "not_configured" })
        );
    }
}
