use super::{BrowserActionPermit, BrowserCdp, BrowserRuntimeError, Execution};
use crate::browser_engine::{BrowserEngineError, NativeBrowserEngine, NativeBrowserResponse};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmux_session_protocol::browser_resource::{BrowserPageIdentity, BrowserSnapshotIdentity};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[cfg(test)]
use super::BrowserRuntime;
#[cfg(test)]
mod tests;

mod annotations;
mod diff;
pub(crate) use diff::CapturedImageDiff;

const MAX_CAPTURE_DIMENSION: u32 = 65_535;
const MAX_CAPTURE_PIXELS: u64 = 16_000_000;

pub(crate) const MAX_ARTIFACT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ImageFormat {
    #[default]
    Png,
    Jpeg,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageCapture {
    #[serde(default)]
    full_page: bool,
    #[serde(default)]
    format: ImageFormat,
    target: Option<super::BrowserElementTarget>,
    quality: Option<u8>,
    #[serde(default)]
    annotate: bool,
}

pub(crate) struct CapturedImage {
    pub(crate) file: CapturedFile,
    pub(crate) viewport: Value,
    pub(crate) snapshot: Option<BrowserSnapshotIdentity>,
    pub(crate) annotations: Vec<Value>,
}

pub(crate) struct CapturedFile {
    pub(crate) page: BrowserPageIdentity,
    pub(crate) mime_type: &'static str,
    pub(crate) suggested_filename: Option<String>,
    pub(crate) bytes: Vec<u8>,
}

impl Execution<'_> {
    pub(crate) async fn capture_image(
        &self,
        page: &BrowserPageIdentity,
        options: &ImageCapture,
    ) -> Result<CapturedImage, BrowserRuntimeError> {
        self.capture_view(page, options, false).await
    }

    async fn capture_view(
        &self,
        page: &BrowserPageIdentity,
        options: &ImageCapture,
        live: bool,
    ) -> Result<CapturedImage, BrowserRuntimeError> {
        if options.quality.is_some_and(|quality| quality > 100) {
            return Err("browser_capture_quality_invalid".into());
        }
        let mut engine = self.engine().await?;
        let mut observed = self.observe_engine(&mut engine).await?;
        let target = self.resource.host.lock().await.target_for(page)?.clone();
        self.validate_capture_reference(page, options).await?;
        let framed = options.target.is_some() || options.annotate;
        let frame = if framed {
            self.resource.host.lock().await.selected_frame(page)?
        } else {
            None
        };
        let cdp = self
            .document_cdp(
                self.renderer_cdp(observed.cdp.clone(), target.clone()),
                frame.clone(),
            )
            .await?;
        let selected_box = if let Some(element) = &options.target {
            Some(
                element
                    .resolve(cdp.clone(), target.as_str())
                    .await?
                    .page_box()
                    .await?,
            )
        } else {
            None
        };
        let session = observed.cdp.attach(target.as_str()).await?;
        observed
            .cdp
            .request("Page.enable", json!({}), Some(&session))
            .await?;
        let metrics = observed
            .cdp
            .request("Page.getLayoutMetrics", json!({}), Some(&session))
            .await?;
        // Chromium owns both emulation and effective density. Read its native
        // getter in our isolated world; the page cannot lower this allocation
        // bound by replacing window.devicePixelRatio in its own world.
        let context = observed.cdp.isolated_context(&session).await?;
        let window = observed.cdp.request("Runtime.evaluate",json!({"expression":"({density:window.devicePixelRatio,width:window.innerWidth,height:window.innerHeight})","contextId":context,"returnByValue":true,"throwOnSideEffect":true}),Some(&session)).await?;
        let positive = |value: &Value| {
            value
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0)
                .ok_or("browser_capture_dimensions_invalid")
        };
        let window = &window["result"]["value"];
        let density = positive(&window["density"])?;
        let viewport = &metrics["cssVisualViewport"];
        let page_scale = positive(&viewport["scale"])?;
        // Unclipped screenshots include rendered scrollbars. CDP's client
        // dimensions exclude them; the native inner dimensions include them.
        // Convert the visible surface back to CSS coordinates at pinch scale.
        let viewport_width = positive(&window["width"])? / page_scale;
        let viewport_height = positive(&window["height"])? / page_scale;
        let dimension = |value: f64| -> Result<f64, BrowserRuntimeError> {
            if value.is_finite() && value > 0.0 && value <= f64::from(MAX_CAPTURE_DIMENSION) {
                Ok(value.ceil())
            } else {
                Err("browser_capture_dimensions_invalid".into())
            }
        };
        let scroll_x = metrics["cssLayoutViewport"]["pageX"]
            .as_f64()
            .ok_or("browser_capture_dimensions_invalid")?;
        let scroll_y = metrics["cssLayoutViewport"]["pageY"]
            .as_f64()
            .ok_or("browser_capture_dimensions_invalid")?;
        let element_clip = selected_box.as_ref().filter(|_| !options.full_page);
        let clipped = options.full_page || element_clip.is_some();
        let (width, height) = if options.full_page {
            (
                dimension(positive(&metrics["cssContentSize"]["width"])?)?,
                dimension(positive(&metrics["cssContentSize"]["height"])?)?,
            )
        } else if let Some(rect) = element_clip {
            (
                dimension(positive(&rect["width"])?)?,
                dimension(positive(&rect["height"])?)?,
            )
        } else {
            (dimension(viewport_width)?, dimension(viewport_height)?)
        };
        let (x, y) = if options.full_page {
            (0.0, 0.0)
        } else if let Some(rect) = element_clip {
            (
                rect["x"].as_f64().unwrap() + scroll_x,
                rect["y"].as_f64().unwrap() + scroll_y,
            )
        } else {
            (
                metrics["cssVisualViewport"]["pageX"]
                    .as_f64()
                    .ok_or("browser_capture_dimensions_invalid")?,
                metrics["cssVisualViewport"]["pageY"]
                    .as_f64()
                    .ok_or("browser_capture_dimensions_invalid")?,
            )
        };
        if !x.is_finite() || !y.is_finite() {
            return Err("browser_capture_dimensions_invalid".into());
        }
        let scale = if clipped {
            // A full-page clip is in DIPs; remove browser zoom from the native
            // ratio. Viewport capture also includes the visual viewport scale.
            density / positive(&viewport["zoom"])?
        } else {
            density * page_scale
        };
        let pixel_width = (width * scale).ceil();
        let pixel_height = (height * scale).ceil();
        let mut viewport = json!({
            "width":if element_clip.is_some() { width } else { viewport_width },
            "height":if element_clip.is_some() { height } else { viewport_height },
            "pixel_ratio":scale,
        });
        if !pixel_width.is_finite()
            || !pixel_height.is_finite()
            || pixel_width > f64::from(MAX_CAPTURE_DIMENSION)
            || pixel_height > f64::from(MAX_CAPTURE_DIMENSION)
            || pixel_width * pixel_height > MAX_CAPTURE_PIXELS as f64
        {
            return Err("browser_capture_pixel_limit".into());
        }
        let mut params = json!({"format":if options.annotate { json!("png") } else { json!(options.format) },"captureBeyondViewport":clipped,"fromSurface":true});
        if !options.annotate && matches!(options.format, ImageFormat::Jpeg) {
            params["quality"] = options.quality.unwrap_or(90).into();
        }
        if clipped {
            params["clip"] = json!({"x":x,"y":y,"width":width,"height":height,"scale":1});
        }
        let annotation = if options.annotate {
            Some(
                annotations::observe(
                    cdp,
                    target.as_str(),
                    [x, y, width, height],
                    [scroll_x, scroll_y],
                    selected_box.as_ref(),
                )
                .await?,
            )
        } else {
            None
        };
        if live {
            // A frame read needs the current surface even when a resize produces
            // no subsequent compositor event. Keep the live image in CSS pixels.
            params["clip"] = json!({"x":x,"y":y,"width":width,"height":height,"scale":1.0 / scale});
            params["optimizeForSpeed"] = true.into();
        }
        let captured = observed.cdp.capture_screenshot(params, &session).await?;
        let mut bytes = STANDARD
            .decode(captured["data"].as_str().ok_or("browser_capture_invalid")?)
            .map_err(|_| "browser_capture_invalid")?;
        if bytes.is_empty() || bytes.len() > MAX_ARTIFACT_BYTES {
            return Err("browser_capture_byte_limit".into());
        }
        if live {
            // Validate encoded bounds and publish the actual CSS-to-image ratio
            // without decoding or allocating its pixels.
            let (width, height) = image::ImageReader::with_format(
                std::io::Cursor::new(&bytes),
                image::ImageFormat::Jpeg,
            )
            .into_dimensions()
            .map_err(|_| "browser_capture_invalid")?;
            if width == 0
                || height == 0
                || width > MAX_CAPTURE_DIMENSION
                || height > MAX_CAPTURE_DIMENSION
                || u64::from(width) * u64::from(height) > MAX_CAPTURE_PIXELS
            {
                return Err("browser_capture_pixel_limit".into());
            }
            let ratio = f64::from(width) / viewport_width;
            if (f64::from(height) - viewport_height * ratio).abs() > 1.0 {
                return Err("browser_capture_dimensions_invalid".into());
            }
            viewport["pixel_ratio"] = ratio.into();
        }
        let (data, elements) = annotation.unwrap_or_default();
        if options.annotate {
            let mut capture_cdp = self.renderer_cdp(observed.cdp.clone(), target.clone());
            bytes = annotations::render(
                &mut capture_cdp,
                &session,
                context,
                &bytes,
                &data,
                scale,
                options,
            )
            .await?;
        }
        self.observe_engine(&mut engine).await?;
        self.resource.host.lock().await.target_for(page)?;
        if framed {
            self.validate_selected_frame(page, &frame).await?;
        }
        self.validate_capture_reference(page, options).await?;
        let snapshot = if options.annotate {
            Some(
                self.resource
                    .host
                    .lock()
                    .await
                    .snapshot_observed_in_frame(page, &frame, elements)?,
            )
        } else {
            None
        };
        Ok(CapturedImage {
            file: CapturedFile {
                page: page.clone(),
                suggested_filename: None,
                mime_type: match options.format {
                    ImageFormat::Png => "image/png",
                    ImageFormat::Jpeg => "image/jpeg",
                },
                bytes,
            },
            viewport,
            snapshot,
            annotations: data,
        })
    }

    async fn validate_capture_reference(
        &self,
        page: &BrowserPageIdentity,
        options: &ImageCapture,
    ) -> Result<(), BrowserRuntimeError> {
        if let Some(reference) = options
            .target
            .as_ref()
            .and_then(super::BrowserElementTarget::reference)
        {
            if reference.snapshot.page != *page {
                return Err("browser_reference_page_mismatch".into());
            }
            self.resource
                .host
                .lock()
                .await
                .validate_element(reference)?;
        }
        Ok(())
    }

    /// Retain the original in-process observer API; transport clients download
    /// persisted captures in chunks through the artifact operation.
    pub async fn screenshot(
        &self,
        page: &BrowserPageIdentity,
    ) -> Result<Value, BrowserRuntimeError> {
        let CapturedImage { file, viewport, .. } = self
            .capture_view(page, &ImageCapture::default(), false)
            .await?;
        Ok(
            json!({"page":file.page,"mimeType":file.mime_type,"base64":STANDARD.encode(file.bytes),"viewport":viewport}),
        )
    }

    pub(super) async fn frame(
        &self,
        page: &BrowserPageIdentity,
    ) -> Result<Value, BrowserRuntimeError> {
        let options = ImageCapture {
            full_page: false,
            format: ImageFormat::Jpeg,
            ..ImageCapture::default()
        };
        let CapturedImage { file, viewport, .. } = self.capture_view(page, &options, true).await?;
        Ok(
            json!({"page":file.page,"mimeType":file.mime_type,"base64":STANDARD.encode(file.bytes),"viewport":viewport}),
        )
    }

    pub(super) async fn print_pdf(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        page: &BrowserPageIdentity,
        mut cdp: BrowserCdp,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let target = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        let session = cdp.attach(target.as_str()).await?;
        cdp.request("Page.enable", json!({}), Some(&session))
            .await?;
        self.observe_engine(engine).await?;
        self.resource.host.lock().await.dispatch_target(permit)?;
        // Printing executes beforeprint/afterprint handlers. It is an admitted
        // operation, even though its output is a document.
        let printed = cdp
            .print_pdf(&session)
            .await
            .map_err(|_| BrowserEngineError::after("browser_pdf_outcome_unknown"))?;
        let Some(handle) = printed["stream"].as_str() else {
            return Err(BrowserEngineError::after("browser_pdf_stream_missing").into());
        };
        // The returned stream is browser I/O, independent of a later renderer
        // dialog or retirement fence. Keep its bounded read and close path.
        let mut io = self.binding.cdp.clone();
        let content = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            read_pdf(&mut io, &session, handle),
        )
        .await
        .unwrap_or(Err("browser_pdf_stream_timeout"));
        let closed = io
            .request("IO.close", json!({"handle":handle}), Some(&session))
            .await;
        let bytes = match content.and_then(|bytes| closed.map(|_| bytes)) {
            Ok(bytes) => bytes,
            Err(code) => {
                return Ok(NativeBrowserResponse {
                    id: "browser-pdf".into(),
                    success: false,
                    data: json!({}),
                    error: Some(code.into()),
                });
            }
        };
        Ok(NativeBrowserResponse {
            id: "browser-pdf".into(),
            success: true,
            data: json!({"artifact_payload":{"page":page,"mime_type":"application/pdf","base64":STANDARD.encode(bytes)}}),
            error: None,
        })
    }
}

async fn read_pdf(
    cdp: &mut BrowserCdp,
    session: &str,
    handle: &str,
) -> Result<Vec<u8>, &'static str> {
    let bytes = super::stream::read(cdp, session, handle)
        .await
        .map_err(|error| match error {
            super::stream::StreamError::Transport("browser_cdp_stream_read_failed") => {
                "browser_cdp_request_rejected"
            }
            super::stream::StreamError::Transport(code) => code,
            super::stream::StreamError::Invalid => "browser_pdf_stream_invalid",
            super::stream::StreamError::Limit => "browser_pdf_byte_limit",
            super::stream::StreamError::Stalled => "browser_pdf_stream_stalled",
        })?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("browser_pdf_invalid");
    }
    Ok(bytes)
}
