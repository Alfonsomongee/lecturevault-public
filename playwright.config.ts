import { defineConfig, devices } from '@playwright/test';

// The tests never use the developer's Gemini key, campus calendar or git upload, whatever their .env says:
// a variable that is already defined (even empty) is not overridden when src/utils/config.ts loads .env.
process.env['GEMINI_API_KEY'] = '';
process.env['LMS_CALENDAR_URL'] = '';
process.env['AUTO_GIT_SYNC'] = 'false';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    // Optional: point at a locally installed Chromium (PW_CHROMIUM_PATH) instead of the bundled one
    launchOptions: { executablePath: process.env['PW_CHROMIUM_PATH'] || undefined },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'dashboard',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
