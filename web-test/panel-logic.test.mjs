import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_USER_AGENT, QUOTA_URLS, accountKey, assignProxies, buildRefreshRequest, buildStatusToggleRequest, fetchQuotaGroups, parseProxies, parseQuota, parseSubscription, parseUpstream, pruneSnapshots, selectAccounts, resetLabel, validateUserAgent, visibleQuotaGroups } from '../web/panel-logic.mjs';

test('accounts sort by descending priority, then by name, with missing priority treated as zero', () => {
  const files = [{ name: 'a', priority: 1 }, { name: 'z', priority: 10 }, { name: 'c', priority: '10' }, { name: 'd' }, { name: 'e', priority: -1 }].map((file) => ({ ...file, provider: 'antigravity' }));
  assert.deepEqual(selectAccounts({ files }).map((a) => a.name), ['c', 'z', 'a', 'd', 'e']);
});

test('refresh sends native frontend UA or saved custom UA and unwraps nested payloads', () => {
  const account = { auth_index: 'a', project_id: 'project-a' };
  for (const kind of ['quota', 'subscription']) {
    assert.equal(buildRefreshRequest(account, kind).header['User-Agent'], DEFAULT_USER_AGENT);
    assert.equal(buildRefreshRequest(account, kind, 'custom-agent/1.0').header['User-Agent'], 'custom-agent/1.0');
  }
  const tier = { paidTier: { id: 'g1-ultra-tier' } };
  assert.equal(parseSubscription(parseUpstream({ status_code: 200, body: JSON.stringify({ body: JSON.stringify(tier) }) })).label, 'Ultra');
  assert.deepEqual(parseUpstream({ status_code: 200, body: { body: { groups: [] } } }), { groups: [] });
  assert.throws(() => validateUserAgent('bad\r\nheader'), /英文字符/);
  assert.throws(() => validateUserAgent(''), /填写/);
});

test('quota follows native endpoint order and reports failed attempts before success', async () => {
  const requests = [];
  const result = await fetchQuotaGroups({ auth_index: 'a', project_id: 'project-a' }, 'custom-agent/1.0', async (request) => {
    requests.push(request);
    if (requests.length < 3) return { status_code: 403, body: '{}' };
    return { status_code: 200, body: { groups: [{ displayName: 'Gemini models', buckets: [{ remainingFraction: 0.98 }] }] } };
  });
  assert.deepEqual(requests.map((r) => r.url), QUOTA_URLS);
  assert.ok(requests.every((r) => r.header['User-Agent'] === 'custom-agent/1.0'));
  assert.equal(result.groups[0].buckets[0].remaining, 98);
  assert.match(result.notice, /HTTP 403/);
  assert.match(result.notice, /切换接口后查询成功/);
  await assert.rejects(fetchQuotaGroups({ auth_index: 'a', project_id: 'project-a' }, DEFAULT_USER_AGENT, async () => ({ status_code: 403 })), /cloudcode-pa.googleapis.com.*HTTP 403/);
});

test('cache cleanup removes deleted credentials and retains disabled credentials', () => {
  const enabled = { name: 'a.json', auth_index: 'a', provider: 'antigravity' };
  const disabled = { name: 'b.json', auth_index: 'b', provider: 'antigravity', disabled: true };
  const removed = { name: 'c.json', auth_index: 'c' };
  const saved = { subscription: { label: 'Ultra' }, groups: [] };
  const snapshots = new Map([enabled, disabled, removed].map((account) => [accountKey(account), saved]));
  assert.equal(pruneSnapshots(snapshots, selectAccounts({ files: [enabled, disabled] })), true);
  assert.deepEqual([...snapshots.keys()], [accountKey(enabled), accountKey(disabled)]);
  assert.equal(snapshots.get(accountKey(disabled)), saved);
  assert.equal(pruneSnapshots(snapshots, [enabled, disabled]), false);
  assert.equal(pruneSnapshots(snapshots, []), true);
  assert.equal(snapshots.size, 0);
});

test('invalid credential lists fail before cache cleanup', () => {
  const snapshots = new Map([['saved-key', { subscription: { label: 'Ultra' } }]]);
  assert.throws(() => pruneSnapshots(snapshots, selectAccounts({})), /列表格式无效/);
  assert.equal(snapshots.size, 1);
});

test('Claude/GPT groups are hidden by default and restored without losing cached quota', () => {
  const groups = [{ label: 'Gemini models' }, { label: 'Claude and GPT models' }, { label: 'Claude 和 GPT 模型' }];
  assert.deepEqual(visibleQuotaGroups(groups), [groups[0]]);
  assert.equal(visibleQuotaGroups(groups, true), groups);
  assert.equal(groups.length, 3);
});

test('credential status toggle targets the named credential and its auth index', () => {
  assert.deepEqual(buildStatusToggleRequest({ name: 'a.json', auth_index: 'a' }), { name: 'a.json', auth_index: 'a', disabled: true });
  assert.equal(buildStatusToggleRequest({ name: 'a.json', auth_index: 'a', disabled: true }).disabled, false);
  assert.throws(() => buildStatusToggleRequest({ name: 'a.json' }), /auth_index/);
});

test('Antigravity accounts include disabled credentials and sort by name', () => {
  const accounts = selectAccounts({ files: [{ name: 'z', type: 'antigravity', disabled: true }, { name: 'c', type: 'codex' }, { name: 'a', provider: 'Antigravity' }] });
  assert.deepEqual(accounts.map((a) => a.name), ['a', 'z']);
  assert.notEqual(accountKey({ name: 'a', auth_index: '1' }), accountKey({ name: 'a', auth_index: '2' }));
});

test('paid tier takes priority; downgrade to free updates the plan', () => {
  assert.equal(parseSubscription({ currentTier: { id: 'free-tier' }, paidTier: { id: 'g1-ultra-tier' } }).label, 'Ultra');
  assert.equal(parseSubscription({ currentTier: { id: 'free-tier' } }).label, 'Free');
  assert.equal(parseSubscription({ paid_tier: { id: 'g1-ultra-lite-tier' } }).label, 'Ultra Lite');
  assert.equal(parseSubscription({ currentTier: { id: 'new-tier', name: 'New plan' } }).label, 'New plan');
  assert.throws(() => parseSubscription({}), /缺少/);
});

test('quota parses grouped five-hour and weekly windows without inventing remaining quota', () => {
  const groups = parseQuota({ groups: [{ displayName: 'Gemini', buckets: [{ displayName: 'Weekly', window: 'weekly', remainingFraction: '0.76' }, { displayName: 'Five Hour', window: '5h', remainingFraction: 0.99, resetTime: '2026-10-02T12:00:00Z' }] }] });
  assert.deepEqual(groups[0].buckets.map((b) => b.remaining), [99, 76]);
  assert.equal(groups[0].buckets[0].resetTime, '2026-10-02T12:00:00Z');
  assert.deepEqual(parseQuota({ groups: [] }), []);
  for (const remainingFraction of [null, '', true, -0.1, 1.1]) assert.throws(() => parseQuota({ groups: [{ buckets: [{ remainingFraction }] }] }), /无效/);
  assert.match(resetLabel('2026-10-02T12:00:00Z', Date.parse('2026-10-02T12:01:00Z')), /需刷新/);
});

test('refresh uses CPA token substitution and the credential project', () => {
  const account = { auth_index: '123', project_id: 'project-a' };
  const request = buildRefreshRequest(account, 'quota');
  assert.equal(request.auth_index, '123');
  assert.equal(request.header.Authorization, 'Bearer $TOKEN$');
  assert.deepEqual(JSON.parse(request.data), { project: 'project-a' });
  assert.match(request.url, /retrieveUserQuotaSummary$/);
  assert.deepEqual(JSON.parse(buildRefreshRequest(account, 'subscription').data), { metadata: { ideType: 'ANTIGRAVITY' } });
  assert.throws(() => buildRefreshRequest({ auth_index: '123' }, 'quota'), /project_id/);
  assert.throws(() => parseUpstream({ status_code: 403, body: 'secret' }), /HTTP 403/);
  assert.deepEqual(parseUpstream({ status_code: 200, body: '{"groups":[]}' }), { groups: [] });
});

test('proxy validation supports auth, IPv6 and SOCKS and rejects invalid addresses', () => {
  const proxies = ['http://user:pass@host:80', 'https://host:443', 'socks5://[::1]:1080', 'socks5h://host:1080'];
  assert.deepEqual(parseProxies(`\n${proxies.join('\r\n')}\n`), proxies);
  for (const proxy of ['ftp://host', 'http://host/path', 'http://host?x=1', 'http://host#', 'http://host:0', 'socks5://host:65536', 'socks5://host:abc', 'http://ho st', '']) assert.throws(() => parseProxies(proxy));
});

test('batch proxy assignment cycles successful writes; failures remain explicit', async () => {
  const accounts = [{ name: 'd', provider: 'antigravity', disabled: true, priority: 10 }, { name: 'a', provider: 'antigravity' }, { name: 'c', provider: 'antigravity', runtime_only: true }, { name: 'b', provider: 'antigravity' }, { name: 'codex', provider: 'codex' }];
  const writes = [];
  const result = await assignProxies(accounts, ['http://p1', 'http://p2'], async (fields) => {
    if (fields.name === 'b') throw new Error('write failed');
    writes.push(fields);
  });
  assert.deepEqual(writes, [{ name: 'a', proxy_url: 'http://p1' }, { name: 'd', proxy_url: 'http://p2' }]);
  assert.equal(result.succeeded, 2);
  assert.deepEqual(result.failures.map((f) => f.name), ['b', 'c']);
});

test('incremental assignment preserves existing proxies and skips unreadable credentials', async () => {
  const accounts = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, provider: 'antigravity' }));
  const writes = [];
  const result = await assignProxies(accounts, ['http://p1', 'http://p2'], async (fields) => writes.push(fields), undefined, async (account) => {
    if (account.name === 'b') throw new Error('credential read failed');
    return { a: 'socks5://existing:1080', c: '', d: undefined, e: 'http://existing' }[account.name];
  });
  assert.deepEqual(writes, [{ name: 'c', proxy_url: 'http://p1' }, { name: 'd', proxy_url: 'http://p2' }]);
  assert.equal(result.skipped, 2);
  assert.equal(result.succeeded, 2);
  assert.deepEqual(result.failures, [{ name: 'b', error: 'credential read failed' }]);
});

test('selected credentials receive one proxy directly or multiple proxies in order', async () => {
  const selected = ['c.json', 'a.json', 'd.json'].map((name) => ({ name, provider: 'antigravity' }));
  for (const proxies of [['http://p2'], ['http://p1', 'http://p3']]) {
    const writes = [];
    await assignProxies(selected, proxies, async (fields) => writes.push(fields));
    assert.deepEqual(writes, ['a.json', 'c.json', 'd.json'].map((name, index) => ({ name, proxy_url: proxies[index % proxies.length] })));
  }
});

test('clearing proxies writes an empty override only to the supplied credentials', async () => {
  const writes = [];
  const result = await assignProxies([{ name: 'selected.json', provider: 'antigravity', disabled: true }], [''], async (fields) => writes.push(fields));
  assert.deepEqual(writes, [{ name: 'selected.json', proxy_url: '' }]);
  assert.equal(result.succeeded, 1);
});
