const DETAIL_TIMEOUT = 45000;
const BIDCENTER_HOME_URL = 'https://www.bidcenter.com.cn/';
const DETAIL_STAGGER_MIN_MS = 100;
const DETAIL_STAGGER_MAX_MS = 3000;
const DETAIL_INTERVAL_JITTER_MIN_MS = -2000;
const DETAIL_INTERVAL_JITTER_MAX_MS = 2000;
const DEFAULT_SETTINGS = {
  intervalMs: 15000,
  concurrency: 3,
  pageSize: 40
};
const ALL_INFORMATION_TYPES = [
  '招标公告', '招标变更', '中标结果', '采购信息', '招标预告', '审批公示',
  '拍卖转让', '土地挂牌', '司法拍卖', '其它公告'
];
const DEFAULT_INFORMATION_TYPES = ['招标公告', '中标结果'];
const ADVANCED_FILTER_KEYS = ['purchaseMethod', 'fundingSource', 'evaluationMethod', 'qualificationCertificate'];
const PLATFORM_DAILY_LIMIT = 1300;
const PLUGIN_DAILY_LIMIT = 1280;
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
let adaptiveSuccessStreak = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDetailStaggerMs = () => Math.floor(
  Math.random() * (DETAIL_STAGGER_MAX_MS - DETAIL_STAGGER_MIN_MS + 1)
) + DETAIL_STAGGER_MIN_MS;
const randomDetailIntervalJitterMs = () => Math.floor(
  Math.random() * (DETAIL_INTERVAL_JITTER_MAX_MS - DETAIL_INTERVAL_JITTER_MIN_MS + 1)
) + DETAIL_INTERVAL_JITTER_MIN_MS;
const effectiveDetailIntervalMs = (baseIntervalMs, jitterMs) => Math.max(200, baseIntervalMs + jitterMs);

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
  const textOf = (element) => (element?.innerText || element?.textContent || '').trim();
  const hasAccountLink = (element) => [...element.querySelectorAll('a')].some((link) => {
    const text = textOf(link);
    return /^(?:用户中心|订阅信息|个人信息|退出|退出登录|安全退出)$/.test(text)
      || /^user\.bidcenter\.com\.cn$/i.test(link.hostname);
  });

  const currentAccountPanel = [...document.querySelectorAll('#ydlHover, .ydl-txt, .ydl-zhong')]
    .find((element) => visible(element) && hasAccountLink(element));
  const visibleMemberLevel = [...document.querySelectorAll('.ydl-hyxx, .ydl-yhxx, .index-register_lan')]
    .find((element) => visible(element) && /会员级别\s*[：:]/.test(textOf(element)));
  if (currentAccountPanel || visibleMemberLevel) {
    return { loggedIn: true, definitive: true, reason: '页面显示当前账号、会员级别或用户中心入口', url: currentUrl };
  }

  const loggedInPanel = [...document.querySelectorAll('.ssjg-header_login.islogin')].find(visible);
  if (loggedInPanel && hasAccountLink(loggedInPanel)) {
    return { loggedIn: true, definitive: true, reason: '页面显示已登录账号和退出入口', url: currentUrl };
  }
  const loggedOutPanel = [...document.querySelectorAll('.ssjg-header_login.nologin')].find(visible);
  const currentLoggedOutPanel = [...document.querySelectorAll('.wdl-zhong')].find((element) => (
    visible(element) && [...element.querySelectorAll('a')]
      .some((link) => visible(link) && /^(?:登录|注册)$/.test(textOf(link)))
  ));
  const visiblePassword = [...document.querySelectorAll('input[type="password"]')].some(visible);
  if (loggedOutPanel || currentLoggedOutPanel || visiblePassword) {
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

async function focusBidcenterHomepage() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const homeTab = tabs.find((tab) => {
    try {
      const url = new URL(tab.url || tab.pendingUrl || '');
      return url.hostname === 'www.bidcenter.com.cn' && url.pathname === '/';
    } catch (_) { return false; }
  });
  if (homeTab?.id) {
    await chrome.tabs.update(homeTab.id, { active: true });
    return homeTab;
  }
  return chrome.tabs.create({ url: BIDCENTER_HOME_URL, active: true });
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
// 常驻心跳（30 秒）：SW 冷启动时重建，防止空闲/长等待期间被 Chrome 回收导致任务冻结
chrome.alarms.create('collector-keepalive', { periodInMinutes: 0.5 });

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
  adaptiveSuccessStreak = 0;
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
    adaptive: { intervalMs: settings.intervalMs, concurrency: settings.concurrency, verificationCount: 0, successStreak: 0 },
    informationTypes, typeFilterIndex: 0,
    currentType: informationTypes[0], completedTypes: [],
    typeFilterApplied: false, typeFilterPending: '', filterStage: '',
    timeFilterMode: settings.timeFilterMode, timeRangeStart: timeRange.start, timeRangeEnd: timeRange.end,
    timeFilterApplied: false, listUrl: url, awaitingSignature: '', error: '',
    networkRetryUrl: '', networkRetryCount: 0,
    verificationUntil: 0, verificationMode: '', verificationRiskType: '', verificationTabIds: [], verificationUrl: '',
    verificationResumeStatus: '',
    advancedFilters: settings.advancedFilters, excludeWords: settings.excludeWords,
    relatedWords: settings.relatedWords, advancedFiltersApplied: false,
    startedAt: new Date().toISOString(), pausedAt: '', totalPausedMs: 0, endedAt: '',
    updatedAt: new Date().toISOString()
  } });
  await chrome.storage.local.set({ taskLogs: [] });
  await chrome.action.setBadgeText({ text: '' });
  await log('info', '开始后台搜索', `${keyword}；会员登录已校验；${timeLabel} ${timeRange.start} 至 ${timeRange.end}；高级筛选 ${advancedSummary}；排除词 ${settings.excludeWords.length}/5；相关词 ${settings.relatedWords.length}/5；依次筛选 ${informationTypes.join(' → ')}；间隔 ${settings.intervalMs}ms；并发 ${settings.concurrency}`);
  let tab;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { tab = await chrome.tabs.create({ url, active: false }); break; } catch (e) {
      if (e.message?.includes('Tabs cannot be edited') && attempt < 4) await sleep(500);
      else throw e;
    }
  }
  await saveTask({ listTabId: tab.id });
  await log('info', '已创建后台结果页', url);
  try {
    const homeTab = await focusBidcenterHomepage();
    await log('info', '前台已切换到采招网首页', homeTab.url || BIDCENTER_HOME_URL);
  } catch (error) {
    await log('warn', '无法自动切换到采招网首页', error.message || String(error));
  }
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

// —— 自适应降速：触发验证自动拉长间隔/降并发，稳定后逐步回调 ——
// 分段长等待：MV3 Service Worker 30 秒无事件会被回收，60 秒间隔的纯 sleep 会冻结任务。
// 每 15 秒醒来查一次状态（chrome.storage API 调用兼作保活），暂停/停止/换代即时响应。
async function sleepChunked(totalMs, expectedGeneration) {
  const endAt = Date.now() + totalMs;
  while (Date.now() < endAt) {
    await sleep(Math.min(15000, Math.max(1, endAt - Date.now())));
    const state = await taskState();
    if (expectedGeneration !== batchGeneration) return;
    if (state && !['searching', 'filtering', 'running', 'verification_wait'].includes(state.status)) return;
  }
}

function effectiveSettings(state = {}) {
  const base = normalizeSettings(state.settings || {});
  const adaptive = state.adaptive;
  if (!adaptive) return base;
  return {
    ...base,
    intervalMs: Math.min(60000, Math.max(base.intervalMs, Number(adaptive.intervalMs) || base.intervalMs)),
    concurrency: Math.min(base.concurrency, Math.max(1, Number(adaptive.concurrency) || base.concurrency))
  };
}

async function escalateAdaptiveSettings() {
  const current = await taskState();
  if (!['searching', 'filtering', 'running', 'verification_wait'].includes(current.status)) return null;
  const base = normalizeSettings(current.settings || {});
  const prev = current.adaptive
    || { intervalMs: base.intervalMs, concurrency: base.concurrency, verificationCount: 0, successStreak: 0 };
  const prevInterval = Math.max(Number(prev.intervalMs) || base.intervalMs, base.intervalMs);
  const prevConcurrency = Number(prev.concurrency) || base.concurrency;
  const verificationCount = (Number(prev.verificationCount) || 0) + 1;
  const growFactor = 1.8 + 0.2 * Math.min(4, verificationCount);
  const intervalFloor = Math.max(15000, Math.round(base.intervalMs * 1.8));
  const intervalMs = Math.min(60000, Math.max(intervalFloor, Math.round(prevInterval * growFactor)));
  const concurrency = 1;
  adaptiveSuccessStreak = 0;
  await saveTask({ adaptive: { intervalMs, concurrency, verificationCount, successStreak: 0 } });
  const stats = await recordVerificationEvent(prevInterval, prevConcurrency);
  await log('warn', '触发验证，自适应降速（实测数据点）',
    `第 ${verificationCount} 次：详情间隔 ${prevInterval}→${intervalMs}ms${concurrency !== prevConcurrency ? `；并发 ${prevConcurrency}→${concurrency}` : ''}；触发前节奏=近10分钟 ${stats.opens10m} 次/近1小时 ${stats.opens60m} 次；距上次验证 ${stats.minSinceVerify ?? '无记录'} 分钟`);
  return { intervalMs, concurrency };
}

async function maybeRecoverAdaptive(expectedGeneration) {
  adaptiveSuccessStreak += 1;
  if (adaptiveSuccessStreak % 60 !== 0 || expectedGeneration !== batchGeneration) return;
  const current = await taskState();
  const base = normalizeSettings(current.settings || {});
  const adaptive = current.adaptive;
  if (!adaptive || Number(adaptive.intervalMs) <= base.intervalMs) return;
  const intervalMs = Math.max(base.intervalMs, Math.round(adaptive.intervalMs / 1.3));
  const concurrency = Math.min(base.concurrency, (Number(adaptive.concurrency) || 1) + 1);
  await saveTask({ adaptive: { ...adaptive, intervalMs, concurrency, successStreak: 0 } });
  await log('info', '采集持续稳定，自动回调速度',
    `详情间隔 ${adaptive.intervalMs}→${intervalMs}ms；并发 ${adaptive.concurrency}→${concurrency}；再次触发验证会重新降速`);
}

// —— 被动速度校准：记录真实运行中的请求节奏与验证事件，实证判断安全速度带（不主动触发验证） ——
async function calibrationLogEntries() {
  const { calibrationLog = [] } = await chrome.storage.local.get('calibrationLog');
  return calibrationLog;
}

function calibrationStats(log = []) {
  const now = Date.now();
  const opens = log.filter((entry) => entry.kind === 'open').map((entry) => Number(entry.time) || 0);
  const verifies = log.filter((entry) => entry.kind === 'verify').map((entry) => Number(entry.time) || 0);
  const lastVerify = verifies.length ? Math.max(...verifies) : 0;
  return {
    opens10m: opens.filter((t) => now - t < 600000).length,
    opens60m: opens.filter((t) => now - t < 3600000).length,
    minSinceVerify: lastVerify ? Math.round((now - lastVerify) / 60000) : null,
    verifies24h: verifies.filter((t) => now - t < 86400000).length
  };
}

async function recordDetailOpen() {
  const log = await calibrationLogEntries();
  log.push({ time: Date.now(), kind: 'open' });
  await chrome.storage.local.set({ calibrationLog: log.slice(-500) });
}

async function recordVerificationEvent(intervalMs, concurrency) {
  const log = await calibrationLogEntries();
  const stats = calibrationStats(log);
  log.push({ time: Date.now(), kind: 'verify', intervalMs, concurrency, ...stats });
  await chrome.storage.local.set({ calibrationLog: log.slice(-500) });
  return stats;
}

function verificationRecoveryCooldownMs(state = {}) {
  // 实测：滑块解完后仅 60 秒即重开列表页，3 秒内再次触发滑块（风险分未衰减）。
  // 恢复冷却按 3 分钟起步，每多一次验证 +1 分钟，5 分钟封顶。
  const count = Math.max(1, Number(state.adaptive?.verificationCount) || 1);
  return Math.min(300000, 180000 + (count - 1) * 60000);
}

function originalVerificationTarget(state = {}, pendingUrl = '') {
  const candidate = pendingUrl || state.verificationUrl || state.listUrl || '';
  return /(?:\/alivalidate|captcha|verify)/i.test(candidate) ? (state.listUrl || '') : candidate;
}

async function detailTabHasNetworkError(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return false;
  if (tab.status === 'loading' || /^chrome-error:/i.test(tab.url || '')) return true;
  try {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        title: document.title || '',
        body: (document.body?.innerText || '').slice(0, 1200)
      })
    });
    return /ERR_[A-Z_]+|无法访问此网站|网页无法打开|网络错误|网络请求失败|网络连接.*(?:中断|失败)|连接已重置|连接超时/i
      .test(`${execution?.result?.title || ''} ${execution?.result?.body || ''}`);
  } catch (error) {
    return /chrome-error|Cannot access contents|无法访问页面内容/i.test(error.message || '');
  }
}

function armDetailTimeout(tabId, pending) {
  clearTimeout(pending.timer);
  pending.timer = setTimeout(async () => {
    if (activeDetailTabs.get(tabId) !== pending) return;
    const networkError = (pending.networkReloads || 0) < 1 && await detailTabHasNetworkError(tabId);
    if (activeDetailTabs.get(tabId) !== pending) return;
    if (networkError) {
      pending.networkReloads = 1;
      await log('warn', '详情页网络异常，自动刷新一次', pending.title || pending.url);
      try {
        await chrome.tabs.reload(tabId);
        armDetailTimeout(tabId, pending);
        return;
      } catch (error) {
        await log('warn', '详情页自动刷新失败', error.message || String(error));
      }
    }
    activeDetailTabs.delete(tabId);
    await clearVerification(tabId);
    chrome.tabs.remove(tabId).catch(() => undefined);
    pending.reject(new Error('详情页在 45 秒内未完成采集。'));
  }, DETAIL_TIMEOUT);
}

function waitForDetail(tabId, url, title) {
  return new Promise((resolve, reject) => {
    const pending = { resolve, reject, timer: 0, url, title, networkReloads: 0 };
    activeDetailTabs.set(tabId, pending);
    armDetailTimeout(tabId, pending);
  });
}

async function openSilentDetail(url, title, expectedGeneration) {
  const { task = {} } = await chrome.storage.local.get('task');
  if (expectedGeneration !== batchGeneration || !['searching', 'filtering', 'running'].includes(task.status)) return null;
  const listTab = task.listTabId ? await chrome.tabs.get(task.listTabId).catch(() => null) : null;
  const latest = await taskState();
  if (expectedGeneration !== batchGeneration || !['searching', 'filtering', 'running'].includes(latest.status)) return null;
  const createProperties = { url, active: false };
  if (listTab && /(^|\.)bidcenter\.com\.cn$/i.test(new URL(listTab.url || '').hostname)) {
    createProperties.openerTabId = listTab.id;
  }
  log('info', '后台打开详情页', `${title || url}；活动详情 ${activeDetailTabs.size} 个；使用浏览器已登录会话${createProperties.openerTabId ? '，关联结果页' : ''}`);
  const tab = await chrome.tabs.create(createProperties);
  recordDetailOpen().catch(() => undefined);
  return { openedAt: Date.now(), result: waitForDetail(tab.id, url, title) };
}

async function clearVerification(tabId, { preserveCooldown = false } = {}) {
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
    if (preserveCooldown && current.verificationMode === 'cooldown') {
      await saveTask({ verificationTabIds: [] });
      return;
    }
    const resumeStatus = ['paused', 'daily_limit'].includes(current.verificationResumeStatus)
      ? current.verificationResumeStatus : 'running';
    const timingPatch = resumeStatus === 'running' ? resumedTimingPatch(current) : {};
    await saveTask({
      status: resumeStatus, verificationUntil: 0, verificationMode: '', verificationRiskType: '',
      verificationTabIds: [], verificationUrl: '', verificationResumeStatus: '', error: '', ...timingPatch
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
  await clearVerification(tabId, { preserveCooldown: true });
  if (error) {
    await log('error', '详情采集失败', `${pending.title || pending.url}：${error}`);
    pending.reject(new Error(error));
    return;
  }
  log('success', '详情采集成功', `${record.信息id || '-'} ${record.信息标题 || pending.title}`);
  pending.resolve(record);
}

function updateBatchProgress(failed, expectedGeneration) {
  progressQueue = progressQueue.then(async () => {
    if (expectedGeneration !== batchGeneration) return;
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
  const settings = effectiveSettings(batchTask);
  await saveTask({ batchTotal: entries.length, batchDone: 0, batchFailed: 0 });
  await log('info', `开始整页批量采集 ${entries.length} 条`, `并发数 ${Math.min(settings.concurrency, entries.length)}，基础间隔 ${settings.intervalMs}ms（每条随机 ±2 秒），每次启动随机错峰 0.1-3 秒`);
  const results = new Array(entries.length);
  let nextIndex = 0;
  const workerLastOpenAt = new Map();
  let staggerQueue = Promise.resolve();

  async function openStaggeredDetail(entry, workerId, intervalTiming) {
    const previousLaunch = staggerQueue;
    let releaseLaunch;
    staggerQueue = new Promise((resolve) => { releaseLaunch = resolve; });
    await previousLaunch;
    try {
      let state = await taskState();
      while (state.status === 'verification_wait' && generation === batchGeneration) {
        await sleep(1000);
        state = await taskState();
      }
      if (generation !== batchGeneration || !['searching', 'filtering', 'running'].includes(state.status)) return null;
      const staggerMs = randomDetailStaggerMs();
      await sleep(staggerMs);
      state = await taskState();
      while (state.status === 'verification_wait' && generation === batchGeneration) {
        await sleep(1000);
        state = await taskState();
      }
      if (generation !== batchGeneration || !['searching', 'filtering', 'running'].includes(state.status)) return null;
      const liveSettings = effectiveSettings(state);
      const quota = await reserveDailyQuotaSlot();
      if (!quota.reserved) {
        await markDailyLimitReached(quota.usage);
        return null;
      }
      const jitterLabel = intervalTiming.jitterMs >= 0 ? `+${intervalTiming.jitterMs}` : String(intervalTiming.jitterMs);
      const intervalLabel = intervalTiming.hasPrevious
        ? `基础间隔 ${intervalTiming.baseMs}ms，随机偏移 ${jitterLabel}ms，实际 ${intervalTiming.actualMs}ms；`
        : '本通道首条无需前序间隔；';
      await log('info', `并发通道 ${workerId} 错峰启动详情`, `${intervalLabel}启动错峰 ${staggerMs}ms；活动详情 ${activeDetailTabs.size + 1}/${Math.min(liveSettings.concurrency, entries.length)}`);
      const opened = await openSilentDetail(entry.url, entry.title, generation);
      return opened;
    } finally {
      releaseLaunch();
    }
  }

  async function worker() {
    const workerId = [...workerLastOpenAt.keys()].length + 1;
    workerLastOpenAt.set(workerId, 0);
    while (nextIndex < entries.length && generation === batchGeneration) {
      let state = await taskState();
      while (workerId > effectiveSettings(state).concurrency && generation === batchGeneration) {
        if (!['searching', 'filtering', 'running', 'verification_wait'].includes(state.status)) return;
        await sleep(1000);
        state = await taskState();
      }
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
        const intervalJitterMs = randomDetailIntervalJitterMs();
        let intervalMs = effectiveSettings(state).intervalMs;
        let actualIntervalMs = effectiveDetailIntervalMs(intervalMs, intervalJitterMs);
        const now = Date.now();
        const lastOpenAt = workerLastOpenAt.get(workerId) || 0;
        const scheduledAt = Math.max(now, lastOpenAt + actualIntervalMs);
        if (scheduledAt > now) await sleepChunked(scheduledAt - now, generation);
        state = await taskState();
        if (generation !== batchGeneration || !['searching', 'filtering', 'running'].includes(state.status)) return;
        intervalMs = effectiveSettings(state).intervalMs;
        actualIntervalMs = effectiveDetailIntervalMs(intervalMs, intervalJitterMs);
        const resumedScheduledAt = lastOpenAt + actualIntervalMs;
        if (resumedScheduledAt > Date.now()) {
          await sleepChunked(resumedScheduledAt - Date.now(), generation);
          state = await taskState();
          if (generation !== batchGeneration || !['searching', 'filtering', 'running'].includes(state.status)) return;
        }
        const opened = await openStaggeredDetail(entry, workerId, {
          baseMs: intervalMs,
          jitterMs: intervalJitterMs,
          actualMs: actualIntervalMs,
          hasPrevious: Boolean(lastOpenAt)
        });
        if (!opened) return;
        workerLastOpenAt.set(workerId, opened.openedAt);
        const record = await opened.result;
        if (generation !== batchGeneration) return;
        await updateBatchProgress(false, generation);
        await maybeRecoverAdaptive(generation);
        results[index] = { url: entry.url, summary: entry.summary, record };
        await persistPartialResult(results[index], generation);
      } catch (error) {
        if (generation !== batchGeneration) return;
        await updateBatchProgress(true, generation);
        results[index] = { url: entry.url, summary: entry.summary, error: error.message || '详情采集失败。' };
        await persistPartialResult(results[index], generation);
      }
    }
  }
  // 可扩张通道池：批次中途调大并发时，监督循环每秒比对有效并发并即时补充新通道；
  // 调小并发由 worker 内部的收缩等待处理（多余通道闲置但不退出）。
  const activeWorkers = new Set();
  const spawnWorker = () => {
    const tracked = worker().finally(() => { activeWorkers.delete(tracked); });
    tracked.catch(() => undefined);
    activeWorkers.add(tracked);
  };
  for (let i = 0; i < Math.min(settings.concurrency, entries.length); i += 1) spawnWorker();
  while (generation === batchGeneration) {
    const state = await taskState();
    if (!['searching', 'filtering', 'running', 'verification_wait'].includes(state.status)) break;
    const desired = Math.min(effectiveSettings(state).concurrency, entries.length);
    if (nextIndex < entries.length && activeWorkers.size < desired) {
      const from = activeWorkers.size;
      while (activeWorkers.size < desired && nextIndex < entries.length) spawnWorker();
      await log('info', '并发已调大，补充采集通道', `${from} → ${activeWorkers.size}`);
    }
    if (!activeWorkers.size) break;
    await sleep(1000);
  }
  await Promise.allSettled([...activeWorkers]);
  const completedResults = results.filter(Boolean);
  if (generation !== batchGeneration) return completedResults;
  const failed = completedResults.filter((result) => result.error).length;
  const finalState = await taskState();
  await log(failed || finalState.status === 'daily_limit' ? 'warn' : 'success',
    finalState.status === 'daily_limit' ? '批量采集已在保护线处暂停' : '整页批量采集结束',
    `完成 ${completedResults.length}/${entries.length} 条，成功 ${completedResults.length - failed} 条，失败 ${failed} 条`);
  return completedResults;
}

async function persistPartialResult(result, expectedGeneration) {
  partialQueue = partialQueue.then(async () => {
    if (expectedGeneration !== batchGeneration) return;
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
    verificationRiskType: '', verificationTabIds: [], verificationUrl: '', verificationResumeStatus: '',
    ...timingPatch, endedAt
  });
  const timing = taskTiming(finalState);
  await chrome.action.setBadgeText({ text: '' });
  await log('warn', '用户停止任务，请尽快导出 Excel', `运行 ${formatDuration(timing.activeMs)}；暂停 ${formatDuration(timing.pausedMs)}；避免浏览器清理或任务重置后结果失效无法下载`);
}

async function resumeTask(requestedIntervalMs, requestedConcurrency) {
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
  const taskSettings = { ...(current.settings || {}) };
  taskSettings.intervalMs = Math.min(60000, Math.max(200,
    Number(requestedIntervalMs) || Number(current.settings?.intervalMs) || DEFAULT_SETTINGS.intervalMs));
  taskSettings.concurrency = Math.min(6, Math.max(1,
    Number(requestedConcurrency) || Number(current.settings?.concurrency) || DEFAULT_SETTINGS.concurrency));
  // 用户在侧栏调整后点「继续」= 接管速度：以新值重置自适应钳制（验证计数保留，冷却递增保护不变）
  const prevAdaptive = current.adaptive || {};
  const tookOver = Number(requestedIntervalMs) || Number(requestedConcurrency);
  const adaptive = {
    intervalMs: taskSettings.intervalMs,
    concurrency: taskSettings.concurrency,
    verificationCount: Number(prevAdaptive.verificationCount) || 0,
    successStreak: 0
  };
  await saveTask({ status: 'running', listTabId: tab.id, settings: taskSettings, adaptive, error: '', ...resumedTimingPatch(current) });
  await chrome.action.setBadgeText({ text: '' });
  await log('info', '继续后台采集',
    `会员登录已校验；详情间隔 ${taskSettings.intervalMs}ms；并发 ${taskSettings.concurrency}${tookOver && (Number(prevAdaptive.intervalMs) > taskSettings.intervalMs || Number(prevAdaptive.concurrency) < taskSettings.concurrency) ? '；已按用户设置覆盖自适应降速（再触发验证会重新降速）' : ''}；${current.listUrl || tab.url || ''}`);
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
  if (message.type === 'DETAIL_PAGE_RETRYING' && sender.tab?.id) {
    const pending = activeDetailTabs.get(sender.tab.id);
    if (pending) {
      pending.networkReloads = 1;
      armDetailTimeout(sender.tab.id, pending);
      log('warn', '详情页网络异常，自动刷新一次', `${pending.title || pending.url}；${message.error || ''}`).catch(() => undefined);
    }
    sendResponse({ ok: Boolean(pending) });
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
      const cooldownMs = Math.min(300000, 60000 * Math.min(5, (Number(current.adaptive?.verificationCount) || 0) + 1));
      const verificationUntil = manual ? 0 : Date.now() + cooldownMs;
      const verificationTabIds = [...new Set([
        ...(Array.isArray(current.verificationTabIds) ? current.verificationTabIds : []),
        ...verificationTabs
      ])];
      const verificationResumeStatus = current.status === 'verification_wait'
        ? current.verificationResumeStatus
        : ['paused', 'daily_limit'].includes(current.status) ? current.status : 'running';
      await saveTask({
        status: 'verification_wait', verificationUntil,
        verificationMode: manual ? 'manual' : 'cooldown', verificationRiskType: riskType,
        verificationTabIds, verificationUrl: message.url || sender.tab?.url || '', error: '',
        verificationResumeStatus,
        pausedAt: current.pausedAt || new Date().toISOString()
      });
      await chrome.action.setBadgeBackgroundColor({ color: '#b54708' });
      await chrome.action.setBadgeText({ text: manual ? '验证' : 'WAIT' });
      await escalateAdaptiveSettings().catch(() => undefined);
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
      if (current.verificationMode === 'cooldown') {
        return sendResponse({ resumed: false, cooldownMs: Math.max(0, (current.verificationUntil || 0) - Date.now()) });
      }
      const pending = activeDetailTabs.get(sender.tab.id);
      const resumeUrl = originalVerificationTarget(current, pending?.url);
      await clearVerification(sender.tab.id);
      const latest = await taskState();
      if (latest.status !== 'running') return sendResponse({ resumed: false });
      const cooldownMs = verificationRecoveryCooldownMs(latest);
      await saveTask({
        status: 'verification_wait', verificationUntil: Date.now() + cooldownMs,
        verificationMode: 'cooldown', verificationRiskType: 'post_verification',
        verificationTabIds: [], verificationUrl: resumeUrl,
        verificationResumeStatus: 'running', error: ''
      });
      await chrome.action.setBadgeText({ text: 'WAIT' });
      await chrome.alarms.create(`verification-${sender.tab.id}`, { delayInMinutes: cooldownMs / 60000 });
      await log('success', '滑块验证已完成，进入恢复冷却',
        `等待 ${Math.round(cooldownMs / 1000)} 秒后继续；${resumeUrl}`);
      sendResponse({ resumed: false, cooldownMs });
    })().catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === 'UPDATE_RUN_SETTINGS') {
    (async () => {
      const current = await taskState();
      if (!['searching', 'filtering', 'running', 'paused', 'verification_wait'].includes(current.status)) {
        sendResponse({ ok: false, message: '当前没有运行中的任务，设置已保存，下次开始时使用。' });
        return;
      }
      const intervalMs = Math.min(60000, Math.max(200, Number(message.intervalMs) || DEFAULT_SETTINGS.intervalMs));
      const concurrency = Math.min(6, Math.max(1, Number(message.concurrency) || DEFAULT_SETTINGS.concurrency));
      const taskSettings = { ...(current.settings || {}), intervalMs, concurrency };
      const prevAdaptive = current.adaptive || {};
      // 用户实时调整 = 接管速度：以新值重置自适应钳制（验证计数保留，冷却递增保护不变）
      const adaptive = {
        intervalMs, concurrency,
        verificationCount: Number(prevAdaptive.verificationCount) || 0,
        successStreak: 0
      };
      await saveTask({ settings: taskSettings, adaptive });
      const covered = Number(prevAdaptive.intervalMs) > intervalMs || Number(prevAdaptive.concurrency) < concurrency;
      await log('info', '设置已实时更新',
        `详情间隔 ${intervalMs}ms（下一条详情生效）；并发 ${concurrency}（调大调小均即时生效）${covered ? '；已覆盖自适应降速，再触发验证会重新降速' : ''}`);
      sendResponse({ ok: true });
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
  if (message.type === 'CLEAR_TASK') {
    (async () => {
      await stopTask();
      await Promise.allSettled([progressQueue, partialQueue]);
      await chrome.storage.local.remove(['task', 'taskLogs']);
      await chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === 'RESUME_SILENT') {
    requireActivation()
      .then(() => resumeTask(message.intervalMs, message.concurrency))
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
  if (message.type === 'RESET_SETTINGS') {
    (async () => {
      await stopTask();
      await Promise.allSettled([progressQueue, partialQueue]);
      await chrome.storage.local.remove([
        'task', 'taskLogs', 'collectorSettings', 'systemErrors', 'calibrationLog',
        'officialAdvancedFilterOptions', 'keywordOptions', 'intervalDefault5000Migrated', ACTIVATION_STORAGE_KEY
      ]);
      await chrome.action.setBadgeText({ text: '' });
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  return undefined;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'collector-keepalive') {
    // 常驻心跳：任何长等待/空闲期间写一次 storage，防止 Service Worker 被回收
    await chrome.storage.local.set({ keepAliveAt: Date.now() }).catch(() => undefined);
    return;
  }
  const tabId = Number(alarm.name.match(/^verification-(\d+)$/)?.[1]);
  if (!tabId) return;
  const pending = activeDetailTabs.get(tabId);
  const current = await taskState();
  if (current.status !== 'verification_wait') return;
  const targetUrl = originalVerificationTarget(current, pending?.url);
  const cooldownLabel = current.verificationRiskType === 'post_verification' ? '验证恢复冷却结束' : '访问频控冷却结束';
  await log('info', `${cooldownLabel}，重新打开原页面`, targetUrl || String(tabId));
  await clearVerification(tabId);
  if (!targetUrl) return;
  if (pending) armDetailTimeout(tabId, pending);
  await chrome.tabs.update(tabId, { url: targetUrl, active: false }).catch((error) => {
    finishDetail(tabId, null, `验证后重新打开详情失败：${error.message}`).catch(() => undefined);
  });
});
