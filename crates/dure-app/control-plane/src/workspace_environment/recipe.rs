use std::collections::BTreeSet;
use std::fs;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(super) const MANIFEST: &str = "dure.environments.json";
const MAX_FILE_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u16,
    environments: Vec<Recipe>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Recipe {
    pub id: String,
    pub name: String,
    pub create: String,
    pub destroy: String,
    pub suspend: Option<String>,
    pub resume: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CapturedRecipe {
    pub id: String,
    pub name: String,
    pub digest: String,
    pub create: String,
    pub destroy: String,
    pub suspend: Option<String>,
    pub resume: Option<String>,
}

pub(super) fn project_root(path: &str) -> Result<PathBuf, &'static str> {
    let root = fs::canonicalize(path).map_err(|_| "environment_project_unavailable")?;
    if !Path::new(path).is_absolute() || !root.is_dir() {
        return Err("environment_project_invalid");
    }
    Ok(root)
}

pub(super) fn catalog(root: &Path) -> Result<Vec<CapturedRecipe>, &'static str> {
    let path = root.join(MANIFEST);
    if !path
        .try_exists()
        .map_err(|_| "environment_recipe_unavailable")?
    {
        return Ok(Vec::new());
    }
    let source = read_file(root, MANIFEST)?;
    let manifest: Manifest =
        serde_json::from_str(&source).map_err(|_| "environment_recipe_invalid")?;
    if manifest.schema_version != 1 || manifest.environments.len() > 32 {
        return Err("environment_recipe_invalid");
    }
    let mut ids = BTreeSet::new();
    manifest
        .environments
        .into_iter()
        .map(|recipe| {
            if !token(&recipe.id)
                || !label(&recipe.name)
                || !ids.insert(recipe.id.clone())
                || recipe.suspend.is_some() != recipe.resume.is_some()
            {
                return Err("environment_recipe_invalid");
            }
            let mut captured = CapturedRecipe {
                id: recipe.id,
                name: recipe.name,
                digest: String::new(),
                create: read_file(root, &recipe.create)?,
                destroy: read_file(root, &recipe.destroy)?,
                suspend: recipe
                    .suspend
                    .as_deref()
                    .map(|path| read_file(root, path))
                    .transpose()?,
                resume: recipe
                    .resume
                    .as_deref()
                    .map(|path| read_file(root, path))
                    .transpose()?,
            };
            if serde_json::to_vec(&captured)
                .map_err(|_| "environment_recipe_invalid")?
                .len()
                > 256 * 1024
            {
                return Err("environment_recipe_too_large");
            }
            captured.digest = format!(
                "sha256:{:x}",
                Sha256::digest(
                    serde_json::to_vec(&captured).map_err(|_| "environment_recipe_invalid")?
                )
            );
            Ok(captured)
        })
        .collect()
}

fn read_file(root: &Path, relative: &str) -> Result<String, &'static str> {
    if Path::new(relative).is_absolute() || relative.is_empty() {
        return Err("environment_script_invalid");
    }
    let path =
        fs::canonicalize(root.join(relative)).map_err(|_| "environment_script_unavailable")?;
    if !path.starts_with(root) {
        return Err("environment_script_outside_project");
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| "environment_script_unavailable")?;
    if !file
        .metadata()
        .map_err(|_| "environment_script_unavailable")?
        .is_file()
    {
        return Err("environment_script_invalid");
    }
    let mut source = String::new();
    std::io::Read::read_to_string(
        &mut std::io::Read::take(file, MAX_FILE_BYTES as u64 + 1),
        &mut source,
    )
    .map_err(|_| "environment_script_unavailable")?;
    if source.is_empty() || source.len() > MAX_FILE_BYTES || source.contains('\0') {
        return Err("environment_script_invalid");
    }
    Ok(source)
}

pub(super) fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

pub(super) fn label(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
