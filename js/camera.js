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

  const LENS_STORAGE_KEY = "refractoscope.lens.v1";

  const CameraCtl = {
    stream: null,
    videoEl: null,
    facingMode: "environment",
    deviceId: null, // specific camera device currently in use, if any
    availableCameras: [], // populated by refreshDeviceList() after permission granted
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
     * Shared stream-acquisition logic used by start() and
     * startWithDeviceId(). Attaches the resulting stream to videoEl and
     * handles the iOS Safari inline-playback attribute dance.
     */
    async _acquire(videoEl, constraints) {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.stream = stream;
      videoEl.srcObject = stream;
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

      // Track which physical device we ended up on, and remember the
      // choice per facing mode so it survives across sessions.
      const track = stream.getVideoTracks()[0];
      const settings = track && track.getSettings ? track.getSettings() : {};
      this.deviceId = settings.deviceId || this.deviceId || null;
      if (settings.facingMode) this.facingMode = settings.facingMode;
      this._saveLensPreference();

      // Device labels are only populated by the browser once permission
      // has been granted, so refresh our cached device list now. Awaited
      // so callers can rely on availableCameras being current as soon as
      // start()/startWithDeviceId() resolves.
      await this.refreshDeviceList().catch(() => {});
    },

    /**
     * Request the camera stream by facing mode (front/back). Attaches to
     * the given <video> element. Returns { ok: true } or
     * { ok: false, reason, error }.
     */
    async start(videoEl, facingMode) {
      this.videoEl = videoEl;
      if (facingMode) this.facingMode = facingMode;
      this.deviceId = null; // facing-mode start lets the browser pick the device

      if (!this.isSecureContextOk()) {
        return { ok: false, reason: "insecure-context" };
      }
      if (!this.supportsGetUserMedia()) {
        return { ok: false, reason: "unsupported" };
      }

      // Stop any existing stream before requesting a new one (e.g. switch camera)
      this.stop();

      // If the user previously picked a specific lens for this facing
      // mode, prefer it over letting the browser guess.
      const remembered = this._loadLensPreference(this.facingMode);

      const constraints = {
        audio: false,
        video: Object.assign(
          {
            facingMode: { ideal: this.facingMode },
            width: { ideal: 1280 },
            height: { ideal: 960 },
          },
          remembered ? { deviceId: { ideal: remembered.deviceId } } : {}
        ),
      };

      try {
        await this._acquire(videoEl, constraints);
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
            await this._acquire(videoEl, { video: true, audio: false });
            return { ok: true };
          } catch (err2) {
            return { ok: false, reason: "error", error: err2 };
          }
        }
        return { ok: false, reason, error: err };
      }
    },

    /**
     * Request a specific physical camera by deviceId (used to pick
     * between multiple back lenses - main / ultra-wide / telephoto -
     * on phones that expose them as separate devices).
     */
    async startWithDeviceId(videoEl, deviceId) {
      this.videoEl = videoEl;
      this.stop();
      const constraints = {
        audio: false,
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: 1280 },
          height: { ideal: 960 },
        },
      };
      try {
        await this._acquire(videoEl, constraints);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err && err.name === "NotAllowedError" ? "denied" : "error", error: err };
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

    // ---------- Multi-lens (multiple back cameras) support ----------

    /**
     * Enumerates video input devices and annotates each with a guessed
     * facing (front/back/unknown) and a friendly lens name parsed from
     * its label (e.g. "Back Ultra Wide Camera" -> "Ultra Wide"). Labels
     * are only available after permission has been granted at least
     * once, so call this after a successful start().
     */
    async refreshDeviceList() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        this.availableCameras = [];
        return this.availableCameras;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === "videoinput");

      const guessFacing = (label) => {
        const l = (label || "").toLowerCase();
        if (l.includes("front") || l.includes("user") || l.includes("face")) return "user";
        if (l.includes("back") || l.includes("rear") || l.includes("environment")) return "environment";
        return "unknown";
      };
      const guessLensName = (label) => {
        const l = (label || "").toLowerCase();
        if (l.includes("ultra") && l.includes("wide")) return "Ultra Wide";
        if (l.includes("telephoto") || l.includes("tele")) return "Telephoto";
        if (l.includes("macro")) return "Macro";
        if (l.includes("wide")) return "Wide";
        if (l.includes("dual")) return "Dual";
        return null;
      };

      // Number unnamed lenses in order within their facing group so
      // e.g. two unlabeled back cameras become "Lens 1" / "Lens 2".
      const counters = {};
      this.availableCameras = cams.map((d) => {
        const facing = guessFacing(d.label);
        let lensName = guessLensName(d.label);
        if (!lensName) {
          counters[facing] = (counters[facing] || 0) + 1;
          lensName = `Lens ${counters[facing]}`;
        }
        return { deviceId: d.deviceId, label: d.label, facing, lensName };
      });
      return this.availableCameras;
    },

    /** Back (or front) cameras only, for populating a lens picker. */
    listCamerasForFacing(facing) {
      const list = this.availableCameras || [];
      const matched = list.filter((c) => c.facing === facing);
      // If facing couldn't be guessed from labels (label-less/older
      // browsers), fall back to showing everything rather than nothing.
      return matched.length ? matched : list;
    },

    _saveLensPreference() {
      if (!this.deviceId) return;
      try {
        const raw = localStorage.getItem(LENS_STORAGE_KEY);
        const prefs = raw ? JSON.parse(raw) : {};
        prefs[this.facingMode] = { deviceId: this.deviceId };
        localStorage.setItem(LENS_STORAGE_KEY, JSON.stringify(prefs));
      } catch (e) { /* ignore storage errors (e.g. private mode) */ }
    },

    _loadLensPreference(facing) {
      try {
        const raw = localStorage.getItem(LENS_STORAGE_KEY);
        if (!raw) return null;
        const prefs = JSON.parse(raw);
        return prefs[facing] || null;
      } catch (e) {
        return null;
      }
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
            // Prefer re-acquiring the exact lens the user had selected
            // (facing-mode start() would let the browser re-guess).
            if (this.deviceId) {
              const result = await this.startWithDeviceId(this.videoEl, this.deviceId);
              if (!result.ok) await this.start(this.videoEl, this.facingMode);
            } else {
              await this.start(this.videoEl, this.facingMode);
            }
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
