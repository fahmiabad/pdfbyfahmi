#!/bin/sh
# Usage: ./set-version.sh v2.0.2
# Stamps one version into every file the offline copy checks, so phones never mix versions.
set -e
V="$1"
[ -z "$V" ] && { echo "usage: $0 vX.Y.Z"; exit 1; }
sed -i.bak -E "s/const VERSION = 'v[0-9.]+'/const VERSION = '$V'/" sw.js
sed -i.bak -E "s/const APP_VERSION = 'v[0-9.]+'/const APP_VERSION = '$V'/" js/app.js
sed -i.bak -E "s/<meta name=\"app-version\" content=\"v[0-9.]+\"/<meta name=\"app-version\" content=\"$V\"/" index.html
sed -i.bak -E "s#/\*! pocketpdf v[0-9.]+ \*/#/*! pocketpdf $V */#" css/app.css
rm -f sw.js.bak js/app.js.bak index.html.bak css/app.css.bak
grep -l "$V" sw.js js/app.js index.html css/app.css
