import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig } from '../../src/utils/config.js';
import { PROJECT_ROOT } from '../../src/utils/paths.js';
import path from 'path';
import os from 'node:os';

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear out env vars that might affect the test
    delete process.env.LMS_BASE_URL;
    delete process.env.COLLAB_RECORDINGS_PATH;
    delete process.env.BROWSER_PROFILE_DIR;
    delete process.env.BROWSER_HEADED;
    delete process.env.BROWSER_VIEWPORT_WIDTH;
    delete process.env.BROWSER_VIEWPORT_HEIGHT;
    delete process.env.BROWSER_TIMEOUT_MS;
    delete process.env.DATABASE_PATH;
    delete process.env.DASHBOARD_PORT;
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_DIR;
    delete process.env.SCREENSHOT_DIR;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('Returns default values when no env vars are set', () => {
    const config = loadConfig();
    expect(config).toHaveProperty('lmsBaseUrl');
    expect(config).toHaveProperty('collabRecordingsPath');
    expect(config).toHaveProperty('browserProfileDir');
    expect(config).toHaveProperty('browserHeaded');
    expect(config).toHaveProperty('browserViewportWidth');
    expect(config).toHaveProperty('browserViewportHeight');
    expect(config).toHaveProperty('browserTimeoutMs');
    expect(config).toHaveProperty('databasePath');
    expect(config).toHaveProperty('dashboardPort');
    expect(config).toHaveProperty('logLevel');
    expect(config).toHaveProperty('logDir');
    expect(config).toHaveProperty('screenshotDir');
  });

  it('keeps uploading to git off unless it is asked for', () => {
    // .env of whoever runs the tests may turn it on
    delete process.env.AUTO_GIT_SYNC;
    delete process.env.GIT_SYNC_BRANCH;
    delete process.env.GIT_SYNC_ALLOW_PUBLIC;
    expect(loadConfig()).toMatchObject({ autoGitSync: false, gitSyncBranch: 'main', gitSyncAllowPublic: false });

    process.env.AUTO_GIT_SYNC = 'true';
    process.env.GIT_SYNC_BRANCH = 'backup';
    expect(loadConfig()).toMatchObject({ autoGitSync: true, gitSyncBranch: 'backup', gitSyncAllowPublic: false });
  });

  describe('where files live', () => {
    const keys = ['DATA_DIR', 'DATABASE_PATH', 'LOG_DIR', 'BROWSER_PROFILE_DIR', 'SCREENSHOT_DIR', 'DIAGNOSTICS_DIR', 'BACKUP_DIR'];
    beforeEach(() => { for (const k of keys) delete process.env[k]; });
    afterEach(() => vi.restoreAllMocks());

    it('defaults hang from the project folder, whatever folder the command started in', () => {
      vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
      const config = loadConfig();
      expect(config.dataDir).toBe(path.join(PROJECT_ROOT, 'data'));
      expect(config.databasePath).toBe(path.join(PROJECT_ROOT, 'data', 'lecturevault.db'));
      expect(config.logDir).toBe(path.join(PROJECT_ROOT, 'data', 'logs'));
      expect(config.browserProfileDir).toBe(path.join(PROJECT_ROOT, 'data', 'browser-profile'));
      // copies live outside data/ by default
      expect(config.backupDir).toBe(path.join(PROJECT_ROOT, 'backups'));
    });

    it('DATA_DIR moves the database, logs and browser profile with it', () => {
      const elsewhere = path.join(os.tmpdir(), 'mis-datos');
      process.env.DATA_DIR = elsewhere;
      const config = loadConfig();
      expect(config.dataDir).toBe(elsewhere);
      expect(config.databasePath).toBe(path.join(elsewhere, 'lecturevault.db'));
      expect(config.logDir).toBe(path.join(elsewhere, 'logs'));
      expect(config.screenshotDir).toBe(path.join(elsewhere, 'screenshots'));
      expect(config.backupDir).toBe(path.join(PROJECT_ROOT, 'backups')); // the copies do not follow the data they protect
    });

    it('an explicit variable wins over DATA_DIR, and a relative one is relative to the project', () => {
      process.env.DATA_DIR = path.join(os.tmpdir(), 'mis-datos');
      process.env.DATABASE_PATH = 'otra/base.db';
      process.env.BACKUP_DIR = path.join(os.tmpdir(), 'nube');
      const config = loadConfig();
      expect(config.databasePath).toBe(path.join(PROJECT_ROOT, 'otra', 'base.db'));
      expect(config.backupDir).toBe(path.join(os.tmpdir(), 'nube'));
    });
  });

  it('Reads values from process.env when set', () => {
    process.env.LMS_BASE_URL = 'https://example.com/lms';
    process.env.BROWSER_HEADED = 'true';
    process.env.DASHBOARD_PORT = '3000';
    process.env.LOG_LEVEL = 'debug';

    const config = loadConfig();
    expect(config.lmsBaseUrl).toBe('https://example.com/lms');
    expect(config.browserHeaded).toBe(true);
    expect(config.dashboardPort).toBe(3000);
    expect(config.logLevel).toBe('debug');
  });

  it('Boolean parsing: true, false, 1, 0, yes, no', () => {
    const truthyValues = ['true', '1', 'yes'];
    const falsyValues = ['false', '0', 'no'];

    for (const val of truthyValues) {
      process.env.BROWSER_HEADED = val;
      expect(loadConfig().browserHeaded).toBe(true);
    }

    for (const val of falsyValues) {
      process.env.BROWSER_HEADED = val;
      expect(loadConfig().browserHeaded).toBe(false);
    }
  });

  it('Integer parsing from env vars', () => {
    process.env.DASHBOARD_PORT = '8080';
    process.env.BROWSER_VIEWPORT_WIDTH = '1920';
    process.env.BROWSER_VIEWPORT_HEIGHT = '1080';
    
    const config = loadConfig();
    expect(config.dashboardPort).toBe(8080);
    expect(config.browserViewportWidth).toBe(1920);
    expect(config.browserViewportHeight).toBe(1080);
  });

  it('Throws on invalid integer', () => {
    process.env.DASHBOARD_PORT = 'abc';
    expect(() => loadConfig()).toThrow();
  });

  it('Throws on invalid boolean', () => {
    process.env.BROWSER_HEADED = 'maybe';
    expect(() => loadConfig()).toThrow();
  });

  it('Throws on invalid port (0, 70000)', () => {
    process.env.DASHBOARD_PORT = '0';
    expect(() => loadConfig()).toThrow();

    process.env.DASHBOARD_PORT = '70000';
    expect(() => loadConfig()).toThrow();
  });

  it('Throws on invalid LMS_BASE_URL (not a valid URL)', () => {
    process.env.LMS_BASE_URL = 'not-a-url';
    expect(() => loadConfig()).toThrow();
  });

  it('Resolves relative paths to absolute paths', () => {
    process.env.DATABASE_PATH = './data/db.sqlite';
    const config = loadConfig();
    expect(path.isAbsolute(config.databasePath)).toBe(true);
    expect(config.databasePath.endsWith('db.sqlite')).toBe(true);
  });

  it('Parses ALLOWED_HOSTS comma separated and includes LMS host', () => {
    process.env.LMS_BASE_URL = 'https://campusvirtual.universidad.es';
    process.env.ALLOWED_HOSTS = 'collab2.bbcollab.com, ext.example.com';
    const config = loadConfig();

    expect(config.allowedHosts).toContain('campusvirtual.universidad.es');
    expect(config.allowedHosts).toContain('collab2.bbcollab.com');
    expect(config.allowedHosts).toContain('ext.example.com');
  });

  it('Defaults ALLOWED_HOSTS to LMS host when not set', () => {
    process.env.LMS_BASE_URL = 'https://myuni.blackboard.com';
    delete process.env.ALLOWED_HOSTS;
    const config = loadConfig();

    expect(config.allowedHosts).toEqual(['myuni.blackboard.com']);
  });
});
