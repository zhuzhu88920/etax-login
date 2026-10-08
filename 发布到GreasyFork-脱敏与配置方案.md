# etax_login 发布到 GreasyFork：脱敏方案 + 快速填账号

## 一、核心原则

**真实账号绝对不能出现在脚本源码里。** GreasyFork 上的脚本是公开可读的，会被搜索引擎索引、被他人 fork、被镜像站抓取，硬编码的税号/手机号/密码等于永久泄露。

正确做法：**代码里只留"空容器 + 假示例"，真实数据存 Tampermonkey 本地存储（`GM_setValue`）**。
这样源码怎么传都不泄密，而且脚本更新不会丢配置。

---

## 二、发布前脱敏检查清单

| # | 检查项 | 处理方式 |
|---|---|---|
| 1 | `CONFIG.accounts` | 改成 `accounts: []`，真实数据移到本地存储 |
| 2 | `CONFIG.sites` 里的 URL | 检查 `state=` 参数是否夹带 token / 会话标识，有就删掉只留站点标识 |
| 3 | 硬编码 cookie / token / Authorization | 全部删除 |
| 4 | 内网 IP、本地端口（127.0.0.1、10.x、192.168.x） | 删除或改成占位符 |
| 5 | README / 注释里的示例数据 | 换成假的（`91330100MA2XXXXXXX` / `13800000000`） |
| 6 | **Git 历史** ⚠️ | 如果真实税号曾 commit 过，push 到公开仓库照样泄露 |

### 第 6 项怎么查 / 怎么救

```bash
# 拿一个真实税号的前几位去历史里搜
git log --all --full-history -S "9133" --oneline

# 命中了就二选一：
# A. 用 git-filter-repo 全文替换
git filter-repo --replace-text <(echo "真实税号==>91330100MA2XXXXXXX")
# B. 更省心：删掉远端仓库，本地净化后重新 init 一个新仓库再 push
```

> 注意：GreasyFork 要求代码**不能压缩/混淆**（会被举报下架），所以别指望靠 obfuscate 藏数据——既违规也挡不住人。

---

## 三、脚本改造（三步）

### 步骤 1：metadata 加三个 grant

```js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
```

> 从 `@grant none` 改成有 grant 后，已安装的用户更新脚本时 Tampermonkey 会重新申请权限，需要点一次确认。

### 步骤 2：CONFIG 留空 + 读取时优先本地

```js
const CONFIG = {
  sites: { shenzhen: "...", zhejiang: "..." },   // URL 保持不变
  accounts: [],   // ← 发布版留空！真实账号走「⚙️ 配置账号」面板，只存本机
};

/* ---------- 账号读写：本地优先 ---------- */
const STORE_KEY = 'etax_accounts_v1';

function loadAccounts() {
  try {
    const v = GM_getValue(STORE_KEY, null);
    if (Array.isArray(v)) return v;      // 只要本地有（哪怕是空数组）就用本地
  } catch (e) { /* 没授权 GM_getValue 时回落 */ }
  return CONFIG.accounts || [];
}
function saveAccounts(list) { GM_setValue(STORE_KEY, list); }
```

**把原代码里所有直接读 `CONFIG.accounts` 的地方换成 `loadAccounts()`。**

### 步骤 3：加配置面板（完整代码，直接粘到脚本末尾）

```js
/* ================= 账号配置面板 ================= */
function splitLine(line) {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(','))  return line.split(',');
  if (line.includes('，'))  return line.split('，');
  if (line.includes('|'))  return line.split('|');
  return line.split(/\s+/);
}

// 两种粘贴格式都吃：
//   1) JSON 数组  [{ "name":"公司甲","site":"shenzhen","taxId":"...","phone":"...","password":"..." }]
//   2) 每行一条   企业名 纳税人识别号 手机号 密码 shenzhen|zhejiang
function parseAccounts(text) {
  const t = (text || '').trim();
  if (!t) throw new Error('内容为空');
  if (t[0] === '[') {
    const arr = JSON.parse(t);
    if (!Array.isArray(arr)) throw new Error('JSON 顶层必须是数组');
    return arr.map(x => ({
      name: (x.name || x.企业名 || '').trim(),
      site: (x.site || x.站点 || 'shenzhen').trim(),
      taxId: (x.taxId || x.税号 || '').trim(),
      phone: (x.phone || x.手机号 || '').trim(),
      password: x.password || x.密码 || ''
    })).filter(x => x.taxId && x.password);
  }
  return t.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(line => {
    const p = splitLine(line).map(s => s.trim()).filter(Boolean);
    return { name: p[0] || '', taxId: p[1] || '', phone: p[2] || '', password: p[3] || '', site: p[4] || 'shenzhen' };
  }).filter(x => x.taxId && x.password);
}

const BTN = 'padding:6px 14px;border-radius:6px;border:1px solid #dcdfe6;background:#fff;cursor:pointer;font-size:13px';

function openConfigPanel() {
  const old = document.getElementById('etax_cfg_panel');
  if (old) { old.remove(); return; }

  const box = document.createElement('div');
  box.id = 'etax_cfg_panel';
  box.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:48px;transform:translateX(-50%);'
    + 'width:min(700px,94vw);max-height:88vh;overflow:auto;background:#fff;border:1px solid #dcdfe6;'
    + 'border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.25);padding:16px;'
    + 'font:14px/1.6 -apple-system,"Microsoft YaHei",sans-serif;color:#303133;';
  box.innerHTML =
    '<div style="font-weight:700;margin-bottom:6px">⚙️ 配置我的企业账号</div>'
    + '<div style="color:#909399;font-size:12px;margin-bottom:8px">数据<b>只保存在本机浏览器</b>，不上传任何服务器、不进脚本源码。<br>'
    + '每行一条，用 Tab / 逗号 / 空格 分隔：<b>企业名&nbsp; 纳税人识别号&nbsp; 手机号&nbsp; 密码&nbsp; shenzhen|zhejiang</b><br>'
    + '也支持直接粘贴 JSON 数组（字段：name / taxId / phone / password / site）</div>'
    + '<textarea id="etax_cfg_text" spellcheck="false" placeholder="公司甲  91440300MA5XXXXX  13800138000  mypassword  shenzhen" '
    + 'style="width:100%;height:200px;box-sizing:border-box;font:12px/1.6 Consolas,monospace;padding:8px;'
    + 'border:1px solid #dcdfe6;border-radius:6px;resize:vertical"></textarea>'
    + '<div id="etax_cfg_msg" style="min-height:20px;font-size:12px;color:#e6a23c;margin:6px 0"></div>'
    + '<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">'
    + '<button data-act="export" style="' + BTN + '">导出当前</button>'
    + '<button data-act="clear"  style="' + BTN + '">清空</button>'
    + '<button data-act="close"  style="' + BTN + '">关闭</button>'
    + '<button data-act="save"   style="' + BTN + ';background:#409eff;color:#fff;border-color:#409eff">保存并生效</button>'
    + '</div>';
  document.body.appendChild(box);

  const ta  = box.querySelector('#etax_cfg_text');
  const msg = box.querySelector('#etax_cfg_msg');

  box.addEventListener('click', e => {
    const act = e.target && e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === 'close')  return box.remove();
    if (act === 'export') { ta.value = JSON.stringify(loadAccounts(), null, 2); msg.textContent = '已导出到文本框，可复制备份'; return; }
    if (act === 'clear')  { if (confirm('确定清空本机保存的账号？')) { saveAccounts([]); msg.textContent = '已清空，刷新页面生效'; } return; }
    if (act === 'save') {
      try {
        const list = parseAccounts(ta.value);
        if (!list.length) throw new Error('没解析出有效条目，请检查格式');
        saveAccounts(list);
        msg.style.color = '#67c23a';
        msg.textContent = '已保存 ' + list.length + ' 条，正在刷新页面…';
        setTimeout(() => location.reload(), 800);
      } catch (err) {
        msg.style.color = '#f56c6c';
        msg.textContent = '保存失败：' + err.message;
      }
    }
  });
}

GM_registerMenuCommand('⚙️ 配置账号（本地保存）', openConfigPanel);
```

### 步骤 4（可选）：空状态引导

企业列表渲染时，如果 `loadAccounts().length === 0`，把列表内容换成一句提示，点击直接 `openConfigPanel()`：

```js
if (!loadAccounts().length) {
  listEl.innerHTML = '<div style="padding:10px;color:#e6a23c;cursor:pointer" '
    + 'onclick="document.getElementById(\'etax_cfg_panel\')||0">'
    + '还没有配置账号，点这里打开配置面板 →</div>';
}
```

---

## 四、以后怎么用（自己 / 别人，同一套动作）

1. 安装脚本（GreasyFork 页面点「安装」）
2. 点浏览器右上角 **Tampermonkey 图标 → 该脚本 → ⚙️ 配置账号（本地保存）**
3. 粘贴，两种格式任选：

```
公司甲	91440300MA5XXXXX	13800138000	password1	shenzhen
公司乙	91440300MA5YYYYY	13800138001	password2	shenzhen
公司丙	91330100MA2ZZZZZ	13800138002	password3	zhejiang
```

或

```json
[{"name":"公司甲","site":"shenzhen","taxId":"91440300MA5XXXXX","phone":"13800138000","password":"password1"}]
```

4. 点「保存并生效」→ 页面自动刷新 → 悬浮按钮里的企业列表就出来了

**从旧脚本迁移**：先把旧脚本里已填好的 `accounts` 数组整段复制出来，新脚本面板里粘进去即可——JSON 格式直接支持。

**换电脑 / 重装浏览器**：面板里点「导出当前」→ 复制 JSON 存好 → 新机器粘贴一次。

> `GM_setValue` 的数据按 `@namespace + 脚本名` 存，**脚本更新不会丢**，只有卸载脚本才清掉。

---

## 五、GreasyFork 发布步骤

### 必填 metadata（缺 `@license` 会被拦）

```js
// ==UserScript==
// @name         电子税务局 一键填表登录（深圳/浙江）
// @namespace    http://tampermonkey.net/
// @version      15.0
// @description  在电子税务局 tpass 登录页自动填写纳税人识别号/手机号/密码并提交，支持多企业一键切换。验证码仍需人工点选。
// @author       zhuzhu88920
// @license      MIT
// @match        *://*.chinatax.gov.cn/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==
```

> `@match` 换成你实际的两个 tpass / etax 域名，别用 `*://*/*`。

### 流程

1. 注册/登录 greasyfork.org（支持 GitHub 登录）
2. 右上角用户名 → **发布你编写的脚本** → 粘贴完整代码 → 提交
   - 语言选「中文（简体）」
   - "附加信息"区把 README 精简版贴进去（功能 / 用法 / 配置 / 已知结论），Markdown 可选
   - 勾选声明：**本脚本不会向任何服务器发送用户数据**
3. 发布成功后，进脚本 **Admin（管理）** 页 → **从源代码仓库同步**
   - 同步 URL 必须是 **raw 文件地址**（GitHub 页面上点 Raw 拿到的那个）：
     `https://raw.githubusercontent.com/zhuzhu88920/etax-login/main/etax_login.user.js`
   - 同步方式选「自动 - 定期检查」（约每小时）或 **Webhook**（push 即时，推荐）
   - Webhook 地址见 https://greasyfork.org/zh-CN/users/webhook-info
4. ⚠️ 两个坑：
   - **首次发布只能粘贴代码**，发布成功后才出现同步选项
   - **同步地址设好后不能改**，改的话要先关闭同步再重设

### 版本号

改代码后必须把 `@version` 加一号，否则 GreasyFork 同步时不会更新。

---

## 六、安全提醒（写进脚本描述里）

- 密码以明文存在本机浏览器存储中，任何能碰这台电脑 / 这个浏览器 profile 的人都能看到 → 只在自己的设备上用
- 别在公共电脑 / 公司公用机上配置
- 脚本本身不发送任何数据，但如果本机中了恶意扩展，本地存储仍有被读走的风险
