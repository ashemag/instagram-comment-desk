(() => {
  const instance = Symbol('igCommentDesk');
  window.__igCommentDesk = instance;
  document.querySelectorAll('ig-comment-desk').forEach((el) => el.remove());

  const APP_ID = '936619743392459';
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const PAGE_DELAY_MS = 350;
  const THREAD_DELAY_MS = 300;
  const RENDER_STEP = 200;
  const EMOJIS = ['❤️', '🙏', '😂', '🔥', '🥹', '🙌', '✨', '💌'];
  const DEFAULT_SETTINGS = {
    autoOpen: true,
    wide: false,
    quickReplies: ['Thank you! ❤️', 'Sent you a DM 💌', 'Link in bio 🔗'],
  };

  let settings = { ...DEFAULT_SETTINGS };
  let routeToken = 0;
  let loadToken = 0;
  let lastPath = null;
  let openRequested = false;
  let renderTimer = null;
  let toastTimer = null;
  const dismissed = new Set();
  let state = freshState(null);

  function freshState(shortcode) {
    return {
      shortcode,
      mediaId: shortcode ? mediaIdFromShortcode(shortcode) : null,
      viewerId: null,
      viewerUsername: null,
      owner: null,
      isOwn: false,
      caption: '',
      commentCount: 0,
      ready: false,
      comments: new Map(),
      children: new Map(),
      childLoading: new Set(),
      expanded: new Set(),
      done: new Set(),
      replied: new Set(),
      loadStarted: false,
      loading: false,
      scanning: null,
      error: null,
      query: '',
      filter: 'all',
      sort: 'newest',
      limit: RENDER_STEP,
      open: false,
      selected: null,
      replyingTo: null,
      draft: '',
      sending: false,
      sendError: null,
    };
  }

  // ---------- Instagram API ----------

  function shortcodeFromPath(path) {
    const m = path.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  function mediaIdFromShortcode(code) {
    let id = 0n;
    for (const ch of code.slice(0, 11)) id = id * 64n + BigInt(ALPHABET.indexOf(ch));
    return id.toString();
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Comment and media IDs exceed Number.MAX_SAFE_INTEGER, so quote them before parsing.
  function parseJson(text) {
    let out = '';
    let last = 0;
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if ((ch >= '0' && ch <= '9') || ch === '-') {
        let j = i + 1;
        while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++;
        const num = text.slice(i, j);
        if (/^-?\d{16,}$/.test(num)) {
          out += text.slice(last, i) + '"' + num + '"';
          last = j;
        }
        i = j - 1;
      }
    }
    return JSON.parse(out + text.slice(last));
  }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {
      'X-IG-App-ID': APP_ID,
      'X-ASBD-ID': '129477',
      'X-Requested-With': 'XMLHttpRequest',
      'X-IG-WWW-Claim': sessionStorage.getItem('www-claim-v2') || '0',
    };
    const csrf = getCookie('csrftoken');
    if (csrf) headers['X-CSRFToken'] = csrf;

    const res = await fetch(location.origin + path, { method, body, headers, credentials: 'include' });
    const text = await res.text();
    let json = null;
    try {
      json = parseJson(text);
    } catch {}

    if (!res.ok || json?.status === 'fail') {
      let msg = json?.message;
      if (res.status === 429 || /wait a few minutes/i.test(msg || '')) {
        msg = 'Instagram is rate limiting requests. Wait a few minutes and try again.';
      } else if (!msg && (res.status === 401 || res.status === 403)) {
        msg = 'Instagram rejected the request. Make sure you are logged in, then refresh the page.';
      } else if (!msg) {
        msg = `Instagram returned an error (${res.status}).`;
      }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    if (!json) throw new Error('Unexpected response from Instagram.');
    return json;
  }

  function uid(u) {
    return String(u?.pk_id ?? u?.pk ?? u?.id ?? '');
  }

  async function getViewer() {
    const id = getCookie('ds_user_id');
    if (id) return { id, username: null };
    const j = await api('/api/v1/accounts/current_user/?edit=true');
    return { id: uid(j.user), username: j.user?.username || null };
  }

  async function fetchCommentsPage(mediaId, cursor) {
    const p = new URLSearchParams({ can_support_threading: 'true', permalink_enabled: 'false' });
    if (cursor) p.set(cursor.key, cursor.value);
    const j = await api(`/api/v1/media/${mediaId}/comments/?${p}`);
    let next = null;
    if (j.next_min_id) next = { key: 'min_id', value: String(j.next_min_id) };
    else if (j.next_max_id) next = { key: 'max_id', value: String(j.next_max_id) };
    return { comments: j.comments || [], next, total: j.comment_count };
  }

  async function fetchChildren(mediaId, commentId) {
    const all = new Map();
    let cursor = null;
    for (let guard = 0; guard < 50; guard++) {
      const p = new URLSearchParams();
      if (cursor) p.set(cursor.key, cursor.value);
      const j = await api(`/api/v1/media/${mediaId}/comments/${commentId}/child_comments/?${p}`);
      for (const c of j.child_comments || []) all.set(String(c.pk), normComment(c, commentId));
      if (j.has_more_tail_child_comments && j.next_max_child_cursor) {
        cursor = { key: 'max_id', value: String(j.next_max_child_cursor) };
      } else if (j.has_more_head_child_comments && j.next_min_child_cursor) {
        cursor = { key: 'min_id', value: String(j.next_min_child_cursor) };
      } else break;
      await sleep(THREAD_DELAY_MS);
    }
    return [...all.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  function postComment(mediaId, text, parentId) {
    const body = new URLSearchParams({ comment_text: text });
    if (parentId) body.set('replied_to_comment_id', parentId);
    return api(`/api/v1/web/comments/${mediaId}/add/`, { method: 'POST', body });
  }

  function setCommentLike(commentId, like) {
    return api(`/api/v1/web/comments/${like ? 'like' : 'unlike'}/${commentId}/`, { method: 'POST' });
  }

  function normUser(u = {}) {
    return {
      pk: uid(u),
      username: u.username || 'unknown',
      fullName: u.full_name || '',
      pic: u.profile_pic_url || u.profile_picture || '',
      verified: !!u.is_verified,
    };
  }

  function normComment(c, parentId = null) {
    const pk = String(c.pk ?? c.id);
    return {
      pk,
      text: c.text || '',
      createdAt: Number(c.created_at_utc ?? c.created_at ?? c.created_time ?? Date.now() / 1000),
      likes: Number(c.comment_like_count ?? c.like_count ?? 0),
      liked: !!c.has_liked_comment,
      user: normUser(c.user || c.from),
      childCount: Number(c.child_comment_count || 0),
      preview: (c.preview_child_comments || []).map((x) => normComment(x, pk)),
      parentId: parentId ?? (c.parent_comment_id ? String(c.parent_comment_id) : null),
    };
  }

  // ---------- Comment state helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function childrenOf(c) {
    return state.children.get(c.pk) || c.preview;
  }

  function threadFullyKnown(c) {
    return state.children.has(c.pk) || c.preview.length >= c.childCount;
  }

  function isMine(c) {
    return !!state.viewerId && c.user.pk === state.viewerId;
  }

  function repliedByMe(c) {
    return state.replied.has(c.pk) || childrenOf(c).some(isMine);
  }

  function statusOf(c) {
    if (isMine(c)) return 'mine';
    if (repliedByMe(c)) return 'replied';
    if (state.done.has(c.pk)) return 'done';
    return 'needs';
  }

  function textMatch(c, q) {
    return (
      c.text.toLowerCase().includes(q) ||
      c.user.username.toLowerCase().includes(q) ||
      c.user.fullName.toLowerCase().includes(q)
    );
  }

  function threadMatch(c, q) {
    return childrenOf(c).some((x) => textMatch(x, q));
  }

  function filterMatch(c, filter) {
    const st = statusOf(c);
    if (filter === 'needs') return st === 'needs';
    if (filter === 'replied') return st === 'replied';
    if (filter === 'done') return st === 'done';
    return true;
  }

  function queryMatched() {
    const q = state.query.trim().toLowerCase();
    const all = [...state.comments.values()];
    return q ? all.filter((c) => textMatch(c, q) || threadMatch(c, q)) : all;
  }

  function visibleComments() {
    const list = queryMatched().filter((c) => filterMatch(c, state.filter));
    const sorters = {
      newest: (a, b) => b.createdAt - a.createdAt,
      oldest: (a, b) => a.createdAt - b.createdAt,
      likes: (a, b) => b.likes - a.likes || b.createdAt - a.createdAt,
      replies: (a, b) => b.childCount - a.childCount || b.createdAt - a.createdAt,
    };
    return list.sort(sorters[state.sort] || sorters.newest);
  }

  function findComment(cid, parentId) {
    const top = state.comments.get(parentId);
    if (!top) return null;
    if (cid === parentId) return top;
    return childrenOf(top).find((x) => x.pk === cid) || null;
  }

  async function loadPostStore(mediaId) {
    const keys = [`done:${mediaId}`, `replied:${mediaId}`];
    const r = await chrome.storage.local.get(keys);
    if (state.mediaId !== mediaId) return;
    state.done = new Set(r[keys[0]] || []);
    state.replied = new Set(r[keys[1]] || []);
  }

  function persist(kind) {
    chrome.storage.local.set({ [`${kind}:${state.mediaId}`]: [...state[kind]] });
  }

  async function loadSettings() {
    const r = await chrome.storage.local.get('settings');
    settings = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
  }

  function saveSettings() {
    chrome.storage.local.set({ settings });
  }

  // ---------- Loading ----------

  async function loadAll() {
    const token = ++loadToken;
    const s = state;
    s.loadStarted = true;
    s.loading = true;
    s.error = null;
    scheduleRender();

    try {
      let cursor = null;
      const seen = new Set();
      for (let page = 0; page < 500; page++) {
        const { comments, next } = await fetchCommentsPage(s.mediaId, cursor);
        if (token !== loadToken) return;
        let added = 0;
        for (const raw of comments) {
          const c = normComment(raw);
          if (!s.comments.has(c.pk)) added++;
          s.comments.set(c.pk, c);
        }
        scheduleRender();
        if (!next || seen.has(next.value) || (page > 0 && added === 0)) break;
        seen.add(next.value);
        cursor = next;
        await sleep(PAGE_DELAY_MS);
      }
    } catch (e) {
      console.warn('[Comment Desk] Could not load comments', e);
      if (token !== loadToken) return;
      s.error = e.message;
    }
    s.loading = false;
    render();
    if (s.isOwn && !s.error) scanThreads(token);
  }

  // Threads whose preview doesn't include every reply might contain one of yours.
  async function scanThreads(token) {
    const todo = [...state.comments.values()].filter(
      (c) => c.childCount > 0 && !threadFullyKnown(c) && statusOf(c) === 'needs'
    );
    for (let i = 0; i < todo.length; i++) {
      if (token !== loadToken) return;
      state.scanning = { done: i, total: todo.length };
      scheduleRender();
      try {
        await loadChildren(todo[i].pk);
      } catch (e) {
        if (e.status === 429) {
          state.error = e.message;
          break;
        }
      }
      await sleep(THREAD_DELAY_MS);
    }
    if (token !== loadToken) return;
    state.scanning = null;
    render();
  }

  async function loadChildren(pk) {
    const s = state;
    if (s.childLoading.has(pk)) return;
    s.childLoading.add(pk);
    scheduleRender();
    try {
      const kids = await fetchChildren(s.mediaId, pk);
      const c = s.comments.get(pk);
      s.children.set(pk, kids);
      if (c) c.childCount = Math.max(c.childCount, kids.length);
    } finally {
      s.childLoading.delete(pk);
      scheduleRender();
    }
  }

  // ---------- Routing ----------

  async function handleRoute() {
    const code = shortcodeFromPath(location.pathname);
    if (code === state.shortcode) return;
    const token = ++routeToken;
    loadToken++;
    const wasOpen = state.open;
    state = freshState(code);
    state.open = (wasOpen || openRequested) && !!code;
    openRequested = false;
    render();
    if (!code) return;

    try {
      const [viewer, info] = await Promise.all([getViewer(), api(`/api/v1/media/${state.mediaId}/info/`)]);
      if (token !== routeToken) return;
      const item = info.items?.[0];
      if (!item) throw new Error('Could not load this post.');
      if (item.id) state.mediaId = String(item.id).split('_')[0];
      state.viewerId = viewer.id;
      state.owner = normUser(item.user);
      state.isOwn = state.owner.pk === viewer.id;
      state.viewerUsername = viewer.username || (state.isOwn ? state.owner.username : null);
      state.caption = item.caption?.text || '';
      state.commentCount = Number(item.comment_count || 0);
      state.filter = state.isOwn ? 'needs' : 'all';
      await loadPostStore(state.mediaId);
      if (token !== routeToken) return;
      state.ready = true;
      if (state.open || (state.isOwn && settings.autoOpen && !dismissed.has(code))) openPanel();
      else render();
    } catch (e) {
      console.warn('[Comment Desk] Could not load post', e);
      if (token !== routeToken) return;
      state.error = e.message;
      state.ready = true;
      render();
    }
  }

  function openPanel() {
    if (!state.shortcode) {
      toast('Open one of your posts or reels to use Comment Desk.');
      return;
    }
    state.open = true;
    dismissed.delete(state.shortcode);
    if (state.ready && !state.loadStarted && !state.error) loadAll();
    render();
    ui.list.focus({ preventScroll: true });
  }

  function closePanel() {
    state.open = false;
    if (state.shortcode) dismissed.add(state.shortcode);
    render();
  }

  function refresh() {
    state.comments = new Map();
    state.children = new Map();
    state.childLoading = new Set();
    state.scanning = null;
    state.limit = RENDER_STEP;
    loadAll();
  }

  // ---------- Actions ----------

  function startReply(parentId, username) {
    const top = state.comments.get(parentId);
    if (!top) return;
    const mention = username && username !== state.viewerUsername ? `@${username} ` : '';
    state.replyingTo = { parentId, username };
    state.draft = mention;
    state.sendError = null;
    state.selected = parentId;
    render();
    focusComposer(true);
  }

  function cancelReply() {
    state.replyingTo = null;
    state.draft = '';
    state.sendError = null;
    render();
    ui.list.focus({ preventScroll: true });
  }

  function focusComposer(toEnd) {
    const ta = ui.list.querySelector('.composer textarea');
    if (!ta) return;
    ta.focus({ preventScroll: true });
    if (toEnd) ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.closest('.composer').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function insertIntoDraft(text) {
    const ta = ui.list.querySelector('.composer textarea');
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const pad = before && !/\s$/.test(before) && !/^\p{Extended_Pictographic}/u.test(text) ? ' ' : '';
    ta.value = before + pad + text + ta.value.slice(end);
    const pos = (before + pad + text).length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    state.draft = ta.value;
  }

  async function sendReply() {
    const r = state.replyingTo;
    if (!r || state.sending) return;
    const text = state.draft.trim();
    const mentionOnly = r.username && text === `@${r.username}`;
    if (!text || mentionOnly) {
      state.sendError = 'Write something first.';
      render();
      focusComposer(true);
      return;
    }

    const s = state;
    const order = visibleComments().map((c) => c.pk);
    s.sending = true;
    s.sendError = null;
    render();

    try {
      const res = await postComment(s.mediaId, text, r.parentId);
      if (s !== state) return;
      const reply = normComment(
        {
          pk: res.id,
          text: res.text ?? text,
          created_time: res.created_time,
          user: { ...(res.from || {}), pk: s.viewerId, username: res.from?.username || s.viewerUsername || 'you' },
        },
        r.parentId
      );
      if (!s.viewerUsername && res.from?.username) s.viewerUsername = res.from.username;
      const top = s.comments.get(r.parentId);
      if (top) {
        s.children.set(r.parentId, [...childrenOf(top), reply]);
        top.childCount += 1;
      }
      s.replied.add(r.parentId);
      persist('replied');
      s.expanded.add(r.parentId);
      s.sending = false;
      s.replyingTo = null;
      s.draft = '';
      toast('Reply posted');

      if (s.filter === 'needs') {
        const idx = order.indexOf(r.parentId);
        const nextId = order.slice(idx + 1).find((id) => s.comments.has(id) && statusOf(s.comments.get(id)) === 'needs');
        if (nextId) {
          startReply(nextId, s.comments.get(nextId).user.username);
          return;
        }
      }
      render();
      ui.list.focus({ preventScroll: true });
    } catch (e) {
      if (s !== state) return;
      s.sending = false;
      s.sendError = e.message;
      render();
      focusComposer(false);
    }
  }

  async function toggleLike(cid, parentId) {
    const c = findComment(cid, parentId);
    if (!c) return;
    const like = !c.liked;
    c.liked = like;
    c.likes = Math.max(0, c.likes + (like ? 1 : -1));
    render();
    try {
      await setCommentLike(cid, like);
    } catch (e) {
      c.liked = !like;
      c.likes = Math.max(0, c.likes + (like ? -1 : 1));
      toast(e.message);
      render();
    }
  }

  function toggleDone(pk) {
    const before = visibleComments().map((c) => c.pk);
    if (state.done.has(pk)) state.done.delete(pk);
    else state.done.add(pk);
    persist('done');
    if (state.selected === pk) {
      const after = new Set(visibleComments().map((c) => c.pk));
      if (!after.has(pk)) {
        const i = before.indexOf(pk);
        state.selected = before.slice(i + 1).find((id) => after.has(id)) || before.slice(0, i).reverse().find((id) => after.has(id)) || null;
      }
    }
    render();
  }

  function toggleThread(pk) {
    const c = state.comments.get(pk);
    if (!c) return;
    if (state.expanded.has(pk)) state.expanded.delete(pk);
    else {
      state.expanded.add(pk);
      if (!threadFullyKnown(c)) loadChildren(pk).catch((e) => toast(e.message));
    }
    render();
  }

  function moveSelection(delta) {
    const ids = visibleComments()
      .slice(0, state.limit)
      .map((c) => c.pk);
    if (!ids.length) return;
    const i = ids.indexOf(state.selected);
    const next = i === -1 ? (delta > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, i + delta));
    state.selected = ids[next];
    render();
    ui.list.querySelector(`[data-cid="${state.selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  // ---------- Rendering ----------

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  }

  function hl(text, q) {
    if (!q) return esc(text);
    const lower = text.toLowerCase();
    let out = '';
    let i = 0;
    let j;
    while ((j = lower.indexOf(q, i)) !== -1) {
      out += esc(text.slice(i, j)) + '<mark>' + esc(text.slice(j, j + q.length)) + '</mark>';
      i = j + q.length;
    }
    return out + esc(text.slice(i));
  }

  function relTime(sec) {
    const d = Math.max(0, Date.now() / 1000 - sec);
    if (d < 60) return 'now';
    if (d < 3600) return `${Math.floor(d / 60)}m`;
    if (d < 86400) return `${Math.floor(d / 3600)}h`;
    if (d < 604800) return `${Math.floor(d / 86400)}d`;
    return `${Math.floor(d / 604800)}w`;
  }

  function avatar(u, small) {
    const cls = small ? 'av sm' : 'av';
    if (!u.pic) return `<div class="${cls} ph">${esc(u.username[0] || '?').toUpperCase()}</div>`;
    return `<img class="${cls}" src="${esc(u.pic)}" alt="" loading="lazy">`;
  }

  function metaHtml(c, q, st) {
    const tags = [];
    if (state.owner && c.user.pk === state.owner.pk) tags.push(`<span class="tag creator">${isMine(c) ? 'You' : 'Creator'}</span>`);
    if (st === 'replied') tags.push('<span class="tag ok">✓ Replied</span>');
    else if (st === 'done') tags.push('<span class="tag muted">Done</span>');
    else if (st === 'needs' && state.isOwn) tags.push('<span class="tag needs">Needs reply</span>');
    const full = new Date(c.createdAt * 1000).toLocaleString();
    return `<div class="meta">
      <a class="user" href="/${esc(c.user.username)}/" target="_blank" rel="noopener">${hl(c.user.username, q)}</a>
      ${c.user.verified ? '<span class="verified" title="Verified">✔︎</span>' : ''}
      <span class="time" title="${esc(full)}">${relTime(c.createdAt)}</span>
      ${tags.join('')}
    </div>`;
  }

  function likeBtn(c) {
    return `<button class="act like ${c.liked ? 'on' : ''}" data-act="like" title="${c.liked ? 'Unlike' : 'Like'} (l)">${c.liked ? '♥' : '♡'}${c.likes ? ` ${c.likes}` : ''}</button>`;
  }

  function childHtml(k, parentId, q) {
    return `<div class="child ${q && textMatch(k, q) ? 'hit' : ''}" data-cid="${k.pk}" data-parent="${parentId}">
      ${avatar(k.user, true)}
      <div class="body">
        ${metaHtml(k, q, isMine(k) ? 'mine' : null)}
        <div class="text">${hl(k.text, q)}</div>
        <div class="actions">
          <button class="act" data-act="reply">Reply</button>
          ${likeBtn(k)}
        </div>
      </div>
    </div>`;
  }

  function threadHtml(c, q) {
    const kids = childrenOf(c);
    const loading = state.childLoading.has(c.pk);
    let more = '';
    if (loading) more = '<div class="thread-note">Loading replies…</div>';
    else if (!threadFullyKnown(c)) more = `<button class="act link" data-act="load-thread">Load all ${c.childCount} replies</button>`;
    return `<div class="thread">${kids.map((k) => childHtml(k, c.pk, q)).join('')}${more}</div>`;
  }

  function composerHtml() {
    const r = state.replyingTo;
    const quick = settings.quickReplies
      .map((t) => `<button class="chip" data-act="quick" data-text="${esc(t)}">${esc(t)}</button>`)
      .join('');
    const emoji = EMOJIS.map((e) => `<button class="emoji" data-act="quick" data-text="${e}">${e}</button>`).join('');
    return `<div class="composer">
      <div class="replying">Replying to <b>@${esc(r.username)}</b><button class="act" data-act="cancel">Cancel</button></div>
      <textarea rows="3" placeholder="Write a reply…" ${state.sending ? 'disabled' : ''}>${esc(state.draft)}</textarea>
      <div class="quick">${emoji}${quick}</div>
      <div class="send-row">
        ${state.sendError ? `<span class="err">${esc(state.sendError)}</span>` : '<span class="hint">Enter to send · Shift+Enter for a new line · Esc to cancel</span>'}
        <button class="primary" data-act="send" ${state.sending ? 'disabled' : ''}>${state.sending ? 'Sending…' : 'Reply'}</button>
      </div>
    </div>`;
  }

  function cardHtml(c, q) {
    const st = statusOf(c);
    const open = state.expanded.has(c.pk) || (q && threadMatch(c, q));
    const replying = state.replyingTo?.parentId === c.pk;
    const actions = [
      '<button class="act" data-act="reply" title="Reply (r)">Reply</button>',
      likeBtn(c),
    ];
    if (state.isOwn && st !== 'mine' && st !== 'replied') {
      actions.push(`<button class="act" data-act="done" title="Mark done without replying (d)">${st === 'done' ? 'Undo done' : 'Mark done'}</button>`);
    }
    if (c.childCount) {
      actions.push(`<button class="act" data-act="thread">${open ? 'Hide' : 'View'} ${c.childCount} ${c.childCount === 1 ? 'reply' : 'replies'}</button>`);
    }
    actions.push(`<a class="act" href="/p/${esc(state.shortcode)}/c/${c.pk}/" target="_blank" rel="noopener" title="Open on Instagram">Open ↗</a>`);

    return `<article class="card st-${st} ${state.selected === c.pk ? 'sel' : ''}" data-cid="${c.pk}" data-parent="${c.pk}">
      ${avatar(c.user)}
      <div class="body">
        ${metaHtml(c, q, st)}
        <div class="text">${hl(c.text, q)}</div>
        <div class="actions">${actions.join('')}</div>
        ${open ? threadHtml(c, q) : ''}
        ${replying ? composerHtml() : ''}
      </div>
    </article>`;
  }

  function filtersHtml() {
    const base = queryMatched();
    const count = (f) => base.filter((c) => filterMatch(c, f)).length;
    const chips = state.isOwn
      ? [
          ['needs', 'Needs reply'],
          ['all', 'All'],
          ['replied', 'Replied'],
          ['done', 'Done'],
        ]
      : [['all', 'All']];
    return chips
      .map(([f, label]) => `<button class="fchip ${state.filter === f ? 'on' : ''}" data-filter="${f}">${label}<span>${count(f)}</span></button>`)
      .join('');
  }

  function statusHtml() {
    if (state.error) {
      return `<span class="err">${esc(state.error)}</span><button class="act link" data-act="retry">Retry</button>`;
    }
    if (!state.ready) return '<span class="spin"></span>Loading post…';
    const n = state.comments.size;
    if (state.loading) return `<span class="spin"></span>Loading comments… ${n} so far`;
    if (state.scanning) {
      return `<span class="spin"></span>Checking reply threads for your replies… ${state.scanning.done}/${state.scanning.total}`;
    }
    if (!state.loadStarted) return '';
    const replies = [...state.comments.values()].reduce((sum, c) => sum + c.childCount, 0);
    return `${n} comments · ${replies} replies loaded`;
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, 150);
  }

  function render() {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    const onPost = !!state.shortcode;
    ui.launcher.hidden = !onPost || state.open;
    ui.panel.classList.toggle('open', onPost && state.open);
    ui.panel.classList.toggle('wide', !!settings.wide);

    const needs = state.isOwn && state.loadStarted ? [...state.comments.values()].filter((c) => statusOf(c) === 'needs').length : 0;
    ui.badge.hidden = !needs;
    ui.badge.textContent = needs > 99 ? '99+' : String(needs);

    if (!onPost || !state.open) return;

    const owner = state.owner ? `@${esc(state.owner.username)}` : '';
    ui.sub.innerHTML = [owner, state.commentCount ? `${state.commentCount.toLocaleString()} comments` : '', state.isOwn ? 'your post' : '']
      .filter(Boolean)
      .join(' · ');
    ui.chips.innerHTML = filtersHtml();
    ui.status.innerHTML = statusHtml();
    if (ui.sort.value !== state.sort) ui.sort.value = state.sort;

    const q = state.query.trim().toLowerCase();
    const list = visibleComments();
    const shown = list.slice(0, state.limit);

    const oldTa = ui.list.querySelector('.composer textarea');
    const hadFocus = oldTa && ui.root.activeElement === oldTa;
    const sel = hadFocus ? [oldTa.selectionStart, oldTa.selectionEnd] : null;
    const scrollTop = ui.list.scrollTop;

    let html = '';
    if (state.caption && !q) {
      html += `<details class="caption"><summary>Caption</summary><div class="text">${esc(state.caption)}</div></details>`;
    }
    if (shown.length) {
      html += shown.map((c) => cardHtml(c, q)).join('');
      if (list.length > shown.length) {
        html += `<button class="more" data-act="more">Show more (${list.length - shown.length} left)</button>`;
      }
    } else if (state.loadStarted && !state.loading) {
      html += `<div class="empty">${emptyText(q)}</div>`;
    }
    ui.list.innerHTML = html;
    ui.list.scrollTop = scrollTop;

    if (hadFocus) {
      const ta = ui.list.querySelector('.composer textarea');
      if (ta) {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(sel[0], sel[1]);
      }
    }
  }

  function emptyText(q) {
    if (q) return `No comments match “${esc(state.query.trim())}”.`;
    if (state.filter === 'needs') return state.scanning ? 'Still checking threads…' : 'You’re all caught up 🎉';
    if (state.filter === 'replied') return 'You haven’t replied to any comments yet.';
    if (state.filter === 'done') return 'Nothing marked done.';
    return 'No comments yet.';
  }

  let toastEl;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
  }

  // ---------- UI ----------

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .wrap {
      --bg: #ffffff; --bg2: #f5f6f8; --bg3: #eceef2; --fg: #0f1419; --fg2: #5b6470; --line: #e3e6ea;
      --blue: #0095f6; --blue-d: #1877f2; --ok: #0f9d58; --warn: #e1306c; --mark: #fff1a8;
      --shadow: 0 20px 60px rgba(15, 20, 25, .18), 0 2px 8px rgba(15, 20, 25, .08);
      font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: var(--fg);
    }
    @media (prefers-color-scheme: dark) {
      .wrap {
        --bg: #111316; --bg2: #1b1e23; --bg3: #262a31; --fg: #f1f3f5; --fg2: #9aa3ad; --line: #2b3038;
        --mark: #6b5a00; --shadow: 0 20px 60px rgba(0,0,0,.6);
      }
    }
    button { font: inherit; color: inherit; cursor: pointer; }
    a { color: inherit; text-decoration: none; }

    .launcher {
      position: fixed; right: 24px; bottom: 96px; width: 56px; height: 56px; border-radius: 18px;
      border: none; padding: 0; background: var(--bg); box-shadow: var(--shadow);
      display: grid; place-items: center; transition: transform .15s ease;
      z-index: 2147483646;
    }
    .launcher:hover { transform: scale(1.06); }
    .launcher img { width: 34px; height: 34px; }
    .badge {
      position: absolute; top: -6px; right: -6px; min-width: 22px; height: 22px; padding: 0 6px;
      border-radius: 11px; background: var(--warn); color: #fff; font-size: 12px; font-weight: 700;
      display: grid; place-items: center; border: 2px solid var(--bg);
    }

    .panel {
      position: fixed; top: 12px; right: 12px; bottom: 12px; width: min(580px, calc(100vw - 24px));
      background: var(--bg); border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--shadow);
      display: flex; flex-direction: column; overflow: hidden; z-index: 2147483647;
      transform: translateX(calc(100% + 24px)); visibility: hidden;
      transition: transform .22s cubic-bezier(.2,.8,.2,1), width .22s ease, visibility 0s linear .22s;
    }
    .panel.open { transform: none; visibility: visible; transition: transform .22s cubic-bezier(.2,.8,.2,1), width .22s ease; }
    .panel.wide { width: min(1040px, calc(100vw - 24px)); }

    header { padding: 16px 18px 10px; border-bottom: 1px solid var(--line); display: grid; gap: 12px; }
    .top { display: flex; align-items: center; gap: 12px; }
    .logo { width: 34px; height: 34px; }
    .heading { flex: 1; min-width: 0; }
    .title { font-weight: 700; font-size: 17px; }
    .sub { color: var(--fg2); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .icon-btn {
      width: 34px; height: 34px; border-radius: 10px; border: none; background: transparent;
      font-size: 17px; color: var(--fg2); display: grid; place-items: center;
    }
    .icon-btn:hover { background: var(--bg2); color: var(--fg); }
    .icon-btn.on { background: var(--bg3); color: var(--fg); }

    .search { position: relative; }
    .search input {
      width: 100%; height: 46px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg2);
      padding: 0 44px 0 42px; font: inherit; font-size: 16px; color: var(--fg); outline: none;
    }
    .search input:focus { border-color: var(--blue); background: var(--bg); box-shadow: 0 0 0 3px rgba(0,149,246,.15); }
    .search svg { position: absolute; left: 14px; top: 14px; width: 18px; height: 18px; color: var(--fg2); }
    .search kbd { position: absolute; right: 12px; top: 12px; }
    kbd {
      display: inline-grid; place-items: center; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 6px;
      border: 1px solid var(--line); background: var(--bg); color: var(--fg2); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; flex: 1; }
    .fchip {
      height: 32px; padding: 0 12px; border-radius: 16px; border: 1px solid var(--line); background: var(--bg);
      font-size: 14px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px;
    }
    .fchip span { color: var(--fg2); font-weight: 500; }
    .fchip.on { background: var(--fg); color: var(--bg); border-color: var(--fg); }
    .fchip.on span { color: inherit; opacity: .7; }
    select {
      height: 32px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--fg);
      font: inherit; font-size: 14px; padding: 0 8px;
    }
    .status { font-size: 13px; color: var(--fg2); min-height: 18px; display: flex; align-items: center; gap: 8px; }
    .status .err { color: var(--warn); }
    .spin {
      width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--blue);
      animation: spin .8s linear infinite; display: inline-block;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .settings { padding: 14px 18px; border-bottom: 1px solid var(--line); background: var(--bg2); display: grid; gap: 12px; font-size: 14px; }
    .settings .check { display: flex; gap: 8px; align-items: center; }
    .settings .field { display: grid; gap: 6px; color: var(--fg2); }
    .settings textarea {
      width: 100%; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--fg);
      font: inherit; padding: 8px 10px; resize: vertical;
    }

    .list { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 8px 10px 24px; outline: none; }
    .panel.wide .list { padding: 8px 22px 24px; }

    .caption { margin: 4px 8px 8px; padding: 10px 12px; border-radius: 12px; background: var(--bg2); font-size: 14px; }
    .caption summary { cursor: pointer; color: var(--fg2); font-weight: 600; }
    .caption .text { margin-top: 6px; }

    .card, .child { display: flex; gap: 12px; }
    .card { padding: 14px 12px; border-radius: 14px; border: 1px solid transparent; }
    .card:hover { background: var(--bg2); }
    .card.sel { background: var(--bg2); border-color: var(--line); }
    .card.st-replied .body > .text, .card.st-done .body > .text { color: var(--fg2); }
    .av { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; flex: none; background: var(--bg3); }
    .av.sm { width: 30px; height: 30px; }
    .av.ph { display: grid; place-items: center; font-weight: 700; color: var(--fg2); }
    .body { flex: 1; min-width: 0; }
    .meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 14px; }
    .user { font-weight: 700; }
    .user:hover { text-decoration: underline; }
    .verified { color: var(--blue); font-size: 12px; }
    .time { color: var(--fg2); }
    .tag { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; letter-spacing: .03em; }
    .tag.needs { background: rgba(225,48,108,.12); color: var(--warn); }
    .tag.ok { background: rgba(15,157,88,.12); color: var(--ok); }
    .tag.muted { background: var(--bg3); color: var(--fg2); }
    .tag.creator { background: rgba(0,149,246,.12); color: var(--blue); }
    .text { font-size: 16px; margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
    mark { background: var(--mark); color: inherit; border-radius: 3px; padding: 0 1px; }

    .actions { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 0 -8px; }
    .act {
      border: none; background: transparent; color: var(--fg2); font-size: 13px; font-weight: 600;
      padding: 5px 8px; border-radius: 8px; display: inline-flex; align-items: center; gap: 4px;
    }
    .act:hover { background: var(--bg3); color: var(--fg); }
    .act[data-act="reply"] { color: var(--blue); }
    .act.like.on { color: var(--warn); }
    .act.link { color: var(--blue); }

    .thread { margin-top: 8px; padding-left: 14px; border-left: 2px solid var(--line); display: grid; gap: 10px; }
    .child { padding: 6px 8px; border-radius: 10px; }
    .child.hit { background: rgba(255, 214, 0, .12); }
    .child .text { font-size: 15px; }
    .thread-note { color: var(--fg2); font-size: 13px; padding: 4px 8px; }

    .composer {
      margin-top: 10px; border: 1px solid var(--blue); border-radius: 14px; background: var(--bg);
      padding: 10px 12px; box-shadow: 0 0 0 3px rgba(0,149,246,.12); display: grid; gap: 8px;
    }
    .replying { font-size: 13px; color: var(--fg2); display: flex; align-items: center; gap: 6px; }
    .replying .act { margin-left: auto; }
    .composer textarea {
      width: 100%; border: none; outline: none; resize: vertical; background: transparent; color: var(--fg);
      font: inherit; font-size: 16px; min-height: 64px;
    }
    .quick { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
      border: 1px solid var(--line); background: var(--bg2); border-radius: 14px; padding: 3px 10px; font-size: 13px;
    }
    .chip:hover { border-color: var(--blue); }
    .emoji { border: none; background: transparent; font-size: 18px; padding: 0 2px; border-radius: 6px; }
    .emoji:hover { background: var(--bg3); }
    .send-row { display: flex; align-items: center; gap: 10px; }
    .send-row .hint { color: var(--fg2); font-size: 12px; flex: 1; }
    .send-row .err { color: var(--warn); font-size: 13px; flex: 1; }
    .primary {
      margin-left: auto; border: none; background: var(--blue); color: #fff; font-weight: 700; font-size: 14px;
      height: 34px; padding: 0 18px; border-radius: 10px;
    }
    .primary:hover { background: var(--blue-d); }
    .primary:disabled { opacity: .6; cursor: default; }

    .more {
      display: block; margin: 12px auto; border: 1px solid var(--line); background: var(--bg); border-radius: 10px;
      padding: 8px 16px; font-weight: 600;
    }
    .empty { text-align: center; color: var(--fg2); padding: 48px 16px; font-size: 16px; }

    footer {
      border-top: 1px solid var(--line); padding: 10px 18px; display: flex; flex-wrap: wrap; gap: 14px;
      font-size: 12px; color: var(--fg2);
    }
    footer span { display: inline-flex; align-items: center; gap: 4px; }

    @media (max-height: 720px) {
      header { padding: 10px 14px 8px; gap: 8px; }
      .search input { height: 40px; }
      .search svg { top: 11px; }
      .search kbd { top: 9px; }
      footer { display: none; }
    }

    .toast {
      position: fixed; left: 50%; bottom: 32px; transform: translateX(-50%); z-index: 2147483647;
      background: #0f1419; color: #fff; padding: 10px 16px; border-radius: 12px; font-size: 14px; font-weight: 600;
      box-shadow: 0 8px 24px rgba(0,0,0,.25);
    }
  `;

  const SEARCH_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

  function buildUi() {
    const host = document.createElement('ig-comment-desk');
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    const icon = chrome.runtime.getURL('icons/icon48.png');
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="wrap">
        <button class="launcher" title="Comment Desk (Option+Shift+C)" hidden>
          <img src="${icon}" alt="Comment Desk"><span class="badge" hidden></span>
        </button>
        <aside class="panel" aria-label="Comment Desk">
          <header>
            <div class="top">
              <img class="logo" src="${icon}" alt="">
              <div class="heading"><div class="title">Comment Desk</div><div class="sub"></div></div>
              <button class="icon-btn" data-act="settings" title="Settings">⚙︎</button>
              <button class="icon-btn" data-act="wide" title="Toggle wide view">⤢</button>
              <button class="icon-btn" data-act="refresh" title="Reload comments">↻</button>
              <button class="icon-btn" data-act="close" title="Close (Esc)">✕</button>
            </div>
            <div class="search">
              ${SEARCH_ICON}
              <input type="text" placeholder="Search comments, usernames, replies…" spellcheck="false" autocomplete="off">
              <kbd>/</kbd>
            </div>
            <div class="filters">
              <div class="chips"></div>
              <select class="sort" title="Sort">
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="likes">Most liked</option>
                <option value="replies">Most replies</option>
              </select>
            </div>
            <div class="status"></div>
          </header>
          <section class="settings" hidden>
            <label class="check"><input type="checkbox" data-setting="autoOpen"> Open automatically on my posts</label>
            <label class="field">Quick replies (one per line)<textarea data-setting="quickReplies" rows="4"></textarea></label>
          </section>
          <div class="list" tabindex="-1"></div>
          <footer>
            <span><kbd>/</kbd> search</span>
            <span><kbd>j</kbd><kbd>k</kbd> move</span>
            <span><kbd>r</kbd> reply</span>
            <span><kbd>l</kbd> like</span>
            <span><kbd>d</kbd> done</span>
            <span><kbd>esc</kbd> close</span>
          </footer>
        </aside>
        <div class="toast" hidden></div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);

    const $ = (s) => root.querySelector(s);
    return {
      host,
      root,
      launcher: $('.launcher'),
      badge: $('.badge'),
      panel: $('.panel'),
      sub: $('.sub'),
      search: $('.search input'),
      chips: $('.chips'),
      sort: $('.sort'),
      status: $('.status'),
      settings: $('.settings'),
      list: $('.list'),
      toast: $('.toast'),
    };
  }

  const ui = buildUi();
  toastEl = ui.toast;

  function bindUi() {
    for (const type of ['keydown', 'keyup', 'keypress']) {
      ui.host.addEventListener(type, (e) => e.stopPropagation());
    }

    ui.launcher.addEventListener('click', openPanel);

    ui.search.addEventListener('input', () => {
      state.query = ui.search.value;
      state.limit = RENDER_STEP;
      render();
    });

    ui.sort.addEventListener('change', () => {
      state.sort = ui.sort.value;
      render();
    });

    ui.chips.addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      state.filter = b.dataset.filter;
      state.limit = RENDER_STEP;
      render();
    });

    ui.panel.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) {
        const card = e.target.closest('.card');
        if (card && !e.target.closest('a, textarea')) {
          ui.list.querySelector('.card.sel')?.classList.remove('sel');
          card.classList.add('sel');
          state.selected = card.dataset.cid;
        }
        return;
      }
      const act = b.dataset.act;
      const card = b.closest('[data-cid]');
      const cid = card?.dataset.cid;
      const parentId = card?.dataset.parent;
      if (card?.classList.contains('card')) state.selected = cid;

      switch (act) {
        case 'close':
          closePanel();
          break;
        case 'wide':
          settings.wide = !settings.wide;
          saveSettings();
          render();
          break;
        case 'refresh':
        case 'retry':
          if (!state.ready || (!state.owner && state.error)) {
            const code = state.shortcode;
            state.shortcode = null;
            lastPath = null;
            dismissed.delete(code);
            handleRoute();
          } else refresh();
          break;
        case 'settings': {
          const show = ui.settings.hidden;
          ui.settings.hidden = !show;
          b.classList.toggle('on', show);
          if (show) {
            ui.settings.querySelector('[data-setting="autoOpen"]').checked = !!settings.autoOpen;
            ui.settings.querySelector('[data-setting="quickReplies"]').value = settings.quickReplies.join('\n');
          }
          break;
        }
        case 'reply': {
          const c = findComment(cid, parentId);
          if (c) startReply(parentId, c.user.username);
          break;
        }
        case 'cancel':
          cancelReply();
          break;
        case 'send':
          sendReply();
          break;
        case 'quick':
          insertIntoDraft(b.dataset.text);
          break;
        case 'like':
          toggleLike(cid, parentId);
          break;
        case 'done':
          toggleDone(cid);
          break;
        case 'thread':
          toggleThread(cid);
          break;
        case 'load-thread':
          loadChildren(parentId).catch((err) => toast(err.message));
          break;
        case 'more':
          state.limit += RENDER_STEP;
          render();
          break;
      }
    });

    ui.list.addEventListener('input', (e) => {
      if (e.target.matches('.composer textarea')) state.draft = e.target.value;
    });

    ui.settings.addEventListener('change', (e) => {
      const key = e.target.dataset.setting;
      if (key === 'autoOpen') settings.autoOpen = e.target.checked;
      if (key === 'quickReplies') {
        settings.quickReplies = e.target.value
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
      }
      saveSettings();
      render();
    });

    ui.root.addEventListener('keydown', (e) => {
      const t = e.composedPath()[0];
      if (t.matches?.('.composer textarea')) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          sendReply();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelReply();
        }
        return;
      }
      if (t === ui.search) {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (ui.search.value) {
            ui.search.value = '';
            state.query = '';
            render();
          } else ui.list.focus({ preventScroll: true });
        } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault();
          state.selected = null;
          ui.list.focus({ preventScroll: true });
          moveSelection(1);
        }
        return;
      }
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const sel = state.selected && state.comments.get(state.selected);
      switch (e.key) {
        case '/':
          e.preventDefault();
          ui.search.focus();
          ui.search.select();
          break;
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          moveSelection(1);
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          moveSelection(-1);
          break;
        case 'Enter':
          if (t.tagName === 'BUTTON' || t.tagName === 'A') break;
        // falls through
        case 'r':
          if (sel) {
            e.preventDefault();
            startReply(sel.pk, sel.user.username);
          }
          break;
        case 'l':
          if (sel) toggleLike(sel.pk, sel.pk);
          break;
        case 'd':
          if (sel && state.isOwn) toggleDone(sel.pk);
          break;
        case 'Escape':
          e.preventDefault();
          closePanel();
          break;
      }
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== 'toggle') return;
      if (lastPath === null) openRequested = true;
      else if (state.open) closePanel();
      else openPanel();
    });
  }

  // A newer copy of this script (after an extension reload) takes over from this one.
  function superseded() {
    return window.__igCommentDesk !== instance || !chrome.runtime?.id;
  }

  function watchRoute() {
    let timer;
    const check = () => {
      if (superseded()) {
        clearInterval(timer);
        window.removeEventListener('popstate', check);
        ui.host.remove();
        return;
      }
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      handleRoute();
    };
    timer = setInterval(check, 400);
    window.addEventListener('popstate', check);
    check();
  }

  bindUi();
  loadSettings().then(watchRoute);
})();
