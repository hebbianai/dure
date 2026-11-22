// The notification service extension. Each remote alert that names an agent
// (`mutable-content`) passes through here before iOS shows it. The app's Rust
// library asks the paired computer who and what the alert is about
// (`src/alert_content.rs`). This file only moves the alert in and out, and
// shows it as delivered whenever that answer does not come in time.

#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>

// The alert's whole JSON payload in; a JSON object with `title`, `body` and an
// optional `subtitle` out, or NULL to keep the alert as it is.
extern char *dure_alert_text(const uint8_t *payload, size_t length);
extern void dure_alert_text_free(char *text);

@interface NotificationService : UNNotificationServiceExtension
@end

@implementation NotificationService {
    void (^_contentHandler)(UNNotificationContent *);
    UNNotificationContent *_delivered;
}

- (void)didReceiveNotificationRequest:(UNNotificationRequest *)request
                   withContentHandler:(void (^)(UNNotificationContent *))contentHandler {
    UNNotificationContent *delivered = request.content;
    @synchronized(self) {
        _contentHandler = [contentHandler copy];
        _delivered = delivered;
    }
    // The answer crosses the network: never on the thread iOS called us on.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        [self finish:[NotificationService rewritten:delivered] ?: delivered];
    });
}

// iOS gives up on the alert soon: it is shown as the relay sent it.
- (void)serviceExtensionTimeWillExpire {
    UNNotificationContent *delivered;
    @synchronized(self) {
        delivered = _delivered;
    }
    [self finish:delivered];
}

// Hands iOS the alert once, whichever of the answer and the deadline is first.
- (void)finish:(UNNotificationContent *)content {
    void (^handler)(UNNotificationContent *);
    @synchronized(self) {
        handler = _contentHandler;
        _contentHandler = nil;
    }
    if (handler) handler(content);
}

+ (UNNotificationContent *)rewritten:(UNNotificationContent *)delivered {
    NSDictionary *info = delivered.userInfo;
    if (![NSJSONSerialization isValidJSONObject:info]) return nil;
    NSData *payload = [NSJSONSerialization dataWithJSONObject:info options:0 error:nil];
    if (!payload) return nil;
    char *answer = dure_alert_text(payload.bytes, payload.length);
    if (!answer) return nil;
    NSData *json = [NSData dataWithBytes:answer length:strlen(answer)];
    dure_alert_text_free(answer);
    NSDictionary *text = [NSJSONSerialization JSONObjectWithData:json options:0 error:nil];
    if (![text isKindOfClass:[NSDictionary class]]) return nil;
    NSString *title = text[@"title"];
    NSString *subtitle = text[@"subtitle"];
    NSString *body = text[@"body"];
    if (![title isKindOfClass:[NSString class]] || ![body isKindOfClass:[NSString class]]) return nil;
    UNMutableNotificationContent *content = [delivered mutableCopy];
    content.title = title;
    content.body = body;
    if ([subtitle isKindOfClass:[NSString class]]) content.subtitle = subtitle;
    return content;
}

@end
