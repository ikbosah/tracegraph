/**
 * Webpack config for the TraceGraph VS Code extension.
 *
 * - target: 'node'          — VS Code extensions run in Node, not a browser.
 * - externals: vscode       — The VS Code API is injected at runtime.
 * - library output: commonjs2 — Required by VS Code's extension host.
 * - @tracegraph/shared-types resolved via alias so types land at build time
 *   without needing a published package.
 */

'use strict';

const path = require('path');

/** @type {import('webpack').Configuration} */
const config = {
  target:  'node',
  mode:    'none',

  entry: './src/extension.ts',

  output: {
    path:           path.resolve(__dirname, 'dist'),
    filename:       'extension.js',
    libraryTarget:  'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },

  devtool: 'nosources-source-map',

  externals: {
    vscode: 'commonjs vscode',
  },

  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      '@tracegraph/shared-types': path.resolve(
        __dirname,
        '../../packages/shared-types/src/index.ts',
      ),
    },
  },

  module: {
    rules: [
      {
        test:    /\.ts$/,
        exclude: /node_modules/,
        use:     [
          {
            loader: 'ts-loader',
          },
        ],
      },
    ],
  },
};

module.exports = config;
