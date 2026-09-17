//! Native desktop notification adapter.
//!
//! The renderer owns notification preferences and attention policy. This module
//! only reports the OS authorization state and returns an honest receipt for one
//! dispatch attempt. In macOS development builds the executable is not the
//! installed app bundle, so it targets the stable Dure bundle identity instead
//! of leaking notifications through Terminal or System Events. macOS owns the
//! Temporary/Persistent display duration; this adapter only reports that style.

use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
#[cfg(target_os = "macos")]
use std::path::Path;
use std::sync::{Mutex, OnceLock};

pub(crate) const DURE_BUNDLE_IDENTIFIER: &str = "io.hebbian.ade";
const SYSTEM_DEFAULT_SOUND_MARKER: &str = "__dure_system_default__";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeNotificationSound<'a> {
    Silent,
    Default,
    Named(&'a str),
}

pub(crate) fn native_notification_sound(sound: Option<&str>) -> NativeNotificationSound<'_> {
    match sound.filter(|value| !value.is_empty()) {
        None => NativeNotificationSound::Silent,
        Some(SYSTEM_DEFAULT_SOUND_MARKER) => NativeNotificationSound::Default,
        Some(name) => NativeNotificationSound::Named(name),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationAuthorization {
    Authorized,
    Denied,
    NotDetermined,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationSender {
    DureApp,
    DureInstalledBridge,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationPresentation {
    Temporary,
    Persistent,
    Disabled,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NativeNotificationSettings {
    authorization: NotificationAuthorization,
    presentation: NotificationPresentation,
}

impl NativeNotificationSettings {
    const UNKNOWN: Self = Self {
        authorization: NotificationAuthorization::Unknown,
        presentation: NotificationPresentation::Unknown,
    };

    const fn with_authorization(authorization: NotificationAuthorization) -> Self {
        Self {
            authorization,
            presentation: NotificationPresentation::Unknown,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationStatus {
    authorization: NotificationAuthorization,
    sender: NotificationSender,
    bundle_identifier: &'static str,
    presentation: NotificationPresentation,
    detail: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationDispatchReceipt {
    accepted: bool,
    authorization: NotificationAuthorization,
    sender: NotificationSender,
    bundle_identifier: &'static str,
    presentation: NotificationPresentation,
    reason: Option<&'static str>,
    detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationPaneTarget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) window_label: Option<String>,
    pub(crate) desktop_id: String,
    pub(crate) panel_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationActivation {
    pub(crate) activation_id: String,
    pub(crate) pane_target: NotificationPaneTarget,
}

#[derive(Default)]
struct NotificationEventDedupe {
    order: VecDeque<String>,
    ids: HashSet<String>,
}

impl NotificationEventDedupe {
    fn claim(&mut self, event_id: &str, limit: usize) -> bool {
        if self.ids.contains(event_id) {
            return false;
        }
        self.ids.insert(event_id.to_string());
        self.order.push_back(event_id.to_string());
        while self.order.len() > limit {
            if let Some(retired) = self.order.pop_front() {
                self.ids.remove(&retired);
            }
        }
        true
    }

    fn release(&mut self, event_id: &str) {
        self.ids.remove(event_id);
        self.order.retain(|candidate| candidate != event_id);
    }
}

fn event_dedupe() -> &'static Mutex<NotificationEventDedupe> {
    static DEDUPE: OnceLock<Mutex<NotificationEventDedupe>> = OnceLock::new();
    DEDUPE.get_or_init(|| Mutex::new(NotificationEventDedupe::default()))
}

pub(crate) fn release_notification_event(event_id: &str) {
    event_dedupe()
        .lock()
        .expect("notification event dedupe lock poisoned")
        .release(event_id);
}

#[cfg(target_os = "macos")]
fn is_bundled_stable_dure_identity(
    configured_identifier: &str,
    executable: &Path,
    native_identifier: Option<&str>,
) -> bool {
    configured_identifier == DURE_BUNDLE_IDENTIFIER
        && native_identifier == Some(DURE_BUNDLE_IDENTIFIER)
        && crate::macos_notification_center::is_bundled_app_executable(executable)
}

fn is_bundled_stable_dure(app: &tauri::AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        let Ok(executable) = std::env::current_exe() else {
            return false;
        };
        let native_identifier = crate::macos_notification_center::native_bundle_identifier();
        is_bundled_stable_dure_identity(
            &app.config().identifier,
            &executable,
            native_identifier.as_deref(),
        )
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.config().identifier == DURE_BUNDLE_IDENTIFIER
    }
}

fn sender_for(app: &tauri::AppHandle) -> NotificationSender {
    if is_bundled_stable_dure(app) {
        NotificationSender::DureApp
    } else {
        NotificationSender::DureInstalledBridge
    }
}

fn status(
    settings: NativeNotificationSettings,
    sender: NotificationSender,
    detail: Option<String>,
) -> NotificationStatus {
    NotificationStatus {
        authorization: settings.authorization,
        sender,
        bundle_identifier: DURE_BUNDLE_IDENTIFIER,
        presentation: settings.presentation,
        detail,
    }
}

fn rejected(
    settings: NativeNotificationSettings,
    sender: NotificationSender,
    reason: &'static str,
    detail: Option<String>,
) -> NotificationDispatchReceipt {
    NotificationDispatchReceipt {
        accepted: false,
        authorization: settings.authorization,
        sender,
        bundle_identifier: DURE_BUNDLE_IDENTIFIER,
        presentation: settings.presentation,
        reason: Some(reason),
        detail,
    }
}

#[cfg(target_os = "macos")]
fn notification_presentation(
    alert_style: objc2_user_notifications::UNAlertStyle,
) -> NotificationPresentation {
    use objc2_user_notifications::UNAlertStyle;

    match alert_style {
        UNAlertStyle::Banner => NotificationPresentation::Temporary,
        UNAlertStyle::Alert => NotificationPresentation::Persistent,
        UNAlertStyle::None => NotificationPresentation::Disabled,
        _ => NotificationPresentation::Unknown,
    }
}

#[cfg(target_os = "macos")]
fn native_settings() -> Result<NativeNotificationSettings, String> {
    use block2::RcBlock;
    use objc2_user_notifications::{
        UNAuthorizationStatus, UNNotificationSettings, UNUserNotificationCenter,
    };
    use std::ptr::NonNull;
    use std::sync::mpsc;
    use std::time::Duration;

    let (sender, receiver) = mpsc::sync_channel(1);
    let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        // SAFETY: UserNotifications owns this non-null settings object for the
        // duration of the completion handler.
        let settings = unsafe { settings.as_ref() };
        let authorization = match settings.authorizationStatus() {
            UNAuthorizationStatus::NotDetermined => NotificationAuthorization::NotDetermined,
            UNAuthorizationStatus::Denied => NotificationAuthorization::Denied,
            UNAuthorizationStatus::Authorized
            | UNAuthorizationStatus::Provisional
            | UNAuthorizationStatus::Ephemeral => NotificationAuthorization::Authorized,
            _ => NotificationAuthorization::Unknown,
        };
        let _ = sender.send(NativeNotificationSettings {
            authorization,
            presentation: notification_presentation(settings.alertStyle()),
        });
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .getNotificationSettingsWithCompletionHandler(&handler);
    receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|error| format!("notification authorization query timed out: {error}"))
}

#[cfg(target_os = "macos")]
fn native_request_authorization() -> Result<NotificationAuthorization, String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_foundation::NSError;
    use objc2_user_notifications::{UNAuthorizationOptions, UNUserNotificationCenter};
    use std::sync::mpsc;
    use std::time::Duration;

    let (sender, receiver) = mpsc::sync_channel(1);
    let handler = RcBlock::new(move |granted: Bool, error: *mut NSError| {
        let result = if error.is_null() {
            Ok(granted.as_bool())
        } else {
            // SAFETY: UserNotifications owns this NSError for the duration of
            // the completion handler and guarantees a valid pointer here.
            let detail = unsafe { error.as_ref() }
                .map(|error| error.localizedDescription().to_string())
                .unwrap_or_else(|| {
                    "macOS rejected the notification authorization request".to_string()
                });
            Err(detail)
        };
        let _ = sender.send(result);
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &handler,
        );
    match receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|error| format!("notification authorization request timed out: {error}"))??
    {
        true => Ok(NotificationAuthorization::Authorized),
        false => Ok(NotificationAuthorization::Denied),
    }
}

#[cfg(target_os = "macos")]
pub(crate) async fn query_native_authorization() -> Result<NotificationAuthorization, String> {
    query_native_settings().await.map(|settings| settings.authorization)
}

#[cfg(target_os = "macos")]
async fn query_native_settings() -> Result<NativeNotificationSettings, String> {
    tokio::task::spawn_blocking(native_settings)
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(target_os = "macos")]
pub(crate) async fn request_native_authorization() -> Result<NotificationAuthorization, String> {
    tokio::task::spawn_blocking(native_request_authorization)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command(async)]
pub async fn notification_status(app: tauri::AppHandle) -> NotificationStatus {
    let sender = sender_for(&app);
    #[cfg(target_os = "macos")]
    {
        if sender == NotificationSender::DureInstalledBridge {
            return status(
                NativeNotificationSettings::UNKNOWN,
                sender,
                Some(
                    "development builds deliver through the installed Dure bundle identity"
                        .to_string(),
                ),
            );
        }
        match query_native_settings().await {
            Ok(settings) => status(settings, sender, None),
            Err(error) => {
                eprintln!("[notification] authorization query failed: {error}");
                status(NativeNotificationSettings::UNKNOWN, sender, Some(error))
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        status(NativeNotificationSettings::UNKNOWN, sender, None)
    }
}

#[tauri::command(async)]
pub async fn notification_request_authorization(app: tauri::AppHandle) -> NotificationStatus {
    let sender = sender_for(&app);
    #[cfg(target_os = "macos")]
    {
        if sender == NotificationSender::DureInstalledBridge {
            return status(
                NativeNotificationSettings::UNKNOWN,
                sender,
                Some(
                    "open the installed Dure notification settings or send a test notification"
                        .to_string(),
                ),
            );
        }
        match request_native_authorization().await {
            Ok(authorization) => match query_native_settings().await {
                Ok(settings) => status(settings, sender, None),
                Err(error) => status(
                    NativeNotificationSettings::with_authorization(authorization),
                    sender,
                    Some(error),
                ),
            },
            Err(error) => {
                eprintln!("[notification] authorization request failed: {error}");
                status(NativeNotificationSettings::UNKNOWN, sender, Some(error))
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        status(NativeNotificationSettings::UNKNOWN, sender, None)
    }
}

#[tauri::command(async)]
pub async fn notification_dispatch(
    app: tauri::AppHandle,
    title: String,
    body: String,
    sound: Option<String>,
    event_id: Option<String>,
    pane_target: Option<NotificationPaneTarget>,
) -> NotificationDispatchReceipt {
    let sender = sender_for(&app);
    #[cfg(target_os = "macos")]
    let (settings, authorization_detail) = if sender == NotificationSender::DureApp {
        match query_native_settings().await {
            Ok(settings) => (settings, None),
            Err(error) => {
                eprintln!("[notification] authorization query failed before dispatch: {error}");
                (NativeNotificationSettings::UNKNOWN, Some(error))
            }
        }
    } else {
        (NativeNotificationSettings::UNKNOWN, None)
    };
    #[cfg(not(target_os = "macos"))]
    let settings = NativeNotificationSettings::UNKNOWN;
    #[cfg(not(target_os = "macos"))]
    let authorization_detail = None;

    if settings.authorization == NotificationAuthorization::Denied {
        return rejected(settings, sender, "permission-denied", None);
    }
    if settings.authorization == NotificationAuthorization::NotDetermined {
        return rejected(settings, sender, "permission-not-requested", None);
    }

    let exact_event_id = event_id.filter(|value| !value.is_empty());
    if exact_event_id.as_deref().is_some_and(|event_id| {
        !event_dedupe()
            .lock()
            .expect("notification event dedupe lock poisoned")
            .claim(event_id, 256)
    }) {
        return rejected(settings, sender, "duplicate-event", None);
    }

    #[cfg(target_os = "macos")]
    let dispatch_event_id = exact_event_id.clone();
    #[cfg(target_os = "macos")]
    let result = tokio::task::spawn_blocking(move || {
        if sender == NotificationSender::DureApp {
            crate::macos_notification_center::dispatch(
                &title,
                &body,
                sound.as_deref(),
                dispatch_event_id.as_deref(),
                pane_target.as_ref(),
            )
        } else {
            crate::macos_notification_bridge::dispatch(
                &title,
                &body,
                sound.as_deref(),
                dispatch_event_id.as_deref(),
                pane_target.as_ref(),
            )
        }
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);

    #[cfg(not(target_os = "macos"))]
    let result = {
        let _ = pane_target;
        use tauri_plugin_notification::NotificationExt;
        let mut builder = app.notification().builder().title(title).body(body);
        match native_notification_sound(sound.as_deref()) {
            NativeNotificationSound::Silent => {}
            NativeNotificationSound::Default => {
                builder = builder.sound("default");
            }
            NativeNotificationSound::Named(name) => {
                builder = builder.sound(name);
            }
        }
        builder.show().map_err(|error| error.to_string())
    };

    match result {
        Ok(()) => NotificationDispatchReceipt {
            accepted: true,
            authorization: settings.authorization,
            sender,
            bundle_identifier: DURE_BUNDLE_IDENTIFIER,
            presentation: settings.presentation,
            reason: None,
            detail: authorization_detail,
        },
        Err(error) => {
            if let Some(event_id) = exact_event_id.as_deref() {
                release_notification_event(event_id);
            }
            let detail = authorization_detail
                .map(|authorization_error| format!("{authorization_error}; dispatch: {error}"))
                .unwrap_or_else(|| error.clone());
            eprintln!("[notification] dispatch failed: {error}");
            rejected(settings, sender, "dispatch-failed", Some(detail))
        }
    }
}

#[tauri::command]
pub fn notification_activation_take(
    window: tauri::WebviewWindow,
) -> Option<NotificationActivation> {
    #[cfg(target_os = "macos")]
    {
        crate::macos_notification_center::take_activation(window.label())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[tauri::command(async)]
pub async fn notification_open_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let bundle_identifier = if is_bundled_stable_dure(&app) {
            app.config().identifier.as_str()
        } else {
            DURE_BUNDLE_IDENTIFIER
        };
        let url = format!(
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={bundle_identifier}"
        );
        let status = std::process::Command::new("open")
            .arg(url)
            .status()
            .map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("open notification settings exited with {status}"))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("notification settings deep-link is unavailable on this platform".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_and_receipt_use_stable_dure_identity() {
        let current = status(
            NativeNotificationSettings {
                authorization: NotificationAuthorization::Authorized,
                presentation: NotificationPresentation::Persistent,
            },
            NotificationSender::DureApp,
            None,
        );
        let receipt = rejected(
            NativeNotificationSettings::with_authorization(NotificationAuthorization::Denied),
            NotificationSender::DureInstalledBridge,
            "permission-denied",
            None,
        );

        assert_eq!(current.bundle_identifier, DURE_BUNDLE_IDENTIFIER);
        assert_eq!(receipt.bundle_identifier, DURE_BUNDLE_IDENTIFIER);
        assert_eq!(receipt.reason, Some("permission-denied"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_alert_style_maps_to_user_visible_persistence() {
        use objc2_user_notifications::UNAlertStyle;

        assert_eq!(
            notification_presentation(UNAlertStyle::Banner),
            NotificationPresentation::Temporary
        );
        assert_eq!(
            notification_presentation(UNAlertStyle::Alert),
            NotificationPresentation::Persistent
        );
        assert_eq!(
            notification_presentation(UNAlertStyle::None),
            NotificationPresentation::Disabled
        );
    }

    #[test]
    fn exact_event_dedupe_is_bounded_and_failed_events_can_be_released() {
        let mut dedupe = NotificationEventDedupe::default();
        assert!(dedupe.claim("event-1", 2));
        assert!(!dedupe.claim("event-1", 2));
        assert!(dedupe.claim("event-2", 2));
        assert!(dedupe.claim("event-3", 2));
        assert!(dedupe.claim("event-1", 2));
        dedupe.release("event-3");
        assert!(dedupe.claim("event-3", 2));
    }

    #[test]
    fn notification_sound_distinguishes_silence_default_and_named_sounds() {
        assert_eq!(
            native_notification_sound(None),
            NativeNotificationSound::Silent
        );
        assert_eq!(
            native_notification_sound(Some("")),
            NativeNotificationSound::Silent
        );
        assert_eq!(
            native_notification_sound(Some(SYSTEM_DEFAULT_SOUND_MARKER)),
            NativeNotificationSound::Default
        );
        assert_eq!(
            native_notification_sound(Some("Ping")),
            NativeNotificationSound::Named("Ping")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn channel_bundle_uses_bridge_without_public_notification_authorization() {
        let executable = Path::new(
            "/repo/src-tauri/target/debug/.dure-dev/dev-uiux/Dure.app/Contents/MacOS/dure",
        );
        let dev_identifier = "io.hebbian.ade.dev.a1b2c3d4e5";

        assert!(!is_bundled_stable_dure_identity(
            dev_identifier,
            executable,
            Some(dev_identifier),
        ));
        assert!(!is_bundled_stable_dure_identity(
            DURE_BUNDLE_IDENTIFIER,
            executable,
            Some("dev.dure.other"),
        ));
        assert!(!is_bundled_stable_dure_identity("", executable, Some("")));
        assert!(is_bundled_stable_dure_identity(
            DURE_BUNDLE_IDENTIFIER,
            executable,
            Some(DURE_BUNDLE_IDENTIFIER),
        ));
    }
}
