const upstreamBase = 'https://daily-cloudcode-pa.googleapis.com/v1internal:';
export const DEFAULT_USER_AGENT = 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)';
export const QUOTA_URLS = [
  upstreamBase + 'retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
];

export function selectAccounts(payload) {
  if (!Array.isArray(payload?.files)) throw new Error('CPA 凭证列表格式无效');
  return payload.files
    .filter((file) => String(file.provider || file.type).toLowerCase() === 'antigravity')
    .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0) || String(a.name).localeCompare(String(b.name), 'en'));
}

export function accountKey(account) {
  return JSON.stringify([String(account.auth_index ?? ''), String(account.name ?? '')]);
}

export function pruneSnapshots(snapshots, accounts) {
  const keys = new Set(accounts.map(accountKey));
  let changed = false;
  for (const key of snapshots.keys()) {
    if (!keys.has(key)) {
      snapshots.delete(key);
      changed = true;
    }
  }
  return changed;
}

export function buildStatusToggleRequest(account) {
  if (!String(account.name ?? '').trim()) throw new Error('凭证缺少文件名');
  if (!String(account.auth_index ?? '').trim()) throw new Error('凭证缺少 auth_index');
  return { name: account.name, auth_index: String(account.auth_index), disabled: !Boolean(account.disabled) };
}

export function visibleQuotaGroups(groups, showClaudeGPT = false) {
  return showClaudeGPT ? groups : groups.filter((group) => !/claude|gpt/i.test(group.label));
}

export function parseSubscription(payload) {
  const paid = payload?.paidTier ?? payload?.paid_tier;
  const tier = paid?.id ? paid : payload?.currentTier ?? payload?.current_tier;
  if (!tier || (!tier.id && !tier.name)) throw new Error('套餐响应缺少套餐信息');
  const labels = { 'free-tier': 'Free', 'g1-pro-tier': 'Pro', 'g1-ultra-tier': 'Ultra', 'g1-ultra-lite-tier': 'Ultra Lite' };
  return { id: String(tier.id ?? ''), label: labels[tier.id] || String(tier.name || tier.id) };
}

export function parseQuota(payload) {
  if (!Array.isArray(payload?.groups)) throw new Error('额度响应缺少分组数据');
  return payload.groups.map((group, index) => ({
    label: String(group.displayName ?? group.display_name ?? `分组 ${index + 1}`),
    description: String(group.description ?? ''),
    buckets: (Array.isArray(group.buckets) ? group.buckets : []).map((bucket) => {
      const raw = bucket.remainingFraction ?? bucket.remaining_fraction;
      const fraction = (typeof raw === 'number' || (typeof raw === 'string' && raw.trim())) ? Number(raw) : NaN;
      if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) throw new Error('额度响应包含无效剩余比例');
      return {
        label: String(bucket.displayName ?? bucket.display_name ?? bucket.bucketId ?? bucket.bucket_id ?? bucket.window ?? '额度'),
        window: String(bucket.window ?? ''),
        remaining: fraction * 100,
        resetTime: String(bucket.resetTime ?? bucket.reset_time ?? ''),
      };
    }).sort((a, b) => windowOrder(a.window) - windowOrder(b.window)),
  }));
}

function windowOrder(window) {
  return ['5h', 'five-hour', 'five_hour'].includes(window) ? 0 : ['weekly', 'week'].includes(window) ? 1 : 2;
}

export function buildRefreshRequest(account, kind, userAgent = DEFAULT_USER_AGENT, url) {
  if (!String(account.auth_index ?? '').trim()) throw new Error('凭证缺少 auth_index');
  if (kind === 'quota' && !String(account.project_id ?? '').trim()) throw new Error('凭证缺少 project_id，无法查询额度');
  return {
    auth_index: String(account.auth_index), method: 'POST',
    url: url ?? upstreamBase + (kind === 'quota' ? 'retrieveUserQuotaSummary' : 'loadCodeAssist'),
    header: { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'User-Agent': userAgent },
    data: JSON.stringify(kind === 'quota' ? { project: account.project_id } : { metadata: { ideType: 'ANTIGRAVITY' } }),
  };
}

export function parseUpstream(response) {
  if (!Number.isInteger(response?.status_code) || response.status_code < 200 || response.status_code >= 300) {
    // 上游原始响应可能含有凭证或代理信息，只展示状态。
    throw new Error(`上游请求失败：HTTP ${response?.status_code ?? '未知'}`);
  }
  let payload = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
  if (payload?.body !== undefined) payload = typeof payload.body === 'string' ? JSON.parse(payload.body) : payload.body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('上游响应格式无效');
  return payload;
}

export async function fetchQuotaGroups(account, userAgent, sendRequest) {
  const failures = [];
  // 与原生前端使用相同地址顺序，切换接口的原因会显示在页面中。
  for (const url of QUOTA_URLS) {
    try {
      const response = await sendRequest(buildRefreshRequest(account, 'quota', userAgent, url));
      const groups = parseQuota(parseUpstream(response));
      if (!groups.some((group) => group.buckets.length)) throw new Error('上游暂无可用额度分组');
      return { groups, notice: failures.length ? `${failures.join('；')}；切换接口后查询成功` : '' };
    } catch (error) { failures.push(`${new URL(url).hostname}：${error.message}`); }
  }
  throw new Error(failures.join('；'));
}

export function validateUserAgent(value) {
  if (!value.trim()) throw new Error('请填写 User-Agent');
  if (/[^\x20-\x7e]/.test(value)) throw new Error('User-Agent 只能包含可打印的英文字符');
}

export function parseProxies(text) {
  const proxies = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const proxy = line.trim();
    if (!proxy) continue;
    try {
      const url = new URL(proxy);
      if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) throw new Error('协议须为 http、https、socks5 或 socks5h');
      if (!url.hostname || /\s/.test(proxy)) throw new Error('地址缺少主机或包含空白');
      if (!/^\w+:\/\//.test(proxy) || !['', '/'].includes(url.pathname) || url.search || url.hash || /[?#]/.test(proxy)) throw new Error('地址不能包含路径、查询参数或片段');
      // URL 对非标准协议不校验端口范围。
      if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) throw new Error('端口须在 1–65535 之间');
    } catch (error) {
      throw new Error(`第 ${index + 1} 行：${error.message === 'Invalid URL' ? '代理地址无效' : error.message}`);
    }
    proxies.push(proxy);
  }
  if (!proxies.length) throw new Error('请至少填写一个代理地址，每行一个');
  return proxies;
}

export async function assignProxies(accounts, proxies, patch, onProgress = () => {}) {
  const targets = selectAccounts({ files: accounts }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'en'));
  let succeeded = 0;
  const failures = [];
  for (const [index, account] of targets.entries()) {
    try {
      if (account.runtime_only || !account.name) throw new Error('运行时凭证无法持久化代理');
      await patch({ name: account.name, proxy_url: proxies[succeeded % proxies.length] });
      succeeded += 1;
    } catch (error) {
      failures.push({ name: String(account.name ?? ''), error: error.message });
    }
    onProgress({ processed: index + 1, total: targets.length, succeeded, failed: failures.length });
  }
  return { succeeded, failures };
}

export function formatTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '未知';
}

export function resetLabel(value, now = Date.now()) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.ceil((time - now) / 60_000);
  if (minutes <= 0) return '重置时间已到，需刷新确认';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  return `${days ? `${days} 天 ` : ''}${hours ? `${hours} 小时 ` : ''}${minutes % 60} 分钟后重置`;
}
