'use strict';

// Offline tests for the message builder (no network, no service account).
// Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMessage, normalizeTopic, normalizeData } = require('../src/index');

test('normalizeTopic strips /topics/ and validates', () => {
  assert.equal(normalizeTopic('news'), 'news');
  assert.equal(normalizeTopic('  /topics/news_1.a~b%c-d '), 'news_1.a~b%c-d');
  assert.throws(() => normalizeTopic(''), /required/);
  assert.throws(() => normalizeTopic('bad topic'), /Invalid topic/);
  assert.throws(() => normalizeTopic('a/b'), /Invalid topic/);
});

test('normalizeData stringifies values and rejects reserved keys', () => {
  assert.deepEqual(normalizeData({ a: 1, b: true, c: { x: 1 }, d: null, e: 's' }), {
    a: '1', b: 'true', c: '{"x":1}', d: '', e: 's',
  });
  assert.equal(normalizeData({}), undefined);
  assert.equal(normalizeData(undefined), undefined);
  for (const k of ['from', 'notification', 'message_type', 'google.x', 'gcm.y']) {
    assert.throws(() => normalizeData({ [k]: 'v' }), /reserved/);
  }
  assert.throws(() => normalizeData(['a']), /object/);
});

test('notification to a topic: title + body with default sound', () => {
  assert.deepEqual(buildMessage({ topic: '/topics/news', title: 'Hi', body: 'Hello' }), {
    topic: 'news',
    notification: { title: 'Hi', body: 'Hello' },
    android: { notification: { sound: 'default' } },
    apns: { payload: { aps: { sound: 'default' } } },
  });
});

test('notification with image + data covers Android, iOS and web', () => {
  const img = 'https://example.com/a.png';
  const m = buildMessage({ topic: 'news', title: 'T', image: img, data: { id: 42 } });
  assert.equal(m.notification.image, img); // Android + web
  assert.equal(m.apns.fcm_options.image, img); // iOS
  assert.equal(m.apns.payload.aps['mutable-content'], 1);
  assert.deepEqual(m.data, { id: '42' });
});

test('extra options: channel, click action, normal priority, no sound', () => {
  const m = buildMessage({
    token: 'dev', body: 'B', sound: 'none', channelId: 'promo',
    clickAction: 'FLUTTER_NOTIFICATION_CLICK', priority: 'normal',
  });
  assert.equal(m.token, 'dev');
  assert.deepEqual(m.android, {
    priority: 'normal',
    notification: { channel_id: 'promo', click_action: 'FLUTTER_NOTIFICATION_CLICK' },
  });
  assert.deepEqual(m.apns, {
    headers: { 'apns-priority': '5' },
    payload: { aps: { category: 'FLUTTER_NOTIFICATION_CLICK' } },
  });
});

test('data-only message is silent and high priority', () => {
  assert.deepEqual(buildMessage({ topic: 'news', dataOnly: true, data: { type: 'sync' } }), {
    topic: 'news',
    data: { type: 'sync' },
    android: { priority: 'high' },
    apns: {
      headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
      payload: { aps: { 'content-available': 1 } },
    },
  });
});

test('invalid input is rejected with a clear error', () => {
  assert.throws(() => buildMessage({ title: 'x' }), /exactly one target/);
  assert.throws(() => buildMessage({ topic: 'a', token: 'b', title: 'x' }), /exactly one target/);
  assert.throws(() => buildMessage({ topic: 'a' }), /title or a body/);
  assert.throws(() => buildMessage({ topic: 'a', dataOnly: true }), /at least one data/);
  assert.throws(() => buildMessage({ topic: 'a', dataOnly: true, data: { k: 'v' }, title: 't' }), /cannot have/);
  assert.throws(() => buildMessage({ topic: 'a', title: 't', image: 'ftp://x' }), /http\(s\) URL/);
  assert.throws(() => buildMessage({ topic: 'a', title: 't', priority: 'urgent' }), /priority/);
});
