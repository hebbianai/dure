use serde::{Deserialize, Serialize};
use std::fmt;

const MAX_RGB: u32 = 0x00ff_ffff;

/// Opaque sRGB defaults used only when a terminal program queries OSC 10/11.
///
/// These are embedder inputs, not terminal-origin overrides: DEFAULT cells
/// remain semantic and each attached renderer continues to resolve them from
/// its own theme.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalDefaultColors {
    foreground_rgb: u32,
    background_rgb: u32,
}

impl TerminalDefaultColors {
    pub fn new(foreground_rgb: u32, background_rgb: u32) -> Result<Self, InvalidRgbColor> {
        let colors = Self {
            foreground_rgb,
            background_rgb,
        };
        colors.validate()?;
        Ok(colors)
    }

    pub fn validate(self) -> Result<(), InvalidRgbColor> {
        if self.foreground_rgb > MAX_RGB || self.background_rgb > MAX_RGB {
            return Err(InvalidRgbColor);
        }
        Ok(())
    }

    #[must_use]
    pub fn foreground_rgb(self) -> u32 {
        self.foreground_rgb
    }

    #[must_use]
    pub fn background_rgb(self) -> u32 {
        self.background_rgb
    }
}

impl Default for TerminalDefaultColors {
    fn default() -> Self {
        Self {
            foreground_rgb: MAX_RGB,
            background_rgb: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidRgbColor;

impl fmt::Display for InvalidRgbColor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("terminal default color exceeds 24-bit sRGB")
    }
}

impl std::error::Error for InvalidRgbColor {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_neutral_white_on_black() {
        let colors = TerminalDefaultColors::default();
        assert_eq!(colors.foreground_rgb(), 0x00ff_ffff);
        assert_eq!(colors.background_rgb(), 0);
    }

    #[test]
    fn rejects_values_outside_24_bit_srgb() {
        assert_eq!(
            TerminalDefaultColors::new(0x0100_0000, 0),
            Err(InvalidRgbColor)
        );
        assert_eq!(
            TerminalDefaultColors::new(0, 0x0100_0000),
            Err(InvalidRgbColor)
        );
    }
}
