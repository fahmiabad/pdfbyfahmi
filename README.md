# PocketPDF Scanner

A private document scanner that runs in the browser. Photos never leave the device: cropping, clean-up and PDF creation all happen on the phone, and the app works offline once it has loaded.

## Hosting (any static host)

Upload **the contents of this folder** as they are. No build step is needed.

It must be served over **HTTPS**, which camera capture, offline mode and "Add to Home Screen" all require. Every host below gives you HTTPS automatically.

### GitHub Pages
1. Create a new repository, e.g. `pocketpdf`.
2. Upload everything in this folder (keep the `vendor/`, `js/`, `css/` and `icons/` folders, and the `.nojekyll` file).
3. Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)` → Save.
4. After a minute the app is live at `https://<username>.github.io/pocketpdf/`.

### Netlify / Cloudflare Pages
Drag this folder onto Netlify Drop (app.netlify.com/drop), or connect the repo in Cloudflare Pages with no build command and output directory `/`.

## Folder layout
```
index.html             App page
css/app.css            Pre-built Tailwind styles (no CDN)
js/app.js              App logic
js/imaging.js          Image filters + perspective warp (pure JS)
js/worker.js           Background worker that runs imaging.js off the main thread
sw.js                  Service worker (offline support)
manifest.webmanifest   Install-to-home-screen metadata
icons/                 App icons
vendor/                Self-hosted libraries: jsPDF, OpenCV.js, heic2any, SortableJS
```

## Updating the app
After you change any file, bump `VERSION` at the top of `sw.js` (e.g. `v1.0.1`). Users then see a "new version is ready → Reload" prompt.
If you replace anything in `vendor/`, also bump `LIB_CACHE`.

## Testing locally
```
python3 -m http.server 8000
```
Then open http://localhost:8000. The service worker also runs on localhost. Opening `index.html` directly as a file works too, just without offline support or the background worker.

## Notes
- OpenCV (~10 MB) loads only the first time someone scans, then stays cached for offline use.
- Pages are saved in the browser's IndexedDB, so they survive a reload or the phone closing the tab. "Clear All" erases them.
- Libraries: jsPDF (MIT), OpenCV.js (Apache 2.0), heic2any (MIT), SortableJS (MIT).
