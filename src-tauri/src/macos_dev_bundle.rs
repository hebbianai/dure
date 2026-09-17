use fs2::FileExt;
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::{
        fs::{symlink, OpenOptionsExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

const DEV_BUNDLE_MARKER_ENV: &str = "DURE_MACOS_DEV_BUNDLE";
const DEV_BUNDLE_KEY_ENV: &str = "DURE_MACOS_DEV_BUNDLE_KEY";
const DEV_BUNDLE_ROOT: &str = ".dure-dev";
const DEV_BUNDLE_NAME: &str = "Dure.app";
const DEV_BUNDLE_SHORT_NAME: &str = "Dure";
const DEV_BUNDLE_ICON_FILE: &str = "Dure.icns";
const DEV_BUNDLE_ICON: &[u8] = include_bytes!("../icons/icon.icns");

#[derive(Debug)]
struct PreparedDevBundle {
    executable: PathBuf,
    _launch_lock: File,
}

pub fn reexec_if_needed(
    product_name: &str,
    bundle_identifier: &str,
    external_bins: &[String],
) -> io::Result<()> {
    if std::env::var(DEV_BUNDLE_MARKER_ENV).as_deref() != Ok("1") {
        return Ok(());
    }

    let executable = std::env::current_exe()?;
    if is_app_bundle_executable(&executable) {
        return Ok(());
    }
    let bundle_key = std::env::var(DEV_BUNDLE_KEY_ENV).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{DEV_BUNDLE_KEY_ENV} is required for a macOS development bundle"),
        )
    })?;
    let app_channel = crate::app_channel::configured_name()?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} is required for a macOS development bundle",
                crate::app_channel::APP_CHANNEL_ENV
            ),
        )
    })?;
    if bundle_key != app_channel {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the macOS development bundle key must equal the active app channel",
        ));
    }
    let prepared = prepare_dev_bundle(
        &executable,
        product_name,
        bundle_identifier,
        external_bins,
        &bundle_key,
    )?;
    let error = Command::new(&prepared.executable)
        .args(std::env::args_os().skip(1))
        .env_remove(DEV_BUNDLE_MARKER_ENV)
        .env_remove(DEV_BUNDLE_KEY_ENV)
        .exec();
    drop(prepared);
    Err(error)
}

fn prepare_dev_bundle(
    executable: &Path,
    product_name: &str,
    bundle_identifier: &str,
    external_bins: &[String],
    bundle_key: &str,
) -> io::Result<PreparedDevBundle> {
    if product_name.is_empty()
        || product_name.len() > 128
        || product_name.chars().any(char::is_control)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the macOS development display name must be 1-128 printable bytes",
        ));
    }
    if !valid_bundle_identifier(bundle_identifier) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the macOS development bundle identifier must be a Dure dev identifier",
        ));
    }
    if !valid_bundle_key(bundle_key) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the macOS development bundle key must be a lowercase app channel",
        ));
    }
    let executable_name = executable.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "the development executable has no filename",
        )
    })?;
    let output_dir = executable.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "the development executable has no output directory",
        )
    })?;
    if !fs::metadata(executable)?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the development executable is not a regular file",
        ));
    }

    let generated_root = output_dir.join(DEV_BUNDLE_ROOT);
    let channel_root = generated_root.join(bundle_key);
    ensure_directory(&generated_root)?;
    ensure_directory(&channel_root)?;
    let launch_lock = acquire_launch_lock(&channel_root.join(".launch.lock"))?;

    let bundle = channel_root.join(DEV_BUNDLE_NAME);
    let contents = bundle.join("Contents");
    let macos = contents.join("MacOS");
    let resource_root = contents.join("Resources");
    ensure_directory(&bundle)?;
    ensure_directory(&contents)?;
    ensure_directory(&macos)?;
    ensure_bundle_resource_directory(&resource_root)?;

    write_info_plist(
        &contents.join("Info.plist"),
        executable_name,
        product_name,
        bundle_identifier,
    )?;
    write_file_atomically(
        &resource_root.join(DEV_BUNDLE_ICON_FILE),
        DEV_BUNDLE_ICON,
    )?;
    for configured in external_bins {
        let name = Path::new(configured).file_name().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("external binary path has no filename: {configured}"),
            )
        })?;
        let source = output_dir.join(name);
        if !fs::metadata(&source)?.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("staged external binary is missing: {}", source.display()),
            ));
        }
        replace_with_hard_link(&source, &macos.join(name))?;
    }

    // Expose only Tauri's staged resource namespaces. Linking Contents/Resources
    // to the entire Cargo profile directory would include this generated app
    // bundle again and create an unbounded directory cycle for macOS storage
    // enumeration.
    for name in ["resources", "plugins"] {
        let source = output_dir.join(name);
        if !fs::symlink_metadata(&source)?.file_type().is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "staged development resource is not a directory: {}",
                    source.display()
                ),
            ));
        }
        replace_with_symlink(
            &Path::new("../../../../..").join(name),
            &resource_root.join(name),
        )?;
    }

    // Publishing the executable is the ready boundary. Every dependency above
    // is complete before another actor can launch this generation.
    let bundled_executable = macos.join(executable_name);
    replace_with_hard_link(executable, &bundled_executable)?;

    // Launch Services keys its cached app metadata, including the notification
    // icon, to the bundle's own modification time. Replacing Info.plist and the
    // icon below Contents does not change that time for an existing channel
    // bundle, so publish the completed generation before exec observes it.
    File::open(&bundle)?.set_modified(SystemTime::now())?;

    Ok(PreparedDevBundle {
        executable: bundled_executable,
        _launch_lock: launch_lock,
    })
}

fn valid_bundle_key(value: &str) -> bool {
    value.starts_with("dev-")
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_bundle_identifier(value: &str) -> bool {
    value
        .strip_prefix("io.hebbian.ade.dev.")
        .is_some_and(|hash| {
            hash.len() == 10
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

fn is_app_bundle_executable(executable: &Path) -> bool {
    let Some(macos) = executable.parent() else {
        return false;
    };
    let Some(contents) = macos.parent() else {
        return false;
    };
    let Some(bundle) = contents.parent() else {
        return false;
    };
    macos.file_name() == Some(OsStr::new("MacOS"))
        && contents.file_name() == Some(OsStr::new("Contents"))
        && bundle.extension() == Some(OsStr::new("app"))
}

fn ensure_directory(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "refusing non-directory development bundle path: {}",
                path.display()
            ),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => match fs::create_dir(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                match fs::symlink_metadata(path) {
                    Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
                    Ok(_) => Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        format!(
                            "refusing raced non-directory development bundle path: {}",
                            path.display()
                        ),
                    )),
                    Err(error) => Err(error),
                }
            }
            Err(error) => Err(error),
        },
        Err(error) => Err(error),
    }
}

fn ensure_bundle_resource_directory(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            let target = fs::read_link(path)?;
            if target != Path::new("../../../..") && target != Path::new("../../Resources") {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!(
                        "refusing unknown development bundle Resources link: {} -> {}",
                        path.display(),
                        target.display()
                    ),
                ));
            }
            fs::remove_file(path)?;
            ensure_directory(path)
        }
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "refusing non-directory development bundle Resources path: {}",
                path.display()
            ),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => ensure_directory(path),
        Err(error) => Err(error),
    }
}

fn acquire_launch_lock(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)?;
    FileExt::lock_exclusive(&file)?;
    Ok(file)
}

fn temporary_sibling(destination: &Path) -> io::Result<PathBuf> {
    let file_name = destination.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "atomic replacement destination has no filename",
        )
    })?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos();
    let mut temporary_name = OsString::from(".");
    temporary_name.push(file_name);
    temporary_name.push(format!(".next.{}.{timestamp}", std::process::id()));
    Ok(destination.with_file_name(temporary_name))
}

fn replace_with_hard_link(source: &Path, destination: &Path) -> io::Result<()> {
    let temporary = temporary_sibling(destination)?;
    if let Err(error) = fs::hard_link(source, &temporary) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn replace_with_symlink(target: &Path, destination: &Path) -> io::Result<()> {
    let temporary = temporary_sibling(destination)?;
    symlink(target, &temporary)?;
    if let Err(error) = fs::rename(&temporary, destination) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn write_info_plist(
    destination: &Path,
    executable_name: &OsStr,
    product_name: &str,
    bundle_identifier: &str,
) -> io::Result<()> {
    let executable_name = executable_name.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "the development executable name is not UTF-8",
        )
    })?;
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>{}</string>
	<key>CFBundleExecutable</key>
	<string>{}</string>
	<key>CFBundleIdentifier</key>
	<string>{}</string>
	<key>CFBundleIconFile</key>
	<string>{DEV_BUNDLE_ICON_FILE}</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>{}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
</dict>
</plist>
"#,
        xml_escape(product_name),
        xml_escape(executable_name),
        xml_escape(bundle_identifier),
        xml_escape(DEV_BUNDLE_SHORT_NAME),
    );
    write_file_atomically(destination, plist.as_bytes())
}

fn write_file_atomically(destination: &Path, contents: &[u8]) -> io::Result<()> {
    let temporary = temporary_sibling(destination)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        fs::rename(&temporary, destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    const KEY: &str = "dev-codex-16-a1b2c3d4e5";
    const OTHER_KEY: &str = "dev-uiux-22-e5f6a7b8c9";
    const IDENTIFIER: &str = "io.hebbian.ade.dev.a1b2c3d4e5";
    const OTHER_IDENTIFIER: &str = "io.hebbian.ade.dev.e5f6a7b8c9";

    fn bundle_path(root: &Path, key: &str) -> PathBuf {
        root.join(format!(
            "{DEV_BUNDLE_ROOT}/{key}/{DEV_BUNDLE_NAME}/Contents/MacOS/dure"
        ))
    }

    fn info_plist(root: &Path, key: &str) -> String {
        fs::read_to_string(
            bundle_path(root, key)
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("Info.plist"),
        )
        .unwrap()
    }

    fn info_plist_value<'a>(plist: &'a str, key: &str) -> Option<&'a str> {
        let key = format!("\t<key>{key}</key>\n\t<string>");
        let value = plist.split_once(&key)?.1;
        value.split_once("</string>").map(|(value, _)| value)
    }

    #[test]
    fn recognizes_only_executables_inside_an_app_bundle() {
        assert!(is_app_bundle_executable(Path::new(
            "/tmp/Dure.app/Contents/MacOS/dure"
        )));
        assert!(!is_app_bundle_executable(Path::new(
            "/tmp/target/debug/dure"
        )));
        assert!(!is_app_bundle_executable(Path::new(
            "/tmp/Dure.app/MacOS/dure"
        )));
    }

    #[test]
    fn validates_the_owner_scoped_bundle_key() {
        assert!(valid_bundle_key(KEY));
        for invalid in ["", "stable", "stable/dev", "Dev-Mixed", "../shared"] {
            assert!(!valid_bundle_key(invalid));
        }
    }

    #[test]
    fn validates_the_configured_dev_bundle_identifier() {
        assert!(valid_bundle_identifier(IDENTIFIER));
        for invalid in [
            "",
            "io.hebbian.ade",
            "io.hebbian.ade.dev.a1b2c3d4",
            "io.hebbian.ade.dev.a1b2c3d4e5ff",
            "io.hebbian.ade.dev.A1B2C3D4E5",
            "io.hebbian.ade.dev-codex-16-a1b2c3d4e5",
        ] {
            assert!(!valid_bundle_identifier(invalid), "accepted {invalid:?}");
        }
    }

    #[test]
    fn prepares_a_bundle_without_changing_the_executable_identity() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("dure");
        fs::write(&executable, b"first build").unwrap();
        fs::write(root.path().join("hmux-runtime"), b"runtime").unwrap();
        fs::write(root.path().join("hmux"), b"client").unwrap();
        fs::create_dir_all(root.path().join("resources")).unwrap();
        fs::write(
            root.path().join("resources/managed-claude-hook.py"),
            b"hook",
        )
        .unwrap();
        fs::create_dir_all(root.path().join("plugins/beads")).unwrap();
        fs::write(root.path().join("plugins/beads/dure-plugin.json"), b"{}").unwrap();
        let legacy_contents = root
            .path()
            .join(DEV_BUNDLE_ROOT)
            .join(KEY)
            .join(DEV_BUNDLE_NAME)
            .join("Contents");
        fs::create_dir_all(&legacy_contents).unwrap();
        symlink("../../../..", legacy_contents.join("Resources")).unwrap();

        let prepared = prepare_dev_bundle(
            &executable,
            "Dure Dev <codex & 16>",
            IDENTIFIER,
            &["binaries/hmux-runtime".into(), "binaries/hmux".into()],
            KEY,
        )
        .unwrap();

        assert_eq!(prepared.executable, bundle_path(root.path(), KEY));
        let source_metadata = fs::metadata(&executable).unwrap();
        let bundled_metadata = fs::metadata(&prepared.executable).unwrap();
        assert_eq!(source_metadata.dev(), bundled_metadata.dev());
        assert_eq!(source_metadata.ino(), bundled_metadata.ino());
        let contents = prepared.executable.parent().unwrap().parent().unwrap();
        let source_runtime = fs::metadata(root.path().join("hmux-runtime")).unwrap();
        let bundled_runtime =
            fs::symlink_metadata(prepared.executable.with_file_name("hmux-runtime")).unwrap();
        assert!(bundled_runtime.file_type().is_file());
        assert_eq!(source_runtime.ino(), bundled_runtime.ino());
        assert!(
            fs::symlink_metadata(contents.join("Resources"))
                .unwrap()
                .file_type()
                .is_dir(),
            "the app bundle must contain its Resources directory"
        );
        let resource_root = fs::canonicalize(contents.join("Resources")).unwrap();
        let executable = fs::canonicalize(&prepared.executable).unwrap();
        assert!(
            !executable.starts_with(&resource_root),
            "the bundle must not live below its own Resources target"
        );
        assert_eq!(
            fs::read_link(resource_root.join("resources")).unwrap(),
            Path::new("../../../../../resources")
        );
        assert_eq!(
            fs::read_link(resource_root.join("plugins")).unwrap(),
            Path::new("../../../../../plugins")
        );
        assert!(contents
            .join("Resources/resources/managed-claude-hook.py")
            .is_file());
        assert!(contents
            .join("Resources/plugins/beads/dure-plugin.json")
            .is_file());

        let plist = fs::read_to_string(contents.join("Info.plist")).unwrap();
        assert!(plist.contains("Dure Dev &lt;codex &amp; 16&gt;"));
        assert!(plist.contains("<key>CFBundleName</key>\n\t<string>Dure</string>"));
        assert_eq!(info_plist_value(&plist, "CFBundleExecutable"), Some("dure"));
        assert_eq!(
            info_plist_value(&plist, "CFBundleIdentifier"),
            Some("io.hebbian.ade.dev.a1b2c3d4e5")
        );
        assert_eq!(
            info_plist_value(&plist, "CFBundleIconFile"),
            Some("Dure.icns")
        );
        assert_eq!(
            fs::read(contents.join("Resources/Dure.icns")).unwrap(),
            include_bytes!("../icons/icon.icns")
        );
    }

    #[test]
    fn gives_each_generated_channel_bundle_its_own_native_identity() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("dure");
        fs::write(&executable, b"build").unwrap();
        fs::create_dir(root.path().join("resources")).unwrap();
        fs::create_dir(root.path().join("plugins")).unwrap();

        let first =
            prepare_dev_bundle(&executable, "Dure Dev first", IDENTIFIER, &[], KEY).unwrap();
        let second = prepare_dev_bundle(
            &executable,
            "Dure Dev second",
            OTHER_IDENTIFIER,
            &[],
            OTHER_KEY,
        )
        .unwrap();
        assert_ne!(first.executable, second.executable);

        let first_plist = info_plist(root.path(), KEY);
        let second_plist = info_plist(root.path(), OTHER_KEY);
        assert_eq!(
            info_plist_value(&first_plist, "CFBundleIdentifier"),
            Some(IDENTIFIER)
        );
        assert_eq!(
            info_plist_value(&second_plist, "CFBundleIdentifier"),
            Some(OTHER_IDENTIFIER)
        );
    }

    #[test]
    fn atomically_refreshes_the_bundle_to_the_latest_build_inode() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("dure");
        fs::write(&executable, b"first build").unwrap();
        fs::create_dir(root.path().join("resources")).unwrap();
        fs::create_dir(root.path().join("plugins")).unwrap();
        let first = prepare_dev_bundle(&executable, "Dure", IDENTIFIER, &[], KEY).unwrap();
        let first_path = first.executable.clone();
        let first_inode = fs::metadata(&first_path).unwrap().ino();
        drop(first);

        fs::remove_file(&executable).unwrap();
        fs::write(&executable, b"second build").unwrap();
        let second = prepare_dev_bundle(&executable, "Dure", IDENTIFIER, &[], KEY).unwrap();

        assert_eq!(second.executable, first_path);
        assert_ne!(first_inode, fs::metadata(&second.executable).unwrap().ino());
        assert_eq!(fs::read(&second.executable).unwrap(), b"second build");
    }

    #[test]
    fn republishes_the_bundle_after_refreshing_launch_services_metadata() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("dure");
        fs::write(&executable, b"first build").unwrap();
        fs::create_dir(root.path().join("resources")).unwrap();
        fs::create_dir(root.path().join("plugins")).unwrap();
        let first = prepare_dev_bundle(&executable, "Dure", IDENTIFIER, &[], KEY).unwrap();
        let bundle = first
            .executable
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        drop(first);

        File::open(&bundle)
            .unwrap()
            .set_modified(UNIX_EPOCH)
            .unwrap();
        assert_eq!(fs::metadata(&bundle).unwrap().modified().unwrap(), UNIX_EPOCH);

        let refreshed =
            prepare_dev_bundle(&executable, "Dure", IDENTIFIER, &[], KEY).unwrap();

        assert_eq!(
            refreshed.executable,
            bundle.join("Contents/MacOS/dure")
        );
        assert!(
            fs::metadata(&bundle).unwrap().modified().unwrap() > UNIX_EPOCH,
            "the ready bundle generation must be visible to Launch Services"
        );
    }

    #[test]
    fn refuses_to_follow_a_preexisting_channel_symlink() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let executable = root.path().join("dure");
        fs::write(&executable, b"build").unwrap();
        fs::create_dir(root.path().join(DEV_BUNDLE_ROOT)).unwrap();
        symlink(outside.path(), root.path().join(DEV_BUNDLE_ROOT).join(KEY)).unwrap();

        let error =
            prepare_dev_bundle(&executable, "Dure", IDENTIFIER, &[], KEY).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(!outside.path().join(DEV_BUNDLE_NAME).exists());
    }

    #[test]
    fn refuses_to_replace_an_unknown_resources_symlink() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let executable = root.path().join("dure");
        fs::write(&executable, b"build").unwrap();
        fs::create_dir(root.path().join("resources")).unwrap();
        fs::create_dir(root.path().join("plugins")).unwrap();
        let contents = root
            .path()
            .join(DEV_BUNDLE_ROOT)
            .join(KEY)
            .join(DEV_BUNDLE_NAME)
            .join("Contents");
        fs::create_dir_all(&contents).unwrap();
        symlink(outside.path(), contents.join("Resources")).unwrap();

        let error =
            prepare_dev_bundle(&executable, "Dure", IDENTIFIER, &[], KEY).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_link(contents.join("Resources")).unwrap(), outside.path());
    }
}
