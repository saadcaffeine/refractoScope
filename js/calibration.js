/**
 * calibration.js
 * Interactive ROI calibration: the user drags a box's edges onto two
 * known tick marks on the physical scale, tightening it around just
 * the tick column. Stored as fractional coordinates (0-1) so it stays
 * valid across different camera resolutions/orientations, persisted
 * to localStorage for offline reuse across sessions.
 *
 * Exposes a single global: window.CalibrationCtl
 */
(function () {
  "use strict";

  const STORAGE_KEY = "refractoscope.calibration.v1";

  const DEFAULT_BOX = { x0: 0.40, y0: 0.22, x1: 0.60, y1: 0.80 };
  const DEFAULT_VALUES = { top: 30, bottom: 0 };

  const CalibrationCtl = {
    box: Object.assign({}, DEFAULT_BOX),
    values: Object.assign({}, DEFAULT_VALUES),
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
            return true;
          }
        }
      } catch (e) { /* ignore corrupt storage */ }
      return false;
    },

    save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ box: this.box, values: this.values }));
      } catch (e) { /* storage may be unavailable (private mode) - non-fatal */ }
    },

    reset() {
      this.box = Object.assign({}, DEFAULT_BOX);
      this.values = Object.assign({}, DEFAULT_VALUES);
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    },

    isCalibrated() {
      try {
        return localStorage.getItem(STORAGE_KEY) !== null;
      } catch (e) { return false; }
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

      ctx.save();
      // dim outside box
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, cssW, y0);
      ctx.fillRect(0, y1, cssW, cssH - y1);
      ctx.fillRect(0, y0, x0, y1 - y0);
      ctx.fillRect(x1, y0, cssW - x1, y1 - y0);

      // box outline
      ctx.strokeStyle = "#4c8dff";
      ctx.lineWidth = 2;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);

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

      const drawHandle = (x, y, label) => {
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fillStyle = "#4c8dff";
        ctx.fill();
        ctx.strokeStyle = "#eaf0ff";
        ctx.lineWidth = 2;
        ctx.stroke();
        if (label != null) {
          ctx.fillStyle = "#eaf0ff";
          ctx.fillText(label, x + 14, y);
        }
      };

      const midX = (x0 + x1) / 2;
      drawHandle(midX, y0, this.values.top + "°Bx");
      drawHandle(midX, y1, this.values.bottom + "°Bx");
      drawHandle(x0, (y0 + y1) / 2, null);
      drawHandle(x1, (y0 + y1) / 2, null);
      ctx.restore();
    },
  };

  window.CalibrationCtl = CalibrationCtl;
})();
