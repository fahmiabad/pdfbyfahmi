# Third-party notices

PocketPDF Scanner (by BigPharmi) includes the following third-party software. Each is redistributed unmodified under its own licence, included in full in this folder.

| Component | Used for | Licence | File in this app | Source |
|---|---|---|---|---|
| OpenCV.js 4.8.0 (@techstark/opencv-js build) | Page-edge detection, perspective correction | Apache License 2.0 — [opencv-Apache-2.0.txt](opencv-Apache-2.0.txt) | `vendor/opencv.js` | https://github.com/opencv/opencv |
| jsPDF 2.5.1 | PDF creation | MIT — [jspdf-MIT.txt](jspdf-MIT.txt) | `vendor/jspdf.umd.min.js` | https://github.com/parallax/jsPDF |
| heic2any 0.0.4 | Opening HEIC/HEIF photos | MIT — [heic2any-MIT.txt](heic2any-MIT.txt) | `vendor/heic2any.min.js` | https://github.com/alexcorvi/heic2any |
| libheif + libde265 (bundled inside heic2any) | HEIC decoding | GNU LGPL v3 — [libheif-LGPL-3.0.txt](libheif-LGPL-3.0.txt), which supplements the GNU GPL v3 — [GPL-3.0.txt](GPL-3.0.txt) | inside `vendor/heic2any.min.js` | https://github.com/strukturag/libheif, https://github.com/strukturag/libde265 |
| SortableJS 1.15.2 | Drag-to-reorder | MIT — [sortablejs-MIT.txt](sortablejs-MIT.txt) | `vendor/Sortable.min.js` | https://github.com/SortableJS/Sortable |
| Bricolage Grotesque | Headline font | SIL Open Font License 1.1 — [OFL-Bricolage-Grotesque.txt](OFL-Bricolage-Grotesque.txt) | `fonts/bricolage-grotesque-*.woff2` | https://github.com/ateliertriay/bricolage |
| Figtree | Interface font | SIL Open Font License 1.1 — [OFL-Figtree.txt](OFL-Figtree.txt) | `fonts/figtree-*.woff2` | https://github.com/erikdkennedy/figtree |

The LGPL-licensed decoder is loaded from its own separate file (`vendor/heic2any.min.js`) and can be replaced with a different or modified build without changing the rest of the app. Its corresponding source code is available at the links above.
