//! Bundled Dure's public UserNotifications sender and click delegate.
//!
//! The request identifier carries a bounded, versioned pane route. macOS gives
//! that identifier back even when clicking the notification launches a fresh
//! process, so the route does not depend on a renderer listener already being
//! alive. The delegate journals it in a bounded in-process queue; a Tauri event
//! is only a wake-up hint and the take command remains authoritative.

use crate::desktop_notification::{
    native_notification_sound, NativeNotificationSound, NotificationActivation,
    NotificationPaneTarget,
};
use base64::Engine as _;
use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, MainThreadOnly};
use objc2_foundation::{MainThreadMarker, NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSound,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

const ACTIVATION_IDENTIFIER_PREFIX: &str = "dure-pane-v1:";
const ACTIVATION_EVENT: &str = "notification:activation-available";
const MAX_ACTIVATIONS: usize = 64;
const MAX_ROUTE_FIELD_BYTES: usize = 512;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationEnvelope {
    activation_id: String,
    pane_target: NotificationPaneTarget,
}

#[derive(Default)]
struct ActivationQueue {
    order: VecDeque<NotificationActivation>,
    ids: HashSet<String>,
}

impl ActivationQueue {
    fn push(&mut self, activation: NotificationActivation) -> bool {
        if self.ids.contains(&activation.activation_id) {
            return false;
        }
        self.ids.insert(activation.activation_id.clone());
        self.order.push_back(activation);
        while self.order.len() > MAX_ACTIVATIONS {
            if let Some(retired) = self.order.pop_front() {
                self.ids.remove(&retired.activation_id);
            }
        }
        true
    }

    fn pop_for_window(&mut self, window_label: &str) -> Option<NotificationActivation> {
        let index = self.order.iter().position(|activation| {
            activation
                .pane_target
                .window_label
                .as_deref()
                .unwrap_or("main")
                == window_label
        })?;
        let activation = self.order.remove(index)?;
        self.ids.remove(&activation.activation_id);
        Some(activation)
    }
}

fn activation_queue() -> &'static Mutex<ActivationQueue> {
    static QUEUE: OnceLock<Mutex<ActivationQueue>> = OnceLock::new();
    QUEUE.get_or_init(|| Mutex::new(ActivationQueue::default()))
}

fn app_handle() -> &'static OnceLock<tauri::AppHandle> {
    static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
    &APP_HANDLE
}

fn next_activation_id(event_id: Option<&str>) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    event_id.map(str::to_owned).unwrap_or_else(|| {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
        format!("local:{}:{millis}:{sequence}", std::process::id())
    })
}

fn valid_route_field(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ROUTE_FIELD_BYTES && !value.contains('\0')
}

pub(crate) fn activation_for(
    event_id: Option<&str>,
    pane_target: &NotificationPaneTarget,
) -> Result<NotificationActivation, String> {
    if !valid_route_field(&pane_target.desktop_id)
        || !valid_route_field(&pane_target.panel_id)
        || pane_target
            .window_label
            .as_deref()
            .is_some_and(|label| !valid_route_field(label))
    {
        return Err("notification pane route is empty or too long".to_string());
    }
    let activation_id = next_activation_id(event_id);
    if !valid_route_field(&activation_id) {
        return Err("notification activation id is empty or too long".to_string());
    }
    Ok(NotificationActivation {
        activation_id,
        pane_target: pane_target.clone(),
    })
}

pub(crate) fn encode_activation_identifier(
    event_id: Option<&str>,
    pane_target: &NotificationPaneTarget,
) -> Result<String, String> {
    let activation = activation_for(event_id, pane_target)?;
    let envelope = ActivationEnvelope {
        activation_id: activation.activation_id,
        pane_target: activation.pane_target,
    };
    let bytes = serde_json::to_vec(&envelope).map_err(|error| error.to_string())?;
    Ok(format!(
        "{ACTIVATION_IDENTIFIER_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    ))
}

pub(crate) fn decode_activation_identifier(identifier: &str) -> Option<NotificationActivation> {
    let encoded = identifier.strip_prefix(ACTIVATION_IDENTIFIER_PREFIX)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()?;
    let envelope: ActivationEnvelope = serde_json::from_slice(&bytes).ok()?;
    if !valid_route_field(&envelope.activation_id)
        || !valid_route_field(&envelope.pane_target.desktop_id)
        || !valid_route_field(&envelope.pane_target.panel_id)
        || envelope
            .pane_target
            .window_label
            .as_deref()
            .is_some_and(|label| !valid_route_field(label))
    {
        return None;
    }
    Some(NotificationActivation {
        activation_id: envelope.activation_id,
        pane_target: envelope.pane_target,
    })
}

pub(crate) fn record_activation(activation: NotificationActivation) {
    let target_window_label = activation
        .pane_target
        .window_label
        .clone()
        .unwrap_or_else(|| "main".to_string());
    let queued = activation_queue()
        .lock()
        .map(|mut queue| queue.push(activation))
        .unwrap_or(false);
    if queued {
        if let Some(app) = app_handle().get() {
            let _ = app.emit_to(target_window_label, ACTIVATION_EVENT, ());
        }
    }
}

fn record_response(response: &UNNotificationResponse) {
    let identifier = response.notification().request().identifier().to_string();
    let Some(activation) = decode_activation_identifier(&identifier) else {
        return;
    };
    record_activation(activation);
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class has no Drop impl.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct DureNotificationCenterDelegate;

    // SAFETY: NSObjectProtocol has no additional invariants.
    unsafe impl NSObjectProtocol for DureNotificationCenterDelegate {}

    // SAFETY: The Objective-C method signature matches UNUserNotificationCenterDelegate.
    unsafe impl UNUserNotificationCenterDelegate for DureNotificationCenterDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present_notification(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion_handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion_handler.call(
                (UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,),
            );
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive_response(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion_handler: &DynBlock<dyn Fn()>,
        ) {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                record_response(response);
            }));
            completion_handler.call(());
        }
    }
);

impl DureNotificationCenterDelegate {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        // SAFETY: This invokes NSObject's correctly typed init implementation.
        unsafe { msg_send![super(this), init] }
    }
}

pub(crate) fn native_bundle_identifier() -> Option<String> {
    NSBundle::mainBundle()
        .bundleIdentifier()
        .map(|identifier| identifier.to_string())
        .filter(|identifier| !identifier.is_empty())
}

pub fn install_delegate() -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    if !should_install_delegate(
        &executable,
        native_bundle_identifier().is_some(),
    ) {
        return Ok(());
    }
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "notification delegate must be installed on the main thread".to_string())?;
    let delegate = DureNotificationCenterDelegate::new(mtm);
    UNUserNotificationCenter::currentNotificationCenter()
        .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center's delegate property is weak. Dure owns this one delegate for
    // the process lifetime, so intentionally retain it until process exit.
    let _ = Retained::into_raw(delegate);
    Ok(())
}

fn should_install_delegate(executable: &Path, main_bundle_has_identifier: bool) -> bool {
    main_bundle_has_identifier && is_bundled_app_executable(executable)
}

pub(crate) fn is_bundled_app_executable(path: &Path) -> bool {
    let Some(macos) = path.parent() else {
        return false;
    };
    let Some(contents) = macos.parent() else {
        return false;
    };
    let Some(bundle) = contents.parent() else {
        return false;
    };
    macos.file_name().is_some_and(|name| name == "MacOS")
        && contents
            .file_name()
            .is_some_and(|name| name == "Contents")
        && bundle.extension().is_some_and(|extension| extension == "app")
}

pub fn register_app_handle(app: &tauri::AppHandle) {
    let _ = app_handle().set(app.clone());
}

pub fn take_activation(window_label: &str) -> Option<NotificationActivation> {
    activation_queue()
        .lock()
        .ok()
        .and_then(|mut queue| queue.pop_for_window(window_label))
}

/// Clear only notifications owned by the current bundle identity. The signed
/// notification-click QA app has a dedicated identity, so this never removes
/// the user's production Dure notifications.
pub fn clear_all() {
    let center = UNUserNotificationCenter::currentNotificationCenter();
    center.removeAllPendingNotificationRequests();
    center.removeAllDeliveredNotifications();
}

pub fn dispatch(
    title: &str,
    body: &str,
    sound: Option<&str>,
    event_id: Option<&str>,
    pane_target: Option<&NotificationPaneTarget>,
) -> Result<(), String> {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    match native_notification_sound(sound) {
        NativeNotificationSound::Silent => {}
        NativeNotificationSound::Default => {
            content.setSound(Some(&UNNotificationSound::defaultSound()));
        }
        NativeNotificationSound::Named(name) => {
            content.setSound(Some(&UNNotificationSound::soundNamed(&NSString::from_str(
                name,
            ))));
        }
    }

    let identifier = match pane_target {
        Some(target) => encode_activation_identifier(event_id, target)?,
        None => next_activation_id(event_id),
    };
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&identifier),
        &content,
        None,
    );
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let handler = RcBlock::new(move |error: *mut NSError| {
        let result = if error.is_null() {
            Ok(())
        } else {
            // SAFETY: UserNotifications owns NSError for the callback duration.
            Err(unsafe { error.as_ref() }
                .map(|error| error.localizedDescription().to_string())
                .unwrap_or_else(|| "macOS rejected the notification request".to_string()))
        };
        let _ = sender.send(result);
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, Some(&handler));
    receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|error| format!("notification dispatch timed out: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> NotificationPaneTarget {
        NotificationPaneTarget {
            window_label: Some("main".to_string()),
            desktop_id: "desktop-b".to_string(),
            panel_id: "agent:codex".to_string(),
        }
    }

    #[test]
    fn activation_identifier_round_trips_exact_route() {
        let identifier =
            encode_activation_identifier(Some("hmux:turn:9"), &target()).expect("encode");
        assert_eq!(
            decode_activation_identifier(&identifier),
            Some(NotificationActivation {
                activation_id: "hmux:turn:9".to_string(),
                pane_target: target(),
            })
        );
    }

    #[test]
    fn activation_identifier_rejects_foreign_and_oversized_routes() {
        assert_eq!(decode_activation_identifier("foreign:notification"), None);
        let oversized = NotificationPaneTarget {
            window_label: Some("main".to_string()),
            desktop_id: "d".repeat(MAX_ROUTE_FIELD_BYTES + 1),
            panel_id: "agent:codex".to_string(),
        };
        assert!(encode_activation_identifier(Some("event"), &oversized).is_err());
        let oversized_event = "e".repeat(MAX_ROUTE_FIELD_BYTES + 1);
        assert!(encode_activation_identifier(Some(&oversized_event), &target()).is_err());
    }

    #[test]
    fn activation_queue_is_bounded_and_deduplicated() {
        let mut queue = ActivationQueue::default();
        let activation = |id: &str| NotificationActivation {
            activation_id: id.to_string(),
            pane_target: target(),
        };
        assert!(queue.push(activation("same")));
        assert!(!queue.push(activation("same")));
        for index in 0..=MAX_ACTIVATIONS {
            assert!(queue.push(activation(&format!("event-{index}"))));
        }
        assert_eq!(queue.order.len(), MAX_ACTIVATIONS);
        assert!(!queue.ids.contains("same"));
    }

    #[test]
    fn activation_queue_is_consumed_only_by_the_exact_window() {
        let mut queue = ActivationQueue::default();
        queue.push(NotificationActivation {
            activation_id: "target-window".to_string(),
            pane_target: NotificationPaneTarget {
                window_label: Some("win-notification-click-target".to_string()),
                ..target()
            },
        });

        assert!(queue.pop_for_window("main").is_none());
        assert_eq!(
            queue
                .pop_for_window("win-notification-click-target")
                .map(|activation| activation.activation_id),
            Some("target-window".to_string())
        );
    }

    #[test]
    fn notification_delegate_requires_a_real_app_bundle_executable() {
        let bundled = Path::new("/Applications/Dure.app/Contents/MacOS/dure");
        assert!(should_install_delegate(bundled, true));
        assert!(!should_install_delegate(bundled, false));
        assert!(!should_install_delegate(
            Path::new("/tmp/target/debug/dure"),
            true,
        ));
        assert!(!should_install_delegate(
            Path::new("/tmp/Contents/debug/dure"),
            true,
        ));
    }
}
