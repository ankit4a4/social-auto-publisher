(function () {
  let websites = []; // cached list of the user's websites
  let socialAccounts = []; // cached list of the user's connected social accounts (shared pool)
  let selectedWebsiteId = null; // which website's detail page is currently open
  let editingWebsiteId = null; // website being edited in the Edit modal
  let wizardWebsiteId = null; // website being built in the Add-Website wizard
  let wizardWebsite = null; // latest known copy of that website (updated as wizard progresses)
  let currentView = 'dashboard'; // 'dashboard' | 'detail'
  const statusByWebsite = new Map(); // websiteId -> latest /api/queue/status row

  const PLATFORM_META = {
    FACEBOOK: { key: 'facebook', path: 'facebook', label: 'Facebook', short: 'FB' },
    INSTAGRAM: { key: 'instagram', path: 'instagram', label: 'Instagram', short: 'IG' },
    LINKEDIN: { key: 'linkedin', path: 'linkedin', label: 'LinkedIn', short: 'LI' },
  };

  // ---------- helpers ----------

  async function api(url, options = {}) {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Request failed');
    }
    return data;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function timeAgo(dateStr) {
    if (!dateStr) return 'never';
    const diffMs = Date.now() - new Date(dateStr).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function statusBadge(status) {
    const map = {
      connected: ['badge-success', 'Connected'],
      pending: ['badge-warn', 'Pending'],
      error: ['badge-danger', 'Error'],
    };
    const [cls, label] = map[status] || ['badge-neutral', status];
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function formatGap(minutes) {
    if (!minutes) return '-';
    if (minutes % 1440 === 0) return `${minutes / 1440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }

  function formatCountdown(ms) {
    if (ms <= 0) return 'Posting now...';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function showAlert(el, message) {
    el.textContent = message;
    el.classList.remove('hidden');
  }
  function hideAlert(el) {
    el.classList.add('hidden');
  }

  // ---------- view switching (Dashboard grid <-> single website detail) ----------

  function showView(view) {
    currentView = view;
    const dashEl = document.getElementById('dashboardView');
    const detailEl = document.getElementById('detailView');
    const navDash = document.getElementById('navDashboard');

    if (view === 'dashboard') {
      dashEl.classList.remove('hidden');
      detailEl.classList.add('hidden');
      navDash.classList.add('active');
    } else {
      dashEl.classList.add('hidden');
      detailEl.classList.remove('hidden');
      navDash.classList.remove('active');
    }
    renderSidebarList();
  }

  document.getElementById('navDashboard').addEventListener('click', () => showView('dashboard'));
  document.getElementById('backToDashboard').addEventListener('click', () => showView('dashboard'));

  // ---------- auth ----------

  async function loadCurrentUser() {
    try {
      const { user } = await api('/api/auth/me');
      document.getElementById('userEmail').textContent = user.username;
    } catch (err) {
      window.location.href = '/login.html';
    }
  }

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login.html';
    }
  });

  // ---------- websites (sidebar + dashboard cache) ----------

  async function loadWebsites() {
    const listEl = document.getElementById('websiteList');
    try {
      const data = await api('/api/websites');
      websites = data.websites;
      document.getElementById('dashWebsiteCount').textContent = websites.length;

      // Keep the current selection if it still exists, otherwise fall back
      // to the first website (or nothing, if the list is empty).
      const stillExists = websites.some((w) => w._id === selectedWebsiteId);
      if (!stillExists) {
        selectedWebsiteId = websites.length > 0 ? websites[0]._id : null;
      }

      renderSidebarList();
      renderDetail();
      renderDashboard();
    } catch (err) {
      listEl.innerHTML = `<div class="empty-state">Could not load websites: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderSidebarList() {
    const listEl = document.getElementById('websiteList');

    if (websites.length === 0) {
      listEl.innerHTML = '<div class="empty-state">No websites yet. Click "+ Add Website" to get started.</div>';
      return;
    }

    listEl.innerHTML = websites
      .map((w) => {
        const auto = w.settings.autoPostingEnabled
          ? '<span class="badge badge-success">Auto ON</span>'
          : '<span class="badge badge-neutral">Auto OFF</span>';
        const active = currentView === 'detail' && w._id === selectedWebsiteId ? ' active' : '';
        return `
          <div class="website-list-item${active}" data-id="${w._id}">
            <div class="wli-name">${escapeHtml(w.name)}</div>
            <div class="wli-url">${escapeHtml(w.url)}</div>
            <div class="wli-meta">${statusBadge(w.status)} ${auto}</div>
          </div>
        `;
      })
      .join('');

    listEl.querySelectorAll('.website-list-item').forEach((el) => {
      el.addEventListener('click', () => selectWebsite(el.dataset.id));
    });
  }

  function selectWebsite(id) {
    selectedWebsiteId = id;
    showView('detail');
    renderDetail();
    refreshStatuses();
    loadQueueForSelected();
  }

  // ---------- Dashboard: card grid for every website ----------

  function renderDashboard() {
    const grid = document.getElementById('dashboardGrid');
    const emptyEl = document.getElementById('dashboardEmpty');

    if (websites.length === 0) {
      grid.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }
    emptyEl.classList.add('hidden');

    grid.innerHTML = websites.map((w) => renderDashCard(w)).join('');

    grid.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => selectWebsite(btn.dataset.view));
    });
    grid.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => openEditWebsiteModal(btn.dataset.edit));
    });
    grid.querySelectorAll('[data-card-toggle-auto]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.cardToggleAuto;
        const enabled = btn.dataset.enabled !== 'true';
        setAutoPosting(id, enabled);
      });
    });
    grid.querySelectorAll('[data-card-delete]').forEach((btn) => {
      btn.addEventListener('click', () => deleteWebsite(btn.dataset.cardDelete));
    });

    tickCountdowns();
  }

  function renderDashCard(w) {
    const s = statusByWebsite.get(w._id);
    const social = w.settings.social || {};
    const socialChips = Object.entries(PLATFORM_META)
      .map(([, meta]) => {
        const on = !!(social[meta.key] && social[meta.key].enabled && social[meta.key].socialAccountId);
        return `<span class="dash-social-chip${on ? ' on' : ''}">${meta.short}</span>`;
      })
      .join('');

    const processedToday = s ? s.processedToday : w.runtime.processedToday;
    const dailyLimit = s ? s.dailyLimit : w.settings.dailyLimit;
    const autoOn = w.settings.autoPostingEnabled;

    let timerCls = 'dash-timer';
    let timerInner = '';
    if (!autoOn) {
      timerCls += ' timer-off';
      timerInner = `<span class="timer-value">Auto posting is off</span>`;
    } else if (s && s.nextPostAt) {
      timerInner = `<span class="timer-value" data-countdown-target="${s.nextPostAt}">calculating...</span>`;
    } else {
      timerCls += ' timer-off';
      timerInner = `<span class="timer-value">Nothing queued yet</span>`;
    }

    return `
      <div class="dash-card" data-id="${w._id}">
        <div class="dash-card-head">
          <div>
            <h3>${escapeHtml(w.name)}</h3>
            <div class="url">${escapeHtml(w.url)}</div>
          </div>
          ${statusBadge(w.status)}
        </div>

        <div class="dash-card-badges">
          ${autoOn ? '<span class="badge badge-success">Auto ON</span>' : '<span class="badge badge-neutral">Auto OFF</span>'}
        </div>

        <div class="dash-social-row">${socialChips}</div>

        <div class="dash-card-stats">
          <div class="dash-stat-box">
            <div class="num">${processedToday} / ${dailyLimit}</div>
            <div class="lbl">Posts Today</div>
          </div>
          <div class="dash-stat-box">
            <div class="num">Every ${formatGap(w.settings.postingGapMinutes)}</div>
            <div class="lbl">Posting Gap</div>
          </div>
        </div>

        <div class="${timerCls}">
          <span class="timer-label">Next Post</span>
          ${timerInner}
        </div>

        <div class="dash-card-actions">
          <button class="btn btn-primary btn-sm" data-view="${w._id}">View</button>
          <button class="btn btn-secondary btn-sm" data-edit="${w._id}">Edit</button>
        </div>
        <div class="dash-card-actions">
          <button class="btn btn-secondary btn-sm" data-card-toggle-auto="${w._id}" data-enabled="${autoOn}">${autoOn ? 'Stop' : 'Start'}</button>
          <button class="btn btn-danger btn-sm" data-card-delete="${w._id}">Delete</button>
        </div>
      </div>
    `;
  }

  // Updates every live countdown on screen (dashboard cards + the detail
  // page's next-post banner) once a second, purely from the timestamp
  // already stashed in data-countdown-target - no network call needed.
  function tickCountdowns() {
    document.querySelectorAll('[data-countdown-target]').forEach((el) => {
      const target = el.dataset.countdownTarget;
      const diff = new Date(target).getTime() - Date.now();
      const wrap = el.closest('.dash-timer, .next-post-banner');
      el.textContent = formatCountdown(diff);
      if (wrap) {
        if (diff <= 0) {
          wrap.classList.add('timer-due');
        } else {
          wrap.classList.remove('timer-due');
        }
      }
    });
  }

  // ---------- live status polling (drives both dashboard + detail timers) ----------

  async function refreshStatuses() {
    try {
      const { websites: statuses } = await api('/api/queue/status');
      statusByWebsite.clear();
      statuses.forEach((s) => statusByWebsite.set(s.websiteId, s));
      renderDashboard();
      if (currentView === 'detail' && selectedWebsiteId) {
        renderDetailStatus();
      }
    } catch (err) {
      console.error('Could not refresh status:', err.message);
    }
  }

  // ---------- website detail page ----------

  function currentWebsite() {
    return websites.find((w) => w._id === selectedWebsiteId) || null;
  }

  function renderDetail() {
    const website = currentWebsite();
    const emptyEl = document.getElementById('noWebsiteSelected');
    const detailEl = document.getElementById('websiteDetail');

    if (!website) {
      emptyEl.classList.remove('hidden');
      detailEl.classList.add('hidden');
      return;
    }

    emptyEl.classList.add('hidden');
    detailEl.classList.remove('hidden');

    document.getElementById('detailName').textContent = website.name;
    document.getElementById('detailUrl').textContent = website.url;

    const auto = website.settings.autoPostingEnabled
      ? '<span class="badge badge-success">Auto Posting: ON</span>'
      : '<span class="badge badge-neutral">Auto Posting: OFF</span>';
    document.getElementById('detailMeta').innerHTML = `${statusBadge(website.status)} ${auto}`;

    const s = website.settings;
    const categoryChip = s.categoryMode === 'category' && s.categoryName
      ? `Category: ${escapeHtml(s.categoryName)}`
      : 'Category: All';
    document.getElementById('detailSettingsSummary').innerHTML = `
      <span class="chip">${categoryChip}</span>
      <span class="chip">Gap: ${formatGap(s.postingGapMinutes)}</span>
      <span class="chip">Daily limit: ${s.dailyLimit}</span>
      <span class="chip">Latest articles: ${s.latestArticleLimit}</span>
      <span class="chip">${escapeHtml(s.timezone)}</span>
    `;

    const errEl = document.getElementById('detailLastError');
    if (website.status === 'error' && website.lastError) {
      errEl.textContent = website.lastError;
      errEl.classList.remove('hidden');
    } else {
      errEl.classList.add('hidden');
    }

    const startBtn = document.getElementById('detailStartBtn');
    const stopBtn = document.getElementById('detailStopBtn');
    if (website.settings.autoPostingEnabled) {
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
    } else {
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
    }

    renderSocialGridInto(website, {
      grid: document.getElementById('detailSocialGrid'),
      pickerWrap: document.getElementById('socialPickerWrap'),
      alertEl: document.getElementById('socialConnectAlert'),
      onLocalUpdate: (updatedWebsite) => {
        // Keep the cached list in sync so re-renders (dashboard, sidebar)
        // reflect the change immediately without waiting on a full reload.
        const idx = websites.findIndex((w) => w._id === updatedWebsite._id);
        if (idx !== -1) websites[idx] = updatedWebsite;
        renderDashboard();
      },
    });

    renderDetailStatus();
  }

  function renderDetailStatus() {
    const website = currentWebsite();
    if (!website) return;
    const s = statusByWebsite.get(website._id);

    const bannerEl = document.getElementById('detailNextPostBanner');
    if (!website.settings.autoPostingEnabled) {
      bannerEl.classList.add('hidden-banner');
      bannerEl.innerHTML = '';
    } else if (s && s.nextPostAt) {
      bannerEl.classList.remove('hidden-banner');
      bannerEl.innerHTML = `<span>Next post</span><span class="timer-value" data-countdown-target="${s.nextPostAt}">calculating...</span>`;
    } else {
      bannerEl.classList.remove('hidden-banner');
      bannerEl.innerHTML = `<span>Next post</span><span class="timer-value">Nothing queued yet</span>`;
    }
    tickCountdowns();

    const listEl = document.getElementById('detailStatus');
    if (!s) {
      listEl.innerHTML = '<div class="empty-state">No status yet.</div>';
      return;
    }

    const pct = s.dailyLimit > 0 ? Math.min(100, Math.round((s.processedToday / s.dailyLimit) * 100)) : 0;
    const runLabel = s.autoPostingEnabled
      ? {
          fetching: 'Fetching articles...',
          waiting: 'Waiting for next article...',
          publishing: s.currentSocialPlatform ? `Publishing to ${s.currentSocialPlatform}...` : 'Publishing...',
          error: 'Error',
          idle: 'Idle',
        }[s.status] || s.status
      : 'Auto posting is off';

    listEl.innerHTML = `
      <div class="status-card">
        <div class="status-row"><span class="label">Auto Posting</span>${s.autoPostingEnabled ? '<span class="badge badge-success">RUNNING</span>' : '<span class="badge badge-neutral">OFF</span>'}</div>
        <div class="status-row"><span class="label">Status</span><span>${escapeHtml(runLabel)}</span></div>
        ${s.currentArticleTitle ? `<div class="status-row"><span class="label">Current Article</span><span>${escapeHtml(s.currentArticleTitle)}</span></div>` : ''}
        <div class="status-row"><span class="label">Articles Processed Today</span><span>${s.processedToday} / ${s.dailyLimit}</span></div>
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="status-row" style="margin-top:8px;"><span class="label">Last Run</span><span>${timeAgo(s.lastRunAt)}</span></div>
      </div>
    `;
  }

  document.getElementById('detailEditBtn').addEventListener('click', () => {
    if (selectedWebsiteId) openEditWebsiteModal(selectedWebsiteId);
  });
  document.getElementById('detailDeleteBtn').addEventListener('click', () => {
    if (selectedWebsiteId) deleteWebsite(selectedWebsiteId);
  });
  document.getElementById('detailStartBtn').addEventListener('click', () => {
    if (selectedWebsiteId) setAutoPosting(selectedWebsiteId, true);
  });
  document.getElementById('detailStopBtn').addEventListener('click', () => {
    if (selectedWebsiteId) setAutoPosting(selectedWebsiteId, false);
  });

  async function setAutoPosting(id, enabled) {
    try {
      await api(`/api/websites/${id}/settings`, {
        method: 'PUT',
        body: JSON.stringify({ autoPostingEnabled: enabled }),
      });
      await loadWebsites();
      await refreshStatuses();
    } catch (err) {
      alert(`Could not ${enabled ? 'start' : 'stop'} auto posting: ${err.message}`);
    }
  }

  async function deleteWebsite(id) {
    const website = websites.find((w) => w._id === id);
    if (!website) return;
    if (!confirm(`Delete "${website.name}"? This also clears its queue.`)) return;

    try {
      await api(`/api/websites/${id}`, { method: 'DELETE' });
      if (selectedWebsiteId === id) {
        selectedWebsiteId = null; // loadWebsites() will pick a new default
        showView('dashboard');
      }
      await loadWebsites();
      await refreshStatuses();
      await loadQueueForSelected();
    } catch (err) {
      alert(`Could not delete website: ${err.message}`);
    }
  }

  // ---------- social accounts (per-website connect cards, reusable) ----------

  async function loadSocialAccounts() {
    try {
      const { accounts } = await api('/api/social/accounts');
      socialAccounts = accounts;
    } catch (err) {
      console.error('Could not load social accounts:', err.message);
    }
  }

  // Renders one card per platform for the given website into whichever
  // grid/picker/alert elements are passed in - this is shared by the
  // detail page AND step 3 of the Add-Website wizard, since the behaviour
  // (each website has its own, fully independent, social connections) is
  // identical in both places.
  function renderSocialGridInto(website, els) {
    const { grid, pickerWrap, alertEl, onLocalUpdate } = els;
    const social = website.settings.social || {};

    grid.innerHTML = Object.entries(PLATFORM_META)
      .map(([platform, meta]) => {
        const mapping = social[meta.key] || { enabled: false, socialAccountId: null };
        const account = mapping.socialAccountId
          ? socialAccounts.find((a) => a._id === mapping.socialAccountId)
          : null;

        if (account) {
          const label = account.username ? `@${escapeHtml(account.username)}` : escapeHtml(account.accountName);
          const statusCls = account.status === 'connected' ? 'badge-success' : 'badge-danger';
          const statusLabel = account.status === 'connected' ? 'Connected' : 'Error';
          return `
            <div class="social-card">
              <div class="platform-name">${meta.label}</div>
              <div class="account-name">${escapeHtml(account.accountName)}${account.username ? ` <span class="section-sub">(${label})</span>` : ''}</div>
              <div style="margin:8px 0;"><span class="badge ${statusCls}">${statusLabel}</span></div>
              ${account.lastError ? `<div class="hint" style="color:var(--danger);margin-bottom:8px;">${escapeHtml(account.lastError)}</div>` : ''}
              <div class="toggle-row" style="padding:0; border:none;">
                <span>Post to ${meta.label}</span>
                <label class="switch">
                  <input type="checkbox" data-toggle-platform="${meta.key}" data-account-id="${account._id}" ${mapping.enabled ? 'checked' : ''} />
                  <span class="slider"></span>
                </label>
              </div>
              <div class="social-actions">
                <button class="btn btn-secondary btn-sm" data-reconnect="${meta.path}">Reconnect</button>
                <button class="btn btn-danger btn-sm" data-disconnect="${account._id}">Disconnect</button>
              </div>
            </div>
          `;
        }

        // Not connected yet for this website. If the user already has other
        // connected accounts on this platform (e.g. connected for a
        // different website), offer to reuse one instead of forcing a
        // fresh OAuth round-trip every single time.
        const reusable = socialAccounts.filter((a) => a.platform === platform && a.status === 'connected');

        return `
          <div class="social-card">
            <div class="platform-name">${meta.label}</div>
            <div class="account-name">Not connected</div>
            <div class="social-actions">
              <button class="btn btn-primary btn-sm" data-connect="${meta.path}">Connect ${meta.label}</button>
            </div>
            ${
              reusable.length > 0
                ? `
              <div class="reuse-row">
                <select data-reuse-select="${meta.key}">
                  ${reusable.map((a) => `<option value="${a._id}">${escapeHtml(a.username ? '@' + a.username : a.accountName)}</option>`).join('')}
                </select>
                <button class="btn btn-secondary btn-sm" data-reuse-use="${meta.key}">Use existing</button>
              </div>
            `
                : ''
            }
          </div>
        `;
      })
      .join('');

    grid.querySelectorAll('[data-connect]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.location.href = `/api/social/${btn.dataset.connect}/connect?websiteId=${website._id}`;
      });
    });
    grid.querySelectorAll('[data-reconnect]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.location.href = `/api/social/${btn.dataset.reconnect}/connect?websiteId=${website._id}`;
      });
    });
    grid.querySelectorAll('[data-disconnect]').forEach((btn) => {
      btn.addEventListener('click', () => disconnectSocialAccount(btn.dataset.disconnect, website, els));
    });
    grid.querySelectorAll('[data-toggle-platform]').forEach((input) => {
      input.addEventListener('change', () => {
        setSocialEnabled(website._id, input.dataset.togglePlatform, input.checked, input.dataset.accountId, els);
      });
    });
    grid.querySelectorAll('[data-reuse-use]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.reuseUse;
        const select = grid.querySelector(`[data-reuse-select="${key}"]`);
        if (select && select.value) {
          setSocialEnabled(website._id, key, true, select.value, els);
        }
      });
    });
  }

  async function setSocialEnabled(websiteId, platformKey, enabled, socialAccountId, els) {
    try {
      const { website } = await api(`/api/websites/${websiteId}/social-settings`, {
        method: 'PUT',
        body: JSON.stringify({ [platformKey]: { enabled, socialAccountId } }),
      });
      renderSocialGridInto(website, els);
      if (els.onLocalUpdate) els.onLocalUpdate(website);
    } catch (err) {
      showAlert(els.alertEl, err.message);
    }
  }

  async function disconnectSocialAccount(id, website, els) {
    if (!confirm('Disconnect this account? Any websites using it will stop posting there.')) return;
    try {
      await api(`/api/social/accounts/${id}`, { method: 'DELETE' });
      await loadSocialAccounts();
      await loadWebsites();
      const fresh = websites.find((w) => w._id === website._id);
      if (fresh) renderSocialGridInto(fresh, els);
    } catch (err) {
      alert(`Could not disconnect: ${err.message}`);
    }
  }

  // ---------- post-OAuth account picker ----------
  // After Facebook/Instagram/LinkedIn redirects back, index.html loads with
  // ?social=<platform>-select&websiteId=<id> so we can re-select that
  // website (switching into its detail page) and show a "choose which
  // account" step right there.

  async function handleSocialRedirect() {
    const params = new URLSearchParams(window.location.search);
    const social = params.get('social');
    const socialError = params.get('social_error');
    const websiteIdParam = params.get('websiteId');
    const alertEl = document.getElementById('socialConnectAlert');

    if (websiteIdParam && websites.some((w) => w._id === websiteIdParam)) {
      selectWebsite(websiteIdParam);
    }

    const pickerWrap = document.getElementById('socialPickerWrap');
    if (!pickerWrap) return; // no website selected/rendered - nothing to show the picker in

    if (socialError) {
      showAlert(alertEl, socialError);
    }

    if (social === 'facebook-select') {
      await renderFacebookPicker(pickerWrap);
    } else if (social === 'instagram-select') {
      await renderInstagramPicker(pickerWrap);
    } else if (social === 'linkedin-select') {
      await renderLinkedinPicker(pickerWrap);
    }

    if (social || socialError) {
      window.history.replaceState({}, '', '/index.html');
    }
  }

  async function renderFacebookPicker(wrap) {
    try {
      const { pages, websiteId } = await api('/api/social/facebook/pending');
      if (!pages || pages.length === 0) {
        wrap.innerHTML = '';
        return;
      }
      wrap.innerHTML = `
        <div class="social-picker">
          <h4>Choose a Facebook Page to connect</h4>
          ${pages
            .map(
              (p) => `
            <div class="picker-row">
              <div>
                <div class="picker-name">${escapeHtml(p.name)}</div>
              </div>
              <button class="btn btn-primary btn-sm" data-pick-page="${escapeHtml(p.pageId)}">Connect</button>
            </div>
          `
            )
            .join('')}
        </div>
      `;
      wrap.querySelectorAll('[data-pick-page]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Connecting...';
          try {
            await api('/api/social/facebook/select', {
              method: 'POST',
              body: JSON.stringify({ pageId: btn.dataset.pickPage, websiteId: websiteId || selectedWebsiteId }),
            });
            wrap.innerHTML = '';
            await loadSocialAccounts();
            await loadWebsites();
          } catch (err) {
            showAlert(document.getElementById('socialConnectAlert'), err.message);
            btn.disabled = false;
            btn.textContent = 'Connect';
          }
        });
      });
    } catch (err) {
      showAlert(document.getElementById('socialConnectAlert'), err.message);
    }
  }

  async function renderInstagramPicker(wrap) {
    try {
      const { accounts, websiteId } = await api('/api/social/instagram/pending');
      if (!accounts || accounts.length === 0) {
        wrap.innerHTML = `
          <div class="social-picker">
            <h4>No eligible Instagram Business/Professional accounts found</h4>
            <div class="picker-sub">Link an Instagram Professional account to one of your Facebook Pages, then connect again.</div>
          </div>
        `;
        return;
      }
      wrap.innerHTML = `
        <div class="social-picker">
          <h4>Choose an Instagram account to connect</h4>
          ${accounts
            .map(
              (a) => `
            <div class="picker-row">
              <div>
                <div class="picker-name">@${escapeHtml(a.instagramUsername)}</div>
                <div class="picker-sub">via ${escapeHtml(a.pageName)}</div>
              </div>
              <button class="btn btn-primary btn-sm" data-pick-ig="${escapeHtml(a.pageId)}">Connect</button>
            </div>
          `
            )
            .join('')}
        </div>
      `;
      wrap.querySelectorAll('[data-pick-ig]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Connecting...';
          try {
            await api('/api/social/instagram/select', {
              method: 'POST',
              body: JSON.stringify({ pageId: btn.dataset.pickIg, websiteId: websiteId || selectedWebsiteId }),
            });
            wrap.innerHTML = '';
            await loadSocialAccounts();
            await loadWebsites();
          } catch (err) {
            showAlert(document.getElementById('socialConnectAlert'), err.message);
            btn.disabled = false;
            btn.textContent = 'Connect';
          }
        });
      });
    } catch (err) {
      showAlert(document.getElementById('socialConnectAlert'), err.message);
    }
  }

  async function renderLinkedinPicker(wrap) {
    try {
      const { entities, websiteId } = await api('/api/social/linkedin/pending');
      if (!entities || entities.length === 0) {
        wrap.innerHTML = '';
        return;
      }
      wrap.innerHTML = `
        <div class="social-picker">
          <h4>Choose a LinkedIn account to connect</h4>
          ${entities
            .map(
              (e) => `
            <div class="picker-row">
              <div>
                <div class="picker-name">${escapeHtml(e.name)}</div>
                <div class="picker-sub">${e.type === 'organization' ? 'Company Page' : 'Personal profile'}</div>
              </div>
              <button class="btn btn-primary btn-sm" data-pick-li="${escapeHtml(e.urn)}">Connect</button>
            </div>
          `
            )
            .join('')}
        </div>
      `;
      wrap.querySelectorAll('[data-pick-li]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Connecting...';
          try {
            await api('/api/social/linkedin/select', {
              method: 'POST',
              body: JSON.stringify({ urn: btn.dataset.pickLi, websiteId: websiteId || selectedWebsiteId }),
            });
            wrap.innerHTML = '';
            await loadSocialAccounts();
            await loadWebsites();
          } catch (err) {
            showAlert(document.getElementById('socialConnectAlert'), err.message);
            btn.disabled = false;
            btn.textContent = 'Connect';
          }
        });
      });
    } catch (err) {
      showAlert(document.getElementById('socialConnectAlert'), err.message);
    }
  }

  // ---------- category picker (shared helper for wizard + edit modal) ----------

  async function loadCategoriesForWebsite(websiteId, pickerEl, selectedCategoryId) {
    pickerEl.disabled = true;
    pickerEl.innerHTML = '<option value="">Loading categories...</option>';
    try {
      const { categories } = await api(`/api/wordpress/${websiteId}/categories`);
      if (categories.length === 0) {
        pickerEl.innerHTML = '<option value="">No categories found</option>';
      } else {
        pickerEl.innerHTML = categories
          .map((c) => `<option value="${c.id}">${escapeHtml(c.name)} (${c.count})</option>`)
          .join('');
        if (selectedCategoryId) pickerEl.value = String(selectedCategoryId);
      }
      pickerEl.disabled = false;
    } catch (err) {
      pickerEl.innerHTML = `<option value="">Could not load categories</option>`;
    }
  }

  function toggleCategoryPicker(modeEl, pickerEl) {
    const mode = modeEl.value;
    pickerEl.disabled = mode !== 'category';
    if (mode !== 'category') {
      pickerEl.innerHTML = '<option value="">Select a category above first</option>';
    }
  }

  // ================================================================
  // Add-Website Wizard (3 steps): WordPress -> Posting Settings -> Social
  // ================================================================

  const wizardOverlay = document.getElementById('websiteModalOverlay');
  const websiteFormStep1 = document.getElementById('websiteFormStep1');
  const websiteFormStep2 = document.getElementById('websiteFormStep2');
  const wizardStep3 = document.getElementById('wizardStep3');
  const websiteModalAlert = document.getElementById('websiteModalAlert');

  function setWizardStepIndicator(step) {
    document.querySelectorAll('.wizard-step-dot').forEach((dot) => {
      const dotStep = Number(dot.dataset.step);
      dot.classList.remove('active', 'done');
      if (dotStep === step) dot.classList.add('active');
      else if (dotStep < step) dot.classList.add('done');
    });
  }

  function goToWizardStep(step) {
    websiteFormStep1.classList.toggle('hidden', step !== 1);
    websiteFormStep2.classList.toggle('hidden', step !== 2);
    wizardStep3.classList.toggle('hidden', step !== 3);
    setWizardStepIndicator(step);
  }

  function openAddWebsiteModal() {
    wizardWebsiteId = null;
    wizardWebsite = null;
    document.getElementById('websiteModalTitle').textContent = 'Add Website';
    websiteFormStep1.reset();
    websiteFormStep2.reset();
    document.getElementById('wPostingGapMinutes').value = '60';
    document.getElementById('wDailyLimit').value = '10';
    toggleCategoryPicker(document.getElementById('wCategoryMode'), document.getElementById('wCategoryPicker'));
    hideAlert(websiteModalAlert);
    goToWizardStep(1);
    wizardOverlay.classList.remove('hidden');
    document.getElementById('websiteName').focus();
  }

  function closeWizardModal() {
    wizardOverlay.classList.add('hidden');
  }

  document.getElementById('openAddWebsite').addEventListener('click', openAddWebsiteModal);
  document.getElementById('closeWebsiteModal').addEventListener('click', closeWizardModal);
  document.getElementById('cancelWebsiteModal').addEventListener('click', closeWizardModal);
  wizardOverlay.addEventListener('click', (e) => {
    if (e.target === wizardOverlay) closeWizardModal();
  });

  // -- Step 1 submit: create the website from its WordPress credentials --
  websiteFormStep1.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(websiteModalAlert);
    const btn = document.getElementById('saveWebsiteBtn');
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Connecting...';

    const payload = {
      name: document.getElementById('websiteName').value.trim(),
      url: document.getElementById('websiteUrl').value.trim(),
      username: document.getElementById('websiteUsername').value.trim(),
      appPassword: document.getElementById('websiteAppPassword').value,
    };

    try {
      const { website, warning } = await api('/api/websites', { method: 'POST', body: JSON.stringify(payload) });
      wizardWebsiteId = website._id;
      wizardWebsite = website;
      if (warning) showAlert(websiteModalAlert, warning);
      await loadWebsites();
      goToWizardStep(2);
    } catch (err) {
      showAlert(websiteModalAlert, err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });

  document.getElementById('wCategoryMode').addEventListener('change', () => {
    const modeEl = document.getElementById('wCategoryMode');
    const pickerEl = document.getElementById('wCategoryPicker');
    toggleCategoryPicker(modeEl, pickerEl);
    if (modeEl.value === 'category' && wizardWebsiteId) {
      loadCategoriesForWebsite(wizardWebsiteId, pickerEl);
    }
  });

  document.getElementById('wizardBackTo1').addEventListener('click', () => goToWizardStep(1));

  // -- Step 2 submit: save posting settings (category/gap/limit/timezone) --
  websiteFormStep2.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(websiteModalAlert);
    if (!wizardWebsiteId) return;
    const btn = document.getElementById('saveStep2Btn');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const categoryMode = document.getElementById('wCategoryMode').value;
    const categoryPicker = document.getElementById('wCategoryPicker');
    const categoryId = categoryMode === 'category' ? Number(categoryPicker.value) || null : null;
    const categoryName =
      categoryMode === 'category' && categoryPicker.selectedOptions[0]
        ? categoryPicker.selectedOptions[0].textContent.replace(/\s\(\d+\)$/, '')
        : '';

    const payload = {
      categoryMode,
      categoryId,
      categoryName,
      latestArticleLimit: Number(document.getElementById('wLatestArticleLimit').value),
      postingGapMinutes: Number(document.getElementById('wPostingGapMinutes').value),
      dailyLimit: Number(document.getElementById('wDailyLimit').value),
      timezone: document.getElementById('wTimezone').value,
      autoPostingEnabled: document.getElementById('wAutoPostingEnabled').checked,
    };

    try {
      const { website } = await api(`/api/websites/${wizardWebsiteId}/settings`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      wizardWebsite = website;
      await loadWebsites();
      await refreshStatuses();

      renderSocialGridInto(website, {
        grid: document.getElementById('wizardSocialGrid'),
        pickerWrap: document.getElementById('wizardSocialPickerWrap'),
        alertEl: document.getElementById('wizardSocialAlert'),
        onLocalUpdate: (updated) => {
          wizardWebsite = updated;
        },
      });
      goToWizardStep(3);
    } catch (err) {
      showAlert(websiteModalAlert, err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Continue';
    }
  });

  document.getElementById('wizardFinishBtn').addEventListener('click', async () => {
    closeWizardModal();
    if (wizardWebsiteId) {
      selectedWebsiteId = wizardWebsiteId;
    }
    await loadWebsites();
    showView('dashboard');
  });

  // ================================================================
  // Edit Website modal (WordPress creds + posting settings together)
  // ================================================================

  const editOverlay = document.getElementById('editModalOverlay');
  const editForm = document.getElementById('editForm');
  const editModalAlert = document.getElementById('editModalAlert');

  function openEditWebsiteModal(id) {
    const website = websites.find((w) => w._id === id);
    if (!website) return;
    editingWebsiteId = id;

    document.getElementById('editWebsiteName').value = website.name;
    document.getElementById('editWebsiteUrl').value = website.url;
    document.getElementById('editWebsiteUsername').value = website.username;
    document.getElementById('editWebsiteAppPassword').value = '';

    const s = website.settings;
    document.getElementById('editCategoryMode').value = s.categoryMode;
    document.getElementById('editLatestArticleLimit').value = s.latestArticleLimit;
    document.getElementById('editPostingGapMinutes').value = String(s.postingGapMinutes);
    document.getElementById('editDailyLimit').value = s.dailyLimit;
    document.getElementById('editTimezone').value = s.timezone;
    document.getElementById('editAutoPostingEnabled').checked = !!s.autoPostingEnabled;

    const modeEl = document.getElementById('editCategoryMode');
    const pickerEl = document.getElementById('editCategoryPicker');
    toggleCategoryPicker(modeEl, pickerEl);
    if (s.categoryMode === 'category') {
      loadCategoriesForWebsite(id, pickerEl, s.categoryId);
    }

    hideAlert(editModalAlert);
    editOverlay.classList.remove('hidden');
  }

  function closeEditModal() {
    editOverlay.classList.add('hidden');
    editingWebsiteId = null;
  }

  document.getElementById('closeEditModal').addEventListener('click', closeEditModal);
  document.getElementById('cancelEditModal').addEventListener('click', closeEditModal);
  editOverlay.addEventListener('click', (e) => {
    if (e.target === editOverlay) closeEditModal();
  });

  document.getElementById('editCategoryMode').addEventListener('change', () => {
    const modeEl = document.getElementById('editCategoryMode');
    const pickerEl = document.getElementById('editCategoryPicker');
    toggleCategoryPicker(modeEl, pickerEl);
    if (modeEl.value === 'category' && editingWebsiteId) {
      loadCategoriesForWebsite(editingWebsiteId, pickerEl);
    }
  });

  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert(editModalAlert);
    if (!editingWebsiteId) return;
    const btn = document.getElementById('saveEditBtn');
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Saving...';

    const credsPayload = {
      name: document.getElementById('editWebsiteName').value.trim(),
      url: document.getElementById('editWebsiteUrl').value.trim(),
      username: document.getElementById('editWebsiteUsername').value.trim(),
      appPassword: document.getElementById('editWebsiteAppPassword').value,
    };

    const categoryMode = document.getElementById('editCategoryMode').value;
    const categoryPicker = document.getElementById('editCategoryPicker');
    const categoryId = categoryMode === 'category' ? Number(categoryPicker.value) || null : null;
    const categoryName =
      categoryMode === 'category' && categoryPicker.selectedOptions[0]
        ? categoryPicker.selectedOptions[0].textContent.replace(/\s\(\d+\)$/, '')
        : '';

    const settingsPayload = {
      categoryMode,
      categoryId,
      categoryName,
      latestArticleLimit: Number(document.getElementById('editLatestArticleLimit').value),
      postingGapMinutes: Number(document.getElementById('editPostingGapMinutes').value),
      dailyLimit: Number(document.getElementById('editDailyLimit').value),
      timezone: document.getElementById('editTimezone').value,
      autoPostingEnabled: document.getElementById('editAutoPostingEnabled').checked,
    };

    try {
      await api(`/api/websites/${editingWebsiteId}`, { method: 'PUT', body: JSON.stringify(credsPayload) });
      await api(`/api/websites/${editingWebsiteId}/settings`, { method: 'PUT', body: JSON.stringify(settingsPayload) });
      closeEditModal();
      await loadWebsites();
      await refreshStatuses();
    } catch (err) {
      showAlert(editModalAlert, err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  });

  // ---------- queue (selected website only) ----------

  async function loadQueueForSelected() {
    const wrap = document.getElementById('detailQueueWrap');
    if (!selectedWebsiteId) return;
    try {
      const { items } = await api(`/api/queue?websiteId=${selectedWebsiteId}&limit=15`);

      if (items.length === 0) {
        wrap.innerHTML = '<div class="empty-state">Nothing in the queue yet.</div>';
        return;
      }

      const statusClass = { PENDING: 'badge-neutral', PROCESSING: 'badge-warn', COMPLETED: 'badge-success', FAILED: 'badge-danger' };
      const socialStatusClass = { PENDING: 'badge-neutral', PROCESSING: 'badge-warn', PUBLISHED: 'badge-success', FAILED: 'badge-danger' };
      const platformShort = { FACEBOOK: 'FB', INSTAGRAM: 'IG', LINKEDIN: 'LI' };

      const rows = items
        .map((item) => {
          const socialBadges = (item.socialPosts || [])
            .map(
              (p) =>
                `<span class="badge ${socialStatusClass[p.status] || 'badge-neutral'}" title="${escapeHtml(p.error || '')}">${platformShort[p.platform] || p.platform}: ${p.status}</span>`
            )
            .join(' ');
          return `
            <tr>
              <td class="title-cell"><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></td>
              <td>${new Date(item.scheduledAt).toLocaleString()}</td>
              <td><span class="badge ${statusClass[item.status] || 'badge-neutral'}">${item.status}</span></td>
              <td><div class="platform-status-row">${socialBadges || '<span class="section-sub">-</span>'}</div></td>
            </tr>
          `;
        })
        .join('');

      wrap.innerHTML = `
        <table class="queue-table">
          <thead>
            <tr><th>Article</th><th>Scheduled</th><th>Status</th><th>Social</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    } catch (err) {
      wrap.innerHTML = `<div class="empty-state">Could not load queue: ${escapeHtml(err.message)}</div>`;
    }
  }

  document.getElementById('refreshStatusBtn').addEventListener('click', () => {
    refreshStatuses();
    loadQueueForSelected();
  });

  // ---------- init ----------

  (async function init() {
    await loadCurrentUser();
    await loadSocialAccounts();
    await loadWebsites();
    await handleSocialRedirect();
    showView(currentView);
    await refreshStatuses();
    await loadQueueForSelected();

    // Live polling so the dashboard timers, status, and queue sections feel
    // "live" without needing a websocket for this simple version.
    setInterval(refreshStatuses, 20000);
    setInterval(loadQueueForSelected, 30000);
    setInterval(tickCountdowns, 1000);
  })();
})();
