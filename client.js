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
      quoteCount: (n) => `引用 ${n} 处`,
      quoteFrom: (n) => `引用自消息 ${n}`,
      quoteOnly: '（引用消息）',
      filterImage: '只看含图片的消息',
      filterQuote: '只看含引用的消息',
      locating: '正在定位消息…',
      locatingPrecise: '正在精确加载到这条消息…',
      fallingBack: '精确加载不可用，正在手动翻页…',
      loadingEarlier: (n) => `正在加载更早的对话…（已尝试 ${n} 次）`,
      loadingWait: (n) => `正在载入更早的对话…（已尝试 ${n} 次）`,
      reachedTop: '未能跳转：已翻到会话最开头，仍未找到这条消息，已定位到当前最早一条',
      loadFailedStuck: '未能跳转：已反复尝试加载更早对话，但这条消息仍未出现（可能已超出当前会话可加载范围），已定位到当前已加载的最早一条',
      loadFailedTimeout: '未能跳转：等待加载更早对话超时，已定位到当前已加载的最早一条',
      emptyAll: '这个会话里还没有你发的消息',
      emptyMatch: '没有匹配的消息',
      loading: '加载中…',
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
      quoteCount: (n) => `${n} quote${n === 1 ? '' : 's'}`,
      quoteFrom: (n) => `Quoted from message ${n}`,      quoteOnly: '(quote message)',
      filterImage: 'Only messages with images',
      filterQuote: 'Only messages with quotes',
      loadingEarlier: (n) => `Loading earlier messages… (attempt ${n})`,
      loadingWait: (n) => `Loading earlier messages… (attempt ${n})`,
      locating: 'Locating message…',
      locatingPrecise: 'Precisely loading this message…',
      fallingBack: 'Precise loading unavailable; paging manually…',
      reachedTop: 'Jump failed: reached the very beginning of the conversation without finding this message; jumped to the earliest loaded row instead.',
      loadFailedStuck: 'Jump failed: tried loading earlier messages repeatedly but this one did not appear; jumped to the earliest currently loaded message instead.',
      loadFailedTimeout: 'Jump failed: timed out waiting for earlier messages; jumped to the earliest currently loaded message instead.',
      emptyAll: 'No messages you sent in this conversation yet',
      emptyMatch: 'No matching messages',
      loading: 'Loading…',
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

      async function loadUserMessages(api, sessionId, signal) {
        if (!api || !sessionId) return [];
        const all = [];
        // Turn ordinal map: "which user message started engine turn N". The
        // engine turn number comes from turn/start / step/start events, NOT
        // from user/message (its data has no turn field). We track the open
        // turn while walking the stream; the first user message inside a turn
        // is recorded as that turn's starter. A quote sourced from an
        // assistant step ("14:assistant-step<turn>:<step>") resolves through
        // this map to the user message that began the turn.
        const turnToOrdinal = {};
        let openTurn = null;
        let ordinalCounter = 0;
        // Records may arrive newest-first per page (backward cursor); collect
        // all events first, then walk them in true chronological order.
        const rawEvents = [];
        let beforeSeq;
        for (let page = 0; page < MAX_PAGES; page++) {
          const request = {
            address: { kind: 'session', sessionId },
            maxMessages: PAGE_BUDGET,
          };
          if (beforeSeq !== undefined) request.beforeSeq = beforeSeq;

          let outcome;
          try {
            outcome = await api.events(request, signal);
          } catch (err) {
            // Some client generations omit the cancellation parameter.
            try { outcome = await api.events(request); }
            catch (err2) { throw err2; }
          }
          // RemoteResult envelope { ok, value } or a bare SessionEventsPage.
          let result = outcome;
          if (outcome && typeof outcome === 'object' && 'ok' in outcome) {
            if (!outcome.ok) throw new Error((outcome.error && outcome.error.message) || 'remote error');
            result = outcome.value;
          }
          if (!result || !Array.isArray(result.records)) break;

          let minSeq;
          for (const record of result.records) {
            const e = record && record.event;
            if (!e) continue;
            if (typeof e.seq === 'number' && isFinite(e.seq)) {
              if (minSeq === undefined || e.seq < minSeq) minSeq = e.seq;
            }
            rawEvents.push(e);
          }
          if (!result.hasMore || minSeq === undefined) break;
          // beforeSeq is a backward cursor: ask for the page strictly older
          // than the oldest event we just saw. Using the minimum keeps this
          // correct whether `records` is chronological or reverse-chronological.
          if (beforeSeq !== undefined && minSeq >= beforeSeq) break; // no progress
          beforeSeq = minSeq;
        }

        // Walk chronologically: track open turns and count user-message ordinals.
        rawEvents.sort((a, b) => (a.seq || 0) - (b.seq || 0));
        for (const e of rawEvents) {
          const data = e.data || {};
          if (e.type === 'turn/start' && typeof data.turn === 'number') {
            openTurn = data.turn;
          } else if (e.type === 'step/start' && typeof data.turn === 'number') {
            if (openTurn === null) openTurn = data.turn;
          } else if (e.type === 'turn/end') {
            openTurn = null;
          }
          const msg = userText(e);
          if (msg) {
            ordinalCounter += 1;
            if (openTurn !== null && !(openTurn in turnToOrdinal)) {
              turnToOrdinal[openTurn] = ordinalCounter;
            }
            all.push({
              seq: e.seq,
              time: e.time,
              text: msg.text || '',
              hasImage: msg.hasImage,
              quotes: msg.quotes || [],
              id: dataId(e),
              sessionId,
              ordinal: ordinalCounter,
            });
          }
        }

        // Resolve quote ordinals.
        // 1) user-sourced: the flow key tail is the source message's data.id;
        //    match it against the card list.
        // 2) assistant/tool-sourced: parse the turn number out of the flow key
        //    ("14:assistant-step<turn>:<step>") and map it through
        //    turnToOrdinal to the user message that started that turn.
        for (const card of all) {
          for (const q of card.quotes || []) {
            let resolved = null;
            if (q.kind === 'user') {
              const target = all.find((c) => c.id !== undefined && c.id !== null &&
                q.messageId.endsWith(String(c.id)));
              if (target) resolved = target.ordinal;
            } else {
              // Assistant flow keys embed the turn: "14:assistant-step19:18".
              const m = /assistant-step(\d+):/.exec(q.messageId) ||
                        /turn-process(\d+):/.exec(q.messageId);
              if (m) {
                const turn = Number(m[1]);
                if (turn in turnToOrdinal) resolved = turnToOrdinal[turn];
              }
            }
            q.ordinal = resolved;
          }
        }
        return all;
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
        //    `${kind.length}:input-message<event.data.id>` (ui-conversation's
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

      function locate(card, openView, t, report, sessionId) {
        const myToken = ++jumpToken;
        const started = Date.now();
        let lastEnsure = 0;
        let lastLoad = 0;
        let loadAttempts = 0;
        let buttonGoneSince = 0; // timestamp when "load earlier" first vanished
        let preciseDone = false; // loadThrough() settled (or was unavailable)
        let preciseSettledAt = 0; // when loadThrough() settled (render grace start)

        try { if (report) report(t('locating')); } catch (_) {}
        try { console.log('[dsh-history-search] locate start', JSON.stringify({ seq: card.seq, ordinal: card.ordinal, id: card.id, sessionId })); } catch (_) {}

        const giveUp = (key) => {
          const ordered = userRowsInOrder();
          const earliest = ordered.length ? ordered[0] : earliestLoadedRow();
          if (earliest) flashRow(earliest);
          else scrollFlowTop();
          try { if (report) report(t(key)); } catch (_) {}
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
            try { if (report) report(''); } catch (_) {} // clear the notice
            return;
          }

          // SERIALISATION GATE: while the precise loadThrough() is still
          // paging, do NOT click "load earlier". Clicking it runs the host's
          // loadEarlier() -> viewport.beginPaging(), which anchors the viewport
          // and later undoes our scrollIntoView. That parallel path was exactly
          // what left the view stuck at the first loaded page. Wait for the
          // precise loader to settle; only then fall back to the button.
          if (!preciseDone) {
            if (Date.now() - started >= LOCATE_TIMEOUT_MS) { giveUp('loadFailedTimeout'); return; }
            window.setTimeout(tick, LOCATE_INTERVAL_MS);
            return;
          }

          // Render grace: after loadThrough() settled, the freshly inserted
          // rows still need a moment to mount before findRow can see them.
          // Don't reach for the button during this window either (same
          // beginPaging hazard) — just keep polling.
          if (preciseSettledAt && (Date.now() - preciseSettledAt) < 600) {
            if (Date.now() - started >= LOCATE_TIMEOUT_MS) { giveUp('loadFailedTimeout'); return; }
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
            try {
              if (report) report(state === 'loading' || state === 'clicked'
                ? t('loadingWait', loadAttempts || 1)
                : t('loadingEarlier', loadAttempts || 1));
            } catch (_) {}
            const topNow = buttonGoneSince > 0 &&
              (Date.now() - buttonGoneSince) >= TOP_SETTLE_MS;
            row = findRow(card, topNow);
            if (row) {
              flashRow(row);
              try { if (report) report(''); } catch (_) {}
              return;
            }
            if (topNow) { giveUp('reachedTop'); return; }
          }

          if (loadAttempts >= MAX_LOAD_ATTEMPTS) { giveUp('loadFailedStuck'); return; }
          if (Date.now() - started >= LOCATE_TIMEOUT_MS) { giveUp('loadFailedTimeout'); return; }
          window.setTimeout(tick, LOCATE_INTERVAL_MS);
        };

        // Phase 1: precise loadThrough, awaited with a timeout, then let React
        // render the newly inserted rows. Phase 2: the tick loop (find row, then
        // button fallback) only begins once the precise path has settled.
        const precise = loadThroughTarget(card, sessionId);
        if (precise) {
          try { if (report) report(t('locatingPrecise')); } catch (_) {}
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
          try { if (report) report(t('fallingBack')); } catch (_) {}
          try { console.warn('[dsh-history-search] loadThrough unavailable, falling back to button paging'); } catch (_) {}
          window.setTimeout(tick, 60);
        }
      }

      function resolveService(ctx, name) {
        const direct = getSvc(ctx, name);
        if (direct) return direct;
        try { return ctx && ctx[name] ? ctx[name] : undefined; } catch (_) { return undefined; }
      }

      function jumpTo(card, ctx, openView, currentId, t, report) {
        const layout = layoutApi || resolveService(ctx, 'layout');
        const workspace = workspaceApi || resolveService(ctx, 'uiWorkspace');
        try { if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(null); } catch (_) {}
        if (card.sessionId && card.sessionId !== currentId) {
          try { if (workspace && typeof workspace.openSession === 'function') workspace.openSession(card.sessionId); } catch (_) {}
        }
        locate(card, openView, t, report, card.sessionId || currentId);
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

/* Card: borderless, transparent; hover only tints the background. */
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

      function renderCardList(allItems, items, shown, q, hasFilter, t, ctx, openView, sessionId, timeLocale) {
        if (items !== null && shown.length === 0) {
          return h('div', { className: 'dhs-empty' },
            hasFilter ? t('emptyMatch') : t('emptyAll'));
        }
        return (items || []).length === 0 && items !== null
          ? null
          : shown.map((card) => renderCard(card, q, t, ctx, openView, sessionId, timeLocale, allItems));
      }

      // Resolve a quote's source message id to "the Nth message you sent" in
      // THIS conversation. quote.source.messageId is a chat flow key of the
      // form `${len}:input-message<event.data.id>` — its tail is the id our
      // cards already carry. Returns the ordinal number, or null when the
      // quoted text came from a model reply / another session / an unloaded
      // message.
      function ordinalOfMsgId(cards, flowKey) {
        if (!flowKey) return null;
        for (const card of cards || []) {
          if (card.id !== undefined && card.id !== null &&
              flowKey.endsWith(String(card.id))) {
            return card.ordinal || null;
          }
        }
        return null;
      }

      function renderCard(card, q, t, ctx, openView, sessionId, timeLocale, allItems) {
        const text = card.text || '';
        const preview = text.length > PREVIEW_CHARS
          ? text.slice(0, PREVIEW_CHARS) + '…' : text;
        return h('button', {
          key: String(card.seq) + ':' + (card.id || ''),
          className: 'dhs-card', type: 'button',
          // No jump-progress notices any more: `report` is intentionally null.
          onClick: () => jumpTo(card, ctx, openView, sessionId, t, null),
        },
          // Left chevron, hidden until hover (see .dhs-arrow CSS).
          h('span', { className: 'dhs-arrow' }, h(ArrowIcon, { size: 16 })),
          h('div', { className: 'dhs-cardbody' },
            h('div', { className: 'dhs-cardmeta' },
              h('span', { className: 'dhs-ordinal' },
                card.ordinal ? t('ordinal', card.ordinal) : ''),
              h('span', { className: 'dhs-time' }, formatTime(card.time, timeLocale)),
              // Small flat picture icon right after the date when the message
              // carried image attachment(s).
              card.hasImage
                ? h('span', {
                    className: 'dhs-imgbadge',
                    title: t('hasImage'),
                  }, h(ImageBadgeIcon, { size: 13 }))
                : null,
              // Blue quote bubble + the ordinal(s) of the message(s) in THIS
              // conversation that the quoted text came from. loadUserMessages
              // already resolved each quote to an ordinal (user-sourced via the
              // card list, assistant/tool-sourced via the prompting turn).
              (card.quotes || []).length > 0
                ? h('span', {
                    className: 'dhs-quotebadge',
                    title: t('quoteFrom', (card.quotes || [])
                      .map((q) => (q.ordinal ? '#' + q.ordinal : '?'))
                      .join(', ')),
                  }, h(QuoteBadgeIcon, { size: 13, color: '#4d6bfe' }),
                  (card.quotes || [])
                    .map((q) => (q.ordinal ? '#' + q.ordinal : '?'))
                    .join('/'))
                : null),
            h('div', { className: 'dhs-cardtext' },
              preview ? highlight(preview, q)
                : h('span', { className: 'dhs-imgonly' },
                  (card.quotes || []).length > 0 ? t('quoteOnly') : t('imageOnly')))));
      }

      /* ---------------------------------------------------------------- *
       * The panel.                                                         *
       * ---------------------------------------------------------------- */
      function HistoryPanel(props) {
        const p = props || {};
        const t = p.t || ((k) => k);
        const ctx = p.ctx;
        const useSessions = p.useSessions;
        const propSessionId = p.sessionId;
        const openView = p.openView;

        const activeId = typeof useSessions === 'function'
          ? useSessions(currentSessionId) : undefined;
        const sessionId = propSessionId || activeId;

        const [query, setQuery] = React.useState('');
        const [items, setItems] = React.useState(null); // null = loading
        const [error, setError] = React.useState('');
        const [reloadKey, setReloadKey] = React.useState(0);
        const [filterImg, setFilterImg] = React.useState(false);
        const [filterQuote, setFilterQuote] = React.useState(false);

        React.useEffect(() => {
          let alive = true;
          let timer = null;
          const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
          let tries = 0;

          const finishEmpty = (msg) => {
            if (!alive) return;
            setItems([]);
            setError(msg || '');
          };

          const run = async () => {
            if (!sessionId) { finishEmpty(t('noSession')); return; }
            if (!sessionApi) {
              if (tries++ < 30) { timer = window.setTimeout(run, 200); return; }
              finishEmpty(t('noService')); return;
            }
            if (alive) { setItems(null); setError(''); }
            try {
              const list = await loadUserMessages(sessionApi, sessionId, ac ? ac.signal : undefined);
              if (!alive) return;
              // Ordinal = "the Nth message you sent", counted oldest -> newest.
              // seq is monotonic, so ascending seq is exactly chronological order.
              const chrono = list.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
              chrono.forEach((card, i) => { card.ordinal = i + 1; });
              setItems(list);
            } catch (err) {
              if (!alive) return;
              const msg = (err && err.message) ? err.message : String(err);
              finishEmpty(t('failed', msg));
            }
          };
          run();
          return () => {
            alive = false;
            if (timer) window.clearTimeout(timer);
            try { if (ac) ac.abort(); } catch (_) {}
          };
        }, [sessionId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

        const q = query.trim();
        const qLower = q.toLowerCase();
        const list = items || [];
        // Keyword + the two toggle filters stack (AND).
        const shown = list.filter((c) => {
          if (q && c.text.toLowerCase().indexOf(qLower) === -1) return false;
          if (filterImg && !c.hasImage) return false;
          if (filterQuote && !(c.quotes && c.quotes.length > 0)) return false;
          return true;
        });
        // Newest first; seq is a monotonic log offset.
        shown.sort((a, b) => (b.seq || 0) - (a.seq || 0));
        const hasFilter = !!q || filterImg || filterQuote;

        const timeLocale = (t('time') === 'en-US') ? 'en-US' : 'zh-CN';

        // Count chip: "…" while loading, "!" on failure, total when idle, and
        // "matched/total" while any filter is active. A locale-specific unit
        // suffix ("条" in Chinese) rides along.
        const unit = t('unit') || '';
        const withUnit = (s) => (unit ? s + ' ' + unit : s);
        const counterText = items === null ? '…'
          : error ? '!'
            : hasFilter ? withUnit(shown.length + '/' + list.length)
              : withUnit(String(list.length));
        const counterTitle = hasFilter ? t('match', shown.length) : t('count', list.length);

        return h('div', {
          className: 'dhs-root',
          'data-dsh-plugin': TAB_ID,
        },
          h('style', { key: 'dhs-css' }, CSS),

          // Scrolling column: the frosted bar sticks near its top, cards slide
          // underneath it and show through blurred.
          h('div', { className: 'dhs-list' },

            // Frosted search bar (inside the scrollport so the frosted effect
            // has content to blur; sticky top == list padding-top).
            h('div', { className: 'dhs-searchbar' },
              h('div', { className: 'dhs-searchbox' },
                h('span', { className: 'dhs-searchicon' }, h(SearchIcon, { size: 17 })),
                h('input', {
                  className: 'dhs-input', type: 'text', value: query,
                  placeholder: t('search'),
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
                onClick: () => setReloadKey((k) => k + 1),
              }, h(RefreshIcon))),

            // Failure detail (the chip only shows "!").
            error ? h('div', { className: 'dhs-status is-error' }, error) : null,

            // Cards. `items` (the full list) rides along so quote badges can
            // resolve their source-message ordinals.
            renderCardList(list, items, shown, q, hasFilter, t, ctx, openView, sessionId, timeLocale)));
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
                    (slotProps) => h(HistoryPanel, Object.assign({}, slotProps, {
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
      }

      exports.inject = ['slots', 'sidebarRightTabs', 'sessions'];
      exports.apply = apply;
      return module.exports;
    },
  });
})();
