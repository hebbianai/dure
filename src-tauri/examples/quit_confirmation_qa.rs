//! Native Quit smoke fixture: the production menu/confirmation/exit adapter,
//! without Dure services, agent sessions, or the user's WebView storage.
//! Build with `cargo build --example quit_confirmation_qa`. Pass an existing
//! mktemp directory named dure-quit-native-*; optionally `--without-windows`.
//! Write `quit` to stdin to exercise Command-Q inside this process only. Never
//! use global keyboard injection: a frontmost-PID check cannot scope OS shortcuts.

#[cfg(target_os = "macos")]
#[path = "../src/durable_window_exit.rs"]
mod durable_window_exit;

#[cfg(target_os = "macos")]
fn exercise_command_q() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType};
    use objc2_foundation::{NSPoint, NSString};

    let main = MainThreadMarker::new().expect("QA menu dispatch must run on the main thread");
    let key = NSString::from_str("q");
    let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
        NSEventType::KeyDown, NSPoint::new(0.0, 0.0), NSEventModifierFlags::Command,
        0.0, 0, None, &key, &key, false, 12,
    ).expect("create fixture-local Command-Q event");
    let menu = NSApplication::sharedApplication(main).mainMenu().expect("QA menu must exist");
    println!("qa_command_q matched={}", menu.performKeyEquivalent(&event));
}

#[cfg(target_os = "macos")]
fn main() {
    use std::io::BufRead;
    use tauri::Manager;

    let root = std::fs::canonicalize(std::env::args().nth(1).expect("QA root required"))
        .expect("QA root must exist");
    assert!(root.is_dir());
    assert!(root.file_name().unwrap().to_string_lossy()
        .starts_with("dure-quit-native-"));
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.package_info_mut().name = "Dure Quit QA".into();
    context.config_mut().identifier = "dev.dure.quit-confirmation-qa".into();
    if !std::env::args().any(|arg| arg == "--without-windows") {
        for index in 0..2 {
            context.config_mut().app.windows.push(tauri::utils::config::WindowConfig {
                label: format!("quit-qa-{index}"),
                title: format!("Dure Quit QA {index}"),
                url: tauri::WebviewUrl::External("about:blank".parse().unwrap()),
                data_directory: Some(root.join(format!("webview-{index}"))),
                incognito: true,
                ..Default::default()
            });
        }
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(durable_window_exit::NativeQuitState::default())
        .menu(durable_window_exit::macos_menu)
        .on_menu_event(durable_window_exit::macos_menu_event)
        .invoke_handler(tauri::generate_handler![
            durable_window_exit::set_app_quit_confirmation_copy,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                println!("qa_close_requested label={}", window.label());
            }
        })
        .build(context)
        .unwrap();
    let handle = app.handle().clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line.as_deref() {
                Ok("quit") => handle.run_on_main_thread(exercise_command_q).unwrap(),
                Ok(_) => eprintln!("QA input accepts only: quit"),
                Err(_) => break,
            }
        }
    });
    let mut exit = durable_window_exit::DurableWindowExitCoordinator::default();
    app.run(move |app, event| {
        match &event {
            tauri::RunEvent::Ready => println!(
                "qa_ready pid={} windows={}",
                std::process::id(), app.webview_windows().len()
            ),
            tauri::RunEvent::Exit => println!("qa_exit"),
            _ => {}
        }
        exit.handle(app, event);
    });
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Native Quit smoke requires macOS");
}
