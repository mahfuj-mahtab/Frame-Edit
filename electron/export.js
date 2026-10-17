const { spawn } = require('child_process');

const PRESETS = {
  '1080p': { width: 1920, height: 1080, high: '8000k', medium: '5000k', low: '2500k' },
  '720p': { width: 1280, height: 720, high: '5000k', medium: '3000k', low: '1500k' },
  '480p': { width: 854, height: 480, high: '2500k', medium: '1500k', low: '800k' },
};

function num(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('A clip has an invalid time or position');
  return Math.round(number * 1000) / 1000;
}

function clipLength(clip) {
  return Math.max(0, num(clip.out) - num(clip.in));
}

function sequenceDuration(project) {
  return (project.tracks || []).reduce((end, track) => {
    return (track.clips || []).reduce((clipEnd, clip) => Math.max(clipEnd, num(clip.start) + clipLength(clip)), end);
  }, 0);
}

function buildExportArgs(project, options) {
  const preset = PRESETS[options.preset];
  if (!preset) throw new Error('Choose 1080p, 720p, or 480p');
  const bitrate = preset[options.quality];
  if (!bitrate) throw new Error('Choose a high, medium, or low quality');
  if (!options.output) throw new Error('Choose where to save the video');

  const width = Number(project.settings?.width) || 1920;
  const height = Number(project.settings?.height) || 1080;
  const duration = sequenceDuration(project);
  if (duration <= 0) throw new Error('Add a clip before exporting');

  const assets = new Map((project.assets || []).map((asset) => [asset.id, asset]));
  const track = (type) => project.tracks?.find((item) => item.type === type);
  const sorted = (type) => [...(track(type)?.clips || [])].sort((a, b) => num(a.start) - num(b.start));

  const inputs = [];
  const addInput = (args) => {
    const index = inputs.length;
    inputs.push(args);
    return index;
  };
  const requireAsset = (clip, label) => {
    const asset = assets.get(clip.assetId);
    if (!asset || asset.missing) throw new Error(`Missing ${asset?.name || label}`);
    return asset;
  };

  const videoInputs = sorted('video').map((clip) => {
    const asset = requireAsset(clip, 'video');
    return { clip, asset, index: addInput(['-i', asset.path]) };
  });
  const audioInputs = sorted('audio').map((clip) => {
    const asset = requireAsset(clip, 'audio');
    return { clip, asset, index: addInput(['-i', asset.path]) };
  });
  const overlayInputs = sorted('overlay').map((clip) => {
    const asset = requireAsset(clip, 'overlay');
    if (asset.type === 'image') {
      return {
        clip,
        asset,
        index: addInput(['-loop', '1', '-framerate', '30', '-t', String(num(duration)), '-i', asset.path]),
      };
    }
    if (asset.type === 'video') return { clip, asset, index: addInput(['-i', asset.path]) };
    throw new Error('The overlay track accepts images and video');
  });

  const colorIndex = addInput([
    '-f', 'lavfi', '-t', String(num(duration)),
    '-i', `color=c=black:s=${width}x${height}:r=30`,
  ]);
  const silenceIndex = addInput([
    '-f', 'lavfi', '-t', String(num(duration)),
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
  ]);

  const filters = [];
  const audioLabels = [];
  let current = `${colorIndex}:v`;

  videoInputs.forEach((item, index) => {
    const start = num(item.clip.start);
    const end = num(start + clipLength(item.clip));
    const label = `vc${index}`;
    const next = `vt${index}`;
    filters.push(
      `[${item.index}:v]trim=start=${num(item.clip.in)}:end=${num(item.clip.out)},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,setpts=PTS-STARTPTS+${start}/TB[${label}]`,
    );
    filters.push(
      `[${current}][${label}]overlay=0:0:enable='between(t,${start},${end})':eof_action=pass:format=auto[${next}]`,
    );
    current = next;
    if (item.asset.hasAudio && !item.clip.muted) {
      const audioLabel = `va${index}`;
      const delay = Math.max(0, Math.round(start * 1000));
      filters.push(
        `[${item.index}:a]atrim=start=${num(item.clip.in)}:end=${num(item.clip.out)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${num(item.clip.volume ?? 1)},adelay=${delay}|${delay}[${audioLabel}]`,
      );
      audioLabels.push(audioLabel);
    }
  });

  overlayInputs.forEach((item, index) => {
    const transform = item.clip.transform || { x: 0, y: 0, scale: 1, opacity: 1 };
    const scale = Number(transform.scale);
    const scaledWidth = Math.max(2, Math.round((Number(item.asset.width) || 2) * (Number.isFinite(scale) ? scale : 1)));
    const scaledHeight = Math.max(2, Math.round((Number(item.asset.height) || 2) * (Number.isFinite(scale) ? scale : 1)));
    const opacity = Math.min(1, Math.max(0, Number(transform.opacity ?? 1)));
    const start = num(item.clip.start);
    const end = num(start + clipLength(item.clip));
    const label = `oc${index}`;
    const next = `ot${index}`;
    const trim = item.asset.type === 'video'
      ? `trim=start=${num(item.clip.in)}:end=${num(item.clip.out)},setpts=PTS-STARTPTS,`
      : '';
    const shift = item.asset.type === 'video' ? `,setpts=PTS-STARTPTS+${start}/TB` : '';
    filters.push(
      `[${item.index}:v]${trim}scale=${scaledWidth}:${scaledHeight},format=rgba,colorchannelmixer=aa=${num(opacity)}${shift}[${label}]`,
    );
    filters.push(
      `[${current}][${label}]overlay=${Math.round(Number(transform.x) || 0)}:${Math.round(Number(transform.y) || 0)}:enable='between(t,${start},${end})':eof_action=pass:format=auto[${next}]`,
    );
    current = next;
    if (item.asset.type === 'video' && item.asset.hasAudio && !item.clip.muted) {
      const audioLabel = `oa${index}`;
      const delay = Math.max(0, Math.round(start * 1000));
      filters.push(
        `[${item.index}:a]atrim=start=${num(item.clip.in)}:end=${num(item.clip.out)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${num(item.clip.volume ?? 1)},adelay=${delay}|${delay}[${audioLabel}]`,
      );
      audioLabels.push(audioLabel);
    }
  });

  filters.push(`[${current}]scale=${preset.width}:${preset.height}:flags=lanczos,format=yuv420p[vout]`);

  audioInputs.forEach((item, index) => {
    if (item.clip.muted) return;
    const start = num(item.clip.start);
    const delay = Math.max(0, Math.round(start * 1000));
    const label = `aa${index}`;
    filters.push(
      `[${item.index}:a]atrim=start=${num(item.clip.in)}:end=${num(item.clip.out)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${num(item.clip.volume ?? 1)},adelay=${delay}|${delay}[${label}]`,
    );
    audioLabels.push(label);
  });

  let audioMap = `${silenceIndex}:a`;
  if (audioLabels.length > 0) {
    const mix = [`[${silenceIndex}:a]`, ...audioLabels.map((label) => `[${label}]`)].join('');
    filters.push(`${mix}amix=inputs=${audioLabels.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`);
    audioMap = '[aout]';
  }

  const args = [
    '-y',
    ...inputs.flat(),
    '-filter_complex',
    filters.join(';'),
    '-map', '[vout]',
    '-map', audioMap,
    '-t', String(num(duration)),
    '-r', '30',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-b:v', bitrate,
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    options.output,
  ];

  return { args, duration };
}

function runExport({ ffmpeg, args, duration, onProgress }) {
  let cancel = () => {};
  const promise = new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    let settled = false;
    cancel = () => {
      if (!settled) child.kill('SIGTERM');
    };

    const finish = (error, canceled) => {
      if (settled) return;
      settled = true;
      if (error) {
        error.canceled = Boolean(canceled);
        reject(error);
        return;
      }
      resolve();
    };

    child.stdout.on('data', (chunk) => {
      const lines = String(chunk).split('\n');
      for (const line of lines) {
        if (!line.startsWith('out_time_ms=') || !onProgress) continue;
        const microseconds = Number(line.slice('out_time_ms='.length));
        if (!Number.isFinite(microseconds) || duration <= 0) continue;
        onProgress(Math.max(0, Math.min(1, (microseconds / 1e6) / duration)));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code, signal) => {
      if (signal) {
        finish(new Error('Export canceled'), true);
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-2).join(' ');
        finish(new Error(detail || 'Export failed'));
        return;
      }
      if (onProgress) onProgress(1);
      finish();
    });

    });
  promise.cancel = cancel;
  return promise;
}

module.exports = {
  PRESETS,
  buildExportArgs,
  runExport,
  sequenceDuration,
};
