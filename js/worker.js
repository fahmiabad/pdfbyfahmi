/* PocketPDF Scanner — background image-processing worker (keeps the UI responsive). */
importScripts('imaging.js');

self.onmessage = (e) => {
  const { id, op, args } = e.data || {};
  try {
    if (op === 'filter') {
      const d = new Uint8ClampedArray(args.buffer);
      self.Imaging.filter(d, args.w, args.h, args.filter, args.brightness, args.contrast);
      self.postMessage({ id, ok: true, result: { buffer: d.buffer } }, [d.buffer]);
    } else if (op === 'dewarp') {
      const out = self.Imaging.dewarp(
        new Uint8ClampedArray(args.buffer), args.sw, args.sh, args.pts, args.outW, args.outH
      );
      self.postMessage({ id, ok: true, result: { buffer: out.buffer } }, [out.buffer]);
    } else {
      throw new Error('Unknown op: ' + op);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
