//! Adds only the two public UIApplicationDelegate APNs callbacks that Tao
//! does not implement. Existing delegate methods are never replaced. A
//! future owner of these callbacks must be integrated explicitly instead of
//! being silently overridden.
//!
//! Taps on remote alerts are the one notification-center callback this module
//! owns. The notification plugin's delegate drops every push-triggered
//! response, so [`install_response_delegate`] stands in front of it: a tap on
//! a remote alert goes to [`PushActivations`], and every other callback is
//! forwarded to the plugin unchanged.
use crate::push::{PushActivation, PushActivations};
use block2::DynBlock;
use dure_hub_protocol::push::{ApnsEnvironment, ApnsToken};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, NSObject, NSObjectProtocol, ProtocolObject, Sel},
    sel, AnyThread, ClassType, DefinedClass, MainThreadMarker,
};
use objc2_foundation::{
    NSBundle, NSData, NSError, NSJSONSerialization, NSJSONWritingOptions, NSString,
};
use objc2_ui_kit::UIApplication;
use objc2_user_notifications::{
    UNNotification, UNNotificationContent, UNNotificationDefaultActionIdentifier,
    UNNotificationPresentationOptions, UNNotificationResponse, UNPushNotificationTrigger,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use std::sync::{mpsc, Mutex, OnceLock};
use tauri::Manager;

type Registration = Result<ApnsToken, String>;
static PENDING: Mutex<Option<mpsc::SyncSender<Registration>>> = Mutex::new(None);
static CALLBACKS: OnceLock<Result<(), String>> = OnceLock::new();

extern "C" {
    fn class_addMethod(
        class: *const AnyClass,
        selector: Sel,
        implementation: unsafe extern "C" fn(),
        encoding: *const std::ffi::c_char,
    ) -> bool;
}

fn finish(result: Registration) {
    if let Some(sender) = PENDING.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = sender.send(result);
    }
}

unsafe extern "C" fn registered(_: *mut AnyObject, _: Sel, _: *mut AnyObject, data: *const NSData) {
    let result = data
        .as_ref()
        .ok_or("APNs returned no device token".to_string())
        .and_then(|data| {
            let hex: String = data
                .to_vec()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            ApnsToken::try_from(hex).map_err(str::to_string)
        });
    finish(result);
}

unsafe extern "C" fn failed(_: *mut AnyObject, _: Sel, _: *mut AnyObject, error: *const NSError) {
    let code = error.as_ref().map(|error| error.code()).unwrap_or(0);
    finish(Err(format!("APNs registration failed ({code}). Check network access and the signed app's Push Notifications capability.")));
}

fn install_callbacks(application: &UIApplication) -> Result<(), String> {
    CALLBACKS
        .get_or_init(|| {
            let delegate = unsafe { application.delegate() }
                .ok_or("The application delegate is unavailable")?;
            let object: &AnyObject = (*delegate).as_ref();
            let class = object.class();
            let success = sel!(application:didRegisterForRemoteNotificationsWithDeviceToken:);
            let failure = sel!(application:didFailToRegisterForRemoteNotificationsWithError:);
            if class.instance_method(success).is_some() || class.instance_method(failure).is_some()
            {
                return Err("APNs callbacks already have an owner".into());
            }
            unsafe {
                let success_imp = std::mem::transmute::<
                    unsafe extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, *const NSData),
                    unsafe extern "C" fn(),
                >(registered);
                let failure_imp = std::mem::transmute::<
                    unsafe extern "C" fn(*mut AnyObject, Sel, *mut AnyObject, *const NSError),
                    unsafe extern "C" fn(),
                >(failed);
                if !class_addMethod(class, success, success_imp, c"v@:@@".as_ptr())
                    || !class_addMethod(class, failure, failure_imp, c"v@:@@".as_ptr())
                {
                    return Err("Could not install APNs registration callbacks".into());
                }
            }
            Ok(())
        })
        .clone()
}

fn environment() -> Result<ApnsEnvironment, String> {
    let key = NSString::from_str("DurePushEnvironment");
    let value = NSBundle::mainBundle()
        .objectForInfoDictionaryKey(&key)
        .and_then(|value| value.downcast::<NSString>().ok())
        .map(|value| value.to_string());
    match value.as_deref() {
        Some("development") => Ok(ApnsEnvironment::Sandbox),
        Some("production") => Ok(ApnsEnvironment::Production),
        _ => Err("This build has no APNs signing environment".into()),
    }
}

pub async fn register(app: &tauri::AppHandle) -> Result<(ApnsToken, ApnsEnvironment), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = (|| {
            let mtm =
                MainThreadMarker::new().ok_or("APNs registration requires the main thread")?;
            let application = UIApplication::sharedApplication(mtm);
            install_callbacks(&application)?;
            let environment = environment()?;
            let (token_sender, token_receiver) = mpsc::sync_channel(1);
            let mut pending = PENDING.lock().unwrap_or_else(|error| error.into_inner());
            if pending.is_some() {
                return Err("APNs registration is already in progress".to_string());
            }
            *pending = Some(token_sender);
            drop(pending);
            application.registerForRemoteNotifications();
            Ok((token_receiver, environment))
        })();
        let _ = sender.send(result);
    })
    .map_err(|_| "Could not schedule APNs registration")?;
    tauri::async_runtime::spawn_blocking(move || {
        let (tokens, environment) = receiver
            .recv()
            .map_err(|_| "APNs registration was interrupted")??;
        match tokens.recv_timeout(std::time::Duration::from_secs(20)) {
            Ok(result) => result.map(|token| (token, environment)),
            Err(_) => {
                PENDING
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take();
                Err("APNs registration timed out. Try again when the phone is online.".into())
            }
        }
    })
    .await
    .map_err(|_| "APNs registration was interrupted")?
}

pub fn unregister(app: &tauri::AppHandle) -> Result<(), String> {
    app.run_on_main_thread(|| {
        if let Some(mtm) = MainThreadMarker::new() {
            UIApplication::sharedApplication(mtm).unregisterForRemoteNotifications();
        }
    })
    .map_err(|_| "Could not disable APNs registration".into())
}

struct Responses {
    app: tauri::AppHandle,
    /// The delegate that was installed first: the notification plugin's.
    previous: Option<Retained<ProtocolObject<dyn UNUserNotificationCenterDelegate>>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and this class does
    // not implement `Drop`.
    #[unsafe(super(NSObject))]
    #[name = "DurePushResponses"]
    #[ivars = Responses]
    struct PushResponses;

    unsafe impl NSObjectProtocol for PushResponses {}

    unsafe impl UNUserNotificationCenterDelegate for PushResponses {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            center: &UNUserNotificationCenter,
            notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            match self.previous(
                sel!(userNotificationCenter:willPresentNotification:withCompletionHandler:),
            ) {
                Some(previous) => previous
                    .userNotificationCenter_willPresentNotification_withCompletionHandler(
                        center,
                        notification,
                        completion,
                    ),
                None => completion.call((UNNotificationPresentationOptions::empty(),)),
            }
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            let request = response.notification().request();
            let remote = request
                .trigger()
                .is_some_and(|trigger| trigger.isKindOfClass(UNPushNotificationTrigger::class()));
            if !remote {
                match self.previous(sel!(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:)) {
                    Some(previous) => previous
                        .userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler(
                            center,
                            response,
                            completion,
                        ),
                    None => completion.call(()),
                }
                return;
            }
            // SAFETY: a framework constant, valid for the process lifetime.
            let tapped = response
                .actionIdentifier()
                .isEqualToString(unsafe { UNNotificationDefaultActionIdentifier });
            if let Some(activation) = tapped
                .then(|| payload(&request.content()))
                .flatten()
                .and_then(|payload| PushActivation::from_payload(&payload))
            {
                self.ivars()
                    .app
                    .state::<PushActivations>()
                    .offer(activation);
            }
            completion.call(());
        }
    }
);

impl PushResponses {
    fn previous(
        &self,
        selector: Sel,
    ) -> Option<&ProtocolObject<dyn UNUserNotificationCenterDelegate>> {
        self.ivars()
            .previous
            .as_deref()
            .filter(|previous| previous.respondsToSelector(selector))
    }
}

/// The alert's payload as the relay sent it: APNs hands it over as `userInfo`.
fn payload(content: &UNNotificationContent) -> Option<Vec<u8>> {
    let info = content.userInfo();
    let object: &AnyObject = &info;
    // SAFETY: `isValidJSONObject` is asked first, so serializing cannot raise.
    unsafe {
        if !NSJSONSerialization::isValidJSONObject(object) {
            return None;
        }
        NSJSONSerialization::dataWithJSONObject_options_error(object, NSJSONWritingOptions::empty())
            .ok()
            .map(|data| data.to_vec())
    }
}

static RESPONSES: OnceLock<Result<(), String>> = OnceLock::new();

/// Puts [`PushResponses`] in front of the notification plugin's delegate.
/// Runs in app setup, inside launch, so the tap that launched the app is not
/// missed; the plugin set its delegate when it was registered, before that.
pub fn install_response_delegate(app: &tauri::AppHandle) -> Result<(), String> {
    RESPONSES
        .get_or_init(|| {
            MainThreadMarker::new().ok_or("Notification responses require the main thread")?;
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let this = PushResponses::alloc().set_ivars(Responses {
                app: app.clone(),
                previous: center.delegate(),
            });
            // SAFETY: NSObject's designated initializer.
            let responses: Retained<PushResponses> = unsafe { msg_send![super(this), init] };
            center.setDelegate(Some(ProtocolObject::from_ref(&*responses)));
            // The center holds its delegate weakly; this one lives as long as the app.
            let _ = Retained::into_raw(responses);
            Ok(())
        })
        .clone()
}
