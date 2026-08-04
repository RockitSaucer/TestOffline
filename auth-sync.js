/* REG SLAYER 5.2 Beta — Auth + personal/shared map cloud sync (local-first).
   Loaded inline into index.html. Performance rules:
   - Always write localStorage first
   - Debounced cloud push (idle when possible)
   - No push while offlineMode or navigator.onLine === false
   - No aggressive polling; shared pull only when tab visible
*/
(function () {
  'use strict';

  var SB_URL = 'https://grvhmktqzrivbqbczkii.supabase.co';
  var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdydmhta3RxenJpdmJxYmN6a2lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3MDQ0MTIsImV4cCI6MjEwMTI4MDQxMn0.fFfrS-7w45IzxwOvvyYDB5ngLnyTz-Ru7XVL5LZXm4o';

  var EMAIL_DOMAIN = 'users.regslayer.local';
  var VIEW_KEY = 'reg_slayer_view_v1';
  var OFFLINE_KEY = 'reg_slayer_offline_mode_v1';
  var CACHE_KEY = 'reg_slayer_map_cache_v1';
  var DIRTY_KEY = 'reg_slayer_map_dirty_v1';
  var MAX_CACHE_BYTES = 1800000; // ~1.8MB prune threshold

  var sb = null;
  var sessionUser = null;
  var profile = null;
  var viewState = { mode: 'private', privateMapId: null, privateMapName: 'My Map', sharedMapId: null, sharedMapName: '', sharedMapCode: '' };
  var offlineMode = false;
  var cloudBusy = false;
  var dirty = false;
  var pushTimer = null;
  var pullTimer = null;
  var lastPullAt = 0;
  var localRevision = 0;
  var pendingSignupCodes = null;
  var authReadyResolve = null;
  var authReady = new Promise(function (r) { authReadyResolve = r; });

  function $(id) { return document.getElementById(id); }

  function normalizeUsername(u) {
    return String(u || '').trim().toLowerCase().replace(/\s+/g, '');
  }

  function syntheticEmail(username) {
    return normalizeUsername(username) + '@' + EMAIL_DOMAIN;
  }

  function isOnline() {
    if (offlineMode) return false;
    try { if (navigator.onLine === false) return false; } catch (e) {}
    return true;
  }

  function loadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  function loadViewState() {
    var v = loadJson(VIEW_KEY, null);
    if (v && (v.mode === 'personal' || v.mode === 'private' || v.mode === 'shared')) {
      viewState = Object.assign({
        mode: 'private', privateMapId: null, privateMapName: 'My Map',
        sharedMapId: null, sharedMapName: '', sharedMapCode: ''
      }, v);
      if (viewState.mode === 'personal') viewState.mode = 'private';
    }
  }

  function persistViewState() {
    saveJson(VIEW_KEY, viewState);
  }

  function loadOfflineMode() {
    try { offlineMode = localStorage.getItem(OFFLINE_KEY) === '1'; } catch (e) { offlineMode = false; }
  }

  function setOfflineMode(on) {
    offlineMode = !!on;
    try { localStorage.setItem(OFFLINE_KEY, offlineMode ? '1' : '0'); } catch (e) {}
    updateAuthChrome();
    if (!offlineMode && isDirty()) scheduleCloudPush(true);
  }

  function isDirty() {
    if (dirty) return true;
    try { return localStorage.getItem(DIRTY_KEY) === '1'; } catch (e) { return false; }
  }

  function restoreDirtyFlag() {
    try { dirty = localStorage.getItem(DIRTY_KEY) === '1'; } catch (e) { dirty = false; }
  }

  // ---- Map state pack/unpack (mirrors existing localStorage keys) ----
  var MAP_KEYS = {
    pins: 'alabama_hunt_custom_pins',
    hunts: 'alabama_hunt_historical_hunts',
    customAreas: 'alabama_hunt_custom_areas_v1',
    measuredPaths: 'alabama_hunt_measured_paths_v1',
    stands: 'alabama_hunt_user_stands_v1',
    hiddenLocs: 'alabama_hunt_hidden_locations_v1'
  };

  function collectMapState() {
    var state = {
      pins: loadJson(MAP_KEYS.pins, []),
      hunts: loadJson(MAP_KEYS.hunts, []),
      customAreas: loadJson(MAP_KEYS.customAreas, []),
      measuredPaths: loadJson(MAP_KEYS.measuredPaths, []),
      stands: loadJson(MAP_KEYS.stands, {}),
      hiddenLocs: loadJson(MAP_KEYS.hiddenLocs, []),
      meta: { savedAt: new Date().toISOString(), revision: localRevision || 0 }
    };
    return state;
  }

  function applyMapState(state) {
    if (!state || typeof state !== 'object') state = {};
    saveJson(MAP_KEYS.pins, Array.isArray(state.pins) ? state.pins : []);
    saveJson(MAP_KEYS.hunts, Array.isArray(state.hunts) ? state.hunts : []);
    saveJson(MAP_KEYS.customAreas, Array.isArray(state.customAreas) ? state.customAreas : []);
    saveJson(MAP_KEYS.measuredPaths, Array.isArray(state.measuredPaths) ? state.measuredPaths : []);
    saveJson(MAP_KEYS.stands, state.stands && typeof state.stands === 'object' ? state.stands : {});
    saveJson(MAP_KEYS.hiddenLocs, Array.isArray(state.hiddenLocs) ? state.hiddenLocs : []);
    localRevision = (state.meta && state.meta.revision) || 0;
  }

  function cacheSlotKey() {
    if (viewState.mode === 'shared' && viewState.sharedMapId) return 'shared:' + viewState.sharedMapId;
    if (viewState.privateMapId) return 'private:' + viewState.privateMapId;
    return 'personal';
  }

  function writeLocalCache(state) {
    var cache = loadJson(CACHE_KEY, {});
    cache[cacheSlotKey()] = {
      state: state,
      savedAt: Date.now(),
      name: viewState.mode === 'shared' ? viewState.sharedMapName : 'My Map',
      code: viewState.sharedMapCode || null
    };
    // Prune if too large
    try {
      var raw = JSON.stringify(cache);
      if (raw.length > MAX_CACHE_BYTES) {
        var entries = Object.keys(cache).map(function (k) {
          return { k: k, t: (cache[k] && cache[k].savedAt) || 0 };
        }).sort(function (a, b) { return a.t - b.t; });
        var active = cacheSlotKey();
        while (entries.length > 2 && JSON.stringify(cache).length > MAX_CACHE_BYTES * 0.75) {
          var drop = entries.shift();
          if (drop.k !== active && drop.k !== 'personal') delete cache[drop.k];
          else break;
        }
      }
    } catch (e) {}
    saveJson(CACHE_KEY, cache);
  }

  function readLocalCache(slot) {
    var cache = loadJson(CACHE_KEY, {});
    return cache[slot] || null;
  }

  function markDirty() {
    dirty = true;
    try { localStorage.setItem(DIRTY_KEY, '1'); } catch (e) {}
    // Always refresh local cache immediately (offline-safe)
    try {
      var st = collectMapState();
      writeLocalCache(st);
    } catch (e2) {}
    // Fast path: upload soon after edit/delete (still idle-friendly)
    scheduleCloudPush(false);
  }

  function scheduleCloudPush(immediate) {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    var delay = immediate ? 50 : 700;
    pushTimer = setTimeout(function () {
      pushTimer = null;
      runWhenIdle(function () { pushMapToCloud(); });
    }, delay);
  }

  // Public hook used after any map feature save
  window.regSlayerMapDataChanged = function () {
    try { markDirty(); } catch (e) {}
  };

  function runWhenIdle(fn) {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(function () { try { fn(); } catch (e) { console.warn(e); } }, { timeout: 2500 });
    } else {
      setTimeout(function () { try { fn(); } catch (e) { console.warn(e); } }, 0);
    }
  }

  async function pushMapToCloud() {
    if (!sb || !sessionUser || cloudBusy) return;
    if (!isOnline()) return;
    if (!isDirty()) return;
    cloudBusy = true;
    updateSyncBadge('syncing');
    try {
      // Local is authority when dirty — full replace (no merge).
      // Merge-by-id was resurrecting deleted pins/areas on push/refresh.
      var state = collectMapState();
      writeLocalCache(state);
      if (!state.meta) state.meta = {};
      state.meta.savedAt = new Date().toISOString();
      state.meta.savedBy = sessionUser.id;

      if (viewState.mode === 'shared' && viewState.sharedMapId) {
        var { data: cur, error: rErr } = await sb
          .from('shared_maps')
          .select('map_revision')
          .eq('id', viewState.sharedMapId)
          .maybeSingle();
        if (rErr) throw rErr;
        var remoteRev = (cur && cur.map_revision) || 0;
        var nextRev = remoteRev + 1;
        state.meta.revision = nextRev;
        var { error: uErr } = await sb
          .from('shared_maps')
          .update({ map_state: state, map_revision: nextRev })
          .eq('id', viewState.sharedMapId);
        if (uErr) throw uErr;
        localRevision = nextRev;
      } else if (viewState.privateMapId) {
        var { data: pm, error: pmErr } = await sb
          .from('private_maps')
          .select('map_revision')
          .eq('id', viewState.privateMapId)
          .maybeSingle();
        if (pmErr) throw pmErr;
        var prev = ((pm && pm.map_revision) || 0) + 1;
        state.meta.revision = prev;
        var { error: pUp } = await sb
          .from('private_maps')
          .update({
            map_state: state,
            map_revision: prev,
            updated_at: new Date().toISOString()
          })
          .eq('id', viewState.privateMapId);
        if (pUp) throw pUp;
        localRevision = prev;
      } else {
        var { data: um, error: umErr } = await sb
          .from('user_map_state')
          .select('map_revision')
          .eq('user_id', sessionUser.id)
          .maybeSingle();
        if (umErr) throw umErr;
        var urev = ((um && um.map_revision) || 0) + 1;
        state.meta.revision = urev;
        var { error: upErr } = await sb
          .from('user_map_state')
          .upsert({
            user_id: sessionUser.id,
            map_state: state,
            map_revision: urev,
            updated_at: new Date().toISOString()
          });
        if (upErr) throw upErr;
        localRevision = urev;
      }
      dirty = false;
      try { localStorage.removeItem(DIRTY_KEY); } catch (e) {}
      writeLocalCache(state);
      updateSyncBadge('ok');
    } catch (e) {
      console.warn('Cloud push deferred', e);
      updateSyncBadge('pending');
    } finally {
      cloudBusy = false;
    }
  }

  async function pullMapFromCloud(force) {
    if (!sb || !sessionUser) return;
    if (!isOnline()) return;
    if (!force && Date.now() - lastPullAt < 12000) return;
    // Never overwrite a local delete/edit that has not uploaded yet
    if (isDirty()) {
      scheduleCloudPush(true);
      return;
    }
    try {
      var state = null;
      var rev = 0;
      if (viewState.mode === 'shared' && viewState.sharedMapId) {
        var { data, error } = await sb
          .from('shared_maps')
          .select('map_state, map_revision, name, code')
          .eq('id', viewState.sharedMapId)
          .maybeSingle();
        if (error) throw error;
        if (!data) return;
        state = data.map_state || {};
        rev = data.map_revision || 0;
        viewState.sharedMapName = data.name || viewState.sharedMapName;
        viewState.sharedMapCode = data.code || viewState.sharedMapCode;
        persistViewState();
      } else if (viewState.privateMapId) {
        var { data: pmd, error: pe } = await sb
          .from('private_maps')
          .select('map_state, map_revision, name')
          .eq('id', viewState.privateMapId)
          .maybeSingle();
        if (pe) throw pe;
        if (!pmd) return;
        state = pmd.map_state || {};
        rev = pmd.map_revision || 0;
        viewState.privateMapName = pmd.name || viewState.privateMapName;
        persistViewState();
      } else {
        var { data: um, error: e2 } = await sb
          .from('user_map_state')
          .select('map_state, map_revision')
          .eq('user_id', sessionUser.id)
          .maybeSingle();
        if (e2) throw e2;
        if (!um) return;
        state = um.map_state || {};
        rev = um.map_revision || 0;
      }
      lastPullAt = Date.now();
      if (rev && rev === localRevision && !force) return;

      // If remote is empty but local still has data (and not dirty), seed cloud once
      var local = collectMapState();
      var remoteEmpty = !state || (
        !(state.pins && state.pins.length) &&
        !(state.hunts && state.hunts.length) &&
        !(state.customAreas && state.customAreas.length) &&
        !(state.measuredPaths && state.measuredPaths.length)
      );
      var localHas = (local.pins && local.pins.length) || (local.hunts && local.hunts.length) ||
        (local.customAreas && local.customAreas.length) || (local.measuredPaths && local.measuredPaths.length);
      // Only seed when we have never synced (rev 0) — not after intentional full delete
      if (remoteEmpty && localHas && !rev) {
        dirty = true;
        try { localStorage.setItem(DIRTY_KEY, '1'); } catch (eD) {}
        scheduleCloudPush(true);
        return;
      }

      // Full replace from cloud (includes deletions). Dirty local already bailed out above.
      applyMapState(state);
      localRevision = rev;
      writeLocalCache(state);
      refreshMapFromLocalState();
      updateAuthChrome();
    } catch (e) {
      console.warn('Cloud pull skipped', e);
    }
  }

  function refreshMapFromLocalState() {
    try {
      if (typeof window.regSlayerRefreshMapData === 'function') window.regSlayerRefreshMapData();
    } catch (e) {
      console.warn('refreshMapFromLocalState', e);
    }
  }

  async function persistViewPrefsCloud() {
    if (!sb || !sessionUser || !isOnline()) return;
    try {
      var mode = viewState.mode === 'shared' ? 'shared' : 'private';
      await sb.from('user_view_prefs').upsert({
        user_id: sessionUser.id,
        view_mode: mode,
        last_shared_map_id: viewState.mode === 'shared' ? viewState.sharedMapId : null,
        last_private_map_id: viewState.mode !== 'shared' ? viewState.privateMapId : null,
        updated_at: new Date().toISOString()
      });
    } catch (e) {}
  }

  async function ensureDefaultPrivateMap() {
    if (!sb || !sessionUser) return null;
    var { data: list } = await sb.rpc('list_my_private_maps');
    if (list && list.length) {
      var def = list.find(function (m) { return m.is_default; }) || list[0];
      return def;
    }
    var { data: created } = await sb.rpc('create_private_map', { p_name: 'My Map' });
    return created;
  }

  async function restoreViewPrefsFromCloud() {
    if (!sb || !sessionUser || !isOnline()) return;
    try {
      var def = await ensureDefaultPrivateMap();
      var { data } = await sb
        .from('user_view_prefs')
        .select('view_mode, last_shared_map_id, last_private_map_id')
        .eq('user_id', sessionUser.id)
        .maybeSingle();
      if (data && (data.view_mode === 'shared') && data.last_shared_map_id) {
        var { data: sm } = await sb
          .from('shared_maps')
          .select('id, name, code')
          .eq('id', data.last_shared_map_id)
          .maybeSingle();
        if (sm) {
          viewState.mode = 'shared';
          viewState.sharedMapId = sm.id;
          viewState.sharedMapName = sm.name;
          viewState.sharedMapCode = sm.code;
          if (def) {
            viewState.privateMapId = viewState.privateMapId || def.id;
            viewState.privateMapName = viewState.privateMapName || def.name;
          }
          persistViewState();
          return;
        }
      }
      var pid = (data && data.last_private_map_id) || (def && def.id);
      if (pid) {
        var { data: pm } = await sb.from('private_maps').select('id, name').eq('id', pid).maybeSingle();
        if (pm) {
          viewState.mode = 'private';
          viewState.privateMapId = pm.id;
          viewState.privateMapName = pm.name;
          viewState.sharedMapId = null;
          viewState.sharedMapName = '';
          viewState.sharedMapCode = '';
          persistViewState();
          return;
        }
      }
      if (def) {
        viewState.mode = 'private';
        viewState.privateMapId = def.id;
        viewState.privateMapName = def.name;
        viewState.sharedMapId = null;
        viewState.sharedMapName = '';
        viewState.sharedMapCode = '';
        persistViewState();
      }
    } catch (e) {}
  }

  // ---- Auth ----
  function randomRecoveryCodes(n) {
    var out = [];
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (var i = 0; i < n; i++) {
      var s = '';
      var arr = new Uint8Array(8);
      crypto.getRandomValues(arr);
      for (var j = 0; j < 8; j++) s += alphabet[arr[j] % alphabet.length];
      // format XXXX-XXXX
      out.push(s.slice(0, 4) + '-' + s.slice(4));
    }
    return out;
  }

  async function sha256Hex(text) {
    var data = new TextEncoder().encode(text);
    var hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }

  async function ensureClient() {
    if (sb) return sb;
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error('Supabase library not loaded');
    }
    sb = window.supabase.createClient(SB_URL, SB_ANON, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: window.localStorage
      }
    });
    return sb;
  }

  async function loadProfile() {
    if (!sb || !sessionUser) return null;
    var { data, error } = await sb
      .from('profiles')
      .select('id, username, recovery_email, display_name')
      .eq('id', sessionUser.id)
      .maybeSingle();
    if (error) throw error;
    profile = data;
    return profile;
  }

  async function signUp(username, password, recoveryEmail) {
    await ensureClient();
    var uname = normalizeUsername(username);
    if (uname.length < 3 || uname.length > 32 || !/^[a-z0-9_]+$/.test(uname)) {
      throw new Error('Username: 3–32 chars, letters/numbers/underscore only');
    }
    if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');
    var email = syntheticEmail(uname);
    var codes = randomRecoveryCodes(8);
    var hashes = [];
    for (var i = 0; i < codes.length; i++) hashes.push(await sha256Hex(codes[i].toUpperCase()));

    var { data, error } = await sb.auth.signUp({
      email: email,
      password: password,
      options: { data: { username: uname } }
    });
    if (error) throw error;
    if (!data.user) throw new Error('Sign up failed');

    var recEmail = recoveryEmail && String(recoveryEmail).trim() ? String(recoveryEmail).trim() : null;
    var { error: pErr } = await sb.from('profiles').insert({
      id: data.user.id,
      username: username.trim(),
      username_normalized: uname,
      recovery_email: recEmail,
      recovery_code_hashes: hashes,
      display_name: username.trim()
    });
    if (pErr) throw pErr;

    pendingSignupCodes = codes;
    sessionUser = data.user;
    await loadProfile();
    return { codes: codes };
  }

  async function signIn(username, password) {
    await ensureClient();
    var uname = normalizeUsername(username);
    var email = syntheticEmail(uname);
    var { data, error } = await sb.auth.signInWithPassword({ email: email, password: password });
    if (error) throw error;
    sessionUser = data.user;
    await loadProfile();
    return data;
  }

  async function signOut() {
    if (sb) await sb.auth.signOut();
    sessionUser = null;
    profile = null;
    showAuthGate(true);
  }

  async function recoverWithCode(username, code, newPassword) {
    var res = await fetch(SB_URL + '/functions/v1/recover-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SB_ANON,
        Authorization: 'Bearer ' + SB_ANON
      },
      body: JSON.stringify({
        username: username,
        recovery_code: String(code || '').trim().toUpperCase(),
        new_password: newPassword
      })
    });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(body.error || 'Recovery failed');
    return true;
  }

  // ---- Shared maps ----
  async function createSharedMap(name) {
    if (!sb || !sessionUser) throw new Error('Sign in required');
    // Save personal first
    await snapshotCurrentToCache();
    var { data, error } = await sb.rpc('create_shared_map', { p_name: name });
    if (error) throw error;
    viewState.mode = 'shared';
    viewState.sharedMapId = data.id;
    viewState.sharedMapName = data.name;
    viewState.sharedMapCode = data.code;
    persistViewState();
    await persistViewPrefsCloud();
    // Seed shared with current local (user's stuff) then push
    dirty = true;
    try { localStorage.setItem(DIRTY_KEY, '1'); } catch (eD) {}
    await pushMapToCloud();
    // Auto-copy invite with deep link
    try {
      var invite = inviteShareText(data.code, data.name);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(invite);
      } else {
        fallbackCopy(invite);
      }
    } catch (eCopy) {
      try { fallbackCopy(inviteShareText(data.code, data.name)); } catch (e2) {}
    }
    updateAuthChrome();
    return data;
  }

  async function joinSharedMap(code) {
    if (!sb || !sessionUser) throw new Error('Sign in required');
    await snapshotCurrentToCache();
    var { data, error } = await sb.rpc('join_shared_map', { p_code: code });
    if (error) throw error;
    viewState.mode = 'shared';
    viewState.sharedMapId = data.id;
    viewState.sharedMapName = data.name;
    viewState.sharedMapCode = data.code;
    persistViewState();
    await persistViewPrefsCloud();
    dirty = false;
    localRevision = 0;
    await pullMapFromCloud(true);
    updateAuthChrome();
    return data;
  }

  async function switchToPersonal() {
    await snapshotCurrentToCache();
    if (dirty && isOnline()) {
      try { await pushMapToCloud(); } catch (e) {}
    }
    var def = await ensureDefaultPrivateMap();
    viewState.mode = 'private';
    viewState.sharedMapId = null;
    viewState.sharedMapName = '';
    viewState.sharedMapCode = '';
    if (def) {
      viewState.privateMapId = def.id;
      viewState.privateMapName = def.name;
    }
    persistViewState();
    await persistViewPrefsCloud();
    var cached = readLocalCache(cacheSlotKey());
    if (cached && cached.state) applyMapState(cached.state);
    dirty = false;
    await pullMapFromCloud(true);
    refreshMapFromLocalState();
    updateAuthChrome();
  }

  async function switchToPrivateMap(mapId) {
    await snapshotCurrentToCache();
    if (isDirty() && isOnline()) {
      try { await pushMapToCloud(); } catch (e) {}
    }
    var { data, error } = await sb.from('private_maps').select('id, name').eq('id', mapId).maybeSingle();
    if (error || !data) throw error || new Error('Map not found');
    viewState.mode = 'private';
    viewState.privateMapId = data.id;
    viewState.privateMapName = data.name;
    viewState.sharedMapId = null;
    viewState.sharedMapName = '';
    viewState.sharedMapCode = '';
    persistViewState();
    await persistViewPrefsCloud();
    var cached = readLocalCache(cacheSlotKey());
    if (cached && cached.state) applyMapState(cached.state);
    dirty = false;
    await pullMapFromCloud(true);
    refreshMapFromLocalState();
    updateAuthChrome();
  }

  async function switchToShared(mapId) {
    await snapshotCurrentToCache();
    if (dirty && isOnline()) {
      try { await pushMapToCloud(); } catch (e) {}
    }
    var { data, error } = await sb.from('shared_maps').select('id, name, code').eq('id', mapId).maybeSingle();
    if (error || !data) throw error || new Error('Map not found');
    viewState.mode = 'shared';
    viewState.sharedMapId = data.id;
    viewState.sharedMapName = data.name;
    viewState.sharedMapCode = data.code;
    persistViewState();
    await persistViewPrefsCloud();
    var cached = readLocalCache('shared:' + data.id);
    if (cached && cached.state) applyMapState(cached.state);
    dirty = false;
    await pullMapFromCloud(true);
    refreshMapFromLocalState();
    updateAuthChrome();
  }

  async function snapshotCurrentToCache() {
    try {
      var st = collectMapState();
      writeLocalCache(st);
    } catch (e) {}
  }

  async function listMySharedMaps() {
    if (!sb || !sessionUser) return [];
    var { data, error } = await sb.rpc('list_my_shared_maps');
    if (error) throw error;
    return data || [];
  }

  function shareCodeToClipboard() {
    var code = viewState.sharedMapCode;
    if (!code) {
      alert('Open a shared map first, or create one in Settings â†’ Maps.');
      return;
    }
    var text = inviteShareText(code, viewState.sharedMapName);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        alert('Copied:\n' + text);
      }).catch(function () {
        fallbackCopy(text);
      });
    } else fallbackCopy(text);
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      alert('Copied:\n' + text);
    } catch (e) {
      prompt('Copy this:', text);
    }
  }

  // ---- UI ----
  function updateAuthChrome() {
    var mapLabel = 'My Map';
    var mapTitle = 'Private map';
    if (viewState.mode === 'shared' && viewState.sharedMapName) {
      mapLabel = viewState.sharedMapName;
      mapTitle = 'Shared map · code ' + (viewState.sharedMapCode || '');
    } else {
      mapLabel = viewState.privateMapName || 'My Map';
      mapTitle = 'Private map';
    }
    var nameEl = $('brand-map-name');
    if (nameEl) {
      nameEl.textContent = mapLabel;
      nameEl.title = mapTitle;
      // Desktop shows header name; mobile CSS hides it
      nameEl.style.display = '';
    }
    var mobileName = $('map-title-mobile');
    if (mobileName) {
      mobileName.textContent = mapLabel;
      mobileName.title = mapTitle;
    }
    var badge = $('auth-user-chip');
    if (badge) {
      badge.textContent = profile && profile.username ? ('@' + profile.username) : (sessionUser ? 'Signed in' : '');
    }
    var modeLabel = $('set-map-mode-label');
    if (modeLabel) {
      if (viewState.mode === 'shared') {
        modeLabel.textContent = 'Viewing: ' + (viewState.sharedMapName || 'Shared') + ' (' + (viewState.sharedMapCode || '------') + ')';
      } else {
        modeLabel.textContent = 'Viewing: ' + (viewState.privateMapName || 'My Map') + ' (private)';
      }
    }
    var off = $('set-offline-mode');
    if (off) off.checked = !!offlineMode;
    var sync = $('set-sync-status');
    if (sync) {
      if (offlineMode) sync.textContent = 'Offline mode — cloud sync paused';
      else if (!isOnline()) sync.textContent = 'No connection — saving locally';
      else if (dirty) sync.textContent = 'Local save pending cloud uploadâ€¦';
      else sync.textContent = 'Cloud sync ready';
    }
    updateSettingsMapsList();
  }

  function updateSyncBadge(state) {
    var sync = $('set-sync-status');
    if (!sync) return;
    if (offlineMode) { sync.textContent = 'Offline mode — cloud sync paused'; return; }
    if (state === 'syncing') sync.textContent = 'Uploading to cloudâ€¦';
    else if (state === 'pending') sync.textContent = 'Waiting to upload (will retry when online)â€¦';
    else if (state === 'ok') sync.textContent = 'Synced with cloud';
  }

  async function updateSettingsMapsList() {
    var box = $('set-shared-maps-list');
    if (!box || !sessionUser) return;
    box.innerHTML = '<p class="settings-hint">Loading mapsâ€¦</p>';
    try {
      var maps = await listMySharedMaps();
      if (!maps.length) {
        box.innerHTML = '<p class="settings-hint">No shared maps yet. Create one below.</p>';
        return;
      }
      var html = '';
      maps.forEach(function (m) {
        var active = viewState.mode === 'shared' && viewState.sharedMapId === m.id;
        html += '<div class="settings-map-row' + (active ? ' is-active' : '') + '">';
        html += '<button type="button" class="settings-map-open" data-mid="' + m.id + '">' +
          esc(m.name) + ' <span class="settings-map-code">' + esc(m.code) + '</span></button>';
        html += '</div>';
      });
      box.innerHTML = html;
      box.querySelectorAll('.settings-map-open').forEach(function (btn) {
        btn.addEventListener('click', function () {
          switchToShared(btn.getAttribute('data-mid')).catch(function (e) {
            alert(e.message || String(e));
          });
        });
      });
    } catch (e) {
      box.innerHTML = '<p class="settings-hint">Could not load maps (offline?).</p>';
    }
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showAuthGate(show) {
    var gate = $('auth-gate');
    if (!gate) return;
    gate.classList.toggle('active', !!show);
    gate.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show) {
      try {
        if (gate.parentNode !== document.body) document.body.appendChild(gate);
      } catch (e) {}
      gate.style.zIndex = '2147483646';
    }
  }

  function showAuthPanel(name) {
    ['auth-panel-signin', 'auth-panel-signup', 'auth-panel-recover', 'auth-panel-codes'].forEach(function (id) {
      var el = $(id);
      if (el) el.style.display = (id === 'auth-panel-' + name) ? '' : 'none';
    });
    var err = $('auth-error');
    if (err) err.textContent = '';
  }

  function setAuthError(msg) {
    var err = $('auth-error');
    if (err) err.textContent = msg || '';
  }

  function wireAuthUi() {
    var si = $('auth-btn-signin');
    if (si) si.onclick = function () {
      setAuthError('');
      signIn($('auth-si-user').value, $('auth-si-pass').value)
        .then(function () { return onAuthed(true); })
        .catch(function (e) { setAuthError(e.message || String(e)); });
    };
    var su = $('auth-btn-signup');
    if (su) su.onclick = function () {
      setAuthError('');
      var p1 = $('auth-su-pass').value;
      var p2 = $('auth-su-pass2').value;
      if (p1 !== p2) { setAuthError('Passwords do not match'); return; }
      signUp($('auth-su-user').value, p1, $('auth-su-email').value)
        .then(function (res) {
          showAuthPanel('codes');
          var box = $('auth-codes-list');
          if (box) box.textContent = (res.codes || []).join('\n');
        })
        .catch(function (e) { setAuthError(e.message || String(e)); });
    };
    var codesDone = $('auth-btn-codes-done');
    if (codesDone) codesDone.onclick = function () {
      pendingSignupCodes = null;
      onAuthed(true);
    };
    var copyCodes = $('auth-btn-copy-codes');
    if (copyCodes) copyCodes.onclick = function () {
      var box = $('auth-codes-list');
      if (box) fallbackCopy(box.textContent);
    };
    var rec = $('auth-btn-recover');
    if (rec) rec.onclick = function () {
      setAuthError('');
      recoverWithCode($('auth-rc-user').value, $('auth-rc-code').value, $('auth-rc-pass').value)
        .then(function () {
          setAuthError('');
          alert('Password updated. Sign in with your new password.');
          showAuthPanel('signin');
        })
        .catch(function (e) { setAuthError(e.message || String(e)); });
    };
    document.querySelectorAll('[data-auth-goto]').forEach(function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        showAuthPanel(a.getAttribute('data-auth-goto'));
      });
    });
  }

  window.addEventListener('regslayer-maps-tab', function () {
    try { updateAuthChrome(); } catch (e) {}
  });

  function wireSettingsMapsUi() {
    var createBtn = $('set-create-map-btn');
    if (createBtn) createBtn.onclick = function () {
      var name = ($('set-create-map-name') && $('set-create-map-name').value || '').trim();
      if (!name) { alert('Enter a name for the shared map'); return; }
      createSharedMap(name).then(function (m) {
        var invite = inviteShareText(m.code, m.name);
        alert('Shared map created!\n\nInvite copied to clipboard:\n\n' + invite);
        if ($('set-create-map-name')) $('set-create-map-name').value = '';
        updateAuthChrome();
      }).catch(function (e) { alert(e.message || String(e)); });
    };
    var joinBtn = $('set-join-map-btn');
    if (joinBtn) joinBtn.onclick = function () {
      var code = ($('set-join-map-code') && $('set-join-map-code').value || '').trim();
      joinSharedMap(code).then(function (m) {
        alert('Joined shared map: ' + m.name + ' (' + m.code + ')');
        if ($('set-join-map-code')) $('set-join-map-code').value = '';
        updateAuthChrome();
      }).catch(function (e) { alert(e.message || String(e)); });
    };
    var personalBtn = $('set-use-personal-btn');
    if (personalBtn) personalBtn.onclick = function () {
      switchToPersonal().catch(function (e) { alert(e.message || String(e)); });
    };
    var shareBtn = $('set-share-code-btn');
    if (shareBtn) shareBtn.onclick = function () { shareCodeToClipboard(); };
    var off = $('set-offline-mode');
    if (off) off.onchange = function () { setOfflineMode(off.checked); };
    var signOutBtn = $('set-signout-btn');
    if (signOutBtn) signOutBtn.onclick = function () {
      if (confirm('Sign out on this device? Map data stays on the device and in the cloud.')) {
        signOut().catch(function (e) { alert(e.message || String(e)); });
      }
    };
  }

  function startPullLoop() {
    if (pullTimer) clearInterval(pullTimer);
    // Personal + shared: light poll so deletes/edits arrive on other devices
    pullTimer = setInterval(function () {
      if (document.visibilityState === 'hidden') return;
      if (!isOnline() || isDirty()) return;
      runWhenIdle(function () { pullMapFromCloud(false); });
    }, 30000);
  }

  function captureJoinFromUrl() {
    try {
      var u = new URL(window.location.href);
      var code = u.searchParams.get('join') || u.searchParams.get('map') || '';
      code = String(code).replace(/\D/g, '').slice(0, 6);
      if (code.length === 6) {
        try { sessionStorage.setItem('reg_slayer_pending_join', code); } catch (eS) {}
        u.searchParams.delete('join');
        u.searchParams.delete('map');
        var clean = u.pathname + (u.search || '') + (u.hash || '');
        if (window.history && history.replaceState) history.replaceState({}, '', clean || '/');
      }
    } catch (e) {}
  }

  async function consumePendingJoin() {
    var code = '';
    try { code = sessionStorage.getItem('reg_slayer_pending_join') || ''; } catch (e) {}
    if (!code || code.length !== 6) return;
    try { sessionStorage.removeItem('reg_slayer_pending_join'); } catch (e2) {}
    try {
      await joinSharedMap(code);
      alert('Joined shared map: ' + (viewState.sharedMapName || code));
    } catch (err) {
      alert('Could not join map ' + code + ': ' + (err.message || err));
    }
  }

  function inviteShareText(code, mapName) {
    var c = String(code || '').replace(/\D/g, '').slice(0, 6);
    var link = 'https://regslayer.com/?join=' + c;
    var nameLine = mapName ? ('Map: ' + mapName + '\n') : '';
    return 'Join my HuntSlayer map!\n' + nameLine + 'Code: ' + c + '\n' + link;
  }

  async function onAuthed(fromLogin) {
    showAuthGate(false);
    restoreDirtyFlag();
    loadViewState();
    await restoreViewPrefsFromCloud();
    // Apply last local cache for active map immediately (offline-first feel)
    var slot = cacheSlotKey();
    var cached = readLocalCache(slot);
    if (cached && cached.state) {
      applyMapState(cached.state);
      if (cached.state.meta && cached.state.meta.revision) {
        localRevision = cached.state.meta.revision;
      }
      refreshMapFromLocalState();
    }
    // Upload pending local deletes/edits BEFORE any cloud pull (prevents resurrect)
    if (isDirty()) {
      try { await pushMapToCloud(); } catch (eP) { console.warn(eP); }
    }
    await pullMapFromCloud(true);
    if (isDirty()) scheduleCloudPush(true);
    await consumePendingJoin();
    updateAuthChrome();
    startPullLoop();
    if (authReadyResolve) { authReadyResolve(); authReadyResolve = null; }
  }

  async function bootstrapAuth() {
    loadOfflineMode();
    loadViewState();
    restoreDirtyFlag();
    captureJoinFromUrl();
    wireAuthUi();
    wireSettingsMapsUi();
    updateAuthChrome();
    showAuthPanel('signin');
    try {
      await ensureClient();
      var { data } = await sb.auth.getSession();
      if (data && data.session && data.session.user) {
        sessionUser = data.session.user;
        window.__rsUser = sessionUser;
        window.__rsSb = sb;
        try { await loadProfile(); } catch (e) {}
        await onAuthed(false);
      } else {
        showAuthGate(true);
      }
      sb.auth.onAuthStateChange(function (event, session) {
        if (session && session.user) {
          sessionUser = session.user;
          window.__rsUser = sessionUser;
          window.__rsSb = sb;
        } else if (event === 'SIGNED_OUT') {
          sessionUser = null;
          window.__rsUser = null;
          profile = null;
          showAuthGate(true);
        }
      });
    } catch (e) {
      console.error(e);
      showAuthGate(true);
      setAuthError('Could not reach sign-in service. Check connection.');
    }

    window.addEventListener('online', function () {
      if (!offlineMode && isDirty()) scheduleCloudPush(true);
      updateAuthChrome();
    });
    window.addEventListener('offline', function () { updateAuthChrome(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && isDirty() && isOnline()) {
        pushMapToCloud();
      } else if (document.visibilityState === 'visible' && !isDirty() && isOnline()) {
        runWhenIdle(function () { pullMapFromCloud(true); });
      }
    });
  }

  // Expose for settings / debugging
  window.RegSlayerCloud = {
    bootstrapAuth: bootstrapAuth,
    markDirty: markDirty,
    forcePush: function () {
      dirty = true;
      try { localStorage.setItem(DIRTY_KEY, '1'); } catch (e) {}
      try {
        var st = collectMapState();
        writeLocalCache(st);
      } catch (e2) {}
      scheduleCloudPush(true);
    },
    shareCodeToClipboard: shareCodeToClipboard,
    switchToPersonal: switchToPersonal,
    switchToPrivateMap: switchToPrivateMap,
    _switchToPrivate: switchToPrivateMap,
    createSharedMap: createSharedMap,
    joinSharedMap: joinSharedMap,
    listMySharedMaps: listMySharedMaps,
    authReady: authReady,
    getViewState: function () { return viewState; },
    getProfile: function () { return profile; },
    isOfflineMode: function () { return offlineMode; },
    setOfflineMode: setOfflineMode,
    getClient: function () { return sb; },
    switchToShared: switchToShared,
    get _sb() { return sb; }
  };
  // Expose for party extension
  Object.defineProperty(window, '__rsSbBridge', {
    get: function () { return sb; }
  });
})();
