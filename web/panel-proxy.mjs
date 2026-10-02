import { accountKey, assignProxies, parseProxies } from './panel-logic.mjs';

export function setupProxyManager({ getConfig, loadAccounts, managementFetch, saveConfig, setBusy }) {
  const ui = Object.fromEntries(['proxy-dialog', 'open-proxy', 'close-proxy', 'proxy-controls', 'proxy-list', 'credential-list', 'proxy-select-all', 'credential-select-all', 'credential-search', 'proxy-selection', 'proxies', 'save-proxies', 'increment-proxies', 'apply-proxies', 'clear-selected-proxies', 'clear-proxies', 'proxy-message'].map((id) => [id, document.getElementById(id)]));
  let proxies = [];
  let accounts = [];
  let busy = false;
  let initialized = false;
  const selectedProxies = new Set();
  const selectedAccounts = new Set();

  function updateSelection() {
    for (const [id, selected, total] of [['proxy-select-all', selectedProxies.size, proxies.length], ['credential-select-all', selectedAccounts.size, accounts.filter((a) => !a.runtime_only).length]]) {
      ui[id].checked = total > 0 && selected === total;
      ui[id].indeterminate = selected > 0 && selected < total;
      ui[id].disabled = total === 0;
    }
    ui['proxy-selection'].textContent = `已选 ${selectedProxies.size} / ${proxies.length} 个代理 · ${selectedAccounts.size} / ${accounts.length} 个凭证`;
    ui['apply-proxies'].disabled = ui['increment-proxies'].disabled = !selectedProxies.size || !selectedAccounts.size;
    ui['clear-selected-proxies'].disabled = !selectedAccounts.size;
    ui['clear-proxies'].disabled = !accounts.length;
  }

  function choice(text, detail, key, selected, disabled = false) {
    const label = document.createElement('label');
    label.className = 'choice';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(key);
    checkbox.disabled = disabled;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(key);
      else selected.delete(key);
      updateSelection();
    });
    const content = document.createElement('span');
    content.className = 'choice-text';
    const name = document.createElement('span');
    name.className = 'choice-name';
    name.textContent = text;
    name.title = text;
    content.append(name);
    if (detail) {
      const status = document.createElement('span');
      status.className = 'choice-detail';
      status.textContent = detail;
      content.append(status);
    }
    label.append(checkbox, content);
    return label;
  }

  function renderProxies() {
    ui['proxy-list'].replaceChildren(...proxies.map((proxy, index) => choice(proxy, '', index, selectedProxies)));
    if (!proxies.length) ui['proxy-list'].textContent = '暂无代理，请展开下方编辑区添加并保存。';
    updateSelection();
  }

  function renderAccounts() {
    const search = ui['credential-search'].value.trim().toLowerCase();
    const matches = accounts.filter((account) => String(account.name).toLowerCase().includes(search));
    ui['credential-list'].replaceChildren(...matches.map((account) => choice(account.name,
      account.runtime_only ? '运行时凭证，无法保存代理' : `${account.disabled ? '已停用' : '已启用'} · 优先级 ${account.priority ?? 0}`,
      accountKey(account), selectedAccounts, Boolean(account.runtime_only))));
    if (!matches.length) ui['credential-list'].textContent = '没有匹配的凭证';
    updateSelection();
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    ui['proxy-controls'].disabled = true;
    ui['close-proxy'].disabled = true;
    setBusy(true);
    ui['proxy-message'].textContent = '';
    try { await action(); }
    catch (error) { ui['proxy-message'].textContent = error.message; }
    finally {
      busy = false;
      ui['proxy-controls'].disabled = false;
      ui['close-proxy'].disabled = false;
      setBusy(false);
      updateSelection();
    }
  }

  function showProgress(progress) {
    ui['proxy-message'].textContent = `已处理 ${progress.processed} / ${progress.total}，成功 ${progress.succeeded}，跳过 ${progress.skipped}，失败 ${progress.failed}`;
  }

  function showResult(result) {
    ui['proxy-message'].textContent = `完成：成功 ${result.succeeded}，跳过 ${result.skipped}，失败 ${result.failures.length}`
      + result.failures.map((failure) => `\n${failure.name}：${failure.error}`).join('');
  }

  const patchProxy = (fields) => managementFetch('/auth-files/fields', { method: 'PATCH', body: JSON.stringify(fields) });

  async function resolveTargets(all) {
    const latest = await loadAccounts();
    if (all) return latest;
    const targets = latest.filter((account) => selectedAccounts.has(accountKey(account)));
    if (targets.length !== selectedAccounts.size) throw new Error('选中的凭证列表已变化，请重新打开代理管理后选择');
    return targets;
  }

  async function apply(mode) {
    if (!selectedProxies.size || !selectedAccounts.size) throw new Error('请选择代理和凭证');
    const chosenProxies = proxies.filter((_, index) => selectedProxies.has(index));
    const targets = await resolveTargets(false);
    showResult(await assignProxies(targets, chosenProxies, patchProxy, showProgress,
      mode === 'incremental' ? async (account) => {
        const credential = await managementFetch(`/auth-files/download?name=${encodeURIComponent(account.name)}`);
        return credential.proxy_url;
      } : undefined));
  }

  ui['open-proxy'].addEventListener('click', () => {
    ui['proxy-dialog'].showModal();
    run(async () => {
      ui['proxy-message'].textContent = '正在读取凭证列表…';
      accounts = await loadAccounts();
      const keys = new Set(accounts.filter((a) => !a.runtime_only).map(accountKey));
      for (const key of selectedAccounts) if (!keys.has(key)) selectedAccounts.delete(key);
      if (!initialized) {
        const text = getConfig().proxy_list ?? '';
        proxies = text.trim() ? parseProxies(text) : [];
        ui.proxies.value = text;
        initialized = true;
      }
      renderProxies();
      renderAccounts();
      ui['proxy-message'].textContent = '';
    });
  });
  ui['close-proxy'].addEventListener('click', () => ui['proxy-dialog'].close());
  ui['proxy-dialog'].addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  ui['credential-search'].addEventListener('input', renderAccounts);
  ui['proxy-select-all'].addEventListener('change', () => {
    selectedProxies.clear();
    if (ui['proxy-select-all'].checked) proxies.forEach((_, index) => selectedProxies.add(index));
    renderProxies();
  });
  ui['credential-select-all'].addEventListener('change', () => {
    selectedAccounts.clear();
    if (ui['credential-select-all'].checked) accounts.filter((a) => !a.runtime_only).forEach((account) => selectedAccounts.add(accountKey(account)));
    renderAccounts();
  });
  ui['save-proxies'].addEventListener('click', () => run(async () => {
    const text = ui.proxies.value.trim();
    const updated = text ? parseProxies(text) : [];
    await saveConfig({ proxy_list: text });
    proxies = updated;
    selectedProxies.clear();
    renderProxies();
    ui['proxy-message'].textContent = '代理列表已保存，请勾选要分配的代理';
  }));
  ui['apply-proxies'].addEventListener('click', () => run(() => apply('overwrite')));
  ui['increment-proxies'].addEventListener('click', () => run(() => apply('incremental')));
  for (const [id, all] of [['clear-selected-proxies', false], ['clear-proxies', true]]) {
    ui[id].addEventListener('click', () => run(async () => {
      const targets = await resolveTargets(all);
      if (!targets.length) throw new Error('请选择要清空代理的凭证');
      if (!confirm(`清空${all ? '全部' : '所选'} ${targets.length} 个 Antigravity 凭证的独立代理？\n${all ? '不受当前勾选或搜索影响。' : ''}代理列表会保留。`)) return;
      showResult(await assignProxies(targets, [''], patchProxy, showProgress));
    }));
  }
}
