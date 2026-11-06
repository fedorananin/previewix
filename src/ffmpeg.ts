import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';

let ffmpegLookup: { configured: string; result: Promise<string | undefined> } | undefined;

function works(command: string): Promise<boolean> {
  return new Promise((resolve) => execFile(command, ['-version'], { timeout: 5000 }, (err) => resolve(!err)));
}

/** Finds ffmpeg: the configured path, then PATH, then the usual install locations (a GUI-launched VS Code may have a short PATH). */
export function findFfmpeg(configured: string): Promise<string | undefined> {
  if (ffmpegLookup?.configured !== configured) {
    const candidates = configured
      ? [configured]
      : ['ffmpeg', path.join(os.homedir(), '.local/bin/ffmpeg'), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
    const result = (async () => {
      for (const candidate of candidates) {
        if (await works(candidate)) {
          return candidate;
        }
      }
      return undefined;
    })();
    ffmpegLookup = { configured, result };
  }
  return ffmpegLookup.result;
}
