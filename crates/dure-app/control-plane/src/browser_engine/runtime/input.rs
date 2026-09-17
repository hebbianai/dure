//! Shared lifecycle drain for the Host's held mouse, touch and keyboard contacts.

use super::{BrowserActionPermit, BrowserRuntimeError, Execution};
use crate::browser_engine::BrowserEngineError;
use hmux_host::browser_resource::{
    BrowserAdmissionError, BrowserResourceHost, keyboard::BrowserKeyboardDispatch,
    pointer::BrowserPointerDispatch, touch::BrowserTouchDispatch,
};
use hmux_session_protocol::browser_resource::BrowserTargetId;
use serde_json::json;

enum Release {
    Touch(BrowserTouchDispatch),
    Pointer(BrowserPointerDispatch),
    Keyboard(BrowserKeyboardDispatch),
}

impl Release {
    fn target(&self) -> &BrowserTargetId {
        match self {
            Self::Touch(event) => event.target(),
            Self::Pointer(event) => event.target(),
            Self::Keyboard(event) => event.target(),
        }
    }
    fn unknown(self, host: &mut BrowserResourceHost) -> Result<(), BrowserAdmissionError> {
        match self {
            Self::Touch(event) => host.touch_delivery_unknown(event),
            Self::Pointer(event) => host.pointer_delivery_unknown(event),
            Self::Keyboard(event) => host.keyboard_delivery_unknown(event),
        }
    }
    fn transfer(host: &BrowserResourceHost) -> Result<Option<Self>, BrowserAdmissionError> {
        if let Some(event) = host.touch_release_for_transfer()? {
            return Ok(Some(Self::Touch(event)));
        }
        Ok(match host.pointer_release_for_transfer()? {
            Some(event) => Some(Self::Pointer(event)),
            None => host.keyboard_release_for_transfer()?.map(Self::Keyboard),
        })
    }
    fn before(
        host: &BrowserResourceHost,
        permit: &BrowserActionPermit,
        replaces_document: bool,
    ) -> Result<Option<Self>, BrowserAdmissionError> {
        if let Some(event) = host.touch_release_before_action(permit, replaces_document)? {
            return Ok(Some(Self::Touch(event)));
        }
        Ok(
            match host.pointer_release_before_action(permit, replaces_document)? {
                Some(event) => Some(Self::Pointer(event)),
                None => host
                    .keyboard_release_before_action(permit, replaces_document)?
                    .map(Self::Keyboard),
            },
        )
    }
}

impl Execution<'_> {
    async fn release_input(&self, event: Release) -> Result<(), BrowserRuntimeError> {
        if self
            .binding
            .cdp
            .clone()
            .request(
                "Target.activateTarget",
                json!({"targetId":event.target()}),
                None,
            )
            .await
            .is_err()
        {
            event.unknown(&mut *self.resource.host.lock().await)?;
            return Err(BrowserEngineError::after("browser_input_drain_activation_failed").into());
        }
        match event {
            Release::Touch(event) => self.dispatch_touch(event).await,
            Release::Pointer(event) => {
                self.dispatch_pointer(self.binding.cdp.clone(), event, 1)
                    .await
            }
            Release::Keyboard(event) => self.dispatch_keyboard(event).await,
        }
    }
    pub(super) async fn input_before_action(
        &self,
        permit: &BrowserActionPermit,
        replaces_document: bool,
    ) -> Result<bool, BrowserRuntimeError> {
        let mut released = false;
        loop {
            let event =
                Release::before(&*self.resource.host.lock().await, permit, replaces_document)?;
            let Some(event) = event else {
                return Ok(released);
            };
            self.resource.release_input(event).await?;
            released = true;
        }
    }
}

impl super::BrowserRuntime {
    async fn release_input(&self, event: Release) -> Result<(), BrowserRuntimeError> {
        self.execution_for_target(event.target())
            .await?
            .release_input(event)
            .await
    }

    pub(super) async fn drain_input_transfer(&self) -> Result<(), BrowserRuntimeError> {
        loop {
            let Some(event) = Release::transfer(&*self.host.lock().await)? else {
                return Ok(());
            };
            let execution = self.execution_for_target(event.target()).await?;
            let mut engine = match execution.engine().await {
                Ok(engine) => engine,
                Err(_) => {
                    event.unknown(&mut *self.host.lock().await)?;
                    return Err(BrowserEngineError::after("browser_input_drain_unobserved").into());
                }
            };
            if Release::transfer(&*self.host.lock().await)?.is_none() {
                return Ok(());
            }
            if execution.observe_engine(&mut engine).await.is_err() {
                event.unknown(&mut *self.host.lock().await)?;
                return Err(BrowserEngineError::after("browser_input_drain_unobserved").into());
            }
            let Some(event) = Release::transfer(&*self.host.lock().await)? else {
                return Ok(());
            };
            let instance = self
                .host
                .lock()
                .await
                .instance_for_target(event.target())
                .cloned();
            if instance.as_ref() != Some(execution.binding.events.instance()) {
                continue;
            }
            execution.release_input(event).await?;
        }
    }
}
