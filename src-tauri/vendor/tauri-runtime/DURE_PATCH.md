# Pinned Tauri runtime patch

Source: `tauri-runtime` 2.12.2 from crates.io, crate SHA-256
`7c55766d99cea69055904d1735b93c2049302b2e09effd462120deb5581d78e9`.
Upstream commit from the crate's VCS metadata:
<https://github.com/tauri-apps/tauri/tree/59b63ab500da9859f12d8888c3298bc29bba0b92/crates/tauri-runtime>.
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
