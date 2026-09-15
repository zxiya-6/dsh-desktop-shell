# DSH Desktop

把 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 封装成一个开箱即用的 Windows 桌面应用：
**依赖全部内置、与系统环境隔离、自带 Chromium 内核、内置可更新依赖的终端。**

沿用官方 Web UI（不重造界面），桌面层只负责它原本缺失的宿主能力：进程生命周期、端口与鉴权、数据持久化、终端、打包分发。

---

## 一、设计要点

### 1. 依赖内置，与系统隔离

| 能力 | 系统里需要装吗 | 说明 |
|---|---|---|
| Node.js | ❌ 不需要 | 直接用 Electron 自带的 Node 24 |
| pnpm | ❌ 不需要 | 打包进 `node_modules/pnpm` |
| dsh + 522 个依赖 | ❌ 不需要 | **不进安装包**，按需下载到 `%APPDATA%\dsh-desktop\core` |
| Chromium | ❌ 不需要 | Electron 自带 |
| 系统的 Node/npm/pnpm 会不会干扰 | ❌ 不会 | 子进程 PATH 以内置目录优先 |

**dsh 以子进程方式运行**，通过 `ELECTRON_RUN_AS_NODE=1` 让 Electron 二进制当作纯 Node 使用——这样就不用再打包一套约 50MB 的 Node 运行时。

> 这要求 Electron ≥ 44（内置 Node 24.18+），因为 dsh 的 `bin.js` 结尾是
> `if (import.meta.main) await runCli()`，`import.meta.main` 是 Node 24 才有的属性。
> 在 Node 22 上它会**静默退出、退出码为 0、无任何报错**，是本项目最难排查的坑。

### 2. 数据放在安装目录之外

```
%APPDATA%\dsh-desktop\
├── dsh-home\        DSH_HOME：profile、凭据、插件（升级不丢）
├── workspace\       默认工作区，首次启动自动创建
├── logs\dsh.log     dsh 子进程日志
├── bin\             自动生成的 dsh / pnpm 命令 shim
├── config.json      内核版本选择、限速、快照保留数
├── plugin-manifest.json  插件与快照清单、回滚历史
└── core\            ← 内核（dsh 本体），与程序分离、可更新可回滚
    ├── snapshots\<version>\   每个版本一份完整 node_modules
    ├── staging\               下载/安装暂存，成功才提升
    └── update.lock            并发安装互斥锁
```

重装或升级应用不会带走 profile、会话和插件。

### 2.5 内核动态更新（快照 / 切换 / 回滚）

dsh 本体**不再打进安装包**，而是当作一个可更新的「内核」放在 `core/snapshots/<version>/`。
这样做换来三件事：安装包变小、内核可以独立于程序升级、装坏了能一键回滚。

```
查询版本 → 暂存安装 → 校验入口 → 预启动冒烟 → 提升为快照 → 切换
```

核心不变量：**只有新内核真的启动并通过 HTTP 就绪探测，才允许写入配置替换当前内核。**
任何一步失败，暂存目录被删除，当前内核分毫未动。

| 能力 | 实现 |
|---|---|
| 版本切换 | 改 `config.json` 的指针，不用 symlink（Windows 建符号链接要管理员/开发者模式） |
| 回滚 | 直接切回任意一个 `ready` 快照，并记录 `from → to` 历史 |
| 切换不丢插件 | `DSH_HOME` 固定在 `dsh-home/`，dsh 把插件装到 `$DSH_HOME/profiles/*/node_modules`，不在内核目录里 |
| 双通道限速 | 内核下载与插件下载各自一个本地 CONNECT 隧道代理，互不影响 |
| 并发保护 | `update.lock` 用 `O_EXCL` 创建，10 分钟自动判死清理 |
| 失败自愈 | 切换失败会把指针写回原版本并尝试重启原内核 |

界面入口：`Ctrl + K`（或菜单「内核 → 内核管理」）。内核缺失时启动页会直接给出「安装内核」按钮。

### 3. 内置终端

`Ctrl + \`` 打开。启动时自动注入内置环境变量，可直接执行：

```powershell
dsh --version
dsh plugin --profile web add @scope/plugin
pnpm add <pkg>
```

终端会**显式检测并展示 shell 类型与版本**，因为 Windows 上三者的行为差异足以导致乱码和命令失败：

| Shell | 说明 |
|---|---|
| `pwsh.exe` (PowerShell 7+) | 首选，UTF-8 表现最好 |
| `powershell.exe` (5.1) | 内置版本，兼容回退 |
| `cmd.exe` | 最后回退，启动时自动 `chcp 65001` |

### 4. 安全

- 渲染进程：`contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`
- `--expose-internals` **只授予 dsh 子进程**，不授予任何渲染进程
- 导航白名单：主窗口只能访问回环地址与本地页面；外链**仅允许 `http(s)`** 交给系统浏览器
  （`shell.openExternal` 会把字符串交给系统 Shell，放行 `file://` 等于任意程序执行）
- `app:openPath` 只允许打开 `userData` 目录内的路径
- 版本号、插件包名在拼进 pnpm 参数与路径前做白名单校验（防参数注入与路径穿越）
- 单实例锁：避免两个实例同时写同一套 profile

---

## 二、在 Windows 上构建

> ⚠️ **必须在 Windows 上构建，不能交叉编译。**
> `node-pty` 是原生模块，`node-gyp` 不支持交叉编译。在 Linux/macOS 上打 Windows 包会直接报
> `node-gyp does not support cross-compiling native modules from source`。
> 参考方案 dsh-desktop 也遵循同样的原则。

### 前置

- Node.js ≥ 22.19（用于构建；运行不需要）
- 网络可访问 npm registry

如果 `node-pty` 走本地编译，还需要 **Visual Studio Build Tools**（勾选「C++ 生成工具」）。

### 步骤

```powershell
cd dsh-desktop
npm install
npm run dist:win
```

产物在 `dist\`：

- `DSH-Desktop-Setup-0.1.0.exe` —— NSIS 安装包（标准安装，系统可识别、可卸载）
- `DSH-Desktop-0.1.0-portable.exe` —— 免安装绿色版（不写注册表，删文件夹即卸载）

---

## 三、安装与卸载

### 安装：路径由你决定

双击 `DSH-Desktop-Setup-<版本>.exe`，向导会给出**安装位置**页面，可以「浏览」到任意目录，
也可以直接手工输入。默认 `C:\Program Files\DSH Desktop`（`perMachine`，首次会请求管理员授权）。

| 方式 | 用法 | 场景 |
|---|---|---|
| 向导选择 | 「安装位置」页 → 浏览 / 手工输入 | 手动安装 |
| 静默参数 | `DSH-Desktop-Setup-0.1.0.exe /S /D=D:\Tools\DSH Desktop` | 批量部署、脚本安装 |
| 沿用上次 | 无需操作 | 升级、或卸载后重装 |

`/D=` 必须放在命令行**最后一位**，且路径**不要加引号**（含空格也能正确解析）。

覆盖安装（升级）时沿用上次目录，向导会跳过路径页；要换位置就先卸载再装，或用 `/D=`。
卸载后重装同样记得上一次的位置——electron-builder 自己的 `InstallLocation`
会随卸载项一起被删掉，所以额外在 `HKLM\Software\DSH Desktop\InstallPath`
留了一份备份（`build/installer.nsh` 的 `customInit` / `customInstall`）。

**换安装位置不影响任何数据。** profile、插件、会话、工作区、日志都在
`%APPDATA%\dsh-desktop`，与 exe 在哪无关。把程序从 C 盘挪到 D 盘，数据原样可用。

选路径时的两点建议：

- 中文与空格都支持，子进程调用全部做了引号处理；
- 但 Windows 的 `MAX_PATH`(260) 仍然有效，而 dsh 有 522 个依赖、目录层级极深，
  **尽量选短路径**（如 `D:\dsh`），别塞进 `D:\我的软件\AI 工具集合\DeepSeek\Harness Desktop\` 这种深坑。

装完后在 **设置 → 应用 → 已安装的应用** 中可见，带图标、版本号、发布者与卸载入口，
并显示真实安装路径（安装器向 ARP 项补写了 `InstallLocation`）。

### 卸载：系统能识别

卸载程序写入标准的「添加/删除程序」注册表项，所以下面三种方式都可用：

1. **Windows 设置** → 应用 → 已安装的应用 → DSH Desktop → 卸载
2. **开始菜单** → DSH Desktop → Uninstall DSH Desktop
3. **控制面板** → 程序和功能 → 卸载程序

因为是标准 ARP 项（`HKLM\...\Uninstall\...`），
Geek Uninstaller、Bulk Crap Uninstaller、Revo Uninstaller 这类工具也能正常识别并接管卸载。

### 卸载时的清理行为

卸载会先结束应用**及其 dsh 子进程**——两者用的是同一个 exe 映像名，
不先结束会导致文件被占用、卸载残留（见 `build/installer.nsh` 的 `customUnInstall`）。

随后询问是否一并删除用户数据：

| 选择 | 行为 |
|---|---|
| 是 | 清除 `%APPDATA%\dsh-desktop`、`%LOCALAPPDATA%\DSH Desktop` 等，彻底干净 |
| 否（默认） | 保留 profile、插件、会话与日志，重装后可继续使用 |

静默卸载（Geek Uninstaller、winget、脚本调用 `/S`）等价于「否」——不会误删数据，
也不会弹出对话框把自动化流程卡住（`MessageBox /SD IDNO`）。

卸载只删除安装器自己写进去的文件。安装目录里如果有你自己放的东西，目录会被保留下来。

### 想要完全不留痕？用绿色版

`portable` 版不写注册表、不装进 Program Files，整个应用就是一个目录，
**删掉文件夹就是卸载**，适合 U 盘携带或没有管理员权限的机器。

手动彻底清理（安装版）：

```powershell
Remove-Item "$env:APPDATA\dsh-desktop" -Recurse -Force
```

绿色版不需要这一步：它的数据写在 exe 同级目录的 `dsh-desktop-data\`，删文件夹时一起没了。

### 国内网络加速

```powershell
$env:ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
npm run dist:win
```

### 关于原生模块（`node-pty`）

终端依赖 `node-pty`，它是原生模块，但**通常不需要你本地编译**：

- 包内已带 `prebuilds/win32-x64/` 预编译二进制，且其 `.node` 使用 **N-API**（ABI 稳定），
  可直接在 Electron 中加载，无需针对 Electron 重新编译。
- 因此 `build.npmRebuild` 设为 `false`，**构建时不需要安装 Visual Studio Build Tools**。

若你希望强制为 Electron 重新编译，把 `package.json` 里 `build.npmRebuild` 改为 `true`
（此时需要 VS Build Tools，且需要能下载对应预编译产物）。

如果 `node-pty` 最终仍加载失败，应用已做降级：终端窗口会显示明确错误，
**其余功能照常可用**；也可移除该依赖后打包，只是没有终端。

---

## 四、本地开发

```powershell
npm install
npm start          # 或 npm run dev
```

首次启动若 `core/snapshots` 为空，会提示下载内核（约 500 个依赖，1–2 分钟）。

| 命令 | 验证什么 |
|---|---|
| `npm run smoke:terminal` | 内置终端与 shell 检测 |
| `npm run seed:core -- 0.1.5-rc.1` | 用内置 pnpm 装一份内核快照（验证依赖树可跑） |
| `npm run smoke:kernel` | 从 userData 解析内核并真实启动，拿到带 token 的 URL |
| `npm run smoke:switch` | 内核切换：成功路径 + 失败路径（配置不被污染、旧内核自愈） |
| `npm run smoke:phase2` | 远端元数据、双通道限速、插件清单、回滚候选、并发锁 |

只想验证内置终端是否可用（不启动完整界面）：

```powershell
npm run smoke:terminal
```

它会打印检测到的 shell 类型与版本，并确认 shell 能回显数据：

```
[smoke] node-pty available: true
[smoke] shell: PowerShell 7+ (pwsh7) version=7.4.6
[smoke] PASS — shell responded
```

---

## 五、关键技术决策与踩坑记录

这几个都是实机验证过的，改动前建议先读：

**1. `--expose-internals` 是必需的**

dsh 的 Cordis HMR 插件要求该 flag，否则：

```
Error: failed to apply loader entry @deepseek-ai/cordis-plugin-hmr:
--expose-internals is required for HMR service
```

表现为 dsh **打印完 URL 之后立刻崩溃**，Electron 加载 URL 得到 `ERR_CONNECTION_REFUSED`。
该 flag 只加在 dsh 子进程上（`src/main/dsh-launcher.js`）。

**2. `ELECTRON_RUN_AS_NODE` 下不能传 Electron 参数**

子进程里传 `--no-sandbox` 会直接报 `bad option: --no-sandbox`。
该模式下二进制按纯 Node 解析参数，只接受 Node flag。

**3. 必须等端口真正可服务**

dsh 打印 URL 早于 HTTP listener 就绪，直接加载会偶发连接失败。
`waitUntilServing()` 会轮询直到拿到 HTTP 响应（401/303 也算就绪）。

**4. Web UI 有 token 鉴权，cookie 绑定 `host:port`**

```
dsh web: http://127.0.0.1:43779/?token=...
```

cookie 内的 JWT 签名绑定了 `authority: "127.0.0.1:<port>"`，所以：
**必须从 stdout 解析带 token 的 URL 再跳转**，不能固定地址访问；端口每次随机。

**5. Node 版本**

必须 ≥ 24。开发时若用 Node 22，dsh 会静默退出且退出码为 0，
`dsh-launcher.js` 里因此加了显式的版本检查和超时。
dsh **没有声明 `engines` 字段**，所以 Node ≥ 24 这个下限是硬编码在
`config-store.js` 的 `KERNEL_MIN_NODE_MAJOR` 里的——不能指望它自己声明。

**6. pnpm 10 默认不跑依赖的构建脚本**

pnpm 10 起默认忽略依赖的 `install`/`postinstall`，`.npmrc` 里必须写
`dangerously-allow-all-builds=true`。否则 `node-pty`、`koffi`、
`dsh-subprocess-local` 会**静默没有原生二进制**，装完看起来成功，运行时才炸。
同理要把 `node_pty_binary_host_mirror`、`sharp_*` 指到国内镜像，
否则脚本会去 GitHub 拉预编译产物，失败后回退 node-gyp，而用户机器上没有工具链。

**7. `node-linker=hoisted`**

dsh 有约 522 个传递依赖。默认的 `.pnpm` 虚拟存储会给每个包的路径多加一层，
在 Windows MAX_PATH（260）下极易踩雷。`hoisted` 铺平成扁平 `node_modules`，路径更短。

**8. 先启动，再写配置**

内核切换的顺序必须是 `stop → 启动新快照 → 成功后再写 config`。
反过来的话，一个起不来的新内核会让 `config.json` 指向它，
**下次启动直接无法运行，而且当前也没有内核在跑**。`smoke:switch` 会验证这条。

**9. 冒烟测试不等于生产可启动**

安装时用独立的 `smoke-home` 和暂存目录做预启动验证，避免污染真实的 `DSH_HOME`。
这能证明「这个内核能起来」，但不代表带着真实 profile 一定能起来——
所以真正的切换仍然要在失败时回滚。

---

## 六、与社区方案 dsh-desktop 的关系

[dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop) 是成熟的社区方案，
本项目的架构借鉴了它的核心思路：随机回环端口 + 就绪检测、用户数据外置、
渲染进程加固、`--expose-internals` 仅授予子进程。

差异点：

| | 本项目 | dsh-desktop |
|---|---|---|
| 语言 | JavaScript（上手快） | TypeScript |
| dsh 版本 | 锁定 `0.1.5-rc.1` | 锁定 `0.1.0-rc.6` / `0.1.1-rc.1` |
| 内核更新方式 | **内核外置 + 快照/回滚** | 内核随安装包升级 |
| 内置终端 | ✅ | 未见 |
| preset 导入导出 | ❌ | ✅ `.dshpreset` |
| UI 补丁机制 | ❌ | ✅ `patch-package` |

---

## 七、已知限制

- **仅 Windows x64**。官方 Harness 桌面端同样未将 Linux 列入发布目标。
- dsh 仍是 `0.1.x-rc` 开发者预览版，一个月发 20 个版本，**必须锁版本**（当前 `0.1.5-rc.1`）。
  内核管理面板可以列出和切换已安装版本，但**不会自动跳到未经验证的 rc**。
- 内核不再进安装包，安装包体积显著下降；代价是**首次启动（或换机后）需要联网下载内核**。
- 内核快照是完整依赖树，单个约 300–400 MB；`keepSnapshots` 默认保留 3 份，可在面板里清理。
- 开发态 `node_modules` 仍约 700 MB（含 Electron 与 pnpm 二进制）。
- Windows MAX_PATH（260）依然是硬约束：已通过 `node-linker=hoisted` 缩短路径，
  但**极深的嵌套目录仍可能触发**，建议把安装路径和用户目录都放在浅层位置。
- macOS 未做签名公证配置；如需 macOS 版本需要额外配置。
- 官方已在上游仓库推进 `apps/desktop`，未来可能与本项目职能重叠。

## 八、License

MIT
