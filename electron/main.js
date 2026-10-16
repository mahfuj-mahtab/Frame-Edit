const { app, BrowserWindow, dialog, ipcMain, net, protocol } = require('electron');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const path = require('path');
const { describeMedia, mediaKind, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS } = require('./probe');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const MEDIA_FILTERS = [
  {
    name: 'Media',
    extensions: [
      ...extensionsOf(VIDEO_EXTENSIONS),
      ...extensionsOf(AUDIO_EXTENSIONS),
      ...extensionsOf(IMAGE_EXTENSIONS),
    ],
  },
  { name: 'Video', extensions: extensionsOf(VIDEO_EXTENSIONS) },
  { name: 'Audio', extensions: extensionsOf(AUDIO_EXTENSIONS) },
  { name: 'Images', extensions: extensionsOf(IMAGE_EXTENSIONS) },
];

function extensionsOf(extensionSet) {
  return [...extensionSet].map((extension) => extension.slice(1));
}

async function importPaths(filePaths) {
  const assets = [];
  const errors = [];

  for (const filePath of filePaths) {
    try {
      const asset = await describeMedia(filePath);
      assets.push({ id: crypto.randomUUID(), ...asset, url: mediaUrl(asset.path) });
    } catch (error) {
      errors.push({
        name: path.basename(filePath),
        message: error.message || 'Could not read media file',
      });
    }
  }

  return { canceled: false, assets, errors };
}

function mediaUrl(filePath) {
  const url = new URL('media://local');
  url.pathname = filePath;
  return url.href;
}

function registerMediaProtocol() {
  protocol.handle('media', (request) => {
    const filePath = decodeURIComponent(new URL(request.url).pathname);
    if (!path.isAbsolute(filePath) || !mediaKind(filePath)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).href);
  });
}

function registerMediaHandlers() {
  ipcMain.handle('media:import', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: MEDIA_FILTERS,
    });
    if (result.canceled) {
      return { canceled: true, assets: [], errors: [] };
    }
    return importPaths(result.filePaths);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#141414',
    show: false,
    title: 'FrameEdit',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.loadFile(path.join(__dirname, '../src/index.html'));
}

app.whenReady().then(() => {
  registerMediaProtocol();
  registerMediaHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
