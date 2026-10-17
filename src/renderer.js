const MIN_PX = 16;
const MAX_PX = 320;
const IMAGE_DURATION = 5;
const MIN_CLIP = 0.1;
const SNAP_PX = 10;

const runtime = document.getElementById('runtime');
const versions = window.frameedit && window.frameedit.versions;
if (versions) runtime.textContent = `Electron ${versions.electron}`;

const importButton = document.getElementById('import-media');
const openButton = document.getElementById('open-project');
const saveButton = document.getElementById('save-project');
const exportButton = document.getElementById('export-button');
const exportSize = document.getElementById('export-size');
const exportQuality = document.getElementById('export-quality');
const exportPanel = document.getElementById('export-panel');
const exportProgress = document.getElementById('export-progress');
const exportLabel = document.getElementById('export-label');
const exportCancel = document.getElementById('export-cancel');
const mediaEmpty = document.getElementById('media-empty');
const mediaList = document.getElementById('media-list');
const mediaError = document.getElementById('media-error');
const previewEmpty = document.getElementById('preview-empty');
const previewCanvas = document.getElementById('preview-canvas');
const previewVideo = document.getElementById('preview-video');
const overlayVideo = document.getElementById('overlay-video');
const previewAudio = document.getElementById('preview-audio');
const previewAudioLabel = document.getElementById('preview-audio-label');
const playToggle = document.getElementById('play-toggle');
const seek = document.getElementById('seek');
const timecode = document.getElementById('timecode');
const timeArea = document.getElementById('time-area');
const timelineScroll = document.getElementById('timeline-scroll');
const ruler = document.getElementById('ruler');
const playhead = document.getElementById('playhead');
const splitButton = document.getElementById('split-clip');
const deleteButton = document.getElementById('delete-clip');
const copyButton = document.getElementById('copy-clip');
const pasteButton = document.getElementById('paste-clip');
const undoButton = document.getElementById('undo');
const redoButton = document.getElementById('redo');
const zoomOutButton = document.getElementById('zoom-out');
const zoomInButton = document.getElementById('zoom-in');
const zoomRange = document.getElementById('zoom-range');
const snapGuide = document.getElementById('snap-guide');
const inspector = document.getElementById('inspector');
const projectName = document.getElementById('project-name');
const notice = document.getElementById('notice');

const assets = [];
const sequence = {
  settings: { width: 1920, height: 1080, fps: 30 },
  tracks: [
    { id: 'overlay', type: 'overlay', clips: [] },
    { id: 'video', type: 'video', clips: [] },
    { id: 'audio', type: 'audio', clips: [] },
  ],
};
const imageCache = new Map();
const history = [];

let historyIndex = -1;
let selectedId = null;
let selectedClipId = null;
let dragAssetId = null;
let scrubbing = false;
let timelineTime = 0;
let playing = false;
let lastTick = 0;
let playbackFrame = 0;
let videoClipId = null;
let overlayClipId = null;
let audioClipId = null;
let projectPath = null;
let dirty = false;
let savedHistoryIndex = 0;
let exporting = false;
let pixelsPerSecond = 80;
let clipboard = null;
let clipDragging = false;
let overlayDrag = null;
const thumbCache = new Map();
const thumbQueue = [];
let thumbRunning = false;
let thumbsStale = false;

importButton.addEventListener('click', importMedia);
openButton.addEventListener('click', openCurrent);
saveButton.addEventListener('click', () => saveCurrent(false));
exportButton.addEventListener('click', exportMovie);
exportCancel.addEventListener('click', () => window.frameedit.cancelExport());
splitButton.addEventListener('click', splitAtPlayhead);
deleteButton.addEventListener('click', deleteSelected);
copyButton.addEventListener('click', copySelected);
pasteButton.addEventListener('click', pasteClipboard);
undoButton.addEventListener('click', undo);
redoButton.addEventListener('click', redo);
zoomOutButton.addEventListener('click', () => setZoom(pixelsPerSecond / 1.25));
zoomInButton.addEventListener('click', () => setZoom(pixelsPerSecond * 1.25));
zoomRange.addEventListener('input', () => setZoom(Number(zoomRange.value)));
playToggle.addEventListener('click', () => {
  if (usingTimeline()) toggleTimeline();
  else toggleSource();
});

seek.addEventListener('pointerdown', () => { scrubbing = true; });
seek.addEventListener('pointerup', () => { scrubbing = false; });
seek.addEventListener('input', () => {
  if (!usingTimeline()) {
    const media = activeSource();
    if (!media) return;
    media.currentTime = Number(seek.value);
    timecode.textContent = formatTimecode(media.currentTime);
    return;
  }
  if (playing) pauseTimeline();
  setTimelineTime(Number(seek.value), true);
});

for (const media of [previewVideo, previewAudio]) {
  media.addEventListener('loadedmetadata', (event) => {
    if (usingTimeline() || event.target !== activeSource()) return;
    const duration = Number.isFinite(event.target.duration) ? event.target.duration : 0;
    seek.max = String(duration);
    seek.value = '0';
    seek.disabled = duration <= 0;
    timecode.textContent = formatTimecode(0);
  });
  media.addEventListener('timeupdate', (event) => {
    if (usingTimeline() || event.target !== activeSource() || scrubbing) return;
    seek.value = String(event.target.currentTime);
    timecode.textContent = formatTimecode(event.target.currentTime);
  });
  media.addEventListener('ended', (event) => {
    if (!usingTimeline() && event.target === activeSource()) playToggle.textContent = 'Play';
  });
  media.addEventListener('error', (event) => {
    if (!event.target.getAttribute('src') || usingTimeline() || event.target !== activeSource()) return;
    showPreviewMessage('Could not play this file');
  });
}

timeArea.addEventListener('pointerdown', (event) => {
  if (!usingTimeline() || event.target.closest('.clip')) return;
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
  lane.addEventListener('dragleave', () => lane.classList.remove('drag-over'));
  lane.addEventListener('drop', (event) => {
    event.preventDefault();
    lane.classList.remove('drag-over');
    const assetId = event.dataTransfer.getData('text/plain') || dragAssetId;
    const asset = assets.find((item) => item.id === assetId);
    const track = trackByType(lane.dataset.track);
    if (!asset || !track || !trackAccepts(track.type, asset.type)) return;
    placeClip(track, asset, timeAtClientX(event.clientX));
    selectedClipId = track.clips[track.clips.length - 1].id;
    commitEdit();
    renderTimeline();
    renderInspector();
    if (playing) pauseTimeline();
    setTimelineTime(timelineTime, true);
  });
}

window.addEventListener('keydown', (event) => {
  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const key = event.key.toLowerCase();
  const command = event.ctrlKey || event.metaKey;
  if (event.code === 'Space') {
    event.preventDefault();
    playToggle.click();
  } else if (key === 's' && !command) {
    splitAtPlayhead();
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    deleteSelected();
  } else if (command && key === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
  } else if (command && key === 'y') {
    event.preventDefault();
    redo();
  } else if (command && key === 's') {
    event.preventDefault();
    saveCurrent(event.shiftKey);
  } else if (command && key === 'o') {
    event.preventDefault();
    openCurrent();
  } else if (command && key === 'c') {
    event.preventDefault();
    copySelected();
  } else if (command && key === 'v') {
    event.preventDefault();
    pasteClipboard();
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    stepTimeline(direction * (event.shiftKey ? 1 : frameDuration()));
  } else if (event.key === 'Home') {
    event.preventDefault();
    stepTimeline(-Infinity);
  } else if (event.key === 'End') {
    event.preventDefault();
    stepTimeline(Infinity);
  }
});

timelineScroll.addEventListener('wheel', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const rect = timeArea.getBoundingClientRect();
  const time = Math.max(0, (event.clientX - rect.left) / pixelsPerSecond);
  const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
  setZoom(pixelsPerSecond * factor, time, event.clientX);
}, { passive: false });

window.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
});

window.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  const paths = [];
  for (const file of event.dataTransfer.files) {
    try {
      const filePath = window.frameedit.pathForFile(file);
      if (filePath) paths.push(filePath);
    } catch {
      /* ignore entries that have no local path */
    }
  }
  if (paths.length) importDropped(paths);
});

previewCanvas.addEventListener('pointerdown', startOverlayDrag);
previewCanvas.addEventListener('pointermove', (event) => {
  if (overlayDrag) return;
  const hit = overlayHit(event);
  previewCanvas.style.cursor = hit?.mode === 'scale' ? 'nwse-resize' : hit ? 'move' : '';
});

window.frameedit.onExportProgress(({ progress }) => {
  exportProgress.value = progress;
  exportLabel.textContent = `${Math.round(progress * 100)}%`;
});

async function importMedia() {
  importButton.disabled = true;
  try {
    acceptImported(await window.frameedit.importMedia());
  } catch (error) {
    showErrors([{ message: error.message || 'Could not import media' }]);
  } finally {
    importButton.disabled = false;
  }
}

async function importDropped(paths) {
  try {
    acceptImported(await window.frameedit.importPaths(paths));
  } catch (error) {
    showErrors([{ message: error.message || 'Could not import media' }]);
  }
}

function acceptImported(result) {
  if (!result || result.canceled) return;
  for (const asset of result.assets) {
    if (assets.some((item) => item.path === asset.path)) continue;
    assets.push(asset);
    if (asset.type === 'image') ensureImage(asset);
    else if (asset.type === 'video') queueThumb(asset);
  }
  renderMedia();
  showErrors(result.errors);
}

async function saveCurrent(forceDialog) {
  try {
    const result = await window.frameedit.saveProject({
      project: serializeProject(),
      filePath: forceDialog ? null : projectPath,
    });
    if (!result || result.canceled) return;
    projectPath = result.path;
    savedHistoryIndex = historyIndex;
    dirty = false;
    updateTitle();
    clearNotice();
  } catch (error) {
    showNotice(error.message || 'Could not save the project');
  }
}

async function openCurrent() {
  if (dirty && !window.confirm('Discard unsaved changes?')) return;
  try {
    const result = await window.frameedit.openProject();
    if (!result || result.canceled) return;
    applyProject(result.path, result.project);
  } catch (error) {
    showNotice(error.message || 'Could not open the project');
  }
}

async function exportMovie() {
  if (exporting || sequenceDuration() <= 0) return;
  exporting = true;
  updateCommandButtons();
  exportPanel.hidden = false;
  exportProgress.value = 0;
  exportLabel.textContent = 'Exporting';
  clearNotice();
  try {
    const stem = projectPath ? projectPath.split(/[\\/]/).pop().replace(/\.frameedit$/, '') : 'export';
    const result = await window.frameedit.exportProject({
      project: serializeProject(),
      preset: exportSize.value,
      quality: exportQuality.value,
      defaultName: `${stem}.mp4`,
    });
    if (result?.canceled) exportLabel.textContent = 'Canceled';
    else exportLabel.textContent = 'Finished';
  } catch (error) {
    exportLabel.textContent = 'Failed';
    showNotice(error.message || 'Export failed');
  } finally {
    exporting = false;
    updateCommandButtons();
    setTimeout(() => { exportPanel.hidden = true; }, 1400);
  }
}

function applyProject(filePath, project) {
  pauseTimeline();
  assets.splice(0, assets.length, ...project.assets);
  sequence.settings = project.settings;
  sequence.tracks = project.tracks;
  projectPath = filePath;
  dirty = false;
  selectedId = null;
  selectedClipId = null;
  imageCache.clear();
  clearThumbs();
  for (const asset of assets) {
    if (asset.missing) continue;
    if (asset.type === 'image') ensureImage(asset);
    else if (asset.type === 'video') queueThumb(asset);
  }
  resetHistory();
  renderMedia();
  renderTimeline();
  renderInspector();
  updateTitle();
  if (usingTimeline()) setTimelineTime(0, true);
  else showEmptyPreview();
  const missing = assets.filter((asset) => asset.missing).map((asset) => asset.name);
  if (missing.length) showNotice(`Missing files: ${missing.join(', ')}`);
  else clearNotice();
}

function serializeProject() {
  return {
    version: 1,
    settings: sequence.settings,
    assets,
    tracks: sequence.tracks,
  };
}

function renderMedia() {
  mediaList.replaceChildren();
  const hasAssets = assets.length > 0;
  mediaEmpty.hidden = hasAssets;
  mediaList.hidden = !hasAssets;

  for (const asset of assets) {
    const item = document.createElement('li');
    item.className = 'media-item';
    if (asset.missing) item.classList.add('is-missing');
    if (asset.id === selectedId) item.classList.add('is-selected');
    item.draggable = !asset.missing;

    const thumb = document.createElement('span');
    thumb.className = 'media-thumb';
    const thumbUrl = thumbCache.get(asset.id);
    if (thumbUrl) thumb.style.backgroundImage = `url("${thumbUrl}")`;

    const chip = document.createElement('span');
    chip.className = `chip ${asset.type === 'image' ? 'image' : asset.type}`;
    chip.textContent = asset.type === 'image' ? 'Image' : typeLabel(asset.type);

    const name = document.createElement('span');
    name.className = 'media-name';
    name.textContent = asset.name;
    name.title = asset.path;

    const meta = document.createElement('span');
    meta.className = 'media-meta';
    meta.textContent = asset.missing ? 'File missing' : formatMeta(asset);

    item.append(thumb, chip, name, meta);
    item.addEventListener('click', () => selectAsset(asset.id));
    item.addEventListener('dragstart', (event) => {
      dragAssetId = asset.id;
      event.dataTransfer.setData('text/plain', asset.id);
      event.dataTransfer.effectAllowed = 'copy';
    });
    item.addEventListener('dragend', () => { dragAssetId = null; });
    mediaList.append(item);
  }
}

function selectAsset(id) {
  selectedId = id;
  renderMedia();
  if (usingTimeline()) return;
  stopSource();
  const asset = selectedAsset();
  if (!asset || asset.missing) {
    showPreviewMessage(asset?.missing ? 'This file is missing' : 'Preview');
    return;
  }
  previewEmpty.hidden = true;
  if (asset.type === 'image') {
    showSourceImage(asset);
    return;
  }
  const media = asset.type === 'video' ? previewVideo : previewAudio;
  previewVideo.classList.remove('is-underlay');
  if (asset.type === 'video') previewCanvas.hidden = true;
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
    media.play().then(() => { playToggle.textContent = 'Pause'; }).catch(() => showPreviewMessage('Could not play this file'));
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
  if (!overlayVideo.paused) overlayVideo.pause();
  if (!previewAudio.paused) previewAudio.pause();
}

function tick(now) {
  if (!playing) return;
  const videoClip = clipAt(trackByType('video'), timelineTime);
  const overlayClip = clipAt(trackByType('overlay'), timelineTime);
  const audioClip = clipAt(trackByType('audio'), timelineTime);
  const overlayAsset = overlayClip ? assetById(overlayClip.assetId) : null;
  const clock = mediaClock(videoClip, previewVideo, videoClipId)
    || (overlayAsset?.type === 'video' ? mediaClock(overlayClip, overlayVideo, overlayClipId) : null)
    || mediaClock(audioClip, previewAudio, audioClipId);
  const next = clock == null ? timelineTime + (now - lastTick) / 1000 : clock;
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
  playToggle.disabled = duration <= 0;
  if (duration > 0) playToggle.disabled = false;
  timecode.textContent = formatTimecode(timelineTime);
  playhead.style.left = `${timelineTime * pixelsPerSecond}px`;
  updateCommandButtons();
  if (usingTimeline()) syncPreview(scrub);
}

function syncPreview(scrub) {
  const videoClip = clipAt(trackByType('video'), timelineTime);
  const overlayClip = clipAt(trackByType('overlay'), timelineTime);
  const audioClip = clipAt(trackByType('audio'), timelineTime);
  syncVideo(videoClip, scrub);
  syncOverlay(overlayClip, scrub);
  syncAudio(audioClip, scrub);
  previewVideo.classList.add('is-underlay');
  const overlayVisible = overlayClip && assetById(overlayClip.assetId)?.type !== 'audio';
  previewAudioLabel.hidden = Boolean(videoClip || overlayVisible || !audioClip);
  if (!videoClip && !overlayVisible && audioClip) {
    previewAudioLabel.textContent = assetById(audioClip.assetId)?.name || 'Audio';
  }
  previewEmpty.hidden = Boolean(videoClip || overlayVisible || audioClip);
  if (!videoClip && !overlayVisible && !audioClip) previewEmpty.textContent = 'Empty frame';
  drawFrame();
}

function syncVideo(clip, scrub) {
  const asset = clip ? assetById(clip.assetId) : null;
  if (!clip || !asset || asset.missing) {
    if (!previewVideo.paused) previewVideo.pause();
    videoClipId = null;
    return;
  }
  applyGain(previewVideo, clip);
  const sourceTime = clip.in + (timelineTime - clip.start);
  videoClipId = clip.id;
  if (previewVideo.getAttribute('src') !== asset.url) {
    const clipId = clip.id;
    previewVideo.src = asset.url;
    previewVideo.addEventListener('loadeddata', () => {
      if (videoClipId !== clipId) return;
      const current = clipAt(trackByType('video'), timelineTime);
      if (!current || current.id !== clipId) return;
      followSourceTime(previewVideo, current.in + (timelineTime - current.start), true);
      drawFrame();
    }, { once: true });
    return;
  }
  followSourceTime(previewVideo, sourceTime, scrub);
}

function syncOverlay(clip, scrub) {
  const asset = clip ? assetById(clip.assetId) : null;
  if (!clip || !asset || asset.type !== 'video' || asset.missing) {
    if (!overlayVideo.paused) overlayVideo.pause();
    overlayClipId = null;
    return;
  }
  applyGain(overlayVideo, clip);
  const sourceTime = clip.in + (timelineTime - clip.start);
  overlayClipId = clip.id;
  if (overlayVideo.getAttribute('src') !== asset.url) {
    const clipId = clip.id;
    overlayVideo.src = asset.url;
    overlayVideo.addEventListener('loadeddata', () => {
      if (overlayClipId !== clipId) return;
      const current = clipAt(trackByType('overlay'), timelineTime);
      if (!current || current.id !== clipId) return;
      followSourceTime(overlayVideo, current.in + (timelineTime - current.start), true);
      drawFrame();
    }, { once: true });
    return;
  }
  followSourceTime(overlayVideo, sourceTime, scrub);
}

function syncAudio(clip, scrub) {
  const asset = clip ? assetById(clip.assetId) : null;
  if (!clip || !asset || asset.missing) {
    if (!previewAudio.paused) previewAudio.pause();
    audioClipId = null;
    return;
  }
  applyGain(previewAudio, clip);
  const sourceTime = clip.in + (timelineTime - clip.start);
  audioClipId = clip.id;
  if (previewAudio.getAttribute('src') !== asset.url) {
    const clipId = clip.id;
    previewAudio.src = asset.url;
    previewAudio.addEventListener('loadeddata', () => {
      if (audioClipId !== clipId) return;
      const current = clipAt(trackByType('audio'), timelineTime);
      if (!current || current.id !== clipId) return;
      followSourceTime(previewAudio, current.in + (timelineTime - current.start), true);
    }, { once: true });
    return;
  }
  const drift = Math.abs((previewAudio.currentTime || 0) - sourceTime);
  const videoIsMaster = Boolean(clipAt(trackByType('video'), timelineTime));
  if (!previewAudio.seeking && (scrub || drift > (videoIsMaster ? 0.2 : 0.35))) {
    previewAudio.currentTime = sourceTime;
  }
  if (playing && previewAudio.paused && !previewAudio.seeking) previewAudio.play().catch(() => {});
  if (!playing && !previewAudio.paused) previewAudio.pause();
}

function followSourceTime(media, sourceTime, scrub) {
  const drift = Math.abs((media.currentTime || 0) - sourceTime);
  if (!media.seeking && (scrub || drift > 0.35)) media.currentTime = Math.max(0, sourceTime);
  if (playing && media.paused && !media.seeking) media.play().catch(() => {});
  if (!playing && !media.paused) media.pause();
}

function mediaClock(clip, media, activeId) {
  if (!clip || activeId !== clip.id || media.readyState < 2 || media.paused || media.seeking) return null;
  const mapped = clip.start + (media.currentTime - clip.in);
  if (!Number.isFinite(mapped)) return null;
  return Math.min(mapped, clip.start + clipLength(clip));
}

function applyGain(media, clip) {
  media.muted = Boolean(clip.muted);
  media.volume = Math.min(1, Math.max(0, Number(clip.volume ?? 1)));
}

function drawFrame() {
  if (!usingTimeline()) return;
  const width = sequence.settings.width;
  const height = sequence.settings.height;
  if (previewCanvas.width !== width || previewCanvas.height !== height) {
    previewCanvas.width = width;
    previewCanvas.height = height;
  }
  const ctx = previewCanvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  const videoClip = clipAt(trackByType('video'), timelineTime);
  if (videoClip && previewVideo.readyState >= 2) {
    const rect = containRect(previewVideo.videoWidth, previewVideo.videoHeight, width, height);
    if (rect.w > 0 && rect.h > 0) ctx.drawImage(previewVideo, rect.x, rect.y, rect.w, rect.h);
  }
  const overlayClip = clipAt(trackByType('overlay'), timelineTime);
  const overlayAsset = overlayClip ? assetById(overlayClip.assetId) : null;
  if (overlayClip && overlayAsset) drawOverlayClip(ctx, overlayClip, overlayAsset);
  previewCanvas.hidden = false;
}

function drawOverlayClip(ctx, clip, asset) {
  const source = overlaySource(asset);
  if (!source) return;
  const transform = clip.transform || defaultTransform(asset);
  const scale = Number(transform.scale) || 1;
  const drawX = Number(transform.x) || 0;
  const drawY = Number(transform.y) || 0;
  const drawW = source.width * scale;
  const drawH = source.height * scale;
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, Number(transform.opacity ?? 1)));
  ctx.drawImage(source.element, drawX, drawY, drawW, drawH);
  ctx.restore();
  if (clip.id === selectedClipId) drawOverlayChrome(ctx, drawX, drawY, drawW, drawH);
}

function overlaySource(asset) {
  if (!asset || asset.missing) return null;
  if (asset.type === 'image') {
    const image = imageCache.get(asset.id);
    if (!(image instanceof HTMLImageElement) || !image.naturalWidth) return null;
    return { element: image, width: image.naturalWidth, height: image.naturalHeight };
  }
  if (asset.type === 'video' && overlayVideo.readyState >= 2 && overlayVideo.videoWidth) {
    return { element: overlayVideo, width: overlayVideo.videoWidth, height: overlayVideo.videoHeight };
  }
  return null;
}

function ensureImage(asset) {
  if (!asset || asset.missing || imageCache.has(asset.id)) return;
  imageCache.set(asset.id, null);
  fetch(asset.url)
    .then((response) => {
      if (!response.ok) throw new Error('Could not read image');
      return response.blob();
    })
    .then((blob) => {
      const image = new Image();
      image.onload = () => {
        imageCache.set(asset.id, image);
        paintThumb(asset.id, image, image.naturalWidth, image.naturalHeight);
        if (usingTimeline()) drawFrame();
      };
      image.onerror = () => imageCache.delete(asset.id);
      image.src = URL.createObjectURL(blob);
    })
    .catch(() => imageCache.delete(asset.id));
}

function showSourceImage(asset) {
  const image = new Image();
  image.onload = () => {
    if (usingTimeline() || selectedAsset()?.id !== asset.id) return;
    previewCanvas.width = image.naturalWidth;
    previewCanvas.height = image.naturalHeight;
    previewCanvas.getContext('2d').drawImage(image, 0, 0);
    previewCanvas.hidden = false;
    previewEmpty.hidden = true;
  };
  image.onerror = () => showPreviewMessage('Could not preview this image');
  image.src = asset.url;
}

function placeClip(track, asset, start) {
  const duration = clipDuration(asset);
  const nextStart = nudgeStart(track, start, duration);
  track.clips.push({
    id: crypto.randomUUID(),
    assetId: asset.id,
    start: nextStart,
    in: 0,
    out: duration,
    volume: 1,
    muted: false,
    transform: track.type === 'overlay' ? defaultTransform(asset) : null,
  });
  if (asset.type === 'image') ensureImage(asset);
  else if (asset.type === 'video') queueThumb(asset);
}

function renderTimeline() {
  const width = Math.max(timelineScroll.clientWidth, Math.max(sequenceDuration() + 8, 20) * pixelsPerSecond);
  timeArea.style.width = `${width}px`;
  timeArea.style.setProperty('--second', `${pixelsPerSecond}px`);
  ruler.replaceChildren();
  const seconds = Math.ceil(width / pixelsPerSecond);
  const step = rulerStep();
  for (let second = 0; second <= seconds; second += step) {
    const mark = document.createElement('span');
    mark.className = 'ruler-mark';
    mark.style.left = `${second * pixelsPerSecond}px`;
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
      block.dataset.clipId = clip.id;
      if (clip.id === selectedClipId) block.classList.add('is-selected');
      if (!asset || asset.missing) block.classList.add('is-missing');
      block.style.left = `${clip.start * pixelsPerSecond}px`;
      block.style.width = `${Math.max(clipLength(clip) * pixelsPerSecond, 8)}px`;
      const thumbUrl = asset && track.type !== 'audio' ? thumbCache.get(asset.id) : '';
      if (thumbUrl) {
        block.classList.add('has-thumb');
        block.style.backgroundImage = `linear-gradient(90deg, rgb(0 0 0 / 20%), rgb(0 0 0 / 62%)), url("${thumbUrl}")`;
      }

      const left = document.createElement('span');
      left.className = 'trim';
      left.dataset.handle = 'left';
      const label = document.createElement('span');
      label.className = 'clip-label';
      label.textContent = asset ? asset.name : 'Missing';
      label.title = formatDuration(clipLength(clip));
      const right = document.createElement('span');
      right.className = 'trim';
      right.dataset.handle = 'right';
      block.append(left, label, right);
      block.addEventListener('pointerdown', (event) => startClipDrag(event, clip, track, block));
      lane.append(block);
    }
  }
  playhead.style.left = `${timelineTime * pixelsPerSecond}px`;
}

function startClipDrag(event, clip, track, block) {
  if (event.button !== 0) return;
  event.stopPropagation();
  selectedClipId = clip.id;
  selectedId = clip.assetId;
  renderMedia();
  for (const node of document.querySelectorAll('.clip')) {
    node.classList.toggle('is-selected', node.dataset.clipId === selectedClipId);
  }
  renderInspector();
  if (playing) pauseTimeline();

  const handle = event.target.closest('[data-handle]')?.dataset.handle || '';
  const originX = event.clientX;
  const origin = { start: clip.start, in: clip.in, out: clip.out };
  block.setPointerCapture(event.pointerId);
  const move = (ev) => {
    dragClip(clip, track, handle, origin, (ev.clientX - originX) / pixelsPerSecond, block);
    setTimelineTime(timelineTime, true);
  };
  clipDragging = true;
  const up = () => {
    clipDragging = false;
    hideSnapGuide();
    block.removeEventListener('pointermove', move);
    block.removeEventListener('pointerup', up);
    commitEdit();
    renderTimeline();
    renderInspector();
    setTimelineTime(timelineTime, true);
  };
  block.addEventListener('pointermove', move);
  block.addEventListener('pointerup', up);
}

function dragClip(clip, track, handle, origin, delta, block) {
  const asset = assetById(clip.assetId);
  const sourceMax = asset && asset.type !== 'image' && Number.isFinite(asset.duration) ? asset.duration : origin.in + 60;
  const proposed = proposeClipEdit(origin, delta, handle, asset, sourceMax);
  if (!proposed || !clipEditFits(track, clip, proposed)) {
    hideSnapGuide();
    return;
  }
  const snapped = snapClipEdit(proposed, handle, track, clip, asset, sourceMax);
  const next = snapped && clipEditFits(track, clip, snapped) ? snapped : proposed;
  if (next === snapped && snapped.guide != null) showSnapGuide(snapped.guide);
  else hideSnapGuide();
  clip.start = next.start;
  clip.in = next.in;
  clip.out = next.out;
  block.style.left = `${clip.start * pixelsPerSecond}px`;
  block.style.width = `${Math.max(clipLength(clip) * pixelsPerSecond, 8)}px`;
}

function splitAtPlayhead() {
  const found = splittableClip();
  if (!found) return;
  const { track, clip } = found;
  const local = timelineTime - clip.start;
  const length = clipLength(clip);
  if (local <= 0.05 || local >= length - 0.05) return;
  const splitPoint = clip.in + local;
  track.clips.push({
    id: crypto.randomUUID(),
    assetId: clip.assetId,
    start: clip.start + local,
    in: splitPoint,
    out: clip.out,
    volume: clip.volume,
    muted: clip.muted,
    transform: clip.transform ? { ...clip.transform } : null,
  });
  clip.out = splitPoint;
  selectedClipId = track.clips[track.clips.length - 1].id;
  commitEdit();
  renderTimeline();
  renderInspector();
  setTimelineTime(timelineTime, true);
}

function deleteSelected() {
  const found = findClip(selectedClipId);
  if (!found) return;
  found.track.clips = found.track.clips.filter((clip) => clip.id !== selectedClipId);
  selectedClipId = null;
  commitEdit();
  renderTimeline();
  renderInspector();
  if (!usingTimeline()) {
    pauseTimeline();
    showEmptyPreview();
    updateCommandButtons();
    return;
  }
  setTimelineTime(Math.min(timelineTime, sequenceDuration()), true);
}

function splittableClip() {
  const selected = findClip(selectedClipId);
  if (selected && clipAt(selected.track, timelineTime)?.id === selected.clip.id) return selected;
  for (const type of ['video', 'overlay', 'audio']) {
    const track = trackByType(type);
    const clip = clipAt(track, timelineTime);
    if (clip) return { track, clip };
  }
  return null;
}

function renderInspector() {
  inspector.replaceChildren();
  updateCommandButtons();
  const found = findClip(selectedClipId);
  if (!found) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    const text = document.createElement('p');
    text.textContent = 'Select a clip to edit it. Space plays, arrows step frames, S splits, and Ctrl+C copies.';
    hint.append(text);
    inspector.append(hint);
    return;
  }

  const { clip } = found;
  const asset = assetById(clip.assetId);
  const card = document.createElement('div');
  card.className = 'inspector-card';
  const title = document.createElement('h3');
  title.textContent = asset?.name || 'Missing clip';
  const meta = document.createElement('p');
  meta.className = 'inspector-meta';
  meta.textContent = `${typeLabel(found.track.type)} · ${formatDuration(clipLength(clip)) || '0:00'}`;
  card.append(title, meta);
  if (!asset || asset.missing) {
    const missing = document.createElement('p');
    missing.className = 'notice';
    missing.textContent = 'The original file is missing.';
    card.append(missing);
  }

  if (found.track.type === 'overlay' && asset) {
    const transform = clip.transform || defaultTransform(asset);
    clip.transform = transform;
    addNumber(card, 'X', transform.x, -4000, 4000, 1, (value) => { transform.x = value; });
    addNumber(card, 'Y', transform.y, -4000, 4000, 1, (value) => { transform.y = value; });
    addNumber(card, 'Scale', transform.scale, 0.1, 8, 0.1, (value) => { transform.scale = value; });
    addRange(card, 'Opacity', transform.opacity, 0, 1, 0.05, (value) => { transform.opacity = value; });
  }

  if (asset && (asset.type === 'video' || found.track.type === 'audio')) {
    addRange(card, found.track.type === 'video' ? 'Video audio' : 'Volume', clip.volume ?? 1, 0, 1, 0.05, (value) => {
      clip.volume = value;
      setTimelineTime(timelineTime, true);
    });
    const mute = document.createElement('label');
    mute.className = 'control check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = Boolean(clip.muted);
    box.addEventListener('change', () => {
      clip.muted = box.checked;
      commitEdit();
      setTimelineTime(timelineTime, true);
    });
    mute.append(box, document.createTextNode('Mute'));
    card.append(mute);
  }

  inspector.append(card);
}

function addNumber(parent, label, value, min, max, step, apply) {
  const wrap = document.createElement('label');
  wrap.className = 'control';
  wrap.append(document.createTextNode(label));
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(Math.round(Number(value) * 1000) / 1000);
  input.addEventListener('input', () => {
    apply(Number(input.value));
    drawFrame();
  });
  input.addEventListener('change', () => commitEdit());
  wrap.append(input);
  parent.append(wrap);
}

function addRange(parent, label, value, min, max, step, apply) {
  const wrap = document.createElement('label');
  wrap.className = 'control';
  const caption = document.createElement('span');
  caption.textContent = `${label} · ${Math.round(Number(value) * 100)}%`;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    apply(Number(input.value));
    caption.textContent = `${label} · ${Math.round(Number(input.value) * 100)}%`;
    drawFrame();
  });
  input.addEventListener('change', () => commitEdit());
  wrap.append(caption, input);
  parent.append(wrap);
}

function commitEdit() {
  const snap = JSON.stringify(sequence.tracks);
  if (history[historyIndex] === snap) return;
  history.splice(historyIndex + 1);
  history.push(snap);
  if (history.length > 80) history.shift();
  historyIndex = history.length - 1;
  dirty = historyIndex !== savedHistoryIndex;
  updateTitle();
  updateCommandButtons();
}

function resetHistory() {
  history.splice(0, history.length, JSON.stringify(sequence.tracks));
  historyIndex = 0;
  savedHistoryIndex = 0;
  dirty = false;
  updateCommandButtons();
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex -= 1;
  restoreHistory();
}

function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex += 1;
  restoreHistory();
}

function restoreHistory() {
  sequence.tracks = JSON.parse(history[historyIndex]);
  if (selectedClipId && !findClip(selectedClipId)) selectedClipId = null;
  dirty = historyIndex !== savedHistoryIndex;
  renderTimeline();
  renderInspector();
  updateTitle();
  if (!usingTimeline()) {
    pauseTimeline();
    showEmptyPreview();
    updateCommandButtons();
    return;
  }
  setTimelineTime(Math.min(timelineTime, sequenceDuration()), true);
}

function updateCommandButtons() {
  undoButton.disabled = historyIndex <= 0;
  redoButton.disabled = historyIndex >= history.length - 1;
  deleteButton.disabled = !findClip(selectedClipId);
  copyButton.disabled = !findClip(selectedClipId);
  pasteButton.disabled = !clipboard;
  splitButton.disabled = !splittableClip();
  exportButton.disabled = exporting || sequenceDuration() <= 0;
}

function updateTitle() {
  const name = projectPath ? projectPath.split(/[\\/]/).pop() : 'Untitled';
  projectName.textContent = dirty ? `${name} · edited` : name;
  document.title = `FrameEdit — ${name}`;
}

function showNotice(message) {
  notice.hidden = false;
  notice.textContent = message;
}

function clearNotice() {
  notice.hidden = true;
  notice.textContent = '';
}

function showErrors(errors) {
  if (!errors || errors.length === 0) {
    mediaError.hidden = true;
    mediaError.textContent = '';
    return;
  }
  mediaError.hidden = false;
  mediaError.textContent = errors.map((error) => (error.name ? `${error.name}: ${error.message}` : error.message)).join(' ');
}

function showPreviewMessage(message) {
  previewCanvas.hidden = true;
  previewVideo.classList.remove('is-underlay');
  previewAudioLabel.hidden = true;
  previewEmpty.hidden = false;
  previewEmpty.textContent = message;
}

function showEmptyPreview() {
  previewVideo.pause();
  overlayVideo.pause();
  previewAudio.pause();
  previewVideo.classList.remove('is-underlay');
  previewVideo.removeAttribute('src');
  previewVideo.load();
  overlayVideo.removeAttribute('src');
  overlayVideo.load();
  previewAudio.removeAttribute('src');
  previewAudio.load();
  previewCanvas.hidden = true;
  previewAudioLabel.hidden = true;
  previewEmpty.hidden = false;
  previewEmpty.textContent = 'Drop a clip on the timeline';
  videoClipId = null;
  overlayClipId = null;
  audioClipId = null;
  playToggle.disabled = true;
  playToggle.textContent = 'Play';
  seek.disabled = true;
  seek.value = '0';
  seek.max = '0';
  timecode.textContent = formatTimecode(0);
  timelineTime = 0;
  playhead.style.left = '0px';
}

function stopSource() {
  previewVideo.pause();
  overlayVideo.pause();
  previewAudio.pause();
  previewVideo.classList.remove('is-underlay');
  previewVideo.removeAttribute('src');
  previewVideo.load();
  overlayVideo.removeAttribute('src');
  overlayVideo.load();
  previewAudio.removeAttribute('src');
  previewAudio.load();
  previewCanvas.hidden = true;
  previewAudioLabel.hidden = true;
  previewEmpty.hidden = false;
  previewEmpty.textContent = 'Drop a clip on the timeline';
  playToggle.textContent = 'Play';
  playToggle.disabled = true;
  seek.disabled = true;
  seek.value = '0';
  seek.max = '0';
  timecode.textContent = formatTimecode(0);
}

function keepPlayheadVisible() {
  const x = timelineTime * pixelsPerSecond;
  const margin = 48;
  if (x < timelineScroll.scrollLeft + margin) timelineScroll.scrollLeft = Math.max(0, x - margin);
  else if (x > timelineScroll.scrollLeft + timelineScroll.clientWidth - margin) {
    timelineScroll.scrollLeft = x - timelineScroll.clientWidth + margin;
  }
}

function containRect(sourceWidth, sourceHeight, width, height) {
  if (!sourceWidth || !sourceHeight) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const w = sourceWidth * scale;
  const h = sourceHeight * scale;
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

function defaultTransform(asset) {
  const w = asset.width || 100;
  const h = asset.height || 100;
  return {
    x: Math.round((sequence.settings.width - w) / 2),
    y: Math.round((sequence.settings.height - h) / 2),
    scale: 1,
    opacity: 1,
  };
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
  if (!track) return null;
  return track.clips.find((clip) => {
    const end = clip.start + clipLength(clip);
    if (time >= clip.start && time < end) return true;
    return time > clip.start && Math.abs(time - end) < 0.0001 && Math.abs(time - sequenceDuration()) < 0.0001;
  }) || null;
}

function findClip(id) {
  if (!id) return null;
  for (const track of sequence.tracks) {
    const clip = track.clips.find((item) => item.id === id);
    if (clip) return { track, clip };
  }
  return null;
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

function overlaps(track, clip, start, end) {
  return track.clips.some((other) => other.id !== clip.id && rangesOverlap(start, end, other.start, other.start + clipLength(other)));
}

function trackAccepts(trackType, assetType) {
  if (trackType === 'overlay') return assetType === 'image' || assetType === 'video';
  return trackType === assetType;
}

function trackByType(type) {
  return sequence.tracks.find((track) => track.type === type);
}

function timeAtClientX(clientX) {
  const rect = timeArea.getBoundingClientRect();
  return Math.max(0, (clientX - rect.left) / pixelsPerSecond);
}

function activeSource() {
  const asset = selectedAsset();
  if (!asset || asset.type === 'image' || asset.missing) return null;
  return asset.type === 'video' ? previewVideo : previewAudio;
}

function selectedAsset() {
  return assets.find((asset) => asset.id === selectedId) || null;
}

function assetById(id) {
  return assets.find((asset) => asset.id === id) || null;
}

function formatMeta(asset) {
  const parts = [];
  const duration = formatDuration(asset.duration);
  if (duration) parts.push(duration);
  if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  return parts.join(' · ');
}

function typeLabel(type) {
  if (type === 'video') return 'Video';
  if (type === 'audio') return 'Audio';
  if (type === 'overlay') return 'Overlay';
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
  const fps = Math.max(1, Math.round(Number(sequence.settings.fps) || 30));
  const totalFrames = Math.max(0, Math.round((Number(seconds) || 0) * fps));
  const frames = totalFrames % fps;
  const total = Math.floor(totalFrames / fps);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const clock = [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
  return `${clock}:${String(frames).padStart(2, '0')}`;
}

function frameDuration() {
  const fps = Number(sequence.settings.fps) || 30;
  return 1 / (fps > 0 ? fps : 30);
}

function stepTimeline(delta) {
  if (!usingTimeline()) return;
  if (playing) pauseTimeline();
  const fps = Number(sequence.settings.fps) || 30;
  if (delta === Infinity) setTimelineTime(sequenceDuration(), true);
  else if (delta === -Infinity) setTimelineTime(0, true);
  else setTimelineTime((Math.round(timelineTime * fps) + Math.round(delta * fps)) / fps, true);
  keepPlayheadVisible();
}

function copySelected() {
  const found = findClip(selectedClipId);
  if (!found) return;
  clipboard = {
    trackType: found.track.type,
    clip: JSON.parse(JSON.stringify(found.clip)),
  };
  updateCommandButtons();
}

function pasteClipboard() {
  if (!clipboard) return;
  const track = trackByType(clipboard.trackType);
  if (!track) return;
  const source = clipboard.clip;
  const length = Math.max(MIN_CLIP, clipLength(source));
  const start = nudgeStart(track, timelineTime, length);
  const clip = {
    ...JSON.parse(JSON.stringify(source)),
    id: crypto.randomUUID(),
    start,
  };
  track.clips.push(clip);
  selectedClipId = clip.id;
  selectedId = clip.assetId;
  const asset = assetById(clip.assetId);
  if (asset?.type === 'image') ensureImage(asset);
  commitEdit();
  renderMedia();
  renderTimeline();
  renderInspector();
  if (playing) pauseTimeline();
  setTimelineTime(timelineTime, true);
}

function setZoom(next, anchorTime, clientX) {
  const leftTime = timelineScroll.scrollLeft / pixelsPerSecond;
  pixelsPerSecond = Math.min(MAX_PX, Math.max(MIN_PX, next));
  zoomRange.value = String(Math.round(pixelsPerSecond));
  renderTimeline();
  if (anchorTime != null && clientX != null) {
    const viewLeft = clientX - timelineScroll.getBoundingClientRect().left;
    timelineScroll.scrollLeft = anchorTime * pixelsPerSecond - viewLeft;
  } else {
    timelineScroll.scrollLeft = leftTime * pixelsPerSecond;
  }
}

function rulerStep() {
  if (pixelsPerSecond >= 140) return 1;
  if (pixelsPerSecond >= 40) return 5;
  return 10;
}

function proposeClipEdit(origin, delta, handle, asset, sourceMax) {
  if (handle === 'left') {
    if (!asset || asset.type === 'image') {
      const length = Math.min(60, Math.max(MIN_CLIP, (origin.out - origin.in) - delta));
      return {
        start: origin.start + ((origin.out - origin.in) - length),
        in: 0,
        out: length,
      };
    }
    const inPoint = Math.min(origin.out - MIN_CLIP, Math.max(0, origin.in + delta));
    return {
      start: origin.start + (inPoint - origin.in),
      in: inPoint,
      out: origin.out,
    };
  }
  if (handle === 'right') {
    return {
      start: origin.start,
      in: origin.in,
      out: Math.min(sourceMax, Math.max(origin.in + MIN_CLIP, origin.out + delta)),
    };
  }
  return {
    start: Math.max(0, origin.start + delta),
    in: origin.in,
    out: origin.out,
  };
}

function clipEditFits(track, clip, edit) {
  const length = edit.out - edit.in;
  return edit.start >= 0 && length >= MIN_CLIP && !overlaps(track, clip, edit.start, edit.start + length);
}

function snapClipEdit(edit, handle, track, clip, asset, sourceMax) {
  const length = edit.out - edit.in;
  const threshold = SNAP_PX / pixelsPerSecond;
  const options = [];
  if (handle === 'right') {
    const end = nearestSnap(edit.start + length, clip.id, threshold);
    if (end != null) {
      const out = edit.in + (end - edit.start);
      if (out >= edit.in + MIN_CLIP && out <= sourceMax) {
        options.push({ start: edit.start, in: edit.in, out, guide: end });
      }
    }
  } else if (handle === 'left') {
    const start = nearestSnap(edit.start, clip.id, threshold);
    if (start != null) {
      const nextLength = length + (edit.start - start);
      if (!asset || asset.type === 'image') {
        if (nextLength >= MIN_CLIP && nextLength <= 60) {
          options.push({ start, in: 0, out: nextLength, guide: start });
        }
      } else {
        const inPoint = edit.out - nextLength;
        if (inPoint >= 0 && nextLength >= MIN_CLIP) {
          options.push({ start, in: inPoint, out: edit.out, guide: start });
        }
      }
    }
  } else {
    const startSnap = nearestSnap(edit.start, clip.id, threshold);
    const endSnap = nearestSnap(edit.start + length, clip.id, threshold);
    if (startSnap != null) {
      options.push({
        start: startSnap,
        in: edit.in,
        out: edit.out,
        guide: startSnap,
        dist: Math.abs(edit.start - startSnap),
      });
    }
    if (endSnap != null) {
      options.push({
        start: endSnap - length,
        in: edit.in,
        out: edit.out,
        guide: endSnap,
        dist: Math.abs(edit.start + length - endSnap),
      });
    }
    options.sort((a, b) => a.dist - b.dist);
  }
  return options.find((item) => clipEditFits(track, clip, item)) || null;
}

function nearestSnap(time, ignoreClipId, threshold) {
  let best = null;
  let bestDist = threshold;
  for (const point of snapTargets(ignoreClipId)) {
    const dist = Math.abs(time - point);
    if (dist <= bestDist) {
      bestDist = dist;
      best = point;
    }
  }
  return best;
}

function snapTargets(ignoreClipId) {
  const points = [0, timelineTime];
  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      if (clip.id === ignoreClipId) continue;
      points.push(clip.start, clip.start + clipLength(clip));
    }
  }
  return points;
}

function showSnapGuide(time) {
  snapGuide.hidden = false;
  snapGuide.style.left = `${time * pixelsPerSecond}px`;
}

function hideSnapGuide() {
  snapGuide.hidden = true;
}

function nudgeStart(track, start, duration, ignoreId) {
  let next = Math.max(0, start);
  const existing = track.clips.filter((clip) => clip.id !== ignoreId).sort((a, b) => a.start - b.start);
  for (let guard = 0; guard < existing.length + 1; guard += 1) {
    const hit = existing.find((clip) => rangesOverlap(next, next + duration, clip.start, clip.start + clipLength(clip)));
    if (!hit) break;
    next = hit.start + clipLength(hit);
  }
  return next;
}

function overlayGeometry() {
  if (!usingTimeline() || previewCanvas.hidden) return null;
  const clip = clipAt(trackByType('overlay'), timelineTime);
  if (!clip) return null;
  const asset = assetById(clip.assetId);
  const source = asset ? overlaySource(asset) : null;
  if (!source) return null;
  const transform = clip.transform || defaultTransform(asset);
  clip.transform = transform;
  const scale = Number(transform.scale) || 1;
  return {
    clip,
    asset,
    sourceWidth: source.width,
    sourceHeight: source.height,
    transform,
    x: Number(transform.x) || 0,
    y: Number(transform.y) || 0,
    w: source.width * scale,
    h: source.height * scale,
  };
}

function pointerToCanvas(event) {
  const rect = previewCanvas.getBoundingClientRect();
  const width = sequence.settings.width;
  const height = sequence.settings.height;
  const scale = Math.min(rect.width / width, rect.height / height) || 1;
  const drawnW = width * scale;
  const drawnH = height * scale;
  const offsetX = rect.left + (rect.width - drawnW) / 2;
  const offsetY = rect.top + (rect.height - drawnH) / 2;
  return {
    x: (event.clientX - offsetX) / scale,
    y: (event.clientY - offsetY) / scale,
    scale,
  };
}

function handleSize(viewScale) {
  return 12 / (viewScale || 1);
}

function overlayHit(event) {
  const geo = overlayGeometry();
  if (!geo) return null;
  const point = pointerToCanvas(event);
  const size = handleSize(point.scale);
  const selected = geo.clip.id === selectedClipId;
  const nearCorner = selected
    && Math.abs(point.x - (geo.x + geo.w)) <= size
    && Math.abs(point.y - (geo.y + geo.h)) <= size;
  if (nearCorner) return { ...geo, mode: 'scale' };
  const inside = point.x >= geo.x && point.x <= geo.x + geo.w && point.y >= geo.y && point.y <= geo.y + geo.h;
  if (!inside) return null;
  return { ...geo, mode: 'move' };
}

function drawOverlayChrome(ctx, x, y, w, h) {
  const rect = previewCanvas.getBoundingClientRect();
  const viewScale = Math.min(rect.width / sequence.settings.width, rect.height / sequence.settings.height) || 1;
  const size = handleSize(viewScale);
  ctx.save();
  ctx.strokeStyle = '#ffd36a';
  ctx.lineWidth = 1.5 / viewScale;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#ffd36a';
  ctx.fillRect(x + w - size / 2, y + h - size / 2, size, size);
  ctx.restore();
}

function startOverlayDrag(event) {
  if (event.button !== 0) return;
  const hit = overlayHit(event);
  if (!hit) return;
  event.preventDefault();
  event.stopPropagation();
  if (playing) pauseTimeline();
  previewCanvas.style.cursor = hit.mode === 'scale' ? 'nwse-resize' : 'move';
  selectedClipId = hit.clip.id;
  selectedId = hit.clip.assetId;
  renderMedia();
  renderTimeline();
  renderInspector();
  const point = pointerToCanvas(event);
  const origin = {
    x: hit.transform.x,
    y: hit.transform.y,
    scale: Number(hit.transform.scale) || 1,
    pointerX: point.x,
    pointerY: point.y,
  };
  overlayDrag = { ...hit, origin };
  previewCanvas.setPointerCapture(event.pointerId);
  const move = (ev) => {
    if (!overlayDrag) return;
    const current = pointerToCanvas(ev);
    const { transform, sourceWidth, sourceHeight, origin: start } = overlayDrag;
    if (overlayDrag.mode === 'scale') {
      const baseW = sourceWidth * start.scale;
      const baseH = sourceHeight * start.scale;
      const origDist = Math.hypot(baseW, baseH) || 1;
      const dist = Math.hypot(current.x - start.x, current.y - start.y);
      transform.scale = Math.min(8, Math.max(0.1, start.scale * (dist / origDist)));
    } else {
      transform.x = start.x + (current.x - start.pointerX);
      transform.y = start.y + (current.y - start.pointerY);
    }
    drawFrame();
  };
  const up = () => {
    overlayDrag = null;
    previewCanvas.removeEventListener('pointermove', move);
    previewCanvas.removeEventListener('pointerup', up);
    previewCanvas.style.cursor = '';
    commitEdit();
    renderInspector();
    drawFrame();
    if (thumbsStale) refreshThumbs();
  };
  previewCanvas.addEventListener('pointermove', move);
  previewCanvas.addEventListener('pointerup', up);
}

function hasFiles(event) {
  return [...event.dataTransfer.types].includes('Files');
}

function queueThumb(asset) {
  if (!asset || asset.missing || asset.type === 'audio' || thumbCache.has(asset.id)) return;
  thumbCache.set(asset.id, '');
  thumbQueue.push(asset);
  pumpThumbs();
}

function pumpThumbs() {
  if (thumbRunning) return;
  thumbRunning = true;
  const step = () => {
    const asset = thumbQueue.shift();
    if (!asset) {
      thumbRunning = false;
      return;
    }
    captureVideoThumb(asset).then((url) => {
      const current = assets.some((item) => item.id === asset.id);
      if (url && current) thumbCache.set(asset.id, url);
      else {
        if (url) URL.revokeObjectURL(url);
        thumbCache.delete(asset.id);
      }
      if (url && current) refreshThumbs();
      step();
    }).catch(() => {
      thumbCache.delete(asset.id);
      step();
    });
  };
  step();
}

function captureVideoThumb(asset) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    let settled = false;
    const finish = (url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      resolve(url);
    };
    const timer = setTimeout(() => finish(null), 8000);
    video.addEventListener('error', () => finish(null), { once: true });
    video.addEventListener('loadeddata', () => {
      const target = Math.min(0.15, Number.isFinite(video.duration) ? video.duration / 2 : 0);
      const paint = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#111318';
        ctx.fillRect(0, 0, 160, 90);
        const rect = containRect(video.videoWidth, video.videoHeight, 160, 90);
        if (rect.w > 0 && rect.h > 0) ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h);
        canvas.toBlob((blob) => finish(blob ? URL.createObjectURL(blob) : null));
      };
      if (target > 0.01) {
        video.addEventListener('seeked', paint, { once: true });
        video.currentTime = target;
      } else paint();
    }, { once: true });
    video.src = asset.url;
  });
}

function paintThumb(assetId, source, sourceWidth, sourceHeight) {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#111318';
  ctx.fillRect(0, 0, 160, 90);
  const rect = containRect(sourceWidth, sourceHeight, 160, 90);
  if (rect.w > 0 && rect.h > 0) ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h);
  canvas.toBlob((blob) => {
    if (!blob || !assets.some((item) => item.id === assetId)) return;
    const previous = thumbCache.get(assetId);
    if (previous) URL.revokeObjectURL(previous);
    thumbCache.set(assetId, URL.createObjectURL(blob));
    refreshThumbs();
  });
}

function refreshThumbs() {
  if (clipDragging || overlayDrag) {
    thumbsStale = true;
    return;
  }
  thumbsStale = false;
  renderMedia();
  renderTimeline();
}

function clearThumbs() {
  thumbQueue.splice(0, thumbQueue.length);
  for (const url of thumbCache.values()) {
    if (url) URL.revokeObjectURL(url);
  }
  thumbCache.clear();
}

resetHistory();
renderTimeline();
renderInspector();
updateTitle();

window.frameedit.lastProject().then((last) => {
  if (last?.project) applyProject(last.path, last.project);
}).catch(() => {});
