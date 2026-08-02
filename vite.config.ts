import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteCommonjs } from '@originjs/vite-plugin-commonjs';

// GitHub Pages serves project sites at /<repo-name>/. Build with that base
// only inside CI so local dev (`vite`) keeps serving from `/`.
const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';
const repoName = 'DICOMassist';

export default defineConfig({
  base: isGitHubActions ? `/${repoName}/` : '/',
  plugins: [
    react(),
    tailwindcss(),
    viteCommonjs(),
  ],
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: [
      'dicom-parser',
      // Force esbuild to pre-bundle i18next + react-i18next together with
      // react so the CJS↔ESM interop is resolved correctly. Without this,
      // Vite serves react-i18next as source while react is pre-bundled,
      // and the React reference inside react-i18next becomes null at runtime
      // ("Cannot read properties of null (reading 'useContext')").
      'i18next',
      'react-i18next',
      'react',
      'react-dom',
    ],
  },
  worker: {
    format: 'es',
  },
  assetsInclude: ['**/*.wasm'],
});
