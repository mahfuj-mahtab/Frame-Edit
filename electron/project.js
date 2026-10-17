const fs = require('fs');
const path = require('path');

function recentFile(userData) {
  return path.join(userData, 'recent.json');
}

function mediaUrl(filePath) {
  const url = new URL('media://local');
  url.pathname = filePath;
  return url.href;
}

function normalizeProject(project) {
  if (!project || project.version !== 1) throw new Error('This project file is not supported');
  const tracks = ['overlay', 'video', 'audio'].map((type) => {
    const track = (project.tracks || []).find((item) => item.type === type);
    return {
      id: type,
      type,
      clips: Array.isArray(track?.clips) ? track.clips : [],
    };
  });
  const assets = (project.assets || []).map((asset) => ({
    id: asset.id,
    type: asset.type,
    path: asset.path,
    name: asset.name,
    duration: asset.duration ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    hasAudio: Boolean(asset.hasAudio),
    missing: !asset.path || !fs.existsSync(asset.path),
    url: asset.path ? mediaUrl(asset.path) : '',
  }));
  return {
    version: 1,
    settings: {
      width: Number(project.settings?.width) || 1920,
      height: Number(project.settings?.height) || 1080,
      fps: Number(project.settings?.fps) || 30,
    },
    assets,
    tracks,
  };
}

function toDisk(project) {
  const normalized = normalizeProject(project);
  return {
    version: 1,
    settings: normalized.settings,
    assets: normalized.assets.map((asset) => ({
      id: asset.id,
      type: asset.type,
      path: asset.path,
      name: asset.name,
      duration: asset.duration,
      width: asset.width,
      height: asset.height,
      hasAudio: asset.hasAudio,
    })),
    tracks: normalized.tracks,
  };
}

function loadProject(filePath) {
  const project = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return normalizeProject(project);
}

function writeProject(filePath, project) {
  const target = filePath.endsWith('.frameedit') ? filePath : `${filePath}.frameedit`;
  fs.writeFileSync(target, JSON.stringify(toDisk(project), null, 2));
  return target;
}

function readRecent(userData) {
  try {
    const saved = JSON.parse(fs.readFileSync(recentFile(userData), 'utf8'));
    if (!saved.path || !fs.existsSync(saved.path)) return null;
    return saved.path;
  } catch {
    return null;
  }
}

function writeRecent(userData, filePath) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(recentFile(userData), JSON.stringify({ path: filePath }));
}

module.exports = {
  loadProject,
  writeProject,
  readRecent,
  writeRecent,
  mediaUrl,
};
