/**
 * LectureVault — Shared type definitions
 */

/** Status of a recording in the local database */
export type RecordingStatus = 'new' | 'seen' | 'processed';

/** Metadata extracted from a Collab2 recording entry */
export interface RecordingMetadata {
  /** Unique identifier from Collab2 (derived from playback URL or DOM id) */
  collabId: string;
  /** Recording title as displayed in the UI */
  title: string;
  /** ISO 8601 date string of when the recording was created */
  createdAt: string;
  /** Duration in seconds */
  durationSeconds: number;
  /** Playback URL or reference */
  playbackUrl: string;
  /** Optional course / subject; never overwritten by a re-sync when empty */
  course?: string;
}

/** Recording row as stored in SQLite */
export interface RecordingRow {
  id: number;
  collab_id: string;
  title: string;
  created_at: string;
  duration_seconds: number;
  playback_url: string;
  first_seen_at: string;
  last_seen_at: string;
  status: RecordingStatus;
  /** Course / subject this recording belongs to ('' when unknown) */
  course: string;
  /** Folder name under data/transcripts (and audio stem) once captured */
  transcript_id: string | null;
  /** Fingerprint of the stored transcript segments */
  segments_hash: string | null;
  /** Campus title ("Clase 3. Análisis cinemático"); sync never touches it. Show COALESCE(display_title, title). */
  display_title: string | null;
  /** Who wrote display_title: 'user' locks it against regeneration */
  title_source: TitleSource;
  class_number: number | null;
  /** Real class day (YYYY-MM-DD); null when only created_at is known, which is unconfirmed */
  class_date: string | null;
  session_kind: SessionKind | null;
  /** Syllabus block this class belongs to ('' when unknown) */
  topic: string;
  analysis_version: string;
  /** Version of the exam-question prompt behind this class's bank ('' = never generated) */
  exam_version?: string;
  /** Set when the student chose not to capture this Collab2 class; sync never clears it */
  ignored_at: string | null;
  /** How the campus titles the class ("Sesión 3. Tema 2: Contabilidad Financiera…"), from the daily agent */
  official_title?: string | null;
  /** "Sesión N" of the campus; the parts of one session (recording_1, recording_2) share it */
  session_number?: number | null;
  session_part?: number | null;
  /** Topic the campus title names; it wins over the AI's guess */
  official_topic?: string | null;
  /** 'user' when the student set class_date by hand (the campus date does not replace it) */
  class_date_source?: string | null;
}

export type TitleSource = 'sync' | 'ai' | 'user';

/** Dominant kind of a class session, as classified by the analysis */
export type SessionKind = 'presentation' | 'theory' | 'project' | 'exam_review' | 'lab' | 'mixed';

/** Application configuration loaded from environment */
export interface AppConfig {
  lmsBaseUrl: string;
  collabRecordingsPath: string;
  allowedHosts: string[];
  courseIdentifier: string;
  lmsUsername?: string;
  lmsPassword?: string;
  browserProfileDir: string;
  browserHeaded: boolean;
  browserViewportWidth: number;
  browserViewportHeight: number;
  browserTimeoutMs: number;
  databasePath: string;
  dashboardPort: number;
  logLevel: string;
  logDir: string;
  screenshotDir: string;
  diagnosticsDir: string;
  enableDiagnostics: boolean;
  screenshotDiagnostics: boolean;
  /** Root of local artifacts: audio/, transcripts/, exports/ (DATA_DIR; default: data/ in the project folder) */
  dataDir: string;
  /** Copies of the database, kept outside data/ (BACKUP_DIR; default: backups/ in the project folder) */
  backupDir: string;
  geminiApiKey?: string;
  geminiModel: string;
  geminiEmbeddingModel: string;
  deepseekApiKey?: string;
  deepseekModel: string;
  /** Two-pass notes: list and verify the facts, then write (NOTES_FACTS=true; default false = one call) */
  notesFacts: boolean;
  browserChannel?: string;
  /** The university's .ics feed (it carries a personal token: .env only) */
  lmsCalendarUrl?: string;
  /** Commit and push each new transcript to the git remote (AUTO_GIT_SYNC, off by default) */
  autoGitSync: boolean;
  /** The only branch transcripts are uploaded from */
  gitSyncBranch: string;
  /** Upload even when GitHub says the repository is public */
  gitSyncAllowPublic: boolean;
}

/** Page state detected by the navigator */
export type PageState =
  | 'recordings-loaded'
  | 'empty-state'
  | 'auth-required'
  | 'error'
  | 'unknown';

/** Sync result summary */
export interface SyncResult {
  totalFound: number;
  newRecordings: number;
  updatedRecordings: number;
  errors: string[];
  timestamp: string;
}

/**
 * Read-only playback, subtitle, transcript, and download capabilities
 * detected in the Collab2 / Collaborate playback UI.
 */
export interface PlayerCapabilities {
  /** Detected sanitized host (e.g. eu.bbcollab.com) */
  sanitizedHost: string;
  /** Presentation window context: 'same-tab' | 'new-tab' | 'popup' */
  windowContext: 'same-tab' | 'new-tab' | 'popup';
  /** Whether a recognized video/audio player container was detected */
  playerDetected: boolean;
  /** Whether the player resides inside an iframe */
  isEmbeddedInIframe: boolean;
  /** Whether user interaction (click play) is required before media plays */
  requiresUserInteractionToPlay: boolean;
  /** Visible Play / Pause button or control */
  hasPlayPauseControl: boolean;
  /** Visible duration and current playback time display */
  hasTimeDisplay: boolean;
  visibleDurationText?: string;
  visibleCurrentTimeText?: string;
  /** Visible playback speed selector (1x, 1.25x, etc.) */
  hasPlaybackSpeedControl: boolean;
  /** Visible Closed Captions (CC) or subtitle toggle/selector */
  hasClosedCaptionsControl: boolean;
  /** Subtitle status statement */
  subtitleStatus: string;
  /** Visible transcript panel, tab, or button */
  hasTranscriptPanelOrButton: boolean;
  /** Visible official download button or menu item */
  hasDownloadOption: boolean;
  downloadLabelOrType?: string;
  /** Visible chat or session content / materials options */
  hasChatOrSessionContentOption: boolean;
  /** Any accessibility notes or labels discovered on player controls */
  accessibilityLabels: string[];
}

/** Inspection result report */
export interface PlayerInspectionReport {
  timestamp: string;
  capabilities: PlayerCapabilities;
  diagnosticFilePath?: string;
  screenshotPath?: string;
  warnings: string[];
}

