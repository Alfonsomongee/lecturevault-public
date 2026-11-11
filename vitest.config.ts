import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // The tests never use the developer's Gemini key, campus calendar or git upload, whatever their .env says:
    // a variable that is already defined (even empty) is not overridden when src/utils/config.ts loads .env.
    env: { GEMINI_API_KEY: '', LMS_CALENDAR_URL: '', AUTO_GIT_SYNC: 'false' },
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
});
