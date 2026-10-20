// End-to-end tests: serve the repo statically and drive the viewer in Chromium.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.js/,
  use: {
    baseURL: 'http://127.0.0.1:8765/',
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
  },
  webServer: {
    command: 'python3 -m http.server 8765 --bind 127.0.0.1',
    url: 'http://127.0.0.1:8765/index.html',
    reuseExistingServer: true,
  },
});
