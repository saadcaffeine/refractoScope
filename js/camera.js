/**
 * camera.js
 * Handles getUserMedia lifecycle, permission state, wake lock, torch,
 * and mobile-browser stability quirks (iOS/Android backgrounding,
 * orientation changes, secure-context checks).
 *
 * Exposes a single global: window.CameraCtl
 */
(function () {
  "use strict";

  const CameraCtl = {
    stream: null,
    videoEl: null,
    facingMode: "environment",
    wakeLock: null,
    wakeLockEnabled: true,
    torchOn: false,
    _visHandlerBound: null,
    _lastPermissionState: "unknown", // 'unknown' | 'prompt' | 'granted' | 'denied' | 'unsupported'

    isSecureContextOk() {
      // getUserMedia requires a secure context (https or localhost)
      return window.isSecureContext === true;
    },

    supportsGetUserMedia() {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    },

    /**
     * Best-effort permission status check. The Permissions API for
     * 'camera' is supported on Chrome/Android but NOT on iOS Safari,
     * so callers must treat 'unsupported' as "unknown, try requesting".
     */
    async queryPermissionState() {
      if (!this.isSecureContextOk()) return "insecure-context";
      if (!this.supportsGetUserMedia()) return "unsupported";
      if (navigator.permissions && navigator.permissions.query) {
        try {
          const status = await navigator.permissions.query({ name: "camera" });
          this._lastPermissionState = status.state;
          return status.state; // 'granted' | 'denied' | 'prompt'
        } catch (e) {
          // Some browsers (iOS Safari) throw / don't support 'camera' name
          return "unknown";
        }
      }
      return "unknown";
    },

    /**
     * Request the camera stream. Attaches to the given <video> element.
     * Returns { ok: true } or { ok: false, reason, error }.
     */
    async start(videoEl, facingMode) {
      this.videoEl = videoEl;
      if (facingMode) this.facingMode = facingMode;

      if (!this.isSecureContextOk()) {
        return { ok: false, reason: "insecure-context" };
      }
      if (!this.supportsGetUserMedia()) {
        return { ok: false, reason: "unsupported" };
      }

      // Stop any existing stream before requesting a new one (e.g. switch camera)
      this.stop();

      const constraints = {
        audio: false,
        video: {
          facingMode: { ideal: this.facingMode },
          width: { ideal: 1280 },
          height: { ideal: 960 },
        },
      };

      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.stream = stream;
        videoEl.srcObject = stream;
        // iOS Safari requires these attributes to be set both in HTML and
        // via JS for inline, autoplaying, muted playback to be reliable.
        videoEl.setAttribute("playsinline", "true");
        videoEl.setAttribute("muted", "true");
        videoEl.muted = true;
        await videoEl.play().catch(() => {
          /* Some browsers require a user gesture; the Enable button click
             that triggered start() counts as that gesture. */
        });
        this._lastPermissionState = "granted";
        this._bindLifecycleHandlers();
        if (this.wakeLockEnabled) this.requestWakeLock();
        return { ok: true };
      } catch (err) {
        let reason = "error";
        if (err && err.name === "NotAllowedError") {
          reason = "denied";
          this._lastPermissionState = "denied";
        } else if (err && err.name === "NotFoundError") {
          reason = "no-camera";
        } else if (err && err.name === "NotReadableError") {
          reason = "in-use";
        } else if (err && err.name === "OverconstrainedError") {
          // retry once with relaxed constraints
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            this.stream = stream;
            videoEl.srcObject = stream;
            await videoEl.play().catch(() => {});
            this._lastPermissionState = "granted";
            this._bindLifecycleHandlers();
            if (this.wakeLockEnabled) this.requestWakeLock();
            return { ok: true };
          } catch (err2) {
            return { ok: false, reason: "error", error: err2 };
          }
        }
        return { ok: false, reason, error: err };
      }
    },

    stop() {
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
      this.releaseWakeLock();
    },

    async switchFacing() {
      const next = this.facingMode === "environment" ? "user" : "environment";
      const videoEl = this.videoEl;
      return this.start(videoEl, next);
    },

    getVideoTrack() {
      return this.stream ? this.stream.getVideoTracks()[0] : null;
    },

    supportsTorch() {
      const track = this.getVideoTrack();
      if (!track) return false;
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      return !!caps.torch;
    },

    async setTorch(on) {
      const track = this.getVideoTrack();
      if (!track) return false;
      try {
        await track.applyConstraints({ advanced: [{ torch: on }] });
        this.torchOn = on;
        return true;
      } catch (e) {
        return false;
      }
    },

    async requestWakeLock() {
      if (!("wakeLock" in navigator)) return;
      try {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener("release", () => {
          this.wakeLock = null;
        });
      } catch (e) {
        // Wake Lock can fail (e.g. low battery, not visible) - non-fatal
        this.wakeLock = null;
      }
    },

    releaseWakeLock() {
      if (this.wakeLock) {
        this.wakeLock.release().catch(() => {});
        this.wakeLock = null;
      }
    },

    /**
     * Mobile browsers (esp. iOS Safari) frequently suspend camera
     * streams when the tab/app is backgrounded and do NOT reliably
     * resume them. We listen for visibility changes and re-acquire
     * the stream on resume to keep the app stable across app switches,
     * lock screens, and incoming calls/notifications.
     */
    _bindLifecycleHandlers() {
      if (this._visHandlerBound) return;
      this._visHandlerBound = async () => {
        if (document.visibilityState === "hidden") {
          this.releaseWakeLock();
        } else if (document.visibilityState === "visible") {
          const track = this.getVideoTrack();
          const needsRestart = !track || track.readyState === "ended";
          if (needsRestart && this.videoEl) {
            await this.start(this.videoEl, this.facingMode);
          } else if (this.wakeLockEnabled) {
            this.requestWakeLock();
          }
        }
      };
      document.addEventListener("visibilitychange", this._visHandlerBound);
      // iOS Safari sometimes fires pagehide/pageshow instead of/along with
      // visibilitychange when navigating away via gestures.
      window.addEventListener("pageshow", (e) => {
        if (e.persisted) this._visHandlerBound();
      });
    },
  };

  window.CameraCtl = CameraCtl;
})();
