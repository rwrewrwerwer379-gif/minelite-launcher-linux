const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { Client, Authenticator } = require('minecraft-launcher-core');
const https = require('https');
let autoUpdater;
try {
  // Lazy require to avoid dev issues
  ({ autoUpdater } = require('electron-updater'));
} catch (_) {
  autoUpdater = null;
}

// Copy specific Forge-related library files from default .minecraft into instance libraries
function adoptMissingForgeLibsFromDefault(instanceDir, relPaths) {
  try {
    const def = getDefaultMinecraftDir();
    if (!def) return 0;
    const defLib = path.join(def, 'libraries');
    const instLib = path.join(instanceDir, 'libraries');
    let copied = 0;
    for (const rel of (relPaths || [])) {
      if (!rel) continue;
      const src = path.join(defLib, rel);
      const dst = path.join(instLib, rel);
      try {
        if (!fs.existsSync(src)) continue;
        ensureDir(path.dirname(dst));
        fs.copyFileSync(src, dst);
        copied++;
      } catch {}
    }
    return copied;
  } catch { return 0; }
}

// Build CP and launch Forge directly via Java when MCLC causes duplicated Forge args
async function launchForgeDirect({ instanceDir, javaPath, versionId, baseVer, username, auth }) {
  try {
    const vDir = path.join(instanceDir, 'versions', versionId);
    const vJson = path.join(vDir, `${versionId}.json`);
    if (!fs.existsSync(vJson)) return { ok: false, error: 'Version manifest missing for Forge fallback.' };
    const raw = JSON.parse(fs.readFileSync(vJson, 'utf8'));
    // Also load base (vanilla) and parent (inheritsFrom) manifests to include LWJGL and other vanilla libs
    const parentIds = new Set();
    if (raw && typeof raw.inheritsFrom === 'string' && raw.inheritsFrom) parentIds.add(raw.inheritsFrom);
    if (baseVer && (!raw || raw.inheritsFrom !== baseVer)) parentIds.add(baseVer);
    const parentManifests = [];
    for (const pid of parentIds) {
      const pjson = path.join(instanceDir, 'versions', pid, `${pid}.json`);
      if (fs.existsSync(pjson)) {
        try { parentManifests.push(JSON.parse(fs.readFileSync(pjson, 'utf8'))); } catch {}
      } else {
        try { mainWindow && mainWindow.webContents.send('log', `Forge direct: Ebeveyn manifest bulunamadı: ${pjson}`); } catch {}
      }
    }

    // Prefetch missing libraries from Forge and parent manifests (uses downloads.artifact.url when available)
    const allLibEntries = [];
    const pushLibs = (list) => {
      for (const lib of (list || [])) {
        if (!lib) continue;
        const art = lib.downloads && lib.downloads.artifact;
        const hasPath = art && typeof art.path === 'string' && art.path;
        const hasUrl = art && typeof art.url === 'string' && art.url;
        let rel = hasPath ? art.path : '';
        if (!rel && lib && typeof lib.name === 'string') {
          const parts = lib.name.split(':');
          if (parts.length >= 3) {
            const [groupId, artifactId, ver] = parts;
            const groupPath = groupId.replace(/\./g, '/');
            rel = `${groupPath}/${artifactId}/${ver}/${artifactId}-${ver}.jar`;
          }
        }
        if (rel) {
          allLibEntries.push({ rel, url: hasUrl ? art.url : '' });
        }
      }
    };
    pushLibs(raw.libraries || []);
    for (const pm of parentManifests) { if (pm && Array.isArray(pm.libraries)) pushLibs(pm.libraries); }

    // Download missing ones into libraries root
    const libRoot = path.join(instanceDir, 'libraries');
    ensureDir(libRoot);
    let libsChecked = 0, libsDownloaded = 0, libsSkipped = 0;
    for (const ent of allLibEntries) {
      try {
        libsChecked++;
        const dest = path.join(libRoot, ent.rel);
        ensureDir(path.dirname(dest));
        if (fs.existsSync(dest)) { libsSkipped++; continue; }
        if (ent.url) {
          await downloadWithRetry(ent.url, dest, { timeoutMs: 30000, retries: 2 });
          libsDownloaded++;
        } else {
          // No URL in manifest; skip (may already be present or provided by installer)
          libsSkipped++;
        }
      } catch (_) { libsSkipped++; }
    }
    try { mainWindow && mainWindow.webContents.send('log', `Forge direct prefetch: libsChecked=${libsChecked}, libsDownloaded=${libsDownloaded}, skipped=${libsSkipped}`); } catch {}

    // Collect libraries
    const libs = [];
    // libRoot declared above
    const addLibsFrom = (list) => {
      for (const lib of (list || [])) {
        try {
          let rel = lib?.downloads?.artifact?.path || '';
          if (!rel && lib && typeof lib.name === 'string') {
            const parts = lib.name.split(':');
            if (parts.length >= 3) {
              const [groupId, artifactId, ver] = parts;
              const groupPath = groupId.replace(/\./g, '/');
              rel = `${groupPath}/${artifactId}/${ver}/${artifactId}-${ver}.jar`;
            }
          }
          if (rel) {
            const full = path.join(libRoot, rel);
            if (fs.existsSync(full)) libs.push(full);
          }
        } catch {}
      }
    };
    addLibsFrom(raw.libraries || []);
    for (const pm of parentManifests) {
      if (pm && Array.isArray(pm.libraries)) addLibsFrom(pm.libraries);
    }
    // Add version jar if exists
    const vJar = path.join(vDir, `${versionId}.jar`);
    if (fs.existsSync(vJar)) libs.push(vJar);

    const cpList = Array.from(new Set(libs));
    const cp = cpList.join(path.delimiter);

    // Prepare substitutions
    const assetsRoot = path.join(instanceDir, 'assets');
    let assetsIndex = '';
    try {
      for (const pm of parentManifests) {
        if (pm && (pm.assets || (pm.assetIndex && pm.assetIndex.id))) {
          assetsIndex = pm.assets || (pm.assetIndex && pm.assetIndex.id) || assetsIndex;
          break;
        }
      }
    } catch {}
    const uuid = (auth && auth.selected_profile && auth.selected_profile.id) || '00000000000000000000000000000000';
    const accessToken = (auth && auth.access_token) || '0';
    const subs = {
      '${auth_player_name}': username || 'Player',
      '${version_name}': versionId,
      '${game_directory}': instanceDir,
      '${assets_root}': assetsRoot,
      '${assets_index_name}': assetsIndex,
      '${auth_uuid}': uuid,
      '${auth_access_token}': accessToken,
      '${user_type}': 'legacy',
      '${version_type}': raw.type || 'custom',
      '${auth_xuid}': '',
      '${clientid}': '',
      '${auth_session}': accessToken,
      '${library_directory}': path.join(instanceDir, 'libraries').replace(/\\/g, '/'),
      '${classpath_separator}': process.platform === 'win32' ? ';' : ':',
    };

    // Extract JVM and game args
    const jvmRaw = Array.isArray(raw?.arguments?.jvm) ? raw.arguments.jvm : [];
    let jvmArgs = [];
    for (const it of jvmRaw) {
      if (typeof it === 'string') jvmArgs.push(applySubs(it, subs));
      else if (it && typeof it === 'object') {
        const val = it.value;
        if (Array.isArray(val)) for (const v of val) jvmArgs.push(applySubs(String(v), subs));
        else if (typeof val === 'string') jvmArgs.push(applySubs(val, subs));
      }
    }
    // Ensure memory and basic flags + natives path (mirror MCLC behavior)
    jvmArgs.push('-Xmx2G', '-Xms1G', `-Djava.library.path=${instanceDir}`);
    try { mainWindow && mainWindow.webContents.send('log', `Forge direct: CP entries=${cpList.length}`); } catch {}

    // Build game args from parent (vanilla) manifests first, then Forge manifest
    const gameArgs = [];
    const addGameArgsFrom = (man) => {
      const gameRaw = Array.isArray(man?.arguments?.game) ? man.arguments.game : [];
      for (const it of gameRaw) {
        if (typeof it === 'string') gameArgs.push(applySubs(it, subs));
        else if (it && typeof it === 'object') {
          const val = it.value;
          if (Array.isArray(val)) for (const v of val) gameArgs.push(applySubs(String(v), subs));
          else if (typeof val === 'string') gameArgs.push(applySubs(val, subs));
        }
      }
    };
    for (const pm of parentManifests) addGameArgsFrom(pm);
    addGameArgsFrom(raw);

    // Ensure required vanilla args exist (some Forge manifests omit them when using inheritsFrom)
    const ensureOpt = (key, value) => {
      const idx = gameArgs.indexOf(key);
      if (idx === -1) { gameArgs.push(key, String(value)); }
    };
    ensureOpt('--version', versionId);
    ensureOpt('--accessToken', accessToken);
    ensureOpt('--gameDir', instanceDir);
    ensureOpt('--assetsDir', assetsRoot);
    if (assetsIndex) ensureOpt('--assetIndex', assetsIndex);
    ensureOpt('--uuid', uuid);
    ensureOpt('--userType', 'legacy');
    ensureOpt('--versionType', raw.type || 'custom');

    // Remove unresolved placeholders and unwanted demo flags from game args
    const optsWithValue = new Set([
      '--width', '--height', '--quickPlayPath', '--quickPlaySingleplayer', '--quickPlayMultiplayer', '--quickPlayRealms'
    ]);
    const cleanedGameArgs = [];
    for (let i = 0; i < gameArgs.length; i++) {
      const tok = gameArgs[i];
      if (tok === '--demo') continue; // don't force demo mode
      if (optsWithValue.has(tok)) {
        const val = gameArgs[i + 1];
        if (typeof val === 'string' && val.includes('${')) { i++; continue; } // skip option + unresolved value
        cleanedGameArgs.push(tok);
        if (typeof val !== 'undefined') { cleanedGameArgs.push(val); i++; }
        continue;
      }
      if (typeof tok === 'string' && tok.includes('${')) continue; // drop stray unresolved placeholders
      cleanedGameArgs.push(tok);
    }
    // replace
    gameArgs.length = 0; gameArgs.push(...cleanedGameArgs);

    // Sanitize duplicate Forge options
    const sanitizeArgs = (arr, { dedupeForge = true } = {}) => {
      if (!Array.isArray(arr) || !arr.length) return arr || [];
      let out = [];
      const seenKeys = new Set();
      const keys = new Set(['--launchTarget','--fml.forgeVersion','--fml.mcVersion','--fml.forgeGroup','--fml.mcpVersion']);
      for (let i = 0; i < arr.length; i++) {
        const tok = arr[i];
        if (dedupeForge && keys.has(tok)) {
          const val = (i + 1 < arr.length) ? String(arr[i + 1]) : '';
          if (seenKeys.has(tok)) { i++; continue; }
          seenKeys.add(tok);
          out.push(tok);
          if (val) { out.push(val); i++; }
          continue;
        }
        out.push(tok);
      }
      return out;
    };
    const gameArgsSan = sanitizeArgs(gameArgs, { dedupeForge: true });

    // Ensure special Forge-patched jars and Forge client modules exist (usually produced by Forge installer)
    try {
      const instLib = path.join(instanceDir, 'libraries');
      const needRel = [];
      // Extract mcpVersion from args
      let mcpVersion = '';
      const mcpIdx = gameArgsSan.indexOf('--fml.mcpVersion');
      if (mcpIdx !== -1 && mcpIdx + 1 < gameArgsSan.length) mcpVersion = String(gameArgsSan[mcpIdx + 1]);
      // Extract forge version from versionId (e.g., 1.20.1-forge-47.4.6)
      let forgeVer = '';
      const m = String(versionId).match(/forge[- ]([0-9.]+)/i);
      if (m) forgeVer = m[1];
      if (mcpVersion) {
        needRel.push(`net/minecraft/client/${baseVer}-${mcpVersion}/client-${baseVer}-${mcpVersion}-srg.jar`);
        needRel.push(`net/minecraft/client/${baseVer}-${mcpVersion}/client-${baseVer}-${mcpVersion}-extra.jar`);
      }
      if (forgeVer) {
        needRel.push(`net/minecraftforge/forge/${baseVer}-${forgeVer}/forge-${baseVer}-${forgeVer}-client.jar`);
        needRel.push(`net/minecraftforge/forge/${baseVer}-${forgeVer}/forge-${baseVer}-${forgeVer}-universal.jar`);
        // Forge client module jars required during scan
        needRel.push(`net/minecraftforge/fmlcore/${baseVer}-${forgeVer}/fmlcore-${baseVer}-${forgeVer}.jar`);
        needRel.push(`net/minecraftforge/javafmllanguage/${baseVer}-${forgeVer}/javafmllanguage-${baseVer}-${forgeVer}.jar`);
        needRel.push(`net/minecraftforge/lowcodelanguage/${baseVer}-${forgeVer}/lowcodelanguage-${baseVer}-${forgeVer}.jar`);
        needRel.push(`net/minecraftforge/mclanguage/${baseVer}-${forgeVer}/mclanguage-${baseVer}-${forgeVer}.jar`);
      }

      const missing = needRel.filter((rel) => !fs.existsSync(path.join(instLib, rel)));
      if (missing.length) {
        try { mainWindow && mainWindow.webContents.send('log', `Forge direct: Özel JAR eksik: ${missing.length} adet. Varsayılandan kopyalanacak.`); } catch {}
        const copied = adoptMissingForgeLibsFromDefault(instanceDir, missing);
        try { mainWindow && mainWindow.webContents.send('log', `Forge direct: Varsayılandan kopyalanan dosya sayısı: ${copied}`); } catch {}
        let stillMissing = missing.filter((rel) => !fs.existsSync(path.join(instLib, rel)));
        // Try direct download from Forge maven for forge modules (if present there)
        if (stillMissing.length) {
          const tryDownload = async (rel) => {
            try {
              if (!rel.startsWith('net/minecraftforge/')) return false;
              const url = `https://maven.minecraftforge.net/${rel.replace(/\\/g,'/')}`;
              const dst = path.join(instLib, rel);
              ensureDir(path.dirname(dst));
              await new Promise((resolve, reject) => {
                const file = fs.createWriteStream(dst);
                https.get(url, (res) => {
                  if (res.statusCode !== 200) { try { fs.unlinkSync(dst); } catch {} return reject(new Error('HTTP '+res.statusCode)); }
                  res.pipe(file);
                  file.on('finish', () => file.close(resolve));
                }).on('error', (e) => { try { fs.unlinkSync(dst); } catch {}; reject(e); });
              });
              try { mainWindow && mainWindow.webContents.send('log', `Forge direct: Maven'den indirildi -> ${rel}`); } catch {}
              return true;
            } catch (e) {
              try { mainWindow && mainWindow.webContents.send('log', `Forge direct: Maven indirme başarısız -> ${rel}: ${String(e)}`); } catch {}
              return false;
            }
          };
          let dlCount = 0;
          for (const r of stillMissing) {
            // eslint-disable-next-line no-await-in-loop
            const ok = await tryDownload(r);
            if (ok) dlCount++;
          }
          try { mainWindow && mainWindow.webContents.send('log', `Forge direct: Maven indirme denemeleri tamamlandı, indirilen: ${dlCount}`); } catch {}
          stillMissing = stillMissing.filter((rel) => !fs.existsSync(path.join(instLib, rel)));
        }
        if (stillMissing.length) {
          try { mainWindow && mainWindow.webContents.send('log', 'Forge direct: Eksikler sürüyor, varsayılan .minecraft içinde Forge yeniden kurulum denenecek.'); } catch {}
          const re = await reinstallForgeFromDefault(instanceDir, javaPath, baseVer);
          try { mainWindow && mainWindow.webContents.send('log', `Forge direct: Yeniden kurulum sonucu: ${JSON.stringify(re).substring(0,200)}`); } catch {}
          // Try adopt again after reinstall
          const copied2 = adoptMissingForgeLibsFromDefault(instanceDir, stillMissing);
          try { mainWindow && mainWindow.webContents.send('log', `Forge direct: Yeniden kurulum sonrası kopyalanan: ${copied2}`); } catch {}
        }
      }
    } catch {}

    const mainClass = raw.mainClass || 'cpw.mods.bootstraplauncher.BootstrapLauncher';
    const javaExe = javaPath.replace(/\\/g, '/');
    const { spawn } = require('child_process');
    const fullArgs = [...jvmArgs, '-cp', cp, mainClass, ...gameArgsSan];
    try { mainWindow && mainWindow.webContents.send('log', 'Forge fallback Java komutu: ' + javaExe + ' ' + JSON.stringify(fullArgs)); } catch {}
    const p = spawn(javaExe, fullArgs, { cwd: instanceDir, stdio: 'pipe' });
    currentLaunch = p;
    p.stdout.on('data', (d) => mainWindow && mainWindow.webContents.send('log', String(d)));
    p.stderr.on('data', (d) => mainWindow && mainWindow.webContents.send('log', String(d)));
    p.on('spawn', () => mainWindow && mainWindow.webContents.send('launched'));
    p.on('close', (code) => { mainWindow && mainWindow.webContents.send('stopped', code); currentLaunch = null; });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Run Forge installer CLI in default .minecraft, then adopt into instanceDir
async function reinstallForgeFromDefault(instanceDir, javaPath, mcVersion) {
  try {
    const installerUrl = await getLatestForgeInstallerUrl(mcVersion);
    const tmpDir = path.join(app.getPath('temp'), 'minelite');
    ensureDir(tmpDir);
    const jarPath = path.join(tmpDir, 'forge-installer.jar');
    const buf = await httpsGet(installerUrl);
    fs.writeFileSync(jarPath, buf);
    const javaExe = javaPath.replace(/\\/g, '/');
    const defMc = getDefaultMinecraftDir();
    const { spawnSync } = require('child_process');
    mainWindow && mainWindow.webContents.send('log', `Forge CLI yeniden kurulum deneniyor (cwd=${defMc})...`);
    const cliArgs = ['-jar', jarPath, '--installClient'];
    const r = spawnSync(javaExe, cliArgs, { encoding: 'utf8', timeout: 180000, cwd: defMc || undefined });
    const out = (r.stdout || '') + (r.stderr || '');
    mainWindow && mainWindow.webContents.send('log', `Forge CLI yeniden kurulum çıktısı: ${out.substring(0, 4000)}`);
    // Adopt into instance
    tryAdoptForgeFromDefault(instanceDir, mcVersion);
    const found = findInstalledForge(instanceDir, mcVersion);
    return found && found.id ? { ok: true, id: found.id } : { ok: false, error: 'Forge yeniden kurulum sonrası tespit edilemedi' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Prefetch assets (resources) for a base MC version using its assetIndex
async function prefetchAssets(instanceDir, baseVer, concurrency = 16) {
  try {
    // Try local base version JSON first
    const vJson = path.join(instanceDir, 'versions', baseVer, `${baseVer}.json`);
    let base;
    if (fs.existsSync(vJson)) {
      try { base = JSON.parse(fs.readFileSync(vJson, 'utf8')); } catch {}
    }
    if (!base) {
      // Fetch remotely
      const manifest = await httpsGetJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
      const entry = (manifest.versions || []).find((v) => v.id === baseVer);
      if (!entry || !entry.url) return null;
      base = await httpsGetJson(entry.url);
    }
    const assetIndex = base?.assetIndex || null;
    if (!assetIndex || !assetIndex.url) return null;
    const idx = await httpsGetJson(assetIndex.url);
    const objects = idx?.objects || {};
    const keys = Object.keys(objects);
    if (!keys.length) return { checked: 0, downloaded: 0, skipped: 0 };

    const assetsRoot = path.join(instanceDir, 'assets');
    const objectsRoot = path.join(assetsRoot, 'objects');
    ensureDir(objectsRoot);

    const jobs = [];
    let checked = 0;
    for (const k of keys) {
      const obj = objects[k];
      if (!obj || !obj.hash) continue;
      checked++;
      const hash = String(obj.hash);
      const sub = hash.substring(0, 2);
      const dest = path.join(objectsRoot, sub, hash);
      const url = `https://resources.download.minecraft.net/${sub}/${hash}`;
      jobs.push(async () => {
        try {
          if (fs.existsSync(dest)) {
            try {
              const s = fs.statSync(dest).size;
              if (!isNaN(obj.size) && obj.size && s === obj.size) return 'skipped';
              if (s > 0 && isNaN(obj.size)) return 'skipped';
            } catch {}
          }
          await downloadWithRetry(url, dest, { timeoutMs: 30000, retries: 2 });
          return 'downloaded';
        } catch {
          return 'skipped';
        }
      });
    }

    const downloadedRef = { n: 0 };
    const skippedRef = { n: 0 };
    let idxJob = 0;
    const worker = async () => {
      for (;;) {
        const my = idxJob++;
        if (my >= jobs.length) break;
        const res = await jobs[my]();
        if (res === 'downloaded') downloadedRef.n++;
        else skippedRef.n++;
      }
    };
    const pool = new Array(Math.min(concurrency, jobs.length)).fill(0).map(() => worker());
    await Promise.all(pool);
    return { checked, downloaded: downloadedRef.n, skipped: skippedRef.n };
  } catch {
    return null;
  }
}

// ESM-only module helpers
let storePromise = null;

// Safely write JSON to a file on Windows handling EPERM/read-only attributes
function safeWriteJson(filePath, obj) {
  const data = JSON.stringify(obj, null, 2);
  try {
    if (fs.existsSync(filePath)) {
      try { fs.chmodSync(filePath, 0o666); } catch {}
    }
    fs.writeFileSync(filePath, data);
    return;
  } catch (e) {
    const msg = String(e || '');
    if (/EPERM/i.test(msg) || /EACCES/i.test(msg)) {
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
      fs.writeFileSync(filePath, data);
      return;
    }
    throw e;
  }
}
function getStore() {
  if (!storePromise) {
    storePromise = import('electron-store').then((m) => new m.default({ name: 'settings' }));
  }
  return storePromise;
}

// Forge helpers
async function getLatestForgeInstallerUrl(mcVersion) {
  // First try promotions_slim.json for recommended/latest mapping
  try {
    const buf = await httpsGet('https://maven.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    const data = JSON.parse(buf.toString());
    const promos = data && data.promos ? data.promos : {};
    const recKey = `${mcVersion}-recommended`;
    const latKey = `${mcVersion}-latest`;
    const forgeVer = promos[recKey] || promos[latKey];
    if (forgeVer) {
      const full = `${mcVersion}-${forgeVer}`;
      const pathPart = `net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
      return `https://maven.minecraftforge.net/${pathPart}`;
    }
  } catch (_) {
    // ignore and try metadata fallback
  }

  // Fallback: parse maven-metadata.xml and pick the newest version matching `${mcVersion}-*`
  try {
    const metaBuf = await httpsGet('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
    const xml = metaBuf.toString();
    // Extract <version>...</version> entries
    const versions = Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g)).map((m) => m[1]);
    const matching = versions.filter((v) => v.startsWith(`${mcVersion}-`));
    if (matching.length) {
      // Sort lexicographically which works reasonably for forge version portion
      matching.sort();
      const best = matching[matching.length - 1];
      const pathPart = `net/minecraftforge/forge/${best}/forge-${best}-installer.jar`;
      return `https://maven.minecraftforge.net/${pathPart}`;
    }
  } catch (_) {}

  throw new Error('Forge version not found for ' + mcVersion);
}

function isForgeInstalled(instanceDir, mcVersion) {
  const versionsDir = path.join(instanceDir, 'versions');
  if (!fs.existsSync(versionsDir)) return false;
  const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  return entries.some((e) => e.isDirectory() && /forge/i.test(e.name) && e.name.includes(mcVersion));
}

async function ensureForge(instanceDir, javaPath, mcVersion) {
  if (isForgeInstalled(instanceDir, mcVersion)) return { ok: true, id: null };
  const installerUrl = await getLatestForgeInstallerUrl(mcVersion);
  const tmpDir = path.join(app.getPath('temp'), 'minelite');
  ensureDir(tmpDir);
  const jarPath = path.join(tmpDir, 'forge-installer.jar');
  let buf;
  try {
    buf = await httpsGet(installerUrl);
  } catch (e) {
    const msg = String(e || '');
    if (/HTTP\s+404/.test(msg)) {
      throw new Error('Bu Minecraft sürümü için uygun Forge yükleyicisi bulunamadı (404). Lütfen farklı bir MC sürümü seçin veya Fabric/Vanilla kullanın.');
    }
    throw e;
  }
  fs.writeFileSync(jarPath, buf);

  const javaExe = javaPath.replace(/\\/g, '/');
  const { spawn, spawnSync } = require('child_process');

  // 1) Try CLI/silent install inside default .minecraft so launcher profile is present
  try {
    const defMc = getDefaultMinecraftDir();
    mainWindow && mainWindow.webContents.send('log', `Forge CLI kurulumu (varsayılan .minecraft içinde) deneniyor... cwd=${defMc}`);
    const cliArgs = ['-jar', jarPath, '--installClient'];
    const r = spawnSync(javaExe, cliArgs, { encoding: 'utf8', timeout: 180000, cwd: defMc || undefined });
    const out = (r.stdout || '') + (r.stderr || '');
    mainWindow && mainWindow.webContents.send('log', `Forge CLI çıktı (${cliArgs.join(' ')}): ${out.substring(0, 4000)}`);
    // If installed in default, adopt into instance
    const foundDef = tryAdoptForgeFromDefault(instanceDir, mcVersion);
    if (foundDef || isForgeInstalled(instanceDir, mcVersion)) {
      const found = findInstalledForge(instanceDir, mcVersion);
      return { ok: true, id: found?.id || null };
    }
  } catch (e) {
    mainWindow && mainWindow.webContents.send('log', 'Forge CLI (default .minecraft) hata: ' + String(e));
  }

  // 2) Fallback to GUI installer in default .minecraft with timeout, then adopt
  return await new Promise((resolve) => {
    const defMc = getDefaultMinecraftDir();
    mainWindow && mainWindow.webContents.send('log', `Forge yükleyici (GUI) başlatılıyor... (cwd=${defMc}) Kurulum penceresini tamamlayın. (Zaman aşımı: 5 dk)`);
    const p = spawn(javaExe, ['-jar', jarPath], { stdio: 'pipe', cwd: defMc || undefined });
    let done = false;
    const finish = (res) => { if (!done) { done = true; try { p.kill('SIGKILL'); } catch {} resolve(res); } };
    const timeout = setTimeout(() => {
      finish({ ok: false, error: 'Forge GUI kurulum zaman aşımına uğradı. Lütfen tekrar deneyin veya farklı bir sürüm seçin.' });
    }, 5 * 60 * 1000);
    p.stdout.on('data', (d) => mainWindow && mainWindow.webContents.send('log', String(d)));
    p.stderr.on('data', (d) => mainWindow && mainWindow.webContents.send('log', String(d)));
    p.on('close', () => {
      clearTimeout(timeout);
      try {
        // Prefer adopting from default .minecraft first
        tryAdoptForgeFromDefault(instanceDir, mcVersion);
        const found = findInstalledForge(instanceDir, mcVersion);
        if (found) return finish({ ok: true, id: found.id });
        finish({ ok: false, error: 'Forge kurulumu tespit edilemedi. Lütfen tekrar deneyin.' });
      } catch (e) {
        finish({ ok: false, error: String(e) });
      }
    });
  });
}

// Mojang versions list for UI version selector
ipcMain.handle('versions:list', async () => {
  try {
    const manifest = await httpsGetJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    const versions = (manifest.versions || []).map((v) => ({ id: v.id, type: v.type }));
    return { ok: true, versions };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Comments API
ipcMain.handle('comments:list', async () => {
  try {
    const store = await getStore();
    const comments = store.get('comments') || [];
    return { ok: true, comments };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('comments:add', async (_e, payload) => {
  try {
    const { author, text } = payload || {};
    if (!text || String(text).trim().length === 0) return { ok: false, error: 'Boş yorum eklenemez' };
    const store = await getStore();
    const comments = store.get('comments') || [];
    const item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      author: (author && String(author).trim()) || 'Anonim',
      text: String(text).trim(),
      ts: Date.now(),
    };
    comments.unshift(item);
    store.set('comments', comments);
    return { ok: true, item };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('comments:delete', async (_e, id) => {
  try {
    const store = await getStore();
    const comments = store.get('comments') || [];
    const next = comments.filter((c) => c.id !== id);
    store.set('comments', next);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

let mainWindow;
let currentLaunch = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'MineLite Launcher',
    // Use provided app icon: .ico on Windows, .png on Linux/macOS
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => (mainWindow = null));
}

app.whenReady().then(() => {
  try { app.setAppUserModelId('com.minelite.launcher'); } catch {}
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Build CP and launch Fabric directly via Java when MCLC fails to include Fabric libraries
async function launchFabricDirect({ instanceDir, javaPath, versionId, baseVer, username, auth }) {
  try {
    // Read version manifest
    const vDir = path.join(instanceDir, 'versions', versionId);
    const vJson = path.join(vDir, `${versionId}.json`);
    if (!fs.existsSync(vJson)) return { ok: false, error: 'Version manifest missing for fallback.' };
    const raw = JSON.parse(fs.readFileSync(vJson, 'utf8'));

    // Collect libraries. Prefer downloads.artifact.path; if missing, derive from lib.name (group:artifact:version)
    const libs = [];
    const libRoot = path.join(instanceDir, 'libraries');
    for (const lib of (raw.libraries || [])) {
      try {
        let rel = lib?.downloads?.artifact?.path || '';
        if (!rel && lib && typeof lib.name === 'string') {
          // Build Maven path: groupId/artifactId/version/artifactId-version.jar
          const parts = lib.name.split(':');
          if (parts.length >= 3) {
            const [groupId, artifactId, ver] = parts;
            const groupPath = groupId.replace(/\./g, '/');
            rel = `${groupPath}/${artifactId}/${ver}/${artifactId}-${ver}.jar`;
          }
        }
        if (rel) {
          const full = path.join(libRoot, rel);
          if (fs.existsSync(full)) libs.push(full);
        }
      } catch {}
    }
    // Add base client jar
    const baseJar = path.join(instanceDir, 'versions', baseVer, `${baseVer}.jar`);
    if (fs.existsSync(baseJar)) libs.push(baseJar);
    else return { ok: false, error: 'Base client.jar bulunamadı: ' + baseJar };

    // Deduplicate and build classpath
    const cpList = Array.from(new Set(libs));
    const cp = cpList.join(path.delimiter);

    // Natives directory (MCLC uses this path pattern)
    const nativesDir = path.join(instanceDir, 'natives', versionId);

    // JVM args (minimal safe set)
    const jvmArgs = [
      `-Djava.library.path=${nativesDir}`,
      '-Dlog4j2.formatMsgNoLookups=true',
    ];
    // Memory (use same as options)
    jvmArgs.push('-Xmx2G', '-Xms1G');

    // Game args from manifest (fill common placeholders)
    const assetsRoot = path.join(instanceDir, 'assets');
    const assetsIndex = raw.assets || (raw.assetIndex && raw.assetIndex.id) || '';
    const uuid = (auth && auth.selected_profile && auth.selected_profile.id) || '00000000000000000000000000000000';
    const accessToken = (auth && auth.access_token) || '0';
    const userType = 'legacy';
    const versionType = raw.type || 'custom';
    const subs = {
      '${auth_player_name}': username || 'Player',
      '${version_name}': versionId,
      '${game_directory}': instanceDir,
      '${assets_root}': assetsRoot,
      '${assets_index_name}': assetsIndex,
      '${auth_uuid}': uuid,
      '${auth_access_token}': accessToken,
      '${user_type}': userType,
      '${version_type}': versionType,
      '${auth_xuid}': '',
      '${clientid}': '',
      '${auth_session}': accessToken,
    };
    const gameArgs = [];
    const fromManifest = (raw.arguments && Array.isArray(raw.arguments.game)) ? raw.arguments.game : [];
    for (const it of fromManifest) {
      if (typeof it === 'string') {
        gameArgs.push(applySubs(it, subs));
      } else if (it && typeof it === 'object') {
        // Ignore rules for simplicity; most are platform allows
        const val = it.value;
        if (Array.isArray(val)) {
          for (const v of val) gameArgs.push(applySubs(String(v), subs));
        } else if (typeof val === 'string') {
          gameArgs.push(applySubs(val, subs));
        }
      }
    }

    const mainClass = raw.mainClass || 'net.fabricmc.loader.impl.launch.knot.KnotClient';
    const javaExe = javaPath.replace(/\\/g, '/');
    const { spawn } = require('child_process');
    const args = ['-cp', cp, mainClass, ...gameArgs];
    const fullArgs = [...jvmArgs, ...args];
    try {
      const missingFabric = !/net[\\\/]fabricmc/.test(cp);
      const diag = ` (libCount=${cpList.length}, fabricInCp=${!missingFabric})`;
      mainWindow && mainWindow.webContents.send('log', 'Fallback Java komutu: ' + javaExe + ' ' + JSON.stringify(fullArgs) + diag);
    } catch {
      mainWindow && mainWindow.webContents.send('log', 'Fallback Java komutu: ' + javaExe + ' ' + JSON.stringify(fullArgs));
    }
    const p = spawn(javaExe, fullArgs, { cwd: instanceDir, stdio: 'pipe' });
    currentLaunch = p;
    p.stdout.on('data', (d) => mainWindow && mainWindow.webContents.send('log', String(d)));
    p.stderr.on('data', (d) => mainWindow && mainWindow.webContents.send('log', String(d)));
    p.on('spawn', () => mainWindow && mainWindow.webContents.send('launched'));
    p.on('close', (code) => {
      mainWindow && mainWindow.webContents.send('stopped', code);
      currentLaunch = null;
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function applySubs(s, map) {
  let out = String(s);
  for (const [k, v] of Object.entries(map)) {
    out = out.split(k).join(String(v));
  }
  return out;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

async function getDefaults() {
  const store = await getStore();
  const home = app.getPath('home');
  const defaultInstance = store.get('instanceDir') || path.join(home, '.minelite');
  const defaultJava = store.get('javaPath') || '';
  const username = store.get('username') || 'Player';
  const version = store.get('gameVersion') || '1.20.1';
  const loader = store.get('loader') || 'fabric';
  return { defaultInstance, defaultJava, username, version, loader };
}

ipcMain.handle('get-settings', async () => {
  return await getDefaults();
});

ipcMain.handle('choose-instance-dir', async () => {
  const store = await getStore();
  const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || res.filePaths.length === 0) return null;
  const selected = res.filePaths[0];
  store.set('instanceDir', selected);
  return selected;
});

ipcMain.handle('choose-java-path', async () => {
  const store = await getStore();
  const res = await dialog.showOpenDialog({ properties: ['openFile'] });
  if (res.canceled || res.filePaths.length === 0) return null;
  const selected = res.filePaths[0];
  store.set('javaPath', selected);
  return selected;
});

ipcMain.handle('save-user-settings', async (_e, { username, version, loader }) => {
  const store = await getStore();
  if (username) store.set('username', username);
  if (version) store.set('gameVersion', version);
  if (loader) store.set('loader', loader);
  return true;
});

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function getDefaultMinecraftDir() {
  try {
    const plat = process.platform;
    if (plat === 'win32') {
      // %APPDATA%\\.minecraft
      return path.join(app.getPath('appData'), '.minecraft');
    }
    if (plat === 'darwin') {
      // ~/Library/Application Support/minecraft
      return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft');
    }
    // linux, freebsd, etc.: ~/.minecraft
    return path.join(os.homedir(), '.minecraft');
  } catch {
    return null;
  }
}

function findInstalledForge(root, mcVersion) {
  try {
    const versionsDir = path.join(root, 'versions');
    if (!fs.existsSync(versionsDir)) return null;
    const entries = fs.readdirSync(versionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /forge/i.test(e.name) && e.name.includes(mcVersion));
    if (entries.length === 0) return null;
    // Prefer entries with a valid jar
    for (const e of entries) {
      const dir = path.join(versionsDir, e.name);
      const jar = path.join(dir, `${e.name}.jar`);
      const info = validateJarFile(jar);
      if (info.exists && info.size > 10 * 1024 && info.magicOk) {
        return { id: e.name, dir };
      }
    }
    // Fallback: pick the most recently modified directory
    let best = entries[0];
    let bestTime = 0;
    for (const e of entries) {
      const dir = path.join(versionsDir, e.name);
      let t = 0;
      try { t = fs.statSync(dir).mtimeMs || 0; } catch {}
      if (t > bestTime) { bestTime = t; best = e; }
    }
    return { id: best.name, dir: path.join(versionsDir, best.name) };
  } catch { return null; }
}

function copyDirRecursive(src, dest) {
  ensureDir(dest);
  if (fs.cpSync) {
    try {
      fs.cpSync(src, dest, { recursive: true, force: true, errorOnExist: false });
      return;
    } catch {}
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDirRecursive(s, d);
    else {
      ensureDir(path.dirname(d));
      try {
        fs.copyFileSync(d, d); // touch to ensure write perms
      } catch {}
      fs.copyFileSync(s, d);
    }
  }
}

function tryAdoptForgeFromDefault(instanceDir, mcVersion) {
  const def = getDefaultMinecraftDir();
  if (!def) return false;
  const found = findInstalledForge(def, mcVersion);
  if (!found) return false;
  const target = path.join(instanceDir, 'versions', found.id);
  try {
    copyDirRecursive(found.dir, target);
    return true;
  } catch {
    return false;
  }
}

// Validate a JAR by existence, size and ZIP magic bytes (PK)
function validateJarFile(jarPath) {
  const exists = fs.existsSync(jarPath);
  let size = 0;
  let magicOk = false;
  if (exists) {
    try { size = fs.statSync(jarPath).size; } catch { size = 0; }
    try {
      const fd = fs.openSync(jarPath, 'r');
      const buf = Buffer.alloc(2);
      const n = fs.readSync(fd, buf, 0, 2, 0);
      fs.closeSync(fd);
      magicOk = n === 2 && buf[0] === 0x50 && buf[1] === 0x4b;
    } catch { magicOk = false; }
  }
  return { exists, size, magicOk };
}

// Try to repair a broken Forge JAR by adopting or copying from default .minecraft
function tryRepairBrokenForgeJar(instanceDir, mcVersion, versionId) {
  try {
    // 1) Try full adoption (copies folder)
    if (tryAdoptForgeFromDefault(instanceDir, mcVersion)) {
      const vDir = path.join(instanceDir, 'versions', versionId);
      const vJar = path.join(vDir, `${versionId}.jar`);
      const info = validateJarFile(vJar);
      if (info.exists && info.size > 10 * 1024 && info.magicOk) return true;
    }
  } catch {}
  // 2) Try copying only the jar from default if same id exists
  try {
    const def = getDefaultMinecraftDir();
    if (def) {
      const defFound = findInstalledForge(def, mcVersion);
      if (defFound) {
        const srcJar = path.join(defFound.dir, `${defFound.id}.jar`);
        const srcInfo = validateJarFile(srcJar);
        if (srcInfo.exists && srcInfo.size > 10 * 1024 && srcInfo.magicOk) {
          const destDir = path.join(instanceDir, 'versions', defFound.id);
          ensureDir(destDir);
          const destJar = path.join(destDir, `${defFound.id}.jar`);
          try {
            // Also ensure JSON exists; if not, copy it as well
            const srcJson = path.join(defFound.dir, `${defFound.id}.json`);
            const destJson = path.join(destDir, `${defFound.id}.json`);
            if (fs.existsSync(srcJson) && !fs.existsSync(destJson)) {
              fs.copyFileSync(srcJson, destJson);
            }
          } catch {}
          fs.copyFileSync(srcJar, destJar);
          return true;
        }
      }
    }
  } catch {}
  return false;
}

function detectJavaPath() {
  // Common vendor install roots on Windows
  const roots = [
    'C:/Program Files/Java',
    'C:/Program Files (x86)/Java',
    'C:/Program Files/AdoptOpenJDK',
    'C:/Program Files/Adoptium',
    'C:/Program Files/Temurin',
    'C:/Program Files/Microsoft/jdk',
    'C:/Program Files/Zulu',
    'C:/Program Files/Amazon Corretto',
  ];

  const tryDir = (base) => {
    const entries = fs.readdirSync(base, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const bin = path.join(base, e.name, 'bin');
      const jW = path.join(bin, 'javaw.exe');
      const j = path.join(bin, 'java.exe');
      if (fs.existsSync(jW)) return jW;
      if (fs.existsSync(j)) return j;
    }
    return '';
  };

  for (const r of roots) {
    try {
      if (fs.existsSync(r)) {
        const found = tryDir(r);
        if (found) return found;
      }
    } catch (_) {}
  }

  // Fallback: search PATH using where
  try {
    const w1 = spawnSync('where', ['javaw'], { encoding: 'utf8' });
    const w2 = spawnSync('where', ['java'], { encoding: 'utf8' });
    const outs = [w1.stdout, w2.stdout].filter(Boolean).join('\n').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const p of outs) {
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}

  return '';
}

function javaExeFor(javaPath) {
  // Prefer java.exe for querying version; if path is javaw.exe, switch sibling
  if (/javaw\.exe$/i.test(javaPath)) {
    const cand = javaPath.replace(/javaw\.exe$/i, 'java.exe');
    if (fs.existsSync(cand)) return cand;
  }
  return javaPath;
}

function getJavaMajor(javaPath) {
  try {
    const exe = javaExeFor(javaPath);
    const out = spawnSync(exe, ['-version'], { encoding: 'utf8' });
    const all = (out.stderr || '') + '\n' + (out.stdout || '');
    // Examples: "java version \"1.8.0_381\"" or "openjdk version \"17.0.8\""
    const m = all.match(/version\s+\"([^\"]+)\"/i);
    if (!m) return 0;
    const ver = m[1];
    if (ver.startsWith('1.')) {
      // 1.8.0_x => major 8
      const p = ver.split('.')[1];
      return parseInt(p, 10) || 0;
    }
    return parseInt(ver.split('.')[0], 10) || 0;
  } catch {
    return 0;
  }
}

function listCandidateJavas() {
  const roots = [
    'C:/Program Files/Java',
    'C:/Program Files (x86)/Java',
    'C:/Program Files/AdoptOpenJDK',
    'C:/Program Files/Adoptium',
    'C:/Program Files/Temurin',
    'C:/Program Files/Microsoft/jdk',
    'C:/Program Files/Zulu',
    'C:/Program Files/Amazon Corretto',
  ];
  const candidates = new Set();
  for (const base of roots) {
    try {
      if (!fs.existsSync(base)) continue;
      const entries = fs.readdirSync(base, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const bin = path.join(base, e.name, 'bin');
        const jw = path.join(bin, 'javaw.exe');
        const j = path.join(bin, 'java.exe');
        if (fs.existsSync(jw)) candidates.add(jw);
        if (fs.existsSync(j)) candidates.add(j);
      }
    } catch {}
  }
  // PATH
  try {
    const w1 = spawnSync('where', ['javaw'], { encoding: 'utf8' });
    const w2 = spawnSync('where', ['java'], { encoding: 'utf8' });
    const outs = [w1.stdout, w2.stdout]
      .filter(Boolean)
      .join('\n')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of outs) if (fs.existsSync(p)) candidates.add(p);
  } catch {}
  return Array.from(candidates);
}

function findJavaByMajor(targetMajor) {
  const list = listCandidateJavas();
  for (const p of list) {
    const mj = getJavaMajor(p);
    if (mj === targetMajor) return p;
  }
  return '';
}

function parseMcVersionTuple(v) {
  // v like "1.20.1" => [1,20,1]
  const m = String(v).match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3] || '0', 10)];
}

function cmpVersionTuple(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const da = a[i] || 0;
    const db = b[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

async function getLatestFabricInstallerUrl() {
  const buf = await httpsGet('https://meta.fabricmc.net/v2/versions/installer');
  const list = JSON.parse(buf.toString());
  const v = list && list[0] && list[0].version;
  if (!v) throw new Error('Fabric installer version not found');
  return `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${v}/fabric-installer-${v}.jar`;
}

function isFabricInstalled(instanceDir, mcVersion) {
  const versionsDir = path.join(instanceDir, 'versions');
  if (!fs.existsSync(versionsDir)) return false;
  const entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  return entries.some((e) => e.isDirectory() && e.name.includes('fabric-loader') && e.name.endsWith(mcVersion));
}

async function ensureFabric(instanceDir, javaPath, mcVersion) {
  if (isFabricInstalled(instanceDir, mcVersion)) return { ok: true, id: null };
  const installerUrl = await getLatestFabricInstallerUrl();
  const tmpDir = path.join(app.getPath('temp'), 'minelite');
  ensureDir(tmpDir);
  const jarPath = path.join(tmpDir, 'fabric-installer.jar');
  const buf = await httpsGet(installerUrl);
  fs.writeFileSync(jarPath, buf);
  const { spawn } = require('child_process');
  return await new Promise((resolve) => {
    const args = ['-jar', jarPath, 'client', '-dir', instanceDir, '-mcversion', mcVersion, '-noprofile'];
    const p = spawn(javaPath.replace(/\\/g, '/'), args, { stdio: 'pipe' });
    p.stdout.on('data', (d) => mainWindow && mainWindow.webContents.send('log', String(d)));
    p.stderr.on('data', (d) => mainWindow && mainWindow.webContents.send('log', String(d)));
    p.on('close', (code) => {
      if (code === 0) {
        // Try to discover installed fabric id
        const versionsDir = path.join(instanceDir, 'versions');
        const entries = fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir) : [];
        const id = entries.find((name) => name.includes('fabric-loader') && name.endsWith(mcVersion)) || null;
        resolve({ ok: true, id });
      } else {
        resolve({ ok: false, error: 'Fabric installer exited with code ' + code });
      }
    });
  });
}

ipcMain.handle('launch', async (_e, { username, version, loader }) => {
  if (currentLaunch) return { ok: false, error: 'Already running' };
  const store = await getStore();
  const { defaultInstance } = await getDefaults();
  const instanceDir = store.get('instanceDir') || defaultInstance;
  ensureDir(instanceDir);
  const storedJava = store.get('javaPath');
  let javaPath = (storedJava && fs.existsSync(storedJava)) ? storedJava : '';
  if (!javaPath) {
    javaPath = detectJavaPath();
    if (javaPath) {
      // persist auto-detected java
      try {
        store.set('javaPath', javaPath);
        mainWindow && mainWindow.webContents.send('log', 'Java bulundu: ' + javaPath);
      } catch (_) {}
    }
  }
  if (!javaPath) return { ok: false, error: 'Java not found. Please select Java path.' };

  // Ensure Java compatibility vs Minecraft version
  const baseVer = version; // base MC version (not loader id)
  const t = parseMcVersionTuple(baseVer);
  // Use Java 8 for all versions up to and including 1.16.5
  const needJava8 = cmpVersionTuple(t, [1, 16, 5]) <= 0; // <= 1.16.5
  const needJava17 = cmpVersionTuple(t, [1, 18, 0]) >= 0; // >= 1.18
  const currentMajor = getJavaMajor(javaPath);
  if (needJava8 && currentMajor !== 8) {
    const j8 = findJavaByMajor(8);
    if (j8) {
      javaPath = j8;
      try { const store2 = await getStore(); store2.set('javaPath', javaPath); } catch {}
      mainWindow && mainWindow.webContents.send('log', 'Java 8’e geçirildi: ' + javaPath + ' (önceden: ' + currentMajor + ')');
    } else {
      return { ok: false, error: 'Minecraft ' + baseVer + ' için Java 8 gerekiyor. Lütfen Java 8 yolunu ayarlayın.' };
    }
  }
  if (needJava17 && currentMajor > 0 && currentMajor < 17) {
    // Try switch to Java 17+
    let j17 = '';
    const candidates = listCandidateJavas();
    for (const p of candidates) {
      const mj = getJavaMajor(p);
      if (mj >= 17) { j17 = p; break; }
    }
    if (j17) {
      javaPath = j17;
      try { const store2 = await getStore(); store2.set('javaPath', javaPath); } catch {}
      mainWindow && mainWindow.webContents.send('log', 'Java 17+’ye geçirildi: ' + javaPath + ' (önceden: ' + currentMajor + ')');
    } else {
      return { ok: false, error: 'Minecraft ' + baseVer + ' için Java 17+ gerekiyor. Lütfen Java 17 yolunu ayarlayın.' };
    }
  }

  store.set('username', username);
  store.set('gameVersion', version);
  store.set('loader', loader);

  const launcher = new Client();
  const auth = Authenticator.getAuth(username || 'Player');
  let versionId = baseVer;
  let isCustomVersion = false;
  if (loader === 'fabric') {
    mainWindow && mainWindow.webContents.send('log', 'Fabric kontrol ediliyor...');
    const res = await ensureFabric(instanceDir, javaPath, baseVer);
    if (!res.ok) return { ok: false, error: 'Fabric kurulumu başarısız: ' + res.error };
    if (res.id) {
      versionId = res.id;
      isCustomVersion = true;
    } else {
      // already installed; discover id
      const versionsDir = path.join(instanceDir, 'versions');
      if (fs.existsSync(versionsDir)) {
        const guess = fs.readdirSync(versionsDir).find((n) => /fabric-loader/i.test(n) && n.endsWith(baseVer));
        if (guess) {
          versionId = guess;
          isCustomVersion = true;
        }
      }
    }
    // Try to build Fabric version JSON from official Fabric Meta profile
    try {
      // versionId format: fabric-loader-<loaderVer>-<mcVer>
      const m = /^fabric-loader-([^\-]+)-(.*)$/.exec(versionId);
      if (m) {
        const loaderVer = m[1];
        const mcVer = m[2];
        const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVer)}/${encodeURIComponent(loaderVer)}/profile/json`;
        const profile = await httpsGetJson(url);
        // Ensure id equals our versionId so directories match
        profile.id = versionId;
        // Use inheritsFrom style so MCLC uses base downloads/json and doesn't rewrite our custom manifest
        profile.inheritsFrom = mcVer;
        // Ensure we point to base client jar, not a per-fabric versions jar
        profile.jar = mcVer;
        if (profile.downloads) delete profile.downloads;
        profile.type = 'custom';
        const vDir = path.join(instanceDir, 'versions', versionId);
        if (!fs.existsSync(vDir)) fs.mkdirSync(vDir, { recursive: true });
        const vJson = path.join(vDir, `${versionId}.json`);
        // Clear read-only if exists to avoid EPERM
        try { if (fs.existsSync(vJson)) fs.chmodSync(vJson, 0o666); } catch {}
        safeWriteJson(vJson, profile);
        const vJar = path.join(vDir, `${versionId}.jar`);
        mainWindow && mainWindow.webContents.send('log', `Fabric profil indirildi ve yazıldı: ${versionId}`);
        // Ensure base vanilla client.json and client.jar are present for base version
        try {
          await ensureBaseClientPresent(instanceDir, mcVer);
          mainWindow && mainWindow.webContents.send('log', `Base vanilla doğrulandı: ${mcVer}`);
        } catch (_) {}
        // Ensure fabric version jar exists by copying base client jar
        try {
          const baseJar = path.join(instanceDir, 'versions', mcVer, `${mcVer}.jar`);
          if (fs.existsSync(baseJar)) {
            if (!fs.existsSync(vJar)) {
              fs.copyFileSync(baseJar, vJar);
              mainWindow && mainWindow.webContents.send('log', `Fabric sürüm JAR base'den kopyalandı: ${vJar}`);
            }
          }
        } catch (e) {
          mainWindow && mainWindow.webContents.send('log', 'Uyarı: Fabric JAR kopyalama hatası: ' + String(e));
        }
      }
    } catch (e) {
      mainWindow && mainWindow.webContents.send('log', 'Uyarı: Fabric profil indirme başarısız, mevcut manifest kullanılacak: ' + String(e));
    }
  } else if (loader === 'forge') {
    mainWindow && mainWindow.webContents.send('log', 'Forge kontrol ediliyor...');
    const res = await ensureForge(instanceDir, javaPath, baseVer);
    if (!res.ok) return { ok: false, error: 'Forge kurulumu başarısız: ' + res.error };
    if (res.id) {
      versionId = res.id;
      isCustomVersion = true;
    } else {
      // already installed; discover id
      const versionsDir = path.join(instanceDir, 'versions');
      if (fs.existsSync(versionsDir)) {
        const guess = fs.readdirSync(versionsDir).find((n) => /forge/i.test(n) && n.includes(baseVer));
        if (guess) {
          versionId = guess;
          isCustomVersion = true;
        }
      }
    }
  }
  // Validate custom versions (fabric/forge) exist locally; vanilla will be downloaded by MCLC
  if (isCustomVersion) {
    try {
      const vDir = path.join(instanceDir, 'versions', versionId);
      const vJson = path.join(vDir, `${versionId}.json`);
      if (!fs.existsSync(vDir) || !fs.existsSync(vJson)) {
        mainWindow && mainWindow.webContents.send('log', `Seçilen loader sürümü bulunamadı: ${versionId}. Lütfen kurulumun tamamlandığından emin olun.`);
        return { ok: false, error: `Loader version not installed: ${versionId}` };
      }
      // For Fabric, do not require a versions jar; it uses libraries + base client jar
      let raw = {};
      try { raw = JSON.parse(fs.readFileSync(vJson, 'utf8')); } catch {}
      const vJar = path.join(vDir, `${versionId}.jar`);
      const info0 = validateJarFile(vJar);
      if (!/fabric-loader/i.test(versionId) && (!info0.exists || info0.size <= 10 * 1024 || !info0.magicOk)) {
        mainWindow && mainWindow.webContents.send('log', `JAR doğrulama: path=${vJar}, size=${info0.size}B, magicOk=${info0.magicOk}`);
        mainWindow && mainWindow.webContents.send('log', `Uyarı: Loader JAR eksik/bozuk görünüyor: ${vJar}`);
        let skippedRepair = false;
        // Forge (BootstrapLauncher) profilleri genelde local jar gerektirmez; JSON'da 'jar' yoksa kontrolü atla.
        try {
          const isForge = /forge/i.test(versionId);
          const hasOwnJar = !!raw.jar;
          const isBootstrap = /bootstraplauncher/i.test(String(raw.mainClass || ''));
          if (isForge && isBootstrap && !hasOwnJar) {
            try { await ensureBaseClientPresent(instanceDir, baseVer); } catch {}
            // Materialize merged JSON so MCLC can find client downloads and avoid jar download errors
            try {
              const manifest = await httpsGetJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
              const entry = (manifest.versions || []).find((v) => v.id === baseVer);
              if (entry && entry.url) {
                const base = await httpsGetJson(entry.url);
                const merged = { ...raw };
                merged.id = versionId;
                merged.jar = baseVer; // point to vanilla client jar
                if (base.downloads) merged.downloads = base.downloads;
                if (!merged.assetIndex && base.assetIndex) merged.assetIndex = base.assetIndex;
                if (!merged.assets && base.assets) merged.assets = base.assets;
                if (!merged.mainClass && base.mainClass) merged.mainClass = base.mainClass;
                if (merged.inheritsFrom) delete merged.inheritsFrom;
                merged.type = 'custom';
                try { if (fs.existsSync(vJson)) fs.chmodSync(vJson, 0o666); } catch {}
                safeWriteJson(vJson, merged);
                raw = merged;
                mainWindow && mainWindow.webContents.send('log', 'Forge manifest base ile zenginleştirildi (downloads/jar eklendi).');
              }
            } catch {}
            mainWindow && mainWindow.webContents.send('log', 'Forge sürümü gömülü jar gerektirmiyor (module-path). Jar kontrolü atlandı.');
            skippedRepair = true;
          }
        } catch {}

        if (!skippedRepair) {
          // Forge: attempt auto-repair by adopting/copying from default .minecraft
          const repaired = tryRepairBrokenForgeJar(instanceDir, baseVer, versionId);
          // Re-detect forge id (adoption may change id)
          const foundAfter = findInstalledForge(instanceDir, baseVer);
          if (foundAfter && foundAfter.id) versionId = foundAfter.id;
          const vDirR = path.join(instanceDir, 'versions', versionId);
          const vJarR = path.join(vDirR, `${versionId}.jar`);
          const infoR = validateJarFile(vJarR);
          mainWindow && mainWindow.webContents.send('log', `JAR onarım sonrası kontrol: path=${vJarR}, size=${infoR.size}B, magicOk=${infoR.magicOk}, repaired=${repaired}`);
          if (!(infoR.exists && infoR.size > 10 * 1024 && infoR.magicOk)) {
            // Last resort: reinstall via CLI in default .minecraft then adopt
            mainWindow && mainWindow.webContents.send('log', 'Forge JAR hâlâ bozuk. CLI ile yeniden kurulum deneniyor...');
            const rr = await reinstallForgeFromDefault(instanceDir, javaPath, baseVer);
            if (rr && rr.ok && rr.id) versionId = rr.id;
            const vDirR2 = path.join(instanceDir, 'versions', versionId);
            const vJarR2 = path.join(vDirR2, `${versionId}.jar`);
            const infoR2 = validateJarFile(vJarR2);
            mainWindow && mainWindow.webContents.send('log', `Yeniden kurulum sonrası kontrol: path=${vJarR2}, size=${infoR2.size}B, magicOk=${infoR2.magicOk}`);
            if (!(infoR2.exists && infoR2.size > 10 * 1024 && infoR2.magicOk)) {
              return { ok: false, error: 'Loader JAR bulunamadı veya bozuk: ' + vJarR2 };
            }
          }
        }
      }

      // Ensure required JVM module opens for Forge on Java 17+
      try {
        const isForge = /forge/i.test(versionId);
        const isBootstrap = /bootstraplauncher/i.test(String(raw.mainClass || ''));
        if (isForge && isBootstrap) {
          if (!raw.arguments) raw.arguments = {};
          if (!Array.isArray(raw.arguments.jvm)) raw.arguments.jvm = [];
          const jvm = raw.arguments.jvm;
          const ensureArgPair = (flag, value) => {
            const present = jvm.some((x, i) => typeof x === 'string' && x === flag && typeof jvm[i+1] === 'string' && jvm[i+1] === value)
              || jvm.some((x) => typeof x === 'string' && x.includes(value));
            if (!present) { jvm.push(flag, value); }
          };
          ensureArgPair('--add-opens', 'java.base/java.lang.invoke=ALL-UNNAMED');
          ensureArgPair('--add-opens', 'java.base/java.lang.reflect=ALL-UNNAMED');
          ensureArgPair('--add-opens', 'java.base/java.io=ALL-UNNAMED');
          ensureArgPair('--add-opens', 'java.base/java.util.jar=ALL-UNNAMED');
          // Ensure jopt-simple is present for Forge/ModLauncher on Java 17+
          try {
            if (!Array.isArray(raw.libraries)) raw.libraries = [];
            const hasJopt = raw.libraries.some((lib) => {
              try {
                const n = typeof lib?.name === 'string' ? lib.name : '';
                return /(^|\s)net\.sf\.jopt-simple:jopt-simple:/i.test(n);
              } catch { return false; }
            });
            if (!hasJopt) {
              const jopt = {
                name: 'net.sf.jopt-simple:jopt-simple:5.0.4',
                url: 'https://repo1.maven.org/maven2/'
              };
              raw.libraries.push(jopt);
              try { mainWindow && mainWindow.webContents.send('log', 'Eksik kütüphane eklendi: net.sf.jopt-simple:jopt-simple:5.0.4'); } catch {}
            }
            // Ensure log4j-core and log4j-api are present (required by ModLauncher on module-path)
            const ensureLib = (gav) => {
              const [g, a] = gav.split(':');
              const exists = raw.libraries.some((lib) => {
                try { return typeof lib?.name === 'string' && lib.name.startsWith(g + ':' + a + ':'); } catch { return false; }
              });
              if (!exists) raw.libraries.push({ name: gav, url: 'https://repo1.maven.org/maven2/' });
            };
            ensureLib('org.apache.logging.log4j:log4j-core:2.17.1');
            ensureLib('org.apache.logging.log4j:log4j-api:2.17.1');
            // SLF4J 1.7.x API ve Log4j 2 köprüsü (Forge/Mojang ile uyumlu)
            ensureLib('org.slf4j:slf4j-api:1.7.36');
            ensureLib('org.apache.logging.log4j:log4j-slf4j-impl:2.17.1');
            // Mojang LogUtils sınıfı
            ensureLib('com.mojang:logging:1.1.1');
            // LMAX Disruptor (log4j async) – güvenli
            ensureLib('com.lmax:disruptor:3.4.4');
            try { mainWindow && mainWindow.webContents.send('log', 'Eksik kütüphaneler garanti altına alındı: log4j-core/log4j-api 2.17.1'); } catch {}
          } catch {}
          try { if (fs.existsSync(vJson)) fs.chmodSync(vJson, 0o666); } catch {}
          safeWriteJson(vJson, raw);
          mainWindow && mainWindow.webContents.send('log', 'Forge JVM argümanları eklendi: --add-opens bayrakları enjekte edildi.');
        }
      } catch {}

      // Prefetch libraries in parallel (only those with downloadable URLs)
      try {
        if (Array.isArray(raw?.libraries) && raw.libraries.length) {
          const stats = await prefetchLibraries(instanceDir, raw.libraries);
          mainWindow && mainWindow.webContents.send('log', `Prefetch: libsChecked=${stats.checked}, libsDownloaded=${stats.downloaded}, skipped=${stats.skipped}`);
        }
      } catch (e) {
        mainWindow && mainWindow.webContents.send('log', 'Uyarı: Prefetch hata: ' + String(e));
      }

      // Prefetch assets in background (do not block launch)
      try {
        setImmediate(async () => {
          try {
            const a = await prefetchAssets(instanceDir, baseVer);
            if (a) mainWindow && mainWindow.webContents.send('log', `Prefetch assets: objectsChecked=${a.checked}, downloaded=${a.downloaded}, skipped=${a.skipped}`);
          } catch (e2) {
            mainWindow && mainWindow.webContents.send('log', 'Uyarı: Assets prefetch hata: ' + String(e2));
          }
        });
      } catch {}
    } catch (e) {
      return { ok: false, error: 'Version check failed: ' + String(e) };
    }
  }

  // Launch context diagnostics
  try {
    const javaMaj = getJavaMajor(javaPath);
    const ctx = { baseVer, loader, versionId, javaPath, javaMajor: javaMaj };
    mainWindow && mainWindow.webContents.send('log', 'Launch context: ' + JSON.stringify(ctx));
  } catch {}

  const options = {
    clientPackage: null,
    authorization: auth,
    root: instanceDir,
    // Use custom for Fabric/Forge (we materialized manifests)
    custom: isCustomVersion,
    version: {
      number: versionId,
      type: 'custom'
    },
    memory: {
      max: '2G',
      min: '1G'
    },
    javaPath,
  };

  // Log sanitized launch options for diagnostics
  // Ensure critical JVM args (especially for Forge on Java 17+) are passed to MCLC via customArgs
  try {
    const verDir = path.join(instanceDir, 'versions', versionId);
    const verJsonPath = path.join(verDir, `${versionId}.json`);
    let jvmArgsFromManifest = [];
    if (fs.existsSync(verJsonPath)) {
      try {
        const parsedVer = JSON.parse(fs.readFileSync(verJsonPath, 'utf8'));
        const jvm = Array.isArray(parsedVer?.arguments?.jvm) ? parsedVer.arguments.jvm : [];
        // Only include plain string args; skip rule objects for simplicity (MCLC handles rules separately)
        jvmArgsFromManifest = jvm.filter((x) => typeof x === 'string');
      } catch {}
    }
    // For Forge BootstrapLauncher on Java 17, ensure --add-opens flags are present
    const needAddOpens = true; // harmless if duplicated; we'll de-dup below
    const ensurePair = (arr, flag, val) => {
      const already = arr.some((x, i) => x === flag && arr[i + 1] === val) || arr.some((x) => typeof x === 'string' && x.includes(val));
      if (!already) arr.push(flag, val);
    };
    let merged = Array.isArray(jvmArgsFromManifest) ? jvmArgsFromManifest.slice() : [];
    if (needAddOpens) {
      ensurePair(merged, '--add-opens', 'java.base/java.lang.invoke=ALL-UNNAMED');
      ensurePair(merged, '--add-opens', 'java.base/java.lang.reflect=ALL-UNNAMED');
      ensurePair(merged, '--add-opens', 'java.base/java.io=ALL-UNNAMED');
      ensurePair(merged, '--add-opens', 'java.base/java.util.jar=ALL-UNNAMED');
    }
    // Substitute placeholders that MCLC normally replaces when reading manifest
    try {
      const libsDir = path.join(instanceDir, 'libraries').replace(/\\/g, '/');
      const cpSep = process.platform === 'win32' ? ';' : ':';
      const subs = {
        '${library_directory}': libsDir,
        '${classpath_separator}': cpSep,
        '${version_name}': versionId,
      };
      merged = merged.map((s) => typeof s === 'string' ? applySubs(s, subs) : s);
      // Ensure required modules are present on module-path (-p) for Java 17 module resolution
      try {
        const requiredLibs = [
          { name: 'net.sf.jopt-simple:jopt-simple:5.0.4', url: 'https://repo1.maven.org/maven2/', tag: 'jopt-simple' },
          { name: 'org.apache.logging.log4j:log4j-core:2.17.1', url: 'https://repo1.maven.org/maven2/', tag: 'log4j-core' },
          { name: 'org.apache.logging.log4j:log4j-api:2.17.1', url: 'https://repo1.maven.org/maven2/', tag: 'log4j-api' },
          { name: 'org.slf4j:slf4j-api:1.7.36', url: 'https://repo1.maven.org/maven2/', tag: 'slf4j-api' },
          { name: 'org.apache.logging.log4j:log4j-slf4j-impl:2.17.1', url: 'https://repo1.maven.org/maven2/', tag: 'log4j-slf4j-impl' },
          { name: 'com.mojang:logging:1.1.1', url: 'https://repo1.maven.org/maven2/', tag: 'mojang-logging' },
          { name: 'com.lmax:disruptor:3.4.4', url: 'https://repo1.maven.org/maven2/', tag: 'disruptor' },
        ];
        const idxP = merged.findIndex((s) => s === '-p' || s === '--module-path');
        if (idxP >= 0 && typeof merged[idxP + 1] === 'string') {
          let current = merged[idxP + 1];
          for (const lib of requiredLibs) {
            const info = resolveLibraryArtifact(instanceDir, lib);
            if (!info || !info.dest) continue;
            const pth = info.dest.replace(/\\/g, '/');
            if (!current.split(cpSep).some((p) => p.replace(/\\/g,'/') === pth)) {
              current += cpSep + pth;
              try { mainWindow && mainWindow.webContents.send('log', `Module-path genişletildi: ${lib.tag} eklendi.`); } catch {}
            }
          }
          merged[idxP + 1] = current;
        }
      } catch {}
    } catch {}
    // Deduplicate and sanitize Forge args to prevent jopt-simple MultipleArgumentsForOptionException
    const sanitizeArgs = (arr, { dedupeForge = true, removeOpens = false } = {}) => {
      if (!Array.isArray(arr) || !arr.length) return arr || [];
      let out = [];
      const seenPairs = new Set();
      const dedupeKeys = new Set([
        '--launchTarget',
        '--fml.forgeVersion',
        '--fml.mcVersion',
        '--fml.forgeGroup',
        '--fml.mcpVersion',
      ]);
      for (let i = 0; i < arr.length; i++) {
        const tok = arr[i];
        if (removeOpens && tok === '--add-opens') { i++; continue; }
        if (dedupeForge && dedupeKeys.has(tok)) {
          const val = (i + 1 < arr.length) ? String(arr[i + 1]) : '';
          const key = tok + '=' + val;
          if (seenPairs.has(tok)) { i++; continue; }
          seenPairs.add(tok);
          out.push(tok);
          if (val) { out.push(val); i++; }
          continue;
        }
        out.push(tok);
      }
      return out;
    };

    if (merged.length) {
      let combined = Array.isArray(options.customArgs) ? options.customArgs.concat(merged) : merged;
      combined = sanitizeArgs(combined, { dedupeForge: true, removeOpens: (currentMajor > 0 && currentMajor < 9) });
      options.customArgs = combined;
      try {
        const note = (currentMajor > 0 && currentMajor < 9) ? ' (Java<9: --add-opens temizlendi)' : '';
        mainWindow && mainWindow.webContents.send('log', 'JVM argümanları MCLC customArgs ile iletildi' + note + ': ' + JSON.stringify(combined));
      } catch {}
    }
  } catch {}
  try {
    const { authorization: _omit, ...safe } = options;
    mainWindow && mainWindow.webContents.send('log', 'Launch options: ' + JSON.stringify(safe));
    const vPath = path.join(instanceDir, 'versions', options.version.number, options.version.number + '.json');
    if (fs.existsSync(vPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(vPath, 'utf8'));
        const libsCount = Array.isArray(parsed?.libraries) ? parsed.libraries.length : 0;
        mainWindow && mainWindow.webContents.send('log', `Yerel manifest bulundu: ${vPath} (libraries=${libsCount})`);
      } catch {}
    } else {
      mainWindow && mainWindow.webContents.send('log', 'Uyarı: Yerel manifest bulunamadı, MCLC indiriyor olabilir.');
    }
  } catch {}

  // Note: This starts vanilla. Loader (fabric/forge) setup is not automated in MVP.
  // User can still download mods; they will apply when matching loader is added manually.

  return new Promise((resolve) => {
    try {
      let sawKnotError = false;
      let sawForgeDupError = false;
      let attemptedForgeFallback = false;
      let mclcExitCode = null;

      // If Forge, prefer direct Java path to avoid duplicated forge args by MCLC
      const isForgeEarly = /forge/i.test(versionId);
      if (isForgeEarly) {
        (async () => {
          try {
            mainWindow && mainWindow.webContents.send('log', 'Forge algılandı: MCLC baypas edilip doğrudan Java ile başlatılıyor.');
            const fb = await launchForgeDirect({ instanceDir, javaPath, versionId, baseVer, username, auth });
            if (!fb || !fb.ok) {
              mainWindow && mainWindow.webContents.send('log', 'Forge direct başlatma hatası: ' + (fb && fb.error ? fb.error : 'bilinmeyen'));
              mainWindow && mainWindow.webContents.send('stopped', 1);
            }
          } catch (e) {
            mainWindow && mainWindow.webContents.send('log', 'Forge direct başlatma istisnası: ' + String(e));
            mainWindow && mainWindow.webContents.send('stopped', 1);
          }
        })();
        return; // do not proceed with MCLC
      }

      currentLaunch = launcher.launch(options) || null;

      launcher.on('debug', (l) => {
        const s = String(l || '');
        if (/Could not find or load main class\s+net\.fabricmc\.loader\.impl\.launch\.knot\.KnotClient/i.test(s) || /ClassNotFoundException:\s*net\.fabricmc\.loader\.impl\.launch\.knot\.KnotClient/i.test(s)) {
          sawKnotError = true;
        }
        if (/joptsimple\.MultipleArgumentsForOptionException/i.test(s) && /launchTarget/i.test(s)) {
          sawForgeDupError = true;
        }
        mainWindow && mainWindow.webContents.send('log', s);
      });
      launcher.on('data', (l) => {
        const s = String(l || '');
        if (/Could not find or load main class\s+net\.fabricmc\.loader\.impl\.launch\.knot\.KnotClient/i.test(s) || /ClassNotFoundException:\s*net\.fabricmc\.loader\.impl\.launch\.knot\.KnotClient/i.test(s)) {
          sawKnotError = true;
        }
        if (/joptsimple\.MultipleArgumentsForOptionException/i.test(s) && /launchTarget/i.test(s)) {
          sawForgeDupError = true;
        }
        mainWindow && mainWindow.webContents.send('log', s);
      });
      launcher.on('progress', (p) => mainWindow && mainWindow.webContents.send('progress', p));
      launcher.on('error', (err) => mainWindow && mainWindow.webContents.send('log', 'Launcher error: ' + String(err)));

      if (currentLaunch && typeof currentLaunch.on === 'function') {
        currentLaunch.on('spawn', () => mainWindow && mainWindow.webContents.send('launched'));
        currentLaunch.on('close', async (code) => {
          mclcExitCode = code;
          // Fallback: if Fabric selected and KnotClient missing, try direct Java launch
          const isFabric = /fabric-loader/i.test(versionId);
          const isForge = /forge/i.test(versionId);
          if (isFabric && code !== 0 && sawKnotError) {
            try {
              mainWindow && mainWindow.webContents.send('log', 'MCLC KnotClient hatası algılandı. Doğrudan Java fallback başlatılıyor...');
              const fb = await launchFabricDirect({ instanceDir, javaPath, versionId, baseVer, username, auth });
              if (fb && fb.ok) {
                // success path handled inside launchFabricDirect
                return;
              } else if (fb && !fb.ok) {
                mainWindow && mainWindow.webContents.send('log', 'Fallback hata: ' + (fb.error || 'bilinmeyen'));
              }
            } catch (e) {
              mainWindow && mainWindow.webContents.send('log', 'Fallback başlatma istisnası: ' + String(e));
            }
          } else if (isForge && code !== 0 && (sawForgeDupError || !attemptedForgeFallback)) {
            try {
              attemptedForgeFallback = true;
              mainWindow && mainWindow.webContents.send('log', 'Forge hata çıkışı algılandı (code=' + code + '). Doğrudan Java fallback (sanitize) başlatılıyor...');
              const fb = await launchForgeDirect({ instanceDir, javaPath, versionId, baseVer, username, auth });
              if (fb && fb.ok) return;
              else if (fb && !fb.ok) mainWindow && mainWindow.webContents.send('log', 'Forge fallback hata: ' + (fb.error || 'bilinmeyen'));
            } catch (e) {
              mainWindow && mainWindow.webContents.send('log', 'Forge fallback istisnası: ' + String(e));
            }
          }
          mainWindow && mainWindow.webContents.send('stopped', code);
          currentLaunch = null;
        });
      } else {
        // Fallback: listen for close on launcher if child handle not returned
        launcher.on('close', async (code) => {
          const isFabric = /fabric-loader/i.test(versionId);
          if (isFabric && code !== 0) {
            try {
              mainWindow && mainWindow.webContents.send('log', 'Launcher kapandı (child yok). Doğrudan Java fallback deneniyor...');
              const fb = await launchFabricDirect({ instanceDir, javaPath, versionId, baseVer, username, auth });
              if (fb && fb.ok) return;
            } catch (e) {
              mainWindow && mainWindow.webContents.send('log', 'Fallback başlatma istisnası: ' + String(e));
            }
          }
          mainWindow && mainWindow.webContents.send('stopped', code);
          currentLaunch = null;
        });
      }

      resolve({ ok: true });
    } catch (err) {
      currentLaunch = null;
      resolve({ ok: false, error: String(err) });
    }
  });
});

ipcMain.handle('stop', async () => {
  if (!currentLaunch) return { ok: false, error: 'Not running' };
  try {
    if (typeof currentLaunch.kill === 'function') {
      currentLaunch.kill('SIGKILL');
      currentLaunch = null;
      return { ok: true };
    } else {
      currentLaunch = null;
      return { ok: false, error: 'Process handle unavailable' };
    }
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Modrinth minimal helpers
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'MineLiteLauncher/0.1' } }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      })
      .on('error', reject);
  });
}

// Generic HTTPS GET that resolves with Buffer (supports basic redirects)
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'MineLiteLauncher/0.1' } }, (res) => {
        // follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(httpsGet(res.headers.location));
        }
        if (res.statusCode !== 200) {
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(dest));
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error('HTTP ' + res.statusCode));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      })
      .on('error', (err) => {
        fs.unlink(dest, () => reject(err));
      });
  });
}

// Robust downloader with timeout, limited redirects, and retries
function downloadWithRetry(url, dest, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const retries = opts.retries ?? 2;

  const attempt = (currentUrl, remainingRedirects, remainingRetries) => new Promise((resolve, reject) => {
    try { ensureDir(path.dirname(dest)); } catch {}
    const file = fs.createWriteStream(dest);
    const req = https.get(currentUrl, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && remainingRedirects > 0) {
        file.close(() => fs.unlink(dest, () => {
          resolve(attempt(res.headers.location, remainingRedirects - 1, remainingRetries));
        }));
        return;
      }
      if (res.statusCode !== 200) {
        file.close(() => fs.unlink(dest, () => reject(new Error('HTTP ' + res.statusCode))));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Timeout'));
    });
    req.on('error', (err) => {
      try { file.close(() => fs.unlink(dest, () => {})); } catch {}
      if (remainingRetries > 0) {
        setTimeout(() => resolve(attempt(currentUrl, remainingRedirects, remainingRetries - 1)), 500);
      } else {
        reject(err);
      }
    });
  });

  return attempt(url, maxRedirects, retries);
}

// Resolve library artifact relative path and download URL
function resolveLibraryArtifact(instanceDir, lib) {
  try {
    const artifact = lib?.downloads?.artifact || {};
    let rel = artifact.path || '';
    if (!rel && lib && typeof lib.name === 'string') {
      const parts = lib.name.split(':');
      if (parts.length >= 3) {
        const [groupId, artifactId, ver] = parts;
        const groupPath = groupId.replace(/\./g, '/');
        rel = `${groupPath}/${artifactId}/${ver}/${artifactId}-${ver}.jar`;
      }
    }
    if (!rel) return null;
    const dest = path.join(instanceDir, 'libraries', rel);
    let url = artifact.url || '';
    if (!url) {
      const baseUrl = lib.url || 'https://libraries.minecraft.net/';
      url = baseUrl.replace(/\/+$/,'/') + rel.replace(/\\/g, '/');
    }
    return { rel, dest, url };
  } catch {
    return null;
  }
}

// Prefetch libraries concurrently to speed up first launch
async function prefetchLibraries(instanceDir, libraries, concurrency = 8) {
  const jobs = [];
  let checked = 0;
  for (const lib of (libraries || [])) {
    const info = resolveLibraryArtifact(instanceDir, lib);
    if (!info || !info.url || !info.dest) { continue; }
    checked++;
    const { url, dest } = info;
    jobs.push(async () => {
      try {
        // Skip if already present and non-trivial size
        if (fs.existsSync(dest)) {
          try { const s = fs.statSync(dest).size; if (s > 1024) return 'skipped'; } catch {}
        }
        await downloadWithRetry(url, dest, { timeoutMs: 30000, retries: 2 });
        return 'downloaded';
      } catch {
        // tolerate errors; MCLC may download later
        return 'skipped';
      }
    });
  }

  const downloadedRef = { n: 0 };
  const skippedRef = { n: 0 };
  let idx = 0;
  const worker = async () => {
    for (;;) {
      const my = idx++;
      if (my >= jobs.length) break;
      const res = await jobs[my]();
      if (res === 'downloaded') downloadedRef.n++;
      else skippedRef.n++;
    }
  };
  const pool = new Array(Math.min(concurrency, jobs.length)).fill(0).map(() => worker());
  await Promise.all(pool);
  return { checked, downloaded: downloadedRef.n, skipped: skippedRef.n };
}

// Ensure base vanilla version JSON and client.jar exist so MCLC doesn't rely on custom profile downloads
async function ensureBaseClientPresent(instanceDir, baseVer) {
  try {
    const manifest = await httpsGetJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    const entry = (manifest.versions || []).find((v) => v.id === baseVer);
    if (!entry || !entry.url) return;
    const base = await httpsGetJson(entry.url);
    const vDir = path.join(instanceDir, 'versions', baseVer);
    ensureDir(vDir);
    const vJson = path.join(vDir, `${baseVer}.json`);
    try { fs.writeFileSync(vJson, JSON.stringify(base, null, 2)); } catch {}
    const jarPath = path.join(vDir, `${baseVer}.jar`);
    const haveJar = fs.existsSync(jarPath) && (() => { try { const s = fs.statSync(jarPath).size; return s > 1024 * 1024; } catch { return false; } })();
    if (!haveJar) {
      const url = base?.downloads?.client?.url;
      if (url) {
        try {
          await downloadToFile(url, jarPath);
        } catch (e) {
          // Log but don't fail launch upfront; MCLC may still handle it
          mainWindow && mainWindow.webContents.send('log', 'Uyarı: Vanilla client.jar indirme hatası: ' + String(e));
        }
      }
    }
  } catch (_) {}
}

ipcMain.handle('mods:list-popular', async () => {
  // Top mods by downloads
  const url = 'https://api.modrinth.com/v2/search?query=&facets=%5B%5B%22project_type%3Amod%22%5D%5D&index=downloads&limit=30';
  const data = await httpsGetJson(url);
  return data.hits.map((h) => ({ id: h.project_id, title: h.title, desc: h.description, downloads: h.downloads }));
});

ipcMain.handle('mods:download', async (_e, { projectId, gameVersion, loader }) => {
  try {
    const versionsUrl = `https://api.modrinth.com/v2/project/${projectId}/version?game_versions=%5B%22${encodeURIComponent(gameVersion)}%22%5D${loader ? `&loaders=%5B%22${encodeURIComponent(loader)}%22%5D` : ''}`;
    const versions = await httpsGetJson(versionsUrl);
    if (!versions.length) return { ok: false, error: 'No compatible version found' };
    const files = versions[0].files || [];
    const file = files.find((f) => f.filename.endsWith('.jar')) || files[0];
    if (!file) return { ok: false, error: 'No file to download' };

    const store = await getStore();
    const { defaultInstance } = await getDefaults();
    const instanceDir = store.get('instanceDir') || defaultInstance;
    const modsDir = path.join(instanceDir, 'mods');
    ensureDir(modsDir);
    const dest = path.join(modsDir, file.filename);
    await downloadToFile(file.url, dest);
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('open-path', async (_e, p) => {
  try {
    await shell.openPath(p);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('open-external', async (_e, url) => {
  try {
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('open-mods-dir', async () => {
  try {
    const store = await getStore();
    const { defaultInstance } = await getDefaults();
    const instanceDir = store.get('instanceDir') || defaultInstance;
    const modsDir = path.join(instanceDir, 'mods');
    ensureDir(modsDir);
    await shell.openPath(modsDir);
    return true;
  } catch (e) {
    return false;
  }
});

// Auto-select Java based on MC version and persist
ipcMain.handle('java:auto-select', async (_e, baseVersion) => {
  try {
    const t = parseMcVersionTuple(baseVersion || '');
    if (!t.length) return { ok: false, error: 'Geçersiz Minecraft sürümü' };
    const needJava8 = cmpVersionTuple(t, [1, 16, 5]) <= 0; // <= 1.16.5
    const needJava17 = cmpVersionTuple(t, [1, 18, 0]) >= 0; // >= 1.18
    let selected = '';
    if (needJava8) {
      selected = findJavaByMajor(8) || '';
    } else if (needJava17) {
      // pick first >=17
      const candidates = listCandidateJavas();
      for (const p of candidates) { const mj = getJavaMajor(p); if (mj >= 17) { selected = p; break; } }
    } else {
      // 1.17.x prefers 16/17; try 17, else 8 as fallback
      const candidates = listCandidateJavas();
      for (const p of candidates) { const mj = getJavaMajor(p); if (mj >= 17) { selected = p; break; } }
      if (!selected) selected = findJavaByMajor(8) || '';
    }
    if (!selected) return { ok: false, error: 'Uygun Java bulunamadı. Lütfen Ayarlar’dan uygun Java yolunu seçin.' };
    try { const store = await getStore(); store.set('javaPath', selected); } catch {}
    mainWindow && mainWindow.webContents.send('log', 'Java otomatik seçildi: ' + selected);
    return { ok: true, javaPath: selected };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Updater: basic check trigger
ipcMain.handle('check-updates', async () => {
  if (!autoUpdater) return { ok: false, error: 'Updater not available' };
  try {
    autoUpdater.autoDownload = false;
    autoUpdater.on('update-available', () => mainWindow && mainWindow.webContents.send('log', 'Güncelleme bulundu.'));
    autoUpdater.on('update-not-available', () => mainWindow && mainWindow.webContents.send('log', 'Güncelleme yok.'));
    autoUpdater.on('error', (e) => mainWindow && mainWindow.webContents.send('log', 'Updater hata: ' + e));
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
