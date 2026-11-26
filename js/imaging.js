/**
 * PocketPDF Scanner — pure pixel-processing routines.
 * Shared by the main thread (fallback) and the Web Worker (js/worker.js).
 * Everything here works on raw RGBA Uint8ClampedArray buffers, no DOM/canvas needed.
 */
(function (root) {
  'use strict';

  function clamp255(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
  }

  /** Separable box blur on an RGBA buffer (alpha forced to 255). */
  function boxBlurRGBA(data, w, h, radius) {
    const tmp = new Uint8ClampedArray(data.length);
    const out = new Uint8ClampedArray(data.length);
    const diam = radius * 2 + 1;

    for (let y = 0; y < h; y++) {
      let r = 0, g = 0, b = 0;
      const row = y * w;
      for (let x = -radius; x <= radius; x++) {
        const i = (row + Math.max(0, Math.min(w - 1, x))) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2];
      }
      for (let x = 0; x < w; x++) {
        const o = (row + x) * 4;
        tmp[o] = r / diam; tmp[o + 1] = g / diam; tmp[o + 2] = b / diam; tmp[o + 3] = 255;
        const ia = (row + Math.min(w - 1, x + radius + 1)) * 4;
        const is = (row + Math.max(0, x - radius)) * 4;
        r += data[ia] - data[is];
        g += data[ia + 1] - data[is + 1];
        b += data[ia + 2] - data[is + 2];
      }
    }

    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let y = -radius; y <= radius; y++) {
        const i = (Math.max(0, Math.min(h - 1, y)) * w + x) * 4;
        r += tmp[i]; g += tmp[i + 1]; b += tmp[i + 2];
      }
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 4;
        out[o] = r / diam; out[o + 1] = g / diam; out[o + 2] = b / diam; out[o + 3] = 255;
        const ia = (Math.min(h - 1, y + radius + 1) * w + x) * 4;
        const is = (Math.max(0, y - radius) * w + x) * 4;
        r += tmp[ia] - tmp[is];
        g += tmp[ia + 1] - tmp[is + 1];
        b += tmp[ia + 2] - tmp[is + 2];
      }
    }
    return out;
  }

  /**
   * Per-channel max filter (morphological dilation of the bright paper).
   * Removes ink from the background estimate so bold headings / stamps don't wash out.
   */
  function maxFilterRGB(src, w, h, r) {
    const out = new Uint8ClampedArray(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let mr = 0, mg = 0, mb = 0;
        for (let dy = -r; dy <= r; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -r; dx <= r; dx++) {
            const i = (yy * w + Math.min(w - 1, Math.max(0, x + dx))) * 4;
            if (src[i] > mr) mr = src[i];
            if (src[i + 1] > mg) mg = src[i + 1];
            if (src[i + 2] > mb) mb = src[i + 2];
          }
        }
        const o = (y * w + x) * 4;
        out[o] = mr; out[o + 1] = mg; out[o + 2] = mb; out[o + 3] = 255;
      }
    }
    return out;
  }

  /** Area-average downscale of an RGBA buffer to bw x bh. */
  function downscale(d, w, h, bw, bh) {
    const sums = new Float64Array(bw * bh * 3);
    const counts = new Uint32Array(bw * bh);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(bh - 1, ((y * bh) / h) | 0);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(bw - 1, ((x * bw) / w) | 0);
        const i = (y * w + x) * 4;
        const k = sy * bw + sx;
        sums[k * 3] += d[i];
        sums[k * 3 + 1] += d[i + 1];
        sums[k * 3 + 2] += d[i + 2];
        counts[k]++;
      }
    }
    const out = new Uint8ClampedArray(bw * bh * 4);
    for (let k = 0; k < bw * bh; k++) {
      const c = counts[k] || 1;
      out[k * 4] = sums[k * 3] / c;
      out[k * 4 + 1] = sums[k * 3 + 1] / c;
      out[k * 4 + 2] = sums[k * 3 + 2] / c;
      out[k * 4 + 3] = 255;
    }
    return out;
  }

  /** Builds bilinear sampling tables for upscaling a length-n axis from a length-m grid. */
  function axisTable(n, m) {
    const i0 = new Int32Array(n);
    const i1 = new Int32Array(n);
    const f = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      let s = ((p + 0.5) * m) / n - 0.5;
      if (s < 0) s = 0;
      if (s > m - 1) s = m - 1;
      const a = s | 0;
      i0[p] = a;
      i1[p] = Math.min(m - 1, a + 1);
      f[p] = s - a;
    }
    return { i0, i1, f };
  }

  function magicColor(d, w, h) {
    const bgScale = Math.min(1, 96 / Math.max(w, h));
    const bw = Math.max(24, Math.round(w * bgScale));
    const bh = Math.max(24, Math.round(h * bgScale));

    let bg = downscale(d, w, h, bw, bh);
    bg = maxFilterRGB(bg, bw, bh, 3);
    bg = boxBlurRGBA(bg, bw, bh, 4);
    bg = boxBlurRGBA(bg, bw, bh, 4);

    const xt = axisTable(w, bw);
    const yt = axisTable(h, bh);

    for (let y = 0; y < h; y++) {
      const r0 = yt.i0[y] * bw;
      const r1 = yt.i1[y] * bw;
      const fy = yt.f[y];
      for (let x = 0; x < w; x++) {
        const fx = xt.f[x];
        const a = (r0 + xt.i0[x]) * 4;
        const b = (r0 + xt.i1[x]) * 4;
        const c = (r1 + xt.i0[x]) * 4;
        const e = (r1 + xt.i1[x]) * 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const bgR = bg[a] * w00 + bg[b] * w10 + bg[c] * w01 + bg[e] * w11;
        const bgG = bg[a + 1] * w00 + bg[b + 1] * w10 + bg[c + 1] * w01 + bg[e + 1] * w11;
        const bgB = bg[a + 2] * w00 + bg[b + 2] * w10 + bg[c + 2] * w01 + bg[e + 2] * w11;

        const i = (y * w + x) * 4;
        let r = (d[i] / Math.max(20, bgR)) * 255;
        let g = (d[i + 1] / Math.max(20, bgG)) * 255;
        let bl = (d[i + 2] / Math.max(20, bgB)) * 255;

        // White-point stretch so shadowed paper becomes clean white
        r = ((r - 18) * 255) / 218;
        g = ((g - 18) * 255) / 218;
        bl = ((bl - 18) * 255) / 218;

        // Gentle saturation boost for coloured ink / stamps
        const lum = 0.299 * r + 0.587 * g + 0.114 * bl;
        d[i] = clamp255(lum + (r - lum) * 1.22);
        d[i + 1] = clamp255(lum + (g - lum) * 1.22);
        d[i + 2] = clamp255(lum + (bl - lum) * 1.22);
      }
    }
  }

  /** Bradley–Roth adaptive threshold via integral image. */
  function crispBW(d, w, h) {
    const len = w * h;
    const gray = new Uint8Array(len);
    for (let i = 0, p = 0; p < len; i += 4, p++) {
      gray[p] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
    }
    const stride = w + 1;
    const integral = new Float64Array(stride * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      const gRow = y * w, iRow = (y + 1) * stride, prevRow = y * stride;
      for (let x = 0; x < w; x++) {
        rowSum += gray[gRow + x];
        integral[iRow + x + 1] = integral[prevRow + x + 1] + rowSum;
      }
    }
    const radius = Math.max(8, Math.round(Math.min(w, h) / 24));
    const t = 0.13;
    for (let y = 0; y < h; y++) {
      const y1 = Math.max(0, y - radius);
      const y2 = Math.min(h - 1, y + radius);
      const row1 = y1 * stride, row2 = (y2 + 1) * stride;
      for (let x = 0; x < w; x++) {
        const x1 = Math.max(0, x - radius);
        const x2 = Math.min(w - 1, x + radius);
        const count = (x2 - x1 + 1) * (y2 - y1 + 1);
        const sum = integral[row2 + x2 + 1] - integral[row1 + x2 + 1] - integral[row2 + x1] + integral[row1 + x1];
        const val = gray[y * w + x];
        const isInk = val * count < sum * (1 - t) && sum / count - val > 10;
        const out = isInk ? 18 : 255;
        const idx = (y * w + x) * 4;
        d[idx] = out; d[idx + 1] = out; d[idx + 2] = out;
      }
    }
  }

  /** Luminance + 2nd/94th percentile stretch. */
  function grayscale(d, w, h) {
    const len = w * h;
    const hist = new Int32Array(256);
    const lums = new Uint8Array(len);
    for (let i = 0, p = 0; p < len; i += 4, p++) {
      const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
      lums[p] = l;
      hist[l]++;
    }
    let low = -1, high = 255, acc = 0;
    const lowCut = len * 0.02;
    const highCut = len * 0.94;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (low < 0 && acc >= lowCut) low = i;
      if (acc >= highCut) { high = i; break; }
    }
    low = Math.max(0, low);
    const range = Math.max(20, high - low);
    for (let i = 0, p = 0; p < len; i += 4, p++) {
      const v = clamp255(((lums[p] - low) * 255) / range);
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
  }

  function lighten(d) {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.pow(i / 255, 0.72) * 265 + 6;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]];
    }
  }

  function adjust(d, brightness, contrast) {
    if (!brightness && !contrast) return;
    const bOff = brightness * 2.2;
    const cVal = contrast * 2.55;
    const cFactor = (259 * (cVal + 255)) / (255 * (259 - cVal));
    for (let i = 0; i < d.length; i += 4) {
      d[i] = clamp255(cFactor * (d[i] - 128) + 128 + bOff);
      d[i + 1] = clamp255(cFactor * (d[i + 1] - 128) + 128 + bOff);
      d[i + 2] = clamp255(cFactor * (d[i + 2] - 128) + 128 + bOff);
    }
  }

  /** Applies a filter preset + brightness/contrast in place. */
  function filter(d, w, h, type, brightness, contrast) {
    if (type === 'magic') magicColor(d, w, h);
    else if (type === 'bw') crispBW(d, w, h);
    else if (type === 'grayscale') grayscale(d, w, h);
    else if (type === 'lighten') lighten(d);
    adjust(d, brightness || 0, contrast || 0);
    for (let i = 3; i < d.length; i += 4) d[i] = 255;
    return d;
  }

  /** Solves the 8x8 system for the homography mapping dstPts -> srcPts. */
  function solveHomography(dstPts, srcPts) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const u = dstPts[i].x, v = dstPts[i].y, x = srcPts[i].x, y = srcPts[i].y;
      A.push([u, v, 1, 0, 0, 0, -x * u, -x * v]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -y * u, -y * v]); b.push(y);
    }
    const n = 8;
    for (let i = 0; i < n; i++) {
      let maxRow = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[maxRow][i])) maxRow = r;
      [A[i], A[maxRow]] = [A[maxRow], A[i]];
      [b[i], b[maxRow]] = [b[maxRow], b[i]];
      const pivot = A[i][i] || 1e-12;
      for (let c = i; c < n; c++) A[i][c] /= pivot;
      b[i] /= pivot;
      for (let r = 0; r < n; r++) {
        if (r === i) continue;
        const factor = A[r][i];
        for (let c = i; c < n; c++) A[r][c] -= factor * A[i][c];
        b[r] -= factor * b[i];
      }
    }
    return b;
  }

  /** Inverse-homography perspective warp with bilinear sampling. Returns RGBA buffer outW x outH. */
  function dewarp(src, sw, sh, srcPts, outW, outH) {
    const dstPts = [
      { x: 0, y: 0 }, { x: outW - 1, y: 0 }, { x: outW - 1, y: outH - 1 }, { x: 0, y: outH - 1 },
    ];
    const [h0, h1, h2, h3, h4, h5, h6, h7] = solveHomography(dstPts, srcPts);
    const dst = new Uint8ClampedArray(outW * outH * 4);

    for (let v = 0; v < outH; v++) {
      const rowBase = v * outW * 4;
      for (let u = 0; u < outW; u++) {
        const denom = h6 * u + h7 * v + 1;
        const sx = (h0 * u + h1 * v + h2) / denom;
        const sy = (h3 * u + h4 * v + h5) / denom;
        const idx = rowBase + u * 4;
        if (sx >= 0 && sx < sw - 1 && sy >= 0 && sy < sh - 1) {
          const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
          const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
          const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
          dst[idx] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
          dst[idx + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
          dst[idx + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
        } else {
          dst[idx] = 255; dst[idx + 1] = 255; dst[idx + 2] = 255;
        }
        dst[idx + 3] = 255;
      }
    }
    return dst;
  }

  root.Imaging = { filter, dewarp, boxBlurRGBA, maxFilterRGB };
})(typeof self !== 'undefined' ? self : this);
