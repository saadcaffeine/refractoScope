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
    btnPermissionsTop: $("btn-permissions"),
    btnSettingsTop: $("btn-settings"),
    brixValue: $("brix-value"),
    sgValue: $("sg-value"),
    confidenceDot: $("confidence-dot"),
    confidenceLabel: $("confidence-label"),
    offlineBadge: $("offline-badge"),
    stabilityBadge: $("stability-badge"),
    btnTorch: $("btn-torch"),
    calTopValue: $("cal-top-value"),
    calBottomValue: $("cal-bottom-value"),
    btnCalCancel: $("btn-cal-cancel"),
    btnCalSave: $("btn-cal-save"),
    settingsPermissionStatus: $("settings-permission-status"),
    btnSettingsPermission: $("btn-settings-permission"),
    settingsCalStatus: $("settings-cal-status"),
    btnSettingsCalibrate: $("btn-settings-calibrate"),
    btnSwitchCamera: $("btn-switch-camera"),
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

  let activeScreen = "screen-live";
  let lastTick = null; // { rowFrac, contrast, value, sg, confidence }
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
  els.btnPermissionsTop.addEventListener("click", () => switchScreen("screen-settings"));
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

  // ---------- Cover-fit drawing helper ----------
  function getCoverSourceRect(video, containerAspect) {
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
    return { sx, sy, sw, sh };
  }

  function drawVideoCover(ctx, video, destW, destH) {
    if (!video.videoWidth) return false;
    const { sx, sy, sw, sh } = getCoverSourceRect(video, destW / destH);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, destW, destH);
    return true;
  }

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

    if (!drawVideoCover(analysisCtx, els.video, ANALYSIS_WIDTH, ANALYSIS_HEIGHT)) return;
    let imageData;
    try {
      imageData = analysisCtx.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    } catch (e) {
      return; // canvas tainted or not ready
    }

    const box = window.CalibrationCtl.box;
    const result = window.Detector.analyzeFrame(imageData, ANALYSIS_WIDTH, ANALYSIS_HEIGHT, box);
    if (!result.ok) return;

    const { top, bottom } = window.CalibrationCtl.values;
    const rawValue = window.Detector.rowFracToValue(result.rowFrac, top, bottom);
    const conf = classifyConfidence(result.contrast);
    const confNum = conf.level === "good" ? 1 : conf.level === "warn" ? 0.5 : 0;

    const smoothed = smoother.push(rawValue, confNum);

    lastTick = {
      rowFrac: result.rowFrac,
      contrast: result.contrast,
      rawValue,
      value: smoothed.value,
      sg: window.Detector.brixToSG(smoothed.value),
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

    const b = window.CalibrationCtl.box;
    const x0 = b.x0 * cssW, x1 = b.x1 * cssW;
    const y0 = b.y0 * cssH, y1 = b.y1 * cssH;

    ctx.strokeStyle = "rgba(76,141,255,0.55)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);

    const lineY = y0 + lastTick.rowFrac * (y1 - y0);
    ctx.strokeStyle = lastTick.confLevel === "bad" ? "rgba(255,91,110,0.9)" : "#ff5b6e";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x0, lineY);
    ctx.lineTo(x1, lineY);
    ctx.stroke();

    if (lastTick.confLevel === "bad") {
      els.brixValue.textContent = "--.-";
      els.sgValue.textContent = "--";
    } else {
      els.brixValue.textContent = lastTick.value.toFixed(1);
      els.sgValue.textContent = lastTick.sg.toFixed(3);
    }

    els.confidenceDot.className = "dot " + lastTick.confLevel;
    els.confidenceLabel.textContent = lastTick.confLabel;
    els.stabilityBadge.classList.toggle("hidden", lastTick.confLevel !== "warn");

    els.offlineBadge.classList.toggle("hidden", navigator.onLine !== false);
  }

  // ---------- Calibration screen rendering ----------
  function startCalRenderLoop() {
    if (calRafId) return;
    const loop = () => {
      if (activeScreen !== "screen-calibrate") { calRafId = null; return; }
      const { ctx, cssW, cssH } = resizeCanvasToContainer(els.calCanvas);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cssW, cssH);
      drawVideoCover(ctx, els.video, cssW, cssH);

      window.CalibrationCtl.drawOverlay(ctx, cssW, cssH);

      if (lastTick) {
        const b = window.CalibrationCtl.box;
        const y0 = b.y0 * cssH, y1 = b.y1 * cssH;
        const x0 = b.x0 * cssW, x1 = b.x1 * cssW;
        const lineY = y0 + lastTick.rowFrac * (y1 - y0);
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

  els.btnCalCancel.addEventListener("click", () => {
    window.CalibrationCtl.load(); // discard unsaved edits, revert to last saved (or defaults)
    switchScreen("screen-live");
  });
  els.btnCalSave.addEventListener("click", () => {
    window.CalibrationCtl.save();
    smoother.reset();
    switchScreen("screen-live");
  });

  function updateCalStatusText() {
    els.settingsCalStatus.textContent = window.CalibrationCtl.isCalibrated()
      ? `Calibrated (${window.CalibrationCtl.values.bottom}–${window.CalibrationCtl.values.top} °Bx)`
      : "Not calibrated — using defaults";
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
    setupTorchButton();
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
    updateCalStatusText();
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
