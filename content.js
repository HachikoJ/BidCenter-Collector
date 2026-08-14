const RESULT_SELECTORS = {
  type: '.ssjg-leixing',
  title: 'a.ssjg-title[tid][href]',
  deadline: '.ssjg-list_text.jiezhishijian',
  province: '.diqu',
  date: '.ssjg-shijian.fr, .ssjg-list_foot > .fr'
};

const FIELD_LABELS = {
  '招标方式': ['招标方式', '采购方式', '交易方式'],
  '项目编号': ['项目编号', '招标项目编号', '采购项目编号', '招标编号', '采购编号', '项目编码', '项目代码', '标项编号', '标段包/编号'],
  '招标单位': ['招标单位', '采购人名称', '招标人名称', '采购人(甲方)', '采购人（甲方）', '采购人', '招标人', '项目业主', '业主单位', '建设单位'],
  '中标单位': ['中标（成交）供应商名称', '中标供应商名称', '成交供应商名称', '中标单位', '成交供应商', '中标人', '供应商(乙方)', '供应商（乙方）', '供应商名称', '供应商'],
  '代理机构': ['采购代理机构名称', '招标代理机构名称', '代理机构名称', '招标代理机构', '采购代理机构', '代理机构'],
  '项目预算': ['项目预算', '预算金额(万元)', '预算金额（万元）', '预算金额', '采购预算', '最高限价', '最高竞标限价', '控制价'],
  '资金来源': ['资金来源'],
  '中标金额': ['中标（成交金额）', '中标成交金额', '中标金额', '成交金额', '合同金额', '中选金额'],
  '评标办法': ['评标办法', '评审方法', '评标方法', '评标方式']
};

const DIAGNOSTIC_FIELDS = [
  '项目编号', '招标单位', '中标单位', '代理机构', '项目预算', '资金来源', '中标金额',
  '评标办法', '业主联系人', '业主联系电话', '中标单位联系人', '中标单位联系电话 ',
  '代理机构联系人', '代理机构联系电话'
];

const INFORMATION_TYPES = [
  '招标公告', '招标变更', '中标结果', '采购信息', '招标预告', '审批公示',
  '拍卖转让', '土地挂牌', '司法拍卖', '其它公告'
];
const INFORMATION_TYPE_SEQUENCE = ['招标公告', '中标结果'];
const ADVANCED_FILTER_FIELDS = [
  { key: 'purchaseMethod', label: '采购方式', param: 'ext_cgfs', selector: '#jq_ddl_cgfs li', valueAttribute: 'tid' },
  { key: 'fundingSource', label: '资金来源', param: 'ext_zjly', selector: '#jq_ddl_zjly li', valueAttribute: 'tid' },
  { key: 'evaluationMethod', label: '评标办法', param: 'ext_pbbf', selector: '#jq_ddl_pbbf li', valueAttribute: 'tid' },
  { key: 'qualificationCertificate', label: '资质证书', param: 'zzzs', selector: 'select[name="jq_ddl_zzzs"] option' }
];

let taskRunning = false;
const RESULT_LOAD_TIMEOUT = 45000;
const RESULT_STABLE_FOR = 800;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (element) => element?.innerText?.replace(/\s+/g, ' ').trim() || '';
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

async function taskState() {
  const { task = { status: 'idle', records: [], completedPages: [] } } = await chrome.storage.local.get('task');
  return task;
}

async function recordContentError(error, context) {
  const state = await taskState();
  const message = error?.message || String(error || '未知错误');
  const errorDetails = {
    time: new Date().toISOString(), message, stack: error?.stack || '',
    url: location.href, context, source: 'content'
  };
  await chrome.runtime.sendMessage({ type: 'REPORT_SYSTEM_ERROR', details: errorDetails }).catch(() => undefined);
  await saveTask({ status: 'error', error: message, errorDetails, pausedAt: state.pausedAt || new Date().toISOString() });
  addLog('error', '系统级错误', `${context}：${message}`);
  return state;
}

window.addEventListener('error', (event) => {
  recordContentError(event.error || new Error(event.message), '未捕获异常').catch(() => undefined);
});
window.addEventListener('unhandledrejection', (event) => {
  recordContentError(event.reason instanceof Error ? event.reason : new Error(String(event.reason)), '未处理的 Promise 异常').catch(() => undefined);
});

async function saveTask(patch) {
  const current = await taskState();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ task: next });
  return next;
}

function addLog(level, message, detail = '') {
  chrome.runtime.sendMessage({ type: 'ADD_LOG', level, message, detail }).catch(() => undefined);
}

function isProgrammingError(error) {
  return ['TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(error?.name);
}

function isResultPage() {
  return document.querySelectorAll(RESULT_SELECTORS.title).length > 0;
}

function closestResultContainer(titleElement) {
  return titleElement.closest('.ssjg-list_body') || titleElement.parentElement || titleElement;
}

function absoluteUrl(value) {
  if (!value) return '';
  try { return new URL(value, location.href).href; } catch (_) { return ''; }
}

function listEntries() {
  const seen = new Set();
  return [...document.querySelectorAll(RESULT_SELECTORS.title)].map((titleElement, index) => {
    const container = closestResultContainer(titleElement);
    const link = titleElement;
    const url = absoluteUrl(link?.href);
    if (!url || !/bidcenter\.com\.cn/.test(url) || seen.has(url)) return null;
    seen.add(url);
    const informationType = text(container.querySelector(RESULT_SELECTORS.type));
    const timingText = text(container.querySelector(RESULT_SELECTORS.deadline));
    const timingValue = text(container.querySelector('.ssjg-list_text.jiezhishijian .jiezhi'))
      || timingText.match(/(?:中标时间|截止时间|预计采购)[：:]\s*([^\s]+)/)?.[1] || '';
    const publishDate = text(container.querySelector('.ssjg-shijian.fr'));
    const method = text(container.querySelector('.ssjg-list_text.caigoufangshi .fangshi'));
    const amountLabel = text(container.querySelector('.ssjg-list_text.caigouyusuan')).match(/^(中标金额|成交金额|采购预算|项目预算|预算金额)/)?.[1] || '';
    const amount = text(container.querySelector('.ssjg-list_text.caigouyusuan .yusuan'));
    const useful = (value) => value && !/详见内容|暂无|--/.test(value) ? value : '';
    return {
      url,
      summary: {
        '信息标题': text(titleElement),
        '信息类型': informationType,
        '省份': text(container.querySelector(RESULT_SELECTORS.province)),
        '中标时间': /中标|成交/.test(informationType) ? useful(timingValue) : '',
        '截止时间': /截止时间/.test(timingText) ? useful(timingValue) : '',
        '发布日期': publishDate.match(/\d{4}-\d{2}-\d{2}/)?.[0] || publishDate,
        '招标方式': useful(method),
        '项目预算': /预算/.test(amountLabel) ? useful(amount) : '',
        '中标金额': /中标|成交/.test(amountLabel) ? useful(amount) : ''
      }
    };
  }).filter(Boolean);
}

function resultSignature(entries = listEntries()) {
  return entries.map((entry) => entry.url).join('|');
}

async function waitForStableResults({ differentFrom = '', expectedPage = 0 } = {}) {
  const startedAt = Date.now();
  let signature = '';
  let stableSince = 0;
  while (Date.now() - startedAt < RESULT_LOAD_TIMEOUT) {
    const entries = listEntries();
    const current = resultSignature(entries);
    const pageReady = !expectedPage || pageNumber() === expectedPage;
    if (current && current !== differentFrom && pageReady) {
      if (current === signature) {
        if (Date.now() - stableSince >= RESULT_STABLE_FOR) return entries;
      } else {
        signature = current;
        stableSince = Date.now();
      }
    } else {
      signature = '';
      stableSince = 0;
    }
    await sleep(250);
  }
  return [];
}

function infoIdFromUrl(url = location.href) {
  return url.match(/(?:news|show)-(\d+)/i)?.[1]
    || url.match(/#\/des\/customDesSearch\/(\d+)/i)?.[1]
    || url.match(/[?&](?:id|infoid)=(\d+)/i)?.[1] || '';
}

function detailRoot() {
  return document.querySelector('#gonggaozhengwen, .gonggaozhengwen, #news_contet_detail, .zbzw_content, .article-content, .detail-content, .news-content');
}

function detailText() {
  const candidates = ['#gonggaozhengwen', '.gonggaozhengwen', '#news_contet_detail', '.zbzw_content', '.article-content', '.detail-content', '.news-content'];
  for (const selector of candidates) {
    const value = text(document.querySelector(selector));
    if (value.length > 30) return value;
  }
  return '';
}

function normalizedLabel(value) {
  return clean(value)
    .replace(/^[一二三四五六七八九十\d]+[.、．)）]\s*/, '')
    .replace(/[：:]$/, '')
    .replace(/\s+/g, '');
}

function looksLikeFieldLabel(value) {
  const label = normalizedLabel(value);
  return label.length <= 24
    && /^(?:序号|标项|包号|项目|采购|招标|投标|中标|成交|供应商|代理|业主|建设|合同|预算|最高|控制|资金|评标|评审|联系人|联系电话|电话|地址|名称|编号|编码|代码|日期|时间|方式|类型|金额|报价|单价|总价|规格|数量|统一社会信用代码)/.test(label);
}

function structuredPairs(root) {
  const pairs = [];
  const seen = new Set();
  const push = (label, value, source) => {
    label = normalizedLabel(label);
    value = clean(value);
    const key = `${label}\u0000${value}`;
    if (label && value && label !== normalizedLabel(value) && !seen.has(key)) {
      seen.add(key);
      pairs.push({ label, value, source });
    }
  };

  for (const row of root.querySelectorAll('tr')) {
    const cells = [...row.cells].map(text);
    const isKeyValueRow = cells.length >= 2 && cells.length % 2 === 0
      && cells.filter((_, index) => index % 2 === 0).every(looksLikeFieldLabel)
      && !cells.filter((_, index) => index % 2 === 1).every(looksLikeFieldLabel);
    if (isKeyValueRow) {
      for (let index = 0; index + 1 < cells.length; index += 2) {
        push(cells[index], cells[index + 1], 'table-row');
      }
    }
  }

  for (const table of root.querySelectorAll('table')) {
    const rows = [...table.rows];
    if (rows.length < 2) continue;
    const headers = [...rows[0].cells].map((cell) => normalizedLabel(text(cell)));
    if (headers.length < 2 || !headers.every(looksLikeFieldLabel)) continue;
    for (const row of rows.slice(1)) {
      const values = [...row.cells].map(text);
      headers.forEach((header, index) => push(header, values[index], 'table-column'));
    }
  }

  const lines = (root.innerText || '').split(/\n+/).map(clean).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([^：:]{1,32})[：:]\s*(.*)$/);
    if (!match) continue;
    const value = match[2] || ((lines[index + 1] && !/^[^：:]{1,32}[：:]/.test(lines[index + 1])) ? lines[index + 1] : '');
    push(match[1], value, 'line');
  }
  return pairs;
}

function pairValue(pairs, labels) {
  const wanted = labels.map(normalizedLabel);
  for (const label of wanted) {
    const exact = pairs.find((pair) => pair.label === label);
    if (exact?.value) return exact.value;
    const qualified = pairs.find((pair) => pair.label.startsWith(label)
      && /^(?:[（(][^）)]{1,16}[）)]|名称|金额)?$/.test(pair.label.slice(label.length)));
    if (qualified?.value) return qualified.value;
  }
  return '';
}

function sectionText(fullText, starts, stops, useLast = false) {
  const startPattern = starts.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const stopPattern = stops.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const matches = [...fullText.matchAll(new RegExp(`(?:${startPattern})[\\s\\S]{0,1600}?(?=${stopPattern}|$)`, 'ig'))];
  return (useLast ? matches.at(-1) : matches[0])?.[0] || '';
}

function contactValue(section, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = section.match(new RegExp(`${escaped}\\s*[：:]\\s*([^\\n]{1,160})`, 'i'));
    if (match?.[1]) return clean(match[1]);
  }
  return '';
}

function sectionContacts(section) {
  let name = contactValue(section, ['项目联系人', '联 系 人', '联系人']);
  let phone = contactValue(section, ['联系电话', '电话', '电 话']);
  const combined = contactValue(section, ['联系方式']);
  if (combined && !phone) {
    const parts = combined.split(/[／/]/).map(clean).filter(Boolean);
    if (parts.length > 1) {
      if (!name) name = parts[0];
      phone = parts.slice(1).join('/');
    } else if (/\d|\*|略/.test(combined)) phone = combined;
  }
  return { name, phone };
}

function detailTitle() {
  const selector = '.title-box h2, h1.item-tit, h1, .article-title, .news-title, .detail-title, .title';
  const title = [...document.querySelectorAll(selector)].map(text).find((value) => value.length > 3 && value.length < 300);
  return title || clean(document.title).replace(/[-_｜|].*$/, '').trim();
}

function detailReady() {
  const title = text(document.querySelector('.title-box h2, h1.item-tit, h1, .article-title, .news-title, .detail-title'));
  const body = text(detailRoot());
  return title.length > 3 && body.length > 30;
}

function waitForDetailReady(timeout = 85000) {
  if (detailReady()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!detailReady()) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve(true);
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, timeout);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  });
}

function scrapeDetail() {
  const root = detailRoot();
  const fullText = root?.innerText?.trim() || '';
  const pairs = root ? structuredPairs(root) : [];
  const tags = [...document.querySelectorAll('.main-top .tag-box > span')].map(text).filter(Boolean);
  const dateTag = tags.find((value) => /^\d{4}年\d{2}月\d{2}日$/.test(value));
  const regionTag = tags.find((value) => value.includes('|'));
  const informationType = tags.find((value) => INFORMATION_TYPES.includes(value)) || '';
  const [province = '', city = ''] = regionTag?.split('|').map((value) => value.trim()) || [];
  const record = {
    '信息id': infoIdFromUrl(),
    '信息标题': detailTitle(),
    '省份': province,
    '城市': city,
    '信息类型': informationType,
    '中标时间': dateTag?.replace(/年|月/g, '-').replace('日', '') || '',
    '信息详情': detailText(),
    '详情页正文全文': fullText,
    '结构化字段证据': JSON.stringify(pairs),
    '采集状态': '成功',
    '失败原因': '',
    '网址': location.href
  };
  for (const [field, labels] of Object.entries(FIELD_LABELS)) record[field] = pairValue(pairs, labels) || record[field] || '';
  const ownerSection = sectionText(fullText,
    ['招标人联系方式', '采购人信息', '采购人联系方式', '受理异议的联系方式', '十一、联系方式', '十、联系方式'],
    ['代理机构联系方式', '采购代理机构信息', '监督部门', '项目联系方式', '附件', '相关附件']);
  const agentSection = sectionText(fullText,
    ['代理机构联系方式', '采购代理机构信息', '招标代理机构信息', '招标代理机构：', '招标代理机构'],
    ['项目联系方式', '监督部门', '附件', '相关附件', '在线报名地址'], true);
  const projectSection = sectionText(fullText,
    ['项目联系方式'],
    ['监督部门', '附件', '相关附件', '在线报名地址']);
  const winnerSection = sectionText(fullText,
    ['中标单位联系方式', '中标供应商联系方式', '成交供应商联系方式'],
    ['代理机构联系方式', '采购代理机构信息', '附件', '相关附件']);
  record['招标单位'] ||= contactValue(ownerSection, ['名 称', '名称', '招标人', '采购人']);
  record['代理机构'] ||= contactValue(agentSection, ['名 称', '名称', '代理机构']);
  record['评标办法'] ||= tags.find((value) => /^评标(?:方式|办法)[：:]/.test(value))?.replace(/^评标(?:方式|办法)[：:]\s*/, '') || '';
  const ownerContacts = sectionContacts(ownerSection);
  const agentContacts = sectionContacts(agentSection);
  const projectContacts = sectionContacts(projectSection);
  record['业主联系人'] = ownerContacts.name
    || pairValue(pairs, ['招标方联系人', '招标人联系人', '采购人联系人', '业主联系人']);
  record['业主联系电话'] = ownerContacts.phone
    || pairValue(pairs, ['招标方联系电话', '招标人联系电话', '采购人联系电话', '业主联系电话']);
  record['代理机构联系人'] = agentContacts.name || projectContacts.name
    || pairValue(pairs, ['代理机构联系人', '招标代理联系人', '采购代理联系人']);
  record['代理机构联系电话'] = agentContacts.phone || projectContacts.phone
    || pairValue(pairs, ['代理机构联系电话', '招标代理联系电话', '采购代理联系电话']);
  record['中标单位联系人'] = contactValue(winnerSection, ['项目联系人', '联 系 人', '联系人'])
    || pairValue(pairs, ['中标单位联系人', '中标供应商联系人', '成交供应商联系人']);
  record['中标单位联系电话 '] = contactValue(winnerSection, ['联系电话', '联系方式', '电话', '电 话'])
    || pairValue(pairs, ['中标单位联系电话', '中标供应商联系电话', '成交供应商联系电话']);
  return record;
}

function pageNumber() {
  const selected = document.querySelector('#listPage .layui-laypage-curr em:last-child, .page .active, .pagination .active, .pager .active, a.cur, span.cur');
  return Number(text(selected)) || Number(new URL(location.href).searchParams.get('page')) || 1;
}

function totalPageNumber() {
  const countText = text(document.querySelector('#listPage .layui-laypage-count, .pagination-total, .page-total, .pager-total'));
  const countMatch = countText.match(/(?:共|总计)\s*(\d+)\s*页/);
  if (countMatch) return Number(countMatch[1]);
  const pageLinks = [...document.querySelectorAll('#listPage a, .pagination a, .pager a')]
    .map((element) => Number(text(element))).filter((value) => Number.isInteger(value) && value > 0);
  return pageLinks.length ? Math.max(...pageLinks) : 0;
}

function nextPageButton() {
  return document.querySelector('#listPage .layui-laypage-next:not(.layui-disabled), #listPage a.layui-laypage-next:not(.layui-disabled)');
}

function informationTypesForState(state = {}) {
  const configured = Array.isArray(state.informationTypes)
    ? state.informationTypes.filter((value, index, values) => INFORMATION_TYPES.includes(value) && values.indexOf(value) === index) : [];
  return configured.length ? configured : INFORMATION_TYPE_SEQUENCE;
}

function currentInformationType(state = {}) {
  const types = informationTypesForState(state);
  const index = Math.min(types.length - 1, Math.max(0, Number(state.typeFilterIndex) || 0));
  return types[index];
}

function filterOptionText(element) {
  return text(element).replace(/\s*[（(]\s*\d+\s*[）)]\s*$/, '').trim();
}

function domDistance(left, right) {
  if (!left || !right) return 1000;
  const ancestors = new Map();
  let node = left;
  let distance = 0;
  while (node) {
    ancestors.set(node, distance);
    node = node.parentElement;
    distance += 1;
  }
  node = right;
  distance = 0;
  while (node) {
    if (ancestors.has(node)) return ancestors.get(node) + distance;
    node = node.parentElement;
    distance += 1;
  }
  return 1000;
}

function informationTypeControl(target) {
  const exact = [...document.querySelectorAll('#jq_intro_type li > a')]
    .find((element) => filterOptionText(element) === target);
  if (exact?.offsetParent !== null) return exact;
  const periodControl = document.querySelector('#jq_dvTime');
  const candidates = [...document.querySelectorAll('a, button, label, [role="button"]')]
    .filter((element) => element.offsetParent !== null)
    .filter((element) => filterOptionText(element) === target)
    .filter((element) => !element.closest('.ssjg-list_body'));
  return candidates.sort((left, right) => {
    const score = (element) => {
      const group = element.closest('ul, ol, [class*="filter"], [class*="search"], nav, section, div');
      const groupText = text(group);
      let value = -domDistance(element, periodControl) * 10;
      if (groupText.includes('招标公告') && groupText.includes('中标结果')) value += 80;
      if (/filter|search|type|leixing|xinxi/i.test(`${group?.className || ''} ${group?.id || ''}`)) value += 30;
      if (element.matches('a, button')) value += 10;
      return value;
    };
    return score(right) - score(left);
  })[0] || null;
}

function informationTypeControlActive(control) {
  let node = control;
  for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
    const className = String(node.className || '');
    if (/(^|[\s_-])(active|current|cur|on|selected|checked)(?=$|[\s_-])/i.test(className)) return true;
    if (node.getAttribute?.('aria-selected') === 'true' || node.getAttribute?.('aria-pressed') === 'true') return true;
    if (node.matches?.('input:checked')) return true;
  }
  return false;
}

function informationTypeApplied(target, control) {
  return filterOptionText(control) === target && informationTypeControlActive(control);
}

function noResultsVisible() {
  return /暂无(?:相关)?数据|暂无(?:相关)?信息|没有找到(?:相关)?结果|未搜索到(?:相关)?信息/.test(document.body?.innerText || '');
}

function officialAdvancedFilterOptions() {
  return Object.fromEntries(ADVANCED_FILTER_FIELDS.map((field) => [field.key,
    [...document.querySelectorAll(field.selector)].map((element) => ({
      text: clean(element.textContent),
      value: field.valueAttribute ? String(element.getAttribute(field.valueAttribute) || '') : String(element.value || '')
    })).filter((option, index, options) => option.text && options.findIndex((item) => item.text === option.text) === index)
  ]));
}

async function publishOfficialAdvancedFilterOptions() {
  const discovered = officialAdvancedFilterOptions();
  if (!ADVANCED_FILTER_FIELDS.every(({ key }) => discovered[key].length)) return false;
  const { officialAdvancedFilterOptions: stored = {} } = await chrome.storage.local.get('officialAdvancedFilterOptions');
  if (JSON.stringify(stored) !== JSON.stringify(discovered)) {
    await chrome.storage.local.set({ officialAdvancedFilterOptions: discovered });
  }
  return true;
}

function normalizedTaskWords(words = []) {
  return [...new Set((Array.isArray(words) ? words : []).map(clean).filter(Boolean))].slice(0, 5);
}

function advancedFilterUrl(state, options) {
  const target = new URL(location.href);
  for (const field of ADVANCED_FILTER_FIELDS) {
    const selected = clean(state.advancedFilters?.[field.key] || '全部') || '全部';
    if (selected === '全部') {
      target.searchParams.delete(field.param);
      continue;
    }
    const match = options[field.key]?.find((option) => option.text === selected);
    if (!match) throw new Error(`官网“${field.label}”中未找到“${selected}”，请刷新结果页后重试。`);
    target.searchParams.set(field.param, match.value);
  }
  const wordParams = [
    ['excode', normalizedTaskWords(state.excludeWords)],
    ['kwordtagh', normalizedTaskWords(state.relatedWords)]
  ];
  for (const [param, words] of wordParams) {
    if (words.length) target.searchParams.set(param, words.join(','));
    else target.searchParams.delete(param);
  }
  target.searchParams.delete('page');
  return target;
}

function advancedFiltersApplied(target) {
  const current = new URL(location.href);
  return ADVANCED_FILTER_FIELDS.every(({ param }) => current.searchParams.get(param) === target.searchParams.get(param))
    && current.searchParams.get('excode') === target.searchParams.get('excode')
    && current.searchParams.get('kwordtagh') === target.searchParams.get('kwordtagh');
}

async function ensureAdvancedFilters() {
  let state = await taskState();
  const hasSettings = state.advancedFilters && typeof state.advancedFilters === 'object'
    || Array.isArray(state.excludeWords) || Array.isArray(state.relatedWords);
  if (!hasSettings) return true;

  const startedAt = Date.now();
  let options = officialAdvancedFilterOptions();
  while (!ADVANCED_FILTER_FIELDS.every(({ key }) => options[key].length) && Date.now() - startedAt < RESULT_LOAD_TIMEOUT) {
    await sleep(250);
    options = officialAdvancedFilterOptions();
  }
  if (!ADVANCED_FILTER_FIELDS.every(({ key }) => options[key].length)) {
    throw new Error('高级筛选加载超时，未能读取官网采购方式、资金来源、评标办法或资质证书选项。');
  }
  await publishOfficialAdvancedFilterOptions();

  const target = advancedFilterUrl(state, options);
  if (!advancedFiltersApplied(target)) {
    const active = ADVANCED_FILTER_FIELDS.map((field) => state.advancedFilters?.[field.key] || '全部')
      .filter((value) => value !== '全部');
    await saveTask({
      status: 'filtering', filterStage: 'advanced', advancedFiltersApplied: false,
      completedPages: [], currentPage: 1, awaitingSignature: '', listUrl: target.href, error: ''
    });
    addLog('info', '应用高级筛选', `${active.join('、') || '四项全部'}；排除词 ${normalizedTaskWords(state.excludeWords).length}/5；相关词 ${normalizedTaskWords(state.relatedWords).length}/5`);
    location.assign(target.href);
    return false;
  }

  let signature = '';
  let stableSince = 0;
  let emptySince = 0;
  const resultsStartedAt = Date.now();
  while (Date.now() - resultsStartedAt < RESULT_LOAD_TIMEOUT) {
    if (verificationVisible()) {
      await waitAndReloadAfterVerification();
      return false;
    }
    state = await taskState();
    if (['paused', 'stopped', 'verification_wait'].includes(state.status)) return false;
    const entries = listEntries();
    const currentSignature = resultSignature(entries);
    if (currentSignature) {
      if (currentSignature === signature) {
        if (Date.now() - stableSince >= RESULT_STABLE_FOR) {
          await saveTask({ advancedFiltersApplied: true, filterStage: '' });
          if (!state.advancedFiltersApplied) addLog('success', '高级筛选已生效', `当前页 ${entries.length} 条`);
          return true;
        }
      } else {
        signature = currentSignature;
        stableSince = Date.now();
      }
      emptySince = 0;
    } else if (noResultsVisible()) {
      emptySince ||= Date.now();
      if (Date.now() - emptySince >= RESULT_STABLE_FOR) {
        await saveTask({ advancedFiltersApplied: true, filterStage: '' });
        if (!state.advancedFiltersApplied) addLog('info', '高级筛选已生效', '当前筛选无结果');
        return true;
      }
    } else {
      signature = '';
      stableSince = 0;
      emptySince = 0;
    }
    await sleep(250);
  }
  throw new Error('高级筛选加载超时，未检测到稳定的搜索结果。');
}

async function ensureInformationType(target) {
  const startedAt = Date.now();
  let control = informationTypeControl(target);
  while (!control && Date.now() - startedAt < RESULT_LOAD_TIMEOUT) {
    await sleep(250);
    control = informationTypeControl(target);
  }
  if (!control) throw new Error(`未找到“${target}”信息类型筛选项，请确认搜索结果页面已完整加载。`);

  let state;
  let entries;
  const active = informationTypeApplied(target, control);

  await saveTask({
    status: 'filtering', filterStage: 'type', currentType: target,
    typeFilterApplied: false, typeFilterPending: target, awaitingSignature: '', error: ''
  });
  if (!active) {
    addLog('info', '应用信息类型筛选', target);
    control.click();
  }

  let signature = '';
  let stableSince = 0;
  let noResultsSince = 0;
  const filterStartedAt = Date.now();
  while (Date.now() - filterStartedAt < RESULT_LOAD_TIMEOUT) {
    if (verificationVisible()) {
      await waitAndReloadAfterVerification();
      return null;
    }
    state = await taskState();
    if (['paused', 'stopped', 'verification_wait'].includes(state.status)) return null;
    control = informationTypeControl(target) || control;
    entries = listEntries();
    const currentSignature = resultSignature(entries);
    if (informationTypeApplied(target, control) && currentSignature) {
      if (currentSignature === signature) {
        if (Date.now() - stableSince >= RESULT_STABLE_FOR) {
          await saveTask({ typeFilterApplied: true, typeFilterPending: '', filterStage: '' });
          addLog('success', '信息类型筛选已生效', `${target}，当前页 ${entries.length} 条`);
          return true;
        }
      } else {
        signature = currentSignature;
        stableSince = Date.now();
      }
      noResultsSince = 0;
    } else if (informationTypeApplied(target, control) && noResultsVisible()) {
      noResultsSince ||= Date.now();
      if (Date.now() - noResultsSince >= RESULT_STABLE_FOR) {
        await saveTask({ typeFilterApplied: true, typeFilterPending: '', filterStage: '' });
        addLog('info', '信息类型筛选无结果', target);
        return false;
      }
    } else {
      signature = '';
      stableSince = 0;
      noResultsSince = 0;
    }
    await sleep(250);
  }
  throw new Error(`“${target}”信息类型筛选未生效，请重试。`);
}

async function finishInformationType(state, completedPages = [], noData = false) {
  const types = informationTypesForState(state);
  const currentIndex = Math.min(types.length - 1, Math.max(0, Number(state.typeFilterIndex) || 0));
  const currentType = types[currentIndex];
  const completedTypes = [...new Set([...(state.completedTypes || []), currentType])];
  addLog('success', `${currentType}阶段完成`, noData ? '该筛选没有结果' : `累计采集 ${state.records?.length || 0} 条`);
  if (currentIndex < types.length - 1) {
    const nextType = types[currentIndex + 1];
    await saveTask({
      status: 'filtering', filterStage: 'type', completedPages: [], completedTypes,
      typeFilterIndex: currentIndex + 1, currentType: nextType,
      typeFilterApplied: false, typeFilterPending: '', currentPage: 1, totalPages: 0,
      currentPageCount: 0, batchTotal: 0, batchDone: 0, batchFailed: 0,
      awaitingSignature: '', partialRecords: [], error: ''
    });
    addLog('info', '切换下一信息类型', `${currentType} → ${nextType}`);
    return true;
  }
  await saveTask({ status: 'complete', filterStage: '', completedPages, completedTypes, error: '', endedAt: new Date().toISOString(), pausedAt: '' });
  addLog('success', '全部信息类型采集完成', `${types.join('、')}；共 ${state.records?.length || 0} 条`);
  chrome.runtime.sendMessage({ type: 'TASK_COMPLETE' }).catch(() => undefined);
  return false;
}

function customTimeApplied(start, end) {
  const params = new URL(location.href).searchParams;
  return params.get('time') === '5'
    && params.get('stime') === start
    && params.get('endtime') === end
    && document.querySelector('#txtStartTime')?.value === start
    && document.querySelector('#txtEndTime')?.value === end;
}

async function ensureTimeRange() {
  let state = await taskState();
  const start = state.timeRangeStart;
  const end = state.timeRangeEnd;
  const timeLabel = state.timeFilterMode === 'custom' ? '自定义时间' : '上个月整月';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end || '')) {
    throw new Error(`${timeLabel}的起止日期无效，请重新开始任务。`);
  }

  const startedAt = Date.now();
  let signature = '';
  let stableSince = 0;
  let emptySince = 0;
  while (Date.now() - startedAt < RESULT_LOAD_TIMEOUT) {
    if (verificationVisible()) {
      await waitAndReloadAfterVerification();
      return false;
    }
    state = await taskState();
    if (['paused', 'stopped', 'verification_wait'].includes(state.status)) return false;
    const startInput = document.querySelector('#txtStartTime');
    const endInput = document.querySelector('#txtEndTime');
    if (startInput && endInput && !customTimeApplied(start, end)) {
      const target = new URL(location.href);
      target.searchParams.set('time', '5');
      target.searchParams.set('stime', start);
      target.searchParams.set('endtime', end);
      target.searchParams.delete('dtrange');
      target.searchParams.delete('page');
      await saveTask({
        status: 'filtering', filterStage: 'time', timeFilterApplied: false,
        completedPages: [], currentPage: 1, awaitingSignature: '', listUrl: target.href, error: ''
      });
      addLog('info', '应用检索时间', `${timeLabel} ${start} 至 ${end}`);
      location.assign(target.href);
      return false;
    }
    if (customTimeApplied(start, end)) {
      const entries = listEntries();
      const currentSignature = resultSignature(entries);
      if (currentSignature) {
        if (currentSignature === signature) {
          if (Date.now() - stableSince >= RESULT_STABLE_FOR) {
            await saveTask({ timeFilterApplied: true, filterStage: '' });
            if (!state.timeFilterApplied) addLog('success', '检索时间已生效', `${timeLabel} ${start} 至 ${end}，当前页 ${entries.length} 条`);
            return true;
          }
        } else {
          signature = currentSignature;
          stableSince = Date.now();
        }
        emptySince = 0;
      } else if (noResultsVisible()) {
        emptySince ||= Date.now();
        if (Date.now() - emptySince >= RESULT_STABLE_FOR) {
          await saveTask({ timeFilterApplied: true, filterStage: '' });
          if (!state.timeFilterApplied) addLog('info', '检索时间已生效', `${timeLabel} ${start} 至 ${end}，当前范围无结果`);
          return true;
        }
      } else {
        signature = '';
        stableSince = 0;
        emptySince = 0;
      }
    }
    await sleep(250);
  }
  throw new Error(`${timeLabel}筛选加载超时：${start} 至 ${end}。`);
}

function isSearchResultsLocation() {
  return location.hostname === 'search.bidcenter.com.cn' && location.pathname.startsWith('/search');
}

function isVerificationLocation() {
  return location.hostname === 'shuju.bidcenter.com.cn'
    && /HumanMachineVerification|403\.shtml/i.test(location.pathname);
}

function verificationVisible() {
  const body = document.body?.innerText || '';
  return isVerificationLocation()
    || /人机验证|安全验证|请完成验证|滑动验证|访问在一定时间内过于频繁|访问过于频繁/.test(body);
}

async function waitAndReloadAfterVerification() {
  const body = document.body?.innerText || '';
  const riskType = /访问在一定时间内过于频繁|访问过于频繁|403\.shtml/i.test(`${location.pathname} ${body}`)
    ? 'frequency' : 'verification';
  await chrome.runtime.sendMessage({ type: 'HUMAN_VERIFICATION', url: location.href, riskType });
}

function samePage(url) {
  try {
    const left = new URL(url);
    const right = new URL(location.href);
    return left.pathname === right.pathname && left.search === right.search;
  } catch (_) { return true; }
}

async function processResults() {
  if (taskRunning || !isSearchResultsLocation()) return;
  taskRunning = true;
  let continueNextPage = false;
  try {
    let state = await taskState();
    if (!['searching', 'filtering', 'running'].includes(state.status)) return;
    const timeReady = await ensureTimeRange();
    state = await taskState();
    if (!['searching', 'filtering', 'running'].includes(state.status)) return;
    if (!timeReady) return;
    const advancedReady = await ensureAdvancedFilters();
    state = await taskState();
    if (!['searching', 'filtering', 'running'].includes(state.status)) return;
    if (!advancedReady) return;
    const targetType = currentInformationType(state);
    const typeHasResults = await ensureInformationType(targetType);
    state = await taskState();
    if (!['searching', 'filtering', 'running'].includes(state.status)) return;
    if (typeHasResults === null) return;
    if (!typeHasResults) {
      continueNextPage = await finishInformationType(state, state.completedPages || [], true);
      return;
    }
    const entries = await waitForStableResults({
      differentFrom: state.awaitingSignature || '',
      expectedPage: state.awaitingSignature ? state.currentPage : 0
    });
    if (!entries.length) {
      if (verificationVisible()) {
        await waitAndReloadAfterVerification();
        return;
      }
      const error = '搜索结果加载超时，未检测到可采集的详情链接。';
      await saveTask({ status: 'error', error, pausedAt: state.pausedAt || new Date().toISOString() });
      addLog('error', '结果页加载失败', error);
      return;
    }
    const currentUrl = location.href;
    const currentPage = pageNumber();
    const pageEntries = entries;
    await saveTask({ status: 'running', currentType: targetType, currentPage, totalPages: totalPageNumber(), currentPageCount: pageEntries.length, listUrl: currentUrl, error: '' });
    const existing = state.records || [];
    const pendingEntries = pageEntries.filter((entry) => !existing.some((record) =>
      record.网址 === entry.url || (infoIdFromUrl(entry.url) && record.信息id === infoIdFromUrl(entry.url))));
    if (pendingEntries.length) {
      const response = await chrome.runtime.sendMessage({
        type: 'BATCH_DETAILS',
        entries: pendingEntries.map((entry) => ({ url: entry.url, title: entry.summary.信息标题, summary: entry.summary }))
      });
      if (response?.loginRequired) {
        addLog('warn', '会员登录已失效，当前断点已保存', response.error || '请重新登录后继续。');
        return;
      }
      if (response?.error || !response?.results) throw new Error(response?.error || '整页详情采集没有返回结果。');
      state = await taskState();
      if (state.status === 'stopped') return;
      const byUrl = new Map(response.results.map((result) => [result.url, result]));
      const processedEntries = pendingEntries.filter((entry) => byUrl.has(entry.url));
      const pageRecords = processedEntries.map((entry) => {
        const result = byUrl.get(entry.url);
        const record = result.record ? { ...result.record } : {
          '信息id': infoIdFromUrl(entry.url),
          '信息标题': entry.summary.信息标题,
          '网址': entry.url,
          '采集状态': '失败',
          '失败原因': result.error || '详情采集失败。',
          '详情页正文全文': '',
          '结构化字段证据': ''
        };
        const authoritativeFields = new Set(['信息标题', '信息类型', '省份', '中标时间', '截止时间', '发布日期']);
        for (const [field, value] of Object.entries(entry.summary)) {
          if (value && (!record[field] || authoritativeFields.has(field))) record[field] = value;
        }
        if (!/中标|成交/.test(record.信息类型 || '')) {
          record['中标单位'] = '';
          record['中标金额'] = '';
          record['中标单位联系人'] = '';
          record['中标单位联系电话 '] = '';
        }
        return record;
      });
      const records = [...existing, ...pageRecords];
      const preservedStatus = ['paused', 'daily_limit'].includes(state.status) ? state.status : 'running';
      const keepBatchProgress = preservedStatus !== 'running';
      await saveTask({
        status: preservedStatus,
        records,
        partialRecords: [],
        lastTitle: pageRecords.at(-1)?.信息标题 || '',
        batchTotal: keepBatchProgress ? state.batchTotal : 0,
        batchDone: keepBatchProgress ? state.batchDone : 0,
        batchFailed: keepBatchProgress ? state.batchFailed : pageRecords.filter((record) => record.采集状态 === '失败').length
      });
      for (const [index, record] of pageRecords.entries()) {
        if (record.采集状态 === '失败') {
          addLog('error', `第 ${existing.length + index + 1} 条采集失败`, `${record.信息标题}；${record.失败原因}`);
          continue;
        }
        const missing = DIAGNOSTIC_FIELDS.filter((field) => !record[field]);
        addLog('success', `已保存第 ${existing.length + index + 1} 条，重点字段 ${DIAGNOSTIC_FIELDS.length - missing.length}/${DIAGNOSTIC_FIELDS.length}`,
          `${record.信息标题}${missing.length ? `；缺失：${missing.join('、')}` : ''}`);
      }
    }
    state = await taskState();
    if (state.status !== 'running') return;
    const completedPages = [...new Set([...(state.completedPages || []), currentPage])];
    const next = nextPageButton();
    if (!next) {
      continueNextPage = await finishInformationType(state, completedPages);
      return;
    }
    await saveTask({ completedPages, currentPage: currentPage + 1, listUrl: location.href, awaitingSignature: resultSignature(pageEntries), error: '' });
    next.click();
    continueNextPage = true;
  } catch (error) {
    const state = await taskState();
    if (['stopped', 'paused', 'daily_limit'].includes(state.status)) return;
    const message = error.message || '页面采集发生未知错误。';
    const errorDetails = {
      time: new Date().toISOString(), message, stack: error.stack || '',
      url: location.href, context: `结果页处理；关键词=${state.keyword || ''}`, source: 'content'
    };
    if (isProgrammingError(error)) {
      await chrome.runtime.sendMessage({ type: 'REPORT_SYSTEM_ERROR', details: errorDetails }).catch(() => undefined);
    }
    await saveTask({ status: 'error', error: message, errorDetails, pausedAt: state.pausedAt || new Date().toISOString() });
    addLog('error', '采集停止', `${message}；${location.href}`);
  } finally {
    taskRunning = false;
    if (continueNextPage) setTimeout(() => processResults(), 0);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'RESUME_TASK') {
    (async () => {
      const state = await taskState();
      if (!state.listUrl && !isResultPage()) throw new Error('没有可继续的任务，请回到已保存的搜索结果页。');
      await saveTask({ status: 'running', error: '' });
      if (state.listUrl && !samePage(state.listUrl)) location.assign(state.listUrl);
      else processResults();
    })().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === 'SCRAPE_DETAIL') {
    waitForDetailReady().then((ready) => {
      sendResponse(ready ? { ready: true, record: scrapeDetail() } : { ready: false });
    });
    return true;
  }
  return undefined;
});

(async () => {
  if (verificationVisible()) {
    await waitAndReloadAfterVerification();
    return;
  }
  if (/#\/des\/customDesSearch\/\d+/i.test(location.hash)) {
    const ready = await waitForDetailReady(170000);
    if (ready) await chrome.runtime.sendMessage({ type: 'DETAIL_PAGE_READY', record: scrapeDetail() });
    else await chrome.runtime.sendMessage({ type: 'DETAIL_PAGE_FAILED', error: '详情页未出现标题和公告正文。' });
    return;
  }
  const state = await taskState();
  if (isSearchResultsLocation() && state.status === 'verification_wait') {
    const now = Date.now();
    const pausedAt = Date.parse(state.pausedAt || state.updatedAt || '');
    const totalPausedMs = Math.max(0, Number(state.totalPausedMs) || 0)
      + (Number.isFinite(pausedAt) ? Math.max(0, now - pausedAt) : 0);
    await saveTask({ status: 'running', verificationUntil: 0, error: '', pausedAt: '', totalPausedMs });
    addLog('info', '验证等待结束，结果页已恢复');
  }
  const latestState = await taskState();
  if (isSearchResultsLocation()) await publishOfficialAdvancedFilterOptions();
  if (isSearchResultsLocation() && ['searching', 'filtering', 'running'].includes(latestState.status)) processResults();
})();
