// End-to-end tests for the VolumeLens terminal: npx playwright test
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:8777',
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  },
  webServer: {
    command: process.platform === 'win32'
      ? '.venv\\Scripts\\python.exe -m http.server 8777 --bind 127.0.0.1 --directory web'
      : '.venv/bin/python -m http.server 8777 --bind 127.0.0.1 --directory web',
    url: 'http://127.0.0.1:8777/index.html',
    reuseExistingServer: true,
  },
  projects: [
    { name: 'edge', use: { channel: 'msedge' } },
    { name: 'chrome', use: { channel: 'chrome' } },
  ],
});
