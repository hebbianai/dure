//! Fail-fast scope for synchronous permission runtime callbacks.

use super::*;
use std::cell::Cell;

std::thread_local! {
    static PERMISSION_CALLBACK_ACTIVE: Cell<bool> = const { Cell::new(false) };
}

pub(super) struct PermissionCallbackScope;

impl PermissionCallbackScope {
    pub(super) fn enter() -> StoreResult<Self> {
        PERMISSION_CALLBACK_ACTIVE.with(|active| {
            if active.replace(true) {
                return Err(callback_reentry_error());
            }
            Ok(Self)
        })
    }
}

impl Drop for PermissionCallbackScope {
    fn drop(&mut self) {
        PERMISSION_CALLBACK_ACTIVE.with(|active| active.set(false));
    }
}

pub(super) fn reject_callback_reentry() -> StoreResult<()> {
    PERMISSION_CALLBACK_ACTIVE.with(|active| {
        if active.get() {
            Err(callback_reentry_error())
        } else {
            Ok(())
        }
    })
}

fn callback_reentry_error() -> PluginPermissionStoreError {
    PluginPermissionStoreError::new(
        "plugin_permission_callback_reentrant",
        "plugin permission callbacks must not reenter permission state APIs",
    )
}
