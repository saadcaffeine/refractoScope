/**
 * level.js
 * A mini digital plumb level using DeviceOrientationEvent, meant to
 * help hold the phone steady/vertical against the refractometer
 * eyepiece. Handles iOS 13+'s explicit motion permission prompt
 * (must be triggered by a user gesture) and works with no prompt at
 * all on Android/desktop, where the API is unrestricted.
 *
 * Exposes a single global: window.LevelCtl
 */
(function () {
  "use strict";

  const LEVEL_GOOD_DEG = 3;
  const LEVEL_WARN_DEG = 9;

  const LevelCtl = {
    supported: typeof DeviceOrientationEvent !== "undefined",
    needsPermission: typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function",
    permissionState: "unknown", // 'unknown' | 'granted' | 'denied' | 'not-needed' | 'unsupported'
    active: false, // true once we've received at least one real reading
    tilt: { x: 0, y: 0 }, // degrees off-level: x = side-to-side (gamma), y = front-back (beta-90)
    _handler: null,

    /**
     * Must be called from within a user gesture (click/tap) on iOS.
     * Safe to call repeatedly; no-ops once resolved.
     */
    async requestPermission() {
      if (!this.supported) {
        this.permissionState = "unsupported";
        return false;
      }
      if (!this.needsPermission) {
        this.permissionState = "not-needed";
        this._attach();
        return true;
      }
      try {
        const result = await DeviceOrientationEvent.requestPermission();
        this.permissionState = result === "granted" ? "granted" : "denied";
        if (this.permissionState === "granted") this._attach();
        return this.permissionState === "granted";
      } catch (e) {
        this.permissionState = "denied";
        return false;
      }
    },

    /** Call on boot: auto-activates on platforms that need no prompt. */
    autoStart() {
      if (this.supported && !this.needsPermission) {
        this.permissionState = "not-needed";
        this._attach();
      }
    },

    _attach() {
      if (this._handler) return;
      this._handler = (e) => {
        if (e.beta == null || e.gamma == null) return;
        this.active = true;
        let x = e.gamma; // left/right rock, 0 = level
        let y = e.beta - 90; // held vertically upright, 0 = level
        if (y > 180) y -= 360;
        if (y < -180) y += 360;
        this.tilt = { x, y };
      };
      window.addEventListener("deviceorientation", this._handler, true);
    },

    /** Combined off-level magnitude in degrees. */
    magnitude() {
      return Math.hypot(this.tilt.x, this.tilt.y);
    },

    classify() {
      if (!this.active) return "inactive";
      const m = this.magnitude();
      if (m <= LEVEL_GOOD_DEG) return "good";
      if (m <= LEVEL_WARN_DEG) return "warn";
      return "bad";
    },
  };

  window.LevelCtl = LevelCtl;
})();
