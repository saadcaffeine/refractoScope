/**
 * detector.js
 * Pure-JS (Canvas ImageData) interface-line detector for optical
 * refractometer scales. No external CV library needed, which keeps
 * the PWA lightweight and fully cacheable for offline use.
 *
 * Algorithm (validated against reference photos):
 *  1. Caller supplies a detection window (rectangle in fractional
 *     0-1 coordinates over the video frame). The calibration step
 *     tightly bounds the tick-mark column, then pads it with a buffer
 *     (esp. below the "0" tick, into the label area) so a reading
 *     right at the low end of the scale still has enough contrasting
 *     bright rows on both sides of the transition to detect reliably.
 *  2. Sample a central vertical strip within the window (avoids the
 *     printed numbers that sit at its left/right edges).
 *  3. Compute per-row mean luminance -> smooth with an edge-safe
 *     moving average (avoids false gradient spikes at the window's
 *     top/bottom boundary) -> take the row of maximum |gradient|.
 *     That row is the blue/bright interface line, whether the
 *     transition is a sharp edge or a soft gradient.
 *  4. Map that row linearly to a Salinity% (0-100 scale) using the
 *     calibration's two known tick values and their *original*
 *     (unbuffered) positions, so a transition found within the buffer
 *     zone correctly extrapolates to a value near (or slightly past)
 *     the low end rather than being clipped at it.
 *
 * A second, independent pass (detectHorizontalBounds) finds the
 * left/right edges of the illuminated scope body against the dark
 * surrounding vignette, using the same profile/threshold technique
 * transposed to columns. This lets the app re-center the detection
 * window horizontally each frame, tolerating minor hand vibration/
 * drift without needing the user to hold perfectly still.
 *
 * Exposes a single global: window.Detector
 */
(function () {
  "use strict";

  function luminance(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** Edge-replicated box-filter smoothing shared by both detection passes. */
  function smoothProfile(profile) {
    const n = profile.length;
    const k = Math.max(3, Math.round(n / 25) | 1);
    const half = Math.floor(k / 2);
    const smooth = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let j = -half; j <= half; j++) {
        let idx = i + j;
        if (idx < 0) idx = 0;
        if (idx >= n) idx = n - 1;
        sum += profile[idx];
      }
      smooth[i] = sum / (half * 2 + 1);
    }
    return smooth;
  }

  function profileRange(profile) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < profile.length; i++) {
      if (profile[i] < lo) lo = profile[i];
      if (profile[i] > hi) hi = profile[i];
    }
    return { lo, hi, contrast: hi - lo };
  }

  /**
   * @param {ImageData} imageData - full frame pixel data
   * @param {number} frameW
   * @param {number} frameH
   * @param {{x0:number,y0:number,x1:number,y1:number}} roiFrac - fractional detection window (0-1)
   * @param {number} stripWidthFrac - fraction of window width to sample (centered), default 0.4
   * @returns {{ok:boolean, rowFrac:number, frameRowFrac:number, contrast:number, sharpness:number, boxPixels:object}}
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

    const smooth = smoothProfile(rowProfile);

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

    const { contrast } = profileRange(smooth);
    const sharpness = avgAbsGrad > 0.0001 ? peakAbs / (avgAbsGrad + 1) : 0;
    const rowFrac = (peakIdx + 0.5) / boxH; // relative to THIS (possibly buffered) window
    const frameRowFrac = (y0 + peakIdx + 0.5) / frameH; // absolute, relative to the full frame

    return {
      ok: true,
      rowFrac,
      frameRowFrac,
      contrast,
      sharpness,
      peakGrad: peakAbs,
      boxPixels: { x0: stripX0, x1: stripX1, y0, y1 },
    };
  }

  /**
   * Finds the left/right edges of the illuminated scope body within a
   * horizontal band (given as pixel rows), by looking for where mean
   * column brightness crosses from the dark surrounding vignette into
   * the bright interior. Mirrors analyzeFrame's row-profile technique,
   * transposed to columns.
   *
   * @returns {{ok:boolean, leftFrac:number, rightFrac:number, contrast:number}}
   */
  function detectHorizontalBounds(imageData, frameW, frameH, y0px, y1px) {
    const y0 = Math.max(0, Math.round(y0px));
    const y1 = Math.min(frameH, Math.round(y1px));
    if (y1 - y0 < 4 || frameW < 8) return { ok: false, reason: "band-too-small" };

    const data = imageData.data;
    const colProfile = new Float32Array(frameW);
    for (let x = 0; x < frameW; x++) {
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        const idx = (y * frameW + x) * 4;
        sum += luminance(data[idx], data[idx + 1], data[idx + 2]);
      }
      colProfile[x] = sum / (y1 - y0);
    }

    const smooth = smoothProfile(colProfile);
    const { lo, hi, contrast } = profileRange(smooth);

    const MIN_CONTRAST = 55; // dark vignette vs. bright scope interior is normally a very strong edge
    if (contrast < MIN_CONTRAST) return { ok: false, reason: "low-contrast", contrast };

    const mid = (lo + hi) / 2;
    let leftIdx = -1;
    for (let x = 0; x < frameW; x++) {
      if (smooth[x] >= mid) { leftIdx = x; break; }
    }
    let rightIdx = -1;
    for (let x = frameW - 1; x >= 0; x--) {
      if (smooth[x] >= mid) { rightIdx = x; break; }
    }
    if (leftIdx < 0 || rightIdx < 0 || rightIdx <= leftIdx) {
      return { ok: false, reason: "no-edges", contrast };
    }

    return {
      ok: true,
      leftFrac: leftIdx / frameW,
      rightFrac: rightIdx / frameW,
      contrast,
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
    detectHorizontalBounds,
    rowFracToValue,
    createSmoother,
  };
})();
