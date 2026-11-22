import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://localhost:4200';
const apiURL = 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'Mobile Chrome',
      use: {
        ...devices['Pixel 7'],
        // "Tomar foto" opens a real getUserMedia stream in the browser; these flags
        // give Chromium a synthetic video device so the live camera flow is testable
        // headlessly, without needing an actual webcam on the CI machine.
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
      },
    },
  ],
  webServer: [
    {
      command: 'npm run api',
      url: `${apiURL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        API_JWT_SECRET: 'e2e-secret-change-me',
        API_PORT: '3000',
        API_STORE_PATH: 'server/data/e2e-store.json',
        IMPORT_SOURCE_URL: `${apiURL}/api/mock/todos`,
        IMPORT_SOURCE_NAME: 'JSONPlaceholder',
        IMPORT_LIMIT: '3',
      },
    },
    {
      command: 'npm start -- --port 4200',
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
