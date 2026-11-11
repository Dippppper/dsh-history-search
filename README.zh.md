# dsh-history-search

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI 加一个右侧栏
**历史对话搜索**标签页。它把当前会话里**你发过的每一条消息**列成卡片，边打字边筛选，点卡片就能跳回
对话里的那一条。

会话一长就丢了线索：往上翻半天，二十轮之前问过什么已经找不到了。这个插件给对话加了一份能搜的目录。

## 功能

| 功能 | 说明 |
|---|---|
| 右侧栏标签页 | 与 对话 / 轨迹 / 浏览器 并列，点一下就打开，不改布局 |
| 只列你的消息 | 你自己的发言变成卡片；助手回复只作为跳转目标，不占列表 |
| 即时关键字筛选 | 每次输入都重新筛选，并高亮命中的片段 |
| 计数 | 浏览时显示 `12 条`，有筛选时显示 `3/12 条` |
| 图片筛选 | 只保留带图片附件的消息 |
| 引用筛选 | 只保留引用了前文的消息 |
| 点击跳转 | 点卡片后对话滚到那一行，并在最左侧打一个逐渐淡出的蓝色箭头 |
| 引用徽标 | 引用图标后的 `#N` 标出被引用的是第几条消息 |
| 毛玻璃搜索条 | 搜索框浮在列表上方，是一条连续的毛玻璃层 |
| 明暗主题 | 只用主题变量（`--dsw-alias-*` / `--dsw-static-*`），跟随当前主题 |
| 中英双语 | 跟随应用语言切换 |

## 安装

Bundle 从本地目录安装：

```
plugin_manager install_bundle target=<这个仓库的绝对路径>
```

或者手动在 profile patch 里加一行：

```yaml
- insert:
    - id: dsh-history-search
      name: '@local/dsh-history-search'
```

### 装完要刷新页面

Host 那半边是个空壳，真正干活的是浏览器模块，而它每打开一次页面只加载一次。装完之后刷新窗口
（或重启应用），再打开对话页，右侧就能看到 **历史对话搜索** 标签。

### 关于包名

Bundle 名保持 `@local/dsh-history-search`、`"private": true`，因为它是作为本地目录装进 profile 的，
没打算发 npm。要改名的话记得同步改 `cordis.patch.yml`。

## 使用

1. 打开一个会话。
2. 点右侧栏的 **历史对话搜索**，你的消息按时间顺序列出，最新一条在最后。
3. 在搜索框里打字筛选并高亮；搜索条上两个按钮可以只看带图的、或只看带引用的。
4. 点卡片跳转，目标行左侧的蓝色箭头只淡出一次。

## 目录结构

| 文件 | 作用 |
|---|---|
| `package.json` | Bundle 清单：`dsh.bundle.patch`、`dsh.client.platform`、`dsh.client.inject` |
| `cordis.patch.yml` | 把插件挂进 profile |
| `index.js` | Host 半边（空实现，渲染全在 Client 模块里） |
| `client.js` | 全部 UI：侧栏标签、卡片列表、筛选、跳转逻辑 |
| `locale/*.json` | 插件页上显示的名称与描述 |
| `icon.svg` | 标签图标 |

## 许可

[MIT](LICENSE) © 2026 Zhang Xiukai (Dipper)