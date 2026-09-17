/// Development installers opt into Pro explicitly even when optimized. Public
/// builds remain Basic-only until the product has a release entitlement policy.
pub(crate) const fn available() -> bool {
    cfg!(any(debug_assertions, feature = "browser-development"))
}
