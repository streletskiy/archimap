const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  fullyParallel: false,
  retries: 0,
  use: {
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
});
