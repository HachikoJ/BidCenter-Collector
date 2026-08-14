const DETAIL_TIMEOUT = 45000;
const DEFAULT_SETTINGS = {
  intervalMs: 3000,
  concurrency: 3,
  pageSize: 40
};
const ALL_INFORMATION_TYPES = [
  '招标公告', '招标变更', '中标结果', '采购信息', '招标预告', '审批公示',
  '拍卖转让', '土地挂牌', '司法拍卖', '其它公告'
];
const DEFAULT_INFORMATION_TYPES = ['招标公告', '中标结果'];
const ADVANCED_FILTER_KEYS = ['purchaseMethod', 'fundingSource', 'evaluationMethod', 'qualificationCertificate'];
const PLATFORM_DAILY_LIMIT = 800;
const PLUGIN_DAILY_LIMIT = 780;
const ACTIVATION_STORAGE_KEY = 'collectorActivation';
const activeDetailTabs = new Map();
const verificationTabs = new Set();
let logQueue = Promise.resolve();
let systemErrorQueue = Promise.resolve();
let progressQueue = Promise.resolve();
let partialQueue = Promise.resolve();
let quotaQueue = Promise.resolve();
let dailyLimitQueue = Promise.resolve();
let batchGeneration = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requireActivation() {
  const stored = await chrome.storage.local.get(ACTIVATION_STORAGE_KEY);
  if (stored[ACTIVATION_STORAGE_KEY]?.activated !== true) {
    throw new Error('工具尚未激活，请先在侧边栏输入公益激活码。');
  }
}

function inspectBidcenterLoginPage() {
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const currentUrl = location.href;
  if (/\/login(?:[/?#]|$)|\/signin(?:[/?#]|$)/i.test(location.pathname)
    || /^sso\.bidcenter\.com\.cn$/i.test(location.hostname)) {
    return { loggedIn: false, definitive: true, reason: '当前页面是登录页面' };
  }
  const loggedInPanel = [...document.querySelectorAll('.ssjg-header_login.islogin')].find(visible);
  const visibleLogout = loggedInPanel && [...loggedInPanel.querySelectorAll('a, button')]
    .some((element) => visible(element) && /^(退出|退出登录|安全退出)$/.test((element.innerText || element.textContent || '').trim()));
  if (loggedInPanel && visibleLogout) {
    return { loggedIn: true, definitive: true, reason: '页面显示已登录账号和退出入口', url: currentUrl };
  }
  const loggedOutPanel = [...document.querySelectorAll('.ssjg-header_login.nologin')].find(visible);
  const visiblePassword = [...document.querySelectorAll('input[type="password"]')].some(visible);
  if (loggedOutPanel || visiblePassword) {
    return { loggedIn: false, definitive: true, reason: '页面显示登录入口或登录表单', url: currentUrl };
  }
  return { loggedIn: false, definitive: false, reason: '页面未出现可确认的登录标识', url: currentUrl };
}

async function inspectLoginTab(tab) {
  if (!tab?.id || !/^(?:https?:\/\/)(?:[^/]+\.)?bidcenter\.com\.cn(?:\/|$)/i.test(tab.url || '')) {
    return { loggedIn: false, definitive: false, reason: '不是采招网页面' };
  }
  if (/^https?:\/\/sso\.bidcenter\.com\.cn\/login/i.test(tab.url || '')) {
    return { loggedIn: false, definitive: true, reason: '已跳转至采招网登录页面' };
  }
  try {
    const [execution] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: inspectBidcenterLoginPage });
    return execution?.result || { loggedIn: false, definitive: false, reason: '登录检查没有返回结果' };
  } catch (error) {
    return { loggedIn: false, definitive: false, reason: `无法读取页面登录状态：${error.message}` };
  }
}

async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const existing = await chrome.tabs.get(tabId).catch(() => null);
  if (!existing || existing.status === 'complete') return existing;
  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(await chrome.tabs.get(tabId).catch(() => null));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(tab);
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function memberLoginStatus({ preferredTabId = 0, allowProbe = true } = {}) {
  const checked = new Set();
  let definiteFailure = null;
  const check = async (tab) => {
    if (!tab?.id || checked.has(tab.id)) return null;
    checked.add(tab.id);
    const status = await inspectLoginTab(tab);
    if (status.loggedIn) return status;
    if (status.definitive) definiteFailure = status;
    return null;
  };
  if (preferredTabId) {
    const preferred = await chrome.tabs.get(preferredTabId).catch(() => null);
    const status = await check(preferred);
    if (status) return status;
  }
  const tabs = (await chrome.tabs.query({}))
    .filter((tab) => /^(?:https?:\/\/)(?:[^/]+\.)?bidcenter\.com\.cn(?:\/|$)/i.test(tab.url || ''))
    .sort((left, right) => Number(right.active) - Number(left.active));
  for (const tab of tabs) {
    const status = await check(tab);
    if (status) return status;
  }
  if (allowProbe) {
    const probe = await chrome.tabs.create({ url: 'https://www.bidcenter.com.cn/', active: false });
    try {
      const loaded = await waitForTabComplete(probe.id);
      const status = await inspectLoginTab(loaded);
      if (status.loggedIn) return status;
      if (status.definitive) definiteFailure = status;
    } finally {
      await chrome.tabs.remove(probe.id).catch(() => undefined);
    }
  }
  return definiteFailure || { loggedIn: false, definitive: false, reason: '无法确认采招网会员登录状态' };
}

async function requireMemberLogin(options) {
  const status = await memberLoginStatus(options);
  if (status.loggedIn) return status;
  const error = new Error(status.definitive
    ? '尚未登录采招网会员账号，请先登录后再开始采集。'
    : '无法确认采招网会员登录状态，请打开或刷新采招网首页，确认页面显示账号和“退出”后重试。');
  error.code = 'LOGIN_REQUIRED';
  error.detail = status.reason;
  throw error;
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function pauseStartedAt(state = {}) {
  return timestamp(state.pausedAt)
    || (['paused', 'error', 'verification_wait', 'daily_limit', 'login_required'].includes(state.status) ? timestamp(state.updatedAt) : 0);
}

function taskTiming(state = {}, now = Date.now()) {
  const startedAt = timestamp(state.startedAt);
  if (!startedAt) return { activeMs: 0, pausedMs: 0 };
  const endedAt = timestamp(state.endedAt) || now;
  const currentPause = pauseStartedAt(state);
  const pausedMs = Math.max(0, Number(state.totalPausedMs) || 0)
    + (currentPause ? Math.max(0, endedAt - currentPause) : 0);
  return { activeMs: Math.max(0, endedAt - startedAt - pausedMs), pausedMs };
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return [hours, minutes, seconds % 60].map((value) => String(value).padStart(2, '0')).join(':');
}

function resumedTimingPatch(state, now = Date.now()) {
  const pausedAt = pauseStartedAt(state);
  return {
    totalPausedMs: Math.max(0, Number(state.totalPausedMs) || 0) + (pausedAt ? Math.max(0, now - pausedAt) : 0),
    pausedAt: '', endedAt: ''
  };
}

function previousCalendarMonthRange(reference = new Date()) {
  const format = (date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  return {
    start: format(new Date(reference.getFullYear(), reference.getMonth() - 1, 1)),
    end: format(new Date(reference.getFullYear(), reference.getMonth(), 0))
  };
}

function localDateKey(reference = new Date()) {
  return [reference.getFullYear(), String(reference.getMonth() + 1).padStart(2, '0'), String(reference.getDate()).padStart(2, '0')].join('-');
}

async function getDailyQuotaUsage() {
  const today = localDateKey();
  const { dailyQuotaUsage = {} } = await chrome.storage.local.get('dailyQuotaUsage');
  if (dailyQuotaUsage.date === today) {
    return {
      date: today,
      used: Math.min(PLUGIN_DAILY_LIMIT, Math.max(0, Number(dailyQuotaUsage.used) || 0)),
      limit: PLUGIN_DAILY_LIMIT,
      platformLimit: PLATFORM_DAILY_LIMIT
    };
  }
  const reset = { date: today, used: 0, limit: PLUGIN_DAILY_LIMIT, platformLimit: PLATFORM_DAILY_LIMIT };
  await chrome.storage.local.set({ dailyQuotaUsage: reset });
  return reset;
}

function reserveDailyQuotaSlot() {
  const reserve = async () => {
    const usage = await getDailyQuotaUsage();
    if (usage.used >= PLUGIN_DAILY_LIMIT) return { reserved: false, usage };
    const next = { ...usage, used: usage.used + 1 };
    await chrome.storage.local.set({ dailyQuotaUsage: next });
    return { reserved: true, usage: next };
  };
  quotaQueue = quotaQueue.then(reserve, reserve);
  return quotaQueue;
}

function markDailyLimitReached(usage) {
  const mark = async () => {
    const current = await taskState();
    if (current.status === 'daily_limit') return;
    await saveTask({
      status: 'daily_limit', dailyLimitDate: usage.date,
      error: '', verificationUntil: 0, pausedAt: current.pausedAt || new Date().toISOString()
    });
    await chrome.action.setBadgeBackgroundColor({ color: '#b54708' });
    await chrome.action.setBadgeText({ text: 'LIMIT' });
    await log('warn', '今日详情访问达到插件保护线',
      `${usage.used}/${usage.limit}；平台上限 ${usage.platformLimit}；任务已保存，次日点击“继续”从当前分页未完成项接着采集`);
  };
  dailyLimitQueue = dailyLimitQueue.then(mark, mark);
  return dailyLimitQueue;
}

function appendSystemError(details) {
  systemErrorQueue = systemErrorQueue.then(async () => {
    const { systemErrors = [] } = await chrome.storage.local.get('systemErrors');
    await chrome.storage.local.set({ systemErrors: [...systemErrors, details].slice(-100) });
  });
  return systemErrorQueue;
}

async function recordSystemError(error, context, url = '') {
  const message = error?.message || String(error || '未知错误');
  const details = {
    time: new Date().toISOString(), message, stack: error?.stack || '',
    url, context, source: 'background'
  };
  await appendSystemError(details);
  const current = await taskState();
  await saveTask({ status: 'error', error: message, errorDetails: details, pausedAt: current.pausedAt || new Date().toISOString() });
  await log('error', '系统级错误', `${context}：${message}`);
  return details;
}

globalThis.addEventListener?.('error', (event) => {
  recordSystemError(event.error || new Error(event.message), 'Service Worker 未捕获异常').catch(() => undefined);
});
globalThis.addEventListener?.('unhandledrejection', (event) => {
  recordSystemError(event.reason instanceof Error ? event.reason : new Error(String(event.reason)), 'Service Worker 未处理 Promise 异常').catch(() => undefined);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

async function taskState() {
  const { task = { status: 'idle', records: [], completedPages: [], logs: [] } } = await chrome.storage.local.get('task');
  return task;
}

async function saveTask(patch) {
  const current = await taskState();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ task: next });
  return next;
}

function log(level, message, detail = '') {
  logQueue = logQueue.then(async () => {
    const { taskLogs = [] } = await chrome.storage.local.get('taskLogs');
    const logs = [...taskLogs, {
      time: new Date().toISOString(), level, message, detail: String(detail || '')
    }].slice(-500);
    await chrome.storage.local.set({ taskLogs: logs });
  });
  return logQueue;
}

async function startSilentSearch(keyword, rawSettings = {}) {
  await requireMemberLogin();
  const quota = await getDailyQuotaUsage();
  if (quota.used >= quota.limit) {
    await markDailyLimitReached(quota);
    return { started: false, dailyLimit: true, message: `今日插件访问已达 ${quota.used}/${quota.limit}，请次日继续。` };
  }
  batchGeneration += 1;
  const previous = await taskState();
  if (previous.listTabId) await chrome.tabs.remove(previous.listTabId).catch(() => undefined);
  const settings = normalizeSettings(rawSettings);
  const informationTypes = settings.informationTypes;
  const timeRange = { start: settings.timeRangeStart, end: settings.timeRangeEnd };
  const timeLabel = settings.timeFilterMode === 'custom' ? '自定义时间' : '上个月整月';
  const advancedSummary = Object.values(settings.advancedFilters).filter((value) => value !== '全部').join('、') || '全部';
  const url = `https://search.bidcenter.com.cn/search?keywords=${encodeURIComponent(keyword)}&time=5&stime=${timeRange.start}&endtime=${timeRange.end}&mod=0`;
  await chrome.storage.local.set({ task: {
    status: 'searching', keyword, records: [], completedPages: [], currentPage: 1,
    currentPageCount: 0, batchTotal: 0, batchDone: 0, batchFailed: 0, partialRecords: [],
    settings,
    informationTypes, typeFilterIndex: 0,
    currentType: informationTypes[0], completedTypes: [],
    typeFilterApplied: false, typeFilterPending: '', filterStage: '',
    timeFilterMode: settings.timeFilterMode, timeRangeStart: timeRange.start, timeRangeEnd: timeRange.end,
    timeFilterApplied: false, listUrl: url, awaitingSignature: '', error: '',
    verificationUntil: 0, verificationMode: '', verificationRiskType: '', verificationTabIds: [], verificationUrl: '',
    advancedFilters: settings.advancedFilters, excludeWords: settings.excludeWords,
    relatedWords: settings.relatedWords, advancedFiltersApplied: false,
    startedAt: new Date().toISOString(), pausedAt: '', totalPausedMs: 0, endedAt: '',
    updatedAt: new Date().toISOString()
  } });
  await chrome.storage.local.set({ taskLogs: [] });
  await chrome.action.setBadgeText({ text: '' });
  await log('info', '开始后台搜索', `${keyword}；会员登录已校验；${timeLabel} ${timeRange.start} 至 ${timeRange.end}；高级筛选 ${advancedSummary}；排除词 ${settings.excludeWords.length}/5；相关词 ${settings.relatedWords.length}/5；依次筛选 ${informationTypes.join(' → ')}；间隔 ${settings.intervalMs}ms；并发 ${settings.concurrency}`);
  const tab = await chrome.tabs.create({ url, active: false });
  await saveTask({ listTabId: tab.id });
  await log('info', '已创建后台结果页', url);
  return { started: true };
}

function normalizeSettings(value = {}) {
  const intervalMs = Math.min(30000, Math.max(200, Number(value.intervalMs) || DEFAULT_SETTINGS.intervalMs));
  const concurrency = Math.min(6, Math.max(1, Number(value.concurrency) || DEFAULT_SETTINGS.concurrency));
  const configuredTypes = Array.isArray(value.informationTypes)
    ? value.informationTypes.filter((type, index, values) => ALL_INFORMATION_TYPES.includes(type) && values.indexOf(type) === index)
    : [];
  const informationTypes = ALL_INFORMATION_TYPES.filter((type) => configuredTypes.includes(type));
  const timeFilterMode = value.timeFilterMode === 'custom' ? 'custom' : 'previous_calendar_month';
  const defaultRange = previousCalendarMonthRange();
  const timeRangeStart = timeFilterMode === 'custom' ? String(value.timeRangeStart || '') : defaultRange.start;
  const timeRangeEnd = timeFilterMode === 'custom' ? String(value.timeRangeEnd || '') : defaultRange.end;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(timeRangeStart) || !/^\d{4}-\d{2}-\d{2}$/.test(timeRangeEnd) || timeRangeStart > timeRangeEnd) {
    throw new Error('自定义时间范围无效，请检查开始日期和结束日期。');
  }
  const advancedFilters = Object.fromEntries(ADVANCED_FILTER_KEYS.map((key) => [key, String(value.advancedFilters?.[key] || '全部').trim() || '全部']));
  const normalizeWords = (words) => {
    const normalized = [...new Set((Array.isArray(words) ? words : [])
      .map((word) => String(word || '').trim()).filter(Boolean))].slice(0, 5);
    if (normalized.some((word) => word.length > 10 || word.includes(','))) {
      throw new Error('排除词和相关词每项不得超过 10 个字，且不能包含逗号。');
    }
    return normalized;
  };
  const excludeWords = normalizeWords(value.excludeWords);
  const relatedWords = normalizeWords(value.relatedWords);
  return {
    intervalMs, concurrency,
    informationTypes: informationTypes.length ? informationTypes : [...DEFAULT_INFORMATION_TYPES],
    timeFilterMode, timeRangeStart, timeRangeEnd,
    advancedFilters, excludeWords, relatedWords
  };
}

function armDetailTimeout(tabId, pending) {
  clearTimeout(pending.timer);
  pending.timer = setTimeout(async () => {
    if (activeDetailTabs.get(tabId) !== pending) return;
    activeDetailTabs.delete(tabId);
    await clearVerification(tabId);
    chrome.tabs.remove(tabId).catch(() => undefined);
    pending.reject(new Error('详情页在 45 秒内未完成采集。'));
  }, DETAIL_TIMEOUT);
}

function waitForDetail(tabId, url, title) {
  return new Promise((resolve, reject) => {
    const pending = { resolve, reject, timer: 0, url, title };
    activeDetailTabs.set(tabId, pending);
    armDetailTimeout(tabId, pending);
  });
}

async function openSilentDetail(url, title) {
  const { task = {} } = await chrome.storage.local.get('task');
  const listTab = task.listTabId ? await chrome.tabs.get(task.listTabId).catch(() => null) : null;
  const createProperties = { url, active: false };
  if (listTab && /(^|\.)bidcenter\.com\.cn$/i.test(new URL(listTab.url || '').hostname)) {
    createProperties.openerTabId = listTab.id;
  }
  log('info', '后台打开详情页', `${title || url}；活动详情 ${activeDetailTabs.size} 个；使用浏览器已登录会话${createProperties.openerTabId ? '，关联结果页' : ''}`);
  const tab = await chrome.tabs.create(createProperties);
  const result = waitForDetail(tab.id, url, title);
  return result;
}

async function clearVerification(tabId) {
  verificationTabs.delete(tabId);
  await chrome.alarms.clear(`verification-${tabId}`);
  const current = await taskState();
  const remaining = new Set([
    ...verificationTabs,
    ...(Array.isArray(current.verificationTabIds) ? current.verificationTabIds : [])
  ]);
  remaining.delete(tabId);
  verificationTabs.clear();
  remaining.forEach((id) => verificationTabs.add(id));
  if (remaining.size) {
    await saveTask({ verificationTabIds: [...remaining] });
    return;
  }
  if (current.status === 'verification_wait') {
    await saveTask({
      status: 'running', verificationUntil: 0, verificationMode: '', verificationRiskType: '',
      verificationTabIds: [], verificationUrl: '', error: '', ...resumedTimingPatch(current)
    });
  }
  await chrome.action.setBadgeText({ text: '' });
}

async function finishDetail(tabId, record, error) {
  const pending = activeDetailTabs.get(tabId);
  if (!pending) return;
  activeDetailTabs.delete(tabId);
  clearTimeout(pending.timer);
  await chrome.tabs.remove(tabId).catch(() => undefined);
  await clearVerification(tabId);
  if (error) {
    await log('error', '详情采集失败', `${pending.title || pending.url}：${error}`);
    pending.reject(new Error(error));
    return;
  }
  log('success', '详情采集成功', `${record.信息id || '-'} ${record.信息标题 || pending.title}`);
  pending.resolve(record);
}

function updateBatchProgress(failed) {
  progressQueue = progressQueue.then(async () => {
    const current = await taskState();
    await saveTask({
      batchDone: (current.batchDone || 0) + 1,
      batchFailed: (current.batchFailed || 0) + (failed ? 1 : 0)
    });
  });
  return progressQueue;
}

async function runDetailBatch(entries) {
  const generation = batchGeneration;
  const { task: batchTask = {} } = await chrome.storage.local.get('task');
  await requireMemberLogin({ preferredTabId: batchTask.listTabId, allowProbe: false });
  const settings = normalizeSettings(batchTask.settings);
  await saveTask({ batchTotal: entries.length, batchDone: 0, batchFailed: 0 });
  await log('info', `开始整页批量采集 ${entries.length} 条`, `并发数 ${Math.min(settings.concurrency, entries.length)}，间隔 ${settings.intervalMs}ms`);
  const results = new Array(entries.length);
  let nextIndex = 0;
  const workerNextOpenAt = new Map();
  async function worker() {
    const workerId = [...workerNextOpenAt.keys()].length + 1;
    workerNextOpenAt.set(workerId, 0);
    while (nextIndex < entries.length && generation === batchGeneration) {
      let state = await taskState();
      while (state.status === 'verification_wait' && generation === batchGeneration) {
        await sleep(1000);
        state = await taskState();
      }
      if (state.status === 'paused') return;
      if (state.status === 'daily_limit') return;
      if (state.status === 'stopped') throw new Error('任务已停止。');
      const index = nextIndex;
      nextIndex += 1;
      const entry = entries[index];
      try {
        const now = Date.now();
        const scheduledAt = Math.max(now, workerNextOpenAt.get(workerId) || 0);
        workerNextOpenAt.set(workerId, scheduledAt + settings.intervalMs);
        if (scheduledAt > now) await sleep(scheduledAt - now);
        state = await taskState();
        if (generation !== batchGeneration || !['searching', 'filtering', 'running'].includes(state.status)) return;
        const quota = await reserveDailyQuotaSlot();
        if (!quota.reserved) {
          await markDailyLimitReached(quota.usage);
          return;
        }
        await log('info', `并发通道 ${workerId} 启动详情`, `活动详情 ${activeDetailTabs.size + 1}/${Math.min(settings.concurrency, entries.length)}`);
        const record = await openSilentDetail(entry.url, entry.title);
        await updateBatchProgress(false);
        results[index] = { url: entry.url, summary: entry.summary, record };
        await persistPartialResult(results[index]);
      } catch (error) {
        await updateBatchProgress(true);
        results[index] = { url: entry.url, summary: entry.summary, error: error.message || '详情采集失败。' };
        await persistPartialResult(results[index]);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(settings.concurrency, entries.length) }, () => worker()));
  const completedResults = results.filter(Boolean);
  if (generation !== batchGeneration) return completedResults;
  const failed = completedResults.filter((result) => result.error).length;
  const finalState = await taskState();
  await log(failed || finalState.status === 'daily_limit' ? 'warn' : 'success',
    finalState.status === 'daily_limit' ? '批量采集已在保护线处暂停' : '整页批量采集结束',
    `完成 ${completedResults.length}/${entries.length} 条，成功 ${completedResults.length - failed} 条，失败 ${failed} 条`);
  return completedResults;
}

async function persistPartialResult(result) {
  partialQueue = partialQueue.then(async () => {
    const current = await taskState();
    const partial = [...(current.partialRecords || [])];
    const key = result.url || result.record?.网址;
    const index = partial.findIndex((item) => (item.url || item.record?.网址) === key);
    if (index >= 0) partial[index] = result;
    else partial.push(result);
    await saveTask({ partialRecords: partial });
  });
  return partialQueue;
}

async function stopTask() {
  batchGeneration += 1;
  const current = await taskState();
  for (const [tabId, pending] of activeDetailTabs) {
    clearTimeout(pending.timer);
    pending.reject(new Error('任务已停止。'));
    chrome.tabs.remove(tabId).catch(() => undefined);
  }
  activeDetailTabs.clear();
  const verificationIds = new Set([
    ...verificationTabs,
    ...(Array.isArray(current.verificationTabIds) ? current.verificationTabIds : [])
  ]);
  for (const tabId of verificationIds) await chrome.alarms.clear(`verification-${tabId}`);
  verificationTabs.clear();
  if (current.listTabId) chrome.tabs.remove(current.listTabId).catch(() => undefined);
  const endedAt = new Date().toISOString();
  const timingPatch = resumedTimingPatch(current, timestamp(endedAt));
  const finalState = await saveTask({
    status: 'stopped', error: '', verificationUntil: 0, verificationMode: '',
    verificationRiskType: '', verificationTabIds: [], verificationUrl: '', ...timingPatch, endedAt
  });
  const timing = taskTiming(finalState);
  await chrome.action.setBadgeText({ text: '' });
  await log('warn', '用户停止任务，请尽快导出 Excel', `运行 ${formatDuration(timing.activeMs)}；暂停 ${formatDuration(timing.pausedMs)}；避免浏览器清理或任务重置后结果失效无法下载`);
}

async function resumeTask() {
  const current = await taskState();
  await requireMemberLogin({ preferredTabId: current.listTabId });
  const quota = await getDailyQuotaUsage();
  if (quota.used >= quota.limit) {
    await markDailyLimitReached(quota);
    return { resumed: false, dailyLimit: true, message: `今日插件访问已达 ${quota.used}/${quota.limit}，任务已保存，请次日继续。` };
  }
  let tab = current.listTabId ? await chrome.tabs.get(current.listTabId).catch(() => null) : null;
  if (!tab && current.listUrl) tab = await chrome.tabs.create({ url: current.listUrl, active: false });
  if (!tab) throw new Error('没有可继续的后台结果页，请重新开始任务。');
  await saveTask({ status: 'running', listTabId: tab.id, error: '', ...resumedTimingPatch(current) });
  await chrome.action.setBadgeText({ text: '' });
  await log('info', '继续后台采集', `会员登录已校验；${current.listUrl || tab.url || ''}`);
  await chrome.tabs.sendMessage(tab.id, { type: 'RESUME_TASK' }).catch(async () => {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'RESUME_TASK' });
  });
  return { resumed: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REPORT_SYSTEM_ERROR') {
    const details = message.details || {};
    appendSystemError({
      time: details.time || new Date().toISOString(),
      source: details.source || 'unknown',
      context: details.context || '',
      message: details.message || '未知错误',
      stack: details.stack || '',
      url: details.url || sender.tab?.url || ''
    }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === 'START_SILENT') {
    requireActivation()
      .then(() => startSilentSearch(message.keyword, message.settings))
      .then((result) => sendResponse({ ok: result.started !== false, ...result }))
      .catch(async (error) => {
        if (error.code === 'LOGIN_REQUIRED') {
          const current = await taskState();
          const now = new Date().toISOString();
          await saveTask({ status: 'login_required', error: error.message, pausedAt: current.endedAt ? '' : (current.pausedAt || (current.startedAt ? now : '')) });
          await log('warn', '会员登录校验未通过', error.detail || error.message);
          sendResponse({ error: error.message, loginRequired: true });
        } else {
          await recordSystemError(error, '后台启动搜索');
          sendResponse({ error: error.message });
        }
      });
    return true;
  }
  if (message.type === 'BATCH_DETAILS') {
    requireActivation()
      .then(() => runDetailBatch(message.entries || []))
      .then((results) => sendResponse({ results }))
      .catch(async (error) => {
        if (error.code === 'LOGIN_REQUIRED') {
          const current = await taskState();
          await saveTask({ status: 'login_required', error: error.message, pausedAt: current.pausedAt || new Date().toISOString() });
          await log('warn', '会员登录已失效，任务暂停', error.detail || error.message);
          sendResponse({ error: error.message, loginRequired: true });
        } else {
          await recordSystemError(error, '后台详情批量采集');
          sendResponse({ error: error.message });
        }
      });
    return true;
  }
  if (message.type === 'DETAIL_PAGE_READY' && sender.tab?.id) {
    finishDetail(sender.tab.id, message.record, '').catch(() => undefined);
    sendResponse({ ok: true });
    return undefined;
  }
  if (message.type === 'DETAIL_PAGE_FAILED' && sender.tab?.id) {
    finishDetail(sender.tab.id, null, message.error || '详情正文未加载。').catch(() => undefined);
    sendResponse({ ok: true });
    return undefined;
  }
  if (message.type === 'HUMAN_VERIFICATION') {
    (async () => {
      const tabId = sender.tab?.id;
      if (tabId) {
        verificationTabs.add(tabId);
        const pending = activeDetailTabs.get(tabId);
        if (pending) {
          clearTimeout(pending.timer);
          pending.timer = 0;
        }
      }
      const current = await taskState();
      const riskType = message.riskType || 'verification';
      const currentManual = current.verificationMode === 'manual';
      const detectedManual = riskType !== 'frequency';
      const manual = currentManual || detectedManual;
      const cooldownMs = 60000;
      const verificationUntil = manual ? 0 : Date.now() + cooldownMs;
      const verificationTabIds = [...new Set([
        ...(Array.isArray(current.verificationTabIds) ? current.verificationTabIds : []),
        ...verificationTabs
      ])];
      await saveTask({
        status: 'verification_wait', verificationUntil,
        verificationMode: manual ? 'manual' : 'cooldown', verificationRiskType: riskType,
        verificationTabIds, verificationUrl: message.url || sender.tab?.url || '', error: '',
        pausedAt: current.pausedAt || new Date().toISOString()
      });
      await chrome.action.setBadgeBackgroundColor({ color: '#b54708' });
      await chrome.action.setBadgeText({ text: manual ? '验证' : 'WAIT' });
      if (tabId && detectedManual) {
        await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
        if (sender.tab?.windowId) await chrome.windows.update(sender.tab.windowId, { focused: true }).catch(() => undefined);
      } else if (tabId) {
        chrome.alarms.create(`verification-${tabId}`, { delayInMinutes: cooldownMs / 60000 });
      }
      if (current.status !== 'verification_wait') {
        await log('warn', manual ? '检测到滑块验证，任务已暂停' : '检测到访问频控，冷却后重试',
          manual
            ? `请在已打开的验证页手动拖动滑块，完成后自动继续；${message.url || sender.tab?.url || ''}`
            : `等待 ${Math.round(cooldownMs / 1000)} 秒；${message.url || sender.tab?.url || ''}`);
      }
      sendResponse({ verificationUntil, verificationMode: manual ? 'manual' : 'cooldown' });
    })().catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === 'VERIFICATION_COMPLETED' && sender.tab?.id) {
    (async () => {
      const current = await taskState();
      const storedIds = Array.isArray(current.verificationTabIds) ? current.verificationTabIds : [];
      const knownTab = verificationTabs.has(sender.tab.id) || storedIds.includes(sender.tab.id)
        || (current.status === 'verification_wait' && sender.tab.id === current.listTabId);
      if (!knownTab) return sendResponse({ resumed: false });
      const pending = activeDetailTabs.get(sender.tab.id);
      if (pending) armDetailTimeout(sender.tab.id, pending);
      await clearVerification(sender.tab.id);
      const latest = await taskState();
      if (latest.status === 'running') {
        await log('success', '滑块验证已完成，自动继续采集', sender.tab.url || '');
      }
      sendResponse({ resumed: latest.status === 'running' });
    })().catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === 'ADD_LOG') {
    log(message.level || 'info', message.message || '', message.detail || '').catch(() => undefined);
    return undefined;
  }
  if (message.type === 'STOP_TASK') {
    stopTask().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'RESUME_SILENT') {
    requireActivation()
      .then(() => resumeTask())
      .then((result) => sendResponse({ ok: result.resumed !== false, ...result }))
      .catch(async (error) => {
        if (error.code === 'LOGIN_REQUIRED') {
          const current = await taskState();
          await saveTask({ status: 'login_required', error: error.message, pausedAt: current.pausedAt || new Date().toISOString() });
          await log('warn', '会员登录校验未通过，无法继续', error.detail || error.message);
          sendResponse({ error: error.message, loginRequired: true });
        } else {
          await recordSystemError(error, '后台恢复任务');
          sendResponse({ error: error.message });
        }
      });
    return true;
  }
  if (message.type === 'TASK_COMPLETE') {
    (async () => {
      const current = await taskState();
      const timing = taskTiming(current);
      await log('warn', '采集完成，请尽快导出 Excel', `运行 ${formatDuration(timing.activeMs)}；暂停 ${formatDuration(timing.pausedMs)}；避免浏览器清理或任务重置后结果失效无法下载`);
      await chrome.action.setBadgeText({ text: '' });
      if (sender.tab?.id) await chrome.tabs.remove(sender.tab.id).catch(() => undefined);
    })().catch(() => undefined);
    return undefined;
  }
  if (message.type === 'RESET_FACTORY') {
    (async () => {
      await stopTask();
      await sleep(50);
      await chrome.storage.local.remove([
        'task', 'taskLogs', 'collectorSettings', 'systemErrors',
        'officialAdvancedFilterOptions', 'keywordOptions', ACTIVATION_STORAGE_KEY
      ]);
      await chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  return undefined;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const tabId = Number(alarm.name.match(/^verification-(\d+)$/)?.[1]);
  if (!tabId) return;
  const pending = activeDetailTabs.get(tabId);
  const current = await taskState();
  if (current.status !== 'verification_wait') return;
  const targetUrl = pending?.url || current.listUrl;
  await log('info', '访问频控冷却结束，重新打开原页面', targetUrl || String(tabId));
  await clearVerification(tabId);
  if (!targetUrl) return;
  if (pending) armDetailTimeout(tabId, pending);
  await chrome.tabs.update(tabId, { url: targetUrl, active: false }).catch((error) => {
    finishDetail(tabId, null, `验证后重新打开详情失败：${error.message}`).catch(() => undefined);
  });
});
