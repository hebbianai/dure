// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Vercel Inc.
// Adapted from agent-browser c830d1b67dc18b754e305859f0ae587f858a1447,
// cli/src/native/diff.rs. License: ../environment/device/LICENSE-agent-browser.

use super::{
    BrowserPageIdentity, BrowserRuntimeError, CapturedFile, Execution, ImageCapture, ImageFormat,
    MAX_ARTIFACT_BYTES, MAX_CAPTURE_DIMENSION, MAX_CAPTURE_PIXELS,
};
use image::{DynamicImage, ImageDecoder, ImageReader, Limits, Rgba, RgbaImage};
use serde_json::{Value, json};
use std::io::Cursor;

pub(crate) struct CapturedImageDiff {
    pub(crate) file: Option<CapturedFile>,
    pub(crate) viewport: Value,
    pub(crate) report: Value,
}

impl Execution<'_> {
    pub(crate) async fn capture_diff(
        &self,
        page: &BrowserPageIdentity,
        options: &ImageCapture,
        baseline: &super::super::BrowserUploadId,
        threshold: f64,
    ) -> Result<CapturedImageDiff, BrowserRuntimeError> {
        if !threshold.is_finite() || !(0.0..=1.0).contains(&threshold) {
            return Err("browser_diff_threshold_invalid".into());
        }
        if !matches!(options.format, ImageFormat::Png)
            || options.annotate
            || options.quality.is_some()
        {
            return Err("browser_diff_capture_options_invalid".into());
        }
        let baseline = self
            .resource
            .uploads
            .lock()
            .await
            .read_sealed_with_limit(baseline, MAX_ARTIFACT_BYTES as u64)
            .await?;
        let baseline = tokio::task::spawn_blocking(move || decode(&baseline))
            .await
            .map_err(|_| "browser_diff_worker_failed")??;
        let captured = self.capture_image(page, options).await?;
        let source_page = captured.file.page;
        let current = captured.file.bytes;
        let (report, bytes) =
            tokio::task::spawn_blocking(move || compare(&baseline, &decode(&current)?, threshold))
                .await
                .map_err(|_| "browser_diff_worker_failed")??;
        Ok(CapturedImageDiff {
            file: bytes.map(|bytes| CapturedFile {
                page: source_page,
                mime_type: "image/png",
                suggested_filename: None,
                bytes,
            }),
            viewport: captured.viewport,
            report,
        })
    }
}

fn decode(bytes: &[u8]) -> Result<DynamicImage, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_ARTIFACT_BYTES {
        return Err("browser_diff_image_invalid");
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "browser_diff_image_invalid")?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_CAPTURE_DIMENSION);
    limits.max_image_height = Some(MAX_CAPTURE_DIMENSION);
    reader.limits(limits.clone());
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| "browser_diff_image_invalid")?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_CAPTURE_PIXELS {
        return Err("browser_capture_pixel_limit");
    }
    // Retain ImageReader's output-allocation accounting after checking the
    // existing capture pixel bound. Codec-internal allocation limits remain
    // best effort, as documented by image::Limits.
    limits
        .reserve(decoder.total_bytes())
        .map_err(|_| "browser_capture_pixel_limit")?;
    decoder
        .set_limits(limits)
        .map_err(|_| "browser_diff_image_invalid")?;
    DynamicImage::from_decoder(decoder).map_err(|_| "browser_diff_image_invalid")
}

fn compare(
    baseline: &DynamicImage,
    current: &DynamicImage,
    threshold: f64,
) -> Result<(Value, Option<Vec<u8>>), &'static str> {
    let (width, height) = (baseline.width(), baseline.height());
    let total = u64::from(width) * u64::from(height);
    let report = |different, mismatch, dimensions| {
        json!({
            "match": different == 0 && dimensions == Value::Null,
            "mismatchPercentage": mismatch, "totalPixels": total,
            "differentPixels": different, "dimensionMismatch": dimensions,
        })
    };
    if (width, height) != (current.width(), current.height()) {
        return Ok((
            report(
                total,
                100.0,
                json!({
                    "expected":{"width":width,"height":height},
                    "actual":{"width":current.width(),"height":current.height()},
                }),
            ),
            None,
        ));
    }
    let a = baseline.to_rgba8();
    let b = current.to_rgba8();
    let mut difference = RgbaImage::new(width, height);
    // Compare squared distances so the closed upper threshold includes
    // black versus white without a one-ULP square-root rounding discrepancy.
    let maximum_squared = threshold * threshold * (3.0 * 255.0 * 255.0);
    let mut different = 0_u64;
    for ((pa, pb), output) in a.pixels().zip(b.pixels()).zip(difference.pixels_mut()) {
        let dr = f64::from(pa[0]) - f64::from(pb[0]);
        let dg = f64::from(pa[1]) - f64::from(pb[1]);
        let db = f64::from(pa[2]) - f64::from(pb[2]);
        if dr * dr + dg * dg + db * db > maximum_squared {
            different += 1;
            *output = Rgba([255, 0, 0, 255]);
        } else {
            let gray = ((u16::from(pa[0]) + u16::from(pa[1]) + u16::from(pa[2])) / 3) as u8;
            let dimmed = (f64::from(gray) * 0.3) as u8;
            *output = Rgba([dimmed, dimmed, dimmed, 255]);
        }
    }
    let bytes = if different > 0 {
        let mut output = Cursor::new(Vec::new());
        difference
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|_| "browser_diff_image_invalid")?;
        let bytes = output.into_inner();
        if bytes.len() > MAX_ARTIFACT_BYTES {
            return Err("browser_capture_byte_limit");
        }
        Some(bytes)
    } else {
        None
    };
    let mismatch = if total == 0 {
        0.0
    } else {
        different as f64 / total as f64 * 100.0
    };
    Ok((report(different, mismatch, Value::Null), bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgba(pixels: &[[u8; 4]], width: u32, height: u32) -> DynamicImage {
        DynamicImage::ImageRgba8(
            RgbaImage::from_raw(
                width,
                height,
                pixels.iter().flat_map(|pixel| *pixel).collect(),
            )
            .unwrap(),
        )
    }

    #[test]
    fn color_distance_alpha_and_diff_pixels_match_the_native_algorithm() {
        let before = rgba(
            &[
                [100, 150, 200, 0],
                [0, 0, 0, 255],
                [10, 20, 30, 255],
                [255, 255, 255, 255],
            ],
            2,
            2,
        );
        let after = rgba(
            &[
                [100, 150, 200, 255],
                [1, 0, 0, 255],
                [255, 0, 0, 255],
                [255, 255, 255, 255],
            ],
            2,
            2,
        );
        let (report, image) = compare(&before, &after, 0.1).unwrap();
        assert_eq!(
            report,
            json!({"match":false,"mismatchPercentage":25.0,
            "totalPixels":4,"differentPixels":1,"dimensionMismatch":null})
        );
        let image = decode(&image.unwrap()).unwrap().to_rgba8();
        assert_eq!(
            image.into_raw(),
            [
                45, 45, 45, 255, 0, 0, 0, 255, 255, 0, 0, 255, 76, 76, 76, 255
            ]
        );
        assert_eq!(
            compare(&before, &after, 0.0).unwrap().0["differentPixels"],
            2
        );
        let (report, image) = compare(&before, &after, 1.0).unwrap();
        assert_eq!(report["match"], true);
        assert!(image.is_none());
        let alpha = rgba(&[[100, 150, 200, 255]], 1, 1);
        assert_eq!(
            compare(&rgba(&[[100, 150, 200, 0]], 1, 1), &alpha, 0.0)
                .unwrap()
                .0["match"],
            true
        );
    }

    #[test]
    fn maximum_threshold_includes_black_white_distance_in_both_directions() {
        let black = rgba(&[[0, 0, 0, 255]], 1, 1);
        let white = rgba(&[[255, 255, 255, 255]], 1, 1);
        for (before, after) in [(&black, &white), (&white, &black)] {
            let (report, image) = compare(before, after, 1.0).unwrap();
            assert_eq!(report["match"], true);
            assert_eq!(report["differentPixels"], 0);
            assert!(image.is_none());
            assert_eq!(
                compare(before, after, 0.999).unwrap().0["differentPixels"],
                1
            );
        }
    }

    #[test]
    fn equal_images_and_different_dimensions_produce_no_diff_file() {
        let before = DynamicImage::new_rgb8(2, 2);
        let (equal, image) = compare(&before, &before, 0.0).unwrap();
        assert_eq!(equal["match"], true);
        assert_eq!(equal["differentPixels"], 0);
        assert!(image.is_none());
        let (changed, image) = compare(&before, &DynamicImage::new_rgb8(4, 1), 0.1).unwrap();
        assert_eq!(
            changed,
            json!({"match":false,"mismatchPercentage":100.0,
            "totalPixels":4,"differentPixels":4,"dimensionMismatch":{
                "expected":{"width":2,"height":2},"actual":{"width":4,"height":1}}})
        );
        assert!(image.is_none());
    }

    #[test]
    fn baseline_decoding_uses_the_native_default_format_family() {
        use image::ImageFormat;
        // The ICO encoder accepts RGB PNG payloads, but its decoder requires
        // RGBA. Prove that this malformed fixture also fails upstream.
        let mut invalid_ico = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(2, 2)
            .write_to(&mut invalid_ico, ImageFormat::Ico)
            .unwrap();
        assert!(image::load_from_memory(invalid_ico.get_ref()).is_err());
        assert!(decode(invalid_ico.get_ref()).is_err());
        for format in [
            ImageFormat::Png,
            ImageFormat::Jpeg,
            ImageFormat::Gif,
            ImageFormat::WebP,
            ImageFormat::Tiff,
            ImageFormat::Bmp,
            ImageFormat::Ico,
            ImageFormat::Pnm,
            ImageFormat::Qoi,
            ImageFormat::Farbfeld,
            ImageFormat::Hdr,
            ImageFormat::OpenExr,
        ] {
            let source = if matches!(format, ImageFormat::Hdr | ImageFormat::OpenExr) {
                DynamicImage::new_rgb32f(2, 2)
            } else if format == ImageFormat::Ico {
                DynamicImage::new_rgba8(2, 2)
            } else if format == ImageFormat::Farbfeld {
                DynamicImage::new_rgba16(2, 2)
            } else {
                DynamicImage::new_rgb8(2, 2)
            };
            let mut bytes = Cursor::new(Vec::new());
            source.write_to(&mut bytes, format).unwrap();
            image::load_from_memory(bytes.get_ref())
                .unwrap_or_else(|error| panic!("upstream {format:?}: {error}"));
            let decoded =
                decode(bytes.get_ref()).unwrap_or_else(|error| panic!("{format:?}: {error}"));
            assert_eq!((decoded.width(), decoded.height()), (2, 2), "{format:?}");
        }
    }

    #[test]
    fn malformed_and_over_pixel_bound_images_fail_before_pixel_conversion() {
        assert!(decode(b"").is_err());
        assert!(decode(b"not an image").is_err());
        assert!(decode(b"\x89PNG\r\n\x1a\n").is_err());
        let mut over = b"P5\n4001 4000\n255\n".to_vec();
        over.resize(over.len() + 4001 * 4000, 0);
        assert_eq!(decode(&over).unwrap_err(), "browser_capture_pixel_limit");
    }
}
