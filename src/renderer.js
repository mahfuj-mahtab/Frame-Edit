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

const assets = [];
let selectedId = null;
let scrubbing = false;

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

playToggle.addEventListener('click', async () => {
  const media = activeMedia();
  if (!media) return;
  if (media.paused) {
    try {
      await media.play();
      playToggle.textContent = 'Pause';
    } catch {
      showPreviewMessage('Could not play this file');
    }
    return;
  }
  media.pause();
  playToggle.textContent = 'Play';
});

seek.addEventListener('pointerdown', () => {
  scrubbing = true;
});
seek.addEventListener('pointerup', () => {
  scrubbing = false;
});
seek.addEventListener('input', () => {
  const media = activeMedia();
  if (!media) return;
  media.currentTime = Number(seek.value);
  timecode.textContent = formatTimecode(media.currentTime);
});

for (const media of [previewVideo, previewAudio]) {
  media.addEventListener('loadedmetadata', onMediaReady);
  media.addEventListener('timeupdate', onMediaTime);
  media.addEventListener('ended', () => {
    if (media === activeMedia()) playToggle.textContent = 'Play';
  });
  media.addEventListener('error', () => {
    if (!media.getAttribute('src') || media !== activeMedia()) return;
    showPreviewMessage('Could not play this file');
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
    mediaList.append(item);
  }
}

function selectAsset(id) {
  if (selectedId === id) return;
  stopPlayback();
  selectedId = id;
  renderMedia();

  const asset = selectedAsset();
  hidePreviewLayers();
  previewEmpty.hidden = true;

  if (asset.type === 'image') {
    showImage(asset);
    return;
  }

  const media = asset.type === 'video' ? previewVideo : previewAudio;
  if (asset.type === 'video') {
    previewVideo.hidden = false;
  } else {
    previewAudioLabel.hidden = false;
    previewAudioLabel.textContent = asset.name;
  }
  playToggle.disabled = false;
  media.src = asset.url;
}

function showImage(asset) {
  const image = new Image();
  image.onload = () => {
    if (!selectedAsset() || selectedAsset().id !== asset.id) return;
    previewCanvas.width = image.naturalWidth;
    previewCanvas.height = image.naturalHeight;
    previewCanvas.getContext('2d').drawImage(image, 0, 0);
    previewCanvas.hidden = false;
    previewEmpty.hidden = true;
  };
  image.onerror = () => {
    if (selectedAsset() && selectedAsset().id === asset.id) {
      showPreviewMessage('Could not preview this image');
    }
  };
  image.src = asset.url;
}

function onMediaReady(event) {
  if (event.target !== activeMedia()) return;
  const duration = Number.isFinite(event.target.duration) ? event.target.duration : 0;
  seek.max = String(duration);
  seek.value = '0';
  seek.disabled = duration <= 0;
  timecode.textContent = formatTimecode(0);
}

function onMediaTime(event) {
  const media = event.target;
  if (media !== activeMedia() || scrubbing) return;
  seek.value = String(media.currentTime);
  timecode.textContent = formatTimecode(media.currentTime);
}

function stopPlayback() {
  for (const media of [previewVideo, previewAudio]) {
    media.pause();
    media.removeAttribute('src');
    media.load();
  }
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
  playToggle.disabled = true;
  seek.disabled = true;
}

function activeMedia() {
  const asset = selectedAsset();
  if (!asset || asset.type === 'image') return null;
  return asset.type === 'video' ? previewVideo : previewAudio;
}

function selectedAsset() {
  return assets.find((asset) => asset.id === selectedId) || null;
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
