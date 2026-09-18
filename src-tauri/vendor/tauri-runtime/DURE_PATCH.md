# Pinned Tauri runtime patch

Source: `tauri-runtime` 2.11.3 from crates.io, crate SHA-256
`b0b4bc95aed361b0019067d189a1174a603d460d0f6c72606512d59fc9c12ec8`.
Upstream commit from the crate's VCS metadata:
<https://github.com/tauri-apps/tauri/tree/6f6ab1207bb3923c2721fbc67d2fdb1c8deb0c7a/crates/tauri-runtime>.
Original normalized manifest, source, README and MIT/Apache-2.0 licenses are
retained. Cargo.lock remains owned by the consuming desktop application.

Dure's patch carries `WindowConfig.data_store_identifier` through the existing
`WebviewAttributes::from` conversion. Without it, both configured initial
windows and JS-created windows discard an explicit WKWebsiteDataStore identity.
The default remains unchanged when no identifier is supplied. The colocated
behavioral tests exercise this conversion directly, including the JS config
deserialization boundary. Native WebKit store-sharing requires a separate
runtime check; these conversion tests alone do not establish it.

Keep this diff limited to that field and its contract tests. Remove the path
patch when a pinned upstream release passes the same tests and native checks.
