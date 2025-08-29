const $ = (q) => document.querySelector(q);
const modsList = $('#modsList');
const logBox = $('#log');
const progressBar = $('#progressBar');

function log(line) {
  logBox.value += (line + '\n');
  logBox.scrollTop = logBox.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function loadSettings() {
  const s = await window.api.getSettings();
  $('#username').value = s.username || 'Player';
  $('#loader').value = s.loader || 'fabric';
  $('#instanceDir').value = s.defaultInstance;
  $('#javaPath').value = s.defaultJava || '';

  // Populate version selector
  const sel = $('#versionSelect');
  sel.innerHTML = '<option>Yükleniyor...</option>';
  try {
    const res = await window.api.listVersions();
    if (!res.ok) throw new Error(res.error || 'versiyon listesi alınamadı');
    const versions = res.versions || [];
    sel.innerHTML = '';
    // Prefer releases first, then snapshots/old
    const order = { release: 0, snapshot: 1, old_beta: 2, old_alpha: 3, undefined: 9 };
    versions.sort((a,b)=> (order[a.type]??9)-(order[b.type]??9) || b.id.localeCompare(a.id));
    for (const v of versions) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.id}${v.type && v.type!=='release' ? ' ('+v.type+')' : ''}`;
      sel.appendChild(opt);
    }
    // Select stored value or fallback to 1.20.1 if exists
    const want = s.version || '1.20.1';
    if ([...sel.options].some(o=>o.value===want)) sel.value = want;
  } catch (e) {
    sel.innerHTML = '<option value="1.20.1">1.20.1</option>';
  }
}

async function refreshMods() {
  modsList.innerHTML = '<li>Yükleniyor...</li>';
  try {
    const mods = await window.api.listPopularMods();
    modsList.innerHTML = '';
    for (const m of mods) {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="meta">
          <div class="title">${m.title}</div>
          <div class="desc">${m.desc || ''}</div>
        </div>
        <div class="actions">
          <button data-id="${m.id}" class="dl">İndir</button>
        </div>
      `;
      modsList.appendChild(li);
    }
  } catch (e) {
    modsList.innerHTML = `<li>Hata: ${e}</li>`;
  }
}

async function init() {
  await loadSettings();
  await refreshMods();

  $('#btnChooseInstance').addEventListener('click', async () => {
    const p = await window.api.chooseInstanceDir();
    if (p) $('#instanceDir').value = p;
  });

  $('#btnChooseJava').addEventListener('click', async () => {
    const p = await window.api.chooseJavaPath();
    if (p) $('#javaPath').value = p;
  });

  $('#btnRefreshMods').addEventListener('click', refreshMods);

  const btnCU = document.querySelector('#btnCheckUpdates');
  if (btnCU) {
    btnCU.addEventListener('click', async () => {
      btnCU.disabled = true;
      btnCU.textContent = 'Kontrol ediliyor...';
      const res = await window.api.checkUpdates();
      if (!res.ok) log('Güncelleme kontrolü hata: ' + res.error);
      setTimeout(() => { btnCU.disabled = false; btnCU.textContent = 'Güncellemeleri kontrol et'; }, 1000);
    });
  }

  const btnDiscord = document.querySelector('#btnDiscord');
  if (btnDiscord) {
    btnDiscord.addEventListener('click', async () => {
      const url = 'https://discord.gg/VE3ksXN9V3';
      await window.api.openExternal(url);
    });
  }

  const btnOpenMods = document.querySelector('#btnOpenMods');
  if (btnOpenMods) {
    btnOpenMods.addEventListener('click', async () => {
      await window.api.openModsDir();
    });
  }

  // Auto-select Java when version changes
  const versionSelect = document.querySelector('#versionSelect');
  const loaderSelect = document.querySelector('#loader');
  const javaPathInput = document.querySelector('#javaPath');
  const runAutoPick = async () => {
    if (!versionSelect) return;
    const v = versionSelect.value;
    const res = await window.api.javaAutoSelect(v);
    if (res && res.ok) {
      if (javaPathInput) javaPathInput.value = res.javaPath || '';
      log('Java otomatik seçildi: ' + res.javaPath);
    } else if (res && res.error) {
      log('Java otomatik seçimi başarısız: ' + res.error);
    }
  };
  if (versionSelect) versionSelect.addEventListener('change', runAutoPick);
  if (loaderSelect) loaderSelect.addEventListener('change', runAutoPick);
  // initial
  setTimeout(runAutoPick, 0);

  modsList.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.classList.contains('dl')) {
      t.disabled = true;
      t.textContent = 'İndiriliyor...';
      const projectId = t.getAttribute('data-id');
      const gameVersion = $('#versionSelect').value;
      const loader = $('#loader').value;
      const res = await window.api.downloadMod({ projectId, gameVersion, loader });
      if (res.ok) {
        t.textContent = 'İndirildi';
        log(`Mod indirildi: ${res.path}`);
      } else {
        t.textContent = 'Hata';
        log(`Mod indirme hatası: ${res.error}`);
      }
      setTimeout(() => { t.disabled = false; t.textContent = 'İndir'; }, 1500);
    }
  });

  $('#btnLaunch').addEventListener('click', async () => {
    const btn = $('#btnLaunch');
    btn.disabled = true;
    const username = $('#username').value || 'Player';
    const version = $('#versionSelect').value || '1.20.1';
    const loader = $('#loader').value;
    await window.api.saveUserSettings({ username, version, loader });
    const res = await window.api.launch({ username, version, loader });
    if (!res.ok) {
      log(`Başlatma hatası: ${res.error}`);
      alert('Başlatma hatası: ' + res.error);
      btn.disabled = false;
    } else {
      log('Başlatılıyor...');
    }
  });

  $('#btnStop').addEventListener('click', async () => {
    const res = await window.api.stop();
    if (!res.ok) {
      log('Durdurma: ' + res.error);
    }
  });

  window.api.onLog((m) => log(m));
  window.api.onProgress((p) => {
    const v = Math.min(100, Math.max(0, Math.floor((p.task / Math.max(1, p.total)) * 100)));
    progressBar.style.width = v + '%';
  });
  window.api.onLaunched(() => log('Minecraft çalışıyor.'));
  window.api.onStopped((code) => {
    log('Minecraft kapandı. Kod: ' + code);
    progressBar.style.width = '0%';
    const btn = $('#btnLaunch');
    if (btn) btn.disabled = false;
  });

  // Yorumlar sekmesi
  const commentsList = document.querySelector('#commentsList');
  const cAuthor = document.querySelector('#cAuthor');
  const cText = document.querySelector('#cText');
  const btnAddComment = document.querySelector('#btnAddComment');

  async function loadComments() {
    try {
      const res = await window.api.listComments();
      if (!res.ok) throw new Error(res.error || 'yorumlar alınamadı');
      renderComments(res.comments || []);
    } catch (e) {
      commentsList.innerHTML = `<li>Hata: ${e}</li>`;
    }
  }

  function renderComments(items) {
    commentsList.innerHTML = '';
    if (!items.length) {
      commentsList.innerHTML = '<li>Henüz yorum yok.</li>';
      return;
    }
    for (const it of items) {
      const li = document.createElement('li');
      const date = new Date(it.ts || Date.now()).toLocaleString();
      li.innerHTML = `
        <div class="meta">
          <div class="title">${(it.author||'Anonim')} <small style="opacity:.7">${date}</small></div>
          <div class="desc">${escapeHtml(it.text||'')}</div>
        </div>
        <div class="actions">
          <button class="danger" data-id="${it.id}">Sil</button>
        </div>
      `;
      commentsList.appendChild(li);
    }
  }

  if (btnAddComment) {
    btnAddComment.addEventListener('click', async () => {
      const author = (cAuthor && cAuthor.value) || '';
      const text = (cText && cText.value) || '';
      const res = await window.api.addComment({ author, text });
      if (!res.ok) {
        alert('Yorum ekleme hatası: ' + res.error);
        return;
      }
      if (cText) cText.value = '';
      await loadComments();
    });
  }

  if (commentsList) {
    commentsList.addEventListener('click', async (e) => {
      const t = e.target;
      if (t.tagName === 'BUTTON' && t.classList.contains('danger')) {
        const id = t.getAttribute('data-id');
        const ok = confirm('Bu yorumu silmek istediğinizden emin misiniz?');
        if (!ok) return;
        const res = await window.api.deleteComment(id);
        if (!res.ok) alert('Silme hatası: ' + res.error);
        await loadComments();
      }
    });
  }

  // İlk yüklemede yorumları getir (sekme görünmese de hazır olsun)
  if (commentsList) { await loadComments(); }

  // Tabs
  initTabs(loadComments);
}

init();

function initTabs(onCommentsActivate) {
  const buttons = document.querySelectorAll('.tab-btn');
  const pages = ['#tab-settings', '#tab-mods', '#tab-console', '#tab-comments'].map((s)=>$(s));
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.getAttribute('data-target');
      pages.forEach(p=> p.classList.add('hidden'));
      const page = document.querySelector(target);
      if (page) page.classList.remove('hidden');
      if (typeof onCommentsActivate === 'function' && target === '#tab-comments') {
        onCommentsActivate();
      }
    });
  });
}
