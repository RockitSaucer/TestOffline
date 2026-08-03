/* REG SLAYER — multi private maps, party presence, share-to-map (extends RegSlayerCloud) */
(function () {
  'use strict';
  if (!window.RegSlayerCloud) {
    console.warn('RegSlayerCloud missing — party maps extension skipped');
    return;
  }

  var C = window.RegSlayerCloud;
  var PRESENCE_KEY = 'reg_slayer_sharing_loc_v1';
  var ARROW_KEY = 'reg_slayer_my_arrow_color_v1';
  var HIDDEN_MEMBERS_KEY = 'reg_slayer_hidden_party_content_v1';
  var MOVE_M = 12; // meters = "moving"
  var STILL_MS = 15 * 60 * 1000;
  var MOVE_MS = 10 * 1000;
  var MAX_SHARE_MS = 60 * 60 * 1000;

  var presenceTimer = null;
  var presenceWatch = null;
  var sharing = false;
  var shareStartedAt = 0;
  var lastSent = { lat: null, lng: null, at: 0 };
  var partyLayer = null;
  var partyMarkers = {};
  var myArrowColor = '#e11d1d';
  var partyPrefs = {}; // memberId -> { nickname, arrow_color, show_content }
  var hiddenContentOwners = {}; // userId -> true means HIDE their content

  try {
    var ac = localStorage.getItem(ARROW_KEY);
    if (ac) myArrowColor = ac;
  } catch (e) {}

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function getSb() {
    return C._sb || (window.supabase && C.getClient && C.getClient());
  }

  // Expose helpers the original module doesn't
  // Patch: we reach into original by re-wrapping public API after boot
  function ensurePartyLayer() {
    if (!window.map || typeof L === 'undefined') return null;
    if (!partyLayer) {
      partyLayer = L.layerGroup().addTo(window.map);
    }
    return partyLayer;
  }

  function haversineM(aLat, aLng, bLat, bLng) {
    var R = 6371000;
    var toR = Math.PI / 180;
    var dLat = (bLat - aLat) * toR;
    var dLng = (bLng - aLng) * toR;
    var x = Math.sin(dLat / 2);
    var y = Math.sin(dLng / 2);
    var h = x * x + Math.cos(aLat * toR) * Math.cos(bLat * toR) * y * y;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function buildPartyArrowIcon(color, label, heading) {
    var rot = heading != null && !isNaN(heading) ? (((Number(heading) % 360) + 360) % 360) : 0;
    var c = color || '#2563eb';
    var w = 22, h = 30;
    var name = esc((label || '').slice(0, 16));
    var html =
      '<div style="display:flex;flex-direction:column;align-items:center;pointer-events:auto;">' +
        '<div style="font-size:10px;font-weight:800;color:#fff;text-shadow:0 0 3px #000,0 1px 2px #000;background:rgba(0,0,0,.55);padding:1px 5px;border-radius:4px;margin-bottom:2px;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + name + '</div>' +
        '<div style="width:' + w + 'px;height:' + h + 'px;transform:rotate(' + rot.toFixed(1) + 'deg);transform-origin:center center;">' +
          '<svg viewBox="0 0 24 32" width="' + w + '" height="' + h + '">' +
            '<path d="M12 1.5 L22.5 29.5 L12 23.2 L1.5 29.5 Z" fill="' + c + '" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/>' +
          '</svg>' +
        '</div>' +
      '</div>';
    return L.divIcon({
      className: 'party-presence-icon',
      html: html,
      iconSize: [96, 52],
      iconAnchor: [48, 40]
    });
  }

  function formatAgo(iso) {
    if (!iso) return 'unknown';
    var t = new Date(iso).getTime();
    if (isNaN(t)) return 'unknown';
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  async function loadPartyPrefs(mapId) {
    partyPrefs = {};
    var sb = window.__rsSb;
    var user = window.__rsUser;
    if (!sb || !user || !mapId) return;
    try {
      var { data } = await sb.from('party_member_prefs')
        .select('member_user_id, nickname, arrow_color, show_content')
        .eq('map_id', mapId)
        .eq('owner_user_id', user.id);
      (data || []).forEach(function (r) {
        partyPrefs[r.member_user_id] = r;
      });
    } catch (e) {}
    try {
      hiddenContentOwners = JSON.parse(localStorage.getItem(HIDDEN_MEMBERS_KEY + ':' + mapId) || '{}');
    } catch (e2) { hiddenContentOwners = {}; }
  }

  async function savePartyPref(memberId, fields) {
    var sb = window.__rsSb;
    var user = window.__rsUser;
    var vs = C.getViewState && C.getViewState();
    if (!sb || !user || !vs || vs.mode !== 'shared' || !vs.sharedMapId) return;
    var row = Object.assign({
      map_id: vs.sharedMapId,
      owner_user_id: user.id,
      member_user_id: memberId,
      updated_at: new Date().toISOString()
    }, fields);
    await sb.from('party_member_prefs').upsert(row);
    partyPrefs[memberId] = Object.assign({}, partyPrefs[memberId] || {}, fields);
  }

  function memberLabel(m) {
    var pref = partyPrefs[m.user_id];
    if (pref && pref.nickname) return pref.nickname;
    return m.display_name || m.username || 'Hunter';
  }

  function memberColor(m) {
    var pref = partyPrefs[m.user_id];
    if (pref && pref.arrow_color) return pref.arrow_color;
    return m.arrow_color || '#2563eb';
  }

  async function pullPresence() {
    var vs = C.getViewState && C.getViewState();
    var sb = window.__rsSb;
    var user = window.__rsUser;
    if (!vs || vs.mode !== 'shared' || !vs.sharedMapId || !sb || !window.map) {
      clearPartyMarkers();
      return;
    }
    var layer = ensurePartyLayer();
    if (!layer) return;
    try {
      var { data } = await sb.from('party_presence')
        .select('user_id, is_sharing, lat, lng, heading, updated_at, started_at')
        .eq('map_id', vs.sharedMapId)
        .eq('is_sharing', true);
      var members = window.__rsPartyMembers || [];
      var byId = {};
      members.forEach(function (m) { byId[m.user_id] = m; });
      var seen = {};
      (data || []).forEach(function (row) {
        if (!row.is_sharing || row.lat == null || row.lng == null) return;
        // Hide self from party layer (own GPS marker is separate)
        if (user && row.user_id === user.id) return;
        // Stale > 20 min hide
        var age = Date.now() - new Date(row.updated_at).getTime();
        if (age > 20 * 60 * 1000) return;
        seen[row.user_id] = true;
        var m = byId[row.user_id] || { user_id: row.user_id, username: 'Hunter', display_name: 'Hunter' };
        var label = memberLabel(m);
        var color = memberColor(m);
        var icon = buildPartyArrowIcon(color, label, row.heading);
        var popup = '<strong>' + esc(label) + '</strong><br>Last updated: ' + esc(formatAgo(row.updated_at));
        if (partyMarkers[row.user_id]) {
          partyMarkers[row.user_id].setLatLng([row.lat, row.lng]);
          try { partyMarkers[row.user_id].setIcon(icon); } catch (eI) {}
          partyMarkers[row.user_id].setPopupContent(popup);
        } else {
          var mk = L.marker([row.lat, row.lng], { icon: icon, zIndexOffset: 800 }).addTo(layer);
          mk.bindPopup(popup);
          partyMarkers[row.user_id] = mk;
        }
      });
      Object.keys(partyMarkers).forEach(function (uid) {
        if (!seen[uid]) {
          try { layer.removeLayer(partyMarkers[uid]); } catch (e) {}
          delete partyMarkers[uid];
        }
      });
    } catch (e) {
      console.warn('presence pull', e);
    }
  }

  function clearPartyMarkers() {
    if (partyLayer) {
      try { partyLayer.clearLayers(); } catch (e) {}
    }
    partyMarkers = {};
  }

  async function pushPresence(lat, lng, heading, force) {
    var vs = C.getViewState && C.getViewState();
    var sb = window.__rsSb;
    var user = window.__rsUser;
    if (!sharing || !vs || vs.mode !== 'shared' || !vs.sharedMapId || !sb || !user) return;
    if (Date.now() - shareStartedAt > MAX_SHARE_MS) {
      stopSharing('auto');
      return;
    }
    var now = Date.now();
    var moved = true;
    if (lastSent.lat != null) {
      var d = haversineM(lastSent.lat, lastSent.lng, lat, lng);
      moved = d >= MOVE_M;
    }
    var interval = moved ? MOVE_MS : STILL_MS;
    if (!force && lastSent.at && (now - lastSent.at) < interval) return;

    try {
      await sb.from('party_presence').upsert({
        map_id: vs.sharedMapId,
        user_id: user.id,
        is_sharing: true,
        lat: lat,
        lng: lng,
        heading: heading != null ? heading : null,
        started_at: new Date(shareStartedAt).toISOString(),
        last_moved_at: moved || !lastSent.at ? new Date().toISOString() : undefined,
        updated_at: new Date().toISOString()
      });
      // fix last_moved_at optional overwrite
      await sb.from('party_presence').upsert({
        map_id: vs.sharedMapId,
        user_id: user.id,
        is_sharing: true,
        lat: lat,
        lng: lng,
        heading: heading != null ? heading : null,
        started_at: new Date(shareStartedAt).toISOString(),
        last_moved_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      lastSent = { lat: lat, lng: lng, at: now };
    } catch (e) {
      console.warn('presence push', e);
    }
  }

  function startSharing() {
    var vs = C.getViewState && C.getViewState();
    if (!vs || vs.mode !== 'shared') {
      alert('Share location only works on a shared map. Open a shared map first.');
      return;
    }
    if (!navigator.geolocation) {
      alert('Geolocation not available on this device.');
      return;
    }
    sharing = true;
    shareStartedAt = Date.now();
    lastSent = { lat: null, lng: null, at: 0 };
    try { localStorage.setItem(PRESENCE_KEY, JSON.stringify({ on: true, started: shareStartedAt, mapId: vs.sharedMapId })); } catch (e) {}
    updateShareLocBtn();
    if (presenceWatch != null) {
      try { navigator.geolocation.clearWatch(presenceWatch); } catch (e2) {}
    }
    presenceWatch = navigator.geolocation.watchPosition(function (pos) {
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      var heading = pos.coords.heading;
      if (heading == null || isNaN(heading)) {
        try { if (typeof deviceHeadingDeg !== 'undefined') heading = deviceHeadingDeg; } catch (eH) {}
      }
      pushPresence(lat, lng, heading, false);
    }, function (err) {
      console.warn(err);
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });

    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = setInterval(function () {
      if (!sharing) return;
      if (Date.now() - shareStartedAt > MAX_SHARE_MS) {
        stopSharing('auto');
        return;
      }
      pullPresence();
      // still heartbeat if we have last coords
      if (lastSent.lat != null) {
        pushPresence(lastSent.lat, lastSent.lng, null, false);
      }
    }, 10000);

    // immediate fix
    navigator.geolocation.getCurrentPosition(function (pos) {
      pushPresence(pos.coords.latitude, pos.coords.longitude, pos.coords.heading, true);
    }, function () {}, { enableHighAccuracy: true, timeout: 10000 });
    pullPresence();
  }

  async function stopSharing(reason) {
    sharing = false;
    try { localStorage.removeItem(PRESENCE_KEY); } catch (e) {}
    if (presenceWatch != null) {
      try { navigator.geolocation.clearWatch(presenceWatch); } catch (e2) {}
      presenceWatch = null;
    }
    if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
    updateShareLocBtn();
    var vs = C.getViewState && C.getViewState();
    var sb = window.__rsSb;
    var user = window.__rsUser;
    if (sb && user && vs && vs.sharedMapId) {
      try {
        await sb.from('party_presence').upsert({
          map_id: vs.sharedMapId,
          user_id: user.id,
          is_sharing: false,
          updated_at: new Date().toISOString()
        });
      } catch (e3) {}
    }
    if (reason === 'auto') {
      try { showAppCopyToast && showAppCopyToast('<span class="act">Location sharing ended</span><br>Auto-off after 1 hour.'); } catch (e4) {}
    }
  }

  function toggleSharing() {
    if (sharing) stopSharing();
    else startSharing();
  }

  function updateShareLocBtn() {
    var btn = $('share-loc-btn');
    if (!btn) return;
    btn.classList.toggle('is-sharing', !!sharing);
    btn.setAttribute('aria-pressed', sharing ? 'true' : 'false');
    btn.title = sharing ? 'Sharing location with party (tap to stop)' : 'Share current location with party';
  }

  // ---- List maps / UI ----
  async function listPrivateMaps() {
    var sb = window.__rsSb;
    if (!sb) return [];
    var { data, error } = await sb.rpc('list_my_private_maps');
    if (error) throw error;
    return data || [];
  }

  async function listMembers() {
    var vs = C.getViewState && C.getViewState();
    var sb = window.__rsSb;
    if (!vs || vs.mode !== 'shared' || !vs.sharedMapId || !sb) {
      window.__rsPartyMembers = [];
      return [];
    }
    var { data, error } = await sb.rpc('list_shared_map_members', { p_map_id: vs.sharedMapId });
    if (error) throw error;
    window.__rsPartyMembers = data || [];
    return window.__rsPartyMembers;
  }

  function showSimpleModal(title, bodyHtml, buttons) {
    var existing = $('rs-simple-modal');
    if (existing) existing.remove();
    var wrap = document.createElement('div');
    wrap.id = 'rs-simple-modal';
    wrap.className = 'rs-simple-modal active';
    wrap.onclick = function (e) { if (e.target === wrap) wrap.remove(); };
    var card = document.createElement('div');
    card.className = 'rs-simple-card';
    card.onclick = function (e) { e.stopPropagation(); };
    card.innerHTML = '<h3>' + esc(title) + '</h3><div class="rs-simple-body">' + bodyHtml + '</div><div class="rs-simple-actions" id="rs-simple-actions"></div>';
    wrap.appendChild(card);
    document.body.appendChild(wrap);
    var act = card.querySelector('#rs-simple-actions');
    (buttons || []).forEach(function (b) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-subbtn' + (b.primary ? ' rs-btn-primary' : '');
      btn.textContent = b.label;
      btn.onclick = function () {
        if (b.close !== false) wrap.remove();
        if (b.onClick) b.onClick();
      };
      act.appendChild(btn);
    });
    return wrap;
  }

  async function openSharedMapActions(mapRow) {
    showSimpleModal(mapRow.name || 'Shared map',
      '<p class="settings-hint">Code: <strong>' + esc(mapRow.code) + '</strong></p>',
      [
        {
          label: 'View this map',
          primary: true,
          onClick: function () {
            C.switchToShared(mapRow.id).then(function () {
              refreshMapsUi();
              pullPresence();
            }).catch(function (e) { alert(e.message || e); });
          }
        },
        {
          label: 'Share this map',
          onClick: function () {
            var text = 'Join my HuntSlayer map!\nMap: ' + (mapRow.name || '') + '\nCode: ' + mapRow.code +
              '\nhttps://regslayer.com/?join=' + mapRow.code;
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(function () {
                alert('Copied:\n' + text);
              }).catch(function () { window.prompt('Copy:', text); });
            } else window.prompt('Copy:', text);
          }
        },
        { label: 'Cancel' }
      ]
    );
  }

  async function openPrivateMapActions(mapRow) {
    showSimpleModal(mapRow.name || 'Private map',
      '<p class="settings-hint">Private — only you. Rename or open.</p>',
      [
        {
          label: 'View this map',
          primary: true,
          onClick: function () {
            switchToPrivate(mapRow.id).catch(function (e) { alert(e.message || e); });
          }
        },
        {
          label: 'Rename map',
          onClick: function () {
            var n = prompt('New name:', mapRow.name || '');
            if (!n || !n.trim()) return;
            renamePrivate(mapRow.id, n.trim()).then(refreshMapsUi).catch(function (e) { alert(e.message || e); });
          }
        },
        { label: 'Cancel' }
      ]
    );
  }

  async function switchToPrivate(mapId) {
    var sb = window.__rsSb;
    if (!sb) throw new Error('Not ready');
    // save current
    if (C.forcePush) C.forcePush();
    await new Promise(function (r) { setTimeout(r, 100); });
    if (C.markDirty) { /* snapshot via collect happens in push */ }

    // Use original snapshot/cache path via internal hooks we expose
    if (typeof C._switchToPrivate === 'function') {
      return C._switchToPrivate(mapId);
    }
    // Fallback: set view + pull
    var { data, error } = await sb.from('private_maps').select('id, name, map_state, map_revision').eq('id', mapId).maybeSingle();
    if (error || !data) throw error || new Error('Map not found');
    var vs = C.getViewState();
    vs.mode = 'private';
    vs.privateMapId = data.id;
    vs.privateMapName = data.name;
    vs.sharedMapId = null;
    vs.sharedMapName = '';
    vs.sharedMapCode = '';
    // personal alias
    if (vs.mode === 'private') { /* ok */ }
    try {
      localStorage.setItem('reg_slayer_view_v1', JSON.stringify(vs));
    } catch (e) {}
    // apply state
    if (window.applyMapStateFromCloud) {
      window.applyMapStateFromCloud(data.map_state || {});
    } else if (typeof C._applyRemoteState === 'function') {
      C._applyRemoteState(data.map_state, data.map_revision);
    }
    // Write local keys via refresh helper
    try {
      var st = data.map_state || {};
      localStorage.setItem('alabama_hunt_custom_pins', JSON.stringify(st.pins || []));
      localStorage.setItem('alabama_hunt_historical_hunts', JSON.stringify(st.hunts || []));
      localStorage.setItem('alabama_hunt_custom_areas_v1', JSON.stringify(st.customAreas || []));
      localStorage.setItem('alabama_hunt_measured_paths_v1', JSON.stringify(st.measuredPaths || []));
      localStorage.setItem('alabama_hunt_user_stands_v1', JSON.stringify(st.stands || {}));
      localStorage.setItem('alabama_hunt_hidden_locations_v1', JSON.stringify(st.hiddenLocs || []));
      if (window.regSlayerRefreshMapData) window.regSlayerRefreshMapData();
    } catch (e2) {}
    clearPartyMarkers();
    stopSharing();
    updateBrandName();
    refreshMapsUi();
    if (C.persistViewPrefsCloud) { /* optional */ }
  }

  async function renamePrivate(id, name) {
    var sb = window.__rsSb;
    var { data, error } = await sb.rpc('rename_private_map', { p_id: id, p_name: name });
    if (error) throw error;
    var vs = C.getViewState();
    if (vs && vs.privateMapId === id) {
      vs.privateMapName = data.name;
      try { localStorage.setItem('reg_slayer_view_v1', JSON.stringify(vs)); } catch (e) {}
      updateBrandName();
    }
    return data;
  }

  async function createPrivateMap(name) {
    var sb = window.__rsSb;
    var { data, error } = await sb.rpc('create_private_map', { p_name: name });
    if (error) throw error;
    await switchToPrivate(data.id);
    return data;
  }

  function updateBrandName() {
    var vs = C.getViewState && C.getViewState();
    var el = $('brand-map-name');
    if (!el || !vs) return;
    if (vs.mode === 'shared') {
      el.textContent = vs.sharedMapName || 'Shared';
      el.title = 'Shared map · ' + (vs.sharedMapCode || '');
    } else {
      el.textContent = vs.privateMapName || vs.sharedMapName || 'My Map';
      el.title = 'Private map';
    }
  }

  async function refreshMapsUi() {
    updateBrandName();
    updateShareLocBtn();
    var privBox = $('set-private-maps-list');
    var sharedBox = $('set-shared-maps-list');
    var partyBox = $('set-party-members');
    var partySec = $('set-party-section');
    var modeLabel = $('set-map-mode-label');
    var vs = C.getViewState && C.getViewState();
    if (modeLabel && vs) {
      if (vs.mode === 'shared') {
        modeLabel.textContent = 'Viewing: ' + (vs.sharedMapName || 'Shared') + ' (' + (vs.sharedMapCode || '') + ')';
      } else {
        modeLabel.textContent = 'Viewing: ' + (vs.privateMapName || 'My Map') + ' (private)';
      }
    }

    if (privBox) {
      try {
        var pmaps = await listPrivateMaps();
        if (!pmaps.length) privBox.innerHTML = '<p class="settings-hint">No private maps yet.</p>';
        else {
          privBox.innerHTML = pmaps.map(function (m) {
            var active = vs && (vs.mode === 'private' || vs.mode === 'personal') && vs.privateMapId === m.id;
            return '<div class="settings-map-row' + (active ? ' is-active' : '') + '">' +
              '<button type="button" class="settings-subbtn settings-map-open" data-pid="' + m.id + '">' +
              esc(m.name) + (m.is_default ? ' · default' : '') + '</button></div>';
          }).join('');
          privBox.querySelectorAll('[data-pid]').forEach(function (btn) {
            btn.onclick = function () {
              var id = btn.getAttribute('data-pid');
              var row = pmaps.find(function (x) { return x.id === id; });
              openPrivateMapActions(row || { id: id, name: btn.textContent });
            };
          });
        }
      } catch (e) {
        privBox.innerHTML = '<p class="settings-hint">Could not load private maps.</p>';
      }
    }

    if (sharedBox && C.listMySharedMaps) {
      try {
        var maps = await (C.listMySharedMaps ? C.listMySharedMaps() : []);
        // Prefer RPC via original — if not exposed, call rpc
        if (!maps || !maps.length) {
          var sb = window.__rsSb;
          if (sb) {
            var r = await sb.rpc('list_my_shared_maps');
            maps = r.data || [];
          }
        }
        if (!maps.length) sharedBox.innerHTML = '<p class="settings-hint">No shared maps yet.</p>';
        else {
          sharedBox.innerHTML = maps.map(function (m) {
            var active = vs && vs.mode === 'shared' && vs.sharedMapId === m.id;
            return '<div class="settings-map-row' + (active ? ' is-active' : '') + '">' +
              '<button type="button" class="settings-subbtn settings-map-open" data-sid="' + m.id + '">' +
              esc(m.name) + ' <span class="settings-map-code">' + esc(m.code) + '</span></button></div>';
          }).join('');
          sharedBox.querySelectorAll('[data-sid]').forEach(function (btn) {
            btn.onclick = function () {
              var id = btn.getAttribute('data-sid');
              var row = maps.find(function (x) { return x.id === id; });
              openSharedMapActions(row || { id: id, name: 'Map', code: '' });
            };
          });
        }
      } catch (e2) {
        sharedBox.innerHTML = '<p class="settings-hint">Could not load shared maps.</p>';
      }
    }

    if (partySec && partyBox) {
      if (vs && vs.mode === 'shared' && vs.sharedMapId) {
        partySec.style.display = '';
        await loadPartyPrefs(vs.sharedMapId);
        try {
          var members = await listMembers();
          var user = window.__rsUser;
          if (!members.length) partyBox.innerHTML = '<p class="settings-hint">Only you on this map so far.</p>';
          else {
            partyBox.innerHTML = members.map(function (m) {
              var pref = partyPrefs[m.user_id] || {};
              var nick = pref.nickname || '';
              var col = pref.arrow_color || m.arrow_color || '#2563eb';
              var show = pref.show_content !== false && !hiddenContentOwners[m.user_id];
              var self = user && m.user_id === user.id;
              return '<div class="party-member-row" data-uid="' + m.user_id + '">' +
                '<div class="party-member-head">' +
                  '<span class="party-dot" style="background:' + esc(col) + '"></span>' +
                  '<strong>' + esc(memberLabel(m)) + '</strong>' +
                  (self ? ' <span class="settings-hint">(you)</span>' : '') +
                  (m.is_host ? ' · host' : '') +
                '</div>' +
                (!self ? (
                  '<label class="settings-row"><input type="checkbox" class="party-show-content" ' + (show ? 'checked' : '') + '>' +
                  '<span class="sr-text">Show their pins/areas on map</span></label>' +
                  '<div class="settings-inline-row"><input type="text" class="party-nick" placeholder="Nickname" value="' + esc(nick) + '">' +
                  '<input type="color" class="party-color" value="' + esc(col) + '" title="Arrow color" style="width:44px;height:36px;padding:0;border:none;">' +
                  '<button type="button" class="party-save">Save</button></div>'
                ) : '') +
              '</div>';
            }).join('');
            partyBox.querySelectorAll('.party-member-row').forEach(function (row) {
              var uid = row.getAttribute('data-uid');
              var save = row.querySelector('.party-save');
              if (save) save.onclick = function () {
                var nick = (row.querySelector('.party-nick') || {}).value || '';
                var col = (row.querySelector('.party-color') || {}).value || '#2563eb';
                savePartyPref(uid, { nickname: nick.trim() || null, arrow_color: col }).then(function () {
                  pullPresence();
                  refreshMapsUi();
                });
              };
              var chk = row.querySelector('.party-show-content');
              if (chk) chk.onchange = function () {
                if (!chk.checked) hiddenContentOwners[uid] = true;
                else delete hiddenContentOwners[uid];
                try {
                  localStorage.setItem(HIDDEN_MEMBERS_KEY + ':' + vs.sharedMapId, JSON.stringify(hiddenContentOwners));
                } catch (e) {}
                savePartyPref(uid, { show_content: !!chk.checked });
                applyContentOwnerFilter();
              };
            });
          }
        } catch (e3) {
          partyBox.innerHTML = '<p class="settings-hint">Could not load party.</p>';
        }
        // presence pull when settings open
        pullPresence();
      } else {
        partySec.style.display = 'none';
        partyBox.innerHTML = '';
        clearPartyMarkers();
      }
    }

    // overlay party section
    renderOverlayParty();
  }

  function applyContentOwnerFilter() {
    // Filter pins/areas/hunts by ownerId when drawing — set flag for draw hooks
    window.__rsHiddenContentOwners = hiddenContentOwners;
    try {
      if (typeof drawPinsOnMap === 'function') drawPinsOnMap();
      if (typeof drawHuntsOnMap === 'function') drawHuntsOnMap();
      if (typeof drawCustomAreasOnMap === 'function') drawCustomAreasOnMap();
    } catch (e) {}
  }

  function renderOverlayParty() {
    var box = $('ml-party-list');
    var fold = $('ml-fold-body-party');
    var vs = C.getViewState && C.getViewState();
    if (!box) return;
    if (!vs || vs.mode !== 'shared') {
      box.innerHTML = '<p class="settings-hint" style="font-size:11px;">Open a shared map to see party members.</p>';
      return;
    }
    var members = window.__rsPartyMembers || [];
    if (!members.length) {
      box.innerHTML = '<p class="settings-hint" style="font-size:11px;">Loading party…</p>';
      listMembers().then(function () { renderOverlayParty(); refreshMapsUi(); });
      return;
    }
    box.innerHTML = members.map(function (m) {
      var show = !hiddenContentOwners[m.user_id];
      return '<label class="ml-option"><input type="checkbox" data-party-uid="' + m.user_id + '" ' + (show ? 'checked' : '') + '>' +
        '<span class="ml-opt-text">' + esc(memberLabel(m)) + ' <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + esc(memberColor(m)) + ';vertical-align:middle;"></span></span></label>';
    }).join('') +
      '<p class="settings-hint" style="font-size:10px;margin:6px 0 0;">Uncheck hides their pins/areas. Live location always shows while they share.</p>';
    box.querySelectorAll('[data-party-uid]').forEach(function (inp) {
      inp.onchange = function () {
        var uid = inp.getAttribute('data-party-uid');
        if (!inp.checked) hiddenContentOwners[uid] = true;
        else delete hiddenContentOwners[uid];
        try {
          localStorage.setItem(HIDDEN_MEMBERS_KEY + ':' + vs.sharedMapId, JSON.stringify(hiddenContentOwners));
        } catch (e) {}
        applyContentOwnerFilter();
      };
    });
  }

  // ---- Share entity to another map ----
  async function listAllTargetMaps() {
    var out = [];
    try {
      var p = await listPrivateMaps();
      p.forEach(function (m) { out.push({ kind: 'private', id: m.id, name: m.name + ' (private)' }); });
    } catch (e) {}
    try {
      var sb = window.__rsSb;
      var r = await sb.rpc('list_my_shared_maps');
      (r.data || []).forEach(function (m) { out.push({ kind: 'shared', id: m.id, name: m.name + ' · ' + m.code, code: m.code }); });
    } catch (e2) {}
    var vs = C.getViewState && C.getViewState();
    // exclude current
    return out.filter(function (m) {
      if (!vs) return true;
      if (vs.mode === 'shared' && m.kind === 'shared' && m.id === vs.sharedMapId) return false;
      if ((vs.mode === 'private' || vs.mode === 'personal') && m.kind === 'private' && m.id === vs.privateMapId) return false;
      return true;
    });
  }

  async function getMapStateRow(kind, id) {
    var sb = window.__rsSb;
    if (kind === 'private') {
      var { data, error } = await sb.from('private_maps').select('map_state, map_revision').eq('id', id).maybeSingle();
      if (error) throw error;
      return data;
    }
    var r = await sb.from('shared_maps').select('map_state, map_revision').eq('id', id).maybeSingle();
    if (r.error) throw r.error;
    return r.data;
  }

  async function putMapStateRow(kind, id, state, rev) {
    var sb = window.__rsSb;
    if (kind === 'private') {
      var { error } = await sb.from('private_maps').update({
        map_state: state,
        map_revision: rev,
        updated_at: new Date().toISOString()
      }).eq('id', id);
      if (error) throw error;
      return;
    }
    var r = await sb.from('shared_maps').update({
      map_state: state,
      map_revision: rev,
      updated_at: new Date().toISOString()
    }).eq('id', id);
    if (r.error) throw r.error;
  }

  function stampOwner(entity) {
    var user = window.__rsUser;
    var prof = C.getProfile && C.getProfile();
    if (!entity || !user) return entity;
    entity.ownerId = user.id;
    entity.ownerName = (prof && prof.username) || 'me';
    entity.updatedAt = new Date().toISOString();
    return entity;
  }

  async function copyEntityToMap(entity, entityType, target) {
    var row = await getMapStateRow(target.kind, target.id);
    var state = (row && row.map_state) || {};
    state.pins = state.pins || [];
    state.hunts = state.hunts || [];
    state.customAreas = state.customAreas || [];
    state.measuredPaths = state.measuredPaths || [];
    state.stands = state.stands || {};
    var copy = JSON.parse(JSON.stringify(entity));
    copy.id = entityType + '_' + Date.now() + '_' + Math.floor(Math.random() * 9999);
    stampOwner(copy);
    if (entityType === 'pin') state.pins.push(copy);
    else if (entityType === 'hunt') state.hunts.push(copy);
    else if (entityType === 'area') state.customAreas.push(copy);
    else if (entityType === 'stand') {
      // stands keyed by loc — store as pin-like under stands.__shared
      var key = 'shared';
      if (!Array.isArray(state.stands[key])) state.stands[key] = [];
      state.stands[key].push(copy);
    }
    var rev = ((row && row.map_revision) || 0) + 1;
    if (!state.meta) state.meta = {};
    state.meta.revision = rev;
    state.meta.savedAt = new Date().toISOString();
    await putMapStateRow(target.kind, target.id, state, rev);
  }

  async function openShareToMapFlow(entity, defaultType) {
    var targets = await listAllTargetMaps();
    if (!targets.length) {
      alert('No other maps available. Create another private or shared map first.');
      return;
    }
    var opts = targets.map(function (t, i) {
      return '<option value="' + i + '">' + esc(t.name) + '</option>';
    }).join('');
    showSimpleModal('Share to another map',
      '<label class="settings-hint">Which map?</label>' +
      '<select id="rs-share-map-sel" style="width:100%;margin:6px 0 12px;padding:8px;background:#0f140e;color:#e8efe4;border:1px solid #2e3a2a;border-radius:8px;">' + opts + '</select>' +
      '<label class="settings-hint">Save as</label>' +
      '<select id="rs-share-type-sel" style="width:100%;margin:6px 0 4px;padding:8px;background:#0f140e;color:#e8efe4;border:1px solid #2e3a2a;border-radius:8px;">' +
        '<option value="pin"' + (defaultType === 'pin' ? ' selected' : '') + '>Pin</option>' +
        '<option value="hunt"' + (defaultType === 'hunt' ? ' selected' : '') + '>Hunt</option>' +
        '<option value="stand"' + (defaultType === 'stand' ? ' selected' : '') + '>Stand</option>' +
        (entity && entity.ring ? '<option value="area">Area</option>' : '') +
      '</select>' +
      '<p class="settings-hint">Keeps color, notes, and other details. Appears on the target map only (stays on this map too).</p>',
      [
        {
          label: 'Share',
          primary: true,
          close: false,
          onClick: function () {
            var mi = parseInt(($('rs-share-map-sel') || {}).value, 10);
            var typ = ($('rs-share-type-sel') || {}).value || 'pin';
            var t = targets[mi];
            if (!t) return;
            var ent = entity || {};
            // build minimal entity if only lat/lng
            if (!ent.id) {
              ent = {
                id: 'tmp',
                name: ent.name || 'Shared spot',
                lat: ent.lat,
                lng: ent.lng,
                color: ent.color || '#e59a18',
                notes: ent.notes || '',
                isPin: typ === 'pin'
              };
            }
            copyEntityToMap(ent, typ, t).then(function () {
              var modal = $('rs-simple-modal');
              if (modal) modal.remove();
              alert('Saved to: ' + t.name);
            }).catch(function (e) {
              alert(e.message || String(e));
            });
          }
        },
        { label: 'Cancel' }
      ]
    );
  }

  function openShareLocationChooser(lat, lng, label, entity) {
    showSimpleModal('Share location',
      '<p class="settings-hint">' + esc(label || 'This spot') + '</p>',
      [
        {
          label: 'Share to another map',
          primary: true,
          onClick: function () {
            openShareToMapFlow(entity || { lat: lat, lng: lng, name: label || 'Spot' }, 'pin');
          }
        },
        {
          label: 'Copy location',
          onClick: function () {
            if (typeof shareLocationLink === 'function') shareLocationLink(lat, lng, label);
            else if (typeof googleMapsShareUrl === 'function') {
              var u = googleMapsShareUrl(lat, lng);
              if (navigator.clipboard) navigator.clipboard.writeText(u);
              else window.prompt('Copy:', u);
            }
          }
        },
        { label: 'Cancel' }
      ]
    );
  }

  function openShareMyLocationChooser() {
    var lat = (typeof userLat !== 'undefined') ? userLat : null;
    var lng = (typeof userLng !== 'undefined') ? userLng : null;
    function go(la, lo) {
      showSimpleModal('Share my location',
        '<p class="settings-hint">Choose how to share your GPS position.</p>',
        [
          {
            label: 'Share to another map',
            primary: true,
            onClick: function () {
              openShareToMapFlow({ lat: la, lng: lo, name: 'My location' }, 'pin');
            }
          },
          {
            label: 'Copy location',
            onClick: function () {
              if (typeof shareLocationLink === 'function') shareLocationLink(la, lo, 'My location');
              else if (typeof googleMapsShareUrl === 'function') {
                var u = googleMapsShareUrl(la, lo);
                if (navigator.clipboard) navigator.clipboard.writeText(u);
                else window.prompt('Copy:', u);
              }
            }
          },
          {
            label: sharing ? 'Stop sharing with party' : 'Share with party (live)',
            onClick: function () {
              if (!sharing) startSharing();
              else stopSharing();
            }
          },
          { label: 'Cancel' }
        ]
      );
    }
    if (lat != null && lng != null) go(lat, lng);
    else if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function (pos) {
        go(pos.coords.latitude, pos.coords.longitude);
      }, function () { alert('Could not get location'); });
    } else alert('Location unavailable');
  }

  // Hook map dot share
  var _origHandleMapDot = window.handleMapDotAction;
  window.handleMapDotAction = function (act) {
    if (act === 'share') {
      openShareLocationChooser(clickLat, clickLng, 'Map spot', { lat: clickLat, lng: clickLng, name: 'Map spot' });
      return false;
    }
    if (typeof _origHandleMapDot === 'function') return _origHandleMapDot(act);
  };

  var _origShareSaved = window.shareSavedPinLocation;
  window.shareSavedPinLocation = function (id) {
    var loc = (typeof locations !== 'undefined') ? locations.find(function (l) { return String(l.id) === String(id); }) : null;
    if (!loc) {
      if (_origShareSaved) return _origShareSaved(id);
      return false;
    }
    openShareLocationChooser(loc.lat, loc.lng, loc.name || 'Pin', loc);
    return false;
  };

  var _origShareLoc = window.shareLocationLink;
  // keep original for clipboard path

  // Stamp owner on saves
  var _origRsChanged = window.regSlayerMapDataChanged;
  window.regSlayerMapDataChanged = function () {
    try {
      // tag newest pin without owner
      var pins = JSON.parse(localStorage.getItem('alabama_hunt_custom_pins') || '[]');
      var user = window.__rsUser;
      var prof = C.getProfile && C.getProfile();
      var changed = false;
      pins.forEach(function (p) {
        if (p && !p.ownerId && user) {
          p.ownerId = user.id;
          p.ownerName = (prof && prof.username) || 'me';
          changed = true;
        }
      });
      if (changed) localStorage.setItem('alabama_hunt_custom_pins', JSON.stringify(pins));
      var areas = JSON.parse(localStorage.getItem('alabama_hunt_custom_areas_v1') || '[]');
      var ca = false;
      areas.forEach(function (a) {
        if (a && !a.ownerId && user) {
          a.ownerId = user.id;
          a.ownerName = (prof && prof.username) || 'me';
          ca = true;
        }
      });
      if (ca) localStorage.setItem('alabama_hunt_custom_areas_v1', JSON.stringify(areas));
    } catch (e) {}
    if (typeof _origRsChanged === 'function') _origRsChanged();
  };

  // Filter draws by hidden owners
  var _origDrawPins = null;
  function installDrawFilters() {
    if (typeof drawPinsOnMap === 'function' && !drawPinsOnMap._rsWrapped) {
      _origDrawPins = drawPinsOnMap;
      window.drawPinsOnMap = function () {
        var hidden = window.__rsHiddenContentOwners || {};
        var backup;
        if (typeof locations !== 'undefined' && Object.keys(hidden).length) {
          backup = locations.slice();
          // temporarily filter pins for draw — drawPins filters isPin from locations
          // We'll filter inside by monkeypatching locations filter
        }
        var r = _origDrawPins.apply(this, arguments);
        return r;
      };
      // Simpler: patch after draw clears and re-filter layers — skip, use pre-filter on locations isPin
      window.drawPinsOnMap = function () {
        if (!window.map || !window.pinMarkerGroup) return _origDrawPins.apply(this, arguments);
        var hidden = window.__rsHiddenContentOwners || {};
        var user = window.__rsUser;
        pinMarkerGroup.clearLayers();
        if (typeof locations === 'undefined') return;
        locations.filter(function (l) {
          if (!l.isPin) return false;
          if (l.ownerId && hidden[l.ownerId] && (!user || l.ownerId !== user.id)) return false;
          return true;
        }).forEach(function (loc) {
          // reuse original single-pin draw by temporary call is hard — call original logic
        });
        // Fall back to original then remove filtered
        _origDrawPins.apply(this, arguments);
        try {
          pinMarkerGroup.eachLayer(function (layer) {
            // can't easily map — re-run original only
          });
        } catch (e) {}
      };
      // Actually keep original drawPinsOnMap and filter at data level before draw:
      window.drawPinsOnMap = function () {
        var hidden = window.__rsHiddenContentOwners || {};
        var user = window.__rsUser;
        var removed = [];
        if (typeof locations !== 'undefined' && Object.keys(hidden).length) {
          for (var i = locations.length - 1; i >= 0; i--) {
            var l = locations[i];
            if (l && l.isPin && l.ownerId && hidden[l.ownerId] && (!user || l.ownerId !== user.id)) {
              removed.push(locations.splice(i, 1)[0]);
            }
          }
        }
        try {
          return _origDrawPins.apply(this, arguments);
        } finally {
          if (removed.length) {
            removed.forEach(function (x) { locations.push(x); });
          }
        }
      };
      window.drawPinsOnMap._rsWrapped = true;
    }
  }

  // Wire settings UI extras after DOM ready
  function wireExtraSettings() {
    var createPriv = $('set-create-private-btn');
    if (createPriv) createPriv.onclick = function () {
      var name = ($('set-create-private-name') && $('set-create-private-name').value || '').trim();
      if (!name) { alert('Enter a name for your private map'); return; }
      createPrivateMap(name).then(function (m) {
        if ($('set-create-private-name')) $('set-create-private-name').value = '';
        alert('Private map created: ' + m.name);
        refreshMapsUi();
      }).catch(function (e) { alert(e.message || e); });
    };
    var renameCur = $('set-rename-current-btn');
    if (renameCur) renameCur.onclick = function () {
      var vs = C.getViewState && C.getViewState();
      if (!vs) return;
      var cur = vs.mode === 'shared' ? vs.sharedMapName : (vs.privateMapName || 'My Map');
      var n = prompt('Rename current map:', cur);
      if (!n || !n.trim()) return;
      var sb = window.__rsSb;
      if (vs.mode === 'shared' && vs.sharedMapId) {
        sb.rpc('rename_shared_map', { p_id: vs.sharedMapId, p_name: n.trim() }).then(function (r) {
          if (r.error) throw r.error;
          vs.sharedMapName = r.data.name;
          try { localStorage.setItem('reg_slayer_view_v1', JSON.stringify(vs)); } catch (e) {}
          updateBrandName();
          refreshMapsUi();
        }).catch(function (e) { alert(e.message || e); });
      } else if (vs.privateMapId) {
        renamePrivate(vs.privateMapId, n.trim()).then(refreshMapsUi).catch(function (e) { alert(e.message || e); });
      } else alert('Open a map first');
    };
    var arrowInp = $('set-my-arrow-color');
    if (arrowInp) {
      arrowInp.value = myArrowColor;
      arrowInp.onchange = function () {
        myArrowColor = arrowInp.value || '#e11d1d';
        try { localStorage.setItem(ARROW_KEY, myArrowColor); } catch (e) {}
        // persist profile
        var sb = window.__rsSb;
        var user = window.__rsUser;
        if (sb && user) {
          sb.from('profiles').update({ arrow_color: myArrowColor }).eq('id', user.id).then(function () {});
        }
        // recolor own GPS if possible
        try {
          if (typeof setGpsMarker === 'function' && typeof userLat !== 'undefined' && userLat != null) {
            // patch buildGpsMarkerIcon via CSS variable
            document.documentElement.style.setProperty('--gps-arrow-color', myArrowColor);
            setGpsMarker(userLat, userLng);
          }
        } catch (e2) {}
      };
      document.documentElement.style.setProperty('--gps-arrow-color', myArrowColor);
    }
    var shareBtn = $('share-loc-btn');
    if (shareBtn) {
      // Popup: share to map / copy location / party live share
      shareBtn.onclick = function (ev) {
        if (ev) { try { ev.preventDefault(); ev.stopPropagation(); } catch (e0) {} }
        openShareMyLocationChooser();
        return false;
      };
    }
    // gps long-press / secondary: after snap offer share? User asked: when clicking current location arrow icon on map
    // Own GPS marker is non-interactive. Make share via toolbar. Also hook snapToGPS secondary menu:
  }

  // Patch buildGpsMarkerIcon color via CSS if path fill hardcoded — override after load
  var _origBuildGps = null;
  function installGpsColor() {
    if (typeof buildGpsMarkerIcon === 'function' && !buildGpsMarkerIcon._rsColor) {
      _origBuildGps = buildGpsMarkerIcon;
      window.buildGpsMarkerIcon = function (headingDeg) {
        var icon = _origBuildGps(headingDeg);
        try {
          if (icon && icon.options && icon.options.html) {
            icon.options.html = icon.options.html.replace(/#e11d1d/g, myArrowColor).replace(/#ff4d4d/g, myArrowColor);
          }
        } catch (e) {}
        return icon;
      };
      window.buildGpsMarkerIcon._rsColor = true;
    }
  }

  // Capture sb + user from auth client used by main module
  function bindClientRefs() {
    // Create our own client with same keys if needed
    if (!window.__rsSb && window.supabase && window.supabase.createClient) {
      try {
        // reuse session from existing
        var url = 'https://grvhmktqzrivbqbczkii.supabase.co';
        var key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdydmhta3RxenJpdmJxYmN6a2lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3MDQ0MTIsImV4cCI6MjEwMTI4MDQxMn0.fFfrS-7w45IzxwOvvyYDB5ngLnyTz-Ru7XVL5LZXm4o';
        window.__rsSb = window.supabase.createClient(url, key, {
          auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage }
        });
      } catch (e) {}
    }
    if (window.__rsSb) {
      window.__rsSb.auth.getSession().then(function (res) {
        if (res.data && res.data.session) window.__rsUser = res.data.session.user;
      });
    }
  }

  // Hook maps tab refresh
  window.addEventListener('regslayer-maps-tab', function () {
    refreshMapsUi();
  });

  // After auth
  function onReady() {
    bindClientRefs();
    wireExtraSettings();
    installGpsColor();
    installDrawFilters();
    // Restore sharing state
    try {
      var raw = localStorage.getItem(PRESENCE_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && o.on && o.started && (Date.now() - o.started) < MAX_SHARE_MS) {
          shareStartedAt = o.started;
          // resume only if still on that shared map
          var vs = C.getViewState && C.getViewState();
          if (vs && vs.mode === 'shared' && vs.sharedMapId === o.mapId) startSharing();
          else localStorage.removeItem(PRESENCE_KEY);
        }
      }
    } catch (e) {}
    setTimeout(function () {
      refreshMapsUi();
      pullPresence();
      // presence poll when on shared
      setInterval(function () {
        var vs = C.getViewState && C.getViewState();
        if (vs && vs.mode === 'shared' && document.visibilityState === 'visible') pullPresence();
      }, 12000);
    }, 800);
  }

  if (C.authReady && C.authReady.then) {
    C.authReady.then(onReady).catch(onReady);
  } else {
    setTimeout(onReady, 1200);
  }

  // Public API
  window.RegSlayerParty = {
    refreshMapsUi: refreshMapsUi,
    toggleSharing: toggleSharing,
    startSharing: startSharing,
    stopSharing: stopSharing,
    openShareToMapFlow: openShareToMapFlow,
    openShareLocationChooser: openShareLocationChooser,
    openShareMyLocationChooser: openShareMyLocationChooser,
    listPrivateMaps: listPrivateMaps,
    createPrivateMap: createPrivateMap,
    switchToPrivate: switchToPrivate,
    isSharing: function () { return sharing; },
    stampOwner: stampOwner
  };

  // Multi-map on create pin: inject checkboxes after save forms appear — hook savePinFromMap
  var _origSavePin = null;
  function waitForSavePin() {
    if (typeof savePinFromMap === 'function' && !savePinFromMap._rsMulti) {
      _origSavePin = savePinFromMap;
      window.savePinFromMap = function () {
        var r = _origSavePin.apply(this, arguments);
        // After save, offer multi-map if checked
        setTimeout(function () {
          var boxes = document.querySelectorAll('.rs-extra-map-chk:checked');
          if (!boxes.length) return;
          try {
            var pins = JSON.parse(localStorage.getItem('alabama_hunt_custom_pins') || '[]');
            var last = pins[pins.length - 1];
            if (!last) return;
            boxes.forEach(function (chk) {
              var kind = chk.getAttribute('data-kind');
              var id = chk.getAttribute('data-id');
              copyEntityToMap(last, 'pin', { kind: kind, id: id }).catch(function (e) { console.warn(e); });
            });
          } catch (e) {}
        }, 100);
        return r;
      };
      savePinFromMap._rsMulti = true;
    }
  }
  setInterval(waitForSavePin, 2000);

  // Pin form multi-map targets
  window.rsFillExtraMapChecks = async function (containerId) {
    var el = $(containerId);
    if (!el) return;
    el.innerHTML = '<span class="settings-hint">Also save to:</span>';
    try {
      var maps = await listAllTargetMaps();
      maps.forEach(function (m) {
        var lab = document.createElement('label');
        lab.className = 'settings-row';
        lab.innerHTML = '<input type="checkbox" class="rs-extra-map-chk" data-kind="' + m.kind + '" data-id="' + m.id + '"><span class="sr-text">' + esc(m.name) + '</span>';
        el.appendChild(lab);
      });
    } catch (e) {}
  };
})();
