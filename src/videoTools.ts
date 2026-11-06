import { spawn } from 'child_process';
import * as fs from 'fs';
import { tempSibling } from './tags/common';

/**
 * What the video player asks of ffmpeg: the list of streams in a file, the keyframes around a
 * position, a cut of a time range into a new file, and the text of a subtitle stream. Video and
 * audio are only ever copied packet by packet (`-c copy`); nothing here decodes or encodes them,
 * and nothing here feeds the player. No `vscode` import.
 */

export interface StreamInfo {
  index: number;
  type: 'video' | 'audio' | 'subtitle' | 'data' | 'attachment';
  codec: string;
  language?: string;
  title?: string;
  /** A cover picture stored as a video stream of one frame. */
  picture: boolean;
}

export interface FileInfo {
  /** The timestamp the file starts at, in seconds. ffmpeg counts `-ss` from here. */
  start: number;
  /** The length in seconds, to the hundredth; undefined when ffmpeg can't tell. */
  duration?: number;
  streams: StreamInfo[];
}

const CANCELLED = 'cancelled';
/** More text than any subtitle track holds; what a run prints beyond it is not kept. */
const MAX_OUTPUT = 64 * 1024 * 1024;

export const isCancelled = (e: unknown) => e instanceof Error && e.message === CANCELLED;

interface RunOptions {
  signal?: AbortSignal;
  /** Called with each piece of standard output; returning true ends the run early, as a success. */
  onOutput?: (chunk: string) => boolean | void;
  /** For a run that is read for what it prints, whatever its exit code. */
  anyExit?: boolean;
}

/** Runs ffmpeg and resolves with what it printed. A failure carries the end of its error output. */
function run(ffmpeg: string, args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) {
      reject(new Error(CANCELLED));
      return;
    }
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let enough = false;
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (enough) {
        return;
      }
      if (options.onOutput) {
        if (options.onOutput(chunk)) {
          enough = true;
          child.kill();
        }
      } else if (stdout.length < MAX_OUTPUT) {
        stdout += chunk;
      }
    });
    // The stream list comes first and errors come last, so a long log loses its middle.
    child.stderr.on('data', (chunk: string) => (stderr = stderr.length > 1 << 20 ? stderr.slice(0, 1 << 19) + (stderr + chunk).slice(-(1 << 19)) : stderr + chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        reject(new Error(CANCELLED));
      } else if (code === 0 || enough || options.anyExit) {
        resolve({ stdout, stderr });
      } else {
        const lines = stderr.trim().split('\n');
        reject(new Error(lines.slice(-4).join('\n').trim() || `ffmpeg exited with code ${code}`));
      }
    });
  });
}

const TYPES: Record<string, StreamInfo['type']> = { Video: 'video', Audio: 'audio', Subtitle: 'subtitle', Data: 'data', Attachment: 'attachment' };

/** Reads the description ffmpeg prints for an input file: `Stream #0:1(eng): Audio: opus, …` with the title in the lines below it. */
export function parseStreams(log: string): FileInfo {
  const info: FileInfo = { start: 0, streams: [] };
  let current: StreamInfo | undefined;
  let inInput = false;
  for (const line of log.split('\n')) {
    if (/^Input #0,/.test(line)) {
      inInput = true;
      continue;
    }
    if (!inInput) {
      continue;
    }
    // Whatever follows the input's description (an error, an output) starts at the left margin.
    if (/^\S/.test(line)) {
      break;
    }
    const times = /^\s+Duration: ([^,]*), start: (-?[\d.]+)/.exec(line);
    if (times) {
      const [h, m, sec] = times[1].split(':').map(Number);
      info.duration = Number.isFinite(sec) ? h * 3600 + m * 60 + sec : undefined;
      info.start = Number(times[2]) || 0;
      continue;
    }
    const stream = /^\s+Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?: (\w+): ([^\s,]+)/.exec(line);
    if (stream) {
      const type = TYPES[stream[3]];
      current = type && {
        index: Number(stream[1]),
        type,
        codec: stream[4],
        language: stream[2] && stream[2] !== 'und' ? stream[2] : undefined,
        picture: /\(attached pic\)/.test(line),
      };
      if (current) {
        info.streams.push(current);
      }
      continue;
    }
    const title = current && /^\s+title\s*: (.*)$/i.exec(line);
    if (title && current && current.title === undefined) {
      current.title = title[1].trim();
    }
  }
  return info;
}

export async function inspect(ffmpeg: string, file: string, signal?: AbortSignal): Promise<FileInfo> {
  // With no output file ffmpeg describes the input and exits with an error, which is all that is wanted of it.
  const { stderr } = await run(ffmpeg, ['-i', file], { signal, anyExit: true });
  const info = parseStreams(stderr);
  if (!info.streams.length) {
    throw new Error(stderr.trim().split('\n').pop() || 'ffmpeg found no streams in the file.');
  }
  return info;
}

/** A position for `-ss`, in whole microseconds and never later than `value`: a start that is a hair late would lose the keyframe it names. */
const position = (value: number) => (Math.max(0, Math.floor(value * 1e6 - 0.01)) / 1e6).toFixed(6);

export interface Keyframe {
  /** The time of the keyframe in seconds from the start of the file. */
  time: number;
  /** The size and checksum of its packet, by which the same packet is recognised in a clip. */
  print: string;
}

export interface Keyframes {
  /** The last keyframe at or before the position. */
  before?: Keyframe;
  /** The first keyframe after it, when there is one before `until`. */
  after?: Keyframe;
}

/** Reads the packet list of ffmpeg's `framecrc` output for stream 0 and calls `onKey` for every keyframe until that returns true. */
function keyReader(onKey: (ticks: number, base: number, print: string) => boolean): (chunk: string) => boolean {
  let base = 0;
  let rest = '';
  return (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const tb = /^#tb 0: (\d+)\/(\d+)/.exec(line);
      if (tb) {
        base = Number(tb[1]) / Number(tb[2]);
        continue;
      }
      // stream, dts, pts, duration, size, checksum, and the flags when they aren't just "keyframe".
      const packet = /^0,\s*(-?\d+),\s*(-?\d+),\s*-?\d+,\s*(\d+),\s*(0x[0-9a-fA-F]+)/.exec(line);
      if (!packet || !base) {
        continue;
      }
      const flags = /, F=0x([0-9A-Fa-f]+)/.exec(line);
      if (flags && !(parseInt(flags[1], 16) & 1)) {
        continue;
      }
      const pts = Number(packet[2]);
      // A packet without a presentation time falls back to its decoding time.
      if (onKey(Math.abs(pts) < 2 ** 62 ? pts : Number(packet[1]), base, `${packet[3]}:${packet[4]}`)) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Finds the video keyframes on both sides of `time`. ffmpeg seeks to a keyframe in front of the
 * position and lists the packets from there as a stream copy, so about one group of pictures is
 * read and nothing is decoded. Undefined when the file has no video to speak of.
 */
export async function keyframesAround(ffmpeg: string, file: string, info: FileInfo, time: number, until: number, signal?: AbortSignal): Promise<Keyframes | undefined> {
  if (!info.streams.some((stream) => stream.type === 'video' && !stream.picture)) {
    return undefined;
  }
  // A container without an index (MPEG-TS, Ogg) may come down behind the keyframe that was aimed
  // for. Then the list is read again from further back, in the end from the start of the file.
  for (const back of [0, 10, 60, Infinity]) {
    const from = Math.max(0, time - back);
    const found: Keyframes = {};
    // `-copyts` keeps the file's own timestamps in the list; `0:V` leaves cover pictures out.
    const args = ['-v', 'error', ...(from > 0 ? ['-ss', position(from)] : []), '-t', Math.max(until - from, 0.001).toFixed(6), '-i', file, '-map', '0:V:0', '-c', 'copy', '-copyts', '-f', 'framecrc', '-'];
    await run(ffmpeg, args, {
      signal,
      onOutput: keyReader((ticks, base, print) => {
        const key = { time: Math.max(0, ticks * base - info.start), print };
        // The seek may also land further back than the nearest keyframe (Matroska does that for the
        // sake of its subtitle tracks), so the list is followed until it has passed the position.
        if (key.time > time + 1e-4) {
          found.after = key;
          return true;
        }
        found.before = key;
        return false;
      }),
    });
    if (found.before || from === 0) {
      return found;
    }
  }
  return undefined;
}

export interface ClipStarts {
  /** Set when the mark is on a keyframe's own frame: the clip starts where it was marked. */
  exact?: Keyframe;
  /** Otherwise the keyframe in front of the mark, for a clip that is longer than marked… */
  before?: Keyframe;
  /** …and the one after it, for a clip that is shorter. */
  after?: Keyframe;
}

/** Where a clip marked from `mark` to `until` can start, given the keyframes around the mark. `frame` is the length of one frame. */
export function clipStarts(keys: Keyframes, mark: number, until: number, frame: number): ClipStarts {
  if (keys.before && mark - keys.before.time < frame) {
    return { exact: keys.before };
  }
  return { before: keys.before, after: keys.after && keys.after.time < until - frame ? keys.after : undefined };
}

export interface ClipOptions {
  /** Where the clip starts, in seconds from the start of the file. With video in the file this is the time of `keyframe`. */
  start: number;
  /** The keyframe the clip was promised to start with. The finished clip is checked against it. */
  keyframe?: Keyframe;
  /** Where it ends; undefined for the end of the file. */
  end?: number;
  signal?: AbortSignal;
  /** Called with the seconds of the clip written so far. */
  onProgress?: (written: number) => void;
}

export interface ClipResult {
  /** The length of what was written, in seconds. */
  duration: number;
  /** How many streams of each type the target's container did not take, such as `{ subtitle: 2 }`. */
  dropped: Partial<Record<StreamInfo['type'], number>>;
}

/** From everything to picture and sound: the first selection the target's container accepts is used. */
const SELECTIONS: { map: string[]; types?: StreamInfo['type'][] }[] = [
  { map: ['-map', '0', '-copy_unknown'] },
  { map: ['-map', '0:v?', '-map', '0:a?', '-map', '0:s?'], types: ['video', 'audio', 'subtitle'] },
  { map: ['-map', '0:v?', '-map', '0:a?'], types: ['video', 'audio'] },
];

/**
 * A seek comes down on some keyframe in front of the start and, for the sake of audio decoders, on
 * sound from before it. `-copypriorss 0` drops what precedes the start, which is what makes the
 * clip begin with the keyframe that was chosen. It is set per output stream, for picture, sound
 * and subtitles only: a cover picture or a timecode track is a single packet at the very
 * beginning, and would be dropped with the rest.
 */
function startFlags(info: FileInfo, selection: (typeof SELECTIONS)[number]): string[] {
  const { types } = selection;
  // `-map 0` keeps the order of the file; the narrower selections put video first, then audio, then subtitles.
  const outputs = types ? types.flatMap((type) => info.streams.filter((stream) => stream.type === type)) : info.streams;
  return outputs.flatMap((stream, place) =>
    (stream.type === 'video' && !stream.picture) || stream.type === 'audio' || stream.type === 'subtitle'
      ? [`-copypriorss:${types ? place : stream.index}`, '0']
      : [],
  );
}

/**
 * Copies the packets of a time range into `target` without re-encoding anything. The file is
 * written next to its target under a temporary name and renamed once it is finished and found to
 * start with the promised keyframe, so a failure or a cancel leaves nothing behind and an
 * existing target is replaced in one step.
 */
export async function cutClip(ffmpeg: string, file: string, target: string, info: FileInfo, options: ClipOptions): Promise<ClipResult> {
  const { start, end, signal } = options;
  // The temporary name keeps the extension, which is how ffmpeg picks the container.
  const temp = tempSibling(target);
  const range = [...(start > 0 ? ['-ss', position(start)] : []), ...(end !== undefined ? ['-t', (end - Math.max(start, 0)).toFixed(6)] : [])];
  let written = 0;
  let rest = '';
  const onOutput = (chunk: string) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      // Microseconds under both names; older versions only have the misnamed `out_time_ms`.
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m) {
        written = Math.max(written, Number(m[1]) / 1e6);
        options.onProgress?.(written);
      }
    }
  };
  try {
    let failure: unknown;
    let done = false;
    for (const selection of SELECTIONS) {
      try {
        const args = ['-v', 'error', '-y', ...range, '-i', file, ...selection.map, '-c', 'copy', ...startFlags(info, selection), '-progress', 'pipe:1', '-nostats', temp];
        await run(ffmpeg, args, { signal, onOutput });
        done = true;
        break;
      } catch (e) {
        failure = e;
        // A container refuses a stream before anything is written. Later than that, the same error would only repeat.
        if (isCancelled(e) || written > 0) {
          break;
        }
      }
    }
    if (!done) {
      throw failure;
    }
    const result = await inspect(ffmpeg, temp, signal);
    if (options.keyframe && start > 0) {
      let first = '';
      await run(ffmpeg, ['-v', 'error', '-i', temp, '-map', '0:V:0', '-c', 'copy', '-f', 'framecrc', '-'], {
        signal,
        onOutput: keyReader((_ticks, _base, print) => {
          first = print;
          return true;
        }),
      });
      if (first !== options.keyframe.print) {
        throw new Error("ffmpeg didn't start the clip at the chosen keyframe, which happens in formats without an index. Nothing was saved.");
      }
    }
    const dropped: ClipResult['dropped'] = {};
    for (const type of Object.values(TYPES)) {
      const count = (streams: StreamInfo[]) => streams.filter((stream) => stream.type === type).length;
      const missing = count(info.streams) - count(result.streams);
      if (missing > 0) {
        dropped[type] = missing;
      }
    }
    await fs.promises.rename(temp, target);
    return { duration: result.duration ?? written, dropped };
  } finally {
    await fs.promises.rm(temp, { force: true });
  }
}

/** Subtitle codecs that are text. The picture-based ones (PGS, DVD, DVB) have no text to show. */
const TEXT_SUBTITLES = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

export const textSubtitles = (info: FileInfo) => info.streams.filter((stream) => stream.type === 'subtitle' && TEXT_SUBTITLES.has(stream.codec));

/** The text of one subtitle stream as WebVTT. Depending on the container, ffmpeg has to read through the whole file for it. */
export async function readSubtitleStream(ffmpeg: string, file: string, index: number, signal?: AbortSignal): Promise<string> {
  const { stdout } = await run(ffmpeg, ['-v', 'error', '-i', file, '-map', `0:${index}`, '-f', 'webvtt', '-'], { signal });
  return stdout;
}
