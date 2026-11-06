import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import mediaInfoFactory, { type MediaInfo } from 'mediainfo.js';

export interface InfoSection {
  title: string;
  rows: [string, string][];
}

export interface MediaReport {
  summary: string;
  sections: InfoSection[];
  hasAudio: boolean;
  hasVideo: boolean;
  /** Frames per second of the first video track, when it is known and constant enough to count frames by. */
  frameRate?: number;
}

type Track = Record<string, unknown>;
type Analyzer = MediaInfo<'object'>;

let analyzer: Promise<Analyzer> | undefined;
// The WASM instance handles one file at a time, so analyses are chained.
let queue: Promise<unknown> = Promise.resolve();

function getAnalyzer(extensionPath: string): Promise<Analyzer> {
  analyzer ??= mediaInfoFactory({
    format: 'object',
    locateFile: () => path.join(extensionPath, 'dist', 'MediaInfoModule.wasm'),
  });
  return analyzer;
}

async function readTracks(uri: vscode.Uri, size: number, extensionPath: string): Promise<Track[]> {
  const mi = await getAnalyzer(extensionPath);
  let result;
  if (uri.scheme === 'file') {
    const handle = await fs.promises.open(uri.fsPath, 'r');
    try {
      result = await mi.analyzeData(size, async (chunkSize, offset) => {
        const buffer = new Uint8Array(chunkSize);
        const { bytesRead } = await handle.read(buffer, 0, chunkSize, offset);
        return buffer.subarray(0, bytesRead);
      });
    } finally {
      await handle.close();
    }
  } else {
    const data = await vscode.workspace.fs.readFile(uri);
    result = await mi.analyzeData(data.length, (chunkSize, offset) => data.subarray(offset, offset + chunkSize));
  }
  return (result.media?.track ?? []) as unknown as Track[];
}

const str = (v: unknown): string | undefined => {
  if (v === undefined || v === null || v === '') {
    return undefined;
  }
  return String(v);
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
};

/** A size as people say it: "95.7 KB", "1.42 GB". */
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

/** The size with the exact byte count alongside. */
export function formatBytes(bytes: number): string {
  return bytes < 1024 ? formatSize(bytes) : `${formatSize(bytes)} (${bytes.toLocaleString('en-US')} bytes)`;
}

function formatBitrate(v: unknown): string | undefined {
  const bps = num(v);
  if (bps === undefined) {
    return undefined;
  }
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(2)} Mb/s` : `${Math.round(bps / 1e3)} kb/s`;
}

function formatDuration(v: unknown): string | undefined {
  const seconds = num(v);
  if (seconds === undefined) {
    return undefined;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h}:${pad(m)}:${s.toFixed(3).padStart(6, '0')}`;
}

function formatFps(v: unknown): string | undefined {
  const fps = num(v);
  return fps === undefined ? undefined : `${parseFloat(fps.toFixed(3))} fps`;
}

function formatAspect(v: unknown): string | undefined {
  const ratio = num(v);
  if (ratio === undefined) {
    return undefined;
  }
  const known: [number, number][] = [[16, 9], [9, 16], [4, 3], [3, 4], [21, 9], [1, 1], [3, 2], [2, 3], [5, 4], [16, 10], [2, 1]];
  for (const [a, b] of known) {
    if (Math.abs(ratio - a / b) < 0.012) {
      return `${a}:${b}`;
    }
  }
  return `${ratio.toFixed(2)}:1`;
}

function formatChannels(track: Track): string | undefined {
  const count = num(track.Channels);
  if (count === undefined) {
    return undefined;
  }
  const names: Record<number, string> = { 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' };
  const layout = str(track.ChannelLayout);
  return `${count}${names[count] ? ` (${names[count]})` : ''}${layout ? ` · ${layout}` : ''}`;
}

function joinParts(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((p): p is string => !!p);
  return present.length ? present.join(' · ') : undefined;
}

function withMode(value: string | undefined, mode: unknown): string | undefined {
  const m = str(mode);
  return value && m ? `${value} (${m})` : value;
}

function codecName(track: Track): string | undefined {
  const format = str(track.Format);
  const commercial = str(track.Format_Commercial_IfAny);
  const names: Record<string, string> = { AVC: 'H.264 / AVC', HEVC: 'H.265 / HEVC' };
  return commercial ?? (format ? names[format] ?? format : undefined);
}

function section(title: string, rows: [string, string | undefined][]): InfoSection {
  return { title, rows: rows.filter((r): r is [string, string] => !!r[1]) };
}

function videoSection(t: Track, title: string): InfoSection {
  const width = num(t.Width);
  const height = num(t.Height);
  const level = str(t.Format_Level);
  const bitDepth = num(t.BitDepth);
  return section(title, [
    ['Codec', codecName(t)],
    ['Profile', joinParts(str(t.Format_Profile), level ? `Level ${level}` : undefined)],
    ['Codec ID', str(t.CodecID)],
    ['Resolution', width && height ? `${width} × ${height}` : undefined],
    ['Aspect ratio', formatAspect(t.DisplayAspectRatio)],
    ['Rotation', num(t.Rotation) ? `${num(t.Rotation)}°` : undefined],
    ['Frame rate', withMode(formatFps(t.FrameRate), t.FrameRate_Mode)],
    ['Frames', str(t.FrameCount)],
    ['Bitrate', withMode(formatBitrate(t.BitRate), t.BitRate_Mode)],
    ['Bit depth', bitDepth ? `${bitDepth} bit` : undefined],
    ['Chroma', joinParts(str(t.ColorSpace), str(t.ChromaSubsampling))],
    ['Scan type', str(t.ScanType)],
    ['HDR', str(t.HDR_Format)],
    ['Color', joinParts(str(t.colour_primaries), str(t.transfer_characteristics), str(t.matrix_coefficients))],
    ['Stream size', num(t.StreamSize) ? formatBytes(num(t.StreamSize)!) : undefined],
    ['Encoder', str(t.Encoded_Library_Name) ?? str(t.Encoded_Library)],
    ['Language', str(t.Language)],
  ]);
}

function audioSection(t: Track, title: string): InfoSection {
  const rate = num(t.SamplingRate);
  const bitDepth = num(t.BitDepth);
  return section(title, [
    ['Codec', joinParts(codecName(t), str(t.Format_AdditionalFeatures))],
    // Some muxers make MediaInfo report these as "a / b" lists; the last codec ID is the specific one.
    ['Codec ID', str(t.CodecID)?.split(' / ').pop()],
    ['Channels', formatChannels(t)],
    ['Sample rate', rate ? `${parseFloat((rate / 1000).toFixed(1))} kHz` : undefined],
    ['Bitrate', withMode(formatBitrate(t.BitRate), t.BitRate_Mode)],
    ['Bit depth', bitDepth ? `${bitDepth} bit` : undefined],
    ['Compression', str(t.Compression_Mode)],
    ['Stream size', num(t.StreamSize) ? formatBytes(num(t.StreamSize)!) : undefined],
    ['Language', str(t.Language)],
    ['Title', str(t.Title)],
    ['Default', str(t.Default)?.split(' / ')[0]],
  ]);
}

function textSection(t: Track, title: string): InfoSection {
  return section(title, [
    ['Format', str(t.Format)],
    ['Language', str(t.Language)],
    ['Title', str(t.Title)],
    ['Default', str(t.Default)],
    ['Forced', str(t.Forced)],
  ]);
}

function numbered(label: string, index: number, total: number): string {
  return total > 1 ? `${label} #${index + 1}` : label;
}

export function analyze(uri: vscode.Uri, extensionPath: string): Promise<MediaReport> {
  const run = queue.then(() => buildReport(uri, extensionPath));
  queue = run.catch(() => undefined);
  return run;
}

async function buildReport(uri: vscode.Uri, extensionPath: string): Promise<MediaReport> {
  const stat = await vscode.workspace.fs.stat(uri);
  const name = path.posix.basename(uri.path);
  const ext = path.posix.extname(uri.path).slice(1);

  let tracks: Track[] = [];
  let error: string | undefined;
  try {
    tracks = await readTracks(uri, stat.size, extensionPath);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const general = tracks.find((t) => t['@type'] === 'General') ?? {};
  const videos = tracks.filter((t) => t['@type'] === 'Video');
  const audios = tracks.filter((t) => t['@type'] === 'Audio');
  const texts = tracks.filter((t) => t['@type'] === 'Text');

  const date = (ms: number) => (ms ? new Date(ms).toLocaleString() : undefined);
  const sections: InfoSection[] = [
    section('File', [
      ['Name', name],
      ['Extension', ext ? `.${ext}` : undefined],
      ['Container', joinParts(str(general.Format), str(general.Format_Profile))],
      ['Size', formatBytes(stat.size)],
      ['Duration', formatDuration(general.Duration)],
      ['Overall bitrate', withMode(formatBitrate(general.OverallBitRate), general.OverallBitRate_Mode)],
      ['Created', date(stat.ctime)],
      ['Modified', date(stat.mtime)],
      ['Title', str(general.Title)],
      ['Written by', str(general.Encoded_Application)],
      ['Muxer', str(general.Encoded_Library)],
      ['Folder', uri.scheme === 'file' ? path.dirname(uri.fsPath) : undefined],
      ['Error', error ? `Could not analyze the file: ${error}` : undefined],
    ]),
    ...videos.map((t, i) => videoSection(t, numbered('Video', i, videos.length))),
    ...audios.map((t, i) => audioSection(t, numbered('Audio', i, audios.length))),
    ...texts.map((t, i) => textSection(t, numbered('Subtitles', i, texts.length))),
  ];

  const v = videos[0];
  const a = audios[0];
  const summary = joinParts(
    formatSize(stat.size),
    v && codecName(v),
    v && num(v.Width) && num(v.Height) ? `${num(v.Width)}×${num(v.Height)}` : undefined,
    v && formatFps(v.FrameRate),
    formatBitrate(general.OverallBitRate),
    a && codecName(a),
    formatDuration(general.Duration)?.replace(/\.\d+$/, ''),
  );

  return {
    summary: summary ?? '',
    sections,
    hasAudio: audios.length > 0,
    hasVideo: videos.length > 0,
    frameRate: (v && num(v.FrameRate)) || undefined,
  };
}
