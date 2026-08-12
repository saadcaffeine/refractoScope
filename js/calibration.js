/**
 * calibration.js
 * Interactive ROI calibration: the user drags a box's edges onto two
 * known tick marks on the physical scale, tightening it around just
 * the tick column. Stored as fractional coordinates (0-1) so it stays
 * valid across different camera resolutions/orientations, persisted
 * to localStorage for offline reuse across sessions.
 *
 * Three derived pieces of state extend the raw dragged box:
 *  - getBufferedY(): pads the box vertically (mostly downward, into
 *    the label area below the "0" tick) so the detector always has
 *    contrasting bright rows on both sides of the transition, even
 *    when the true reading sits right at the low end of the scale.
 *    This is a coarse safety margin only, sized to *not* reach the
 *    scope's own curved physical edge below the label - see
 *    zeroRowFrac for the precise version.
 *  - zeroRowFrac: an independently-set, precisely measured "true
 *    zero" row position, captured via the live Tare button (dunk a
 *    known 0% sample - e.g. distilled water - and tap Tare). This
 *    decouples "exactly where is 0" (a physical measurement) from
 *    "roughly where did I drag the box" (a by-eye span/window
 *    calibration) - the box still defines search area and the top
 *    reference tick, but value mapping anchors to zeroRowFrac
 *    whenever it's set, falling back to the dragged box.y1 otherwise.
 *  - dynamicX: relative-to-scope-width x-bounds captured at save
 *    time (see app.js), letting the live detection window re-center
 *    horizontally each frame against the scope's own left/right dark
 *    edges rather than a fixed frame position - tolerating minor
 *    hand vibration/drift without needing the user to hold still.
 *
 * Exposes a single global: window.CalibrationCtl
 */
(function () {
  "use strict";

  // Bumped to v2 when the scale changed from Brix% to Salinity% (0-100)
  // so a stale Brix-era calibration doesn't silently get reinterpreted
  // as a Salinity reading - anyone upgrading starts fresh.
  const STORAGE_KEY = "refractoscope.calibration.v2";

  const DEFAULT_BOX = { x0: 0.40, y0: 0.22, x1: 0.60, y1: 0.80 };
  const DEFAULT_VALUES = { top: 100, bottom: 0 };

  // Vertical padding applied to the *sampling* window only, as a
  // fraction of the calibrated box's own height. Larger below than
  // above: the region under the "0" tick runs into printed labels
  // fairly soon, while there's normally plenty of dark scale above
  // the top tick already. Kept modest so it doesn't reach far enough
  // to catch the scope's own curved physical edge - a precise Tare
  // (see zeroRowFrac) is the recommended way to get right up to a
  // true low reading without relying on this margin at all.
  const BUFFER_TOP_FRAC = 0.05;
  const BUFFER_BOTTOM_FRAC = 0.12;
  // Once tared, only a small margin past the exact measured zero is
  // needed - we're no longer compensating for by-eye drag imprecision.
  const TARE_MARGIN_FRAC = 0.05;

  const CalibrationCtl = {
    box: Object.assign({}, DEFAULT_BOX),
    values: Object.assign({}, DEFAULT_VALUES),
    dynamicX: null, // { relX0, relX1 } relative-to-scope-width x-bounds, or null
    zeroRowFrac: null, // Tare-captured absolute frame-row-fraction for value=bottom, or null
    canvas: null,
    ctx: null,
    activeHandle: null,
    onChange: null,

    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.box && parsed.values) {
            this.box = parsed.box;
            this.values = parsed.values;
            this.dynamicX = parsed.dynamicX || null;
            this.zeroRowFrac = typeof parsed.zeroRowFrac === "number" ? parsed.zeroRowFrac : null;
            return true;
          }
        }
      } catch (e) { /* ignore corrupt storage */ }
      return false;
    },

    save() {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ box: this.box, values: this.values, dynamicX: this.dynamicX, zeroRowFrac: this.zeroRowFrac })
        );
      } catch (e) { /* storage may be unavailable (private mode) - non-fatal */ }
    },

    reset() {
      this.box = Object.assign({}, DEFAULT_BOX);
      this.values = Object.assign({}, DEFAULT_VALUES);
      this.dynamicX = null;
      this.zeroRowFrac = null;
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    },

    isCalibrated() {
      try {
        return localStorage.getItem(STORAGE_KEY) !== null;
      } catch (e) { return false; }
    },

    isTared() {
      return this.zeroRowFrac != null;
    },

    /** Effective absolute frame-row-fraction anchor for value=bottom (usually 0). */
    getZeroAnchor() {
      return this.zeroRowFrac != null ? this.zeroRowFrac : this.box.y1;
    },

    /** The actual detection sampling window: the box, padded vertically. */
    getBufferedY() {
      const span = Math.max(0.001, this.box.y1 - this.box.y0);
      const y0 = Math.max(0, this.box.y0 - span * BUFFER_TOP_FRAC);
      let y1;
      if (this.zeroRowFrac != null) {
        // Trust the precise Tare measurement: cover it plus a small
        // margin, whichever extends further than the dragged box.
        y1 = Math.max(this.box.y1, this.zeroRowFrac) + span * TARE_MARGIN_FRAC;
      } else {
        y1 = this.box.y1 + span * BUFFER_BOTTOM_FRAC;
      }
      return { y0, y1: Math.min(1, y1) };
    },

    /**
     * Wires up pointer-drag handles on the given canvas overlay for
     * interactive calibration. Draws the box + handles each frame via
     * the caller's render loop (call `render()` yourself), this just
     * manages hit-testing and dragging state.
     */
    attach(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");

      const handleRadius = 22; // touch target in CSS px

      const getHandles = () => {
        const rect = canvas.getBoundingClientRect();
        const b = this.box;
        return {
          top: { x: (b.x0 + b.x1) / 2 * rect.width, y: b.y0 * rect.height },
          bottom: { x: (b.x0 + b.x1) / 2 * rect.width, y: b.y1 * rect.height },
          left: { x: b.x0 * rect.width, y: (b.y0 + b.y1) / 2 * rect.height },
          right: { x: b.x1 * rect.width, y: (b.y0 + b.y1) / 2 * rect.height },
        };
      };

      const pointerDown = (e) => {
        const rect = canvas.getBoundingClientRect();
        const px = (e.clientX != null ? e.clientX : e.touches[0].clientX) - rect.left;
        const py = (e.clientY != null ? e.clientY : e.touches[0].clientY) - rect.top;
        const handles = getHandles();
        let best = null;
        let bestDist = handleRadius;
        for (const name of Object.keys(handles)) {
          const h = handles[name];
          const d = Math.hypot(h.x - px, h.y - py);
          if (d < bestDist) { bestDist = d; best = name; }
        }
        this.activeHandle = best;
        if (best) {
          canvas.setPointerCapture && e.pointerId != null && canvas.setPointerCapture(e.pointerId);
          e.preventDefault();
        }
      };

      const pointerMove = (e) => {
        if (!this.activeHandle) return;
        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX != null ? e.clientX : e.touches[0].clientX;
        const clientY = e.clientY != null ? e.clientY : e.touches[0].clientY;
        let fx = (clientX - rect.left) / rect.width;
        let fy = (clientY - rect.top) / rect.height;
        fx = Math.min(1, Math.max(0, fx));
        fy = Math.min(1, Math.max(0, fy));

        const minGap = 0.03;
        if (this.activeHandle === "top") {
          this.box.y0 = Math.min(fy, this.box.y1 - minGap);
        } else if (this.activeHandle === "bottom") {
          this.box.y1 = Math.max(fy, this.box.y0 + minGap);
        } else if (this.activeHandle === "left") {
          this.box.x0 = Math.min(fx, this.box.x1 - minGap);
        } else if (this.activeHandle === "right") {
          this.box.x1 = Math.max(fx, this.box.x0 + minGap);
        }
        if (this.onChange) this.onChange();
        e.preventDefault();
      };

      const pointerUp = () => { this.activeHandle = null; };

      canvas.addEventListener("pointerdown", pointerDown);
      canvas.addEventListener("pointermove", pointerMove);
      window.addEventListener("pointerup", pointerUp);
      canvas.addEventListener("pointercancel", pointerUp);

      // touch fallback for older browsers
      canvas.addEventListener("touchstart", pointerDown, { passive: false });
      canvas.addEventListener("touchmove", pointerMove, { passive: false });
      canvas.addEventListener("touchend", pointerUp);

      this._getHandles = getHandles;
    },

    /** Draw the calibration box + drag handles onto the overlay canvas (CSS pixel sized). */
    drawOverlay(ctx, cssW, cssH) {
      const b = this.box;
      const x0 = b.x0 * cssW, x1 = b.x1 * cssW;
      const y0 = b.y0 * cssH, y1 = b.y1 * cssH;

      const buf = this.getBufferedY();
      const by0 = buf.y0 * cssH, by1 = buf.y1 * cssH;

      ctx.save();
      // dim everything outside the padded detection window (the box
      // itself sits inside this, so it stays lit too)
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, cssW, by0);
      ctx.fillRect(0, by1, cssW, cssH - by1);
      ctx.fillRect(0, by0, x0, by1 - by0);
      ctx.fillRect(x1, by0, cssW - x1, by1 - by0);

      // padded detection window - dashed, muted (shows the buffer
      // added below the "0" tick so a low reading still has enough
      // contrasting rows to detect)
      ctx.strokeStyle = "rgba(127,176,255,0.5)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(x0, by0, x1 - x0, by1 - by0);
      ctx.setLineDash([]);

      // box outline (the calibrated reference - what the handles below
      // drag) - dashed like every other alignment line so it's easy to
      // see the physical scale ticks through it while lining up.
      ctx.strokeStyle = "#4c8dff";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);

      // Tared zero line, if set - the authoritative value=bottom anchor,
      // which may sit above or below the dragged bottom edge.
      if (this.zeroRowFrac != null) {
        const zy = this.zeroRowFrac * cssH;
        ctx.strokeStyle = "#35d38a";
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x0, zy);
        ctx.lineTo(x1, zy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#35d38a";
        ctx.font = "600 12px -apple-system, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText("tared 0", x1 + 6, zy);
      }

      // sample-strip guide (matches detector.js stripWidthFrac default)
      const stripPad = (x1 - x0) * 0.3;
      ctx.strokeStyle = "rgba(127,176,255,0.55)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x0 + stripPad, y0); ctx.lineTo(x0 + stripPad, y1);
      ctx.moveTo(x1 - stripPad, y0); ctx.lineTo(x1 - stripPad, y1);
      ctx.stroke();
      ctx.setLineDash([]);

      // top / bottom value lines
      ctx.fillStyle = "#eaf0ff";
      ctx.font = "600 13px -apple-system, sans-serif";
      ctx.textBaseline = "middle";

      const drawHandle = (x, y, label, labelX) => {
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fillStyle = "#4c8dff";
        ctx.fill();
        ctx.strokeStyle = "#eaf0ff";
        ctx.lineWidth = 2;
        ctx.stroke();
        if (label != null) {
          ctx.fillStyle = "#eaf0ff";
          ctx.fillText(label, labelX != null ? labelX : x + 14, y);
        }
      };

      const midX = (x0 + x1) / 2;
      // Value labels sit off to the right of the box entirely (rather
      // than right next to the handle, over the scale itself) so they
      // don't obscure the tick marks the user is trying to line up.
      const labelX = x1 + 14;
      drawHandle(midX, y0, this.values.top + "%", labelX);
      drawHandle(midX, y1, this.values.bottom + "%", labelX);
      drawHandle(x0, (y0 + y1) / 2, null);
      drawHandle(x1, (y0 + y1) / 2, null);
      ctx.restore();
    },
  };

  window.CalibrationCtl = CalibrationCtl;
})();
