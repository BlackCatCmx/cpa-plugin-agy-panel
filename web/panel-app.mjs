import {
  accountKey, assignProxies, buildRefreshRequest, buildStatusToggleRequest, formatTime,
  parseProxies, parseQuota, parseSubscription, parseUpstream, pruneSnapshots, resetLabel, selectAccounts, visibleQuotaGroups,
} from './panel-logic.mjs';

const pluginID = 'cpa-plugin-agy-panel';
const cacheKey = 'cpa-agy-panel-quota-v1';
const state = { accounts: [], snapshots: new Map(), errors: new Map(), refreshing: new Set(), statusUpdating: new Set(), config: {}, page: 1, polling: false, proxyBusy: false, session: null };
const ui = Object.fromEntries(['summary', 'banner', 'grid', 'pagination', 'proxies', 'proxy-message', 'save-proxies', 'apply-proxies', 'search', 'filter', 'reload', 'theme', 'show-claude-gpt', 'display-message'].map((id) => [id, document.getElementById(id)]));

function readSession() {
  let raw = localStorage.getItem('cli-proxy-auth');
  if (!raw) throw new Error('请先在 CPA 管理页面登录并选择记住管理密钥');
  if (raw.startsWith('enc::v1::')) {
    const encrypted = Uint8Array.from(atob(raw.slice(9)), (char) => char.charCodeAt(0));
    const key = new TextEncoder().encode(`cli-proxy-api-webui::secure-storage|${location.host}|${navigator.userAgent}`);
    raw = new TextDecoder().decode(Uint8Array.from(encrypted, (byte, index) => byte ^ key[index % key.length]));
  }
  const parsed = JSON.parse(raw);
  const session = parsed?.state ?? parsed;
  if (!session?.apiBase || !session?.managementKey) throw new Error('请在 CPA 管理页面启用记住管理密钥');
  const base = new URL(session.apiBase, location.origin);
  if (base.origin !== location.origin) throw new Error('插件页面必须与 CPA 管理接口同源');
  return { base: base.href.replace(/\/+$/, ''), key: session.managementKey };
}

async function managementFetch(path, options = {}, timeout = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${state.session.base}/v0/management${path}`, {
      ...options, signal: controller.signal,
      headers: { Authorization: `Bearer ${state.session.key}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body?.message || body?.error || `HTTP ${response.status}`);
    return body;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时');
    throw error;
  } finally { clearTimeout(timer); }
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(text, action, disabled = false) {
  const element = node('button', '', text);
  element.type = 'button';
  element.disabled = disabled;
  element.addEventListener('click', action);
  return element;
}

function renderCard(account) {
  const key = accountKey(account);
  const saved = state.snapshots.get(key) ?? {};
  const card = node('article', `card${account.disabled ? ' disabled' : ''}`);
  const head = node('div', 'card-head');
  const identity = node('div', 'identity');
  const name = node('div', 'name', account.email || account.label || account.name);
  name.title = name.textContent;
  identity.append(node('span', 'plan' + (saved.subscription && saved.subscription.id !== 'free-tier' ? ' paid' : ''), saved.subscription?.label ?? '未知'), name);
  const actions = node('div', 'head-actions');
  const busy = state.refreshing.has(key) || state.statusUpdating.has(key) || state.proxyBusy;
  const canToggle = account.runtime_only !== true && Boolean(account.name && account.auth_index);
  const status = button(state.statusUpdating.has(key) ? '处理中' : account.disabled ? '已停用' : account.unavailable ? '暂不可用' : '已启用', () => toggleAccountStatus(account), busy || !canToggle);
  status.className = `status-toggle${account.disabled ? ' off' : account.unavailable ? ' unavailable' : ''}`;
  status.title = canToggle ? account.disabled ? '点击启用凭证' : '点击停用凭证' : '此凭证无法切换状态';
  status.setAttribute('aria-label', status.title);
  const refresh = button(state.refreshing.has(key) ? '↻' : '⟳', () => refreshAccount(account), busy || Boolean(account.disabled) || !account.auth_index);
  refresh.className = 'refresh';
  refresh.title = account.disabled ? '已停用凭证不能刷新' : '刷新套餐与额度';
  refresh.setAttribute('aria-label', `刷新 ${name.textContent} 的套餐与额度`);
  actions.append(status, refresh);
  head.append(identity, actions);
  card.append(head);
  const meta = node('div', 'account-meta');
  for (const [label, value] of [['套餐更新', saved.subscriptionAt], ['额度更新', saved.quotaAt]]) {
    if (!value) continue;
    const item = node('span', '', `${label} ${new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}`);
    item.title = formatTime(value);
    meta.append(item);
  }
  if (meta.childElementCount) card.append(meta);
  if (account.status_message) card.append(node('div', 'error', account.status_message));
  if (state.errors.has(key)) card.append(node('div', 'error', state.errors.get(key)));
  const groups = visibleQuotaGroups(saved.groups ?? [], state.config.show_claude_gpt === true);
  if (!groups.length) card.append(node('div', 'empty', saved.quotaAt ? '暂无可显示的额度分组' : '暂无额度，点击刷新获取'));
  for (const group of groups) {
    const section = node('section', 'group');
    section.append(node('h2', '', group.label));
    if (group.description) section.append(node('p', '', group.description));
    for (const bucket of group.buckets) {
      const row = node('div', 'quota-row');
      const top = node('div', 'row-head');
      top.append(node('span', '', bucket.label), node('span', 'remaining', `剩余 ${Math.round(bucket.remaining)}%`));
      const track = node('div', 'track');
      const fill = node('div', 'fill');
      fill.style.width = `${bucket.remaining}%`;
      if (bucket.remaining < 30) fill.style.background = 'var(--red)';
      track.append(fill);
      const reset = node('div', 'reset', resetLabel(bucket.resetTime));
      reset.title = bucket.resetTime ? formatTime(bucket.resetTime) : '';
      row.append(top, reset, track);
      section.append(row);
    }
    card.append(section);
  }
  return card;
}

function render() {
  ui.summary.replaceChildren();
  for (const [label, count] of [['账号', state.accounts.length], ['已缓存套餐', state.accounts.filter((a) => state.snapshots.get(accountKey(a))?.subscription).length], ['已停用', state.accounts.filter((a) => a.disabled).length]]) {
    const item = node('span');
    item.append(node('strong', '', count), document.createTextNode(` ${label}`));
    ui.summary.append(item);
  }
  const search = ui.search.value.trim().toLowerCase();
  const accounts = state.accounts.filter((a) => `${a.name} ${a.email ?? ''} ${a.label ?? ''}`.toLowerCase().includes(search))
    .filter((a) => ui.filter.value === 'all' || (ui.filter.value === 'enabled' && !a.disabled) || (ui.filter.value === 'disabled' && a.disabled) || (ui.filter.value === 'waiting' && !state.snapshots.get(accountKey(a))?.subscription));
  const totalPages = Math.max(1, Math.ceil(accounts.length / 30));
  state.page = Math.min(state.page, totalPages);
  ui.grid.replaceChildren(...accounts.slice((state.page - 1) * 30, state.page * 30).map(renderCard));
  if (!accounts.length) ui.grid.append(node('div', 'empty', state.accounts.length ? '没有匹配账号' : '没有 Antigravity 凭证'));
  ui.pagination.replaceChildren();
  if (totalPages > 1) ui.pagination.append(
    button('上一页', () => { state.page -= 1; render(); }, state.page === 1),
    node('span', 'meta', `${state.page} / ${totalPages}`),
    button('下一页', () => { state.page += 1; render(); }, state.page === totalPages),
  );
}

async function pollAccounts() {
  if (state.polling) return;
  state.polling = true;
  ui.reload.disabled = true;
  try {
    updateAccounts(await managementFetch('/auth-files'));
    ui.banner.textContent = '';
    render();
  } catch (error) { ui.banner.textContent = `更新账号失败：${error.message}`; }
  finally { state.polling = false; ui.reload.disabled = false; }
}

function updateAccounts(payload) {
  state.accounts = selectAccounts(payload);
  if (pruneSnapshots(state.snapshots, state.accounts)) {
    localStorage.setItem(cacheKey, JSON.stringify([...state.snapshots]));
  }
}

async function fetchQuota(account) {
  let project = account.project_id;
  if (!project) {
    const response = await fetch(`${state.session.base}/v0/management/auth-files/download?name=${encodeURIComponent(account.name)}`, { headers: { Authorization: `Bearer ${state.session.key}` } });
    if (!response.ok) throw new Error(`读取凭证项目失败：HTTP ${response.status}`);
    const credential = await response.json();
    project = credential.project_id ?? credential.projectId ?? credential.installed?.project_id ?? credential.web?.project_id;
  }
  return fetchUpstream({ ...account, project_id: project }, 'quota');
}

async function fetchUpstream(account, kind) {
  const request = buildRefreshRequest(account, kind);
  const payload = parseUpstream(await managementFetch('/api-call', { method: 'POST', body: JSON.stringify(request) }, 65_000));
  return kind === 'quota' ? parseQuota(payload) : parseSubscription(payload);
}

async function refreshAccount(account) {
  const key = accountKey(account);
  if (state.refreshing.has(key) || state.statusUpdating.has(key) || state.proxyBusy || account.disabled) return;
  state.refreshing.add(key);
  state.errors.delete(key);
  render();
  const saved = { ...state.snapshots.get(key) };
  const errors = [];
  try {
    const results = await Promise.allSettled([fetchUpstream(account, 'subscription'), fetchQuota(account)]);
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        saved[index === 0 ? 'subscription' : 'groups'] = result.value;
        saved[index === 0 ? 'subscriptionAt' : 'quotaAt'] = new Date().toISOString();
      } else errors.push(`${index === 0 ? '套餐' : '额度'}刷新失败：${result.reason.message}`);
    }
    if (results.some((result) => result.status === 'fulfilled') && state.accounts.some((item) => accountKey(item) === key)) {
      state.snapshots.set(key, saved);
      try { localStorage.setItem(cacheKey, JSON.stringify([...state.snapshots])); }
      catch (error) { errors.push(`本次结果未能持久化：${error.message}`); }
    }
    if (errors.length) state.errors.set(key, errors.join('\n'));
  } finally { state.refreshing.delete(key); render(); }
}

async function toggleAccountStatus(account) {
  const key = accountKey(account);
  if (state.statusUpdating.has(key) || state.refreshing.has(key) || state.proxyBusy) return;
  state.statusUpdating.add(key);
  ui.banner.textContent = '';
  render();
  try {
    const response = await managementFetch('/auth-files/status', { method: 'PATCH', body: JSON.stringify(buildStatusToggleRequest(account)) });
    if (typeof response?.disabled !== 'boolean') throw new Error('CPA 响应缺少凭证状态');
    state.accounts = state.accounts.map((item) => accountKey(item) === key ? { ...item, disabled: response.disabled } : item);
  } catch (error) { ui.banner.textContent = `切换凭证状态失败：${error.message}`; }
  finally { state.statusUpdating.delete(key); render(); }
}

async function saveConfig(fields) {
  await managementFetch(`/plugins/${pluginID}/config`, { method: 'PATCH', body: JSON.stringify(fields) });
  Object.assign(state.config, fields);
}

async function editProxies(apply) {
  if (state.proxyBusy) return;
  state.proxyBusy = true;
  for (const id of ['save-proxies', 'apply-proxies', 'proxies']) ui[id].disabled = true;
  ui['proxy-message'].textContent = '';
  render();
  try {
    const text = ui.proxies.value.trim();
    const proxies = text ? parseProxies(text) : [];
    if (apply && !proxies.length) throw new Error('请至少填写一个代理地址');
    await saveConfig({ proxy_list: text });
    ui['proxy-message'].textContent = '代理列表已保存';
    if (apply) {
      updateAccounts(await managementFetch('/auth-files'));
      const accounts = state.accounts;
      if (!accounts.length) throw new Error('没有 Antigravity 凭证可供分配');
      const result = await assignProxies(accounts, proxies,
        (fields) => managementFetch('/auth-files/fields', { method: 'PATCH', body: JSON.stringify(fields) }),
        (progress) => { ui['proxy-message'].textContent = `已处理 ${progress.processed} / ${progress.total}，成功 ${progress.succeeded}，失败 ${progress.failed}`; },
      );
      ui['proxy-message'].textContent = `完成：成功 ${result.succeeded}，失败 ${result.failures.length}` + result.failures.map((failure) => `\n${failure.name}：${failure.error}`).join('');
    }
  } catch (error) { ui['proxy-message'].textContent = error.message; }
  finally {
    state.proxyBusy = false;
    for (const id of ['save-proxies', 'apply-proxies', 'proxies']) ui[id].disabled = false;
    render();
  }
}

ui['save-proxies'].addEventListener('click', () => editProxies(false));
ui['apply-proxies'].addEventListener('click', () => editProxies(true));
ui['show-claude-gpt'].addEventListener('change', async () => {
  ui['show-claude-gpt'].disabled = true;
  try {
    await saveConfig({ show_claude_gpt: ui['show-claude-gpt'].checked });
    ui['display-message'].textContent = '已保存';
    render();
  } catch (error) {
    ui['show-claude-gpt'].checked = state.config.show_claude_gpt === true;
    ui['display-message'].textContent = `保存失败：${error.message}`;
  } finally { ui['show-claude-gpt'].disabled = false; }
});
ui.reload.addEventListener('click', pollAccounts);
for (const id of ['search', 'filter']) ui[id].addEventListener('input', () => { state.page = 1; render(); });
ui.theme.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('cpa-agy-panel-theme', theme); }
  catch (error) { ui.banner.textContent = `主题保存失败：${error.message}`; }
});

async function initialize() {
  for (const id of ['save-proxies', 'apply-proxies', 'reload', 'show-claude-gpt']) ui[id].disabled = true;
  try {
    document.documentElement.dataset.theme = localStorage.getItem('cpa-agy-panel-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    state.session = readSession();
    const cached = localStorage.getItem(cacheKey);
    if (cached) state.snapshots = new Map(JSON.parse(cached));
    state.config = await managementFetch(`/plugins/${pluginID}/config`);
    ui.proxies.value = state.config.proxy_list ?? '';
    ui['show-claude-gpt'].checked = state.config.show_claude_gpt === true;
    for (const id of ['save-proxies', 'apply-proxies', 'reload', 'show-claude-gpt']) ui[id].disabled = false;
    await pollAccounts();
    setInterval(() => { if (!document.hidden) pollAccounts(); }, 30_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollAccounts(); });
  } catch (error) {
    ui.banner.textContent = error.message;
    ui.grid.replaceChildren(node('div', 'empty', '无法加载面板'));
  }
}

initialize();
