'use strict';

const esbuild = require('esbuild');
const path = require('path');

const root = path.resolve(__dirname, '..');

esbuild.build({
  entryPoints: [path.join(root, 'scripts/admin-face-liveness-entry.jsx')],
  outfile: path.join(root, 'public/js/admin-face-liveness.mjs'),
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: false,
  legalComments: 'none',
  loader: {
    '.wasm': 'file',
    '.png': 'file',
    '.jpg': 'file',
    '.svg': 'file',
  },
  assetNames: 'assets/[name]-[hash]',
  logLevel: 'info',
}).catch((error) => {
  console.error('Could not build the admin face liveness bundle.');
  process.exitCode = 1;
});
