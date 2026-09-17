use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;

#[derive(Clone, Copy)]
enum MacApplication {
    Finder,
    Name(&'static str),
    Bundle(&'static str),
}

#[derive(Clone, Copy)]
enum PathDelivery {
    Document,
    ProjectArgument,
}

#[derive(Clone, Copy)]
struct LaunchCandidate {
    application: MacApplication,
    delivery: PathDelivery,
}

#[derive(Clone, Copy)]
struct TargetSpec {
    id: &'static str,
    label: &'static str,
    group: &'static str,
    capability: &'static str,
    candidates: &'static [LaunchCandidate],
}

const fn finder() -> LaunchCandidate {
    LaunchCandidate {
        application: MacApplication::Finder,
        delivery: PathDelivery::Document,
    }
}

const fn application(name: &'static str) -> LaunchCandidate {
    LaunchCandidate {
        application: MacApplication::Name(name),
        delivery: PathDelivery::Document,
    }
}

const fn project_application(name: &'static str) -> LaunchCandidate {
    LaunchCandidate {
        application: MacApplication::Name(name),
        delivery: PathDelivery::ProjectArgument,
    }
}

const fn project_bundle(bundle: &'static str) -> LaunchCandidate {
    LaunchCandidate {
        application: MacApplication::Bundle(bundle),
        delivery: PathDelivery::ProjectArgument,
    }
}

static TARGETS: &[TargetSpec] = &[
    TargetSpec {
        id: "finder",
        label: "Finder",
        group: "finder",
        capability: "directory",
        candidates: &[finder()],
    },
    TargetSpec {
        id: "cursor",
        label: "Cursor",
        group: "editor",
        capability: "directory",
        candidates: &[application("Cursor")],
    },
    TargetSpec {
        id: "vscode",
        label: "VS Code family",
        group: "editor",
        capability: "directory",
        candidates: &[
            application("Visual Studio Code"),
            application("Visual Studio Code - Insiders"),
            application("VSCodium"),
        ],
    },
    TargetSpec {
        id: "xcode",
        label: "Xcode",
        group: "editor",
        capability: "directory",
        candidates: &[application("Xcode")],
    },
    TargetSpec {
        id: "sublime-text",
        label: "Sublime Text",
        group: "editor",
        capability: "directory",
        candidates: &[application("Sublime Text")],
    },
    TargetSpec {
        id: "intellij",
        label: "IntelliJ IDEA",
        group: "editor",
        capability: "project",
        candidates: &[
            project_bundle("com.jetbrains.intellij"),
            project_bundle("com.jetbrains.intellij.ce"),
        ],
    },
    TargetSpec {
        id: "webstorm",
        label: "WebStorm",
        group: "editor",
        capability: "project",
        candidates: &[project_application("WebStorm")],
    },
    TargetSpec {
        id: "pycharm",
        label: "PyCharm",
        group: "editor",
        capability: "project",
        candidates: &[
            project_bundle("com.jetbrains.pycharm"),
            project_bundle("com.jetbrains.pycharm.ce"),
        ],
    },
    TargetSpec {
        id: "phpstorm",
        label: "PhpStorm",
        group: "editor",
        capability: "project",
        candidates: &[project_application("PhpStorm")],
    },
    TargetSpec {
        id: "rubymine",
        label: "RubyMine",
        group: "editor",
        capability: "project",
        candidates: &[project_application("RubyMine")],
    },
    TargetSpec {
        id: "goland",
        label: "GoLand",
        group: "editor",
        capability: "project",
        candidates: &[project_application("GoLand")],
    },
    TargetSpec {
        id: "clion",
        label: "CLion",
        group: "editor",
        capability: "project",
        candidates: &[project_application("CLion")],
    },
    TargetSpec {
        id: "rider",
        label: "Rider",
        group: "editor",
        capability: "project",
        candidates: &[project_application("Rider")],
    },
    TargetSpec {
        id: "datagrip",
        label: "DataGrip",
        group: "editor",
        capability: "project",
        candidates: &[project_application("DataGrip")],
    },
    TargetSpec {
        id: "rustrover",
        label: "RustRover",
        group: "editor",
        capability: "project",
        candidates: &[project_application("RustRover")],
    },
    TargetSpec {
        id: "android-studio",
        label: "Android Studio",
        group: "editor",
        capability: "project",
        candidates: &[project_application("Android Studio")],
    },
    TargetSpec {
        id: "terminal",
        label: "Terminal",
        group: "terminal",
        capability: "directory",
        candidates: &[application("Terminal")],
    },
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalOpenTarget {
    id: &'static str,
    label: &'static str,
    group: &'static str,
    capability: &'static str,
    platforms: [&'static str; 1],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalWorkspaceOpenReceipt {
    schema_version: u8,
    target_id: &'static str,
    canonical_path: String,
    attempted_candidates: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalWorkspaceOpenError {
    code: &'static str,
    message: String,
    target_id: Option<String>,
}

impl ExternalWorkspaceOpenError {
    fn new(code: &'static str, message: impl Into<String>, target_id: Option<&str>) -> Self {
        Self {
            code,
            message: message.into(),
            target_id: target_id.map(str::to_owned),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct LaunchPlan {
    executable: &'static str,
    args: Vec<String>,
}

fn public_target(spec: &TargetSpec) -> ExternalOpenTarget {
    ExternalOpenTarget {
        id: spec.id,
        label: spec.label,
        group: spec.group,
        capability: spec.capability,
        platforms: ["macos"],
    }
}

fn target_spec(target_id: &str) -> Option<&'static TargetSpec> {
    TARGETS.iter().find(|target| target.id == target_id)
}

fn launch_plan(candidate: LaunchCandidate, path: &Path) -> LaunchPlan {
    let path = path.to_string_lossy().into_owned();
    let args = match (candidate.application, candidate.delivery) {
        (MacApplication::Finder, _) => vec![path],
        (MacApplication::Name(name), PathDelivery::Document) => {
            vec!["-a".into(), name.into(), path]
        }
        (MacApplication::Bundle(bundle), PathDelivery::Document) => {
            vec!["-b".into(), bundle.into(), path]
        }
        (MacApplication::Name(name), PathDelivery::ProjectArgument) => {
            vec!["-n".into(), "-a".into(), name.into(), "--args".into(), path]
        }
        (MacApplication::Bundle(bundle), PathDelivery::ProjectArgument) => {
            vec![
                "-n".into(),
                "-b".into(),
                bundle.into(),
                "--args".into(),
                path,
            ]
        }
    };
    LaunchPlan {
        executable: "/usr/bin/open",
        args,
    }
}

fn canonical_workspace_path(path: &str) -> Result<PathBuf, ExternalWorkspaceOpenError> {
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err(ExternalWorkspaceOpenError::new(
            "workspace_unavailable",
            "workspace path must be absolute",
            None,
        ));
    }
    let canonical = fs::canonicalize(requested).map_err(|_| {
        ExternalWorkspaceOpenError::new(
            "workspace_unavailable",
            "workspace path is unavailable",
            None,
        )
    })?;
    if !canonical.is_dir() {
        return Err(ExternalWorkspaceOpenError::new(
            "workspace_unavailable",
            "workspace path is not a directory",
            None,
        ));
    }
    Ok(canonical)
}

fn execute_target(
    spec: &'static TargetSpec,
    canonical_path: &Path,
    mut run: impl FnMut(&LaunchPlan) -> Result<(), ()>,
) -> Result<usize, ExternalWorkspaceOpenError> {
    for (index, candidate) in spec.candidates.iter().copied().enumerate() {
        if run(&launch_plan(candidate, canonical_path)).is_ok() {
            return Ok(index + 1);
        }
    }
    Err(ExternalWorkspaceOpenError::new(
        "target_unavailable",
        format!("{} is not installed or could not be opened", spec.label),
        Some(spec.id),
    ))
}

#[tauri::command]
pub fn external_workspace_targets() -> Vec<ExternalOpenTarget> {
    TARGETS.iter().map(public_target).collect()
}

#[tauri::command]
pub fn open_external_workspace(
    path: String,
    target_id: String,
) -> Result<ExternalWorkspaceOpenReceipt, ExternalWorkspaceOpenError> {
    let target_id = target_id.trim();
    let spec = target_spec(target_id).ok_or_else(|| {
        ExternalWorkspaceOpenError::new(
            "target_unknown",
            "external open target is unknown",
            Some(target_id),
        )
    })?;
    let canonical_path = canonical_workspace_path(&path)?;
    let canonical_path_text = canonical_path.to_str().ok_or_else(|| {
        ExternalWorkspaceOpenError::new(
            "workspace_unavailable",
            "canonical workspace path is not valid UTF-8",
            Some(target_id),
        )
    })?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (spec, canonical_path_text);
        Err(ExternalWorkspaceOpenError::new(
            "platform_unsupported",
            "external workspace opening is currently available on macOS",
            Some(target_id),
        ))
    }

    #[cfg(target_os = "macos")]
    {
        let attempted_candidates = execute_target(spec, &canonical_path, |plan| {
            Command::new(plan.executable)
                .args(&plan.args)
                .status()
                .map_err(|_| ())
                .and_then(|status| status.success().then_some(()).ok_or(()))
        })?;
        Ok(ExternalWorkspaceOpenReceipt {
            schema_version: 1,
            target_id: spec.id,
            canonical_path: canonical_path_text.to_owned(),
            attempted_candidates,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalog_has_stable_unique_targets_across_all_groups() {
        let catalog = external_workspace_targets();
        let ids = catalog
            .iter()
            .map(|target| target.id)
            .collect::<HashSet<_>>();
        let groups = catalog
            .iter()
            .map(|target| target.group)
            .collect::<HashSet<_>>();

        assert_eq!(ids.len(), catalog.len());
        assert!(ids.contains("finder"));
        assert!(ids.contains("cursor"));
        assert!(ids.contains("vscode"));
        assert!(ids.contains("intellij"));
        assert!(ids.contains("terminal"));
        assert_eq!(groups, HashSet::from(["finder", "editor", "terminal"]));
        assert!(catalog.iter().all(|target| target.platforms == ["macos"]));
    }

    #[test]
    fn shell_metacharacters_remain_one_path_argument() {
        let path = Path::new("/tmp/work tree;$(touch should-not-run)");
        let ordinary = launch_plan(application("Cursor"), path);
        let jetbrains = launch_plan(project_bundle("com.jetbrains.intellij"), path);

        assert_eq!(ordinary.executable, "/usr/bin/open");
        assert_eq!(ordinary.args, ["-a", "Cursor", path.to_str().unwrap()]);
        assert_eq!(
            jetbrains.args,
            [
                "-n",
                "-b",
                "com.jetbrains.intellij",
                "--args",
                path.to_str().unwrap(),
            ]
        );
    }

    #[test]
    fn bounded_candidates_preserve_order_without_editor_fallback() {
        let spec = target_spec("vscode").unwrap();
        let mut attempts = Vec::new();
        let attempted = execute_target(spec, Path::new("/repo"), |plan| {
            attempts.push(plan.args.clone());
            if attempts.len() == 2 {
                Ok(())
            } else {
                Err(())
            }
        })
        .unwrap();

        assert_eq!(attempted, 2);
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0][1], "Visual Studio Code");
        assert_eq!(attempts[1][1], "Visual Studio Code - Insiders");
    }

    #[test]
    fn candidate_exhaustion_is_a_typed_unavailable_error() {
        let error = execute_target(target_spec("pycharm").unwrap(), Path::new("/repo"), |_| {
            Err(())
        })
        .unwrap_err();

        assert_eq!(error.code, "target_unavailable");
        assert_eq!(error.target_id.as_deref(), Some("pycharm"));
    }
}
