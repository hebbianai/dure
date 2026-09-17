use tauri::Manager;

#[cfg(any(target_os = "macos", test))]
#[path = "quit_confirmation.rs"]
mod quit_confirmation;

#[cfg(target_os = "macos")]
#[derive(Clone, serde::Deserialize)]
pub(crate) struct QuitConfirmationCopy {
    #[serde(rename = "app.quit.title")]
    title: String,
    #[serde(rename = "app.quit.message")]
    message: String,
    #[serde(rename = "app.quit.confirm")]
    confirm: String,
    #[serde(rename = "app.quit.cancel")]
    cancel: String,
}

#[cfg(target_os = "macos")]
impl Default for QuitConfirmationCopy {
    fn default() -> Self {
        // The native pre-WebView default and t() use the same English catalog.
        serde_json::from_str(include_str!("quit_confirmation.en.json"))
            .expect("canonical app quit translations must match QuitConfirmationCopy")
    }
}

#[cfg(target_os = "macos")]
#[derive(Default)]
pub(crate) struct NativeQuitState {
    copy: std::sync::Mutex<QuitConfirmationCopy>,
    confirmation: quit_confirmation::QuitConfirmation,
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub(crate) fn set_app_quit_confirmation_copy(
    state: tauri::State<'_, NativeQuitState>,
    copy: QuitConfirmationCopy,
) -> Result<(), String> {
    *state.copy.lock().map_err(|error| error.to_string())? = copy;
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_menu_event<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    event: tauri::menu::MenuEvent,
) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

    if event.id() != MACOS_QUIT_MENU_ID {
        return;
    }
    let state = app.state::<NativeQuitState>();
    let copy = state.copy.lock()
        .unwrap_or_else(|error| error.into_inner()).clone();
    let exit_app = app.clone();
    state.confirmation.request(
        |reply| {
            let mut dialog = app.dialog()
                .message(copy.message)
                .title(copy.title)
                .buttons(MessageDialogButtons::OkCancelCustom(copy.confirm, copy.cancel));
            let windows = app.webview_windows();
            if let Some(parent) = windows.values()
                .find(|window| window.is_focused().unwrap_or(false))
            {
                dialog = dialog.parent(parent);
            }
            dialog.show(reply);
        },
        move || exit_app.exit(0),
    );
}

#[derive(Debug, Default, PartialEq, Eq)]
enum ExitPhase {
    #[default]
    Idle,
    ClosingWindows { requested_code: Option<i32> },
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct DurableWindowExitCoordinator {
    phase: ExitPhase,
}

#[derive(Debug, PartialEq, Eq)]
enum ExitDecision {
    Allow,
    CloseWindows,
    Reissue(i32),
}

#[cfg(target_os = "macos")]
fn reveal_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    for (action, result) in [
        ("unminimize", window.unminimize()),
        ("show", window.show()),
        ("focus", window.set_focus()),
    ] {
        if let Err(error) = result {
            eprintln!(
                "[durable-window-exit] reopen action failed: label={} action={action} error={error}",
                window.label()
            );
        }
    }
}

impl DurableWindowExitCoordinator {
    fn decide(&mut self, requested_code: Option<i32>, window_count: usize) -> ExitDecision {
        if requested_code == Some(tauri::RESTART_EXIT_CODE) {
            return ExitDecision::Allow;
        }

        if window_count > 0 {
            let preserved_code = match self.phase {
                ExitPhase::ClosingWindows { requested_code } => requested_code,
                ExitPhase::Idle => requested_code,
            };
            self.phase = ExitPhase::ClosingWindows {
                requested_code: preserved_code,
            };
            return ExitDecision::CloseWindows;
        }

        match std::mem::take(&mut self.phase) {
            ExitPhase::ClosingWindows {
                requested_code: Some(code),
            } if requested_code != Some(code) => ExitDecision::Reissue(code),
            ExitPhase::Idle | ExitPhase::ClosingWindows { .. } => ExitDecision::Allow,
        }
    }

    pub(crate) fn handle<R: tauri::Runtime>(
        &mut self,
        app: &tauri::AppHandle<R>,
        event: tauri::RunEvent,
    ) {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } = &event
        {
            self.handle_reopen(app, *has_visible_windows);
            return;
        }
        let tauri::RunEvent::ExitRequested { code, api, .. } = event else {
            return;
        };
        let windows = app.webview_windows();

        match self.decide(code, windows.len()) {
            ExitDecision::Allow => {}
            ExitDecision::CloseWindows => {
                api.prevent_exit();
                for window in windows.into_values() {
                    if let Err(error) = window.close() {
                        eprintln!(
                            "[durable-window-exit] close request failed: label={} error={error}",
                            window.label()
                        );
                    }
                }
            }
            ExitDecision::Reissue(code) => {
                api.prevent_exit();
                app.exit(code);
            }
        }
    }

    #[cfg(target_os = "macos")]
    fn handle_reopen<R: tauri::Runtime>(
        &mut self,
        app: &tauri::AppHandle<R>,
        has_visible_windows: bool,
    ) {
        if has_visible_windows {
            return;
        }
        let Some(config) = app.config().app.windows.iter().find(|window| window.create) else {
            eprintln!("[durable-window-exit] reopen failed: primary window config is missing");
            return;
        };
        if let Some(window) = app.get_webview_window(&config.label) {
            reveal_window(&window);
            return;
        }
        match tauri::WebviewWindowBuilder::from_config(app, config)
            .and_then(tauri::WebviewWindowBuilder::build)
        {
            Ok(window) => reveal_window(&window),
            Err(error) => eprintln!(
                "[durable-window-exit] reopen failed: label={} error={error}",
                config.label
            ),
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) const MACOS_QUIT_MENU_ID: &str = "dure.durable-quit";

#[cfg(target_os = "macos")]
pub(crate) fn macos_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind};

    let menu = Menu::default(app)?;
    let top_level_items = menu.items()?;
    let app_menu = top_level_items
        .first()
        .and_then(MenuItemKind::as_submenu)
        .ok_or_else(|| macos_default_menu_error("application submenu is missing"))?;
    let app_menu_items = app_menu.items()?;
    let quit_index = app_menu_items
        .len()
        .checked_sub(1)
        .ok_or_else(|| macos_default_menu_error("application submenu is empty"))?;
    if !matches!(app_menu_items.last(), Some(MenuItemKind::Predefined(_))) {
        return Err(macos_default_menu_error(
            "native Quit item is not the final application menu item",
        ));
    }
    app_menu.remove_at(quit_index)?;
    let durable_quit = MenuItemBuilder::with_id(
        MACOS_QUIT_MENU_ID,
        format!("Quit {}", app.package_info().name),
    )
    .accelerator("CmdOrCtrl+Q")
    .build(app)?;
    app_menu.append(&durable_quit)?;
    Ok(menu)
}

#[cfg(target_os = "macos")]
fn macos_default_menu_error(detail: &str) -> tauri::Error {
    std::io::Error::other(format!(
        "cannot install durable Quit in the macOS default menu: {detail}"
    ))
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_exit_closes_state_owning_windows_before_it_is_allowed() {
        let mut coordinator = DurableWindowExitCoordinator::default();

        assert_eq!(coordinator.decide(None, 3), ExitDecision::CloseWindows);
        assert_eq!(coordinator.decide(None, 0), ExitDecision::Allow);
    }

    #[test]
    fn explicit_exit_code_survives_the_window_close_round_trip() {
        let mut coordinator = DurableWindowExitCoordinator::default();

        assert_eq!(coordinator.decide(Some(42), 2), ExitDecision::CloseWindows);
        assert_eq!(coordinator.decide(None, 0), ExitDecision::Reissue(42));
        assert_eq!(coordinator.decide(Some(42), 0), ExitDecision::Allow);
    }

    #[test]
    fn a_repeated_request_keeps_the_original_exit_code_until_windows_close() {
        let mut coordinator = DurableWindowExitCoordinator::default();

        assert_eq!(coordinator.decide(Some(42), 2), ExitDecision::CloseWindows);
        assert_eq!(coordinator.decide(None, 1), ExitDecision::CloseWindows);
        assert_eq!(coordinator.decide(None, 0), ExitDecision::Reissue(42));
    }

    #[test]
    fn tauri_restart_is_not_intercepted_because_it_cannot_be_prevented() {
        let mut coordinator = DurableWindowExitCoordinator::default();

        assert_eq!(
            coordinator.decide(Some(tauri::RESTART_EXIT_CODE), 2),
            ExitDecision::Allow
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reopen_recreates_the_configured_window_once() {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().app.windows.push(Default::default());
        let app = tauri::test::mock_builder().build(context).unwrap();
        let mut coordinator = DurableWindowExitCoordinator::default();

        coordinator.handle_reopen(app.handle(), true);
        assert!(app.get_webview_window("main").is_none());

        coordinator.handle_reopen(app.handle(), false);
        coordinator.handle_reopen(app.handle(), false);

        assert!(app.get_webview_window("main").is_some());
        assert_eq!(app.webview_windows().len(), 1);
    }
}
