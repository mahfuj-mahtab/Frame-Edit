const { app, BrowserWindow, dialog, ipcMain, net, protocol } = require('electron');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const path = require('path');
const ffmpegStatic = require('ffmpeg-static');
const { describeMedia, mediaKind, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, AUDIO_EXTENSIONS } = require('./probe');
const { buildExportArgs, runExport } = require('./export');
const { loadProject, writeProject, readRecent, writeRecent, mediaUrl } = require('./project');

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

let exportJob = null;

function extensionsOf(extensionSet) {
  return [...extensionSet].map((extension) => extension.slice(1));
}

function ffmpegPath() {
  return ffmpegStatic ? ffmpegStatic.replaceAll('app.asar', 'app.asar.unpacked') : '';
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

function registerMediaProtocol() {
  protocol.handle('media', (request) => {
    const filePath = decodeURIComponent(new URL(request.url).pathname);
    if (!path.isAbsolute(filePath) || !mediaKind(filePath)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).href);
  });
}

function registerHandlers() {
  ipcMain.handle('media:import', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: MEDIA_FILTERS,
    });
    if (result.canceled) return { canceled: true, assets: [], errors: [] };
    return importPaths(result.filePaths);
  });

  ipcMain.handle('media:import-paths', async (_event, filePaths) => {
    const paths = Array.isArray(filePaths) ? filePaths.filter((item) => typeof item === 'string' && path.isAbsolute(item)) : [];
    if (paths.length === 0) return { canceled: true, assets: [], errors: [] };
    return importPaths(paths);
  });

  ipcMain.handle('project:save', async (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    let target = payload?.filePath || null;
    if (!target) {
      const result = await dialog.showSaveDialog(win, {
        title: 'Save project',
        defaultPath: 'Untitled.frameedit',
        filters: [{ name: 'FrameEdit project', extensions: ['frameedit'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      target = result.filePath;
    }
    const saved = writeProject(target, payload.project);
    writeRecent(app.getPath('userData'), saved);
    return { canceled: false, path: saved };
  });

  ipcMain.handle('project:open', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      title: 'Open project',
      properties: ['openFile'],
      filters: [{ name: 'FrameEdit project', extensions: ['frameedit'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const filePath = result.filePaths[0];
    const project = loadProject(filePath);
    writeRecent(app.getPath('userData'), filePath);
    return { canceled: false, path: filePath, project };
  });

  ipcMain.handle('project:last', () => {
    const filePath = readRecent(app.getPath('userData'));
    if (!filePath) return null;
    try {
      return { path: filePath, project: loadProject(filePath) };
    } catch {
      return null;
    }
  });

  ipcMain.handle('export:start', async (event, payload) => {
    if (exportJob) throw new Error('An export is already running');
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, {
      title: 'Export video',
      defaultPath: payload?.defaultName || 'export.mp4',
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const output = result.filePath.endsWith('.mp4') ? result.filePath : `${result.filePath}.mp4`;
    const { args, duration } = buildExportArgs(payload.project, {
      preset: payload.preset,
      quality: payload.quality,
      output,
    });
    const job = runExport({
      ffmpeg: ffmpegPath(),
      args,
      duration,
      onProgress: (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('export:progress', { progress });
      },
    });
    exportJob = job;
    try {
      await job;
      return { canceled: false, path: output };
    } catch (error) {
      if (error.canceled) return { canceled: true };
      throw error;
    } finally {
      exportJob = null;
    }
  });

  ipcMain.handle('export:cancel', () => {
    if (exportJob) exportJob.cancel();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1020,
    minHeight: 680,
    backgroundColor: '#0c0d10',
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

  win.webContents.on('will-navigate', (event) => {
    if (event.url !== win.webContents.getURL()) event.preventDefault();
  });

  win.loadFile(path.join(__dirname, '../src/index.html'));
}

app.whenReady().then(() => {
  registerMediaProtocol();
  registerHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (exportJob) exportJob.cancel();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
