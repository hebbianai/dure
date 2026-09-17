//! Development app notification bridge.
//!
//! A development bundle has its own channel-scoped native identity, not the signed
//! stable identity. This adapter keeps using the installed Dure identity through
//! NSUserNotificationCenter, supplies the current Dure icon, and carries exact pane
//! activations back into the same bounded queue as the signed-app delegate.

use crate::desktop_notification::{
    native_notification_sound, NativeNotificationSound, NotificationPaneTarget,
    DURE_BUNDLE_IDENTIFIER,
};
use mac_notification_sys::set_application;
use objc2::rc::{autoreleasepool, Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{define_class, msg_send, AnyThread};
use objc2_foundation::{NSObject, NSObjectProtocol, NSString};
use std::path::Path;
use std::sync::OnceLock;

const DURE_NOTIFICATION_ICON: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/icons/icon.png");

fn record_clicked_notification(notification: &AnyObject) {
    let identifier: Option<Retained<NSString>> = unsafe { msg_send![notification, identifier] };
    let Some(identifier) = identifier else {
        return;
    };
    let Some(activation) = crate::macos_notification_center::decode_activation_identifier(
        &identifier.to_string(),
    ) else {
        return;
    };
    crate::macos_notification_center::record_activation(activation);
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class has no Drop impl.
    #[unsafe(super(NSObject))]
    #[ivars = ()]
    struct DureInstalledNotificationDelegate;

    impl DureInstalledNotificationDelegate {
        #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
        fn should_present_notification(
            &self,
            _center: &AnyObject,
            _notification: &AnyObject,
        ) -> Bool {
            Bool::YES
        }

        #[unsafe(method(userNotificationCenter:didActivateNotification:))]
        fn did_activate_notification(&self, center: &AnyObject, notification: &AnyObject) {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                record_clicked_notification(notification);
            }));
            if result.is_err() {
                eprintln!("[notification] installed bridge click callback panicked");
            }
            unsafe {
                let _: () = msg_send![center, removeDeliveredNotification: notification];
            }
        }
    }

    // SAFETY: NSObjectProtocol has no additional invariants.
    unsafe impl NSObjectProtocol for DureInstalledNotificationDelegate {}
);

impl DureInstalledNotificationDelegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: This invokes NSObject's correctly typed init implementation.
        unsafe { msg_send![super(this), init] }
    }
}

fn default_notification_center() -> Result<Retained<AnyObject>, String> {
    let center_class = AnyClass::get(c"NSUserNotificationCenter")
        .ok_or_else(|| "NSUserNotificationCenter is unavailable".to_string())?;
    Ok(unsafe { msg_send![center_class, defaultUserNotificationCenter] })
}

fn setup_sender() -> Result<(), String> {
    static SENDER_SETUP: OnceLock<Result<(), String>> = OnceLock::new();
    SENDER_SETUP
        .get_or_init(|| set_application(DURE_BUNDLE_IDENTIFIER).map_err(|error| error.to_string()))
        .clone()
}

fn install_notification_delegate() -> Result<(), String> {
    let center = default_notification_center()?;
    let delegate = DureInstalledNotificationDelegate::new();
    unsafe {
        let _: () = msg_send![&*center, setDelegate: &*delegate];
    }
    // NSUserNotificationCenter's delegate is not retained. This is the sole
    // process delegate, so keep it alive for the process lifetime.
    let _ = Retained::into_raw(delegate);
    Ok(())
}

fn setup_notification_delegate() -> Result<(), String> {
    static DELEGATE_SETUP: OnceLock<Result<(), String>> = OnceLock::new();
    DELEGATE_SETUP
        .get_or_init(install_notification_delegate)
        .clone()
}

fn notification_with_content(
    title: &str,
    body: &str,
    sound: Option<&str>,
    identifier: Option<&str>,
) -> Result<Retained<AnyObject>, String> {
    let notification_class = AnyClass::get(c"NSUserNotification")
        .ok_or_else(|| "NSUserNotification is unavailable".to_string())?;
    let notification: Retained<AnyObject> = unsafe { msg_send![notification_class, new] };
    let title = NSString::from_str(title);
    let body = NSString::from_str(body);
    unsafe {
        let _: () = msg_send![&*notification, setTitle: &*title];
        let _: () = msg_send![&*notification, setInformativeText: &*body];
        let _: () = msg_send![&*notification, setHasActionButton: Bool::NO];
    }

    if let Some(identifier) = identifier {
        let identifier = NSString::from_str(identifier);
        unsafe {
            let _: () = msg_send![&*notification, setIdentifier: &*identifier];
        }
    }

    let sound_name = match native_notification_sound(sound) {
        NativeNotificationSound::Silent => None,
        NativeNotificationSound::Default => Some("NSUserNotificationDefaultSoundName"),
        NativeNotificationSound::Named(name) => Some(name),
    };
    if let Some(sound_name) = sound_name {
        let sound_name = NSString::from_str(sound_name);
        unsafe {
            let _: () = msg_send![&*notification, setSoundName: &*sound_name];
        }
    }

    if Path::new(DURE_NOTIFICATION_ICON).is_file() {
        if let Some(image_class) = AnyClass::get(c"NSImage") {
            let path = NSString::from_str(DURE_NOTIFICATION_ICON);
            let allocated: Allocated<AnyObject> = unsafe { msg_send![image_class, alloc] };
            let image: Option<Retained<AnyObject>> =
                unsafe { msg_send![allocated, initWithContentsOfFile: &*path] };
            if let Some(image) = image {
                let key = NSString::from_str("_identityImage");
                unsafe {
                    let _: () = msg_send![&*notification, setValue: &*image, forKey: &*key];
                }
            }
        }
    }

    Ok(notification)
}

pub(crate) fn dispatch(
    title: &str,
    body: &str,
    sound: Option<&str>,
    event_id: Option<&str>,
    pane_target: Option<&NotificationPaneTarget>,
) -> Result<(), String> {
    setup_sender()?;
    setup_notification_delegate()?;
    let activation_identifier = pane_target
        .map(|target| {
            crate::macos_notification_center::encode_activation_identifier(event_id, target)
        })
        .transpose()?;

    autoreleasepool(|_| {
        let center = default_notification_center()?;
        let notification = notification_with_content(
            title,
            body,
            sound,
            activation_identifier.as_deref(),
        )?;

        unsafe {
            let _: () = msg_send![&*center, deliverNotification: &*notification];
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::ClassType;

    #[test]
    fn bridge_uses_the_current_dure_icon() {
        assert!(Path::new(DURE_NOTIFICATION_ICON).is_file());
    }

    #[test]
    fn one_delegate_owns_foreground_presentation_and_clicks() {
        let delegate = DureInstalledNotificationDelegate::class();
        assert!(
            delegate
                .instance_method(objc2::sel!(userNotificationCenter:shouldPresentNotification:))
                .is_some()
        );
        assert!(
            delegate
                .instance_method(objc2::sel!(userNotificationCenter:didActivateNotification:))
                .is_some()
        );
    }

    #[test]
    fn installed_bridge_reuses_the_versioned_activation_identifier() {
        let target = NotificationPaneTarget {
            window_label: Some("main".to_string()),
            desktop_id: "space".to_string(),
            panel_id: "pane".to_string(),
        };
        let identifier = crate::macos_notification_center::encode_activation_identifier(
            Some("event"),
            &target,
        )
        .expect("activation identifier");
        let activation =
            crate::macos_notification_center::decode_activation_identifier(&identifier)
                .expect("activation route");
        assert_eq!(activation.activation_id, "event");
        assert_eq!(activation.pane_target, target);
    }
}
