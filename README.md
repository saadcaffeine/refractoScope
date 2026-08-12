# refractoScope

**Version 0.2.0**

A camera-based Salinity% reader for analog optical refractometers (the kind with a blue/dark region over a bright region and a 0-100% scale printed down the middle). Point your phone's camera at the eyepiece and refractoScope tracks the blue/bright interface line live and converts its position to a Salinity% reading — no lab equipment, no network connection, all processing happens on-device.

## How it works

- **Detection**: for each frame, a vertical strip is sampled inside a detection window, and refractoScope measures brightness row by row, smooths it, and finds the row with the sharpest brightness change — that's the blue/bright interface line. This works whether the transition is a crisp edge or a soft gradient (validated against real refractometer photos).
- **Calibration**: because every phone/scope/zoom combination frames the scale differently, you do a one-time calibration: drag a box's handles onto two known tick marks on the scale (e.g. the "100" and "0" Salinity ticks) and confirm their values. This is saved on-device and reused on future visits. Every alignment line on the calibration screen — the box outline, the padded sampling window, the sample-strip guides — is dashed so you can see the physical scale ticks underneath while you line things up, and the value labels sit off to the right of the box rather than on top of the scale, out of the way.
- **Buffer zone below the low tick**: the box you calibrate is the *value reference*, but the actual sampling window is padded automatically — mostly downward, into the label area below the "0" tick — so a reading near the low end of the scale still has bright rows on both sides of the transition to detect against. Without this, a true reading right at (or just past) your calibrated "0" position can fall outside the sampled area entirely and simply fail to register. The calibration screen shows this padded area as a dashed outline around your solid calibration box. This buffer is intentionally small (enough to catch the transition, not so much that it reaches the refractometer's own curved body edge and mistakes it for the scale) — for the most accurate zero, use Tare instead of relying on this margin.
- **Tare (precise zero)**: dragging the calibration box's low handle is a coarse, by-eye way to mark "0" — good enough to get going, but it's still a guess at where the scale's 0 print actually sits. **Tare** replaces that guess with a real measurement: load the refractometer with a known 0% sample (distilled water is the standard reference), then tap the pill-shaped **Tare** button at the bottom-left of the Live view while the reading is stable. refractoScope records the exact detected row as the true zero and uses it — instead of the dragged box edge — as the zero anchor for all future readings, independent of the detection window's scale calibration. Tare is disabled while the detection confidence is poor, and clearing it (Settings → Zero point) reverts to the dragged calibration edge. Saving a new box calibration clears any existing Tare, since a changed detection window invalidates the old measured zero.
- **Horizontal auto-centering**: at the moment you save a calibration, refractoScope also detects the scope's left/right edges (the sharp dark-vignette-to-bright-interior boundary) and stores your box's x-bounds as fractions relative to that scope width instead of a fixed frame position. On the Live tab, it re-detects those edges every frame and re-centers the detection window to match — so minor hand vibration or drift doesn't require you to hold the phone perfectly still. This is confidence-gated: if the edges can't be found reliably in a given frame (e.g. poor contrast), it holds the last known-good position rather than guessing.
- **No OpenCV/WASM**: detection is plain Canvas `ImageData` math, which keeps the whole app lightweight and trivially cacheable for offline use — no multi-megabyte CV library to download or bundle.
- **2× zoom**: an optional digital zoom (**Settings → 2× zoom**) crops in around the center of the frame for a closer view of the scale, useful on phones held further back or with scales that read small. The same crop is applied consistently to the live video display, the calibration screen, the detector, and snapshots, so the guide box and detected line stay correctly aligned at either zoom level — a fractional box coordinate (like "dead center") always points at the same physical spot on the scale regardless of zoom. Changing zoom shifts what's framed, though, so recalibrate afterward for best accuracy.

## Requirements this app meets

- **Offline-capable PWA**: a service worker precaches the entire app shell (HTML/CSS/JS/icons) on first load. After that, refractoScope works with airplane mode on — camera capture and Salinity detection never touch the network.
- **Mobile stability (iOS & Android)**: `playsinline`/`muted` attributes for reliable inline autoplay on iOS Safari; the camera stream is re-acquired automatically if the OS suspends it when the app is backgrounded (common on iOS); Wake Lock keeps the screen from sleeping mid-read; layout uses safe-area insets for notches/home indicators.
- **Permission handling**: an explicit "Enable camera" gate on first use (not a silent auto-prompt), live permission-state checking via the Permissions API where supported (Android Chrome) with a manual fallback for browsers that don't support it (iOS Safari), and clear recovery instructions if access was blocked. A Settings screen lets you re-check permission status any time.
- **Multi-lens support**: on top of the front/back camera switch, phones with multiple rear lenses (main / ultra-wide / telephoto / macro) get a **Lens** picker in Settings. It only appears when more than one lens is detected for the active facing, labels each one from its device name where possible ("Ultra Wide", "Telephoto", etc., falling back to "Lens 1/2/3…"), and remembers your choice per facing across sessions.

## Level indicator & local weather

The header's second icon is a mini digital plumb level — a small bubble that tracks device tilt via `DeviceOrientationEvent`, useful for holding the phone steady and square to the eyepiece. It works immediately on Android/desktop (no prompt required); on iOS 13+, tap it once (or use **Settings → Motion & orientation**) to grant the motion-permission prompt Apple requires.

If you enable **Settings → Local weather**, refractoScope asks for your location once, then shows today's ambient temperature range as a small chip next to the app name (e.g. "18°–24°C"), sourced from the free, key-less [Open-Meteo](https://open-meteo.com) API. It's off by default, only looks up location when you turn it on, caches the result for 2 hours to avoid repeat lookups, and fails silently (chip just stays hidden) if you're offline or deny location access — it never blocks or breaks the core Salinity-reading functionality.

## Snapshots

The circular button between the reading and the confidence indicator on the Live tab saves a still image of the current view — via your device's native share sheet where available ("Save to Photos"), or a direct download otherwise. **Settings → Include overlay in snapshot** (on by default) burns in the guide box, the detected interface line, the Salinity% reading, and a small metadata block in the bottom-left corner with whatever of the following the browser can actually provide:

- **Device**: a real model name on Android (via User-Agent Client Hints), a coarse platform guess elsewhere (e.g. "iPhone", "Mac") — browsers don't expose true device models for privacy reasons, so this is best-effort.
- **Resolution & lens**: read directly from the active camera track and the same lens-detection data used by the Lens picker.
- **ISO**: only present on the rare browser/device combination that exposes it (no standard web API guarantees this — it's almost always omitted).
- **Location**: reuses the coordinates from the opt-in weather lookup above, if you've enabled it — snapshots never trigger their own separate location request.

Any field that can't be determined is simply left out rather than shown as blank or "unknown."

## Running it

Camera access requires a **secure context** — `https://` or `http://localhost`. Two easy options:

**Quick local test (same machine):**
```
cd refractoScope
python3 -m http.server 8080
```
Open `http://localhost:8080` in a desktop browser to sanity-check the UI (camera permission prompt, screens, calibration drag handles).

**On an actual phone:** you need HTTPS. The simplest path is deploying the folder as-is to any static host — GitHub Pages, Netlify, Vercel, Cloudflare Pages all work with zero configuration since this is a plain static site. Then open the HTTPS URL on your phone and use "Add to Home Screen" (Safari share sheet on iOS, or the install prompt on Android Chrome) to install it as a standalone app.

## Using it

1. Open the app, tap **Enable camera**, allow access.
2. Point the camera at the refractometer eyepiece so the scale fills the frame (steady, well-lit).
3. Go to the **Calibrate** tab. Drag the box's top/bottom handles onto two ticks you can clearly see (defaults to 100 and 0), narrow the left/right handles so the box sits just around the tick marks (not the printed numbers), and set the corresponding values in the two fields — the value labels sit off to the right of the box so they don't cover the ticks you're aligning against. Every line on this screen is dashed for the same reason. The dashed outline around the box is the padded area actually sampled — that's expected, not a mistake.
4. Tap **Save calibration**. Back on the **Live** tab, the Salinity% reading updates automatically as you swap samples under the scope, and the guide box will visibly shift a little to track minor hand movement — no need to re-calibrate unless you change how you're holding the phone or switch lenses.
5. For the most accurate zero, load a 0% sample (e.g. distilled water), wait for a stable/good-confidence reading, and tap **Tare** at the bottom-left of the Live view. A green dashed line marks the tared zero going forward, replacing the coarse dragged "0" edge. Re-tare any time, or clear it from **Settings → Zero point**.
6. If the scale reads small in frame, enable **Settings → 2× zoom** for a closer digital crop, then recalibrate — a "2×" badge appears on the Live view as a reminder that zoom is active.

## Files

```
index.html          app shell / screens
manifest.json        PWA metadata
service-worker.js    offline cache-first strategy
css/style.css        styling
js/camera.js          getUserMedia, permissions, wake lock, torch, lens picker, backgrounding recovery
js/detector.js        brightness-boundary detection + row-to-Salinity% mapping + temporal smoothing
js/calibration.js     draggable calibration box, persisted to localStorage
js/level.js            device-tilt plumb level (DeviceOrientationEvent)
js/weather.js          opt-in geolocation + Open-Meteo daily temperature range
js/app.js             screen wiring, detection loop, rendering
icons/                app icons
```

## Changelog

- **v0.2.0** — Switched the scale from Brix% to Salinity% (0-100 range; new calibration defaults, dropped the Brix-only SG estimate). Added an optional 2× digital zoom (Settings), applied consistently across the live view, calibration, detection, and snapshots. Improved calibration-screen legibility: every alignment line is now dashed and value labels moved off to the right of the box so they no longer sit on top of the scale ticks. Added the Tare button (physically zero against a 0% sample) and a smaller, more precise detection buffer. Added horizontal auto-centering so the detection window tracks minor hand movement.
- **v0.1.0** — Initial release: live camera Brix% reader with offline PWA support, calibration, front/back + multi-lens camera switching, digital plumb level, opt-in local weather, and snapshot capture with metadata overlay.
