/**
 * autodetect.js
 * "Auto-detect" calibration helper - runs only when the user taps the
 * button on the Calibrate screen, never per-frame. Two stages:
 *
 *  1. Geometric (Detector.detectScopeBody): finds the illuminated
 *     scope body's rough bounding box against the dark vignette, with
 *     no prior calibration needed. Cheap, always runs first.
 *  2. OCR (Tesseract.js, vendored locally - no CDN dependency so this
 *     still works offline after first use): crops to that rough box,
 *     reads the printed tick numerals and their pixel positions, then
 *     uses the numerals' own content - not a hardcoded left/right
 *     assumption - to figure out which printed column is the 0-100
 *     Salinity scale (vs. a density/SG-style column some refractometers
 *     print alongside it), and fits a robust (outlier-rejecting) line
 *     through the detected ticks to read the exact row for value=0 and
 *     value=100.
 *
 * This whole flow was prototyped and validated against a real
 * refractometer photo before being ported here (see conversation/dev
 * notes): geometric-only edge detection got the scope's outer bounds
 * right but landed noticeably off the true 0/100 ticks (there's a
 * printed label margin between the scope's optical edge and the real
 * ticks); adding OCR closed that gap to a near-exact match, provided
 * the fit is robust to occasional bad OCR tokens (raw/unfiltered OCR
 * was ~35% off on one bad reading; the outlier-rejecting fit reduced
 * that to <1%).
 *
 * Exposes a single global: window.AutoDetect
 */
(function () {
  "use strict";

  const VENDOR_BASE = "js/vendor/tesseract";
  let workerPromise = null;

  /** Lazily creates (and caches) a single Tesseract.js worker, pointed
   *  entirely at our vendored files - never a CDN - so this keeps
   *  working offline once the vendor files are cached by the service
   *  worker (which happens automatically on first use, same as any
   *  other same-origin asset - see service-worker.js). */
  function getWorker(onProgress) {
    if (workerPromise) return workerPromise;
    if (!window.Tesseract) return Promise.reject(new Error("Tesseract.js failed to load"));
    workerPromise = window.Tesseract.createWorker("eng", 1, {
      workerPath: `${VENDOR_BASE}/worker.min.js`,
      corePath: `${VENDOR_BASE}/core`,
      langPath: `${VENDOR_BASE}/lang`,
      gzip: true,
      // Tesseract.js defaults to fetching the worker script and
      // wrapping it in a Blob URL. Blob-sourced workers have historic
      // service-worker interception quirks on some mobile browsers
      // (the offline cache below may not apply to their sub-requests).
      // Loading the worker as a plain same-origin script instead keeps
      // its network requests reliably covered by our cache-first
      // fetch handler, matching this app's offline-first design.
      workerBlobURL: false,
      logger: onProgress || (() => {}),
    }).catch((err) => {
      workerPromise = null; // allow retry on a later tap
      throw err;
    });
    return workerPromise;
  }

  /** Cover-fit crop matching the same math used elsewhere in the app
   *  (getCoverSourceRect in app.js) so fractional coordinates stay
   *  portable between the live video, the analysis canvas, and here. */
  function getCoverSourceRect(video, containerAspect, zoom) {
    zoom = zoom || 1;
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const videoAspect = vw / vh;
    let sx, sy, sw, sh;
    if (videoAspect > containerAspect) {
      sh = vh; sw = vh * containerAspect; sx = (vw - sw) / 2; sy = 0;
    } else {
      sw = vw; sh = vw / containerAspect; sx = 0; sy = (vh - sh) / 2;
    }
    if (zoom > 1) {
      const zsw = sw / zoom, zsh = sh / zoom;
      sx += (sw - zsw) / 2; sy += (sh - zsh) / 2; sw = zsw; sh = zsh;
    }
    return { sx, sy, sw, sh };
  }

  /**
   * 1-D k-means (k=2) clustering of OCR tokens by x-position, to
   * separate the two printed numeral columns these refractometers
   * typically have (e.g. density on one side, Salinity on the other).
   */
  function clusterByX(tokens) {
    if (tokens.length < 2) return { left: tokens, right: [] };
    let c0 = Math.min(...tokens.map((t) => t.cx));
    let c1 = Math.max(...tokens.map((t) => t.cx));
    let left = [], right = [];
    for (let iter = 0; iter < 10; iter++) {
      left = tokens.filter((t) => Math.abs(t.cx - c0) <= Math.abs(t.cx - c1));
      right = tokens.filter((t) => Math.abs(t.cx - c0) > Math.abs(t.cx - c1));
      if (left.length) c0 = left.reduce((s, t) => s + t.cx, 0) / left.length;
      if (right.length) c1 = right.reduce((s, t) => s + t.cx, 0) / right.length;
    }
    return { left, right, leftCentroid: c0, rightCentroid: c1 };
  }

  /**
   * Robust (outlier-rejecting) linear fit of value vs. y-position:
   * fits a line, drops the single worst-residual point if it's off by
   * more than `tolerance`, refits, repeats. A simple RANSAC-style pass
   * so one bad OCR token can't drag the whole calibration off - this
   * mattered in testing: a single stray misread token pulled a naive
   * fit ~35% off; this brought it back under 1%.
   */
  function robustFit(points, tolerance) {
    tolerance = tolerance != null ? tolerance : 8;
    let pts = points.slice();
    const dropped = [];

    function fitLine(p) {
      const n = p.length;
      const sumY = p.reduce((s, t) => s + t.cy, 0);
      const sumN = p.reduce((s, t) => s + t.num, 0);
      const sumYY = p.reduce((s, t) => s + t.cy * t.cy, 0);
      const sumYN = p.reduce((s, t) => s + t.cy * t.num, 0);
      const denom = n * sumYY - sumY * sumY;
      if (Math.abs(denom) < 1e-9) return null;
      const m = (n * sumYN - sumY * sumN) / denom;
      const b = (sumN - m * sumY) / n;
      return { m, b };
    }

    while (pts.length > 2) {
      const fit = fitLine(pts);
      if (!fit) break;
      const withResiduals = pts.map((p) => ({ ...p, residual: Math.abs(p.num - (fit.m * p.cy + fit.b)) }));
      const worst = withResiduals.reduce((a, c) => (c.residual > a.residual ? c : a));
      if (worst.residual <= tolerance) break;
      dropped.push(worst);
      pts = pts.filter((p) => p !== pts.find((q) => q.num === worst.num && q.cy === worst.cy));
    }

    const fit = fitLine(pts);
    if (!fit) return null;
    const residuals = pts.map((p) => Math.abs(p.num - (fit.m * p.cy + fit.b)));
    return { m: fit.m, b: fit.b, points: pts, dropped, maxResidual: Math.max(...residuals) };
  }

  /**
   * Parses raw Tesseract word-level TSV/data rows into clean numeric
   * tokens, identifies which x-cluster is the Salinity (0-100) column
   * (the one containing an exact "100" - a density/SG column will
   * never produce that, it tops out at a decimal like "1.070"), and
   * fits value=cy through the robust regression.
   *
   * @param {Array<{text:string, conf:number, cx:number, cy:number}>} words - in full-resolution *crop* pixel coords
   * @returns {{ok:boolean, reason?:string, y0?:number, y100?:number, colCentroid?:number, maxResidual?:number}}
   */
  function fitSalinityColumn(words) {
    const numeric = words
      .filter((t) => /^\d+(\.\d+)?$/.test(t.text))
      .map((t) => ({ ...t, num: parseFloat(t.text), hasDecimal: t.text.indexOf(".") !== -1 }));

    if (numeric.length < 3) return { ok: false, reason: "too-few-numeric-tokens" };

    const { left, right, leftCentroid, rightCentroid } = clusterByX(numeric);
    const hasExact100 = (cluster) => cluster.some((t) => !t.hasDecimal && t.num === 100);
    const cluster = hasExact100(right) ? right : hasExact100(left) ? left : null;
    const centroid = cluster === right ? rightCentroid : leftCentroid;
    if (!cluster) return { ok: false, reason: "no-salinity-column-found" };

    const candidates = cluster
      .filter((t) => !t.hasDecimal && t.num >= 0 && t.num <= 100 && t.num % 20 === 0)
      .map((t) => ({ num: t.num, cy: t.cy }));
    if (candidates.length < 3) return { ok: false, reason: "too-few-tick-candidates" };

    const fit = robustFit(candidates, 8);
    if (!fit || fit.points.length < 3) return { ok: false, reason: "fit-failed" };

    const y100 = (100 - fit.b) / fit.m;
    const y0 = (0 - fit.b) / fit.m;

    return {
      ok: true,
      y0, y100,
      colCentroid: centroid,
      pointsUsed: fit.points.length,
      pointsDropped: fit.dropped.length,
      maxResidual: fit.maxResidual,
    };
  }

  /**
   * Full pipeline: given a source <video> (or any CanvasImageSource
   * with matching width/height) and its container aspect + zoom
   * (matching whatever's currently live), returns a proposed
   * calibration box + values, or a failure reason. Never throws for
   * expected failure modes (low contrast, no scale found, OCR
   * inconclusive) - always resolves with { ok, reason }.
   */
  async function run(video, containerAspect, zoom, onProgress) {
    if (!video || !video.videoWidth) return { ok: false, reason: "no-video" };

    // Stage 1: geometric, on a downsampled analysis frame (fast).
    const AW = 500;
    const AH = Math.round(AW / containerAspect);
    const analysisCanvas = document.createElement("canvas");
    analysisCanvas.width = AW;
    analysisCanvas.height = AH;
    const actx = analysisCanvas.getContext("2d", { willReadFrequently: true });
    const src = getCoverSourceRect(video, containerAspect, zoom);
    actx.drawImage(video, src.sx, src.sy, src.sw, src.sh, 0, 0, AW, AH);
    let imageData;
    try {
      imageData = actx.getImageData(0, 0, AW, AH);
    } catch (e) {
      return { ok: false, reason: "capture-failed" };
    }

    const geoBox = window.Detector.detectScopeBody(imageData, AW, AH);
    if (!geoBox.ok) return { ok: false, reason: geoBox.reason || "scope-not-found" };

    // Stage 2: OCR on a padded, upscaled crop of the *full-res* source
    // (not the 500px analysis frame - OCR needs real resolution).
    if (onProgress) onProgress({ status: "reading scale", progress: 0 });
    let worker;
    try {
      worker = await getWorker(onProgress);
    } catch (e) {
      return { ok: false, reason: "ocr-unavailable" };
    }

    const padX = 0.03, padY = 0.03;
    const fullW = src.sw, fullH = src.sh; // full-res crop source dimensions
    const cropX0 = Math.max(0, (geoBox.x0 - padX) * fullW);
    const cropX1 = Math.min(fullW, (geoBox.x1 + padX) * fullW);
    const cropY0 = Math.max(0, (geoBox.y0 - padY) * fullH);
    const cropY1 = Math.min(fullH, (geoBox.y1 + padY) * fullH);
    const cropW = cropX1 - cropX0, cropH = cropY1 - cropY0;
    if (cropW < 20 || cropH < 20) return { ok: false, reason: "crop-too-small" };

    const upscale = Math.min(3, Math.max(1, 1200 / cropW));
    const ocrCanvas = document.createElement("canvas");
    ocrCanvas.width = Math.round(cropW * upscale);
    ocrCanvas.height = Math.round(cropH * upscale);
    const octx = ocrCanvas.getContext("2d");
    octx.drawImage(
      video,
      src.sx + cropX0, src.sy + cropY0, cropW, cropH,
      0, 0, ocrCanvas.width, ocrCanvas.height
    );

    let ocrResult;
    try {
      ocrResult = await worker.recognize(ocrCanvas);
    } catch (e) {
      return { ok: false, reason: "ocr-failed" };
    }

    const words = (ocrResult.data.words || [])
      .filter((w) => w.text && w.text.trim())
      .map((w) => ({
        text: w.text.trim(),
        conf: w.confidence,
        // map back from the upscaled OCR canvas into the ORIGINAL
        // full-frame fractional coordinate space.
        cx: src.sx + cropX0 + (w.bbox.x0 + w.bbox.x1) / 2 / upscale,
        cy: src.sy + cropY0 + (w.bbox.y0 + w.bbox.y1) / 2 / upscale,
      }));

    const fit = fitSalinityColumn(words);
    if (!fit.ok) return { ok: false, reason: fit.reason, geoBox };

    // Convert the OCR-derived y0/y100 (currently in full-frame *source
    // pixel* coords) into the same fractional (0-1, cover-fit) space
    // the rest of the app uses.
    const y0Frac = (fit.y0 - src.sy) / src.sh;
    const y100Frac = (fit.y100 - src.sy) / src.sh;
    const colCentroidFrac = (fit.colCentroid - src.sx) / src.sw;

    // x-bounds: we only have precise column *numeral* positions from
    // OCR, not the tick-mark bar itself (thin lines have no text to
    // read). Approximate the tick strip as sitting just inside the
    // numeral column, sized relative to the scope's own width (not a
    // fixed frame fraction, so this scales correctly across different
    // zoom/framing) - tuned empirically against a real reference photo
    // to land tightly on the correct tick bar without spilling into
    // the neighboring column's ticks. The user can still narrow this
    // with the drag handles same as manual calibration; this is a
    // starting point, not a final answer.
    const scopeSpan = geoBox.x1 - geoBox.x0;
    const scopeCenterFrac = (geoBox.x0 + geoBox.x1) / 2;
    const towardCenter = colCentroidFrac > scopeCenterFrac ? -1 : 1;
    const innerGap = 0.035 * scopeSpan; // gap from numerals to the tick bar's outer edge
    const tickBarWidth = 0.14 * scopeSpan; // the tick bar's own width
    const x1Frac = colCentroidFrac + towardCenter * innerGap;
    const x0Frac = x1Frac + towardCenter * tickBarWidth;
    const boxX0 = Math.max(geoBox.x0 + 0.005, Math.min(x0Frac, x1Frac));
    const boxX1 = Math.min(geoBox.x1 - 0.005, Math.max(x0Frac, x1Frac));

    const boxY0 = Math.min(y100Frac, y0Frac);
    const boxY1 = Math.max(y100Frac, y0Frac);

    if (onProgress) onProgress({ status: "done", progress: 1 });

    return {
      ok: true,
      box: { x0: boxX0, y0: boxY0, x1: boxX1, y1: boxY1 },
      values: { top: 100, bottom: 0 },
      confidence: { pointsUsed: fit.pointsUsed, pointsDropped: fit.pointsDropped, maxResidual: fit.maxResidual },
    };
  }

  async function terminate() {
    if (workerPromise) {
      try {
        const w = await workerPromise;
        await w.terminate();
      } catch (e) { /* ignore */ }
      workerPromise = null;
    }
  }

  window.AutoDetect = {
    run,
    terminate,
    // exposed for testing
    _clusterByX: clusterByX,
    _robustFit: robustFit,
    _fitSalinityColumn: fitSalinityColumn,
  };
})();
