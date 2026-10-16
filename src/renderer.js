const runtime = document.getElementById('runtime');
const versions = window.frameedit && window.frameedit.versions;

if (versions) {
  runtime.textContent = `Electron ${versions.electron}`;
}

const importButton = document.getElementById('import-media');
const mediaEmpty = document.getElementById('media-empty');
const mediaList = document.getElementById('media-list');
const mediaError = document.getElementById('media-error');
const assets = [];

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

function renderMedia() {
  mediaList.replaceChildren();
  const hasAssets = assets.length > 0;
  mediaEmpty.hidden = hasAssets;
  mediaList.hidden = !hasAssets;

  for (const asset of assets) {
    const item = document.createElement('li');
    item.className = 'media-item';

    const name = document.createElement('span');
    name.className = 'media-name';
    name.textContent = asset.name;
    name.title = asset.path;

    const meta = document.createElement('span');
    meta.className = 'media-meta';
    meta.textContent = formatMeta(asset);

    item.append(name, meta);
    mediaList.append(item);
  }
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
