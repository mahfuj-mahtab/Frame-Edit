const { spawn } = require('child_process');
const path = require('path');
const ffprobe = require('ffprobe-static');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac']);

function unpackedBinary(binary) {
  return binary ? binary.replaceAll('app.asar', 'app.asar.unpacked') : binary;
}

function mediaKind(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  return null;
}

function runProbe(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      unpackedBinary(ffprobe.path),
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { windowsHide: true },
    );
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out while reading media'));
    }, 20000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('Could not read media file'));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('Could not read media file'));
      }
    });
  });
}

function pictureStream(streams) {
  return streams.find(
    (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
  );
}

function parseRate(rate) {
  if (!rate || rate === '0/0') return 0;
  const [numerator, denominator] = String(rate).split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return numerator / denominator;
}

function streamLength(stream) {
  const duration = Number(stream?.duration);
  if (Number.isFinite(duration) && duration > 0) return duration;
  const frames = Number(stream?.nb_frames);
  const rate = parseRate(stream?.avg_frame_rate) || parseRate(stream?.r_frame_rate);
  if (Number.isFinite(frames) && frames > 0 && rate > 0) return frames / rate;
  return null;
}

function mediaDuration(probed, type, picture, audio) {
  if (type === 'image') return null;
  const formatDuration = Number(probed.format?.duration);
  if (Number.isFinite(formatDuration) && formatDuration > 0) return formatDuration;
  return streamLength(type === 'audio' ? audio : picture);
}

async function describeMedia(filePath) {
  const type = mediaKind(filePath);
  if (!type) {
    throw new Error('Unsupported file type');
  }

  const probed = await runProbe(filePath);
  const streams = probed.streams || [];
  const picture = pictureStream(streams);
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  if (type === 'audio' && !audio) throw new Error('No audio stream found');
  if (type === 'video' && !picture) throw new Error('No video stream found');
  if (type === 'image' && !picture) throw new Error('Could not read image size');

  const duration = mediaDuration(probed, type, picture, audio);
  return {
    type,
    path: filePath,
    name: path.basename(filePath),
    duration: Number.isFinite(duration) ? duration : null,
    width: picture ? Number(picture.width) || null : null,
    height: picture ? Number(picture.height) || null : null,
    hasAudio: Boolean(audio),
  };
}

module.exports = {
  describeMedia,
  mediaKind,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
};
