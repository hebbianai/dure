use crate::ssh::{directory, SshOptions};

#[tauri::command(async)]
pub fn ssh_browse_directory(
    opts: SshOptions,
    path: Option<String>,
) -> Result<directory::DirectoryListing, String> {
    directory::browse(&opts, path.as_deref())
}

#[tauri::command(async)]
pub fn ssh_project_directory(
    opts: SshOptions,
    path: String,
) -> Result<directory::ProjectDirectory, String> {
    directory::project(&opts, &path)
}
