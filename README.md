# dsh-history-search

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI plugin that adds a
**History search** tab to the right sidebar. It lists every message **you** sent in the current
conversation as cards, filters them as you type, and jumps straight back to the matching message
when you click a card.

Long sessions lose their thread: scroll up and the question you asked twenty turns ago is gone.
This plugin gives the conversation a table of contents you can search.

## Features

| Feature | Notes |
|---|---|
| Right-sidebar tab | Sits next to 对话 / 轨迹 / 浏览器, one click away, no layout change |
| User messages only | Your own turns as cards; assistant replies are reachable as jump targets but never clutter the list |
| Live keyword filter | Every keystroke filters the cards and highlights the matched fragment |
| Counter | `12 条` while browsing, `3/12 条` while a filter or badge filter is active |
| Image filter | Keeps only the messages that carry an image attachment |
| Quote filter | Keeps only the messages that quote an earlier message |
| Jump to message | Click a card, the conversation scrolls to that row and marks it with a fading blue arrow |
| Quote badge | `#N` after the quote icon names the message that was quoted |
| Live updates | New messages appear as they are sent; no reload, and the list survives tab switches |
| Copy / reinsert | Every card can copy its text or put it back into the composer with one click |
| Frosted search strip | The search bar floats above the list with a frosted-glass surface |
| Light and dark | Built on theme tokens only (`--dsw-alias-*` / `--dsw-static-*`), so it follows the active theme |
| Bilingual UI | Chinese and English, following the app locale |

## Install

A bundle installs from a directory:

```
plugin_manager install_bundle target=<absolute path to this checkout>
```

Or add the row to your profile patch:

```yaml
- insert:
    - id: dsh-history-search
      name: '@local/dsh-history-search'
```

### Reload the page after installing

The Host half is an empty shell; the browser module is loaded once per page. Reload the window
(or restart the application) after installing, then open the chat page and look for the
**History search** tab on the right.

### Package name

The bundle keeps the name `@local/dsh-history-search` and stays `"private": true`, because it is
installed into a profile as a local directory rather than published to npm. Rename it only if you
change `cordis.patch.yml` to match.

## Usage

1. Open a conversation.
2. Click the **History search** tab in the right sidebar — your messages appear, newest last.
3. Type in the search box to filter and highlight; use the two buttons in the strip to keep only
   image messages or only quoting messages.
4. Click a card to jump. The target row gets a blue arrow that fades out once.
5. Hover a card for two buttons: copy the message text, or put it back into the composer.

## Known limits

- The list covers the most recent 40 pages of session events (thousands of messages in practice).
  Older messages are not listed, and `#N` numbering starts at the earliest message that was loaded.
- The first open of a long session reads its history once; switching back to the same session reuses
  the cache and only fetches the new tail.
- Copy and reinsert need the session context the tab cannot see directly, so they are bridged through
  an invisible slot inside the composer. If a future Harness drops that slot, the reinsert button
  becomes disabled while copy keeps working.

## Project layout

| File | Purpose |
|---|---|
| `package.json` | Bundle manifest: `dsh.bundle.patch`, `dsh.client.platform`, `dsh.client.inject` |
| `cordis.patch.yml` | Inserts the plugin row into the profile |
| `index.js` | Host half (no-op; rendering lives in the Client module) |
| `client.js` | The whole UI: sidebar tab, card list, filter, jump logic |
| `locale/*.json` | Plugin name and description shown on the Plugins page |
| `icon.svg` | Tab icon |

## License

[MIT](LICENSE) © 2026 Zhang Xiukai (Dipper)