import test from 'node:test';
import assert from 'node:assert/strict';
import { accountKey, assignProxies, buildRefreshRequest, buildStatusToggleRequest, parseProxies, parseQuota, parseSubscription, parseUpstream, pruneSnapshots, selectAccounts, resetLabel, visibleQuotaGroups } from '../web/panel-logic.mjs';

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
  const accounts = [{ name: 'd', provider: 'antigravity', disabled: true }, { name: 'a', provider: 'antigravity' }, { name: 'c', provider: 'antigravity', runtime_only: true }, { name: 'b', provider: 'antigravity' }, { name: 'codex', provider: 'codex' }];
  const writes = [];
  const result = await assignProxies(accounts, ['http://p1', 'http://p2'], async (fields) => {
    if (fields.name === 'b') throw new Error('write failed');
    writes.push(fields);
  });
  assert.deepEqual(writes, [{ name: 'a', proxy_url: 'http://p1' }, { name: 'd', proxy_url: 'http://p2' }]);
  assert.equal(result.succeeded, 2);
  assert.deepEqual(result.failures.map((f) => f.name), ['b', 'c']);
});
