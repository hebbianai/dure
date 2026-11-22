//! Adds only the two public UIApplicationDelegate APNs callbacks that Tao
//! does not implement. Existing delegate methods are never replaced. A
//! future owner of these callbacks must be integrated explicitly instead of
//! being silently overridden.
//!
//! Responses to remote alerts are the one notification-center callback this
//! module owns. The notification plugin's delegate drops every push-triggered
//! response, so [`install_response_delegate`] stands in front of it: a tap on
//! a remote alert goes to [`PushActivations`], Allow once and Deny go to
//! `push::answer_from_alert`, and every other callback is forwarded to the
//! plugin unchanged. The notice this module posts when such an answer did not
//! land is its own too, never the plugin's.
use crate::push::{FailureNotice, PushActivation, PushActivations};
use block2::{DynBlock, RcBlock};
use dure_hub_protocol::push::{ApnsEnvironment, ApnsToken, PUSH_ALERT_CONTEXT_KEY};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, NSObject, NSObjectProtocol, ProtocolObject, Sel},
    sel, AnyThread, ClassType, DefinedClass, MainThreadMarker,
};
use objc2_foundation::{
    NSBundle, NSData, NSDictionary, NSError, NSJSONReadingOptions, NSJSONSerialization,
    NSJSONWritingOptions, NSString,
};
use objc2_ui_kit::UIApplication;
use objc2_user_notifications::{
    UNMutableNotificationContent, UNNotification, UNNotificationContent,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSound, UNPushNotificationTrigger,
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
            if is_notice(&notification.request()) {
                completion.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
                return;
            }
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
            if !remote && !is_notice(&request) {
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
            let payload = payload(&request.content()).unwrap_or_default();
            let action = response.actionIdentifier();
            let app = &self.ivars().app;
            if let Some(choice) = crate::push::action_choice(&action.to_string()) {
                // The system waits for the answer: the handler is called once it landed or failed.
                let completion = Completion(completion.copy());
                let main = app.clone();
                crate::push::answer_from_alert(app, &payload, choice, move |notice| {
                    let _ = main.run_on_main_thread(move || {
                        if let Some(notice) = notice {
                            post_notice(&notice);
                        }
                        completion.finish();
                    });
                });
                return;
            }
            // SAFETY: a framework constant, valid for the process lifetime.
            if action.isEqualToString(unsafe { UNNotificationDefaultActionIdentifier }) {
                if let Some(activation) = PushActivation::from_payload(&payload) {
                    app.state::<PushActivations>().offer(activation);
                }
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

/// A completion handler kept past its callback, until an answer settles.
struct Completion(RcBlock<dyn Fn()>);

// SAFETY: a heap copy of the system's completion block, which may be called
// from any thread; it is only ever called on the main thread here.
unsafe impl Send for Completion {}

impl Completion {
    /// Taking `self` moves the whole wrapper into a closure, not its block.
    fn finish(self) {
        self.0.call(());
    }
}

/// The notices this module posts carry this identifier prefix; their
/// callbacks are this module's, never the plugin's, which knows nothing of them.
const NOTICE_PREFIX: &str = "dure.notice.";

fn is_notice(request: &UNNotificationRequest) -> bool {
    request.identifier().to_string().starts_with(NOTICE_PREFIX)
}

/// Tells the person an answer from an alert did not land. A tap opens the
/// agent, as a tap on the alert would.
fn post_notice(notice: &FailureNotice) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str("Dure"));
    content.setBody(&NSString::from_str(&notice.body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let info = serde_json::json!({ PUSH_ALERT_CONTEXT_KEY: { "session": notice.session } });
    if let Ok(bytes) = serde_json::to_vec(&info) {
        let data = NSData::with_bytes(&bytes);
        let object = NSJSONSerialization::JSONObjectWithData_options_error(
            &data,
            NSJSONReadingOptions::empty(),
        );
        if let Some(info) = object
            .ok()
            .and_then(|object| object.downcast::<NSDictionary>().ok())
        {
            // SAFETY: a property list of strings, as `userInfo` requires.
            unsafe { content.setUserInfo(&info) };
        }
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(&format!("{NOTICE_PREFIX}{stamp}")),
        &content,
        None,
    );
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, None);
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
