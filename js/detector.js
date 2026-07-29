/**
 * detector.js
 * Pure-JS (Canvas ImageData) interface-line detector for optical
 * refractometer scales. No external CV library needed, which keeps
 * the PWA lightweight and fully cacheable for offline use.
 *
 * Algorithm (validated against reference photos):
 *  1. Caller supplies a calibrated ROI (rectangle in fractional
 *     0-1 coordinates over the video frame) that tightly bounds just
 *     the tick-mark column of the scale (excludes rounded dome edges,
 *     printed labels - those are handled by the calibration step, not
 *     by this module).
 *  2. Sample a central vertical strip within the ROI (avoids the
 *     printed numbers that sit at the ROI's left/right edges).
 *  3. Compute per-row mean luminance -> smooth with an edge-safe
 *     moving average (avoids false gradient spikes at the ROI top/
 *     bottom boundary) -> take the row of maximum |gradient|. That
 *     row is the blue/bright interface line, whether the transition
 *     is a sharp edge or a soft gradient.
 *  4. Map that row linearly to a Brix% using the calibration's two
 *     known tick values.
 *
 * Exposes a single global: window.Detector
 */
(function () {
  "use strict";

  function luminance(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * @param {ImageData} imageData - full frame pixel data
   * @param {number} frameW
   * @param {number} frameH
   * @param {{x0:number,y0:number,x1:number,y1:number}} roiFrac - fractional ROI (0-1)
   * @param {number} stripWidthFrac - fraction of ROI width to sample (centered), default 0.4
   * @returns {{ok:boolean, rowFrac:number, contrast:number, sharpness:number, boxPixels:object}}
   */
  function analyzeFrame(imageData, frameW, frameH, roiFrac, stripWidthFrac) {
    stripWidthFrac = stripWidthFrac || 0.4;

    const x0 = Math.round(roiFrac.x0 * frameW);
    const x1 = Math.round(roiFrac.x1 * frameW);
    const y0 = Math.round(roiFrac.y0 * frameH);
    const y1 = Math.round(roiFrac.y1 * frameH);

    const boxW = Math.max(1, x1 - x0);
    const boxH = Math.max(1, y1 - y0);

    if (boxH < 8 || boxW < 4) {
      return { ok: false, reason: "roi-too-small" };
    }

    const stripW = Math.max(2, Math.round(boxW * stripWidthFrac));
    const stripX0 = Math.max(0, Math.round(x0 + (boxW - stripW) / 2));
    const stripX1 = Math.min(frameW, stripX0 + stripW);

    const data = imageData.data; // RGBA
    const rowProfile = new Float32Array(boxH);

    for (let ry = 0; ry < boxH; ry++) {
      const y = y0 + ry;
      if (y < 0 || y >= frameH) continue;
      let sum = 0;
      let count = 0;
      const rowOffset = y * frameW * 4;
      for (let x = stripX0; x < stripX1; x++) {
        const idx = rowOffset + x * 4;
        sum += luminance(data[idx], data[idx + 1], data[idx + 2]);
        count++;
      }
      rowProfile[ry] = count > 0 ? sum / count : 0;
    }

    // Edge-safe moving average smoothing
    const k = Math.max(3, Math.round(boxH / 25) | 1);
    const half = Math.floor(k / 2);
    const smooth = new Float32Array(boxH);
    // prefix sums for O(n) box filter with edge replication
    for (let i = 0; i < boxH; i++) {
      let sum = 0;
      for (let j = -half; j <= half; j++) {
        let idx = i + j;
        if (idx < 0) idx = 0;
        if (idx >= boxH) idx = boxH - 1;
        sum += rowProfile[idx];
      }
      smooth[i] = sum / (half * 2 + 1);
    }

    // Gradient (central difference, edge-clamped)
    const grad = new Float32Array(boxH);
    for (let i = 0; i < boxH; i++) {
      const prev = smooth[Math.max(0, i - 1)];
      const next = smooth[Math.min(boxH - 1, i + 1)];
      grad[i] = (next - prev) / 2;
    }

    let peakIdx = 0;
    let peakAbs = -Infinity;
    let sumAbsGrad = 0;
    for (let i = 0; i < boxH; i++) {
      const a = Math.abs(grad[i]);
      sumAbsGrad += a;
      if (a > peakAbs) {
        peakAbs = a;
        peakIdx = i;
      }
    }
    const avgAbsGrad = sumAbsGrad / boxH;

    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < boxH; i++) {
      if (smooth[i] < lo) lo = smooth[i];
      if (smooth[i] > hi) hi = smooth[i];
    }
    const contrast = hi - lo; // 0-255 scale

    const sharpness = avgAbsGrad > 0.0001 ? peakAbs / (avgAbsGrad + 1) : 0;
    const rowFrac = (peakIdx + 0.5) / boxH;

    return {
      ok: true,
      rowFrac,
      contrast,
      sharpness,
      peakGrad: peakAbs,
      boxPixels: { x0: stripX0, x1: stripX1, y0, y1 },
    };
  }

  /**
   * Maps a rowFrac (0 = top of ROI, 1 = bottom of ROI) to a calibrated
   * value, given the two calibration values at top and bottom handles.
   */
  function rowFracToValue(rowFrac, topValue, bottomValue) {
    return topValue + (bottomValue - topValue) * rowFrac;
  }

  /**
   * Estimate specific gravity (wort) from Brix using the standard
   * brewing approximation (matches the "SG wort" column printed on
   * these dual-scale refractometers at 20C reference).
   */
  function brixToSG(brix) {
    if (!isFinite(brix)) return NaN;
    return 1 + brix / (258.6 - (brix / 258.2) * 227.1);
  }

  /**
   * Temporal smoother: fast-snaps to large changes (new sample placed
   * under the scope), slow-smooths small jitter (stable reading).
   */
  function createSmoother(opts) {
    opts = opts || {};
    const alpha = opts.alpha != null ? opts.alpha : 0.25;
    const jumpThreshold = opts.jumpThreshold != null ? opts.jumpThreshold : 3.0;
    let value = null;
    let confidence = 0;

    return {
      reset() { value = null; confidence = 0; },
      push(newValue, newConfidence) {
        if (value === null || Math.abs(newValue - value) > jumpThreshold) {
          value = newValue;
        } else {
          value = value + alpha * (newValue - value);
        }
        confidence = confidence + 0.35 * (newConfidence - confidence);
        return { value, confidence };
      },
      get() { return { value, confidence }; },
    };
  }

  window.Detector = {
    analyzeFrame,
    rowFracToValue,
    brixToSG,
    createSmoother,
  };
})();
