/**
 * app.js - orchestrates screens, camera, calibration and the live
 * detection loop.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    video: $("video"),
    overlay: $("overlay"),
    calCanvas: $("cal-canvas"),
    screenPermission: $("screen-permission"),
    screenLive: $("screen-live"),
    screenCalibrate: $("screen-calibrate"),
    screenSettings: $("screen-settings"),
    btnRequestCamera: $("btn-request-camera"),
    permissionStatus: $("permission-status"),
    permissionDeniedHelp: $("permission-denied-help"),
    btnSettingsTop: $("btn-settings"),
    levelWidget: $("level-widget"),
    levelCanvas: $("level-canvas"),
    weatherChip: $("weather-chip"),
    settingsLevelStatus: $("settings-level-status"),
    btnSettingsLevel: $("btn-settings-level"),
    settingsWeatherStatus: $("settings-weather-status"),
    btnSettingsWeather: $("btn-settings-weather"),
    salinityValue: $("salinity-value"),
    btnSnapshot: $("btn-snapshot"),
    settingsSnapshotStatus: $("settings-snapshot-status"),
    toggleSnapshotOverlay: $("toggle-snapshot-overlay"),
    btnTare: $("btn-tare"),
    settingsTareStatus: $("settings-tare-status"),
    btnClearTare: $("btn-clear-tare"),
    confidenceDot: $("confidence-dot"),
    confidenceLabel: $("confidence-label"),
    offlineBadge: $("offline-badge"),
    stabilityBadge: $("stability-badge"),
    btnTorch: $("btn-torch"),
    calTopValue: $("cal-top-value"),
    calBottomValue: $("cal-bottom-value"),
    btnAutodetect: $("btn-autodetect"),
    autodetectStatus: $("autodetect-status"),
    btnCalCancel: $("btn-cal-cancel"),
    btnCalSave: $("btn-cal-save"),
    settingsPermissionStatus: $("settings-permission-status"),
    btnSettingsPermission: $("btn-settings-permission"),
    settingsCalStatus: $("settings-cal-status"),
    btnSettingsCalibrate: $("btn-settings-calibrate"),
    btnSwitchCamera: $("btn-switch-camera"),
    rowLens: $("row-lens"),
    lensSelect: $("lens-select"),
    lensSubStatus: $("lens-sub-status"),
    toggleZoom: $("toggle-zoom"),
    zoomBadge: $("zoom-badge"),
    toggleWakelock: $("toggle-wakelock"),
    settingsOfflineStatus: $("settings-offline-status"),
    btnResetCal: $("btn-reset-cal"),
    btnCloseSettings: $("btn-close-settings"),
    tabBtns: Array.from(document.querySelectorAll(".tab-btn")),
  };

  const CONTAINER_ASPECT = 3 / 4; // matches .camera-wrap { aspect-ratio: 3/4 }
  const ANALYSIS_WIDTH = 420;
  const ANALYSIS_HEIGHT = Math.round(ANALYSIS_WIDTH / CONTAINER_ASPECT);
  const analysisCanvas = document.createElement("canvas");
  analysisCanvas.width = ANALYSIS_WIDTH;
  analysisCanvas.height = ANALYSIS_HEIGHT;
  const analysisCtx = analysisCanvas.getContext("2d", { willReadFrequently: true });

  const smoother = window.Detector.createSmoother({ alpha: 0.25, jumpThreshold: 3.5 });

  /**
   * Smooths the live-detected scope x-bounds (see "Horizontal
   * auto-centering" in runTick): fast-snaps to a big jump (the user
   * deliberately repositioned), slow-smooths small jitter (hand
   * vibration), and holds its last good value across a transient
   * failed detection rather than springing back to the static box.
   */
  function createXTracker(alpha, jumpThreshold) {
    let x0 = null, x1 = null;
    return {
      reset() { x0 = null; x1 = null; },
      hasValue() { return x0 !== null; },
      get() { return { x0, x1 }; },
      push(nx0, nx1) {
        if (x0 === null || Math.abs(nx0 - x0) > jumpThreshold || Math.abs(nx1 - x1) > jumpThreshold) {
          x0 = nx0; x1 = nx1;
        } else {
          x0 = x0 + alpha * (nx0 - x0);
          x1 = x1 + alpha * (nx1 - x1);
        }
        return { x0, x1 };
      },
    };
  }
  const dynamicXTracker = createXTracker(0.3, 0.08);

  let activeScreen = "screen-live";
  let lastTick = null; // { frameRowFrac, activeX0, activeX1, contrast, value, sg, confidence }
  let calRafId = null;
  let cameraReady = false;

  // ---------- Screen management ----------
  function switchScreen(name) {
    activeScreen = name;
    [els.screenPermission, els.screenLive, els.screenCalibrate, els.screenSettings].forEach((s) => s.classList.add("hidden"));
    $(name).classList.remove("hidden");
    els.tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.screen === name));

    if (name === "screen-calibrate") {
      els.calTopValue.value = window.CalibrationCtl.values.top;
      els.calBottomValue.value = window.CalibrationCtl.values.bottom;
      els.autodetectStatus.textContent = AUTODETECT_DEFAULT_STATUS;
      els.autodetectStatus.classList.remove("error", "success");
      startCalRenderLoop();
      updateCalStatusText();
    } else {
      stopCalRenderLoop();
    }
    if (name === "screen-settings") {
      refreshSettingsScreen();
    }
  }

  els.tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!cameraReady && btn.dataset.screen !== "screen-settings") {
        switchScreen("screen-permission");
        return;
      }
      switchScreen(btn.dataset.screen);
    });
  });
  els.btnSettingsTop.addEventListener("click", () => switchScreen("screen-settings"));
  els.btnCloseSettings.addEventListener("click", () => switchScreen(cameraReady ? "screen-live" : "screen-permission"));

  // ---------- Permission flow ----------
  async function refreshPermissionUI() {
    const state = await window.CameraCtl.queryPermissionState();
    let msg = "Status: ";
    els.permissionDeniedHelp.classList.add("hidden");
    switch (state) {
      case "granted": msg += "granted"; break;
      case "denied": msg += "blocked"; els.permissionDeniedHelp.classList.remove("hidden"); break;
      case "prompt": msg += "not yet requested"; break;
      case "insecure-context": msg += "unavailable (page must be loaded over HTTPS)"; break;
      case "unsupported": msg += "camera API not supported in this browser"; break;
      default: msg += "unknown — tap Enable camera";
    }
    els.permissionStatus.textContent = msg;
    return state;
  }

  async function attemptEnableCamera() {
    els.permissionStatus.textContent = "Status: requesting…";
    const result = await window.CameraCtl.start(els.video);
    if (result.ok) {
      cameraReady = true;
      window.CalibrationCtl.load();
      switchScreen("screen-live");
      startDetectionLoop();
      setupTorchButton();
      refreshLensUI();
      els.btnSnapshot.disabled = false;
    } else {
      let msg = "Status: ";
      els.permissionDeniedHelp.classList.add("hidden");
      switch (result.reason) {
        case "denied":
          msg += "blocked by browser";
          els.permissionDeniedHelp.classList.remove("hidden");
          break;
        case "no-camera": msg += "no camera found on this device"; break;
        case "in-use": msg += "camera is in use by another app"; break;
        case "insecure-context": msg += "unavailable — this page must be loaded over HTTPS"; break;
        case "unsupported": msg += "camera API not supported in this browser"; break;
        default: msg += "could not start camera";
      }
      els.permissionStatus.textContent = msg;
    }
  }

  els.btnRequestCamera.addEventListener("click", attemptEnableCamera);

  // ---------- Torch ----------
  function setupTorchButton() {
    if (window.CameraCtl.supportsTorch()) {
      els.btnTorch.classList.remove("hidden");
    } else {
      els.btnTorch.classList.add("hidden");
    }
  }
  els.btnTorch.addEventListener("click", async () => {
    const next = !window.CameraCtl.torchOn;
    const ok = await window.CameraCtl.setTorch(next);
    if (ok) els.btnTorch.classList.toggle("active", next);
  });

  // ---------- Digital plumb level ----------
  function levelTooltip() {
    const L = window.LevelCtl;
    if (!L.supported) return "Level: not supported by this browser";
    if (L.active) return "Level indicator";
    if (L.needsPermission && L.permissionState === "denied") return "Motion access blocked — tap for details in Settings";
    if (L.needsPermission) return "Tap to enable the level";
    return "Level indicator";
  }

  function drawLevel() {
    const L = window.LevelCtl;
    const canvas = els.levelCanvas;
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2;
    const outerR = w / 2 - 3;

    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(234,240,255,0.35)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(cx - 3, cy); ctx.lineTo(cx + 3, cy);
    ctx.moveTo(cx, cy - 3); ctx.lineTo(cx, cy + 3);
    ctx.stroke();

    if (!L.active) {
      ctx.fillStyle = "rgba(142,160,198,0.55)";
      ctx.beginPath();
      ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    const MAX_DEG = 20; // tilt magnitude that maps to the edge of the ring
    let ox = (L.tilt.x / MAX_DEG) * outerR;
    let oy = (L.tilt.y / MAX_DEG) * outerR;
    const dist = Math.hypot(ox, oy);
    const clampR = outerR - 4;
    if (dist > clampR) {
      const scale = clampR / dist;
      ox *= scale;
      oy *= scale;
    }

    const level = L.classify();
    ctx.fillStyle = level === "good" ? "#35d38a" : level === "warn" ? "#f2b544" : "#ff5b6e";
    ctx.beginPath();
    ctx.arc(cx + ox, cy + oy, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  function startLevelLoop() {
    setInterval(() => {
      if (document.hidden) return;
      drawLevel();
    }, 120);
  }

  function settingsLevelStatusText() {
    const L = window.LevelCtl;
    if (!L.supported) return "Not supported by this browser";
    if (L.active) return "Active";
    if (L.needsPermission && L.permissionState === "denied") return "Blocked — re-enable via device Settings app";
    if (L.needsPermission) return "Not yet enabled — tap Enable";
    return "Waiting for first reading…";
  }

  els.levelWidget.addEventListener("click", async () => {
    const L = window.LevelCtl;
    if (!L.active) {
      await L.requestPermission();
      els.levelWidget.title = levelTooltip();
      if (activeScreen === "screen-settings") refreshSettingsScreen();
    }
  });

  els.btnSettingsLevel.addEventListener("click", async () => {
    await window.LevelCtl.requestPermission();
    refreshSettingsScreen();
  });

  // ---------- Local weather (opt-in, needs geolocation) ----------
  function formatWeatherChip(range) {
    if (!range) return "";
    const lo = Math.round(range.min);
    const hi = Math.round(range.max);
    return `${lo}°–${hi}°C`;
  }

  function updateWeatherChip() {
    const W = window.WeatherCtl;
    if (W.status === "ready" && W.range) {
      els.weatherChip.textContent = formatWeatherChip(W.range);
      els.weatherChip.classList.remove("hidden");
    } else {
      els.weatherChip.classList.add("hidden");
    }
  }

  function settingsWeatherStatusText() {
    const W = window.WeatherCtl;
    if (!W.isEnabled()) return "Off — uses your location, never stored elsewhere";
    switch (W.status) {
      case "locating": return "Finding your location…";
      case "fetching": return "Fetching today's forecast…";
      case "ready": return `Today: ${formatWeatherChip(W.range)}`;
      case "denied": return "Location access blocked — re-enable via browser/device settings";
      case "unsupported": return "Geolocation not supported by this browser";
      case "offline": return "Offline — will retry once you're back online";
      case "error": return "Couldn't fetch the forecast — tap Retry";
      default: return "Enabled — tap Refresh";
    }
  }

  function updateWeatherSettingsUI() {
    const W = window.WeatherCtl;
    els.settingsWeatherStatus.textContent = settingsWeatherStatusText();
    els.btnSettingsWeather.textContent = !W.isEnabled() ? "Enable" : W.status === "error" ? "Retry" : "Refresh";
  }

  els.btnSettingsWeather.addEventListener("click", async () => {
    const W = window.WeatherCtl;
    if (!W.isEnabled()) W.setEnabled(true);
    els.settingsWeatherStatus.textContent = "Requesting location…";
    els.btnSettingsWeather.disabled = true;
    await W.refresh();
    els.btnSettingsWeather.disabled = false;
    updateWeatherSettingsUI();
    updateWeatherChip();
  });

  // ---------- Lens picker (multiple back/front cameras) ----------
  function refreshLensUI() {
    const cams = window.CameraCtl.listCamerasForFacing(window.CameraCtl.facingMode);

    if (!cams || cams.length <= 1) {
      els.rowLens.classList.add("hidden");
      return;
    }

    els.rowLens.classList.remove("hidden");

    // Rebuild options only if the set of devices actually changed, so we
    // don't fight the user's open dropdown / lose their selection mid-edit.
    const currentIds = Array.from(els.lensSelect.options).map((o) => o.value).join("|");
    const newIds = cams.map((c) => c.deviceId).join("|");
    if (currentIds !== newIds) {
      els.lensSelect.innerHTML = "";
      cams.forEach((cam, i) => {
        const opt = document.createElement("option");
        opt.value = cam.deviceId;
        opt.textContent = cam.lensName || `Lens ${i + 1}`;
        els.lensSelect.appendChild(opt);
      });
    }

    const current = cams.find((c) => c.deviceId === window.CameraCtl.deviceId);
    if (current) {
      els.lensSelect.value = current.deviceId;
      els.lensSubStatus.textContent = `Using ${current.lensName} (${cams.length} lenses detected)`;
    } else {
      els.lensSubStatus.textContent = `${cams.length} lenses detected — choose one`;
    }
  }

  els.toggleZoom.addEventListener("change", () => {
    setZoomLevel(els.toggleZoom.checked ? 2 : 1);
    applyZoomToVideoEl();
    smoother.reset();
    dynamicXTracker.reset();
  });

  els.lensSelect.addEventListener("change", async () => {
    const deviceId = els.lensSelect.value;
    if (!deviceId) return;
    els.lensSubStatus.textContent = "Switching lens…";
    const result = await window.CameraCtl.startWithDeviceId(els.video, deviceId);
    if (result.ok) {
      smoother.reset();
      dynamicXTracker.reset();
      setupTorchButton();
      refreshLensUI();
    } else {
      els.lensSubStatus.textContent = "Couldn't switch to that lens";
    }
  });

  // ---------- Cover-fit drawing helper ----------
  // `zoom` (1 or 2) shrinks the source crop toward its center, giving a
  // digital zoom that stays perfectly in sync between what's displayed
  // (the <video> element gets a matching CSS transform, see
  // applyZoomToVideoEl) and what's analyzed/calibrated/snapshotted -
  // all three consumers below share this same helper, so fractional
  // box coordinates keep meaning the same thing at any zoom level.
  function getCoverSourceRect(video, containerAspect, zoom) {
    zoom = zoom || 1;
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const videoAspect = vw / vh;
    let sx, sy, sw, sh;
    if (videoAspect > containerAspect) {
      sh = vh;
      sw = vh * containerAspect;
      sx = (vw - sw) / 2;
      sy = 0;
    } else {
      sw = vw;
      sh = vw / containerAspect;
      sx = 0;
      sy = (vh - sh) / 2;
    }
    if (zoom > 1) {
      const zsw = sw / zoom, zsh = sh / zoom;
      sx += (sw - zsw) / 2;
      sy += (sh - zsh) / 2;
      sw = zsw;
      sh = zsh;
    }
    return { sx, sy, sw, sh };
  }

  function drawVideoCover(ctx, video, destW, destH, zoom) {
    if (!video.videoWidth) return false;
    const { sx, sy, sw, sh } = getCoverSourceRect(video, destW / destH, zoom);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, destW, destH);
    return true;
  }

  // ---------- Zoom (digital, applied consistently to display + detection) ----------
  const ZOOM_STORAGE_KEY = "refractoscope.zoom.v1";

  function getZoomLevel() {
    try {
      return localStorage.getItem(ZOOM_STORAGE_KEY) === "2" ? 2 : 1;
    } catch (e) {
      return 1;
    }
  }

  function setZoomLevel(z) {
    try { localStorage.setItem(ZOOM_STORAGE_KEY, String(z)); } catch (e) { /* ignore */ }
  }

  /** Visually zooms the live <video> element to match the digital crop
   *  used everywhere else (see getCoverSourceRect). The overlay canvas
   *  itself is never transformed - its fractional coordinates already
   *  line up because they're derived from the same zoomed crop. */
  function applyZoomToVideoEl() {
    const z = getZoomLevel();
    els.video.style.transform = z > 1 ? `scale(${z})` : "";
    els.zoomBadge.classList.toggle("hidden", z <= 1);
  }

  // ---------- Snapshot (save a still image locally) ----------
  const SNAPSHOT_OVERLAY_KEY = "refractoscope.snapshot.overlay";

  function snapshotOverlayEnabled() {
    try {
      const v = localStorage.getItem(SNAPSHOT_OVERLAY_KEY);
      return v === null ? true : v === "1";
    } catch (e) {
      return true;
    }
  }

  function setSnapshotOverlayEnabled(v) {
    try {
      localStorage.setItem(SNAPSHOT_OVERLAY_KEY, v ? "1" : "0");
    } catch (e) { /* ignore storage errors (e.g. private mode) */ }
  }

  // ---- Best-effort metadata for the snapshot overlay ----
  // Every lookup here is wrapped so a missing/unsupported API just
  // yields null/omitted rather than breaking the snapshot.

  let _deviceLabelCache; // undefined = not yet resolved, null/false = resolved to nothing

  /**
   * Browsers deliberately don't expose a real "device model" for
   * fingerprinting reasons. Chromium's User-Agent Client Hints give an
   * actual model string on Android; nothing does on iOS/desktop, so we
   * fall back to parsing whatever coarse platform hint the classic UA
   * string carries (often still includes the model on Android).
   */
  async function resolveDeviceLabel() {
    if (_deviceLabelCache !== undefined) return _deviceLabelCache;
    let label = null;
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const uaData = await navigator.userAgentData.getHighEntropyValues(["model", "platform", "platformVersion"]);
        if (uaData && uaData.model) label = uaData.model;
        else if (uaData && uaData.platform) label = [uaData.platform, uaData.platformVersion].filter(Boolean).join(" ");
      }
    } catch (e) { /* ignore, fall through to UA-string guess */ }

    if (!label) {
      try {
        const ua = navigator.userAgent || "";
        let m;
        if ((m = ua.match(/Android[^;]*;\s*([^)]+?)\)/))) {
          label = m[1].replace(/\s*Build\/.*/, "").trim();
        } else if (/iPhone/.test(ua)) {
          label = "iPhone";
        } else if (/iPad/.test(ua)) {
          label = "iPad";
        } else if (/Macintosh/.test(ua)) {
          label = "Mac";
        } else if (/Windows/.test(ua)) {
          label = "Windows PC";
        }
      } catch (e) { /* ignore */ }
    }
    _deviceLabelCache = label || null;
    return _deviceLabelCache;
  }

  /** Facing + lens name, reusing the same data the Lens picker uses. */
  function getLensLabel() {
    try {
      const facing = window.CameraCtl.facingMode;
      const facingLabel = facing === "user" ? "Front" : facing === "environment" ? "Back" : null;
      const cams = window.CameraCtl.listCamerasForFacing(facing) || [];
      const current = cams.find((c) => c.deviceId === window.CameraCtl.deviceId);
      if (current && cams.length > 1) {
        return facingLabel ? `${facingLabel} · ${current.lensName}` : current.lensName;
      }
      return facingLabel ? `${facingLabel} camera` : null;
    } catch (e) {
      return null;
    }
  }

  /** Active capture resolution, straight from the live MediaStreamTrack. */
  function getResolutionLabel() {
    try {
      const track = window.CameraCtl.getVideoTrack();
      const settings = track && track.getSettings ? track.getSettings() : null;
      if (settings && settings.width && settings.height) {
        return `${settings.width}×${settings.height}`;
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /**
   * ISO has no standard place in the Media Capture API. A handful of
   * Chromium builds expose it via getSettings() or the experimental
   * ImageCapture.getPhotoSettings(); everywhere else this resolves to
   * null and the line is simply omitted.
   */
  async function tryGetIso() {
    try {
      const track = window.CameraCtl.getVideoTrack();
      if (!track) return null;
      const settings = track.getSettings ? track.getSettings() : {};
      if (typeof settings.iso === "number") return settings.iso;
      if (window.ImageCapture) {
        const capture = new ImageCapture(track);
        const photoSettings = await capture.getPhotoSettings();
        if (photoSettings && typeof photoSettings.iso === "number") return photoSettings.iso;
      }
    } catch (e) { /* not supported on this device/browser */ }
    return null;
  }

  /** Cached weather-location coordinates, if the user opted into weather. */
  function getLocationLabel() {
    try {
      const loc = window.WeatherCtl.getLastKnownLocation();
      if (loc) return `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}`;
    } catch (e) { /* ignore */ }
    return null;
  }

  /** Captures the current camera view (matching what's on screen) as a JPEG blob. */
  async function captureSnapshotBlob() {
    const video = els.video;
    if (!video.videoWidth) return null;

    const { sx, sy, sw, sh } = getCoverSourceRect(video, CONTAINER_ASPECT, getZoomLevel());
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    if (snapshotOverlayEnabled()) {
      const w = canvas.width, h = canvas.height;
      // Fractional coordinates are portable between the analysis
      // canvas and this full-res snapshot canvas since both use the
      // same cover-fit crop (CONTAINER_ASPECT).
      const b = window.CalibrationCtl.box;
      const gx0 = (lastTick ? lastTick.activeX0 : b.x0) * w;
      const gx1 = (lastTick ? lastTick.activeX1 : b.x1) * w;
      const y0 = b.y0 * h, y1 = b.y1 * h;

      ctx.strokeStyle = "rgba(76,141,255,0.85)";
      ctx.lineWidth = Math.max(2, w * 0.0035);
      ctx.strokeRect(gx0, y0, gx1 - gx0, y1 - y0);

      if (lastTick) {
        const lineY = lastTick.frameRowFrac * h;
        ctx.strokeStyle = "#ff5b6e";
        ctx.lineWidth = Math.max(3, w * 0.005);
        ctx.beginPath();
        ctx.moveTo(gx0, lineY);
        ctx.lineTo(gx1, lineY);
        ctx.stroke();
      }

      const pad = w * 0.025;

      // Reading label pill, bottom-left (unchanged from before).
      const label = lastTick && lastTick.confLevel !== "bad"
        ? `${lastTick.value.toFixed(1)}% salinity`
        : "No signal";
      const fontSize = Math.round(w * 0.045);
      ctx.font = `700 ${fontSize}px -apple-system, sans-serif`;
      const textW = ctx.measureText(label).width;
      const boxH = fontSize + pad * 1.4;
      const readingBoxY = h - boxH - pad * 0.6;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(pad * 0.6, readingBoxY, textW + pad * 1.6, boxH);
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.fillText(label, pad * 1.2, readingBoxY + boxH / 2 + fontSize * 0.05);

      // Small device/camera/location metadata block, stacked just
      // above the reading pill, bottom-left. Only fields that actually
      // resolved are included; the rest are silently skipped.
      const [deviceLabel, iso] = await Promise.all([resolveDeviceLabel(), tryGetIso()]);
      const resLabel = getResolutionLabel();
      const lensLabel = getLensLabel();
      const locLabel = getLocationLabel();

      const metaLines = [];
      if (deviceLabel) metaLines.push(deviceLabel);
      const camLine = [resLabel, lensLabel].filter(Boolean).join(" · ");
      if (camLine) metaLines.push(camLine);
      if (typeof iso === "number") metaLines.push(`ISO ${iso}`);
      if (locLabel) metaLines.push(locLabel);

      if (metaLines.length) {
        const metaFontSize = Math.max(9, Math.round(w * 0.022));
        const lineH = metaFontSize * 1.35;
        ctx.font = `500 ${metaFontSize}px -apple-system, sans-serif`;
        const metaW = Math.max(...metaLines.map((l) => ctx.measureText(l).width));
        const metaBoxH = metaLines.length * lineH + pad * 0.6;
        const metaBoxY = readingBoxY - metaBoxH - pad * 0.35;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(pad * 0.6, metaBoxY, metaW + pad * 1.6, metaBoxH);
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.textBaseline = "middle";
        metaLines.forEach((line, i) => {
          ctx.fillText(line, pad * 1.2, metaBoxY + pad * 0.3 + lineH * (i + 0.5));
        });
      }

      const ts = new Date().toLocaleString();
      ctx.font = `500 ${Math.round(fontSize * 0.55)}px -apple-system, sans-serif`;
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.shadowColor = "rgba(0,0,0,0.8)";
      ctx.shadowBlur = 4;
      ctx.fillText(ts, w - pad, h - pad);
      ctx.shadowBlur = 0;
      ctx.textAlign = "left";
    }

    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92));
  }

  function flashSnapshotButton() {
    els.btnSnapshot.classList.add("flash");
    setTimeout(() => els.btnSnapshot.classList.remove("flash"), 450);
  }

  async function handleSnapshot() {
    if (els.btnSnapshot.disabled) return;
    els.btnSnapshot.disabled = true;
    try {
      const blob = await captureSnapshotBlob();
      if (!blob) return;
      const filename = `refractoscope-${new Date().toISOString().replace(/[:.]/g, "-")}.jpg`;

      let saved = false;
      if (navigator.canShare && window.File) {
        try {
          const file = new File([blob], filename, { type: "image/jpeg" });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: "refractoScope reading" });
            saved = true;
          }
        } catch (err) {
          // User cancelling the native share sheet is not a failure.
          saved = err && err.name === "AbortError";
        }
      }
      if (!saved) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
      flashSnapshotButton();
    } finally {
      els.btnSnapshot.disabled = !cameraReady;
    }
  }

  function settingsSnapshotStatusText() {
    if (!document.createElement("canvas").toBlob) return "Not supported by this browser";
    if (!cameraReady) return "Start the camera first";
    if (navigator.canShare) return "Ready — opens your device's share sheet to save to Photos/Files";
    return "Ready — downloads directly to this device";
  }

  els.btnSnapshot.addEventListener("click", handleSnapshot);
  els.toggleSnapshotOverlay.addEventListener("change", () => {
    setSnapshotOverlayEnabled(els.toggleSnapshotOverlay.checked);
  });

  // ---------- Tare (set 0 against a known 0% sample) ----------
  function flashTareButton() {
    els.btnTare.classList.add("flash");
    setTimeout(() => els.btnTare.classList.remove("flash"), 450);
  }

  function updateTareStatusText() {
    els.settingsTareStatus.textContent = window.CalibrationCtl.isTared()
      ? "Tared — using the measured 0 position"
      : "Not tared — using the calibrated 0 position";
  }

  els.btnTare.addEventListener("click", () => {
    if (!lastTick || lastTick.confLevel === "bad") return;
    window.CalibrationCtl.zeroRowFrac = lastTick.frameRowFrac;
    window.CalibrationCtl.save();
    smoother.reset();
    flashTareButton();
    updateTareStatusText();
  });

  els.btnClearTare.addEventListener("click", () => {
    window.CalibrationCtl.zeroRowFrac = null;
    window.CalibrationCtl.save();
    smoother.reset();
    updateTareStatusText();
  });

  // ---------- Detection loop (runs continuously at low rate) ----------
  const TICK_MS = 350;
  let tickTimer = null;

  function classifyConfidence(contrast) {
    if (contrast < 22) return { level: "bad", label: "No signal" };
    if (contrast < 65) return { level: "warn", label: "Low confidence" };
    return { level: "good", label: "Reading stable" };
  }

  function runTick() {
    if (document.hidden) return;
    if (!els.video.videoWidth) return;

    if (!drawVideoCover(analysisCtx, els.video, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, getZoomLevel())) return;
    let imageData;
    try {
      imageData = analysisCtx.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    } catch (e) {
      return; // canvas tainted or not ready
    }

    const refBox = window.CalibrationCtl.box; // the user-calibrated reference (unbuffered, static x)
    const bufferedY = window.CalibrationCtl.getBufferedY(); // padded sampling window, mostly downward

    // ---- Horizontal auto-centering ----
    // Only active on the Live screen: while the user is on the
    // Calibrate screen actively dragging refBox, the detection window
    // must track exactly what they're dragging, not a live-detected
    // position, or the preview line would stop matching the box.
    let activeX0 = refBox.x0;
    let activeX1 = refBox.x1;
    if (activeScreen === "screen-live" && window.CalibrationCtl.dynamicX) {
      const y0px = Math.round(refBox.y0 * ANALYSIS_HEIGHT);
      const y1px = Math.round(refBox.y1 * ANALYSIS_HEIGHT);
      const bounds = window.Detector.detectHorizontalBounds(imageData, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, y0px, y1px);
      if (bounds.ok) {
        const span = bounds.rightFrac - bounds.leftFrac;
        const rel = window.CalibrationCtl.dynamicX;
        const smoothed = dynamicXTracker.push(
          bounds.leftFrac + rel.relX0 * span,
          bounds.leftFrac + rel.relX1 * span
        );
        activeX0 = smoothed.x0;
        activeX1 = smoothed.x1;
      } else if (dynamicXTracker.hasValue()) {
        // Transient bad frame (motion blur, hand briefly off-target) -
        // hold the last good position rather than snapping back.
        const held = dynamicXTracker.get();
        activeX0 = held.x0;
        activeX1 = held.x1;
      }
      // else: no good detection yet this session - fall back to the
      // static refBox x-bounds already assigned above.
    }

    const detectBox = { x0: activeX0, x1: activeX1, y0: bufferedY.y0, y1: bufferedY.y1 };
    const result = window.Detector.analyzeFrame(imageData, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, detectBox);
    if (!result.ok) return;

    // Value mapping anchors "bottom" (usually 0) to the Tared zero
    // position when set, otherwise falls back to the dragged box.y1 -
    // exactly today's behavior. Either way the anchor is independent
    // of the padded sampling window, so a transition found inside the
    // buffer zone correctly extrapolates to a value at/near the low
    // end instead of being clipped at it.
    const { top, bottom } = window.CalibrationCtl.values;
    const zeroAnchor = window.CalibrationCtl.getZeroAnchor();
    const refSpan = zeroAnchor - refBox.y0;
    const refRowFrac = Math.abs(refSpan) > 0.0001 ? (result.frameRowFrac - refBox.y0) / refSpan : 0.5;
    const rawValue = window.Detector.rowFracToValue(refRowFrac, top, bottom);
    const conf = classifyConfidence(result.contrast);
    const confNum = conf.level === "good" ? 1 : conf.level === "warn" ? 0.5 : 0;

    const smoothed = smoother.push(rawValue, confNum);

    lastTick = {
      frameRowFrac: result.frameRowFrac,
      activeX0,
      activeX1,
      contrast: result.contrast,
      rawValue,
      value: smoothed.value,
      confLevel: conf.level,
      confLabel: conf.label,
    };

    if (activeScreen === "screen-live") updateLiveUI();
  }

  function startDetectionLoop() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(runTick, TICK_MS);
    runTick();
  }

  // ---------- Live screen rendering ----------
  function resizeCanvasToContainer(canvas) {
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, cssW: rect.width, cssH: rect.height };
  }

  function updateLiveUI() {
    if (!lastTick) return;

    const { ctx, cssW, cssH } = resizeCanvasToContainer(els.overlay);
    ctx.clearRect(0, 0, cssW, cssH);

    // The box's x-bounds follow the live-detected scope position (see
    // runTick's horizontal auto-centering) when available, so this
    // guide box visibly tracks minor hand movement; y-bounds stay at
    // the static calibrated reference.
    const b = window.CalibrationCtl.box;
    const x0 = lastTick.activeX0 * cssW, x1 = lastTick.activeX1 * cssW;
    const y0 = b.y0 * cssH, y1 = b.y1 * cssH;

    ctx.strokeStyle = "rgba(76,141,255,0.55)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([]);

    if (window.CalibrationCtl.isTared()) {
      const zy = window.CalibrationCtl.zeroRowFrac * cssH;
      ctx.strokeStyle = "rgba(53,211,138,0.6)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, zy);
      ctx.lineTo(x1, zy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Absolute frame position - may legitimately land outside the box
    // (below it) when the reading is near the low end of the scale,
    // inside the buffer zone.
    const lineY = lastTick.frameRowFrac * cssH;
    ctx.strokeStyle = lastTick.confLevel === "bad" ? "rgba(255,91,110,0.9)" : "#ff5b6e";
    ctx.lineWidth = 2.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, lineY);
    ctx.lineTo(x1, lineY);
    ctx.stroke();
    ctx.setLineDash([]);

    if (lastTick.confLevel === "bad") {
      els.salinityValue.textContent = "--.-";
    } else {
      els.salinityValue.textContent = lastTick.value.toFixed(1);
    }

    els.confidenceDot.className = "dot " + lastTick.confLevel;
    els.confidenceLabel.textContent = lastTick.confLabel;
    els.stabilityBadge.classList.toggle("hidden", lastTick.confLevel !== "warn");

    els.offlineBadge.classList.toggle("hidden", navigator.onLine !== false);

    // Tare only makes sense against a stable, non-noise reading.
    els.btnTare.disabled = lastTick.confLevel === "bad";
  }

  // ---------- Calibration screen rendering ----------
  function startCalRenderLoop() {
    if (calRafId) return;
    const loop = () => {
      if (activeScreen !== "screen-calibrate") { calRafId = null; return; }
      const { ctx, cssW, cssH } = resizeCanvasToContainer(els.calCanvas);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cssW, cssH);
      drawVideoCover(ctx, els.video, cssW, cssH, getZoomLevel());

      window.CalibrationCtl.drawOverlay(ctx, cssW, cssH);

      if (lastTick) {
        // Detection window x-bounds stay static (equal to the box
        // being dragged) while on this screen - see runTick. Line
        // position is absolute and may fall within the dashed buffer
        // zone below the box for a low reading.
        const x0 = lastTick.activeX0 * cssW, x1 = lastTick.activeX1 * cssW;
        const lineY = lastTick.frameRowFrac * cssH;
        ctx.strokeStyle = "#ff5b6e";
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(x0, lineY);
        ctx.lineTo(x1, lineY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      calRafId = requestAnimationFrame(loop);
    };
    calRafId = requestAnimationFrame(loop);
  }

  function stopCalRenderLoop() {
    if (calRafId) {
      cancelAnimationFrame(calRafId);
      calRafId = null;
    }
  }

  window.CalibrationCtl.onChange = () => {}; // overlay redraws every rAF tick already

  els.calTopValue.addEventListener("input", () => {
    const v = parseFloat(els.calTopValue.value);
    if (!isNaN(v)) window.CalibrationCtl.values.top = v;
  });
  els.calBottomValue.addEventListener("input", () => {
    const v = parseFloat(els.calBottomValue.value);
    if (!isNaN(v)) window.CalibrationCtl.values.bottom = v;
  });

  // ---------- Auto-detect (OCR-assisted calibration) ----------
  const AUTODETECT_DEFAULT_STATUS = els.autodetectStatus.textContent;

  const AUTODETECT_REASON_MESSAGES = {
    "no-video": "Camera isn't ready yet.",
    "capture-failed": "Couldn't capture a frame — try again.",
    "scope-not-found": "Couldn't find the scope in frame. Fill more of the frame with the eyepiece and make sure it's well lit.",
    "low-contrast": "Not enough contrast against the background. Improve lighting or steady the phone and try again.",
    "region-too-small": "The scope looks too small in frame — move closer or zoom in, then try again.",
    "ocr-unavailable": "Couldn't load the text-reading engine — check your connection for first-time use (it's cached for offline use after that).",
    "crop-too-small": "The detected scale area is too small to read. Move closer or zoom in, then try again.",
    "ocr-failed": "Reading the scale failed — try holding the phone steadier and closer to the eyepiece.",
    "too-few-numeric-tokens": "Couldn't read enough printed numbers on the scale. Make sure the 0-100 numerals are in frame, sharp, and well lit.",
    "no-salinity-column-found": "Found numbers but couldn't identify the 0-100 Salinity scale specifically. Try improving focus/lighting, or calibrate manually below.",
    "too-few-tick-candidates": "Only found a couple of matching tick numbers — not enough to calibrate reliably. Try again with better framing.",
    "fit-failed": "The detected tick numbers didn't line up consistently. Try again, or calibrate manually below.",
  };

  function setAutodetectStatus(text, kind) {
    els.autodetectStatus.textContent = text;
    els.autodetectStatus.classList.remove("error", "success");
    if (kind) els.autodetectStatus.classList.add(kind);
  }

  els.btnAutodetect.addEventListener("click", async () => {
    if (els.btnAutodetect.disabled) return;
    els.btnAutodetect.disabled = true;
    setAutodetectStatus("Detecting… this can take a few seconds, longer on first use.");

    try {
      const result = await window.AutoDetect.run(els.video, CONTAINER_ASPECT, getZoomLevel(), (m) => {
        if (m && m.status) {
          const pct = typeof m.progress === "number" ? ` ${Math.round(m.progress * 100)}%` : "";
          setAutodetectStatus(`Detecting… ${m.status}${pct}`);
        }
      });

      if (!result.ok) {
        setAutodetectStatus(AUTODETECT_REASON_MESSAGES[result.reason] || "Auto-detect couldn't calibrate — try again or calibrate manually below.", "error");
        return;
      }

      // Fill in the box/values the same way dragging the handles would -
      // nothing is persisted until the user taps Save calibration, so
      // this is always safe to try and easy to back out of via Cancel.
      window.CalibrationCtl.box = result.box;
      window.CalibrationCtl.values = result.values;
      els.calTopValue.value = result.values.top;
      els.calBottomValue.value = result.values.bottom;

      const conf = result.confidence;
      const droppedNote = conf.pointsDropped ? `, ignored ${conf.pointsDropped} unreliable reading${conf.pointsDropped > 1 ? "s" : ""}` : "";
      setAutodetectStatus(`Detected using ${conf.pointsUsed} tick marks${droppedNote}. Review the box below, adjust if needed, then Save.`, "success");
    } catch (e) {
      setAutodetectStatus("Auto-detect ran into an unexpected error — try again or calibrate manually below.", "error");
    } finally {
      els.btnAutodetect.disabled = false;
    }
  });

  els.btnCalCancel.addEventListener("click", () => {
    window.CalibrationCtl.load(); // discard unsaved edits, revert to last saved (or defaults)
    dynamicXTracker.reset();
    setAutodetectStatus(AUTODETECT_DEFAULT_STATUS);
    switchScreen("screen-live");
  });

  /**
   * Establishes the horizontal auto-centering reference: detects the
   * scope's left/right edges at exactly the box the user just
   * calibrated, then stores the box's x-bounds as fractions relative
   * to that scope width. If detection isn't confident right now (e.g.
   * poor lighting), dynamicX is cleared and the box simply stays
   * static - never a hard requirement for calibration to work.
   */
  function establishDynamicXReference() {
    const box = window.CalibrationCtl.box;
    try {
      if (els.video.videoWidth && drawVideoCover(analysisCtx, els.video, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, getZoomLevel())) {
        const imageData = analysisCtx.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
        const y0px = Math.round(box.y0 * ANALYSIS_HEIGHT);
        const y1px = Math.round(box.y1 * ANALYSIS_HEIGHT);
        const bounds = window.Detector.detectHorizontalBounds(imageData, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, y0px, y1px);
        if (bounds.ok) {
          const span = bounds.rightFrac - bounds.leftFrac;
          window.CalibrationCtl.dynamicX = {
            relX0: (box.x0 - bounds.leftFrac) / span,
            relX1: (box.x1 - bounds.leftFrac) / span,
          };
        } else {
          window.CalibrationCtl.dynamicX = null;
        }
      } else {
        window.CalibrationCtl.dynamicX = null;
      }
    } catch (e) {
      window.CalibrationCtl.dynamicX = null;
    }
    dynamicXTracker.reset();
  }

  els.btnCalSave.addEventListener("click", () => {
    // A new span/window calibration invalidates any prior Tare - the
    // measured zero position was relative to the OLD box's framing.
    window.CalibrationCtl.zeroRowFrac = null;
    establishDynamicXReference();
    window.CalibrationCtl.save();
    smoother.reset();
    updateTareStatusText();
    switchScreen("screen-live");
  });

  function updateCalStatusText() {
    if (!window.CalibrationCtl.isCalibrated()) {
      els.settingsCalStatus.textContent = "Not calibrated — using defaults";
      return;
    }
    const range = `Calibrated (${window.CalibrationCtl.values.bottom}–${window.CalibrationCtl.values.top}%)`;
    els.settingsCalStatus.textContent = window.CalibrationCtl.dynamicX
      ? `${range} · auto-centering on`
      : `${range} · auto-centering unavailable (recalibrate in brighter contrast)`;
  }

  // ---------- Settings screen ----------
  els.btnSettingsCalibrate.addEventListener("click", () => switchScreen("screen-calibrate"));

  els.btnSettingsPermission.addEventListener("click", async () => {
    if (!cameraReady) {
      await attemptEnableCamera();
    }
    refreshSettingsScreen();
  });

  els.btnSwitchCamera.addEventListener("click", async () => {
    await window.CameraCtl.switchFacing();
    smoother.reset();
    dynamicXTracker.reset();
    setupTorchButton();
    refreshLensUI();
  });

  els.toggleWakelock.addEventListener("change", () => {
    window.CameraCtl.wakeLockEnabled = els.toggleWakelock.checked;
    if (els.toggleWakelock.checked) {
      window.CameraCtl.requestWakeLock();
    } else {
      window.CameraCtl.releaseWakeLock();
    }
  });

  els.btnResetCal.addEventListener("click", () => {
    window.CalibrationCtl.reset();
    smoother.reset();
    dynamicXTracker.reset();
    updateCalStatusText();
    updateTareStatusText();
  });

  async function refreshSettingsScreen() {
    const state = await window.CameraCtl.queryPermissionState();
    const label = {
      granted: "Granted",
      denied: "Blocked — check browser site settings",
      prompt: "Not yet requested",
      "insecure-context": "Unavailable (needs HTTPS)",
      unsupported: "Not supported by this browser",
      unknown: cameraReady ? "Granted" : "Unknown — tap Check",
    }[state] || "Unknown";
    els.settingsPermissionStatus.textContent = label;
    updateCalStatusText();
    updateTareStatusText();
    refreshLensUI();
    els.settingsLevelStatus.textContent = settingsLevelStatusText();
    updateWeatherSettingsUI();
    els.settingsSnapshotStatus.textContent = settingsSnapshotStatusText();

    if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
      els.settingsOfflineStatus.textContent = "Ready — app works offline";
    } else if ("serviceWorker" in navigator) {
      els.settingsOfflineStatus.textContent = "Preparing offline cache…";
    } else {
      els.settingsOfflineStatus.textContent = "Not supported by this browser";
    }
  }

  window.addEventListener("online", () => els.offlineBadge.classList.add("hidden"));
  window.addEventListener("offline", () => els.offlineBadge.classList.remove("hidden"));

  // ---------- Boot ----------
  async function boot() {
    window.CalibrationCtl.load();
    window.CalibrationCtl.attach(els.calCanvas);
    els.toggleSnapshotOverlay.checked = snapshotOverlayEnabled();
    els.toggleZoom.checked = getZoomLevel() === 2;
    applyZoomToVideoEl();

    // Level: no-op prompt needed on Android/desktop, starts reading
    // immediately. On iOS it stays inactive until the widget/Settings
    // button is tapped (a user gesture is required to ask permission).
    window.LevelCtl.autoStart();
    els.levelWidget.title = levelTooltip();
    startLevelLoop();

    // Weather: only runs automatically if the user previously opted in;
    // otherwise it stays off until enabled from Settings.
    if (window.WeatherCtl.isEnabled()) {
      window.WeatherCtl.refresh().then(updateWeatherChip);
    }

    if ("serviceWorker" in navigator) {
      try {
        await navigator.serviceWorker.register("service-worker.js");
      } catch (e) { /* offline support degrades gracefully */ }
    }

    const state = await refreshPermissionUI();
    if (state === "granted") {
      await attemptEnableCamera();
    } else {
      switchScreen("screen-permission");
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
