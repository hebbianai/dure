#include "bindings/bindings.h"

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

/**
 * Take away the bar iOS draws between the keyboard and the page.
 *
 * WKWebView gives every focused text field Apple's form accessory bar — the
 * ‹ › field-stepper and Done. This app has one text field and a terminal; there
 * is no form to step through, so the bar is a strip of chrome sitting exactly
 * where the shortcut row is supposed to meet the keys. There is no web API for
 * it: `WKWebView` exposes no setting, and both Cordova and Capacitor answer it
 * the same way, by overriding the accessory getter on WebKit's content view.
 *
 * Every step is allowed to fail into doing nothing. If WebKit renames or
 * restructures that class, the bar comes back and the keyboard is untouched —
 * the failure mode is the bar, never a field that cannot be typed into.
 *
 * The override is added to `WKContentView` itself rather than replacing an
 * inherited implementation, so nothing else in the app loses its accessory
 * view: `class_getInstanceMethod` walks up to `UIResponder`, and rewriting
 * *that* implementation would silence the bar for every responder there is.
 */
static void HideFormAccessoryBar(void) {
  Class contentView = NSClassFromString(@"WKContentView");
  if (contentView == Nil) {
    return;
  }
  SEL selector = @selector(inputAccessoryView);
  Method inherited = class_getInstanceMethod(contentView, selector);
  if (inherited == NULL) {
    return;
  }
  IMP none = imp_implementationWithBlock(^UIView *(id target) {
    (void)target;
    return nil;
  });
  // YES means the class had no implementation of its own and now carries an
  // override. NO means the one found above belongs to this class, so replacing
  // it stays scoped to it.
  if (class_addMethod(contentView, selector, none, method_getTypeEncoding(inherited))) {
    return;
  }
  method_setImplementation(inherited, none);
}

int main(int argc, char * argv[]) {
	// WebKit is linked into this binary, so its classes are registered before
	// `main`. If a future WebKit is loaded lazily instead, the lookup above finds
	// nothing and this is simply a no-op.
	HideFormAccessoryBar();
	ffi::start_app();
	return 0;
}
