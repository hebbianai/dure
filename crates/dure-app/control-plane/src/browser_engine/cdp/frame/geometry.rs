use super::*;

impl BrowserCdp {
    /// Map a hit-tested point inside the selected document to the page's input
    /// surface. Native quads already include all same-process ancestor transforms;
    /// each out-of-process boundary contributes its embedding content quad.
    pub(in crate::browser_engine) async fn page_point(
        &mut self,
        point: Value,
    ) -> Result<Value, &'static str> {
        let Some(scope) = self.frame.clone() else {
            return Ok(point);
        };
        let mut point = [number(&point["x"])?, number(&point["y"])?];
        let boundary = self
            .project_to_page(std::slice::from_mut(&mut point), 0)
            .await?;
        let root = scope
            .ancestry
            .last()
            .ok_or("browser_frame_ancestry_missing")?;
        let hit = self
            .request(
                "DOM.getNodeForLocation",
                json!({"x":point[0].floor() as i64,"y":point[1].floor() as i64}),
                Some(&root.session),
            )
            .await?;
        // A remote renderer is hit-tested as its iframe element by the parent
        // DOM agent. Same-process frames expose their leaf frame directly.
        if hit["frameId"] != scope.frame.frame_id.as_str()
            && !(hit["backendNodeId"] == boundary.0 && hit["frameId"] == boundary.1.as_str())
        {
            return Err("browser_frame_covered");
        }
        Ok(json!({"x":point[0],"y":point[1]}))
    }

    /// DOM box quads already include same-process ancestors. Only cross-process
    /// renderer boundaries remain before they reach the root capture surface.
    pub(in crate::browser_engine) async fn page_quad(
        &mut self,
        points: &mut [[f64; 2]],
    ) -> Result<(), &'static str> {
        let Some(scope) = &self.frame else {
            return Ok(());
        };
        let renderer = &scope
            .ancestry
            .first()
            .ok_or("browser_frame_ancestry_missing")?
            .engine_target;
        let index = scope
            .ancestry
            .iter()
            .position(|node| node.frame.frame_id.as_str() == renderer)
            .ok_or("browser_frame_ancestry_missing")?;
        if index + 1 < scope.ancestry.len() {
            self.project_to_page(points, index).await?;
        }
        Ok(())
    }

    async fn project_to_page(
        &mut self,
        points: &mut [[f64; 2]],
        mut child_index: usize,
    ) -> Result<(i64, String), &'static str> {
        let scope = self.frame.clone().ok_or("browser_frame_ancestry_missing")?;
        loop {
            let child = scope
                .ancestry
                .get(child_index)
                .ok_or("browser_frame_ancestry_missing")?;
            let parent = scope
                .ancestry
                .get(child_index + 1)
                .ok_or("browser_frame_ancestry_missing")?;
            if child.lifetime.has_changed().is_err() || parent.lifetime.has_changed().is_err() {
                return Err("browser_frame_context_changed");
            }
            let context = self
                .request(
                    "Page.createIsolatedWorld",
                    json!({"frameId":child.frame.frame_id,"worldName":"dure-browser-observer"}),
                    Some(&child.session),
                )
                .await?;
            let viewport = self.request("Runtime.evaluate", json!({"expression":"({width:innerWidth,height:innerHeight})","contextId":context["executionContextId"],"returnByValue":true}), Some(&child.session)).await?;
            let width = number(&viewport["result"]["value"]["width"])?;
            let height = number(&viewport["result"]["value"]["height"])?;
            if width <= 0.0 || height <= 0.0 {
                return Err("browser_frame_not_reachable");
            }
            let owner = self
                .request(
                    "DOM.getFrameOwner",
                    json!({"frameId":child.frame.frame_id}),
                    Some(&parent.session),
                )
                .await?;
            let backend = owner["backendNodeId"]
                .as_i64()
                .filter(|id| *id > 0)
                .ok_or("browser_frame_owner_missing")?;
            let model = self
                .request(
                    "DOM.getBoxModel",
                    json!({"backendNodeId":backend}),
                    Some(&parent.session),
                )
                .await?;
            for point in points.iter_mut() {
                *point = project(
                    &model["model"]["content"],
                    point[0] / width,
                    point[1] / height,
                )?;
            }
            if parent.engine_target == scope.target {
                return Ok((backend, parent.frame.frame_id.as_str().to_owned()));
            }
            child_index = scope
                .ancestry
                .iter()
                .enumerate()
                .skip(child_index + 1)
                .find(|(_, ancestor)| ancestor.frame.frame_id.as_str() == parent.engine_target)
                .map(|(index, _)| index)
                .ok_or("browser_frame_ancestry_missing")?;
        }
    }
}

fn number(value: &Value) -> Result<f64, &'static str> {
    value
        .as_f64()
        .filter(|number| number.is_finite())
        .ok_or("browser_frame_geometry_invalid")
}

// Project a point in the unit viewport into its CSS content quadrilateral.
// This retains rotation, scale and perspective instead of adding a guessed offset.
fn project(quad: &Value, u: f64, v: f64) -> Result<[f64; 2], &'static str> {
    let values = quad
        .as_array()
        .filter(|values| values.len() == 8)
        .ok_or("browser_frame_geometry_invalid")?;
    let q = values.iter().map(number).collect::<Result<Vec<_>, _>>()?;
    let dx1 = q[2] - q[4];
    let dx2 = q[6] - q[4];
    let dx3 = q[0] - q[2] + q[4] - q[6];
    let dy1 = q[3] - q[5];
    let dy2 = q[7] - q[5];
    let dy3 = q[1] - q[3] + q[5] - q[7];
    let (g, h) = if dx3.abs() < 1e-9 && dy3.abs() < 1e-9 {
        (0.0, 0.0)
    } else {
        let determinant = dx1 * dy2 - dx2 * dy1;
        if determinant.abs() < 1e-9 {
            return Err("browser_frame_geometry_invalid");
        }
        (
            (dx3 * dy2 - dx2 * dy3) / determinant,
            (dx1 * dy3 - dx3 * dy1) / determinant,
        )
    };
    let denominator = g * u + h * v + 1.0;
    let x = ((q[2] - q[0] + g * q[2]) * u + (q[6] - q[0] + h * q[6]) * v + q[0]) / denominator;
    let y = ((q[3] - q[1] + g * q[3]) * u + (q[7] - q[1] + h * q[7]) * v + q[1]) / denominator;
    if !x.is_finite() || !y.is_finite() || x.abs() > 1_000_000.0 || y.abs() > 1_000_000.0 {
        return Err("browser_frame_geometry_invalid");
    }
    Ok([x, y])
}
