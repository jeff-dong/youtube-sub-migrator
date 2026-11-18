let exportedChannels = [];
let importItems = [];

const btnScan = document.getElementById('btnScan');
const btnDownloadJson = document.getElementById('btnDownloadJson');
const btnDownloadCsv = document.getElementById('btnDownloadCsv');
const exportBanner = document.getElementById('exportBanner');
const exportPreviewWrap = document.getElementById('exportPreviewWrap');
const exportCountLabel = document.getElementById('exportCountLabel');
const exportSearchInput = document.getElementById('exportSearchInput');
const exportTableBody = document.getElementById('exportTableBody');

const fileInput = document.getElementById('fileInput');
const btnLoadCached = document.getElementById('btnLoadCached');
const delayInput = document.getElementById('delayInput');
const importControlsWrap = document.getElementById('importControlsWrap');
const statTotal = document.getElementById('statTotal');
const statProcessed = document.getElementById('statProcessed');
const statSubscribed = document.getElementById('statSubscribed');
const statAlready = document.getElementById('statAlready');
const statFailed = document.getElementById('statFailed');
const progressBarFill = document.getElementById('progressBarFill');
const btnStartImport = document.getElementById('btnStartImport');
const btnPauseImport = document.getElementById('btnPauseImport');
const btnResumeImport = document.getElementById('btnResumeImport');
const btnStopImport = document.getElementById('btnStopImport');
const btnExportFailed = document.getElementById('btnExportFailed');
const btnSelectAll = document.getElementById('btnSelectAll');
const btnSelectNone = document.getElementById('btnSelectNone');
const btnSelectFailed = document.getElementById('btnSelectFailed');
const importSelectedLabel = document.getElementById('importSelectedLabel');
const importSearchInput = document.getElementById('importSearchInput');
const importTableBody = document.getElementById('importTableBody');
const logOutput = document.getElementById('logOutput');

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showExportBanner(msg, type = 'info') {
  exportBanner.textContent = msg;
  exportBanner.className = `banner ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`;
}

function renderExportTable() {
  const q = (exportSearchInput.value || '').trim().toLowerCase();
  const filtered = exportedChannels.filter((ch) =>
    !q || (ch.title || '').toLowerCase().includes(q) || (ch.handle || '').toLowerCase().includes(q) || (ch.channelId || '').toLowerCase().includes(q)
  );
  exportCountLabel.textContent = `共导出 ${exportedChannels.length} 个频道（显示 ${filtered.length} 个）`;
  exportPreviewWrap.classList.toggle('hidden', exportedChannels.length === 0);
  btnDownloadJson.disabled = exportedChannels.length === 0;
  btnDownloadCsv.disabled = exportedChannels.length === 0;

  exportTableBody.innerHTML = filtered.map((ch) => `
    <tr>
      <td>${ch.avatar ? `<img class="avatar-img" src="${escapeHtml(ch.avatar)}" alt="" />` : '<div class="avatar-img"></div>'}</td>
      <td><strong>${escapeHtml(ch.title)}</strong></td>
      <td>${escapeHtml([ch.handle, ch.channelId].filter(Boolean).join(' · ') || '-')}</td>
      <td>${escapeHtml((ch.description || ch.subscriberInfo || '').slice(0, 70))}</td>
      <td><a class="link" href="${escapeHtml(ch.url)}" target="_blank" rel="noopener noreferrer">打开</a></td>
    </tr>
  `).join('');
}

function downloadBlob(content, filename, mimeType) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  chrome.downloads.download({ url, filename, saveAs: true });
}

function escapeCsvCell(val) {
  const s = String(val ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

btnScan.addEventListener('click', () => {
  btnScan.disabled = true;
  showExportBanner('正在打开 YouTube 订阅页并自动滚动提取全部频道...');
  chrome.runtime.sendMessage({ type: 'START_EXPORT' }, (res) => {
    btnScan.disabled = false;
    if (!res || !res.ok) showExportBanner((res && res.error) || '扫描失败', 'error');
  });
});

btnDownloadJson.addEventListener('click', () => {
  const dateStr = new Date().toISOString().slice(0, 10);
  downloadBlob(
    JSON.stringify({ format: 'youtube-sub-migrator-v1', exportedAt: new Date().toISOString(), count: exportedChannels.length, channels: exportedChannels }, null, 2),
    `youtube-subscriptions-${dateStr}.json`,
    'application/json;charset=utf-8'
  );
});

btnDownloadCsv.addEventListener('click', () => {
  const dateStr = new Date().toISOString().slice(0, 10);
  const lines = ['Channel Id,Channel Url,Channel Title'];
  for (const ch of exportedChannels) {
    const id = ch.channelId || ch.handle || '';
    const url = ch.channelId ? `https://www.youtube.com/channel/${ch.channelId}` : ch.url;
    lines.push([escapeCsvCell(id), escapeCsvCell(url), escapeCsvCell(ch.title)].join(','));
  }
  downloadBlob('\uFEFF' + lines.join('\n'), `youtube-subscriptions-${dateStr}.csv`, 'text/csv;charset=utf-8');
});

exportSearchInput.addEventListener('input', renderExportTable);

function parseCsvRow(line) {
  const res = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { res.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  res.push(cur.trim());
  return res;
}

function normalizeImportedChannels(rawText) {
  const text = rawText.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  if (text.startsWith('{') || text.startsWith('[')) {
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : parsed.channels || parsed.subscriptions || [];
    return arr.map((item) => {
      const channelId = item.channelId || item.id || '';
      const handle = item.handle || '';
      let url = item.url || item.channelUrl || (channelId.startsWith('UC') ? `https://www.youtube.com/channel/${channelId}` : handle ? `https://www.youtube.com/${handle.startsWith('@') ? handle : '@' + handle}` : '');
      url = url.replace(/^http:\/\//i, 'https://');
      return { selected: true, channelId, handle, title: item.title || item.name || handle || channelId || url, url, status: 'pending', note: '' };
    }).filter((x) => x.url.includes('youtube.com/'));
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    if (i === 0 && cols.length >= 2 && !cols[0].startsWith('UC') && !cols[0].includes('youtube.com') && !cols[1].includes('youtube.com')) continue;
    if (cols.length >= 3) {
      const [colId, colUrl, colTitle] = cols;
      const url = (colUrl || (colId.startsWith('UC') ? `https://www.youtube.com/channel/${colId}` : '')).replace(/^http:\/\//i, 'https://');
      if (url) items.push({ selected: true, channelId: colId.startsWith('UC') ? colId : '', handle: colId.startsWith('@') ? colId : '', title: colTitle || colId || url, url, status: 'pending', note: '' });
    } else if (cols[0]) {
      const raw = cols[0];
      const url = raw.includes('youtube.com/') ? raw.replace(/^http:\/\//i, 'https://') : raw.startsWith('UC') ? `https://www.youtube.com/channel/${raw}` : raw.startsWith('@') ? `https://www.youtube.com/${raw}` : '';
      if (url) items.push({ selected: true, channelId: raw.startsWith('UC') ? raw : '', handle: raw.startsWith('@') ? raw : '', title: cols[1] || raw, url, status: 'pending', note: '' });
    }
  }
  return items;
}

function renderImportTable() {
  importControlsWrap.classList.toggle('hidden', importItems.length === 0);
  importSelectedLabel.textContent = `已勾选 ${importItems.filter((i) => i.selected).length} / ${importItems.length} 项`;
  const q = (importSearchInput.value || '').trim().toLowerCase();
  importTableBody.innerHTML = importItems.map((item, idx) => ({ item, idx }))
    .filter(({ item }) => !q || (item.title || '').toLowerCase().includes(q) || (item.url || '').toLowerCase().includes(q))
    .map(({ item, idx }) => {
      const map = {
        pending: ['badge-pending', '待处理'],
        processing: ['badge-processing', '正在订阅...'],
        subscribed: ['badge-subscribed', '新订阅成功'],
        already_subscribed: ['badge-already', '原本已订阅'],
        failed: ['badge-failed', item.note ? `失败: ${item.note}` : '失败']
      };
      const [cls, label] = map[item.status] || map.pending;
      return `<tr>
        <td><input type="checkbox" class="import-check" data-idx="${idx}" ${item.selected ? 'checked' : ''} /></td>
        <td><strong>${escapeHtml(item.title)}</strong></td>
        <td><a class="link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.url)}</a></td>
        <td><span class="badge ${cls}">${escapeHtml(label)}</span></td>
      </tr>`;
    }).join('');
}

importTableBody.addEventListener('change', (e) => {
  if (e.target.classList.contains('import-check')) {
    const idx = Number(e.target.dataset.idx);
    if (importItems[idx]) {
      importItems[idx].selected = e.target.checked;
      importSelectedLabel.textContent = `已勾选 ${importItems.filter((i) => i.selected).length} / ${importItems.length} 项`;
    }
  }
});

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const parsed = normalizeImportedChannels(await file.text());
    if (!parsed.length) return alert('未识别到有效的频道记录。');
    importItems = parsed;
    statTotal.textContent = String(importItems.length);
    renderImportTable();
  } catch (err) {
    alert('文件解析失败：' + (err.message || String(err)));
  } finally {
    fileInput.value = '';
  }
});

btnLoadCached.addEventListener('click', () => {
  if (!exportedChannels.length) return alert('尚无扫描缓存，请先执行第一步导出或上传文件。');
  importItems = exportedChannels.map((ch) => ({ selected: true, channelId: ch.channelId || '', handle: ch.handle || '', title: ch.title, url: ch.url, status: 'pending', note: '' }));
  statTotal.textContent = String(importItems.length);
  renderImportTable();
});

btnSelectAll.addEventListener('click', () => { importItems.forEach((i) => (i.selected = true)); renderImportTable(); });
btnSelectNone.addEventListener('click', () => { importItems.forEach((i) => (i.selected = false)); renderImportTable(); });
btnSelectFailed.addEventListener('click', () => { importItems.forEach((i) => (i.selected = i.status === 'failed')); renderImportTable(); });
importSearchInput.addEventListener('input', renderImportTable);

btnStartImport.addEventListener('click', () => {
  const selected = importItems.filter((i) => i.selected);
  if (!selected.length) return alert('请至少勾选一个频道。');
  chrome.runtime.sendMessage({ type: 'START_IMPORT', channels: selected, delayMs: Math.round((parseFloat(delayInput.value) || 3) * 1000) });
});
btnPauseImport.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'PAUSE_IMPORT' }));
btnResumeImport.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'RESUME_IMPORT' }));
btnStopImport.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'STOP_IMPORT' }));
btnExportFailed.addEventListener('click', () => {
  const failed = importItems.filter((i) => i.status === 'failed');
  if (failed.length) downloadBlob(JSON.stringify({ channels: failed }, null, 2), 'youtube-failed-subscriptions.json', 'application/json;charset=utf-8');
});

function applyImportState(st) {
  if (!st || !Array.isArray(st.queue)) return;
  importItems = st.queue.map((q) => ({ selected: q.status === 'pending' || q.status === 'failed', channelId: q.channelId, handle: q.handle, title: q.title, url: q.url, status: q.status, note: q.note }));
  const s = st.stats || { total: 0, processed: 0, subscribed: 0, alreadySubscribed: 0, failed: 0 };
  statTotal.textContent = String(s.total);
  statProcessed.textContent = `${s.processed} / ${s.total}`;
  statSubscribed.textContent = String(s.subscribed);
  statAlready.textContent = String(s.alreadySubscribed);
  statFailed.textContent = String(s.failed);
  progressBarFill.style.width = `${s.total > 0 ? Math.round((s.processed / s.total) * 100) : 0}%`;
  btnStartImport.disabled = st.status === 'running' || st.status === 'paused';
  btnPauseImport.disabled = st.status !== 'running';
  btnResumeImport.disabled = st.status !== 'paused';
  btnStopImport.disabled = !(st.status === 'running' || st.status === 'paused');
  btnExportFailed.disabled = s.failed === 0;
  if (st.logs && st.logs.length) { logOutput.textContent = st.logs.join('\n'); logOutput.scrollTop = logOutput.scrollHeight; }
  renderImportTable();
}

chrome.storage.local.get(['exportedData', 'exportState', 'importState']).then(({ exportedData, exportState, importState }) => {
  if (exportedData && exportedData.channels) { exportedChannels = exportedData.channels; renderExportTable(); }
  if (exportState && exportState.message) showExportBanner(exportState.message, exportState.status === 'error' ? 'error' : exportState.status === 'completed' ? 'success' : 'info');
  if (importState && importState.queue) applyImportState(importState);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.exportedData?.newValue) { exportedChannels = changes.exportedData.newValue.channels || []; renderExportTable(); }
  if (changes.exportState?.newValue) {
    const st = changes.exportState.newValue;
    showExportBanner(st.message, st.status === 'error' ? 'error' : st.status === 'completed' ? 'success' : 'info');
    btnScan.disabled = st.status === 'running';
  }
  if (changes.importState?.newValue) applyImportState(changes.importState.newValue);
});
