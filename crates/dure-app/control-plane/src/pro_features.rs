/// Backend features behind the Beta interface (persisted as `pro`) ship in
/// every build. Keep this as the single hook for a future entitlement policy.
pub(crate) const fn available() -> bool {
    true
}

/// The managed Browser and the Slack connector need runtimes that public
/// bundles do not ship. Development installers opt in explicitly even when
/// optimized.
pub(crate) const fn development_previews_available() -> bool {
    cfg!(any(debug_assertions, feature = "browser-development"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn beta_features_are_available_in_every_build() {
        assert!(super::available());
    }

    #[test]
    fn development_previews_follow_the_development_build_policy() {
        assert_eq!(
            super::development_previews_available(),
            cfg!(any(debug_assertions, feature = "browser-development"))
        );
    }
}
