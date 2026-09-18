/// Backend features behind the Beta interface (persisted as `pro`) ship in
/// every build. The interface preference controls presentation only.
pub(crate) const fn available() -> bool {
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn beta_features_are_available_in_every_build() {
        assert!(super::available());
    }
}
