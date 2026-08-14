import { downloadWorkbook } from './xlsx-export.js';

const $ = (selector) => document.querySelector(selector);
const controls = ['start', 'pause', 'resume', 'export', 'stop', 'clear'].map((id) => $(`#${id}`));
const ACTIVATION_CODE = '18682408521';
const ACTIVATION_STORAGE_KEY = 'collectorActivation';
const DEFAULT_KEYWORDS = ['智慧交通', '交通基础设施', '自然保护地'];
const ALL_INFORMATION_TYPES = [
  '招标公告', '招标变更', '中标结果', '采购信息', '招标预告', '审批公示',
  '拍卖转让', '土地挂牌', '司法拍卖', '其它公告'
];
const DEFAULT_INFORMATION_TYPES = ['招标公告', '中标结果'];
const ADVANCED_FILTER_FIELDS = [
  { key: 'purchaseMethod', label: '采购方式', id: 'filter-purchase-method' },
  { key: 'fundingSource', label: '资金来源', id: 'filter-funding-source' },
  { key: 'evaluationMethod', label: '评标办法', id: 'filter-evaluation-method' },
  { key: 'qualificationCertificate', label: '资质证书', id: 'filter-qualification-certificate' }
];
const OFFICIAL_ADVANCED_FILTER_FALLBACKS = {
  purchaseMethod: ['全部', '公开招标', '邀请招标', '竞争性', '询价', '单一来源', '比选', '电子反拍'],
  fundingSource: ['全部', '自筹资金', '政府投资'],
  evaluationMethod: ['全部', '综合', '低价', '抽签', '综合-简易评定'],
  qualificationCertificate: [
    '全部', '国军标认证', '质量管理体系', '环境管理体系', '职业健康安全管理体系', '测量管理体系',
    '能源管理体系', '整合管理体系', '合规管理体系', '诚信管理体系', '业务连续性管理体系'
  ]
};
const PLATFORM_DAILY_LIMIT = 800;
const PLUGIN_DAILY_LIMIT = 780;
const INITIAL_TIME_RANGE = previousCalendarMonthRange();
let latestState = {};
let latestLogs = [];
let latestSystemErrors = [];
let latestQuota = { date: '', used: 0, limit: PLUGIN_DAILY_LIMIT, platformLimit: PLATFORM_DAILY_LIMIT };
let latestOfficialFilterOptions = OFFICIAL_ADVANCED_FILTER_FALLBACKS;
let keywordOptions = [...DEFAULT_KEYWORDS];
let draftWords = { exclude: [], related: [] };
let settings = {
  intervalMs: 3000, concurrency: 3,
  informationTypes: [...DEFAULT_INFORMATION_TYPES],
  timeFilterMode: 'previous_calendar_month',
  timeRangeStart: INITIAL_TIME_RANGE.start, timeRangeEnd: INITIAL_TIME_RANGE.end,
  advancedFilters: Object.fromEntries(ADVANCED_FILTER_FIELDS.map(({ key }) => [key, '全部'])),
  excludeWords: [], relatedWords: []
};
let settingsDirty = false;
let keywordDirty = false;
let logsFollowTail = true;
let activationReady = false;
let statePollingTimer = 0;

function showActivationView(isActivated) {
  activationReady = isActivated;
  $('#activation-screen').hidden = isActivated;
  $('#app-shell').hidden = !isActivated;
  if (!isActivated) {
    if (statePollingTimer) clearInterval(statePollingTimer);
    statePollingTimer = 0;
    $('#activation-input').value = '';
    $('#activation-input').removeAttribute('aria-invalid');
    $('#activate-button').disabled = false;
    $('#activate-button').textContent = '立即激活';
    $('#activation-feedback').className = 'activation-feedback';
    $('#activation-feedback').textContent = '';
    setTimeout(() => $('#activation-input').focus(), 0);
  }
}

function startStatePolling() {
  if (!activationReady || statePollingTimer) return;
  getState().catch(reportReadError);
  statePollingTimer = setInterval(() => getState().catch(reportReadError), 1000);
}

async function initializeSidepanel() {
  const version = chrome.runtime.getManifest().version;
  document.querySelectorAll('[data-app-version]').forEach((element) => {
    element.textContent = `v${version}`;
  });
  renderKeywordOptions();
  const stored = await chrome.storage.local.get(ACTIVATION_STORAGE_KEY);
  const isActivated = stored[ACTIVATION_STORAGE_KEY]?.activated === true;
  showActivationView(isActivated);
  if (isActivated) startStatePolling();
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function formatTime(value) {
  if (!value) return '--:--:--';
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
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
  const pausedAt = pauseStartedAt(state);
  const pausedMs = Math.max(0, Number(state.totalPausedMs) || 0)
    + (pausedAt ? Math.max(0, endedAt - pausedAt) : 0);
  return { activeMs: Math.max(0, endedAt - startedAt - pausedMs), pausedMs };
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return [hours, minutes, seconds % 60].map((value) => String(value).padStart(2, '0')).join(':');
}

function timingCaption(state) {
  if (!state.startedAt) return '尚未计时';
  const timing = taskTiming(state);
  const prefix = ['complete', 'stopped'].includes(state.status) ? '结束' : pauseStartedAt(state) ? '已暂停' : '运行中';
  return `${prefix} ${formatDuration(timing.activeMs)} · 暂停 ${formatDuration(timing.pausedMs)}`;
}

function completedRecordCount(state = {}) {
  const completed = new Set();
  [...(state.records || []), ...(state.partialRecords || [])].forEach((item, index) => {
    const record = item.record || item;
    completed.add(item.url || record.网址 || record.信息id || `record-${index}`);
  });
  return completed.size;
}

function taskEstimate(state = {}, now = Date.now()) {
  const totalPages = Math.max(0, Number(state.totalPages) || 0);
  const currentPage = Math.max(1, Number(state.currentPage) || 1);
  const pageSize = Math.max(0, Number(state.batchTotal || state.currentPageCount) || 0);
  if (!state.startedAt || !totalPages || !pageSize) return null;

  const types = state.informationTypes?.length ? state.informationTypes : DEFAULT_INFORMATION_TYPES;
  const typeIndex = Math.min(types.length - 1, Math.max(0, Number(state.typeFilterIndex) || 0));
  const remainingTypes = Math.max(0, types.length - typeIndex - 1);
  const currentPageRemaining = state.batchTotal
    ? Math.max(0, Number(state.batchTotal) - (Number(state.batchDone) || 0))
    : pageSize;
  const futurePages = Math.max(0, totalPages - currentPage);
  const remainingPages = 1 + futurePages + remainingTypes * totalPages;
  const remainingItems = Math.max(0,
    currentPageRemaining + futurePages * pageSize + remainingTypes * totalPages * pageSize);
  const completedItems = completedRecordCount(state);
  const timing = taskTiming(state, now);
  const intervalMs = Math.max(200, Number(state.settings?.intervalMs || settings.intervalMs) || 3000);
  const concurrency = Math.max(1, Number(state.settings?.concurrency || settings.concurrency) || 3);
  const configuredPerItemMs = Math.max(3000, intervalMs) / concurrency;
  const observedPerItemMs = completedItems >= Math.max(6, concurrency * 2) && timing.activeMs > 0
    ? timing.activeMs / completedItems : 0;
  const perItemMs = Math.min(180000, Math.max(configuredPerItemMs, observedPerItemMs));
  const remainingMs = Math.max(0, remainingItems * perItemMs + remainingPages * 3000);
  return {
    totalMs: timing.activeMs + remainingMs,
    remainingMs,
    remainingItems,
    completedItems,
    basedOnObservedSpeed: Boolean(observedPerItemMs)
  };
}

function estimateCaption(state, quota = latestQuota) {
  if (state.status === 'complete') return `本次实际运行 ${formatDuration(taskTiming(state).activeMs)}`;
  if (state.status === 'stopped') return `任务已停止 · 已运行 ${formatDuration(taskTiming(state).activeMs)}`;
  if (!state.startedAt) return '预计耗时：开始后计算';
  const estimate = taskEstimate(state);
  if (!estimate) return '预计耗时：正在读取结果数量…';
  const paused = pauseStartedAt(state) ? '恢复后预计剩余' : '预计剩余';
  const availableToday = Math.max(0, Number(quota.limit || PLUGIN_DAILY_LIMIT) - Number(quota.used || 0));
  const crossDay = estimate.remainingItems > availableToday ? ' · 可能跨日' : '';
  const source = estimate.basedOnObservedSpeed ? ' · 已按实际速度修正' : '';
  return `预计总运行 ${formatDuration(estimate.totalMs)} · ${paused} ${formatDuration(estimate.remainingMs)}${crossDay}${source}`;
}

function localDateKey(reference = new Date()) {
  return [reference.getFullYear(), String(reference.getMonth() + 1).padStart(2, '0'), String(reference.getDate()).padStart(2, '0')].join('-');
}

function previousCalendarMonthRange(reference = new Date()) {
  const format = (date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  return {
    start: format(new Date(reference.getFullYear(), reference.getMonth() - 1, 1)),
    end: format(new Date(reference.getFullYear(), reference.getMonth(), 0))
  };
}

function selectedTimeMode() {
  return document.querySelector('[data-time-mode].selected')?.dataset.timeMode || 'previous_calendar_month';
}

function renderTimeSelection(value = {}) {
  const mode = value.timeFilterMode === 'custom' ? 'custom' : 'previous_calendar_month';
  const fallback = previousCalendarMonthRange();
  const useSavedRange = mode === 'custom' || value.persisted;
  const start = useSavedRange ? (value.timeRangeStart || fallback.start) : fallback.start;
  const end = useSavedRange ? (value.timeRangeEnd || fallback.end) : fallback.end;
  document.querySelectorAll('[data-time-mode]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.timeMode === mode);
  });
  $('#time-start').value = start;
  $('#time-end').value = end;
  $('#custom-time-range').hidden = mode !== 'custom';
  $('#time-range-summary').textContent = `${start} - ${end}`;
}

function syncTimeSummary() {
  const mode = selectedTimeMode();
  const fallback = previousCalendarMonthRange();
  const start = $('#time-start').value || fallback.start;
  const end = $('#time-end').value || fallback.end;
  $('#custom-time-range').hidden = mode !== 'custom';
  $('#time-range-summary').textContent = mode === 'custom' ? `${start} - ${end}` : `${fallback.start} - ${fallback.end}`;
}

function normalizeQuota(value = {}) {
  const today = localDateKey();
  return {
    date: today,
    used: value.date === today ? Math.min(PLUGIN_DAILY_LIMIT, Math.max(0, Number(value.used) || 0)) : 0,
    limit: PLUGIN_DAILY_LIMIT,
    platformLimit: PLATFORM_DAILY_LIMIT
  };
}

function selectedInformationTypes() {
  const selected = new Set([...document.querySelectorAll('#information-types input:checked')].map((input) => input.value));
  return ALL_INFORMATION_TYPES.filter((type) => selected.has(type));
}

function renderInformationTypeSelection(types = DEFAULT_INFORMATION_TYPES) {
  const selected = new Set(types.filter((type) => ALL_INFORMATION_TYPES.includes(type)));
  document.querySelectorAll('#information-types input').forEach((input) => {
    input.checked = selected.has(input.value);
  });
  const values = selectedInformationTypes();
  $('#type-filter-summary').textContent = `${values.length ? values.join('、') : '未选择'} · ${values.length}/${ALL_INFORMATION_TYPES.length}`;
}

function advancedFilterSelections() {
  return Object.fromEntries(ADVANCED_FILTER_FIELDS.map(({ key, id }) => [key, $(`#${id}`).value || '全部']));
}

function mergedOfficialFilterOptions(options = {}) {
  return Object.fromEntries(ADVANCED_FILTER_FIELDS.map(({ key }) => [key,
    Array.isArray(options[key]) && options[key].length ? options[key] : OFFICIAL_ADVANCED_FILTER_FALLBACKS[key]
  ]));
}

function renderOfficialFilterOptions(options = {}, selected = advancedFilterSelections()) {
  for (const { key, id } of ADVANCED_FILTER_FIELDS) {
    const select = $(`#${id}`);
    const names = [...new Set(['全部', ...(options[key] || []).map((option) => String(option.text || option.label || option || '').trim()).filter(Boolean)])];
    const current = selected[key] || '全部';
    if (!names.includes(current)) names.push(current);
    select.replaceChildren(...names.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      return option;
    }));
    select.value = current;
  }
}

function normalizeWords(words = []) {
  return [...new Set(words.map((word) => String(word || '').trim()).filter(Boolean))].slice(0, 5);
}

function renderWordChips(kind, words) {
  const values = normalizeWords(words);
  draftWords[kind] = values;
  const prefix = kind === 'exclude' ? 'exclude' : 'related';
  $(`#${prefix}-word-count`).textContent = `${values.length}/5`;
  $(`#add-${prefix}-word`).disabled = values.length >= 5;
  $(`#${prefix}-word-chips`).replaceChildren(...values.map((word) => {
    const chip = document.createElement('span');
    chip.className = 'word-chip';
    const label = document.createElement('span');
    label.textContent = word;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.dataset.removeWord = word;
    remove.dataset.wordKind = kind;
    remove.title = `删除${word}`;
    chip.append(label, remove);
    return chip;
  }));
  updateAdvancedFilterSummary();
}

function updateAdvancedFilterSummary() {
  const selectedCount = Object.values(advancedFilterSelections()).filter((value) => value !== '全部').length;
  const wordCount = draftWords.exclude.length + draftWords.related.length;
  $('#advanced-filter-summary').textContent = `${selectedCount ? `筛选 ${selectedCount}` : '全部'} · 词 ${wordCount}/10`;
}

function renderAdvancedFilters(value = {}) {
  renderOfficialFilterOptions(latestOfficialFilterOptions, value.advancedFilters || {});
  renderWordChips('exclude', value.excludeWords || []);
  renderWordChips('related', value.relatedWords || []);
}

function normalizeKeywordOptions(values = []) {
  const seen = new Set();
  return values.map((value) => String(value || '').trim()).filter((value) => {
    const key = value.toLocaleLowerCase('zh-CN');
    if (!value || value.length > 80 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function setKeywordManagerFeedback(message = '', isError = false) {
  const feedback = $('#keyword-manager-feedback');
  feedback.textContent = message;
  feedback.className = `keyword-manager-feedback${isError ? ' error' : ''}`;
}

async function saveKeywordOptions() {
  await chrome.storage.local.set({ keywordOptions });
  renderKeywordOptions();
}

function renderKeywordManager() {
  const list = $('#keyword-manager-list');
  if (!keywordOptions.length) {
    const empty = document.createElement('div');
    empty.className = 'keyword-manager-empty';
    empty.textContent = '暂无常用关键词，可在主界面输入后点击“+”添加。';
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...keywordOptions.map((keyword, index) => {
    const row = document.createElement('div');
    row.className = 'keyword-manager-row';
    const input = document.createElement('input');
    input.value = keyword;
    input.maxLength = 80;
    input.setAttribute('aria-label', `编辑关键词 ${keyword}`);
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'keyword-manager-save';
    save.textContent = '✓';
    save.title = `保存“${keyword}”的修改`;
    save.setAttribute('aria-label', save.title);
    save.disabled = true;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'keyword-manager-delete';
    remove.textContent = '×';
    remove.title = `删除“${keyword}”`;
    remove.setAttribute('aria-label', remove.title);
    input.addEventListener('input', () => {
      save.disabled = !input.value.trim() || input.value.trim() === keyword;
      setKeywordManagerFeedback();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !save.disabled) save.click();
    });
    save.addEventListener('click', async () => {
      const nextKeyword = input.value.trim();
      const duplicate = keywordOptions.some((value, valueIndex) => valueIndex !== index
        && value.toLocaleLowerCase('zh-CN') === nextKeyword.toLocaleLowerCase('zh-CN'));
      if (duplicate) {
        setKeywordManagerFeedback('该关键词已存在，请使用其他名称。', true);
        return;
      }
      keywordOptions[index] = nextKeyword;
      keywordOptions = normalizeKeywordOptions(keywordOptions);
      if ($('#keyword').value.trim() === keyword) {
        $('#keyword').value = nextKeyword;
        keywordDirty = true;
      }
      await saveKeywordOptions();
      renderKeywordManager();
      setKeywordManagerFeedback('关键词已更新。');
    });
    remove.addEventListener('click', async () => {
      keywordOptions = keywordOptions.filter((_, valueIndex) => valueIndex !== index);
      await saveKeywordOptions();
      renderKeywordManager();
      setKeywordManagerFeedback(`已删除“${keyword}”。`);
    });
    row.append(input, save, remove);
    return row;
  }));
}

function renderKeywordOptions() {
  const selected = $('#keyword').value.trim();
  $('#keyword-options').replaceChildren(...keywordOptions.map((keyword, index) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.id = `keyword-option-${index}`;
    option.className = 'keyword-option';
    option.setAttribute('role', 'option');
    option.textContent = keyword;
    option.addEventListener('click', () => {
      $('#keyword').value = keyword;
      keywordDirty = true;
      syncKeywordControls();
      setKeywordDropdown(false);
      $('#keyword').focus();
    });
    return option;
  }));
  $('#keyword-toggle').disabled = !keywordOptions.length;
  $('#keyword-toggle').title = keywordOptions.length ? '选择常用关键词' : '暂无常用关键词';
  syncKeywordControls(selected);
}

function setKeywordDropdown(open) {
  const visible = Boolean(open && keywordOptions.length);
  $('#keyword-options').hidden = !visible;
  $('#keyword').setAttribute('aria-expanded', String(visible));
  $('#keyword-toggle').setAttribute('aria-expanded', String(visible));
  $('#keyword-toggle').classList.toggle('open', visible);
}

function syncKeywordControls(value = $('#keyword').value.trim()) {
  const normalized = value.toLocaleLowerCase('zh-CN');
  const selectedIndex = keywordOptions.findIndex((keyword) => keyword.toLocaleLowerCase('zh-CN') === normalized);
  const addButton = $('#add-keyword');
  const duplicate = selectedIndex >= 0;
  addButton.disabled = !value || duplicate;
  addButton.title = !value
    ? '请先输入关键词'
    : duplicate ? '该关键词已存在，无需重复添加' : '添加到常用关键词';
  [...$('#keyword-options').children].forEach((option, index) => {
    const selected = index === selectedIndex;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-selected', String(selected));
  });
  if (selectedIndex >= 0) $('#keyword').setAttribute('aria-activedescendant', `keyword-option-${selectedIndex}`);
  else $('#keyword').removeAttribute('aria-activedescendant');
}

function syncKeywordOptions(values = []) {
  const next = normalizeKeywordOptions(values);
  if (next.length === keywordOptions.length && next.every((value, index) => value === keywordOptions[index])) return;
  keywordOptions = next;
  renderKeywordOptions();
  if ($('#keyword-manager-dialog').open) renderKeywordManager();
}

function statusLabel(state) {
  const batch = state.batchTotal ? `第 ${state.currentPage || 1} 页 ${state.batchDone || 0}/${state.batchTotal}` : `第 ${state.currentPage || 1} 页`;
  const type = state.currentType ? `${state.currentType} · ` : '';
  return {
    idle: '尚未开始，输入关键词后开始采集。',
    searching: '正在打开后台检索页…',
    filtering: state.filterStage === 'type'
      ? `正在筛选信息类型 · ${state.currentType || ''}`
      : state.filterStage === 'advanced'
        ? '正在应用采购方式、资金来源等高级条件…'
        : `正在应用${state.timeFilterMode === 'custom' ? '自定义' : '上个月整月'}时间范围…`,
    running: state.batchTotal ? `${type}正在批量读取 · ${batch}` : `${type}正在读取列表 · ${batch}`,
    paused: `${type}任务已暂停，运行耗时已停止；点击“继续”恢复。`,
    verification_wait: state.verificationMode === 'manual'
      ? '网站要求滑块验证 · 请在已打开的验证页手动完成，完成后自动继续。'
      : `访问频控冷却中 · ${Math.max(0, Math.ceil(((state.verificationUntil || 0) - Date.now()) / 1000))} 秒后重试`,
    daily_limit: `今日插件访问已达 ${latestQuota.used}/${latestQuota.limit}，断点已保存；次日点击“继续”。`,
    login_required: state.error || '请先登录采招网会员账号，再开始或继续采集。',
    stopped: '任务已停止，请尽快导出 Excel，避免结果失效后无法下载。',
    complete: `✓ ${(state.informationTypes || DEFAULT_INFORMATION_TYPES).join('、')}采集完成，请尽快导出 Excel，避免结果失效后无法下载。`,
    error: state.error || '任务出现错误，请查看日志。'
  }[state.status] || '正在读取任务状态…';
}

function progress(state) {
  if (state.status === 'complete') return { value: 100, label: '全部分页已完成' };
  const total = Number(state.batchTotal || state.currentPageCount || 0);
  const done = Number(state.batchDone || 0);
  if (!total) return { value: state.status === 'complete' ? 100 : 0, label: state.status === 'complete' ? '全部分页已完成' : '等待详情任务' };
  return { value: Math.min(100, Math.round(done / total * 100)), label: `${state.currentType ? `${state.currentType} · ` : ''}当前页 ${done}/${total}` };
}

function systemDiagnostic(state, errors = latestSystemErrors) {
  const lines = [
    `插件版本：${chrome.runtime.getManifest().version}`,
    `导出时间：${new Date().toISOString()}`,
    `状态：${state.status || 'idle'}`,
    `关键词：${state.keyword || '无'}`,
    `检索时间：${state.timeRangeStart && state.timeRangeEnd ? `${state.timeFilterMode === 'custom' ? '自定义' : '上个月整月'} ${state.timeRangeStart} 至 ${state.timeRangeEnd}` : '上个月整月（任务启动时自动计算）'}`,
    `当前信息类型：${state.currentType || '无'}`,
    `已选信息类型：${(state.informationTypes || settings.informationTypes || DEFAULT_INFORMATION_TYPES).join('、')}`,
    `采购方式：${state.advancedFilters?.purchaseMethod || '全部'}`,
    `资金来源：${state.advancedFilters?.fundingSource || '全部'}`,
    `评标办法：${state.advancedFilters?.evaluationMethod || '全部'}`,
    `资质证书：${state.advancedFilters?.qualificationCertificate || '全部'}`,
    `排除词：${(state.excludeWords || []).join('、') || '无'}`,
    `相关词：${(state.relatedWords || []).join('、') || '无'}`,
    `分页：${state.currentPage || '-'} / ${state.totalPages || '-'}`,
    `本页进度：${state.batchDone || 0}/${state.batchTotal || 0}`,
    `运行耗时：${formatDuration(taskTiming(state).activeMs)}`,
    `暂停耗时：${formatDuration(taskTiming(state).pausedMs)}`,
    `任务时间预估：${estimateCaption(state)}`,
    `详情间隔：${state.settings?.intervalMs || settings.intervalMs}ms`,
    `并发数：${state.settings?.concurrency || settings.concurrency}`,
    `今日插件详情访问：${latestQuota.used}/${latestQuota.limit}`,
    `平台每日上限：${latestQuota.platformLimit}`,
    `额度统计日期：${latestQuota.date}`,
    '',
    `插件运行错误（${errors.length} 条）：`
  ];
  if (!errors.length) lines.push('暂无插件运行错误。');
  errors.forEach((error, index) => {
    lines.push(
      '',
      `#${index + 1} ${error.time || '未知时间'} [${error.source || 'unknown'}]`,
      `上下文：${error.context || '无'}`,
      `错误：${error.message || '未知错误'}`,
      `页面：${error.url || '无'}`,
      `堆栈：${error.stack || '无'}`
    );
  });
  return lines.join('\n');
}

async function reportSidepanelError(error, context, includeInSystemDebug = true) {
  const current = latestState || {};
  const message = error?.message || String(error || '未知错误');
  const errorDetails = {
    time: new Date().toISOString(), message, stack: error?.stack || '',
    url: current.listUrl || location.href, context, source: 'sidepanel'
  };
  const now = new Date().toISOString();
  const next = { ...current, status: 'error', error: message, errorDetails, pausedAt: current.pausedAt || now, updatedAt: now };
  latestState = next;
  if (includeInSystemDebug) {
    await chrome.runtime.sendMessage({ type: 'REPORT_SYSTEM_ERROR', details: errorDetails }).catch(() => undefined);
  }
  await chrome.storage.local.set({ task: next });
  render(next, latestLogs, latestSystemErrors, latestQuota);
}

function reportReadError(error) {
  reportSidepanelError(error, '读取任务状态').catch(() => undefined);
}

function renderLogs() {
  const filter = $('#log-filter').value;
  const logs = filter === 'all' ? latestLogs : latestLogs.filter((entry) => entry.level === filter);
  const logsEl = $('#logs');
  logsEl.replaceChildren(...logs.slice(-180).map((entry) => {
    const row = document.createElement('div');
    row.className = `log ${entry.level || 'info'}`;
    row.innerHTML = `<time>${formatTime(entry.time)}</time>${escapeHtml(entry.message)}${entry.detail ? ` · ${escapeHtml(entry.detail)}` : ''}`;
    return row;
  }));
  $('#log-count').textContent = `${latestLogs.length} 条`;
  if (logsFollowTail) logsEl.scrollTop = logsEl.scrollHeight;
}

function renderSystemErrors() {
  const debugEl = $('#debug-logs');
  $('#debug-count').textContent = `${latestSystemErrors.length} 条`;
  if (!latestSystemErrors.length) {
    debugEl.innerHTML = '<div class="debug-empty">暂无插件运行错误</div>';
    return;
  }
  debugEl.replaceChildren(...latestSystemErrors.slice(-100).reverse().map((error) => {
    const row = document.createElement('article');
    row.className = 'debug-entry';
    row.innerHTML = [
      `<div class="debug-entry-head"><time>${formatTime(error.time)}</time><span class="debug-entry-source">[${escapeHtml(error.source || 'unknown')}]</span><span>${escapeHtml(error.context || '未标注上下文')}</span></div>`,
      `<div class="debug-entry-message">${escapeHtml(error.message || '未知错误')}</div>`,
      error.url ? `<div class="debug-entry-detail">页面：${escapeHtml(error.url)}</div>` : '',
      error.stack ? `<div class="debug-entry-detail">${escapeHtml(error.stack)}</div>` : ''
    ].join('');
    return row;
  }));
}

function render(state = {}, logs = latestLogs, systemErrors = latestSystemErrors, quota = latestQuota, officialFilterOptions = latestOfficialFilterOptions) {
  latestState = state;
  latestLogs = logs;
  latestSystemErrors = systemErrors;
  latestQuota = normalizeQuota(quota);
  latestOfficialFilterOptions = mergedOfficialFilterOptions(officialFilterOptions);
  const label = statusLabel(state);
  const bar = progress(state);
  $('#status').textContent = label;
  $('#status').className = `status ${state.status === 'error' ? 'error' : ['login_required', 'verification_wait'].includes(state.status) ? 'warning' : ''}`;
  const dotMap = { error: 'error', login_required: 'waiting', verification_wait: 'waiting', daily_limit: 'waiting', paused: 'paused', stopped: 'paused', complete: 'complete' };
  const dotStatus = ['running', 'searching', 'filtering'].includes(state.status) ? 'running' : (dotMap[state.status] || '');
  $('#status-dot').className = `status-dot ${dotStatus}`;
  $('#elapsed-time').textContent = timingCaption(state);
  $('#time-estimate').textContent = estimateCaption(state, latestQuota);
  $('#progress-bar').style.width = `${bar.value}%`;
  $('#progress-bar').classList.toggle('complete', state.status === 'complete');
  $('#progress-label').textContent = bar.label;
  $('#progress-percent').textContent = `${bar.value}%`;
  const visibleRecords = [...(state.records || []), ...(state.partialRecords || [])];
  const uniqueRecords = new Map(visibleRecords.map((record) => [record.url || record.record?.网址 || record.网址 || JSON.stringify(record), record.record || record]));
  $('#record-count').textContent = uniqueRecords.size;
  $('#current-page').textContent = `${state.currentPage || '-'}/${state.totalPages || '-'}`;
  $('#quota-count').textContent = `${latestQuota.used}/${latestQuota.limit}`;
  const partialFailed = (state.partialRecords || []).filter((item) => item.error || item.record?.采集状态 === '失败').length;
  $('#failed-count').textContent = state.batchFailed || partialFailed || state.records?.filter((record) => record.采集状态 === '失败').length || 0;
  if (state.keyword && !keywordDirty) {
    $('#keyword').value = state.keyword;
    syncKeywordControls();
  }
  $('#last-action').textContent = state.lastTitle ? `最近：${state.lastTitle}` : state.updatedAt ? `更新于 ${formatTime(state.updatedAt)}` : '尚未开始任务';
  if (!settingsDirty) {
    const currentSettings = { ...settings, ...(state.settings || {}) };
    $('#interval').value = currentSettings.intervalMs;
    $('#concurrency').value = currentSettings.concurrency;
    document.querySelectorAll('[data-concurrency]').forEach((button) => {
      button.classList.toggle('selected', Number(button.dataset.concurrency) === Number(currentSettings.concurrency));
    });
    renderInformationTypeSelection(state.informationTypes || currentSettings.informationTypes || DEFAULT_INFORMATION_TYPES);
    renderTimeSelection({
      timeFilterMode: state.timeFilterMode || currentSettings.timeFilterMode,
      timeRangeStart: state.timeRangeStart || currentSettings.timeRangeStart,
      timeRangeEnd: state.timeRangeEnd || currentSettings.timeRangeEnd,
      persisted: Boolean(state.startedAt && state.timeRangeStart && state.timeRangeEnd)
    });
    renderAdvancedFilters({
      advancedFilters: state.advancedFilters || currentSettings.advancedFilters,
      excludeWords: state.excludeWords || currentSettings.excludeWords,
      relatedWords: state.relatedWords || currentSettings.relatedWords
    });
  } else {
    renderOfficialFilterOptions(latestOfficialFilterOptions, advancedFilterSelections());
    updateAdvancedFilterSummary();
  }
  $('#pause').disabled = !['searching', 'filtering', 'running'].includes(state.status);
  $('#resume').disabled = !['paused', 'error', 'daily_limit', 'login_required'].includes(state.status) || !state.listUrl;
  $('#export').disabled = !(state.records?.length || state.partialRecords?.length);
  $('#stop').disabled = !['searching', 'filtering', 'running', 'verification_wait', 'paused', 'daily_limit', 'login_required'].includes(state.status);
  $('#start').disabled = ['searching', 'filtering', 'running', 'verification_wait', 'paused', 'daily_limit'].includes(state.status);
  controls.forEach((button) => { button.title = button.textContent; });
  renderLogs();
  renderSystemErrors();
}

async function getState() {
  const stored = await chrome.storage.local.get(['task', 'taskLogs', 'collectorSettings', 'systemErrors', 'dailyQuotaUsage', 'officialAdvancedFilterOptions', 'keywordOptions']);
  const { task = {}, taskLogs = [], collectorSettings = {}, systemErrors = [], dailyQuotaUsage = {}, officialAdvancedFilterOptions = {} } = stored;
  const storedKeywordOptions = stored.keywordOptions;
  const normalizedKeywordOptions = normalizeKeywordOptions(Array.isArray(storedKeywordOptions) ? storedKeywordOptions : DEFAULT_KEYWORDS);
  syncKeywordOptions(normalizedKeywordOptions);
  if (!Array.isArray(storedKeywordOptions)
    || normalizedKeywordOptions.length !== storedKeywordOptions.length
    || normalizedKeywordOptions.some((value, index) => value !== storedKeywordOptions[index])) {
    await chrome.storage.local.set({ keywordOptions: normalizedKeywordOptions });
  }
  settings = { ...settings, ...collectorSettings, ...(task.settings || {}) };
  render(task, taskLogs, systemErrors, dailyQuotaUsage, officialAdvancedFilterOptions);
  return task;
}

$('#start').addEventListener('click', async () => {
  try {
    const keyword = $('#keyword').value.trim();
    if (!keyword) throw new Error('请输入搜索关键词。');
    if (!selectedInformationTypes().length) throw new Error('请至少选择一个信息类型。');
    keywordDirty = false;
    settings = readSettings();
    const response = await chrome.runtime.sendMessage({ type: 'START_SILENT', keyword, settings });
    if (response?.loginRequired) return;
    if (response?.error) throw new Error(response.error);
    if (response?.dailyLimit) await getState();
  } catch (error) { await reportSidepanelError(error, '开始采集', false); }
});
$('#stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'STOP_TASK' }));
$('#pause').addEventListener('click', async () => {
  const current = await getState();
  const now = new Date().toISOString();
  await chrome.storage.local.set({ task: { ...current, status: 'paused', pausedAt: current.pausedAt || now, updatedAt: now } });
  await getState();
});
$('#resume').addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'RESUME_SILENT' });
  if (response?.loginRequired) return getState();
  if (response?.error) await reportSidepanelError(new Error(response.error), '继续任务', false);
  else if (response?.dailyLimit) await getState();
});
function readSettings() {
  const timeFilterMode = selectedTimeMode();
  const defaultRange = previousCalendarMonthRange();
  const timeRangeStart = timeFilterMode === 'custom' ? $('#time-start').value : defaultRange.start;
  const timeRangeEnd = timeFilterMode === 'custom' ? $('#time-end').value : defaultRange.end;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(timeRangeStart) || !/^\d{4}-\d{2}-\d{2}$/.test(timeRangeEnd)) {
    throw new Error('请选择完整的开始日期和结束日期。');
  }
  if (timeRangeStart > timeRangeEnd) throw new Error('开始日期不能晚于结束日期。');
  const next = {
    intervalMs: Math.min(30000, Math.max(200, Number($('#interval').value) || 3000)),
    concurrency: Math.min(6, Math.max(1, Number($('#concurrency').value) || 3)),
    informationTypes: selectedInformationTypes(),
    timeFilterMode, timeRangeStart, timeRangeEnd,
    advancedFilters: advancedFilterSelections(),
    excludeWords: [...draftWords.exclude], relatedWords: [...draftWords.related]
  };
  settings = next;
  settingsDirty = false;
  chrome.storage.local.set({ collectorSettings: next });
  return next;
}

function adjustInterval(delta) {
  const input = $('#interval');
  const current = Number(input.value) || 3000;
  input.value = Math.min(30000, Math.max(200, current + delta));
  settingsDirty = true;
}

function exportableRecords(state) {
  const all = [...(state.records || [])];
  const known = new Set(all.map((record) => record.网址 || record.信息id));
  for (const item of state.partialRecords || []) {
    const record = item.record ? { ...item.record, ...(item.summary || {}) } : {
      ...(item.summary || {}),
      '信息id': item.summary?.信息id || '',
      '网址': item.url || '',
      '采集状态': '失败',
      '失败原因': item.error || '详情采集失败。',
      '详情页正文全文': '',
      '结构化字段证据': ''
    };
    const key = record.网址 || record.信息id || item.url;
    if (key && !known.has(key)) { all.push(record); known.add(key); }
  }
  return all;
}

$('#export').addEventListener('click', async () => {
  const state = await getState();
  const records = exportableRecords(state);
  if (records.length) downloadWorkbook(records);
});
$('#clear').addEventListener('click', async () => {
  await chrome.storage.local.remove(['task', 'taskLogs']);
  render({ status: 'idle' }, [], latestSystemErrors, latestQuota);
});
$('#factory-reset').addEventListener('click', async () => {
  const confirmed = confirm('恢复出厂设置将清除激活状态、任务、采集结果、日志、自定义关键词和所有用户设置。\n\n今日访问计数会保留，以防超过平台每日访问上限。确定继续吗？');
  if (!confirmed) return;
  const response = await chrome.runtime.sendMessage({ type: 'RESET_FACTORY' });
  if (response?.error) {
    await reportSidepanelError(new Error(response.error), '恢复出厂设置', false);
    return;
  }
  location.reload();
});
$('#activation-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#activation-input');
  const feedback = $('#activation-feedback');
  const button = $('#activate-button');
  const code = input.value.replace(/\s+/g, '');
  if (code !== ACTIVATION_CODE) {
    input.setAttribute('aria-invalid', 'true');
    feedback.className = 'activation-feedback error';
    feedback.textContent = '激活码不正确，请核对后重新输入。';
    input.focus();
    input.select();
    return;
  }
  input.removeAttribute('aria-invalid');
  button.disabled = true;
  button.textContent = '激活中…';
  try {
    await chrome.storage.local.set({
      [ACTIVATION_STORAGE_KEY]: { activated: true, activatedAt: new Date().toISOString() }
    });
    feedback.className = 'activation-feedback success';
    feedback.textContent = '激活成功。';
    showActivationView(true);
    startStatePolling();
  } catch (error) {
    button.disabled = false;
    button.textContent = '立即激活';
    feedback.className = 'activation-feedback error';
    feedback.textContent = `激活失败：${error.message}`;
  }
});
$('#activation-input').addEventListener('input', (event) => {
  event.currentTarget.value = event.currentTarget.value.replace(/\D/g, '').slice(0, 11);
  event.currentTarget.removeAttribute('aria-invalid');
  $('#activation-feedback').className = 'activation-feedback';
  $('#activation-feedback').textContent = '';
});
$('#logs').addEventListener('scroll', () => {
  const logsEl = $('#logs');
  logsFollowTail = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight < 24;
});
$('#log-filter').addEventListener('change', () => { logsFollowTail = true; renderLogs(); });
['#interval', '#concurrency'].forEach((selector) => {
  $(selector).addEventListener('input', () => { settingsDirty = true; });
  $(selector).addEventListener('change', () => { settingsDirty = true; });
});
document.querySelectorAll('#information-types input').forEach((input) => {
  input.addEventListener('change', () => {
    settingsDirty = true;
    renderInformationTypeSelection(selectedInformationTypes());
  });
});
ADVANCED_FILTER_FIELDS.forEach(({ id }) => {
  $(`#${id}`).addEventListener('change', () => { settingsDirty = true; updateAdvancedFilterSummary(); });
});

function addDraftWord(kind) {
  const prefix = kind === 'exclude' ? 'exclude' : 'related';
  const input = $(`#${prefix}-word-input`);
  const word = input.value.trim();
  if (!word || draftWords[kind].length >= 5 || draftWords[kind].includes(word)) return;
  if (word.length > 10 || word.includes(',')) {
    input.setCustomValidity('每个词不得超过 10 个字，且不能包含逗号。');
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  settingsDirty = true;
  renderWordChips(kind, [...draftWords[kind], word]);
  input.value = '';
}

$('#add-exclude-word').addEventListener('click', () => addDraftWord('exclude'));
$('#add-related-word').addEventListener('click', () => addDraftWord('related'));
['exclude', 'related'].forEach((kind) => {
  $(`#${kind}-word-input`).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addDraftWord(kind); }
  });
  $(`#${kind}-word-input`).addEventListener('input', (event) => event.currentTarget.setCustomValidity(''));
  $(`#${kind}-word-chips`).addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-word]');
    if (!button) return;
    settingsDirty = true;
    renderWordChips(kind, draftWords[kind].filter((word) => word !== button.dataset.removeWord));
  });
});
document.querySelectorAll('[data-time-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-time-mode]').forEach((item) => item.classList.toggle('selected', item === button));
    if (!$('#time-start').value || !$('#time-end').value) {
      const range = previousCalendarMonthRange();
      $('#time-start').value ||= range.start;
      $('#time-end').value ||= range.end;
    }
    settingsDirty = true;
    syncTimeSummary();
  });
});
['#time-start', '#time-end'].forEach((selector) => {
  $(selector).addEventListener('input', () => { settingsDirty = true; syncTimeSummary(); });
  $(selector).addEventListener('change', () => { settingsDirty = true; syncTimeSummary(); });
});
document.querySelectorAll('[data-concurrency]').forEach((button) => {
  button.addEventListener('click', () => {
    $('#concurrency').value = button.dataset.concurrency;
    document.querySelectorAll('[data-concurrency]').forEach((item) => item.classList.toggle('selected', item === button));
    settingsDirty = true;
  });
});
$('#interval-decrease').addEventListener('click', () => adjustInterval(-100));
$('#interval-increase').addEventListener('click', () => adjustInterval(100));
$('#keyword').addEventListener('input', () => {
  keywordDirty = true;
  syncKeywordControls();
});
$('#keyword').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    setKeywordDropdown(true);
    $('#keyword-options .selected, #keyword-options .keyword-option')?.focus();
  } else if (event.key === 'Escape') {
    setKeywordDropdown(false);
  }
});
$('#keyword-toggle').addEventListener('click', () => setKeywordDropdown($('#keyword-options').hidden));
$('#keyword-options').addEventListener('keydown', (event) => {
  const options = [...$('#keyword-options').querySelectorAll('.keyword-option')];
  const currentIndex = options.indexOf(document.activeElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    setKeywordDropdown(false);
    $('#keyword').focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    options[(currentIndex + direction + options.length) % options.length]?.focus();
  }
});
$('#add-keyword').addEventListener('click', async () => {
  const keyword = $('#keyword').value.trim();
  const duplicate = keywordOptions.some((value) => value.toLocaleLowerCase('zh-CN') === keyword.toLocaleLowerCase('zh-CN'));
  if (!keyword || duplicate) {
    syncKeywordControls();
    $('#keyword').focus();
    return;
  }
  keywordOptions = normalizeKeywordOptions([...keywordOptions, keyword]);
  await saveKeywordOptions();
  $('#add-keyword').textContent = '✓';
  setTimeout(() => { $('#add-keyword').textContent = '+'; }, 1200);
});
$('#manage-keywords').addEventListener('click', () => {
  setKeywordDropdown(false);
  setKeywordManagerFeedback();
  renderKeywordManager();
  $('#keyword-manager-dialog').showModal();
});
$('#close-keyword-manager').addEventListener('click', () => $('#keyword-manager-dialog').close());
$('#keyword-manager-dialog').addEventListener('click', (event) => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#keyword-combobox')) setKeywordDropdown(false);
});
$('#diagnose').addEventListener('click', async () => {
  const state = await getState();
  const timing = taskTiming(state);
  const detail = `状态=${state.status || 'idle'}；运行耗时=${formatDuration(timing.activeMs)}；暂停耗时=${formatDuration(timing.pausedMs)}；时间预估=${estimateCaption(state)}；检索时间=${state.timeRangeStart && state.timeRangeEnd ? `${state.timeFilterMode === 'custom' ? '自定义' : '上个月整月'} ${state.timeRangeStart}至${state.timeRangeEnd}` : '未开始'}；信息类型=${(state.informationTypes || selectedInformationTypes()).join('、') || '未选择'}；高级筛选=${Object.values(state.advancedFilters || advancedFilterSelections()).join('、')}；排除词=${(state.excludeWords || draftWords.exclude).join('、') || '无'}；相关词=${(state.relatedWords || draftWords.related).join('、') || '无'}；分页=${state.currentPage || '-'}/${state.totalPages || '-'}；本页=${state.batchDone || 0}/${state.batchTotal || 0}；已抓取=${exportableRecords(state).length}；错误=${state.batchFailed || 0}；今日访问=${latestQuota.used}/${latestQuota.limit}；平台上限=${latestQuota.platformLimit}`;
  await chrome.runtime.sendMessage({ type: 'ADD_LOG', level: 'info', message: '诊断快照', detail });
});
$('#copy-logs').addEventListener('click', async () => {
  const text = latestLogs.map((entry) => `[${formatTime(entry.time)}] ${entry.level || 'info'} ${entry.message}${entry.detail ? ` | ${entry.detail}` : ''}`).join('\n');
  await navigator.clipboard.writeText(text);
  $('#copy-logs').textContent = '已复制';
  setTimeout(() => { $('#copy-logs').textContent = '复制'; }, 1200);
});
$('#copy-debug').addEventListener('click', async () => {
  await navigator.clipboard.writeText(systemDiagnostic(latestState));
  $('#copy-debug').textContent = '已复制';
  setTimeout(() => { $('#copy-debug').textContent = '复制'; }, 1200);
});
$('#clear-debug').addEventListener('click', async () => {
  await chrome.storage.local.remove('systemErrors');
  latestSystemErrors = [];
  renderSystemErrors();
});
window.addEventListener('error', (event) => {
  reportSidepanelError(event.error || new Error(event.message), '未捕获异常').catch(() => undefined);
});
window.addEventListener('unhandledrejection', (event) => {
  reportSidepanelError(event.reason instanceof Error ? event.reason : new Error(String(event.reason)), '未处理的 Promise 异常').catch(() => undefined);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[ACTIVATION_STORAGE_KEY]) {
    const isActivated = changes[ACTIVATION_STORAGE_KEY].newValue?.activated === true;
    showActivationView(isActivated);
    if (isActivated) startStatePolling();
    return;
  }
  if (!activationReady || !(changes.task || changes.taskLogs || changes.systemErrors || changes.dailyQuotaUsage || changes.officialAdvancedFilterOptions || changes.keywordOptions)) return;
  getState().catch(reportReadError);
});
initializeSidepanel().catch(reportReadError);

// 键盘快捷键：Space=暂停/继续，Esc=停止（焦点在输入控件时不触发）
document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, select, textarea, button')) return;
  if (event.code === 'Space') {
    event.preventDefault();
    if (!$('#pause').disabled) $('#pause').click();
    else if (!$('#resume').disabled) $('#resume').click();
  } else if (event.key === 'Escape') {
    if (!$('#stop').disabled) $('#stop').click();
  }
});
