/* Fixed-folder saving for the extension workbench. No filesystem work occurs at startup.
 * Call pick/save/list only from an explicit user interaction. Handles stay scoped to
 * the folder selected in the browser's native picker; absolute paths are unavailable.
 */
(function (root) {
  'use strict';
  let handle = null;
  let fixed = false;
  let hashes = Object.create(null);
  let opening;
  let initializing;
  let queue = Promise.resolve();

  function state() {
    return { fixed, directoryName: handle ? handle.name : '', hasDirectory: !!handle };
  }
  function database() {
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = root.indexedDB.open('getty-plugin-saver', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('settings')) request.result.createObjectStore('settings');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法读取保存目录设置'));
      request.onblocked = () => reject(new Error('保存目录设置被其他插件页面占用，请关闭旧页面后重试'));
    }).catch(error => { opening = null; throw error; });
    return opening;
  }
  async function readSettings() {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readonly');
      const request = tx.objectStore('settings').get('current');
      let value;
      request.onsuccess = () => { value = request.result; };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('无法读取保存目录设置'));
    });
  }
  async function persist() {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ fixed, handle, hashes }, 'current');
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('无法记住保存目录设置'));
    });
  }
  function init() {
    if (!initializing) initializing = readSettings().then(saved => {
      if (saved) {
        fixed = !!saved.fixed;
        handle = saved.handle || null;
        hashes = saved.hashes && typeof saved.hashes === 'object' ? saved.hashes : Object.create(null);
      }
      return state();
    }).catch(error => { initializing = null; throw error; });
    return initializing.then(() => state());
  }
  function serialized(work) {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  }
  async function permission(directory, mode) {
    const options = { mode };
    if (await directory.queryPermission(options) === 'granted') return;
    if (await directory.requestPermission(options) === 'granted') return;
    throw new Error('目录访问权限未授权，请点击“选择目录”重新授权后保存');
  }
  async function pick() {
    if (typeof root.showDirectoryPicker !== 'function') {
      throw new Error('当前浏览器不支持固定目录选择，请使用新版 Chrome 或 Edge');
    }
    // Invoke immediately while the caller still has transient user activation.
    const selected = await root.showDirectoryPicker({ mode: 'readwrite', id: 'getty-save-folder' });
    await permission(selected, 'readwrite');
    return serialized(async () => {
      await init();
      const previous = { handle, fixed, hashes };
      handle = selected;
      fixed = true;
      hashes = Object.create(null);
      try { await persist(); }
      catch (error) { ({ handle, fixed, hashes } = previous); throw error; }
      return state();
    });
  }
  function setFixed(value) {
    return serialized(async () => {
      await init();
      const previous = fixed;
      fixed = !!value;
      try { await persist(); } catch (error) { fixed = previous; throw error; }
      return state();
    });
  }
  function filenameOnly(name) {
    if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[\\/\u0000-\u001f]/.test(name)) {
      throw new Error('文件名必须是单个文件名，不能包含目录或路径');
    }
    return name;
  }
  async function digest(blob) {
    const bytes = new Uint8Array(await root.crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function requireDirectory() {
    if (!handle) throw new Error('请先点击“选择目录”选择固定保存目录');
    return handle;
  }
  async function fileOrMissing(directory, name) {
    try { return await directory.getFileHandle(name); }
    catch (error) {
      if (error.name === 'NotFoundError' || error.name === 'TypeMismatchError') return null;
      throw error;
    }
  }
  async function nameExists(directory, name) {
    try { await directory.getFileHandle(name); return true; }
    catch (error) {
      if (error.name === 'TypeMismatchError') return true;
      if (error.name === 'NotFoundError') return false;
      throw error;
    }
  }
  async function matches(fileHandle, blob, hash) {
    try {
      const file = await fileHandle.getFile();
      return file.size === blob.size && await digest(file) === hash;
    } catch (error) {
      if (error.name === 'NotFoundError') return false;
      throw error;
    }
  }
  async function remember(hash, name) {
    hashes[hash] = name;
    // A failed index write must not report an already committed file as unsaved.
    // Every later save also scans existing files, so deduplication remains correct.
    try { await persist(); } catch (_) { /* File commit is the source of truth. */ }
  }
  async function saveToDirectory(blob, filename) {
    const directory = requireDirectory();
    await permission(directory, 'readwrite');
    const hash = await digest(blob);
    const cachedName = hashes[hash];
    if (typeof cachedName === 'string') {
      const cached = await fileOrMissing(directory, cachedName);
      if (cached && await matches(cached, blob, hash)) {
        return { saved: false, duplicate: true, filename: cachedName, directory: directory.name };
      }
      delete hashes[hash];
    }
    const names = new Set();
    for await (const [name, entry] of directory.entries()) {
      names.add(name);
      if (entry.kind === 'file' && await matches(entry, blob, hash)) {
        await remember(hash, name);
        return { saved: false, duplicate: true, filename: name, directory: directory.name };
      }
    }
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const extension = dot > 0 ? filename.slice(dot) : '';
    let target = filename;
    let suffix = 0;
    // Include both files and directories when selecting a name. Recheck after
    // the scan, which may have taken time in a large existing folder.
    while (names.has(target) || await nameExists(directory, target)) {
      target = `${stem} (${++suffix})${extension}`;
    }
    let writer;
    let created = false;
    try {
      const file = await directory.getFileHandle(target, { create: true });
      created = true;
      writer = await file.createWritable({ keepExistingData: false });
      await writer.write(blob);
      await writer.close();
    } catch (error) {
      if (writer) { try { await writer.abort(); } catch (_) { /* Already closed/aborted. */ } }
      if (created) {
        try { await directory.removeEntry(target); }
        catch (cleanupError) {
          if (cleanupError.name !== 'NotFoundError') {
            throw new Error(`保存失败，未能清理未完成文件“${target}”：${error.message}`);
          }
        }
      }
      throw error;
    }
    await remember(hash, target);
    return { saved: true, duplicate: false, filename: target, directory: directory.name };
  }
  function save(blob, filename, hash) {
    // The caller hash is intentionally not trusted: disk and incoming bytes
    // are hashed here, avoiding stale or differently-defined hash identities.
    return serialized(async () => {
      filenameOnly(filename);
      await init();
      if (!fixed) return { saved: false, duplicate: false, filename, directory: '' };
      if (root.navigator && root.navigator.locks) {
        return root.navigator.locks.request('getty-plugin-fixed-folder-save', () => saveToDirectory(blob, filename));
      }
      return saveToDirectory(blob, filename);
    });
  }
  function list() {
    return serialized(async () => {
      await init();
      const directory = requireDirectory();
      await permission(directory, 'read');
      const entries = [];
      for await (const [name, entry] of directory.entries()) {
        if (entry.kind === 'file') {
          try { entries.push({ name, kind: 'file', size: (await entry.getFile()).size }); }
          catch (error) { if (error.name !== 'NotFoundError') throw error; }
        } else entries.push({ name, kind: entry.kind });
      }
      return entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    });
  }
  root.PluginSaver = Object.freeze({ init, pick, setFixed, state, save, list });
})(globalThis);
