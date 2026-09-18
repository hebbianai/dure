use super::*;

fn ios() -> Target {
    Target {
        platform: Platform::Ios,
        id: "11111111-2222-3333-4444-555555555555".into(),
    }
}
fn android() -> Target {
    Target {
        platform: Platform::Android,
        id: "emulator-5554".into(),
    }
}

#[test]
fn discovery_keeps_exact_identity_state_and_only_available_ios_devices() {
    let devices = ios_devices(br#"{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-18-6":[{"udid":"11111111-2222-3333-4444-555555555555","name":"Phone","state":"Booted","isAvailable":true},{"udid":"22222222-2222-3333-4444-555555555555","name":"Phone","state":"Shutdown","isAvailable":false}],"com.apple.CoreSimulator.SimRuntime.watchOS-11-0":[]}}"#).unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].target.id, ios().id);
    assert_eq!(devices[0].state, "ready");
    assert_eq!(devices[0].runtime, "iOS 18 6");
    assert!(ios_devices(b"{}").is_err());
}

#[test]
fn android_discovery_preserves_offline_and_unauthorized_devices() {
    let devices = android_devices(b"List of devices attached\nemulator-5554 device product:sdk model:Pixel_8\nserial2 unauthorized\nserial3 offline\n").unwrap();
    assert_eq!(devices.len(), 3);
    assert_eq!(devices[0].name, "Pixel 8");
    assert_eq!(devices[1].state, "unauthorized");
    assert_eq!(devices[2].state, "offline");
    assert!(android_devices(b"unrecognized").is_err());
}

#[test]
fn no_implicit_booted_or_shell_selector_is_accepted() {
    for id in ["booted", "all", "--help", "", "$(touch /tmp/no)"] {
        assert!(validate_target(&Target {
            platform: Platform::Ios,
            id: id.into()
        })
        .is_err());
    }
    for id in ["", "-d", "x;echo bad", "a b", "x\n"] {
        assert!(validate_target(&Target {
            platform: Platform::Android,
            id: id.into()
        })
        .is_err());
    }
    assert!(validate_target(&android()).is_ok());
    assert!(validate_target(&ios()).is_ok());
}

#[test]
fn deep_links_preserve_parameters_without_remote_shell_expansion() {
    let url = "myapp://open?a=1&b='$(echo bad)'";
    let args = action_args(&android(), Action::OpenUrl { url: url.into() }).unwrap();
    assert_eq!(
        args.last().unwrap(),
        "'myapp://open?a=1&b='\\''$(echo bad)'\\'''"
    );
    let ios_args = action_args(
        &ios(),
        Action::OpenUrl {
            url: "https://localhost:8081/a?x=1&y=2".into(),
        },
    )
    .unwrap();
    assert_eq!(&ios_args[..2], &["openurl", &ios().id]);
    for url in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/plain,a",
        "intent://bad",
        "localhost:3000",
    ] {
        assert!(action_args(&android(), Action::OpenUrl { url: url.into() }).is_err());
    }
}

#[test]
fn app_launch_and_buttons_fail_closed_on_unsupported_or_unsafe_values() {
    assert!(action_args(
        &ios(),
        Action::Button {
            button: "home".into()
        }
    )
    .is_err());
    assert!(action_args(
        &android(),
        Action::Button {
            button: "shell".into()
        }
    )
    .is_err());
    assert!(action_args(
        &android(),
        Action::Launch {
            app_id: "x;reboot".into()
        }
    )
    .is_err());
    assert!(action_args(
        &android(),
        Action::Launch {
            app_id: "-help".into()
        }
    )
    .is_err());
    assert_eq!(
        action_args(
            &android(),
            Action::Button {
                button: "back".into()
            }
        )
        .unwrap(),
        ["shell", "input", "keyevent", "4"]
    );
    assert_eq!(
        action_args(
            &ios(),
            Action::Launch {
                app_id: "com.example.app".into()
            }
        )
        .unwrap(),
        ["launch", &ios().id, "com.example.app"]
    );
}

#[test]
fn touch_mapping_checks_ranges_and_keeps_edges_inside_screen() {
    assert_eq!(pixel(0.5, 100).unwrap(), "50");
    assert_eq!(pixel(1.0, 100).unwrap(), "99");
    for value in [-0.1, 1.1, f64::NAN, f64::INFINITY] {
        assert!(pixel(value, 100).is_err());
    }
    assert!(pixel(0.5, 0).is_err());
    assert!(png_dimensions(b"not a screenshot").is_err());
}

#[test]
fn installation_accepts_only_platform_artifacts_and_preserves_paths() {
    let root = tempfile::tempdir().unwrap();
    let app = root.path().join("My App.app");
    std::fs::create_dir(&app).unwrap();
    let apk = root.path().join("My App.apk");
    std::fs::write(&apk, b"fixture").unwrap();
    let path = app.to_string_lossy().into_owned();
    assert!(action_args(&ios(), Action::Install { path: path.clone() }).is_ok());
    assert!(action_args(&android(), Action::Install { path }).is_err());
    let path = apk.to_string_lossy().into_owned();
    assert!(action_args(&android(), Action::Install { path: path.clone() }).is_ok());
    assert!(action_args(&ios(), Action::Install { path }).is_err());
}

#[test]
fn bounded_process_reports_native_failure() {
    #[cfg(unix)]
    assert!(execute("/usr/bin/false", &[], 1, 1024).is_err());
}

#[test]
fn paste_preserves_unicode_and_refuses_invalid_text_before_live_admission() {
    for text in ["한글 🙂\nsecond\tline\r\n", &"x".repeat(8192)] {
        assert!(validate_paste(text).is_ok());
        let error = live::act(&ios(), &Action::Paste { text: text.into() }).unwrap_err();
        assert!(error.contains("Enable Live iOS"), "{error}");
        assert!(action_args(&android(), Action::Paste { text: text.into() }).is_err());
    }
    for text in [
        "",
        "a\0b",
        "\u{1b}[2J",
        "\u{85}",
        &"한".repeat(2731),
        &"x".repeat(8193),
    ] {
        let error = live::act(&ios(), &Action::Paste { text: text.into() }).unwrap_err();
        assert!(error.contains("Paste accepts"), "{error}");
    }
}

#[cfg(unix)]
#[test]
fn bounded_sdk_input_preserves_exact_utf8_without_shell_arguments() {
    let text = "한글 🙂\n'$HOME'\t%\\";
    assert_eq!(
        execute_with_input("/bin/cat", &[], 5, 8192, Some(text.as_bytes())).unwrap(),
        text.as_bytes()
    );
}

#[test]
fn android_activity_requires_a_success_receipt_even_when_adb_exits_zero() {
    assert!(verify_android_activity(b"Starting: Intent {...}\nStatus: ok\nComplete\n").is_ok());
    assert!(
        verify_android_activity(b"Error: Activity not started, unable to resolve Intent").is_err()
    );
    assert!(verify_android_activity(b"Starting: Intent {...}").is_err());
}

#[test]
fn android_text_stays_literal_and_refuses_unsupported_encoding() {
    let text = "hello ' $HOME; echo no";
    let args = action_args(&android(), Action::Type { text: text.into() }).unwrap();
    assert_eq!(
        args,
        ["shell", "input", "text", "'hello%s'\\''%s$HOME;%secho%sno'"]
    );
    for text in ["%s", "한글", "line\nbreak", ""] {
        assert!(action_args(&android(), Action::Type { text: text.into() }).is_err());
    }
}

#[test]
fn failed_sdk_commands_preserve_stdout_diagnostics() {
    let (program, args): (&str, &[&str]) = if cfg!(windows) {
        ("cmd.exe", &["/C", "echo SDK-install-failed & exit /b 7"])
    } else {
        ("/bin/sh", &["-c", "printf SDK-install-failed; exit 7"])
    };
    let error = execute(program, args, 5, 8192).unwrap_err();
    assert!(error.contains("SDK-install-failed"), "{error}");
    assert!(error.contains('7'), "{error}");
}

#[test]
fn sdk_timeouts_identify_the_operation_and_elapsed_bound() {
    let (program, args): (&str, &[&str]) = if cfg!(windows) {
        ("cmd.exe", &["/C", "ping -n 10 127.0.0.1 >nul"])
    } else {
        ("/bin/sh", &["-c", "sleep 10"])
    };
    let error = execute(program, args, 1, 8192).unwrap_err();
    assert!(error.contains("timed out after 1s"), "{error}");
    assert!(error.contains(args[0]), "{error}");
}

#[test]
fn launcher_resolution_requires_one_component_from_the_selected_package() {
    assert_eq!(
        android_launcher_component("com.app", b"com.app/.Main\r\n").unwrap(),
        "com.app/.Main"
    );
    for output in [
        "No activity found",
        "other.app/.Main",
        "android/com.android.ResolverActivity",
        "com.app/.One\ncom.app/.Two",
        "com.app/$(bad)",
    ] {
        assert!(android_launcher_component("com.app", output.as_bytes()).is_err());
    }
}
