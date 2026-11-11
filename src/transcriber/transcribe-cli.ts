/**
 * Transcribe CLI Wrapper — Milestone 4
 *
 * Validates input audio path security:
 * - Rejects URLs and network shares
 * - Strictly ensures the file is within the project's data directory
 * - Validates supported extensions (.wav, .mp3, .m4a, etc.)
 * Invokes the project-local Python virtual environment (.venv).
 */

import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { assessHardware } from '../utils/hardware.js';
import { PROJECT_ROOT } from '../utils/paths.js';

export interface TranscribeOptions {
  inputFile: string;
  /** Where audio/ and transcripts/ live (DATA_DIR); the audio has to be inside. Default: data/ in the project */
  dataDir?: string;
  model?: string;
  device?: string;
  computeType?: string;
  language?: string;
  /** Technical terms (course glossary) to bias recognition */
  hotwords?: string[];
}

export type WhisperDevice = 'cuda' | 'cpu';

/** `--device` value: "cuda" (or "gpu") and "cpu". Anything else is an error, not a silent fallback. */
export function parseDevice(value: string): WhisperDevice {
  const v = value.trim().toLowerCase();
  if (v === 'cuda' || v === 'gpu') return 'cuda';
  if (v === 'cpu') return 'cpu';
  throw new Error(`Dispositivo no válido: "${value}". Usa --device cuda o --device cpu.`);
}

/** float16 on the GPU; int8 on the CPU, where float16 is unsupported or very slow. */
export function defaultComputeType(device: WhisperDevice): string {
  return device === 'cuda' ? 'float16' : 'int8';
}

/** `baseDir` resolves a relative path (default: the project folder) and `dataDir` is the only place audio may be. */
export function validateInputFilePath(inputRaw: string, baseDir: string = PROJECT_ROOT, dataDirRaw?: string): string {
  if (!inputRaw || typeof inputRaw !== 'string') {
    throw new Error('Input audio file path is required.');
  }

  const trimmed = inputRaw.trim();

  // Reject URLs
  if (/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Security restriction: URLs are not allowed: "${trimmed}"`);
  }

  // Reject network/UNC paths
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) {
    throw new Error(`Security restriction: Network UNC paths are not allowed: "${trimmed}"`);
  }

  const resolved = path.resolve(baseDir, trimmed);
  const dataDir = path.resolve(baseDir, dataDirRaw ?? 'data');

  // Enforce location within data directory
  const relative = path.relative(dataDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Security restriction: Audio file must reside inside data/ directory. Got: "${resolved}"`);
  }

  // Check file exists
  if (!fs.existsSync(resolved)) {
    throw new Error(`Audio file does not exist: "${resolved}"`);
  }

  // Supported media extensions
  const ext = path.extname(resolved).toLowerCase();
  const allowedExts = ['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac'];
  if (!allowedExts.includes(ext)) {
    throw new Error(`Unsupported media format: "${ext}". Supported: ${allowedExts.join(', ')}`);
  }

  return resolved;
}

/** The project's own Python (where faster-whisper is installed), under `root`. */
export function venvPython(root: string = PROJECT_ROOT): string {
  return process.platform === 'win32'
    ? path.resolve(root, '.venv', 'Scripts', 'python.exe')
    : path.resolve(root, '.venv', 'bin', 'python');
}

export async function runTranscriptionCli(options: TranscribeOptions): Promise<number> {
  const dataDir = options.dataDir ?? path.join(PROJECT_ROOT, 'data');
  const validatedPath = validateInputFilePath(options.inputFile, PROJECT_ROOT, dataDir);

  const pythonVenvExe = venvPython();

  if (!fs.existsSync(pythonVenvExe)) {
    throw new Error(`Python virtual environment not found at "${pythonVenvExe}". Run "python -m venv .venv" and install requirements.`);
  }

  const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'transcribe.py');

  const hw = assessHardware();
  // An explicit --device wins over detection; the compute type follows the device actually used
  const device: WhisperDevice = options.device ? parseDevice(options.device) : hw.gpu.cudaAvailable ? 'cuda' : 'cpu';
  if (device === 'cuda' && !hw.gpu.cudaAvailable) {
    console.warn('⚠️  Se pidió --device cuda pero no se detecta CUDA; si falla, usa --device cpu.');
  }

  const args = [
    scriptPath,
    '--input', validatedPath,
    '--data_dir', dataDir,
    '--model', options.model || hw.recommendation.whisperModel || 'small',
    '--device', device,
    '--compute_type', options.computeType || defaultComputeType(device),
    '--language', options.language || 'es',
    '--beam_size', '5',
    '--vad_filter'
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonVenvExe, args, { stdio: 'inherit', cwd: PROJECT_ROOT });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(0);
      } else {
        reject(new Error(`Transcription process exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

// CLI entry point
if (process.argv[1]?.endsWith('transcribe-cli.ts') || process.argv[1]?.endsWith('transcribe-cli.js')) {
  const args = process.argv.slice(2);
  let inputFile = '';
  let model = 'small';
  let device: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) {
      inputFile = args[i + 1]!;
      i++;
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[i + 1]!;
      i++;
    } else if (args[i] === '--device' && args[i + 1]) {
      device = args[i + 1]!;
      i++;
    }
  }

  if (!inputFile) {
    // Default fallback to 5min capture test
    inputFile = path.join('data', 'audio', 'capture-test-5min-16khz.wav');
  }

  runTranscriptionCli({ inputFile, model, device })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n❌ Transcription Error:', err.message);
      process.exit(1);
    });
}
