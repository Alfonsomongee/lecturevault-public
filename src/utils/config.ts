/**
 * LectureVault — Configuration loader
 *
 * Loads configuration from environment variables (via .env file)
 * with sensible defaults. Never stores or processes credentials.
 */

import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import type { AppConfig } from '../types.js';
import { PROJECT_ROOT, fromRoot } from './paths.js';
import { resolveDeepseekModel } from '../ai/GeminiClient.js';

// The .env of the project, wherever the command was started from
dotenvConfig({ path: path.join(PROJECT_ROOT, '.env') });

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer for ${key}: "${raw}"`);
  }
  return parsed;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const lower = raw.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  throw new Error(`Invalid boolean for ${key}: "${raw}"`);
}

/** Load and validate application configuration */
export function loadConfig(): AppConfig {
  const lmsBaseUrl = envStr('LMS_BASE_URL', 'https://example.blackboard.com');
  
  // Validate URL format
  let lmsHost: string;
  try {
    const parsed = new URL(lmsBaseUrl);
    lmsHost = parsed.hostname;
  } catch {
    throw new Error(`Invalid LMS_BASE_URL: "${lmsBaseUrl}"`);
  }

  // Parse allowed hosts: comma-separated list of exact hosts, defaulting to lmsHost
  const rawAllowedHosts = process.env['ALLOWED_HOSTS'];
  const allowedHosts = rawAllowedHosts
    ? rawAllowedHosts.split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
    : [lmsHost.toLowerCase()];

  // Ensure lmsHost is in allowedHosts
  if (!allowedHosts.includes(lmsHost.toLowerCase())) {
    allowedHosts.push(lmsHost.toLowerCase());
  }

  // Everything local hangs from DATA_DIR unless its own variable says otherwise, so moving the data folder
  // moves the database, logs and browser profile with it. Relative values are relative to the project folder.
  const dataDir = fromRoot(envStr('DATA_DIR', 'data'));
  const inData = (key: string, name: string) => (process.env[key] ? fromRoot(process.env[key]!) : path.join(dataDir, name));

  const config: AppConfig = {
    lmsBaseUrl,
    collabRecordingsPath: envStr('COLLAB_RECORDINGS_PATH', '/ultra/courses'),
    allowedHosts,
    courseIdentifier: envStr('COURSE_IDENTIFIER', 'default-course'),
    lmsUsername: process.env['LMS_USERNAME']?.trim() || undefined,
    lmsPassword: process.env['LMS_PASSWORD'] || undefined,
    browserProfileDir: inData('BROWSER_PROFILE_DIR', 'browser-profile'),
    browserHeaded: envBool('BROWSER_HEADED', true),
    browserViewportWidth: envInt('BROWSER_VIEWPORT_WIDTH', 1280),
    browserViewportHeight: envInt('BROWSER_VIEWPORT_HEIGHT', 720),
    browserTimeoutMs: envInt('BROWSER_TIMEOUT_MS', 30000),
    databasePath: inData('DATABASE_PATH', 'lecturevault.db'),
    dashboardPort: envInt('DASHBOARD_PORT', 3000),
    logLevel: envStr('LOG_LEVEL', 'info'),
    logDir: inData('LOG_DIR', 'logs'),
    screenshotDir: inData('SCREENSHOT_DIR', 'screenshots'),
    diagnosticsDir: inData('DIAGNOSTICS_DIR', 'diagnostics'),
    enableDiagnostics: envBool('ENABLE_DIAGNOSTICS', false),
    screenshotDiagnostics: envBool('SCREENSHOT_DIAGNOSTICS', false),
    dataDir,
    backupDir: process.env['BACKUP_DIR'] ? fromRoot(process.env['BACKUP_DIR']) : path.join(PROJECT_ROOT, 'backups'),
    geminiApiKey: process.env['GEMINI_API_KEY']?.trim() || undefined,
    geminiModel: envStr('GEMINI_MODEL', 'gemini-2.5-flash').trim(),
    geminiEmbeddingModel: envStr('GEMINI_EMBEDDING_MODEL', 'gemini-embedding-001').trim(),
    deepseekApiKey: process.env['DEEPSEEK_API_KEY']?.trim() || undefined,
    deepseekModel: resolveDeepseekModel(envStr('DEEPSEEK_MODEL', 'deepseek-v4-flash').trim()),
    notesFacts: envBool('NOTES_FACTS', false),
    browserChannel: process.env['BROWSER_CHANNEL']?.trim() || undefined,
    lmsCalendarUrl: process.env['LMS_CALENDAR_URL']?.trim() || undefined,
    autoGitSync: envBool('AUTO_GIT_SYNC', false),
    gitSyncBranch: envStr('GIT_SYNC_BRANCH', 'main').trim() || 'main',
    gitSyncAllowPublic: envBool('GIT_SYNC_ALLOW_PUBLIC', false),
  };

  // Validate port range
  if (config.dashboardPort < 1 || config.dashboardPort > 65535) {
    throw new Error(`Invalid DASHBOARD_PORT: ${config.dashboardPort}`);
  }

  return config;
}

export { loadConfig as default };
