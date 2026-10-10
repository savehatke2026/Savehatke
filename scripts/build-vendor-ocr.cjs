#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   build-vendor-ocr.cjs — rebuild the sell page's vendored PaddleOCR bundle
   ══════════════════════════════════════════════════════════════════════════
   The sell page has no bundler, so the official @paddleocr/paddleocr-js SDK
   is bundled ONCE (here) into public/vendor/paddleocr/paddleocr.bundle.mjs
   and served same-origin, together with the matching ONNX Runtime wasm
   binary. Re-run after bumping the SDK version:

       npm run build:vendor-ocr

   Notes:
   • --alias:fs/--alias:path stub out the Node-only requires inside the
     OpenCV.js emscripten build; the browser branch never executes them.
   • --alias:onnxruntime-web pins the SDK's ORT import to the wasm-ONLY
     build (dist/ort.wasm.min.mjs): no WebGPU/jsep code, so the runtime
     needs exactly ort-wasm-simd-threaded.mjs (glue) + ort-wasm-simd-threaded.wasm
     from wasmPaths — both copied below. The default full build would drag
     in the 27 MB jsep binary instead.
   • backend "wasm" (pinned in public/js/coupon-ocr.js) only ever loads
     those two files.
   • The PP-OCRv5 English model tars are NOT vendored — the SDK downloads
     them from Paddle's official host on the first scan.
   ══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'vendor', 'paddleocr');
const SDK_ENTRY = path.join(ROOT, 'node_modules', '@paddleocr', 'paddleocr-js', 'dist', 'index.mjs');
const ORT_WASM_BUILD = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', 'ort.wasm.min.mjs');
const ORT_WASM = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm');
const ORT_GLUE = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.mjs');

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const shim = path.join(os.tmpdir(), 'paddleocr-empty-shim.js');
  fs.writeFileSync(shim, 'export default {};\n');

  await esbuild.build({
    entryPoints: [SDK_ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: path.join(OUT_DIR, 'paddleocr.bundle.mjs'),
    alias: {
      fs: shim,
      path: shim,
      'onnxruntime-web': ORT_WASM_BUILD,
    },
    logLevel: 'warning',
  });

  fs.copyFileSync(ORT_WASM, path.join(OUT_DIR, 'ort-wasm-simd-threaded.wasm'));
  fs.copyFileSync(ORT_GLUE, path.join(OUT_DIR, 'ort-wasm-simd-threaded.mjs'));

  for (const f of ['paddleocr.bundle.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
    const st = fs.statSync(path.join(OUT_DIR, f));
    console.log(f + ' — ' + (st.size / 1048576).toFixed(1) + ' MB');
  }
  console.log('done.');
})().catch((e) => { console.error(e); process.exit(1); });
