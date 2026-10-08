// End-to-end tests for the VolumeLens terminal: npx playwright test
const path = require('path');
const { defineConfig } = require('@playwright/test');

const PY = process.platform === 'win32' ? path.join('.venv', 'Scripts', 'python.exe') : '.venv/bin/python';

module.exports = defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:8777',       // BASE_URL=https://… tests a deployment
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  },
  webServer: [
    {
      command: `${PY} -m http.server 8777 --bind 127.0.0.1 --directory web`,
      url: 'http://127.0.0.1:8777/terminal.html',
      reuseExistingServer: true,
    },
    {
      // the live server, replaying a recorded session through the live path
      command: `${PY} -m live.server RELIANCE --simulate 2026-09-29 --speed 60 --port 8788`,
      url: 'http://127.0.0.1:8788/status',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
  projects: [
    { name: 'edge', use: { channel: 'msedge' } },
    { name: 'chrome', use: { channel: 'chrome' } },
  ],
});
