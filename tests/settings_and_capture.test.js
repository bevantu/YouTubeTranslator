const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');

function loadStorage(initialSettings = {}) {
  const state = { settings: initialSettings };
  const chrome = {
    storage: {
      sync: {
        get(key, callback) {
          callback({ settings: state.settings });
        },
        set(value, callback) {
          state.settings = value.settings;
          callback?.();
        }
      },
      local: {
        get(key, callback) { callback({}); },
        set(value, callback) { callback?.(); }
      }
    }
  };
  const context = vm.createContext({ chrome, console });
  const source = readFileSync(join(root, 'lib/storage.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__storage = StorageHelper;`, context);
  return { storage: context.__storage, state };
}

test('settings migration produces one valid display mode and safe visual values', () => {
  const { storage } = loadStorage();
  const migrated = storage.normalizeSettings({
    proficiencyLevel: 'intermediate',
    showOriginalSubtitle: false,
    showTranslatedSubtitle: true,
    fontSize: 99,
    subtitleBackgroundOpacity: -2,
    knownWordColor: 'not-a-color'
  });

  assert.equal(migrated.proficiencyLevel, 'middle');
  assert.equal(migrated.subtitleDisplayMode, 'translated');
  assert.equal(migrated.showOriginalSubtitle, false);
  assert.equal(migrated.showTranslatedSubtitle, true);
  assert.equal(migrated.fontSize, 32);
  assert.equal(migrated.subtitleBackgroundOpacity, 0);
  assert.equal(migrated.knownWordColor, storage.DEFAULT_SETTINGS.knownWordColor);
});

test('partial settings saves preserve unrelated preferences', async () => {
  const { storage, state } = loadStorage({
    enabled: true,
    targetLanguage: 'ja',
    nativeLanguage: 'zh',
    subtitleDisplayMode: 'original',
    fontSize: 16
  });

  const saved = await storage.saveSettings({ fontSize: 22 });
  assert.equal(saved.targetLanguage, 'ja');
  assert.equal(saved.subtitleDisplayMode, 'original');
  assert.equal(saved.fontSize, 22);
  assert.equal(state.settings.showTranslatedSubtitle, false);
});

class MiniTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return true;
  }
}

class MiniCustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
}

class FakeXMLHttpRequest extends MiniTarget {
  open(method, url) {
    this.opened = { method, url };
  }
}

test('timedtext captured before content startup can be replayed without changing responses', async () => {
  const payload = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello world' }] }] });
  const calls = [];
  const window = new MiniTarget();
  window.location = {
    origin: 'https://www.youtube.com',
    href: 'https://www.youtube.com/watch?v=video-1'
  };
  const originalResponse = {
    marker: 'original-response',
    clone() {
      return { text: async () => payload };
    }
  };
  window.fetch = async (...args) => {
    calls.push(args);
    return originalResponse;
  };

  const context = vm.createContext({
    window,
    URL,
    Map,
    Date,
    CustomEvent: MiniCustomEvent,
    XMLHttpRequest: FakeXMLHttpRequest,
    Request: class Request {},
    console
  });
  vm.runInContext(readFileSync(join(root, 'content/inject.js'), 'utf8'), context);

  const received = [];
  window.addEventListener('__yb_timedtext__', event => received.push(event.detail));
  const response = await window.fetch('https://www.youtube.com/api/timedtext?v=video-1&lang=en');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(response, originalResponse);
  assert.equal(calls.length, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].replay, false);

  window.dispatchEvent(new MiniCustomEvent('__yb_timedtext_request__', {
    detail: { videoId: 'video-1' }
  }));
  assert.equal(received.length, 2);
  assert.equal(received[1].replay, true);
  assert.equal(received[1].text, payload);

  const xhr = new FakeXMLHttpRequest();
  xhr.open('GET', 'https://www.youtube.com/api/timedtext?v=video-1&lang=ja');
  xhr.responseText = payload;
  xhr.dispatchEvent(new MiniCustomEvent('load'));
  assert.equal(received.length, 3);
  assert.match(received[2].url, /lang=ja/);

  const before = received.length;
  assert.equal(await window.fetch('https://www.youtube.com/youtubei/v1/player'), originalResponse);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.length, before);
});

test('Shorts replay is scoped to the video that made the request', async () => {
  const payload = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 900, segs: [{ utf8: 'short caption' }] }] });
  const window = new MiniTarget();
  window.location = {
    origin: 'https://www.youtube.com',
    href: 'https://www.youtube.com/shorts/short-one'
  };
  window.fetch = async () => ({ clone: () => ({ text: async () => payload }) });
  const context = vm.createContext({
    window, URL, Map, Date, CustomEvent: MiniCustomEvent,
    XMLHttpRequest: FakeXMLHttpRequest, Request: class Request {}, console
  });
  vm.runInContext(readFileSync(join(root, 'content/inject.js'), 'utf8'), context);

  const received = [];
  window.addEventListener('__yb_timedtext__', event => received.push(event.detail));
  await window.fetch('https://www.youtube.com/api/timedtext?lang=en');
  window.location.href = 'https://www.youtube.com/shorts/short-two';
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(received[0].videoId, 'short-one');
  window.dispatchEvent(new MiniCustomEvent('__yb_timedtext_request__', { detail: { videoId: 'short-two' } }));
  assert.equal(received.length, 1);
  window.dispatchEvent(new MiniCustomEvent('__yb_timedtext_request__', { detail: { videoId: 'short-one' } }));
  assert.equal(received.length, 2);
  assert.equal(received[1].replay, true);
});
