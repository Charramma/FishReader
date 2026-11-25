# FishReader

上班摸鱼用的 PC 端超小小说阅读器。无边框小窗常驻屏幕右下角，黑底灰白字，滚轮阅读，自动生成目录。

当前版本：0.1.1 ｜ 平台：Windows ｜ 运行时：Electron 33

## 功能

| 项目 | 说明 |
| --- | --- |
| 窗口 | 无边框、无标题栏，默认 380×560 停在主屏工作区右下角，可置顶；位置与尺寸自动记忆 |
| 移动 | 按住顶部工具条任意空白处拖动 |
| 缩放 | 拖四条边 + 四个角，最小 300×320 |
| 工具条 | 鼠标移动时淡入，1.6 秒无操作自动淡出；不碰它时窗口里只有一块正文 |
| 主题 | 黑底 `#141414` + 灰白字 `#c8c8c8` ↔ 白底 `#fafafa` + 黑字 `#222` |
| 排版 | 字号 12–34px，行距 1.3–2.6，中文段落自动首行缩进 |
| 透明度 | 整窗 35%–100%，可边读边调 |
| 格式 | `.txt`（自动识别 UTF-8 / GB18030 / Big5 等编码）、`.epub`（EPUB2 NCX 与 EPUB3 nav 目录、内嵌图片） |
| 目录 | 自动生成，默认隐藏；覆盖式左侧抽屉，按层级缩进，点击跳转，跟随滚动高亮当前章 |
| 阅读方式 | 连续滚动，跨章无缝衔接，滚到末尾自动加载下一章 |
| 进度 | 记住上次打开的书，重启后回到上次那一页那一行 |
| 老板键 | 全局热键 `` `Alt+` ` ``，焦点在任意程序时都能瞬间隐藏/恢复 |

## 快捷键

| 键 | 作用 |
| --- | --- |
| `` `Alt+` ` `` | 老板键：立即隐藏 / 恢复（全局生效，无需焦点） |
| `Ctrl+O` | 打开文件 |
| `Ctrl+T` / `Esc` | 目录抽屉开 / 关 |
| `T` | 切换黑底 / 白底 |
| `+` / `-` | 字号增大 / 减小 |
| `[` / `]` | 行距减小 / 加大 |
| `Ctrl+-` / `Ctrl+=` / `Ctrl+0` | 透明度降低 / 升高 / 复位 100% |
| `P` | 窗口置顶开关 |
| `Ctrl+→` / `Ctrl+←` | 下一章 / 上一章 |
| `PgUp` `PgDn` `↑` `↓` `Home` `End` | 滚动 |
| `Ctrl+Q` | 退出 |

## 使用

- **免安装单文件**：`release/FishReader-0.1.0-portable.exe`，双击即用。首次启动需解包到临时目录，会慢 1–2 秒；想要秒开就用 `release/win-unpacked/FishReader.exe`（文件夹版）。
- 打开书：点工具条上的文件夹图标，或直接把 `.txt` / `.epub` 拖进窗口。
- 也可以在资源管理器里右键 → 打开方式 → 选 FishReader（免安装版不会自动注册文件关联）。
- 退出：点工具条最右的「关」，或 `Ctrl+Q`。窗口隐藏后除老板键外没有别的入口，忘了键就再启动一次程序——单实例机制会把已隐藏的窗口直接唤回。
- 配置与进度：`%APPDATA%\FishReader\config.json`。想彻底重置，删掉这个文件即可。

## 开发

```bash
npm install          # 国内建议先设 ELECTRON_MIRROR，见下
npm start            # 开发运行
npm run dist         # 打包 release/FishReader-<版本>-portable.exe
```

Electron 与 electron-builder 的二进制默认从 GitHub 拉，网络不畅时用镜像：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
```

`package.json` 里 `build.win.signAndEditExecutable: false` 是必需的：electron-builder 解压 `winCodeSign` 时要创建 macOS 符号链接，普通账户没有 `SeCreateSymbolicLinkPrivilege` 会直接失败。将来要做 exe 图标和代码签名，需以管理员身份或开启 Windows 开发者模式构建，并把这项改回 true。

### 自动构建与发版

`.github/workflows/release.yml` 在 `windows-latest` 上打包：推 `v*` 的 tag 就会自动构建并把 `release/*-portable.exe` 挂到对应的 GitHub Release。

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`package.json` 的 `version` 要和 tag 对上（产物文件名带版本号）。不想动 tag 只想验证构建能否通过，就去 Actions 页面手动运行一次，产物在那个运行的 Artifacts 里下载。

CI 和本地打出来的 exe 都没有代码签名，别人第一次运行时 Windows SmartScreen 会提示「未知发布者」，点「更多信息 → 仍要运行」即可；要消除提示只能买代码签名证书。

运行时依赖只有 4 个：`jszip`、`fast-xml-parser`（epub）、`iconv-lite`、`jschardet`（txt 编码）。渲染层不使用任何前端框架，纯原生 DOM。

## 工程结构

```
src/
├── main/
│   ├── main.js          应用入口：单实例、book:// 协议、全局老板键、命令行打开文件
│   ├── window.js        无边框窗口：右下角定位、置顶、透明度、八向拖拽缩放、位置持久化
│   ├── config.js        极简 JSON 配置存储（原子写入 + 防抖 + 进度上限 60 条）
│   ├── ipc.js           主进程与渲染层的接口收口
│   ├── library.js       当前打开的书；统一产出 { pages, chapters } 模型
│   └── books/
│       ├── txt.js       编码探测、章节正则、兜底分段
│       └── epub.js      container → OPF → spine，nav/NCX 目录，zip 内资源读取
├── preload/index.js     contextBridge 暴露 window.fish（无 nodeIntegration）
└── renderer/
    ├── index.html
    ├── css/app.css      两套主题 + 布局，全部走 CSS 变量
    └── js/
        ├── util.js      DOM/路径/提示等小工具
        ├── epub-view.js epub XHTML 白名单清洗、图片改走 book://
        ├── reader.js    连续滚动引擎：按需加载、窗口化裁剪与占位补偿、进度上报
        ├── toc.js       目录抽屉渲染、跳转、当前章高亮
        └── app.js       工具条、悬停浮现、缩放热区、快捷键、打开与持久化
```

## 几个实现决定

- **不用 `transparent: true`**：透明无边框窗口在 Windows 上拿不到原生缩放、文字抗锯齿也会变差，而 `win.setOpacity()` 能达到同样的半透明效果。代价是透明度会把文字一起变淡，所以默认 100%。
- **缩放自己实现**：无边框窗口没有可拖的边框，主进程以 16ms 轮询光标位置换算 `setBounds`，渲染层只负责 pointerdown/up 与光标样式。
- **epub 不按目录切分正文**：正文永远按 spine 文档连续渲染一次，目录只做「页 + 锚点」索引。这样目录里父子章节指向同一文档时不会重复或丢内容。
- **txt 分章是渐进降级**：先匹配 `第X章/回/节/卷/折`、`Chapter N`、`楔子/序言/后记/番外/大结局` 等；命中不足则试纯数字编号标题；再不行按每 2000 字分段生成「第 N 段」目录。第一个标题前的书名/作者会单独成「开篇」，不丢字。
- **长书不会撑爆 DOM**：只保留当前阅读位置附近的已渲染页，移出的页用 `phantomTop/phantomBottom` 占位并记录高度，往回滚时按记录的高度插回并补偿滚动位置，所以位置不跳。
- **安全边界**：`contextIsolation: true`、`nodeIntegration: false`、CSP 限制脚本只来自本地；epub 的 XHTML 经 `DOMParser` 解析后按白名单重建，丢弃 `script`/`style`/`href` 等，图片通过自定义 `book://` 协议从 zip 内按需取流，不整本转 base64。
- **配置自写而不是用 electron-store**：少一个依赖，绿色版只在 `%APPDATA%` 下留一个文件。

## 限制

- 文件上限：txt 80 MB，epub 120 MB。超大 txt 首次解析分章会短暂停顿。
- 只支持 `.txt` 和 `.epub`。`.mobi` / `.azw3` 明确不做（容器与压缩要自己解析，且商店文件多为 DRM 加密，投入产出不成比例）；这类书建议先用 Calibre 转成 epub。也不支持 PDF / fb2。
- DRM 保护的文件（加密 epub、Kindle 的 MoveRead/KFX）无法打开。
- 阅读进度以文件绝对路径为键。把书移动到别的目录会被当成新书，进度从头开始。
- 目录识别质量取决于文本本身的规整程度。标题写法太冷门的 txt，目录可能偏粗（整本少数几段）甚至不准。
- `` `Alt+` `` 是系统级全局注册，注册成功后其他程序就收不到这个组合键了。想换键就改 `config.json` 里的 `hotkeyToggle`，格式为 `Ctrl+Alt+Q`、`Alt+Shift+F1` 这类组合（`CommandOrControl` 可简写），重启生效；若被占用，工具条会提示「老板键被其他程序占用了」。
