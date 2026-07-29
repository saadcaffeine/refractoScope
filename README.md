# refractoScope

A camera-based Brix% reader for analog optical refractometers (the kind with a blue/dark region over a bright region and a scale printed down the middle). Point your phone's camera at the eyepiece and refractoScope tracks the blue/bright interface line live and converts its position to a Brix% (and estimated SG) reading — no lab equipment, no network connection, all processing happens on-device.

## How it works

- **Detection**: for each frame, a vertical strip is sampled inside a calibrated region of the image. refractoScope measures brightness row by row, smooths it, and finds the row with the sharpest brightness change — that's the blue/bright interface line. This works whether the transition is a crisp edge or a soft gradient (validated against 10 real refractometer photos).
- **Calibration**: because every phone/scope/zoom combination frames the scale differently, you do a one-time calibration: drag a box's handles onto two known tick marks on the scale (e.g. the "30" and "0" Brix ticks) and confirm their values. This is saved on-device and reused on future visits.
- **No OpenCV/WASM**: detection is plain Canvas `ImageData` math (~150 lines), which keeps the whole app under 50KB and trivially cacheable for offline use — no multi-megabyte CV library to download or bundle.

## Requirements this app meets

- **Offline-capable PWA**: a service worker precaches the entire app shell (HTML/CSS/JS/icons) on first load. After that, refractoScope works with airplane mode on — camera capture and Brix detection never touch the network.
- **Mobile stability (iOS & Android)**: `playsinline`/`muted` attributes for reliable inline autoplay on iOS Safari; the camera stream is re-acquired automatically if the OS suspends it when the app is backgrounded (common on iOS); Wake Lock keeps the screen from sleeping mid-read; layout uses safe-area insets for notches/home indicators.
- **Permission handling**: an explicit "Enable camera" gate on first use (not a silent auto-prompt), live permission-state checking via the Permissions API where supported (Android Chrome) with a manual fallback for browsers that don't support it (iOS Safari), and clear recovery instructions if access was blocked. A Settings screen lets you re-check permission status any time.
- **Multi-lens support**: on top of the front/back camera switch, phones with multiple rear lenses (main / ultra-wide / telephoto / macro) get a **Lens** picker in Settings. It only appears when more than one lens is detected for the active facing, labels each one from its device name where possible ("Ultra Wide", "Telephoto", etc., falling back to "Lens 1/2/3…"), and remembers your choice per facing across sessions.

## Level indicator & local weather

The header's second icon is a mini digital plumb level — a small bubble that tracks device tilt via `DeviceOrientationEvent`, useful for holding the phone steady and square to the eyepiece. It works immediately on Android/desktop (no prompt required); on iOS 13+, tap it once (or use **Settings → Motion & orientation**) to grant the motion-permission prompt Apple requires.

If you enable **Settings → Local weather**, refractoScope asks for your location once, then shows today's ambient temperature range as a small chip next to the app name (e.g. "18°–24°C"), sourced from the free, key-less [Open-Meteo](https://open-meteo.com) API. It's off by default, only looks up location when you turn it on, caches the result for 2 hours to avoid repeat lookups, and fails silently (chip just stays hidden) if you're offline or deny location access — it never blocks or breaks the core Brix-reading functionality.

## Snapshots

The circular button between the reading and the confidence indicator on the Live tab saves a still image of the current view — via your device's native share sheet where available ("Save to Photos"), or a direct download otherwise. **Settings → Include overlay in snapshot** (on by default) burns in the guide box, the detected interface line, the Brix%/SG reading, and a small metadata block in the bottom-left corner with whatever of the following the browser can actually provide:

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
3. Go to the **Calibrate** tab. Drag the box's top/bottom handles onto two ticks you can clearly see (defaults to 30 and 0), narrow the left/right handles so the box sits just around the tick marks (not the printed numbers), and set the corresponding values in the two fields.
4. Tap **Save calibration**. Back on the **Live** tab, the Brix% reading updates automatically as you swap samples under the scope — no need to re-calibrate unless you change how you're holding the phone.

## Files

```
index.html          app shell / screens
manifest.json        PWA metadata
service-worker.js    offline cache-first strategy
css/style.css        styling
js/camera.js          getUserMedia, permissions, wake lock, torch, lens picker, backgrounding recovery
js/detector.js        brightness-boundary detection + Brix->SG conversion + temporal smoothing
js/calibration.js     draggable calibration box, persisted to localStorage
js/level.js            device-tilt plumb level (DeviceOrientationEvent)
js/weather.js          opt-in geolocation + Open-Meteo daily temperature range
js/app.js             screen wiring, detection loop, rendering
icons/                app icons
```
