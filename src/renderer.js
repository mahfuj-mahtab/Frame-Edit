const PX_PER_SECOND = 80;
const IMAGE_DURATION = 5;

const runtime = document.getElementById('runtime');
const versions = window.frameedit && window.frameedit.versions;

if (versions) {
  runtime.textContent = `Electron ${versions.electron}`;
}

const importButton = document.getElementById('import-media');
const mediaEmpty = document.getElementById('media-empty');
const mediaList = document.getElementById('media-list');
const mediaError = document.getElementById('media-error');
const previewEmpty = document.getElementById('preview-empty');
const previewCanvas = document.getElementById('preview-canvas');
const previewVideo = document.getElementById('preview-video');
const previewAudio = document.getElementById('preview-audio');
const previewAudioLabel = document.getElementById('preview-audio-label');
const playToggle = document.getElementById('play-toggle');
const seek = document.getElementById('seek');
const timecode = document.getElementById('timecode');
const timeArea = document.getElementById('time-area');
const timelineScroll = document.getElementById('timeline-scroll');
const ruler = document.getElementById('ruler');
const playhead = document.getElementById('playhead');

const assets = [];
const sequence = {
  settings: { width: 1920, height: 1080, fps: 30 },
  tracks: [
    { id: 'overlay', type: 'overlay', clips: [] },
    { id: 'video', type: 'video', clips: [] },
    { id: 'audio', type: 'audio', clips: [] },
  ],
};

let selectedId = null;
let dragAssetId = null;
let scrubbing = false;
let timelineTime = 0;
let playing = false;
let lastTick = 0;
let playbackFrame = 0;
let videoClipId = null;
let audioClipId = null;
let imagePreviewId = null;

importButton.addEventListener('click', async () => {
  importButton.disabled = true;
  try {
    const result = await window.frameedit.importMedia();
    if (!result || result.canceled) return;

    for (const asset of result.assets) {
      if (!assets.some((item) => item.path === asset.path)) {
        assets.push(asset);
      }
    }
    renderMedia();
    showErrors(result.errors);
  } catch (error) {
    showErrors([{ message: error.message || 'Could not import media' }]);
  } finally {
    importButton.disabled = false;
  }
});

playToggle.addEventListener('click', () => {
  if (usingTimeline()) {
    toggleTimeline();
    return;
  }
  toggleSource();
});

seek.addEventListener('pointerdown', () => {
  scrubbing = true;
});
seek.addEventListener('pointerup', () => {
  scrubbing = false;
});
seek.addEventListener('input', () => {
  if (usingTimeline()) {
    if (playing) pauseTimeline();
    setTimelineTime(Number(seek.value), true);
    return;
  }
  const media = activeSource();
  if (!media) return;
  media.currentTime = Number(seek.value);
  timecode.textContent = formatTimecode(media.currentTime);
});

for (const media of [previewVideo, previewAudio]) {
  media.addEventListener('loadedmetadata', onMediaReady);
  media.addEventListener('timeupdate', onMediaTime);
  media.addEventListener('ended', () => {
    if (!usingTimeline() && media === activeSource()) playToggle.textContent = 'Play';
  });
  media.addEventListener('error', () => {
    if (!media.getAttribute('src') || usingTimeline() || media !== activeSource()) return;
    showPreviewMessage('Could not play this file');
  });
}

timeArea.addEventListener('pointerdown', (event) => {
  if (!usingTimeline()) return;
  timeArea.setPointerCapture(event.pointerId);
  scrubTo(event.clientX);
});
timeArea.addEventListener('pointermove', (event) => {
  if (!timeArea.hasPointerCapture(event.pointerId)) return;
  scrubTo(event.clientX);
});

for (const lane of document.querySelectorAll('.track-lane')) {
  lane.addEventListener('dragover', (event) => {
    const asset = assets.find((item) => item.id === dragAssetId);
    if (!asset || !trackAccepts(lane.dataset.track, asset.type)) return;
    event.preventDefault();
    lane.classList.add('drag-over');
  });
  lane.addEventListener('dragleave', () => {
    lane.classList.remove('drag-over');
  });
  lane.addEventListener('drop', (event) => {
    event.preventDefault();
    lane.classList.remove('drag-over');
    const assetId = event.dataTransfer.getData('text/plain') || dragAssetId;
    const asset = assets.find((item) => item.id === assetId);
    const track = trackByType(lane.dataset.track);
    if (!asset || !track || !trackAccepts(track.type, asset.type)) return;
    placeClip(track, asset, timeAtClientX(event.clientX));
    renderTimeline();
    if (playing) pauseTimeline();
    setTimelineTime(timelineTime, true);
  });
}

function renderMedia() {
  mediaList.replaceChildren();
  const hasAssets = assets.length > 0;
  mediaEmpty.hidden = hasAssets;
  mediaList.hidden = !hasAssets;

  for (const asset of assets) {
    const item = document.createElement('li');
    item.className = 'media-item';
    item.draggable = true;
    if (asset.id === selectedId) item.classList.add('is-selected');

    const name = document.createElement('span');
    name.className = 'media-name';
    name.textContent = asset.name;
    name.title = asset.path;

    const meta = document.createElement('span');
    meta.className = 'media-meta';
    meta.textContent = formatMeta(asset);

    item.append(name, meta);
    item.addEventListener('click', () => selectAsset(asset.id));
    item.addEventListener('dragstart', (event) => {
      dragAssetId = asset.id;
      event.dataTransfer.setData('text/plain', asset.id);
      event.dataTransfer.effectAllowed = 'copy';
    });
    item.addEventListener('dragend', () => {
      dragAssetId = null;
    });
    mediaList.append(item);
  }
}

function selectAsset(id) {
  selectedId = id;
  renderMedia();
  if (usingTimeline()) return;

  stopSource();
  const asset = selectedAsset();
  hidePreviewLayers();
  previewEmpty.hidden = true;

  if (asset.type === 'image') {
    showImage(asset);
    return;
  }

  const media = asset.type === 'video' ? previewVideo : previewAudio;
  if (asset.type === 'video') previewVideo.hidden = false;
  else {
    previewAudioLabel.hidden = false;
    previewAudioLabel.textContent = asset.name;
  }
  playToggle.disabled = false;
  media.src = asset.url;
}

function toggleSource() {
  const media = activeSource();
  if (!media) return;
  if (media.paused) {
    media.play().then(() => {
      playToggle.textContent = 'Pause';
    }).catch(() => {
      showPreviewMessage('Could not play this file');
    });
    return;
  }
  media.pause();
  playToggle.textContent = 'Play';
}

function toggleTimeline() {
  if (sequenceDuration() <= 0) return;
  if (playing) {
    pauseTimeline();
    return;
  }
  if (timelineTime >= sequenceDuration() - 0.01) setTimelineTime(0, true);
  playing = true;
  playToggle.textContent = 'Pause';
  lastTick = performance.now();
  syncPreview(false);
  playbackFrame = requestAnimationFrame(tick);
}

function pauseTimeline() {
  playing = false;
  cancelAnimationFrame(playbackFrame);
  playToggle.textContent = 'Play';
  if (!previewVideo.paused) previewVideo.pause();
  if (!previewAudio.paused) previewAudio.pause();
}

function tick(now) {
  if (!playing) return;
  const videoClip = clipAt(trackByType('video'), timelineTime);
  const audioClip = clipAt(trackByType('audio'), timelineTime);
  let next = timelineTime;
  if (videoClip && videoClipId === videoClip.id && previewVideo.readyState >= 2 && !previewVideo.paused) {
    next = videoClip.start + (previewVideo.currentTime - videoClip.in);
  } else if (!videoClip && audioClip && audioClipId === audioClip.id && previewAudio.readyState >= 2 && !previewAudio.paused) {
    next = audioClip.start + (previewAudio.currentTime - audioClip.in);
  } else {
    next = timelineTime + (now - lastTick) / 1000;
  }
  lastTick = now;
  if (next >= sequenceDuration()) {
    setTimelineTime(sequenceDuration(), true);
    pauseTimeline();
    return;
  }
  setTimelineTime(next, false);
  keepPlayheadVisible();
  playbackFrame = requestAnimationFrame(tick);
}

function scrubTo(clientX) {
  if (playing) pauseTimeline();
  setTimelineTime(timeAtClientX(clientX), true);
}

function setTimelineTime(time, scrub) {
  const duration = sequenceDuration();
  timelineTime = duration > 0 ? Math.min(Math.max(0, time), duration) : 0;
  seek.max = String(duration);
  seek.value = String(timelineTime);
  seek.disabled = duration <= 0;
  playToggle.disabled = duration <= 0 && !selectedAsset();
  if (duration > 0) playToggle.disabled = false;
  timecode.textContent = formatTimecode(timelineTime);
  playhead.style.left = `${timelineTime * PX_PER_SECOND}px`;
  if (usingTimeline()) syncPreview(scrub);
}

function syncPreview(scrub) {
  const videoClip = clipAt(trackByType('video'), timelineTime);
  const imageClip = clipAt(trackByType('overlay'), timelineTime);
  const audioClip = clipAt(trackByType('audio'), timelineTime);

  syncVideo(videoClip, scrub);
  syncAudio(audioClip, scrub);

  if (videoClip) {
    previewEmpty.hidden = true;
    previewCanvas.hidden = true;
    previewAudioLabel.hidden = true;
    previewVideo.hidden = false;
    return;
  }

  previewVideo.hidden = true;
  if (imageClip) {
    previewAudioLabel.hidden = true;
    showImage(assetById(imageClip.assetId));
    return;
  }

  previewCanvas.hidden = true;
  imagePreviewId = null;
  if (audioClip) {
    previewEmpty.hidden = true;
    previewAudioLabel.hidden = false;
    previewAudioLabel.textContent = assetById(audioClip.assetId).name;
    return;
  }

  previewAudioLabel.hidden = true;
  previewEmpty.hidden = false;
  previewEmpty.textContent = 'Preview';
}

function syncVideo(clip, scrub) {
  if (!clip) {
    if (!previewVideo.paused) previewVideo.pause();
    videoClipId = null;
    return;
  }

  const asset = assetById(clip.assetId);
  const sourceTime = clip.in + (timelineTime - clip.start);
  const clipChanged = videoClipId !== clip.id;
  videoClipId = clip.id;

  if (previewVideo.getAttribute('src') !== asset.url) {
    const clipId = clip.id;
    previewVideo.src = asset.url;
    previewVideo.addEventListener('loadeddata', () => {
      if (videoClipId !== clipId) return;
      const current = clipAt(trackByType('video'), timelineTime);
      if (!current || current.id !== clipId) return;
      previewVideo.currentTime = current.in + (timelineTime - current.start);
      if (playing) previewVideo.play().catch(() => pauseTimeline());
    }, { once: true });
    return;
  }

  if (clipChanged || scrub || Math.abs(previewVideo.currentTime - sourceTime) > 0.35) {
    previewVideo.currentTime = sourceTime;
  }
  if (playing && previewVideo.paused) previewVideo.play().catch(() => pauseTimeline());
  if (!playing && !previewVideo.paused) previewVideo.pause();
}

function syncAudio(clip, scrub) {
  if (!clip) {
    if (!previewAudio.paused) previewAudio.pause();
    audioClipId = null;
    return;
  }

  const asset = assetById(clip.assetId);
  const sourceTime = clip.in + (timelineTime - clip.start);
  const clipChanged = audioClipId !== clip.id;
  audioClipId = clip.id;
  const videoIsMaster = Boolean(clipAt(trackByType('video'), timelineTime));

  if (previewAudio.getAttribute('src') !== asset.url) {
    const clipId = clip.id;
    previewAudio.src = asset.url;
    previewAudio.addEventListener('loadeddata', () => {
      if (audioClipId !== clipId) return;
      const current = clipAt(trackByType('audio'), timelineTime);
      if (!current || current.id !== clipId) return;
      previewAudio.currentTime = current.in + (timelineTime - current.start);
      if (playing) previewAudio.play().catch(() => {});
    }, { once: true });
    return;
  }

  if (clipChanged || scrub || (videoIsMaster && Math.abs(previewAudio.currentTime - sourceTime) > 0.2) || (!videoIsMaster && Math.abs(previewAudio.currentTime - sourceTime) > 0.35)) {
    previewAudio.currentTime = sourceTime;
  }
  if (playing && previewAudio.paused) previewAudio.play().catch(() => {});
  if (!playing && !previewAudio.paused) previewAudio.pause();
}

function placeClip(track, asset, start) {
  const duration = clipDuration(asset);
  let nextStart = Math.max(0, start);
  const existing = track.clips.slice().sort((a, b) => a.start - b.start);
  for (let guard = 0; guard < existing.length + 1; guard += 1) {
    const hit = existing.find((clip) => rangesOverlap(nextStart, nextStart + duration, clip.start, clip.start + clipLength(clip)));
    if (!hit) break;
    nextStart = hit.start + clipLength(hit);
  }
  track.clips.push({
    id: crypto.randomUUID(),
    assetId: asset.id,
    start: nextStart,
    in: 0,
    out: duration,
  });
}

function renderTimeline() {
  const width = Math.max(timelineScroll.clientWidth, (Math.max(sequenceDuration() + 8, 20)) * PX_PER_SECOND);
  timeArea.style.width = `${width}px`;
  ruler.replaceChildren();
  const seconds = Math.ceil(width / PX_PER_SECOND);
  for (let second = 0; second <= seconds; second += 5) {
    const mark = document.createElement('span');
    mark.className = 'ruler-mark';
    mark.style.left = `${second * PX_PER_SECOND}px`;
    mark.textContent = `${second}s`;
    ruler.append(mark);
  }

  for (const track of sequence.tracks) {
    const lane = document.querySelector(`.track-lane[data-track="${track.type}"]`);
    lane.replaceChildren();
    for (const clip of track.clips) {
      const asset = assetById(clip.assetId);
      const block = document.createElement('div');
      block.className = `clip clip-${track.type}`;
      block.style.left = `${clip.start * PX_PER_SECOND}px`;
      block.style.width = `${Math.max(clipLength(clip) * PX_PER_SECOND, 8)}px`;
      block.textContent = asset ? asset.name : 'Missing';
      block.title = formatDuration(clipLength(clip));
      lane.append(block);
    }
  }
  playhead.style.left = `${timelineTime * PX_PER_SECOND}px`;
}

function keepPlayheadVisible() {
  const x = timelineTime * PX_PER_SECOND;
  const margin = 48;
  if (x < timelineScroll.scrollLeft + margin) {
    timelineScroll.scrollLeft = Math.max(0, x - margin);
  } else if (x > timelineScroll.scrollLeft + timelineScroll.clientWidth - margin) {
    timelineScroll.scrollLeft = x - timelineScroll.clientWidth + margin;
  }
}

function showImage(asset) {
  if (!asset) return;
  if (imagePreviewId === asset.id && !previewCanvas.hidden) return;
  imagePreviewId = asset.id;
  const image = new Image();
  image.onload = () => {
    if (imagePreviewId !== asset.id) return;
    previewCanvas.width = image.naturalWidth;
    previewCanvas.height = image.naturalHeight;
    previewCanvas.getContext('2d').drawImage(image, 0, 0);
    previewCanvas.hidden = false;
    previewEmpty.hidden = true;
  };
  image.onerror = () => {
    if (imagePreviewId === asset.id) showPreviewMessage('Could not preview this image');
  };
  image.src = asset.url;
}

function onMediaReady(event) {
  if (usingTimeline() || event.target !== activeSource()) return;
  const duration = Number.isFinite(event.target.duration) ? event.target.duration : 0;
  seek.max = String(duration);
  seek.value = '0';
  seek.disabled = duration <= 0;
  timecode.textContent = formatTimecode(0);
}

function onMediaTime(event) {
  const media = event.target;
  if (usingTimeline() || media !== activeSource() || scrubbing) return;
  seek.value = String(media.currentTime);
  timecode.textContent = formatTimecode(media.currentTime);
}

function stopSource() {
  for (const media of [previewVideo, previewAudio]) {
    media.pause();
    media.removeAttribute('src');
    media.load();
  }
  videoClipId = null;
  audioClipId = null;
  imagePreviewId = null;
  playToggle.disabled = true;
  playToggle.textContent = 'Play';
  seek.disabled = true;
  seek.value = '0';
  seek.max = '0';
  timecode.textContent = '00:00:00';
  hidePreviewLayers();
  previewEmpty.hidden = false;
  previewEmpty.textContent = 'Preview';
}

function hidePreviewLayers() {
  previewCanvas.hidden = true;
  previewVideo.hidden = true;
  previewAudioLabel.hidden = true;
}

function showPreviewMessage(message) {
  hidePreviewLayers();
  previewEmpty.hidden = false;
  previewEmpty.textContent = message;
  if (!usingTimeline()) {
    playToggle.disabled = true;
    seek.disabled = true;
  }
}

function usingTimeline() {
  return sequence.tracks.some((track) => track.clips.length > 0);
}

function sequenceDuration() {
  return sequence.tracks.reduce((end, track) => {
    return track.clips.reduce((clipEnd, clip) => Math.max(clipEnd, clip.start + clipLength(clip)), end);
  }, 0);
}

function clipAt(track, time) {
  return track.clips.find((clip) => {
    const end = clip.start + clipLength(clip);
    if (time >= clip.start && time < end) return true;
    return time > clip.start && time === end && Math.abs(time - sequenceDuration()) < 0.0001;
  }) || null;
}

function clipDuration(asset) {
  if (asset.type === 'image' || !Number.isFinite(asset.duration) || asset.duration <= 0) return IMAGE_DURATION;
  return asset.duration;
}

function clipLength(clip) {
  return Math.max(0, clip.out - clip.in);
}

function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function trackAccepts(trackType, assetType) {
  return trackType === assetType || (trackType === 'overlay' && assetType === 'image');
}

function trackByType(type) {
  return sequence.tracks.find((track) => track.type === type);
}

function timeAtClientX(clientX) {
  const rect = timeArea.getBoundingClientRect();
  return Math.max(0, (clientX - rect.left) / PX_PER_SECOND);
}

function activeSource() {
  const asset = selectedAsset();
  if (!asset || asset.type === 'image') return null;
  return asset.type === 'video' ? previewVideo : previewAudio;
}

function selectedAsset() {
  return assets.find((asset) => asset.id === selectedId) || null;
}

function assetById(id) {
  return assets.find((asset) => asset.id === id) || null;
}

function showErrors(errors) {
  if (!errors || errors.length === 0) {
    mediaError.hidden = true;
    mediaError.textContent = '';
    return;
  }
  mediaError.hidden = false;
  mediaError.textContent = errors
    .map((error) => (error.name ? `${error.name}: ${error.message}` : error.message))
    .join(' ');
}

function formatMeta(asset) {
  const parts = [typeLabel(asset.type)];
  const duration = formatDuration(asset.duration);
  if (duration) parts.push(duration);
  if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  return parts.join(' · ');
}

function typeLabel(type) {
  if (type === 'video') return 'Video';
  if (type === 'audio') return 'Audio';
  return 'Image';
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const clock = `${minutes}:${String(secs).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : clock;
}

function formatTimecode(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
}

renderTimeline();
