//! Both constructing and published bindings retire through the same Host authority.
use super::*;

#[derive(Clone)]
pub(super) struct HostBindingRetirement {
    pub(super) host: Arc<Mutex<BrowserResourceHost>>,
    pub(super) identity: BrowserResourceIdentity,
    pub(super) instance: BrowserInstanceId,
    uploads: Arc<Mutex<upload::BrowserUploads>>,
    pub(super) changed: Arc<tokio::sync::Notify>,
}

impl HostBindingRetirement {
    pub(super) fn new(
        identity: &BrowserResourceIdentity,
        host: &Arc<Mutex<BrowserResourceHost>>,
        instance: &BrowserInstanceId,
        uploads: &Arc<Mutex<upload::BrowserUploads>>,
        changed: &Arc<tokio::sync::Notify>,
    ) -> Self {
        Self {
            host: Arc::clone(host),
            identity: identity.clone(),
            instance: instance.clone(),
            uploads: Arc::clone(uploads),
            changed: Arc::clone(changed),
        }
    }

    pub(super) async fn begin(&self) -> Result<(), BrowserRuntimeError> {
        self.host
            .lock()
            .await
            .begin_instance_retirement(&self.identity, &self.instance)?;
        self.changed.notify_waiters();
        Ok(())
    }

    /// Call only after the native owner and retained observation have retired.
    pub(super) async fn complete(&self) -> Result<(), BrowserRuntimeError> {
        let closed = self
            .host
            .lock()
            .await
            .instance_binding_retired(&self.identity, &self.instance)?;
        if closed {
            self.uploads.lock().await.clear();
        }
        self.changed.notify_waiters();
        Ok(())
    }
}
