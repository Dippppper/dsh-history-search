/**
 * dsh-history-search — Client half.
 *
 * A right-sidebar tab, at the same level as the "Chat" / "Trajectory" /
 * "Browser" tabs. With no keyword it lists the cards of the messages YOU sent
 * in the current conversation; typing a keyword filters them live; clicking a
 * card jumps to that message in the main conversation flow.
 *
 * Everything lives in an IIFE: DSH concatenates all client plugins into one
 * script, so top-level const/let would collide with other bundles.
 */
;(() => {
  const TAB_ID = 'dsh-history-search';
  const TAB_KIND = 'dsh-history-search';
  const PAGE_BUDGET = 400;
  const MAX_PAGES = 40;
  const TAIL_PAGES = 5; // bounded backward walk while catching up with the cache
  const CACHE_MAX = 8; // keep at most this many per-session card caches
  const LOCATE_TIMEOUT_MS = 30000;
  const LOCATE_INTERVAL_MS = 140;
  const LOAD_THROTTLE_MS = 500;
  const MAX_LOAD_ATTEMPTS = 60;
  const TOP_SETTLE_MS = 3000; // time the "load earlier" button must stay gone
  let jumpToken = 0; // cancels a previous in-flight jump when a new card is clicked
  const PREVIEW_CHARS = 220;
  const NEEDLE_CHARS = 34;

  const I18N = {
    zh: {
      tab: '历史',
      title: '历史对话',
      search: '搜索历史对话',
      refresh: '刷新',
      hint: '点击卡片跳转到对话中的对应消息',
      count: (n) => `共 ${n} 条`,
      match: (n) => `匹配 ${n} 条`,
      ordinal: (n) => `#${n}`,
      unit: '条',
      hasImage: '含图片',
      imageOnly: '（图片消息）',
      quoteFrom: (n) => `引用自消息 ${n}`,
      quoteOnly: '（引用消息）',
      filterImage: '只看含图片的消息',
      filterQuote: '只看含引用的消息',
      copy: '复制内容',
      copied: '已复制',
      copyFailed: '复制失败，请手动选择文本',
      insert: '填回输入框',
      insertBlocked: '输入框当前不可编辑',
      insertUnavailable: '输入框尚未就绪',
      retry: '重试',
      emptyAll: '这个会话里还没有你发的消息',
      emptyMatch: '没有匹配的消息',
      failed: (m) => `读取失败：${m}`,
      noService: '会话数据服务尚未就绪',
      noSession: '未检测到已打开的会话',
      time: 'zh-CN',
    },
    en: {
      tab: 'History',
      title: 'History',
      search: 'Search history',
      refresh: 'Refresh',
      hint: 'Click a card to jump to that message',
      count: (n) => `${n} messages`,
      match: (n) => `${n} matches`,
      ordinal: (n) => `#${n}`,
      unit: '',
      hasImage: 'Contains image',
      imageOnly: '(image message)',
      quoteFrom: (n) => `Quoted from message ${n}`,
      quoteOnly: '(quote message)',
      filterImage: 'Only messages with images',
      filterQuote: 'Only messages with quotes',
      copy: 'Copy text',
      copied: 'Copied',
      copyFailed: 'Copy failed — select the text manually',
      insert: 'Insert into composer',
      insertBlocked: 'The composer is not editable right now',
      insertUnavailable: 'The composer is not ready yet',
      retry: 'Retry',
      emptyAll: 'No messages you sent in this conversation yet',
      emptyMatch: 'No matching messages',
      failed: (m) => `Failed: ${m}`,
      noService: 'Session data service is not ready',
      noSession: 'No open conversation detected',
      time: 'en-US',
    },
  };

  window.__ModuleLoader__.load({
    id: '@local/dsh-history-search',
    factory: (require) => {
      const React = require('react');
      const h = React.createElement;
      const module = { exports: {} };
      const exports = module.exports;

      /* ---------------------------------------------------------------- *
       * Theme tokens only (no literal UI colors).                          *
       * ---------------------------------------------------------------- */
      const C = {
        text: 'var(--dsw-alias-label-primary)',
        sub: 'var(--dsw-alias-label-secondary)',
        tertiary: 'var(--dsw-alias-label-tertiary)',
        border: 'var(--dsw-alias-border-l1)',
        border2: 'var(--dsw-alias-border-l2)',
        surface: 'var(--dsw-alias-bg-layer-1)',
        surface2: 'var(--dsw-alias-bg-layer-2)',
        hover: 'var(--dsw-alias-interactive-bg-hover)',
        accent: 'var(--dsw-alias-brand-primary)',
        mark: 'var(--dsw-static-amber-100)',
        error: 'var(--dsw-alias-state-error-primary)',
      };

      /* ---------------------------------------------------------------- *
       * Locales: prefer the host locale service, fall back to <html lang>. *
       * ---------------------------------------------------------------- */
      function makeT(ctx) {
        // Deliberately do NOT touch the host `locale` service: our dictionaries
        // contain function-valued entries (count/match/failed) that a LocaleDict
        // schema would reject. Resolve the language on every call instead, so a
        // host language switch takes effect on the next render.
        const readLang = () => {
          let raw = '';
          try {
            const locale = ctx && (ctx.get ? ctx.get('locale') : ctx.locale);
            if (locale && typeof locale.getLocale === 'function') {
              const info = locale.getLocale();
              raw = (info && info.active) || '';
            }
          } catch (_) { /* optional */ }
          if (!raw && typeof document !== 'undefined') raw = document.documentElement.lang || '';
          return /^en/i.test(raw) ? 'en' : 'zh';
        };
        return (key, ...args) => {
          const dict = I18N[readLang()] || I18N.zh;
          const value = dict[key];
          return typeof value === 'function' ? value(...args) : (value !== undefined ? value : key);
        };
      }

      /* ---------------------------------------------------------------- *
       * Service handles, filled by ctx.inject as dependencies mount.       *
       * ---------------------------------------------------------------- */
      let sessionApi = null; // remote.session (sessionController client face)
      let sessionsSvc = null; // ctx.sessions: binding(id).session.loadThrough(seq)
      let layoutApi = null;
      let workspaceApi = null;

      function getSvc(ctx, name) {
        try { return ctx && ctx.get ? ctx.get(name) : undefined; } catch (_) { return undefined; }
      }

      /* ---------------------------------------------------------------- *
       * Session event -> "message I sent" extraction.                      *
       * Returns { text, hasImage, quoteCount }: image content blocks       *
       * ({type:'image', data, mimeType}) carry no searchable text but are  *
       * flagged so the card can show an image badge next to the date.      *
       * dsh-select-quote folds selection quotes into the same text as a    *
       * "# Response annotations:" + <response-annotations>[JSON] block;    *
       * that protocol payload is stripped from the preview and counted.    *
       * ---------------------------------------------------------------- */
      // Split a select-quote protocol block off the message text. Returns the
      // user's own words and, per quote, {messageId, kind} of the message the
      // quoted text came from. The wire item's source may be singular
      // (`source`) or plural (`sources`, when several passages were quoted in
      // one go), and each source may lack messageId entirely (pure text
      // fallback) — mirror select-quote's sourcesOf. kind classifies the
      // source message: user / tool / assistant (from its flow key).
      //
      // MIRROR OF dsh-select-quote's blockParts (client.js L5599): the wire
      // format is  [optional prose] # Response annotations: <tag>JSON</tag>
      // [user text]  — the user's typed words come AFTER the block
      // (composeBlock: `${block}\n\n${rest}`), and older drafts may carry
      // prose before it. So the real text = before + after, joined.
      function splitQuoteBlock(text) {
        const fallback = { text, quotes: [] };
        if (!text) return fallback;
        const open = text.indexOf('<response-annotations>');
        if (open === -1) return fallback;
        const OPEN_LEN = '<response-annotations>'.length;
        const CLOSE_LEN = '</response-annotations>'.length;
        const payloadStart = open + OPEN_LEN;
        // Tolerant close search: retry after each failed JSON.parse, exactly
        // like the plugin does, so embedded lookalike text can't break us.
        let close = text.indexOf('</response-annotations>', payloadStart);
        let arr = null;
        while (close >= 0) {
          try {
            const parsed = JSON.parse(text.slice(payloadStart, close).trim());
            if (Array.isArray(parsed)) { arr = parsed; break; }
          } catch (_) { /* try the next closer */ }
          close = text.indexOf('</response-annotations>', close + CLOSE_LEN);
        }
        if (!arr) {
          // No valid block: leave the text untouched (a draft that merely
          // mentions the markers must never be edited away).
          return { text, quotes: [] };
        }
        const kindOfFlowKey = (key) => {
          if (key.includes('input-message')) return 'user';
          if (key.includes('tool-call')) return 'tool';
          return 'assistant';
        };
        const quotes = [];
        for (const item of arr) {
          if (!item || typeof item !== 'object') continue;
          const rawSources = Array.isArray(item.sources) ? item.sources
            : (item.source && typeof item.source === 'object' ? [item.source] : []);
          for (const src of rawSources) {
            if (!src || typeof src !== 'object') continue;
            const mid = typeof src.messageId === 'string' ? src.messageId : '';
            if (!mid) continue;
            if (quotes.some((q) => q.messageId === mid)) continue;
            quotes.push({ messageId: mid, kind: kindOfFlowKey(mid) });
          }
        }
        // Header prose ("# Response annotations:" + instructions) sits before
        // the open tag when present; drop it from the user's words.
        let before = text.slice(0, open);
        const header = before.indexOf('# Response annotations:');
        if (header >= 0) before = before.slice(0, header);
        before = before.replace(/\s+$/, '');
        const after = text.slice(close + CLOSE_LEN).replace(/^\s+/, '');
        const parts = [before, after].filter((p) => p.length > 0);
        const rest = parts.join('\n\n').trim();
        return { text: rest || undefined, quotes };
      }

      function userText(event) {
        if (!event || event.type !== 'user/message') return undefined;
        const data = event.data || {};
        const source = data.source || {};
        if (source.kind !== 'user') return undefined; // real human input only
        const c = data.content;
        if (typeof c === 'string') {
          const raw = c.trim() || '';
          const s = splitQuoteBlock(raw);
          // A quote-only message (no typed words) must still show up.
          if (!s.text && s.quotes.length === 0) return undefined;
          return { text: s.text || undefined, hasImage: false, quotes: s.quotes };
        }
        if (!Array.isArray(c)) return undefined;
        let out = '';
        let hasImage = false;
        for (const b of c) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'image') hasImage = true;
          if (b.type === 'text' && typeof b.text === 'string') {
            out += (out ? '\n' : '') + b.text;
          }
        }
        const s = splitQuoteBlock(out.trim());
        const text = s.text || undefined;
        // Image-only AND quote-only messages still deserve a card.
        if (!text && !hasImage && s.quotes.length === 0) return undefined;
        return { text, hasImage, quotes: s.quotes };
      }

      function currentSessionId(snapshot) {
        if (!snapshot) return undefined;
        if (snapshot.current !== undefined && snapshot.current !== null) return snapshot.current;
        const byId = snapshot.byId || {};
        for (const id of Object.keys(byId)) {
          const row = byId[id];
          if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) return row.id || id;
        }
        return undefined;
      }

/* ---------------------------------------------------------------- *
       * Per-session card cache.                                           *
       *                                                                   *
       * Session events are an append-only log, so a card list built once  *
       * stays valid later: reopening a session only needs the tail delta, *
       * not another 40-page sweep of the whole conversation.              *
       * ---------------------------------------------------------------- */
      const CACHE = new Map(); // sessionId -> cache record

      function newCache() {
        return {
          cards: [],          // chronological, oldest -> newest
          bySeq: new Map(),   // event seq -> card
          byId: new Map(),    // message id (string) -> card
          turnToOrdinal: {},  // engine turn -> ordinal of the message that opened it
          openTurn: null,
          ordinal: 0,
          lastSeq: -1,
          ready: false,
          historyComplete: false,
        };
      }

      function ensureCache(sessionId) {
        let cache = CACHE.get(sessionId);
        if (cache) return cache;
        cache = newCache();
        CACHE.set(sessionId, cache);
        while (CACHE.size > CACHE_MAX) {
          const oldest = CACHE.keys().next().value;
          if (oldest === sessionId) break;
          CACHE.delete(oldest);
        }
        return cache;
      }

      // Turn ordinal map: "which user message started engine turn N". The
      // engine turn number comes from turn/start / step/start events, NOT from
      // user/message (its data has no turn field). A quote sourced from an
      // assistant step ("14:assistant-step<turn>:<step>") resolves through this
      // map to the user message that began the turn.
      //
      // Every batch is either a full rebuild (reset) or an append-only delta;
      // seq is monotonic, so "seq > lastSeq" is exactly "not applied yet".
      // Older pages are never merged: the list only grows at the tail, which
      // keeps ordinals stable while a session stays open.
      function applyEvents(cache, events, reset) {
        if (!cache || !Array.isArray(events)) return 0;
        if (reset) {
          cache.cards = [];
          cache.bySeq = new Map();
          cache.byId = new Map();
          cache.turnToOrdinal = {};
          cache.openTurn = null;
          cache.ordinal = 0;
          cache.lastSeq = -1;
        }
        const fresh = [];
        const seen = new Set();
        for (const e of events) {
          if (!e || typeof e !== 'object') continue;
          const seq = e.seq;
          if (typeof seq !== 'number' || !isFinite(seq)) continue;
          if (seq <= cache.lastSeq || seen.has(seq)) continue;
          seen.add(seq);
          fresh.push(e);
        }
        if (fresh.length === 0) return 0;
        fresh.sort((a, b) => a.seq - b.seq);
        const added = [];
        for (const e of fresh) {
          const data = e.data || {};
          if (e.type === 'turn/start' && typeof data.turn === 'number') {
            cache.openTurn = data.turn;
          } else if (e.type === 'step/start' && typeof data.turn === 'number') {
            if (cache.openTurn === null) cache.openTurn = data.turn;
          } else if (e.type === 'turn/end') {
            cache.openTurn = null;
          }
          const msg = userText(e);
          if (!msg) continue;
          cache.ordinal += 1;
          if (cache.openTurn !== null && !(cache.openTurn in cache.turnToOrdinal)) {
            cache.turnToOrdinal[cache.openTurn] = cache.ordinal;
          }
          const card = {
            seq: e.seq,
            time: e.time,
            text: msg.text || '',
            hasImage: msg.hasImage,
            quotes: msg.quotes || [],
            id: dataId(e),
            ordinal: cache.ordinal,
          };
          cache.cards.push(card);
          cache.bySeq.set(card.seq, card);
          if (card.id !== undefined && card.id !== null) cache.byId.set(String(card.id), card);
          added.push(card);
        }
        cache.lastSeq = fresh[fresh.length - 1].seq;
        if (added.length) resolveQuoteOrdinals(cache, added);
        return added.length;
      }

      // Resolve quote ordinals for the cards just appended.
      // 1) user-sourced: the flow key tail is the source message's data.id.
      // 2) assistant/tool-sourced: parse the turn number out of the flow key
      //    ("14:assistant-step<turn>:<step>") and map it through
      //    turnToOrdinal to the user message that started that turn.
      function resolveQuoteOrdinals(cache, cards) {
        for (const card of cards) {
          for (const q of card.quotes || []) {
            if (q.ordinal) continue;
            let resolved = null;
            if (q.kind === 'user') {
              const key = /input-message(.+)$/.exec(q.messageId);
              const direct = key ? cache.byId.get(key[1]) : undefined;
              if (direct) resolved = direct.ordinal;
              else {
                for (const c of cache.cards) {
                  if (c.id !== undefined && c.id !== null && q.messageId.endsWith(String(c.id))) {
                    resolved = c.ordinal;
                    break;
                  }
                }
              }
            } else {
              // Assistant flow keys embed the turn: "14:assistant-step19:18".
              const m = /assistant-step(\d+):/.exec(q.messageId) ||
                        /turn-process(\d+):/.exec(q.messageId);
              if (m) {
                const turn = Number(m[1]);
                if (turn in cache.turnToOrdinal) resolved = cache.turnToOrdinal[turn];
              }
            }
            q.ordinal = resolved;
          }
        }
      }

      async function fetchPage(api, sessionId, beforeSeq, signal) {
        const request = {
          address: { kind: 'session', sessionId },
          maxMessages: PAGE_BUDGET,
        };
        if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;
        let outcome;
        try {
          outcome = await api.events(request, signal);
        } catch (err) {
          if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) throw err;
          // Some client generations omit the cancellation parameter.
          outcome = await api.events(request);
        }
        // RemoteResult envelope { ok, value } or a bare SessionEventsPage.
        let result = outcome;
        if (outcome && typeof outcome === 'object' && 'ok' in outcome) {
          if (!outcome.ok) throw new Error((outcome.error && outcome.error.message) || 'remote error');
          result = outcome.value;
        }
        return result || null;
      }

      // Full sweep: page backwards until the conversation start or the budget
      // runs out. Records may arrive newest-first per page (backward cursor), so
      // everything is collected first and sorted into chronological order.
      async function loadHistory(api, sessionId, signal) {
        const events = [];
        let beforeSeq;
        let complete = false;
        for (let page = 0; page < MAX_PAGES; page++) {
          const result = await fetchPage(api, sessionId, beforeSeq, signal);
          if (!result || !Array.isArray(result.records)) break;
          let minSeq;
          for (const record of result.records) {
            const e = record && record.event;
            if (!e) continue;
            if (typeof e.seq === 'number' && isFinite(e.seq)) {
              if (minSeq === undefined || e.seq < minSeq) minSeq = e.seq;
            }
            events.push(e);
          }
          if (!result.hasMore || minSeq === undefined) { complete = !result.hasMore; break; }
          // beforeSeq is a backward cursor: ask for the page strictly older
          // than the oldest event we just saw. Using the minimum keeps this
          // correct whether `records` is chronological or reverse-chronological.
          if (beforeSeq !== undefined && minSeq >= beforeSeq) break; // no progress
          beforeSeq = minSeq;
        }
        events.sort((a, b) => (a.seq || 0) - (b.seq || 0));
        return { events, complete };
      }

      // Cheap revalidation for a cached session: one tail page in the common
      // case. When the newest page no longer overlaps what we hold, the gap is
      // reported so the caller can fall back to a full rebuild.
      async function syncTail(api, sessionId, cache, signal) {
        const floor = cache.lastSeq;
        const collected = [];
        let beforeSeq;
        for (let page = 0; page < TAIL_PAGES; page++) {
          const result = await fetchPage(api, sessionId, beforeSeq, signal);
          if (!result || !Array.isArray(result.records)) return false;
          if (result.records.length === 0) return true; // nothing new
          let minSeq;
          for (const record of result.records) {
            const e = record && record.event;
            if (!e) continue;
            if (typeof e.seq === 'number' && isFinite(e.seq)) {
              if (minSeq === undefined || e.seq < minSeq) minSeq = e.seq;
            }
            collected.push(e);
          }
          if (minSeq === undefined) return false;
          if (minSeq <= floor) { // overlaps what we hold: the merge is gapless
            applyEvents(cache, collected, false);
            return true;
          }
          if (!result.hasMore) return false;
          beforeSeq = minSeq;
        }
        return false;
      }

      // Live source: the very Session object the chat view reads. Its
      // `eventSource` publishes the loaded window, and every notification
      // carries entries we can merge by seq (duplicates are ignored).
      function liveBinding(sessionId) {
        try {
          const svc = sessionsSvc;
          if (!svc || typeof svc.binding !== 'function') return null;
          const binding = svc.binding(sessionId);
          const session = binding && binding.session;
          const source = session && session.eventSource;
          if (!source || typeof source.subscribe !== 'function' ||
              typeof source.getSnapshot !== 'function') return null;
          return { binding, source };
        } catch (_) { return null; }
      }

      function eventsFromSnapshot(snapshot) {
        const entries = snapshot && Array.isArray(snapshot.entries) ? snapshot.entries : [];
        const out = [];
        for (const entry of entries) {
          if (!entry) continue;
          const e = entry.event || entry;
          if (e && typeof e.type === 'string') out.push(e);
        }
        return out;
      }

      function dataId(e) {
        const d = e && e.data;
        return d && d.id !== undefined ? d.id : undefined;
      }

      /* ---------------------------------------------------------------- *
       * Row lookup. IMPORTANT: this function is a pure read of the live DOM.*
       * It must NEVER write anchors back onto `card`. A previous version    *
       * cached the first fuzzy text match into card.flowKey, which then     *
       * short-circuited every later click to the WRONG row (and paging      *
       * stopped early). Cards keep only their data-layer identity.          *
       * ---------------------------------------------------------------- */
      function allFlowRows() {
        try { return Array.prototype.slice.call(
          document.querySelectorAll('[data-chat-flow-key]')); } catch (_) { return []; }
      }

      // Is this flow row one of MY user messages? The host tags ordinary user
      // rows with data-chat-flow-kind="user" and steering rows with
      // "steering" (both render the user-message surface). Group rows carry
      // data-chat-group-key and must be excluded. Folded rows stay in the DOM
      // with [hidden]; they are still real rows we can scroll to.
      function isUserRow(r) {
        if (r.hasAttribute && r.hasAttribute('data-chat-group-key')) return false;
        const kind = r.getAttribute('data-chat-flow-kind') || '';
        if (kind === 'user' || kind === 'steering') return true;
        const nk = (r.getAttribute('data-chat-node-key') || '') + ' ' +
                   (r.getAttribute('data-chat-flow-key') || '');
        return /input-message/.test(nk) &&
               !/(assistant|tool|system|reasoning|compaction|turn-process)/i.test(kind);
      }

      // De-duplicated user rows in document order (oldest -> newest). One
      // user message can yield several flow rows (group parts); keep one per
      // node-key / flow-key so ordinal counting stays 1:1 with the cards.
      function userRowsInOrder() {
        const out = [];
        const seen = Object.create(null);
        for (const r of allFlowRows()) {
          if (!isUserRow(r)) continue;
          const nk = r.getAttribute('data-chat-node-key') || '';
          const fk = r.getAttribute('data-chat-flow-key') || '';
          const key = nk || fk;
          if (!key || seen[key]) continue;
          seen[key] = 1;
          out.push(r);
        }
        return out;
      }

      function findRow(card, allLoaded) {
        if (typeof document === 'undefined') return null;
        const rows = allFlowRows();
        if (!rows.length) return null;
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const uniq = (hits) => (hits.length === 1 ? hits[0] : null);

        // 0) Once we have paged all the way to the conversation start
        //    (hasMore === false, i.e. the "load earlier" button is gone), the
        //    DOM holds EVERY message. Then the Nth user row in document order
        //    IS the Nth message you sent. This is exact, immune to identical
        //    short texts, and must take priority over fuzzy matching.
        //    BEFORE that, the DOM is only the loaded tail window, so counting
        //    rows would address a purely local index — never do it.
        if (allLoaded && card.ordinal) {
          const ordered = userRowsInOrder();
          const target = ordered[card.ordinal - 1];
          if (target) return target;
        }

        // 1) Identity by message id. data-chat-node-key is a synthetic value
        //    `${kind.length}:input-message${event.data.id}` (ui-conversation's
        //    conversationContextKey), NOT the bare id. Require a unique hit.
        const id = card.id === undefined ? '' : String(card.id);
        if (id) {
          const hits = rows.filter((r) => {
            const nk = r.getAttribute('data-chat-node-key') || '';
            const ak = r.getAttribute('data-chat-anchor-key') || '';
            return nk === id || nk.endsWith(id) || ak === id || ak.endsWith(id);
          });
          const hit = uniq(hits);
          if (hit) return hit;
        }

        // 2) Prefix text match, but NEVER "first hit wins": a short prefix
        //    can be shared by neighbouring messages. Collect ALL user-row
        //    hits, require exactly one; if several, re-filter with a longer
        //    needle. Ambiguous => return null and keep loading (never guess).
        const needle = norm(card.text.slice(0, NEEDLE_CHARS));
        if (needle.length >= 6) {
          let hits = rows.filter((r) =>
            norm(r.textContent).indexOf(needle) !== -1 && isUserRow(r));
          const one = uniq(hits);
          if (one) return one;
          if (hits.length > 1) {
            const long = norm(card.text.slice(0, 90));
            if (long.length > needle.length) {
              hits = hits.filter((r) => norm(r.textContent).indexOf(long) !== -1);
              const exact = uniq(hits);
              if (exact) return exact;
            }
          }
        }
        return null;
      }

      function ensureChatView(openView) {
        if (typeof document === 'undefined') return;
        if (typeof openView === 'function') {
          try { openView('chat', ''); return; } catch (_) { /* fall through */ }
        }
        try {
          const direct = document.querySelector('[data-view-id="chat"],[data-conversation-view="chat"]');
          if (direct) { direct.click(); return; }
          const buttons = document.querySelectorAll('button,[role="tab"]');
          for (const b of buttons) {
            const label = (b.textContent || '').trim();
            if (/^(对话|Chat)$/i.test(label)) { b.click(); return; }
          }
        } catch (_) { /* optional */ }
      }

      // The host's beginPaging() anchors the viewport while older rows are
      // inserted above it, and can restore the old scroll position afterwards.
      // A single smooth scrollIntoView is therefore easily undone. Re-assert
      // the position a few times (instant, not smooth) and only then flash.
      //
      // IMPORTANT: scrollIntoView does NOT reliably scroll the ChatView
      // scrollport, whose computed overflow is `clip auto` (overflow-y: auto).
      // So we resolve the actual scroll container and set its scrollTop
      // directly, with scrollIntoView only as a last-resort fallback.
      function findScrollContainer() {
        try {
          const anchor = document.querySelector('[data-chat-flow-key]');
          if (!anchor) return null;
          let node = anchor.parentElement;
          for (let i = 0; node && i < 12; i++, node = node.parentElement) {
            if (node.hasAttribute && node.hasAttribute('data-conversation-scroll')) return node;
            const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
            if (!style) continue;
            const oy = (style.overflowY || '') + ' ' + (style.overflow || '');
            if (/(auto|scroll)/.test(oy) && node.scrollHeight > node.clientHeight + 4) return node;
          }
          return null;
        } catch (_) { return null; }
      }

      function flashRow(row) {
        let logged = false;
        const scrollTo = (smooth) => {
          const container = findScrollContainer();
          if (container) {
            try {
              const before = container.scrollTop;
              const rect = row.getBoundingClientRect();
              const cRect = container.getBoundingClientRect();
              const target = Math.max(0, before + (rect.top - cRect.top)
                + (rect.height / 2) - (container.clientHeight / 2));
              if (smooth) {
                // Smooth animated scroll on the first pass; fall back to an
                // instant write if the container rejects options.
                try { container.scrollTo({ top: target, behavior: 'smooth' }); }
                catch (_) { container.scrollTop = target; }
              } else {
                container.scrollTop = target;
                if (!logged) {
                  logged = true;
                  try {
                    console.log('[dsh-history-search] scroll', JSON.stringify({
                      containerTag: container.tagName,
                      cls: (container.className || '').toString().slice(0, 40),
                      overflowY: (window.getComputedStyle ? window.getComputedStyle(container).overflowY : ''),
                      before: Math.round(before), target: Math.round(target),
                      after: Math.round(container.scrollTop),
                      scrollHeight: container.scrollHeight, clientHeight: container.clientHeight,
                    }));
                  } catch (_) {}
                }
              }
              return;
            } catch (_) { /* fall through to scrollIntoView */ }
          }
          try { row.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (_) {
            try { row.scrollIntoView({ block: 'center' }); } catch (_) {}
          }
        };

        // Smooth-scroll to the target and show the blue arrow landmark ONCE.
        scrollTo(true);
        // Single shot: add the class once and let the CSS animation run its
        // course (fade out). Never re-add it during the scroll re-asserts —
        // replaying the animation made the arrow blink continuously.
        try {
          row.classList.remove('dhs-landmark');
          void row.offsetWidth; // reflow so a fresh click replays it
          row.classList.add('dhs-landmark');
        } catch (_) { /* optional */ }
        try { row.focus && row.focus({ preventScroll: true }); } catch (_) { /* optional */ }

        // Re-assert the scroll position a few times (spaced after the smooth
        // animation finishes) to defeat any beginPaging anchor that restored
        // the old position. No landmark touching here.
        [600, 1200, 2000].forEach((ms) => window.setTimeout(() => {
          scrollTo(false);
        }, ms));

        // Clean the class up once the fade-out has finished.
        window.setTimeout(() => { try { row.classList.remove('dhs-landmark'); } catch (_) {} }, 2000);
      }

      function flowRows() {
        try {
          return document.querySelectorAll('[data-chat-flow-key]');
        } catch (_) { return []; }
      }

      // Earliest currently-loaded chat row: the first flow row in document
      // order (the chat flow renders oldest -> newest).
      function earliestLoadedRow() {
        const rows = flowRows();
        for (const r of rows) {
          if (r.getClientRects && r.getClientRects().length) return r;
        }
        return rows.length ? rows[0] : null;
      }

      // The host's "load earlier" control is a real <button> at the very top of
      // the message column. It only exists while `hasMore` is true, is disabled
      // and relabeled ("载入中" / "Loading…") while a page is loading. There is
      // NO scroll sentinel / IntersectionObserver: clicking it is the only way
      // to page older messages in (ui-chat: onClick -> scroll.loadEarlier ->
      // session.loadOlder). Returns one of: 'clicked' | 'loading' | 'absent'.
      function findLoadEarlierButton() {
        const buttons = document.querySelectorAll('button');
        for (const b of buttons) {
          const txt = (b.textContent || '').trim();
          if (/^(加载更早|载入中|加载中|Load earlier|Loading)/i.test(txt)) return b;
          // CSS-module class of the wrapper: ..._older (hash may change).
          const parent = b.parentElement;
          if (parent && /_older\b/.test(parent.className || '')) return b;
        }
        return null;
      }

      function triggerLoadEarlier() {
        const btn = findLoadEarlierButton();
        if (!btn) return 'absent';
        if (btn.disabled) return 'loading';
        // Some hosts keep the button off-screen; scroll the flow to the top so
        // the click is on a mounted, visible control.
        scrollFlowTop();
        try { btn.click(); return 'clicked'; } catch (_) { return 'loading'; }
      }

      function scrollFlowTop() {
        try {
          const c = findScrollContainer();
          if (c && c.scrollTop > 0) c.scrollTop = 0;
        } catch (_) { /* optional */ }
      }

      // Preferred fast path: the sessions service exposes the very Session
      // object the ChatView itself uses. Its loadThrough(seq) pages backwards
      // in 200-message jumps until the window covers `seq` — one shot instead
      // of dozens of "load earlier" clicks.
      //
      // CRITICAL: this returns a Promise so the caller can AWAIT it before it
      // ever clicks the "load earlier" button. Clicking that button calls the
      // host's loadEarlier() -> viewport.beginPaging(), which anchors the
      // viewport and later undoes our scrollIntoView. Running both in parallel
      // is exactly what left the view stuck at the first loaded page (the user
      // had to scroll manually to break the anchor). So the two paths must be
      // strictly serialised: loadThrough first, button fallback second.
      // Returns null when the precise loader is unavailable.
      function loadThroughTarget(card, sessionId) {
        try {
          const svc = sessionsSvc;
          if (!svc || typeof svc.binding !== 'function' || !sessionId) return null;
          const binding = svc.binding(sessionId);
          const session = binding && binding.session;
          if (!session || typeof session.loadThrough !== 'function') return null;
          if (typeof card.seq !== 'number' || !isFinite(card.seq)) return null;
          const p = session.loadThrough(card.seq);
          if (!p || typeof p.then !== 'function') return null;
          try { console.log('[dsh-history-search] loadThrough', card.seq, sessionId); } catch (_) {}
          return p.catch((err) => {
            try { console.warn('[dsh-history-search] loadThrough rejected', err); } catch (_) {}
          });
        } catch (err) {
          try { console.warn('[dsh-history-search] loadThroughTarget failed', err); } catch (_) {}
          return null;
        }
      }

      function locate(card, openView, t, sessionId) {
        const myToken = ++jumpToken;
        const started = Date.now();
        let lastEnsure = 0;
        let lastLoad = 0;
        let loadAttempts = 0;
        let buttonGoneSince = 0; // timestamp when "load earlier" first vanished
        let preciseDone = false; // loadThrough() settled (or was unavailable)
        let preciseSettledAt = 0; // when loadThrough() settled (render grace start)

        try { console.log('[dsh-history-search] locate start', JSON.stringify({ seq: card.seq, ordinal: card.ordinal, id: card.id, sessionId })); } catch (_) {}

        const giveUp = () => {
          const ordered = userRowsInOrder();
          const earliest = ordered.length ? ordered[0] : earliestLoadedRow();
          if (earliest) flashRow(earliest);
          else scrollFlowTop();
        };

        const tick = () => {
          if (myToken !== jumpToken) return; // a newer click took over
          // Pure DOM read: no anchors are cached onto `card`, so a second
          // click always re-evaluates from scratch.
          // Independently track whether the "load earlier" button is gone.
          const buttonPresent = !!findLoadEarlierButton();
          if (buttonPresent) buttonGoneSince = 0;
          else if (!buttonGoneSince) buttonGoneSince = Date.now();
          // "At the top" is confirmed only after the button has stayed absent
          // for TOP_SETTLE_MS: the last page may still be rendering.
          const atTop = buttonGoneSince > 0 &&
            (Date.now() - buttonGoneSince) >= TOP_SETTLE_MS;
          let row = findRow(card, atTop);

          if (!row) {
            const now = Date.now();
            scrollFlowTop();
            if (now - lastEnsure > 3000) {
              lastEnsure = now;
              ensureChatView(openView);
            }
            row = findRow(card, atTop);
          }

          if (row) {
            try { console.log('[dsh-history-search] found row, flashing', card.ordinal); } catch (_) {}
            flashRow(row);
            return;
          }

          // SERIALISATION GATE: while the precise loadThrough() is still
          // paging, do NOT click "load earlier". Clicking it runs the host's
          // loadEarlier() -> viewport.beginPaging(), which anchors the viewport
          // and later undoes our scrollIntoView. That parallel path was exactly
          // what left the view stuck at the first loaded page. Wait for the
          // precise loader to settle; only then fall back to the button.
          if (!preciseDone) {
            if (Date.now() - started >= LOCATE_TIMEOUT_MS) { giveUp(); return; }
            window.setTimeout(tick, LOCATE_INTERVAL_MS);
            return;
          }

          // Render grace: after loadThrough() settled, the freshly inserted
          // rows still need a moment to mount before findRow can see them.
          // Don't reach for the button during this window either (same
          // beginPaging hazard) — just keep polling.
          if (preciseSettledAt && (Date.now() - preciseSettledAt) < 600) {
            if (Date.now() - started >= LOCATE_TIMEOUT_MS) { giveUp(); return; }
            window.setTimeout(tick, LOCATE_INTERVAL_MS);
            return;
          }

          // Fallback: click "load earlier" (only after loadThrough finished or
          // was unavailable). Each click re-anchors via beginPaging, so once the
          // row appears, re-assert the scroll a few extra times.
          if (Date.now() - lastLoad > LOAD_THROTTLE_MS) {
            lastLoad = Date.now();
            const state = triggerLoadEarlier();
            if (state === 'clicked') loadAttempts += 1;
            const topNow = buttonGoneSince > 0 &&
              (Date.now() - buttonGoneSince) >= TOP_SETTLE_MS;
            row = findRow(card, topNow);
            if (row) {
              flashRow(row);
              return;
            }
            if (topNow) { giveUp(); return; }
          }

          if (loadAttempts >= MAX_LOAD_ATTEMPTS) { giveUp(); return; }
          if (Date.now() - started >= LOCATE_TIMEOUT_MS) { giveUp(); return; }
          window.setTimeout(tick, LOCATE_INTERVAL_MS);
        };

        // Phase 1: precise loadThrough, awaited with a timeout, then let React
        // render the newly inserted rows. Phase 2: the tick loop (find row, then
        // button fallback) only begins once the precise path has settled.
        const precise = loadThroughTarget(card, sessionId);
        if (precise) {
          const timeout = new Promise((resolve) => window.setTimeout(resolve, 8000));
          Promise.race([precise, timeout]).then(() => {
            if (myToken !== jumpToken) return;
            preciseDone = true;
            preciseSettledAt = Date.now();
            try { console.log('[dsh-history-search] loadThrough settled'); } catch (_) {}
            window.setTimeout(() => { if (myToken === jumpToken) tick(); }, 120);
          });
          // Poll immediately too: the row may already be in the loaded window.
          window.setTimeout(tick, 60);
        } else {
          preciseDone = true;
          try { console.warn('[dsh-history-search] loadThrough unavailable, falling back to button paging'); } catch (_) {}
          window.setTimeout(tick, 60);
        }
      }

      function resolveService(ctx, name) {
        const direct = getSvc(ctx, name);
        if (direct) return direct;
        try { return ctx && ctx[name] ? ctx[name] : undefined; } catch (_) { return undefined; }
      }

      function jumpTo(card, ctx, openView, currentId, t) {
        const layout = layoutApi || resolveService(ctx, 'layout');
        const workspace = workspaceApi || resolveService(ctx, 'uiWorkspace');
        try { if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null); } catch (_) {}
        if (card.sessionId && card.sessionId !== currentId) {
          try { if (workspace && typeof workspace.openSession === 'function') workspace.openSession(card.sessionId); } catch (_) {}
        }
        locate(card, openView, t, card.sessionId || currentId);
      }

      /* ---------------------------------------------------------------- *
       * Highlight helper: split text into plain / matched spans.           *
       * ---------------------------------------------------------------- */
      function highlight(text, query) {
        const q = query.trim();
        if (!q) return text;
        const lower = text.toLowerCase();
        const qLower = q.toLowerCase();
        const parts = [];
        let from = 0;
        let at = lower.indexOf(qLower, from);
        let key = 0;
        while (at !== -1) {
          if (at > from) parts.push(text.slice(from, at));
          parts.push(h('span', {
            key: 'm' + (key++),
            className: 'dhs-mark',
          }, text.slice(at, at + q.length)));
          from = at + q.length;
          at = lower.indexOf(qLower, from);
        }
        if (from < text.length) parts.push(text.slice(from));
        return parts;
      }

      function formatTime(ts, locale) {
        if (typeof ts !== 'number' || !isFinite(ts)) return '';
        try { return new Date(ts).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }
        catch (_) { return ''; }
      }

      /* ---------------------------------------------------------------- *
       * Styles: rendered as a component-local <style>, removed on unmount. *
       * Design language (user preference): minimal, low saturation, round *
       * corners, frosted-glass controls (~10px blur), flat SVG icons,     *
       * NO borders, NO shadows, NO hover-scaling.                         *
       * ---------------------------------------------------------------- */
      const CSS = `
.dhs-root * { box-sizing: border-box; }
.dhs-root {
  font-family: inherit;
  display: flex; flex-direction: column; height: 100%;
  padding: 10px 12px 8px; gap: 8px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
}

/* Scrolling list owns the scrollport; the search bar sticks to its top.
   Keep the side padding minimal so the CARDS keep their full width (the search
   bar reserves its own side room via margins). The top padding equals the
   search bar's sticky "top" offset, so it starts already pinned with a visible
   gap and never slides around. */
.dhs-list {
  flex: 1; overflow-y: auto; display: flex; flex-direction: column;
  gap: 4px;
  padding: 14px 2px 10px;
}
.dhs-list::-webkit-scrollbar { width: 8px; }
.dhs-list::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-hover-l1); border-radius: 8px;
}

/* Frosted, floating search bar: ONE continuous glass strip that mirrors the
   conversation header's translucent surface — not separate pill-shaped chips.
   The cards scroll underneath and show through, blurred.
   sticky top == .dhs-list padding-top, so it sits with a gap AND stays pinned:
   no top margin to scroll away, no clipping of the upward glow. */
.dhs-searchbar {
  position: sticky; top: 14px; z-index: 20;
  display: flex; align-items: center; gap: 10px;
  margin: 0 18px 10px;
  padding: 7px 10px;
  border-radius: 18px;
  border: 1.5px solid var(--dsw-alias-border-l2);
  box-shadow: 0 6px 16px rgba(15,20,40,0.12), 0 2px 4px rgba(15,20,40,0.06);
  background: rgba(140,150,170,0.16);
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 78%, transparent);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
}
.dhs-searchbox {
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: 8px;
  height: 22px;
}
.dhs-searchicon { display: inline-flex; flex: none; color: var(--dsw-alias-label-tertiary); }
.dhs-input {
  flex: 1; min-width: 0; height: 100%; padding: 0;
  border: none; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary);
  font-family: inherit; font-size: 13.5px; letter-spacing: .1px;
}
.dhs-input::placeholder { color: var(--dsw-alias-label-tertiary); }

/* Count chip: plain text inside the same glass strip (no own surface). */
.dhs-counter {
  flex: none; min-width: 58px;
  display: flex; align-items: center; justify-content: center;
  font-size: 12.5px; font-weight: 600; letter-spacing: .2px;
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dhs-iconbtn {
  flex: none; width: 30px; height: 30px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 9px; background: transparent;
  color: var(--dsw-alias-label-tertiary); cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.dhs-iconbtn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

/* One-click filter chips: quiet by default, brand-blue when active. */
.dhs-filterbtn {
  flex: none; width: 30px; height: 30px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 9px; background: transparent;
  color: var(--dsw-alias-label-tertiary); cursor: pointer;
  transition: background .15s ease, color .15s ease;
}
.dhs-filterbtn:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dhs-filterbtn.is-on { color: #4d6bfe; background: rgba(77,107,254,0.14); }
.dhs-filterbtn.is-on:hover { background: rgba(77,107,254,0.22); }

/* Status / error line (only rendered while loading or on failure). */
.dhs-status {
  font-size: 12.5px; line-height: 1.55; padding: 2px 4px;
  color: var(--dsw-alias-label-tertiary);
}
.dhs-status.is-error { color: var(--dsw-alias-state-error-primary); }
.dhs-retry {
  margin-left: 8px; padding: 0; border: none; background: transparent;
  color: var(--dsw-alias-brand-primary); font: inherit; cursor: pointer;
}
.dhs-retry:hover { text-decoration: underline; }

/* Card: borderless, transparent; hover only tints the background. It is a div
   with role="button" so the copy / insert controls can live inside it — a
   <button> inside a <button> is invalid HTML. */
.dhs-card {
  position: relative; display: block; width: 100%; padding: 0;
  text-align: left; cursor: pointer; border: none; border-radius: 12px;
  background: transparent; color: var(--dsw-alias-label-primary);
  font-family: inherit;
  appearance: none; -webkit-appearance: none;
  transition: background .16s ease;
}
.dhs-card:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dhs-card:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px;
}

/* Left arrow slides in on hover; the body shifts right to make room. */
.dhs-arrow {
  position: absolute; left: 9px; top: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  transform: translateY(-50%) translateX(-7px);
  opacity: 0; color: var(--dsw-alias-brand-primary);
  transition: opacity .18s ease, transform .18s ease;
  pointer-events: none;
}
.dhs-card:hover .dhs-arrow { opacity: 1; transform: translateY(-50%) translateX(0); }
.dhs-cardbody { padding: 11px 13px; transition: padding-left .18s ease; }
.dhs-card:hover .dhs-cardbody { padding-left: 32px; }

.dhs-cardmeta { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.dhs-ordinal { font-size: 12px; font-weight: 600; color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; }
.dhs-time {
  font-size: 12px; color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
/* Small picture badge right after the time: signals image attachment(s).
   Same brand blue as the quote badge; the filter chip controls its own color
   via .dhs-filterbtn, so it stays neutral there. */
.dhs-imgbadge {
  display: inline-flex; align-items: center; justify-content: center;
  color: #4d6bfe;
}
.dhs-imgonly {
  font-size: 13px; color: var(--dsw-alias-label-tertiary); font-style: italic;
}
/* Blue quote bubble + source-message ordinal: message carries select-quote
   selection quotes. */
.dhs-quotebadge {
  display: inline-flex; align-items: center; gap: 3px;
  color: #4d6bfe;
  font-size: 12px; font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.dhs-cardtext {
  font-size: 14.5px; line-height: 1.65;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap; word-break: break-word;
  max-height: 96px; overflow: hidden;
}
/* Copy / insert controls sit at the right end of the meta row. visibility
   (not display/opacity) keeps the row height and the text width stable, so
   hovering a card never reflows it. */
.dhs-actions {
  margin-left: auto; display: inline-flex; align-items: center; gap: 2px;
  visibility: hidden;
}
.dhs-card:hover .dhs-actions,
.dhs-card:focus-within .dhs-actions { visibility: visible; }
.dhs-actbtn {
  width: 24px; height: 24px; padding: 0; border: none; border-radius: 7px;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; color: var(--dsw-alias-label-tertiary);
  cursor: pointer; transition: background .12s ease, color .12s ease;
}
.dhs-actbtn:hover {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.dhs-actbtn:disabled { cursor: default; opacity: .45; }
.dhs-actbtn:disabled:hover { background: transparent; color: var(--dsw-alias-label-tertiary); }
.dhs-mark {
  background: rgba(255,196,0,0.42);
  background: color-mix(in srgb, var(--dsw-static-amber-100) 58%, transparent);
  border-radius: 3px; padding: 0 1px;
}

.dhs-empty {
  padding: 34px 12px; text-align: center;
  font-size: 13.5px; line-height: 1.75;
  color: var(--dsw-alias-label-tertiary);
}

/* Jump landmark: a bold blue arrow fades out once at the far left of the
   landed row. Pure CSS via ::before, so the host row's DOM stays untouched and
   nothing is painted over the message itself. */
.dhs-landmark { position: relative; }
.dhs-landmark::before {
  content: '';
  position: absolute;
  left: 2px; top: 50%;
  width: 40px; height: 40px;
  margin-top: -20px;
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%234d6bfe' stroke-width='2.4' stroke-linecap='butt' stroke-linejoin='miter' stroke-miterlimit='10'%3E%3Cpath d='M4 12h15'/%3E%3Cpath d='M12 5l7 7-7 7'/%3E%3C/svg%3E") no-repeat center / contain;
  pointer-events: none;
  z-index: 5;
  /* One clean fade-out — no sliding, no looping. */
  animation: dhs-landmark-fade 2s ease-out forwards;
}
@keyframes dhs-landmark-fade {
  0%   { opacity: 0; }
  12%  { opacity: 1; }
  62%  { opacity: 1; }
  100% { opacity: 0; }
}
`;

      /* ---------------------------------------------------------------- *
       * Icons (plain SVG, currentColor).                                   *
       * ---------------------------------------------------------------- */
      function SearchIcon(props) {
        const s = (props && props.size) || 16;
        return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false' },
          h('circle', { cx: 11, cy: 11, r: 7 }),
          h('path', { d: 'M20 20l-3.6-3.6' }));
      }
      function RefreshIcon(props) {
        const s = (props && props.size) || 15;
        return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false' },
          h('path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }),
          h('path', { d: 'M21 3v5h-5' }),
          h('path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }),
          h('path', { d: 'M8 16H3v5' }));
      }
      // Chevron pointing left: slides in on card hover as the "jump" affordance.
      function ArrowIcon(props) {
        const s = (props && props.size) || 16;
        return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false' },
          h('path', { d: 'M15 5l-7 7 7 7' }));
      }
      // Flat picture icon (Lucide "image" style): frame + circle sun + mountains.
      function ImageBadgeIcon(props) {
        const s = (props && props.size) || 13;
        return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false' },
          h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 2, ry: 2 }),
          h('circle', { cx: 8.5, cy: 8.5, r: 1.5 }),
          h('path', { d: 'M21 15l-5-5L5 21' }));
      }
      // Flat quote icon (message bubble). `color` defaults to currentColor so
      // the filter button can control it; card badges pass brand blue.
      function QuoteBadgeIcon(props) {
        const s = (props && props.size) || 13;
        const stroke = (props && props.color) || 'currentColor';
        return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
          stroke: stroke, strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false' },
          h('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }));
      }
      function TabIcon(props) {
        const s = (props && props.size) || 18;
        return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false' },
          h('path', { d: 'M5 5h11M5 10h8M5 15h6' }),
          h('circle', { cx: 16.5, cy: 16.5, r: 3.5 }),
          h('path', { d: 'M19.2 19.2 22 22' }));
      }
      // Two offset sheets (Lucide "copy"): the copy-to-clipboard control.
      function CopyIcon(props) {
        const s = (props && props.size) || 14;
        return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false' },
          h('rect', { x: 9, y: 9, width: 12, height: 12, rx: 2, ry: 2 }),
          h('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }));
      }
      // Check mark: transient confirmation after a successful copy.
      function CheckIcon(props) {
        const s = (props && props.size) || 14;
        return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false' },
          h('path', { d: 'M20 6 9 17l-5-5' }));
      }
      // Arrow turning into a box (Lucide "corner-down-left"): insert into composer.
      function InsertIcon(props) {
        const s = (props && props.size) || 14;
        return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true', focusable: 'false' },
          h('path', { d: 'M9 10l-5 5 5 5' }),
          h('path', { d: 'M20 4v7a4 4 0 0 1-4 4H4' }));
      }

/* ---------------------------------------------------------------- *
       * Card.                                                             *
       * ---------------------------------------------------------------- */
      const Card = React.memo(function HistoryCard(props) {
        const card = props.card;
        const q = props.q;
        const t = props.t;
        const ctx = props.ctx;
        const openView = props.openView;
        const sessionId = props.sessionId;
        const timeLocale = props.timeLocale;
        const actions = props.actions;
        const onNotice = props.onNotice;

        const [copied, setCopied] = React.useState(false);
        const timer = React.useRef(0);
        React.useEffect(() => () => {
          if (timer.current) window.clearTimeout(timer.current);
        }, []);

        const text = card.text || '';
        const preview = text.length > PREVIEW_CHARS
          ? text.slice(0, PREVIEW_CHARS) + '…' : text;
        // Blue quote bubble + the ordinal(s) of the message(s) in THIS
        // conversation that the quoted text came from. The data layer already
        // resolved each quote (user-sourced via message id, assistant-sourced
        // through the turn that prompted it).
        const quoteOrdinals = (card.quotes || [])
          .map((x) => (x.ordinal ? '#' + x.ordinal : '?'));

        const jump = () => jumpTo(card, ctx, openView, sessionId, t);

        const handleCopy = (e) => {
          e.stopPropagation();
          Promise.resolve(copyText(text)).then((ok) => {
            if (!ok) { if (onNotice) onNotice(t('copyFailed')); return; }
            setCopied(true);
            if (timer.current) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), 1200);
          });
        };

        // Insert at the live caret: never destroys an existing draft and stays
        // undoable. insertText() refuses when the composer is busy or the draft
        // moved, so a refusal is surfaced instead of silently doing nothing.
        const handleInsert = (e) => {
          e.stopPropagation();
          let ok = false;
          try {
            if (actions) {
              const span = actions.captureInsertion();
              ok = actions.insertText(text, span);
            }
          } catch (_) { ok = false; }
          if (!ok && onNotice) {
            onNotice(actions ? t('insertBlocked') : t('insertUnavailable'));
          }
        };

        const handleKey = (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
            ev.preventDefault();
            jump();
          }
        };

        return h('div', {
          className: 'dhs-card',
          role: 'button',
          tabIndex: 0,
          onClick: jump,
          onKeyDown: handleKey,
        },
          // Left chevron, hidden until hover (see .dhs-arrow CSS).
          h('span', { className: 'dhs-arrow', 'aria-hidden': 'true' },
            h(ArrowIcon, { size: 16 })),
          h('div', { className: 'dhs-cardbody' },
            h('div', { className: 'dhs-cardmeta' },
              h('span', { className: 'dhs-ordinal' },
                card.ordinal ? t('ordinal', card.ordinal) : ''),
              h('span', { className: 'dhs-time' }, formatTime(card.time, timeLocale)),
              // Small flat picture icon right after the date when the message
              // carried image attachment(s).
              card.hasImage
                ? h('span', { className: 'dhs-imgbadge', title: t('hasImage') },
                  h(ImageBadgeIcon, { size: 13 }))
                : null,
              (card.quotes || []).length > 0
                ? h('span', {
                  className: 'dhs-quotebadge',
                  title: t('quoteFrom', quoteOrdinals.join(', ')),
                }, h(QuoteBadgeIcon, { size: 13, color: '#4d6bfe' }),
                quoteOrdinals.join('/'))
                : null,
              // Copy / insert ride at the right end of the meta row and only
              // appear on hover or keyboard focus (visibility keeps layout).
              h('span', { className: 'dhs-actions' },
                h('button', {
                  className: 'dhs-actbtn', type: 'button',
                  title: copied ? t('copied') : t('copy'),
                  'aria-label': t('copy'),
                  onClick: handleCopy,
                }, copied ? h(CheckIcon, { size: 14 }) : h(CopyIcon, { size: 14 })),
                h('button', {
                  className: 'dhs-actbtn', type: 'button',
                  title: actions ? t('insert') : t('insertUnavailable'),
                  'aria-label': t('insert'),
                  disabled: !actions,
                  onClick: handleInsert,
                }, h(InsertIcon, { size: 14 })))),
            h('div', { className: 'dhs-cardtext' },
              preview ? highlight(preview, q)
                : h('span', { className: 'dhs-imgonly' },
                  (card.quotes || []).length > 0 ? t('quoteOnly') : t('imageOnly')))));
      });

      /* ---------------------------------------------------------------- *
       * Composer bridge.                                                   *
       *                                                                    *
       * `inputActions` is a Session-scoped standard prop (ui-conversation   *
       * publishes it through uiSession), so a right-sidebar tab can only    *
       * reach it from inside a session slot. This invisible dock entry      *
       * parks the action face per session and renders nothing.              *
       * ---------------------------------------------------------------- */
      const inputActionsBySession = new Map();
      const inputActionsListeners = new Set();

      function publishInputActions(sessionId, actions) {
        if (!sessionId) return;
        if (actions) inputActionsBySession.set(sessionId, actions);
        else if (!inputActionsBySession.delete(sessionId)) return;
        for (const notify of inputActionsListeners) {
          try { notify(); } catch (_) {}
        }
      }

      function InputActionsBridge(props) {
        const sid = props && (props.dhsSessionId || props.sessionId);
        const actions = props && props.inputActions;
        React.useEffect(() => {
          if (!sid || !actions) return undefined;
          publishInputActions(sid, actions);
          return () => publishInputActions(sid, null);
        }, [sid, actions]);
        return null;
      }

      function useInputActions(sessionId) {
        const read = () => (sessionId ? inputActionsBySession.get(sessionId) : undefined);
        const [actions, setActions] = React.useState(read);
        React.useEffect(() => {
          const sync = () => setActions(read());
          sync();
          inputActionsListeners.add(sync);
          return () => { inputActionsListeners.delete(sync); };
        }, [sessionId]);
        return actions;
      }

      function legacyCopy(text) {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '-1000px';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          return !!ok;
        } catch (_) { return false; }
      }

      function copyText(text) {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard &&
              typeof navigator.clipboard.writeText === 'function') {
            return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
          }
        } catch (_) { /* fall through to the DOM path */ }
        return Promise.resolve(legacyCopy(text));
      }

      /* ---------------------------------------------------------------- *
       * The panel.                                                         *
       * ---------------------------------------------------------------- */
      function HistoryPanel(props) {
        const p = props || {};
        const t = p.t || ((k) => k);
        const ctx = p.ctx;
        const openView = p.openView;
        const sessionId = p.sessionId;

        const [query, setQuery] = React.useState('');
        const [items, setItems] = React.useState(null); // null = nothing yet
        const [error, setError] = React.useState('');
        const [loading, setLoading] = React.useState(true);
        const [reloadKey, setReloadKey] = React.useState(0);
        const [filterImg, setFilterImg] = React.useState(false);
        const [filterQuote, setFilterQuote] = React.useState(false);
        const [notice, setNotice] = React.useState('');

        const actions = useInputActions(sessionId);

        React.useEffect(() => {
          if (!notice) return undefined;
          const id = window.setTimeout(() => setNotice(''), 2500);
          return () => window.clearTimeout(id);
        }, [notice]);

        // ---- load / revalidate -------------------------------------------
        // A cached session paints immediately and only pays for a tail sync;
        // an uncached one runs the full backward sweep once.
        React.useEffect(() => {
          if (!sessionId) {
            setItems([]);
            setLoading(false);
            setError(t('noSession'));
            return undefined;
          }
          let alive = true;
          const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
          const signal = ac ? ac.signal : undefined;
          const cache = ensureCache(sessionId);
          // Paint whatever this session already has; a switch must never show
          // the previous session's cards while the new load is in flight.
          setItems(cache.ready ? cache.cards.slice() : null);
          setLoading(!cache.ready);
          setError('');

          const rebuild = async (api) => {
            const { events, complete } = await loadHistory(api, sessionId, signal);
            if (!alive) return;
            applyEvents(cache, events, true);
            cache.historyComplete = complete;
            cache.ready = true;
            setItems(cache.cards.slice());
          };

          const waitForApi = async () => {
            for (let i = 0; i < 30; i++) {
              if (!alive) return null;
              if (sessionApi) return sessionApi;
              await new Promise((resolve) => window.setTimeout(resolve, 200));
            }
            return null;
          };

          (async () => {
            const api = await waitForApi();
            if (!alive) return;
            if (!api) { setLoading(false); setError(t('noService')); return; }
            try {
              let merged = false;
              if (cache.ready) merged = await syncTail(api, sessionId, cache, signal);
              if (!merged && alive) await rebuild(api);
              if (!alive) return;
              setItems(cache.cards.slice());
              setLoading(false);
            } catch (err) {
              if (!alive) return;
              if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) return;
              setLoading(false);
              setError(t('failed', (err && err.message) ? err.message : String(err)));
            }
          })();

          return () => {
            alive = false;
            try { if (ac) ac.abort(); } catch (_) {}
          };
        }, [sessionId, reloadKey]);

        // ---- live updates -------------------------------------------------
        // The chat view's own Session publishes its loaded window; merging by
        // seq turns every append into a card without re-fetching anything.
        React.useEffect(() => {
          if (!sessionId) return undefined;
          let alive = true;
          let unsubscribe = null;
          let owner = null;
          let timer = 0;

          const resync = async () => {
            if (!alive || !sessionApi) return;
            const cache = CACHE.get(sessionId);
            if (!cache || !cache.ready) return;
            try {
              const ok = await syncTail(sessionApi, sessionId, cache, undefined);
              if (ok && alive) setItems(cache.cards.slice());
            } catch (_) { /* the next notification retries */ }
          };

          const merge = (events) => {
            if (!alive) return;
            const cache = CACHE.get(sessionId);
            if (!cache || !cache.ready) return;
            const before = cache.lastSeq;
            if (applyEvents(cache, events, false)) setItems(cache.cards.slice());
            // A jump in seq numbers means events we never saw (the window was
            // replaced after a reconnect): one tail sync closes the hole.
            let first;
            for (const e of events) {
              if (typeof e.seq !== 'number') continue;
              if (first === undefined || e.seq < first) first = e.seq;
            }
            if (first !== undefined && first > before + 1 && !timer) {
              timer = window.setTimeout(() => { timer = 0; void resync(); }, 300);
            }
          };

          const onChange = () => {
            if (!alive) return;
            const live = liveBinding(sessionId);
            if (!live) return;
            if (owner && live.binding !== owner) {
              // The controller replaced the generation: resubscribe once.
              try { if (unsubscribe) unsubscribe(); } catch (_) {}
              owner = live.binding;
              try { unsubscribe = live.source.subscribe(onChange); } catch (_) { unsubscribe = null; }
            }
            merge(eventsFromSnapshot(live.source.getSnapshot()));
          };

          const attach = () => {
            const live = liveBinding(sessionId);
            if (!live) return false;
            owner = live.binding;
            try { unsubscribe = live.source.subscribe(onChange); } catch (_) { return false; }
            return true;
          };

          if (!attach()) {
            const id = window.setTimeout(() => { if (alive) attach(); }, 800);
            return () => { alive = false; window.clearTimeout(id); };
          }
          return () => {
            alive = false;
            if (timer) window.clearTimeout(timer);
            try { if (unsubscribe) unsubscribe(); } catch (_) {}
          };
        }, [sessionId]);

        // ---- derived list -------------------------------------------------
        const deferredQuery = React.useDeferredValue(query);
        const shown = React.useMemo(() => {
          const needle = (deferredQuery || '').trim();
          const lower = needle.toLowerCase();
          const out = (items || []).filter((c) => {
            if (needle && c.text.toLowerCase().indexOf(lower) === -1) return false;
            if (filterImg && !c.hasImage) return false;
            if (filterQuote && !(c.quotes && c.quotes.length > 0)) return false;
            return true;
          });
          // Newest first; seq is a monotonic log offset.
          out.sort((a, b) => (b.seq || 0) - (a.seq || 0));
          return out;
        }, [items, deferredQuery, filterImg, filterQuote]);

        const q = (deferredQuery || '').trim();
        const list = items || [];
        const hasFilter = !!q || filterImg || filterQuote;
        const timeLocale = (t('time') === 'en-US') ? 'en-US' : 'zh-CN';

        // Counter: "…" while loading, "!" on failure, total when idle, and
        // "matched/total" while any filter is active. The locale-specific unit
        // suffix ("条" in Chinese) rides along.
        const unit = t('unit') || '';
        const withUnit = (s) => (unit ? s + ' ' + unit : s);
        const counterText = loading && items === null ? '…'
          : error ? '!'
            : hasFilter ? withUnit(shown.length + '/' + list.length)
              : withUnit(String(list.length));
        const counterTitle = hasFilter ? t('match', shown.length) : t('count', list.length);
        const showEmpty = !loading && !error && shown.length === 0;

        return h('div', {
          className: 'dhs-root',
          'data-dsh-plugin': TAB_ID,
        },
          h('style', { key: 'dhs-css' }, CSS),

          // Scrolling column: the frosted bar sticks near its top, cards slide
          // underneath it and show through blurred.
          h('div', { className: 'dhs-list' },
            h('div', { className: 'dhs-searchbar' },
              h('div', { className: 'dhs-searchbox' },
                h('span', { className: 'dhs-searchicon' }, h(SearchIcon, { size: 17 })),
                h('input', {
                  className: 'dhs-input', type: 'text', value: query,
                  placeholder: t('search'),
                  'aria-label': t('search'),
                  onChange: (e) => setQuery(e.target.value),
                })),
              h('div', { className: 'dhs-counter', title: counterTitle }, counterText),
              // One-click filters: "has image" / "has quote". Stack with the
              // keyword search; active state is a blue tint (no border/shadow).
              h('button', {
                className: 'dhs-filterbtn' + (filterImg ? ' is-on' : ''),
                type: 'button', title: t('filterImage'),
                'aria-pressed': filterImg ? 'true' : 'false',
                onClick: () => setFilterImg((v) => !v),
              }, h(ImageBadgeIcon, { size: 15 })),
              h('button', {
                className: 'dhs-filterbtn' + (filterQuote ? ' is-on' : ''),
                type: 'button', title: t('filterQuote'),
                'aria-pressed': filterQuote ? 'true' : 'false',
                onClick: () => setFilterQuote((v) => !v),
              }, h(QuoteBadgeIcon, { size: 15 })),
              h('button', {
                className: 'dhs-iconbtn', type: 'button', title: t('refresh'),
                onClick: () => {
                  // Manual refresh means "start over": drop the cache entry and
                  // let the load effect rebuild it from scratch.
                  if (sessionId) CACHE.delete(sessionId);
                  setReloadKey((k) => k + 1);
                },
              }, h(RefreshIcon))),

            // Failure detail (the chip only shows "!"), with a retry affordance.
            error
              ? h('div', { className: 'dhs-status is-error' },
                error,
                h('button', {
                  className: 'dhs-retry', type: 'button',
                  onClick: () => setReloadKey((k) => k + 1),
                }, t('retry')))
              : null,
            notice ? h('div', { className: 'dhs-status', role: 'status' }, notice) : null,
            showEmpty
              ? h('div', { className: 'dhs-empty' },
                hasFilter ? t('emptyMatch') : t('emptyAll'))
              : null,
            shown.map((card) => h(Card, {
              key: String(card.seq) + ':' + (card.id || ''),
              card, q, t, ctx, openView, sessionId, timeLocale, actions,
              onNotice: setNotice,
            }))));
      }

      /* ---------------------------------------------------------------- *
       * Session resolution wrapper.                                        *
       *                                                                    *
       * The `useSessions` prop is optional, so the hook lives in a child    *
       * component instead of being called conditionally in the panel.       *
       * ---------------------------------------------------------------- */
      function HistoryPanelWithSession(props) {
        const p = props || {};
        const activeId = p.useSessions(currentSessionId);
        return h(HistoryPanel, Object.assign({}, p, {
          sessionId: p.sessionId || activeId,
        }));
      }

      function HistoryTabEntry(props) {
        const p = props || {};
        if (typeof p.useSessions !== 'function') return h(HistoryPanel, p);
        return h(HistoryPanelWithSession, p);
      }

      /* ---------------------------------------------------------------- *
       * Tab title chip.                                                    *
       * ---------------------------------------------------------------- */
      function TabTitle(props) {
        const t = (props && props.t) || ((k) => k);
        return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          h(TabIcon, { size: 15 }), h('span', null, t('tab')));
      }

      /* ---------------------------------------------------------------- *
       * Registration.                                                      *
       * ---------------------------------------------------------------- */
      function apply(ctx) {
        const t = makeT(ctx);

        // Resolve services as their composing contexts mount.
        try {
          ctx.inject(['remote'], (scoped) => {
            const api = (scoped.get && scoped.get('remote.session')) ||
                        (scoped.remote && scoped.remote.session);
            if (api) sessionApi = api;
            scoped.effect(() => () => { if (sessionApi === api) sessionApi = null; },
              'dsh-history-search: remote.session');
          });
        } catch (_) { /* optional */ }
        try {
          ctx.inject(['sessions'], (scoped) => {
            const svc = (scoped.get && scoped.get('sessions')) || scoped.sessions;
            if (svc) sessionsSvc = svc;
            scoped.effect(() => () => { if (sessionsSvc === svc) sessionsSvc = null; },
              'dsh-history-search: sessions');
          });
        } catch (_) { /* optional */ }
        try {
          ctx.inject(['layout'], (scoped) => {
            layoutApi = (scoped.get && scoped.get('layout')) || scoped.layout || null;
            scoped.effect(() => () => { layoutApi = null; }, 'dsh-history-search: layout');
          });
        } catch (_) { /* optional */ }
        try {
          ctx.inject(['uiWorkspace'], (scoped) => {
            workspaceApi = (scoped.get && scoped.get('uiWorkspace')) || scoped.uiWorkspace || null;
            scoped.effect(() => () => { workspaceApi = null; }, 'dsh-history-search: uiWorkspace');
          });
        } catch (_) { /* optional */ }

        // Right-sidebar tab (same row as Chat / Trajectory / Browser).
        // Structure mirrors the proven dsh-memoir `watchSidebar`: an inject on
        // sidebarRightTabs whose scoped ctx runs one effect that owns every
        // registration and returns their cleanup. The child scope is disposed
        // automatically when this plugin unloads.
        try {
          ctx.inject(['sidebarRightTabs'], (sidebarCtx) => {
            sidebarCtx.effect(() => {
              const owned = [];
              const cleanup = () => {
                for (const dispose of owned.splice(0).reverse()) {
                  try { if (typeof dispose === 'function') dispose(); } catch (_) {}
                }
              };
              try {
                const tabs = sidebarCtx.sidebarRightTabs ||
                  (typeof sidebarCtx.get === 'function' && sidebarCtx.get('sidebarRightTabs'));
                if (tabs && typeof tabs.register === 'function') {
                  owned.push(tabs.register({
                    id: TAB_ID,
                    kind: TAB_KIND,
                    keepMounted: true,
                    title: () => t('tab'),
                    guide: [{
                      id: TAB_KIND,
                      order: 40,
                      title: () => t('title'),
                      description: () => t('hint'),
                      icon: TabIcon,
                    }],
                  }));
                }
                owned.push(sidebarCtx.slots.inject('sidebar.right.pane.tab', () =>
                  sidebarCtx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID },
                    (slotProps) => h(HistoryTabEntry, Object.assign({}, slotProps, {
                      t, ctx: sidebarCtx,
                    })))));
                owned.push(sidebarCtx.slots.inject('sidebar.right.pane.tab.title', () =>
                  sidebarCtx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID },
                    () => h(TabTitle, { t }))));
              } catch (err) {
                cleanup();
                try { console.error('[dsh-history-search] sidebar registration failed', err); } catch (_) {}
              }
              return cleanup;
            }, 'dsh-history-search: right sidebar tab');
          });
        } catch (_) { /* optional */ }

        // Composer bridge: an invisible dock row inside the conversation gives
        // this bundle the Session-scoped `inputActions` face (insert/capture),
        // which a sidebar tab cannot reach on its own. It renders null; when
        // the slot or the prop is absent on this host build, the card's insert
        // button degrades to a disabled control instead of throwing.
        try {
          ctx.inject(['slots'], (dockCtx) => {
            dockCtx.effect(() => {
              let dispose = null;
              try {
                dispose = dockCtx.slots.inject('conversation.input.dock', () =>
                  dockCtx.slots.register({
                    name: 'conversation.input.dock',
                    id: 'dsh-history-search-actions',
                    order: 900,
                    inject: (sessionId) => ({ dhsSessionId: sessionId }),
                  }, InputActionsBridge));
              } catch (err) {
                try { console.warn('[dsh-history-search] composer bridge unavailable', err); } catch (_) {}
              }
              return () => { try { if (dispose) dispose(); } catch (_) {} };
            }, 'dsh-history-search: composer bridge');
          });
        } catch (_) { /* optional */ }
      }

      exports.inject = ['slots', 'sidebarRightTabs', 'sessions'];
      exports.apply = apply;
      return module.exports;
    },
  });
})();
