'use strict';

// Set these to your Supabase project URL and sb_publishable_ key before deployment.
const rvmSyncConfig = { url: '', publishableKey: '' };

function initializeRvmSync(app, config = rvmSyncConfig) {
  const login = document.querySelector('#syncLogin');
  const status = document.querySelector('#syncStatus');
  const controls = document.querySelector('#syncControls');
  const choices = document.querySelector('#syncChoices');
  const metadataKey = app.key + ':sync-v1';
  const sessionKey = metadataKey + ':session';
  const verseKey = /^(?:[1-9]|1[0-9]|2[0-2]):[1-9][0-9]?$/;
  const enabled = /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(config.url)
    && /^sb_publishable_[\w-]+$/.test(config.publishableKey);
  if (!enabled) {
    status.textContent = '기기 연동을 준비 중이에요. 지금은 아래 메뉴에서 기록을 백업할 수 있어요.';
    return null;
  }

  const read = (storage, key) => {
    try { return JSON.parse(storage.getItem(key)); }
    catch { return null; }
  };
  let session = read(sessionStorage, sessionKey);
  let conflict = null;
  let busy = false;
  let timer;
  let anotherTab = false;
  let sessionNeedsLogin = false;
  const say = message => { status.textContent = message; };

  function showControls() {
    login.hidden = Boolean(session) && !sessionNeedsLogin;
    controls.hidden = !session;
    choices.hidden = !conflict;
  }

  async function request(path, { method = 'GET', data, token } = {}) {
    const headers = { apikey: config.publishableKey };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(config.url + path, {
      method, headers, cache: 'no-store', signal: AbortSignal.timeout(15000),
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    if (!response.ok) {
      const error = new Error('연결 오류');
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  function setSession(result) {
    session = {
      user: result.user.id, access: result.access_token, refresh: result.refresh_token,
      expires: Date.now() + result.expires_in * 1000
    };
    sessionStorage.setItem(sessionKey, JSON.stringify(session));
    sessionNeedsLogin = false;
  }

  async function token() {
    if (session.expires > Date.now() + 60000) return session.access;
    try {
      setSession(await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', data: { refresh_token: session.refresh }
      }));
      return session.access;
    } catch (error) {
      if ([400, 401, 403].includes(error.status)) sessionNeedsLogin = true;
      throw error;
    }
  }

  async function fingerprint(raw) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
  }

  function remember(user, version, hash) {
    localStorage.setItem(metadataKey, JSON.stringify({ user, version, hash }));
  }

  function hasRecords(snapshot) {
    return snapshot.history.length > 0 || Object.keys(snapshot.wrong).length > 0
      || Object.keys(snapshot.mastery).length > 0 || snapshot.studyPlan?.source === 'custom'
      || Object.keys(snapshot.studyPlan?.chaptersByDate || {}).length > 0
      || Object.keys(snapshot.reviewSchedule || {}).length > 0 || app.hasCustomVerses(snapshot);
  }

  function validate(snapshot) {
    const isMap = value => value && typeof value === 'object' && !Array.isArray(value);
    const integer = (value, min, max = Number.MAX_SAFE_INTEGER) =>
      Number.isSafeInteger(value) && value >= min && value <= max;
    const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
    if (!isMap(snapshot) || !Array.isArray(snapshot.history)
      || !isMap(snapshot.verses) || !isMap(snapshot.wrong) || !isMap(snapshot.mastery)
      || !Object.entries(snapshot.verses).every(([key, verse]) => verseKey.test(key) && typeof verse === 'string')
      || !snapshot.history.every(h => h && integer(h.chapter, 1, 22) && integer(h.level, 1, 3)
        && integer(h.score, 0, 100) && date(h.date)
        && (h.correctCount === undefined || integer(h.correctCount, 0))
        && (h.totalCount === undefined || integer(h.totalCount, 0)))
      || !Object.values(snapshot.wrong).every(w => w && verseKey.test(w.key)
        && integer(w.count, 0) && integer(w.chapter, 1, 22) && integer(w.verse, 1, 99)
        && integer(w.level, 0, 3) && (w.parts == null || (Array.isArray(w.parts) && w.parts.every(Boolean))))
      || (snapshot.cardDay && (!integer(snapshot.cardDay.attempts, 0)
        || !Array.isArray(snapshot.cardDay.keys) || !snapshot.cardDay.keys.every(k => verseKey.test(k))
        || !Array.isArray(snapshot.cardDay.done)))) {
      throw new Error('저장된 기록 형식이 달라요. 기존 기록을 먼저 내보내 주세요.');
    }
  }

  function download(snapshot, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function readCloud(access) {
    const rows = await request('/rest/v1/rvm_progress?select=revision,snapshot', { token: access });
    const row = rows[0];
    if (row) validate(row.snapshot);
    return row;
  }

  async function writeCloud(access, revision, snapshot) {
    validate(snapshot);
    return request('/rest/v1/rpc/rvm_save_progress', {
      method: 'POST', token: access, data: { expected_revision: revision, new_snapshot: snapshot }
    });
  }

  function showConflict(row) {
    conflict = row;
    showControls();
    say('두 기기의 기록이 달라요. 백업을 저장하고 사용할 기록을 골라 주세요.');
  }

  async function applyCloud(row, before) {
    const hash = await fingerprint(JSON.stringify(row.snapshot));
    if (anotherTab || app.snapshot() !== before || app.isEditing()) {
      say('작성 중인 답안을 제출하거나 홈으로 돌아가면 기록을 다시 확인해요.');
      return false;
    }
    app.apply(row.snapshot);
    remember(session.user, row.revision, hash);
    app.render();
    return true;
  }

  async function sync(choice) {
    if (!session || sessionNeedsLogin || busy || anotherTab || (conflict && !choice)) return;
    busy = true;
    try {
      const meta = read(localStorage, metadataKey);
      if (meta && meta.user !== session.user) {
        say('이 브라우저는 다른 계정과 연결되어 있어요. 다른 브라우저 프로필에서 로그인해 주세요.');
        return;
      }

      const raw = app.snapshot();
      const snapshot = JSON.parse(raw);
      const hash = await fingerprint(raw);
      const access = await token();
      const row = await readCloud(access);
      if (anotherTab) return;
      const localChanged = meta ? hash !== meta.hash : hasRecords(snapshot);
      const remoteChanged = row && row.revision !== meta?.version;
      if (choice && (!row || row.revision !== conflict.revision)) {
        if (row) showConflict(row);
        else say('서버 기록이 바뀌었어요. 다시 로그인한 뒤 확인해 주세요.');
        return;
      }
      if (!choice && row && ((localChanged && remoteChanged) || (meta && row.revision < meta.version))) {
        showConflict(row);
        return;
      }
      if (choice === 'cloud' || remoteChanged && !localChanged) {
        if (!await applyCloud(row, raw)) return;
      } else if (choice === 'device' || localChanged) {
        const revision = await writeCloud(access, row?.revision ?? 0, snapshot);
        if (revision === null) {
          const updated = await readCloud(access);
          if (updated) showConflict(updated);
          return;
        }
        remember(session.user, revision, hash);
      }
      conflict = null;
      say('기록을 동기화했어요.');
    } catch (error) {
      if (sessionNeedsLogin) say('로그인이 만료됐어요. 다시 로그인하면 저장을 이어가요.');
      else say('동기화를 끝내지 못했어요. 이 기기에 기록은 남아 있어요. 연결을 확인하고 다시 시도해 주세요.');
    } finally {
      busy = false;
      showControls();
    }
  }

  login.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const button = login.querySelector('button');
    button.disabled = true;
    try {
      const fields = new FormData(login);
      const result = await request('/auth/v1/token?grant_type=password', {
        method: 'POST', data: { email: fields.get('email'), password: fields.get('password') }
      });
      const meta = read(localStorage, metadataKey);
      if (meta && result.user.id !== meta.user) {
        say('이 브라우저는 다른 계정과 연결되어 있어요. 다른 브라우저 프로필을 사용해 주세요.');
        return;
      }
      setSession(result);
      login.reset();
      showControls();
    } catch {
      say('로그인할 수 없어요. 이메일, 비밀번호와 인터넷 연결을 확인해 주세요.');
      return;
    } finally {
      busy = false;
      button.disabled = false;
    }
    await sync();
  });
  document.querySelector('#syncNow').onclick = () => sync();
  document.querySelector('#syncLogout').onclick = () => {
    if (busy) return;
    session = null;
    conflict = null;
    sessionNeedsLogin = false;
    sessionStorage.removeItem(sessionKey);
    showControls();
    say('연동을 중지했어요. 이 기기의 기록은 남아 있어요.');
  };
  document.querySelector('#syncKeepCloud').onclick = () => {
    if (busy || !conflict) return;
    download(JSON.parse(app.snapshot()), 'RV-M-기기기록.json');
    sync('cloud');
  };
  document.querySelector('#syncKeepDevice').onclick = () => {
    if (busy || !conflict) return;
    download(conflict.snapshot, 'RV-M-서버기록.json');
    sync('device');
  };
  window.addEventListener('storage', event => {
    if (event.key !== app.key || !session) return;
    anotherTab = true;
    say('다른 탭에서 기록이 바뀌었어요. 한 탭만 남긴 뒤 새로고침해 주세요.');
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sync();
  });
  window.addEventListener('online', () => sync());
  setInterval(() => { if (!document.hidden) sync(); }, 30000);
  showControls();
  if (session) sync();

  return () => {
    clearTimeout(timer);
    timer = setTimeout(sync, 750);
  };
}
