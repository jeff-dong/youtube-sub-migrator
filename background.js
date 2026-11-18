const ALARM_KEEPALIVE = 'yt_sub_migrator_keepalive';
let importLoopRunning = false;

chrome.action.onClicked.addListener(() => {
  openManagerTab();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_KEEPALIVE) {
    const { importState } = await chrome.storage.local.get('importState');
    if (importState && importState.status === 'running' && !importLoopRunning) {
      runImportQueue();
    } else if (!importState || importState.status !== 'running') {
      chrome.alarms.clear(ALARM_KEEPALIVE);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;
  switch (message.type) {
    case 'OPEN_MANAGER':
      openManagerTab().then(() => sendResponse({ ok: true }));
      return true;
    case 'START_EXPORT':
      handleStartExport()
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    case 'START_IMPORT':
      handleStartImport(message.channels, message.delayMs)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
      return true;
    case 'PAUSE_IMPORT':
      updateImportStatus('paused').then(() => sendResponse({ ok: true }));
      return true;
    case 'RESUME_IMPORT':
      handleResumeImport().then((res) => sendResponse(res));
      return true;
    case 'STOP_IMPORT':
      updateImportStatus('stopped').then(() => sendResponse({ ok: true }));
      return true;
    default:
      return false;
  }
});

async function openManagerTab() {
  const managerUrl = chrome.runtime.getURL('manager.html');
  const existing = await chrome.tabs.query({ url: managerUrl });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: managerUrl, active: true });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, timeoutMs);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete' && !settled) {
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function handleStartExport() {
  await chrome.storage.local.set({
    exportState: {
      status: 'running',
      message: '正在打开 YouTube 订阅列表页面并滚动加载全部频道...',
      count: 0,
      updatedAt: Date.now()
    }
  });

  const tab = await chrome.tabs.create({ url: 'https://www.youtube.com/feed/channels', active: true });
  await waitForTabComplete(tab.id, 25000);
  await sleep(2000);

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: scrapeChannelsInPageMainWorld
  });

  const payload = results && results[0] ? results[0].result : null;
  if (!payload || !payload.ok) {
    const errMsg = (payload && payload.error) || '未能读取订阅列表，请确认已登录 YouTube 账号。';
    await chrome.storage.local.set({
      exportState: { status: 'error', message: errMsg, count: 0, updatedAt: Date.now() }
    });
    return { ok: false, error: errMsg };
  }

  await chrome.storage.local.set({
    exportedData: {
      exportedAt: new Date().toISOString(),
      count: payload.channels.length,
      channels: payload.channels
    },
    exportState: {
      status: 'completed',
      message: `成功导出 ${payload.channels.length} 个订阅频道！`,
      count: payload.channels.length,
      updatedAt: Date.now()
    }
  });

  const managerTabs = await chrome.tabs.query({ url: chrome.runtime.getURL('manager.html') });
  if (managerTabs.length > 0) {
    await chrome.tabs.update(managerTabs[0].id, { active: true });
  }
  return { ok: true, count: payload.channels.length };
}

async function scrapeChannelsInPageMainWorld() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (location.hostname.includes('accounts.google.com')) {
    return { ok: false, error: '当前浏览器未登录 YouTube，请先登录原账号后再试。' };
  }

  for (let i = 0; i < 16; i++) {
    if (document.querySelector('ytd-channel-renderer')) break;
    if (document.querySelector('ytd-background-promo-renderer a[href*="accounts.google.com"]')) {
      return { ok: false, error: '检测到当前未登录 YouTube 账号，请先登录后再导出。' };
    }
    await wait(500);
  }

  let stagnantRounds = 0;
  let lastCount = -1;
  for (let round = 0; round < 400; round++) {
    const currentCount = document.querySelectorAll('ytd-channel-renderer').length;
    const scrollTarget = Math.max(
      document.documentElement.scrollHeight || 0,
      document.body?.scrollHeight || 0,
      document.getElementById('primary')?.scrollHeight || 0
    );
    window.scrollTo(0, scrollTarget);
    await wait(750);

    const afterCount = document.querySelectorAll('ytd-channel-renderer').length;
    const stillHasContinuation = Boolean(
      document.querySelector('ytd-continuation-item-renderer, yt-continuation-item-renderer')
    );

    if (afterCount === lastCount && !stillHasContinuation) {
      if (++stagnantRounds >= 3) break;
    } else if (afterCount === currentCount && afterCount === lastCount) {
      if (++stagnantRounds >= 6) break;
    } else {
      stagnantRounds = 0;
    }
    lastCount = afterCount;
  }

  window.scrollTo(0, 0);
  const channelMap = new Map();

  for (const el of document.querySelectorAll('ytd-channel-renderer')) {
    const data = el.data || {};
    const channelId = data.channelId || '';
    const linkEl = el.querySelector('a#main-link, a.channel-link, a[href*="/@"], a[href*="/channel/"]');
    const rawHref = linkEl ? linkEl.getAttribute('href') || '' : '';
    const canonicalBase = data.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || rawHref || '';

    let handle = '';
    if (canonicalBase.startsWith('/@')) {
      handle = canonicalBase.slice(1).split('/')[0];
    } else {
      const subText = (el.querySelector('#subscribers')?.textContent || '').trim();
      if (subText.startsWith('@')) handle = subText.split(/\s+/)[0];
    }

    const title =
      data.title?.simpleText ||
      data.title?.runs?.map((r) => r.text).join('') ||
      (el.querySelector('ytd-channel-name #text, #channel-title')?.textContent || '').trim();

    let url = '';
    if (channelId && channelId.startsWith('UC')) {
      url = `https://www.youtube.com/channel/${channelId}`;
    } else if (canonicalBase) {
      url = canonicalBase.startsWith('http')
        ? canonicalBase
        : `https://www.youtube.com${canonicalBase.startsWith('/') ? '' : '/'}${canonicalBase}`;
    }

    const description =
      data.descriptionSnippet?.runs?.map((r) => r.text).join('') ||
      (el.querySelector('#description')?.textContent || '').trim();
    const subscriberInfo =
      data.videoCountText?.simpleText ||
      data.subscriberCountText?.simpleText ||
      (el.querySelector('#video-count, #subscribers')?.textContent || '').trim();
    const thumbs = data.thumbnail?.thumbnails || [];
    const rawAvatar =
      (thumbs.length ? thumbs[thumbs.length - 1].url : '') ||
      el.querySelector('#avatar img, yt-img-shadow img')?.getAttribute('src') ||
      '';
    const avatar = rawAvatar.startsWith('//') ? `https:${rawAvatar}` : rawAvatar;

    const key = channelId || handle || url;
    if (key && url) {
      channelMap.set(key, {
        channelId,
        handle,
        title: title || handle || channelId,
        url,
        subscriberInfo,
        description,
        avatar
      });
    }
  }

  return { ok: true, channels: Array.from(channelMap.values()) };
}

async function handleStartImport(channels, delayMs = 3000) {
  if (!Array.isArray(channels) || channels.length === 0) {
    return { ok: false, error: '待导入的频道列表为空。' };
  }
  const sanitizedDelay = Math.max(1500, Math.min(30000, Number(delayMs) || 3000));
  const queue = channels.map((ch, idx) => ({
    index: idx,
    channelId: ch.channelId || '',
    handle: ch.handle || '',
    title: ch.title || ch.handle || ch.channelId || ch.url,
    url: (ch.url || '').replace(/^http:\/\//i, 'https://'),
    status: 'pending',
    note: ''
  }));

  await chrome.storage.local.set({
    importState: {
      status: 'running',
      delayMs: sanitizedDelay,
      workerTabId: null,
      updatedAt: Date.now(),
      stats: { total: queue.length, processed: 0, subscribed: 0, alreadySubscribed: 0, failed: 0 },
      logs: [`[${new Date().toLocaleTimeString()}] 开始导入任务，共 ${queue.length} 个频道。`],
      queue
    }
  });
  chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 0.4 });
  runImportQueue();
  return { ok: true };
}

async function updateImportStatus(newStatus) {
  const { importState } = await chrome.storage.local.get('importState');
  if (!importState) return;
  importState.status = newStatus;
  importState.updatedAt = Date.now();
  importState.logs = [...(importState.logs || []).slice(-199), `[${new Date().toLocaleTimeString()}] 状态切换为：${newStatus}`];
  await chrome.storage.local.set({ importState });
  if (newStatus !== 'running') chrome.alarms.clear(ALARM_KEEPALIVE);
}

async function handleResumeImport() {
  const { importState } = await chrome.storage.local.get('importState');
  if (!importState) return { ok: false, error: '没有可继续的导入任务。' };
  importState.status = 'running';
  importState.updatedAt = Date.now();
  await chrome.storage.local.set({ importState });
  chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 0.4 });
  runImportQueue();
  return { ok: true };
}

async function ensureWorkerTab(existingTabId) {
  if (existingTabId) {
    try {
      const tab = await chrome.tabs.get(existingTabId);
      if (tab && tab.id) return tab.id;
    } catch (_) {}
  }
  const tab = await chrome.tabs.create({ url: 'https://www.youtube.com', active: false });
  return tab.id;
}

async function runImportQueue() {
  if (importLoopRunning) return;
  importLoopRunning = true;
  try {
    while (true) {
      const { importState } = await chrome.storage.local.get('importState');
      if (!importState || importState.status !== 'running') break;

      const nextIdx = importState.queue.findIndex((item) => item.status === 'pending');
      if (nextIdx === -1) {
        importState.status = 'completed';
        importState.logs = [
          ...(importState.logs || []).slice(-199),
          `[${new Date().toLocaleTimeString()}] 全部完成！新订阅 ${importState.stats.subscribed}，已订阅 ${importState.stats.alreadySubscribed}，失败 ${importState.stats.failed}。`
        ];
        await chrome.storage.local.set({ importState });
        chrome.alarms.clear(ALARM_KEEPALIVE);
        break;
      }

      const workerTabId = await ensureWorkerTab(importState.workerTabId);
      importState.workerTabId = workerTabId;
      importState.queue[nextIdx].status = 'processing';
      await chrome.storage.local.set({ importState });

      const targetItem = importState.queue[nextIdx];
      let outcome = { status: 'failed', note: '未知错误' };
      try {
        await chrome.tabs.update(workerTabId, { url: targetItem.url });
        await waitForTabComplete(workerTabId, 20000);
        await sleep(1600);
        const execRes = await chrome.scripting.executeScript({
          target: { tabId: workerTabId },
          world: 'MAIN',
          func: subscribeChannelInPageMainWorld
        });
        const res = execRes && execRes[0] ? execRes[0].result : null;
        outcome = res && res.ok
          ? { status: res.status, note: res.note || '' }
          : { status: 'failed', note: (res && res.error) || '未找到订阅按钮' };
      } catch (err) {
        outcome = { status: 'failed', note: err.message || String(err) };
      }

      const { importState: latest } = await chrome.storage.local.get('importState');
      if (!latest) break;
      latest.queue[nextIdx].status = outcome.status;
      latest.queue[nextIdx].note = outcome.note;
      latest.stats.processed += 1;
      if (outcome.status === 'subscribed') latest.stats.subscribed += 1;
      else if (outcome.status === 'already_subscribed') latest.stats.alreadySubscribed += 1;
      else latest.stats.failed += 1;

      latest.logs = [
        ...(latest.logs || []).slice(-199),
        `[${new Date().toLocaleTimeString()}] [${latest.stats.processed}/${latest.stats.total}] ${targetItem.title} -> ${outcome.status}`
      ];
      await chrome.storage.local.set({ importState: latest });
      if (latest.status !== 'running') break;

      const jitter = Math.floor((Math.random() - 0.5) * 0.5 * latest.delayMs);
      await sleep(Math.max(1200, latest.delayMs + jitter));
    }
  } finally {
    importLoopRunning = false;
  }
}

async function subscribeChannelInPageMainWorld() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (location.hostname.includes('accounts.google.com')) {
    return { ok: false, error: '未登录目标 YouTube 账号' };
  }

  function classifyButtonState(container, btn) {
    if (!btn) return 'unknown';
    const polymer = container.closest
      ? container.closest('ytd-subscribe-button-renderer') || (container.tagName === 'YTD-SUBSCRIBE-BUTTON-RENDERER' ? container : null)
      : null;
    if (polymer && (polymer.hasAttribute('subscribed') || polymer.data?.subscribed === true)) {
      return 'subscribed';
    }
    const text = (btn.textContent || '').replace(/\s+/g, ' ').trim();
    const aria = (btn.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (/^(Subscribed|已订阅|已訂閱|登録済み|구독중)$/i.test(text) || /(Unsubscribe|退订|取消订阅|取消訂閱|通知|Current setting is)/i.test(aria)) {
      return 'subscribed';
    }
    if (/^(Subscribe|订阅|訂閱|チャンネル登録|구독)$/i.test(text) || /^(Subscribe to|订阅|訂閱)/i.test(aria)) {
      return 'unsubscribed';
    }
    return 'unknown';
  }

  function findHeaderSubscribeTarget() {
    const scopes = [
      document.querySelector('yt-page-header-view-model'),
      document.querySelector('#page-header'),
      document.querySelector('ytd-c4-tabbed-header-renderer'),
      document.querySelector('#channel-header-container'),
      document.querySelector('ytd-browse[page-subtype="channels"]')
    ].filter(Boolean);
    for (const scope of scopes) {
      for (const sel of ['yt-subscribe-button-view-model', 'ytd-subscribe-button-renderer', '#subscribe-button']) {
        const container = scope.querySelector(sel);
        if (!container) continue;
        const btn = container.querySelector('button') || (container.tagName === 'BUTTON' ? container : null);
        if (btn && btn.offsetParent !== null) return { container, btn };
      }
    }
    return null;
  }

  let found = null;
  for (let i = 0; i < 20; i++) {
    found = findHeaderSubscribeTarget();
    if (found) break;
    await wait(400);
  }
  if (!found) return { ok: false, error: '未在频道页找到订阅按钮' };

  if (classifyButtonState(found.container, found.btn) === 'subscribed') {
    return { ok: true, status: 'already_subscribed', note: '原本已订阅' };
  }

  found.btn.click();
  for (let j = 0; j < 10; j++) {
    await wait(400);
    const signInModal = document.querySelector('ytd-modal-with-title-and-button-renderer a[href*="accounts.google.com"]');
    if (signInModal && signInModal.offsetParent !== null) {
      return { ok: false, error: '目标账号未登录' };
    }
    const refreshed = findHeaderSubscribeTarget() || found;
    if (classifyButtonState(refreshed.container, refreshed.btn) === 'subscribed') {
      return { ok: true, status: 'subscribed', note: '订阅成功' };
    }
  }
  return { ok: false, error: '点击后未检测到已订阅状态（可能受限于订阅频率）' };
}
