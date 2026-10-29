import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginSass } from '@rsbuild/plugin-sass';

export default defineConfig(({ envMode, command }) => ({
  // Build/watch для расширения не должен получать HMR runtime или пути dev-сервера.
  ...(command !== 'dev' ? {
    dev: { assetPrefix: './', hmr: false, liveReload: false },
  } : {}),
  resolve: { alias: { '@': './src' } },
  output: {
    assetPrefix: './',
    filenameHash: false,
    polyfill: 'off',
    overrideBrowserslist: ['Chrome >= 120'],
    sourceMap: { js: envMode === 'development' ? 'source-map' : false, css: false },
  },
  environments: {
    popup: {
      source: { entry: { popup: './src/app/main.tsx' } },
      plugins: [pluginReact(), pluginSass()],
      html: { template: './src/app/popup.html', title: 'MusicLoader' },
      output: { distPath: { root: 'dist' } },
    },
    background: {
      source: { entry: { background: './src/entrypoints/background/index.ts' } },
      output: {
        target: 'web-worker',
        distPath: { root: 'dist', js: 'background' },
      },
      server: { publicDir: false },
      splitChunks: false,
      tools: { rspack: { optimization: { runtimeChunk: false } } },
    },
    content: {
      source: { entry: { content: './src/entrypoints/content/index.ts' } },
      output: { distPath: { root: 'dist', js: 'content' } },
      server: { publicDir: false },
      splitChunks: false,
      tools: {
        htmlPlugin: false,
        rspack: { optimization: { runtimeChunk: false } },
      },
    },
  },
  server: { host: '127.0.0.1', port: 3000, strictPort: true },
}));
