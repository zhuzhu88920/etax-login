// ==UserScript==
// @name         深圳/浙江税务-一键填表登录
// @namespace    http://tampermonkey.net/
// @version      15.4
// @license      MIT
// @description  电子税务局 tpass 登录页一键填写（税号/手机号/密码）并提交，支持多企业。账号只存在本机浏览器，不写进源码。验证码仍需人工点选。
// @match        https://tpass.shenzhen.chinatax.gov.cn:8443/*
// @match        https://tpass.zhejiang.chinatax.gov.cn:8443/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    /* ===================== 配置 ===================== */
    const STORE_KEY = 'etax_accounts_v1';    // 本机账号存储
    const PENDING_KEY = 'etax_pending_autofill'; // 跨站跳转时的待填标记（不进 URL）

    const CONFIG = {
        // 登录页地址（实测：整条 URL 可长期复用，state 不会失效）
        sites: {
            shenzhen: 'https://tpass.shenzhen.chinatax.gov.cn:8443/#/login?redirect_uri=https%3A%2F%2Fetax.shenzhen.chinatax.gov.cn%3A8443%2Fmhzx%2Fapi%2Fmh%2Ftpass%2Fcode&client_id=b5492bba3b4e4f37b977c354a2b26a59&response_type=code&state=f407e89320184a86a2a638ce35c70848&client_pid=b5492bba3b4e4f37b977c354a2b26a59',
            zhejiang: 'https://tpass.zhejiang.chinatax.gov.cn:8443/#/login?redirect_uri=https%3A%2F%2Fetax.zhejiang.chinatax.gov.cn%3A8443%2Fmhzx%2Fapi%2Fmh%2Ftpass%2Fcode&client_id=tct8zta97w6c46zdt9zc2648227df5z2&response_type=code&state=c816f6aebc074f789f9f09a1202efccc'
        },

        // ⚠️ 发布版必须留空！真实账号通过弹窗填写后存本机（GM_setValue），
        //    绝不写进源码 —— GreasyFork 上的脚本是公开可读的。
        accounts: []
    };

    const SITE_LABEL = { shenzhen: '深圳', zhejiang: '浙江' };

    /* ---------- 页面 realm 的事件构造器 ----------
     * 脚本带了 @grant 就跑在 Tampermonkey 沙箱里，此时裸写 new Event() / new MouseEvent()
     * 拿到的是【沙箱】的构造器，派发出去 Vue 收不到 —— 表现为「值填上了但登录没反应」。
     * 必须显式取页面 window 的构造器（v14 用 @grant none 所以没这个问题）。
     */
    const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    const PageEvent = PAGE.Event || Event;
    const PageMouseEvent = PAGE.MouseEvent || MouseEvent;
    const PageInputEvent = PAGE.InputEvent || PageEvent;

    /* ---------- 样式常量 ---------- */
    const inputCss = 'width:100%; box-sizing:border-box; padding:7px 10px; font-size:13px;'
        + 'border:1px solid #dcdfe6; border-radius:6px; outline:none; background:#fff; color:#303133;';
    const btnCss = 'padding:6px 14px; border-radius:6px; border:1px solid #dcdfe6; background:#fff;'
        + 'cursor:pointer; font-size:13px; color:#606266;';

    /* ===================== 账号存取 ===================== */
    function loadAccounts() {
        try {
            const v = GM_getValue(STORE_KEY, null);
            if (Array.isArray(v)) return v;
        } catch (e) { /* 未授权时回落到代码内配置 */ }
        return CONFIG.accounts || [];
    }

    function saveAccounts(list) {
        try { GM_setValue(STORE_KEY, list); } catch (e) { }
    }

    function isInitialized() {
        try { return GM_getValue(STORE_KEY, null) !== null; } catch (e) { return true; }
    }

    /* ===================== 工具 ===================== */
    const Utils = {
        sleep: (ms) => new Promise(r => setTimeout(r, ms)),

        isVisible: (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0;
        },

        toast: (msg, color = '#1890ff', ms = 2600) => {
            let el = document.getElementById('sz-toast');
            if (!el) {
                el = document.createElement('div');
                el.id = 'sz-toast';
                el.style.cssText = 'position:fixed; top:0; left:50%; transform:translateX(-50%); z-index:2147483646;'
                    + 'background:#333; color:#fff; padding:8px 20px; border-radius:0 0 8px 8px; font-size:14px;'
                    + 'box-shadow:0 2px 10px rgba(0,0,0,0.3); max-width:80vw;';
                (document.body || document.documentElement).appendChild(el);
            }
            el.innerHTML = msg;
            el.style.backgroundColor = color;
            if (ms) setTimeout(() => { if (el) el.remove(); }, ms);
        }
    };

    const Actions = {
        clickStandard: (el) => {
            if (!el) return;
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const opts = { bubbles: true, cancelable: true, view: PAGE };
            el.dispatchEvent(new PageMouseEvent('mouseover', opts));
            el.dispatchEvent(new PageMouseEvent('mousedown', opts));
            el.dispatchEvent(new PageMouseEvent('mouseup', opts));
            // ⚠️ 只派发一次 click。原来后面还跟了一句 el.click()，会点两次 → 登录提交两次
            el.dispatchEvent(new PageMouseEvent('click', opts));
        }
    };

    /* ===================== 站点 ===================== */
    function currentSite() {
        const h = location.hostname;
        return Object.keys(CONFIG.sites).find(k => h.includes(k)) || null;
    }
    function isTpass() { return location.hostname.indexOf('tpass.') === 0; }

    /* ===================== 登录表单 ===================== */
    // 登录按钮：优先按文本找「登录」，找不到才回落原来的选择器
    function pickLoginBtn() {
        const all = Array.prototype.slice.call(document.querySelectorAll('.el-col > .el-button, button.el-button'));
        const byText = all.find(x => /登\s*录/.test((x.innerText || x.textContent || '').trim()));
        return byText || document.querySelector('.el-col > .el-button');
    }

    function getLoginForm() {
        return {
            taxInput: document.querySelector('.el-autocomplete .el-input__inner'),
            phoneInput: document.querySelector('.mobileInp > .el-input__inner'),
            pwdInput: document.querySelector('.pwdInp > .el-input__inner'),
            loginBtn: pickLoginBtn()
        };
    }

    // 等按钮真正可点（Element UI 校验没过时会挂 is-disabled）
    async function waitClickable(btn, timeout = 5000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (btn && !btn.disabled && !(btn.classList && btn.classList.contains('is-disabled'))) return true;
            await Utils.sleep(200);
        }
        return false;
    }
    function isLoginPage() {
        const { taxInput, phoneInput, pwdInput } = getLoginForm();
        return Utils.isVisible(taxInput) && Utils.isVisible(phoneInput) && Utils.isVisible(pwdInput);
    }
    async function waitForLoginForm(timeout = 15000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (isLoginPage()) return true;
            await Utils.sleep(500);
        }
        return false;
    }

    async function fillAndSubmit(acc) {
        const { taxInput, phoneInput, pwdInput, loginBtn } = getLoginForm();
        if (!taxInput || !phoneInput || !pwdInput || !loginBtn) {
            Utils.toast('❌ 未找到登录表单', '#f5222d', 3000);
            return;
        }
        function fillField(el, value) {
            el.value = value;
            // 用页面 realm 的构造器，Vue 才能收到
            let ev;
            try {
                ev = new PageInputEvent('input', { bubbles: true, cancelable: true, data: value });
            } catch (e) {
                ev = new PageEvent('input', { bubbles: true, cancelable: true });
            }
            el.dispatchEvent(ev);
            el.dispatchEvent(new PageEvent('change', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new PageEvent('blur', { bubbles: true, cancelable: true }));
            const parent = el.parentElement;
            if (parent && parent.classList.contains('el-input')) parent.classList.remove('is-error');
        }
        fillField(taxInput, acc.taxId);
        fillField(phoneInput, acc.phone);
        fillField(pwdInput, acc.password);
        Utils.toast(`已填写: ${acc.name}`, '#52c41a');

        await Utils.sleep(500);

        const ok = await waitClickable(loginBtn);
        if (!ok) Utils.toast('⚠️ 登录按钮还是禁用状态，可能表单校验没过', '#faad14', 4000);

        Actions.clickStandard(loginBtn);
        Utils.toast('已点击登录，请手动完成验证码点选', '#faad14', 6000);
    }

    function login(acc) {
        const target = CONFIG.sites[acc.site];
        if (!target) { Utils.toast(`❌ 未配置站点: ${acc.site}`, '#f5222d', 3000); return; }
        if (currentSite() !== acc.site || !isTpass()) {
            // 跨站跳转：优先用 GM_setValue 传递待填公司名（跨域名共享，且不进 URL / 浏览器历史）
            let ok = false;
            try {
                GM_setValue(PENDING_KEY, JSON.stringify({ name: acc.name, ts: Date.now() }));
                ok = true;
            } catch (e) { }
            Utils.toast(`正在跳转 ${SITE_LABEL[acc.site] || acc.site} 登录页...`, '#faad14');
            // GM 写不进去时退回 URL 参数兜底
            window.location.href = ok ? target : withAutofill(target, acc.name);
            return;
        }
        fillAndSubmit(acc);
    }

    function withAutofill(url, name) {
        const i = url.indexOf('#');
        const param = '?autofill=' + encodeURIComponent(name);
        return i === -1 ? url + param : url.slice(0, i) + param + url.slice(i);
    }

    // 读取并消费跨站待填标记（2 分钟内有效）
    function consumePending() {
        // 1) 本地存储标记（跨域名共享，不进 URL）
        try {
            const raw = GM_getValue(PENDING_KEY, '');
            if (raw) {
                GM_deleteValue(PENDING_KEY);
                const o = JSON.parse(raw);
                if (o && o.name && Date.now() - (o.ts || 0) <= 120000) return o.name;
            }
        } catch (e) { /* 落到 URL 兜底 */ }

        // 2) 兜底：URL 参数（老行为），读完立刻从地址栏擦掉
        try {
            const u = new URL(window.location.href);
            const name = u.searchParams.get('autofill');
            if (name) {
                u.searchParams.delete('autofill');
                history.replaceState(null, '', u.pathname + u.search + u.hash);
                return name;
            }
        } catch (e) { /* 忽略 */ }
        return null;
    }

    /* ===================== 批量解析 / 合并 ===================== */
    function normSite(s) {
        const v = String(s || '').trim().toLowerCase();
        if (!v) return 'shenzhen';
        if (v.indexOf('zhejiang') >= 0 || v.indexOf('浙江') >= 0 || v === 'zj' || v === 'z') return 'zhejiang';
        return 'shenzhen';
    }

    // 支持两种粘贴格式：
    //   1) JSON 数组  [{ "name":"京东","site":"shenzhen","taxId":"...","phone":"...","password":"..." }]
    //   2) 每行一条   公司名 纳税人识别号 手机号 密码 深圳|浙江
    function parseBulk(text) {
        const t = String(text || '').trim();
        if (!t) throw new Error('内容为空');
        if (t.charAt(0) === '[') {
            let arr;
            try { arr = JSON.parse(t); } catch (e) { throw new Error('JSON 格式不对：' + e.message); }
            if (!Array.isArray(arr)) throw new Error('JSON 顶层必须是数组 [ ... ]');
            return arr.map(x => ({
                name: String(x.name || x.公司简称 || x.企业名 || x.公司 || '').trim(),
                site: normSite(x.site || x.归属城市 || x.城市 || x.站点),
                taxId: String(x.taxId || x.taxid || x.税号 || x.纳税人识别号 || '').trim(),
                phone: String(x.phone || x.手机号 || x.电话 || '').trim(),
                password: String(x.password || x.pwd || x.密码 || '')
            })).filter(x => x.name && x.taxId && x.password);
        }
        return t.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(line => {
            let p;
            if (line.indexOf('\t') >= 0) p = line.split('\t');
            else if (line.indexOf(',') >= 0) p = line.split(',');
            else if (line.indexOf('，') >= 0) p = line.split('，');
            else if (line.indexOf('|') >= 0) p = line.split('|');
            else p = line.split(/\s+/);
            p = p.map(s => String(s).trim()).filter(Boolean);
            return { name: p[0] || '', taxId: p[1] || '', phone: p[2] || '', password: p[3] || '', site: normSite(p[4]) };
        }).filter(x => x.name && x.taxId && x.password);
    }

    // 合并进本机账号：同名覆盖，其余追加
    function mergeAccounts(list) {
        const cur = loadAccounts();
        let added = 0, updated = 0;
        list.forEach(a => {
            const i = cur.findIndex(x => x.name === a.name);
            if (i >= 0) { cur[i] = a; updated++; } else { cur.push(a); added++; }
        });
        saveAccounts(cur);
        return { added: added, updated: updated, total: cur.length };
    }

    /* ===================== 添加/编辑公司 弹窗 ===================== */
    // 字段：公司简称 name / 归属城市 site / 税号 taxId / 电话 phone / 密码 password
    // 按钮：继续添加（保存并清空接着填）/ 取消 / 确定（保存并关闭）
    // 底部「📥 批量导入」：粘贴 JSON 数组或每行一条，一次性灌进去
    function openAccountDialog(onChange) {
        const old = document.getElementById('sz-acc-dialog');
        if (old) old.remove();

        const mask = document.createElement('div');
        mask.id = 'sz-acc-dialog';
        mask.style.cssText = 'position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,.45);'
            + 'display:flex; align-items:center; justify-content:center; font:14px/1.6 -apple-system,"Microsoft YaHei",sans-serif; color:#303133;';

        mask.innerHTML = `
<div style="width:min(420px,94vw); background:#fff; border-radius:10px; box-shadow:0 12px 40px rgba(0,0,0,.28); padding:18px 20px 16px;">
  <div style="font-weight:700; font-size:15px; margin-bottom:4px;">🏢 添加公司</div>
  <div id="sz-acc-tip" style="color:#909399; font-size:12px; margin-bottom:12px;">
    数据只保存在本机浏览器，不会上传到任何服务器，也不会写进脚本源码。
  </div>
  <label style="display:block; font-size:12px; color:#606266; margin-bottom:4px;">公司简称</label>
  <input id="sz-f-name" autocomplete="off" placeholder="如：京东"
    style="${inputCss}">
  <label style="display:block; font-size:12px; color:#606266; margin:10px 0 4px;">归属城市</label>
  <select id="sz-f-site" style="${inputCss}">
    <option value="shenzhen">深圳</option>
    <option value="zhejiang">浙江</option>
  </select>
  <label style="display:block; font-size:12px; color:#606266; margin:10px 0 4px;">纳税人识别号</label>
  <input id="sz-f-taxid" autocomplete="off" placeholder="18 位统一社会信用代码"
    style="${inputCss}">
  <label style="display:block; font-size:12px; color:#606266; margin:10px 0 4px;">手机号</label>
  <input id="sz-f-phone" autocomplete="off" placeholder="登录手机号"
    style="${inputCss}">
  <label style="display:block; font-size:12px; color:#606266; margin:10px 0 4px;">
    密码
    <label style="float:right; font-weight:400; color:#909399; cursor:pointer;">
      <input id="sz-f-show" type="checkbox"> 显示
    </label>
  </label>
  <input id="sz-f-pwd" type="password" autocomplete="off" placeholder="登录密码"
    style="${inputCss}">
  <div id="sz-acc-msg" style="min-height:18px; font-size:12px; color:#e6a23c; margin-top:8px;"></div>
  <div id="sz-acc-bulk-toggle" data-act="bulk-toggle"
    style="font-size:12px; color:#1890ff; cursor:pointer; margin-top:4px; user-select:none;">📥 批量导入（粘贴 JSON / 每行一条）</div>
  <div id="sz-acc-bulk" style="display:none; margin-top:8px;">
    <textarea id="sz-f-bulk" spellcheck="false"
      placeholder='[{"name":"公司名","site":"shenzhen","taxId":"9144...","phone":"138...","password":"..."}]'
      style="width:100%; height:150px; box-sizing:border-box; font:12px/1.5 Consolas,monospace; padding:8px; border:1px solid #dcdfe6; border-radius:6px; resize:vertical;"></textarea>
    <div style="margin-top:6px; text-align:right;">
      <button data-act="import" style="${btnCss}">导入（同名覆盖）</button>
    </div>
  </div>
  <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:10px; flex-wrap:wrap;">
    <button data-act="more"  style="${btnCss}">继续添加</button>
    <button data-act="cancel" style="${btnCss}">取消</button>
    <button data-act="ok"    style="${btnCss}; background:#1890ff; color:#fff; border-color:#1890ff;">确定</button>
  </div>
</div>`;

        document.body.appendChild(mask);

        const $ = (id) => mask.querySelector('#' + id);
        const fName = $('sz-f-name'), fSite = $('sz-f-site'), fTax = $('sz-f-taxid'),
            fPhone = $('sz-f-phone'), fPwd = $('sz-f-pwd'), fShow = $('sz-f-show'),
            msg = $('sz-acc-msg'), bulkBox = $('sz-acc-bulk'), bulkToggle = $('sz-acc-bulk-toggle'),
            fBulk = $('sz-f-bulk');

        fShow.onchange = () => { fPwd.type = fShow.checked ? 'text' : 'password'; };
        mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });

        setTimeout(() => fName.focus(), 50);

        function readForm() {
            return {
                name: fName.value.trim(),
                site: fSite.value,
                taxId: fTax.value.trim(),
                phone: fPhone.value.trim(),
                password: fPwd.value
            };
        }
        function resetForm(keepSite) {
            fName.value = ''; fTax.value = ''; fPhone.value = ''; fPwd.value = '';
            if (!keepSite) fSite.value = 'shenzhen';
            fName.focus();
        }
        function commit() {
            const acc = readForm();
            if (!acc.name || !acc.taxId || !acc.phone || !acc.password) {
                msg.textContent = '⚠️ 公司简称 / 税号 / 手机号 / 密码 都不能为空';
                return null;
            }
            mergeAccounts([acc]);
            if (typeof onChange === 'function') onChange();
            return acc;
        }

        mask.addEventListener('click', (e) => {
            const act = e.target && e.target.dataset ? e.target.dataset.act : null;
            if (!act) return;
            if (act === 'bulk-toggle') {
                const show = bulkBox.style.display === 'none';
                bulkBox.style.display = show ? 'block' : 'none';
                bulkToggle.textContent = show ? '📥 收起批量导入' : '📥 批量导入（粘贴 JSON / 每行一条）';
                if (show) { msg.textContent = ''; setTimeout(() => fBulk.focus(), 30); }
                return;
            }
            if (act === 'import') {
                try {
                    const list = parseBulk(fBulk.value);
                    if (!list.length) throw new Error('没解析出有效条目，请检查格式');
                    const r = mergeAccounts(list);
                    Utils.toast(`已导入 ${r.added} 家，更新 ${r.updated} 家，共 ${r.total} 家`, '#52c41a', 3200);
                    if (typeof onChange === 'function') onChange();
                    mask.remove();
                } catch (err) {
                    msg.style.color = '#f56c6c';
                    msg.textContent = '导入失败：' + err.message;
                }
                return;
            }
            if (act === 'cancel') { mask.remove(); return; }
            if (act === 'ok') {
                const acc = commit();
                if (!acc) return;
                Utils.toast(`已保存「${acc.name}」`, '#52c41a');
                mask.remove();
                return;
            }
            if (act === 'more') {
                const acc = commit();
                if (!acc) return;
                const n = loadAccounts().length;
                msg.style.color = '#67c23a';
                msg.textContent = `已保存「${acc.name}」，当前共 ${n} 家，继续填下一家 ↓`;
                resetForm(true);
                Utils.toast(`已保存「${acc.name}」，继续添加`, '#52c41a', 1600);
            }
        });
    }

    /* ===================== 主面板 ===================== */
    function buildPanel(container) {
        const accounts = loadAccounts();

        if (!accounts.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:#e6a23c; font-size:12px; padding:6px 0;';
            empty.innerHTML = '还没有配置公司，点下面「➕ 添加公司」';
            container.appendChild(empty);
        }

        accounts.forEach((acc) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; gap:4px; margin-bottom:6px;';

            const btn = document.createElement('button');
            btn.innerText = '📋 ' + acc.name;
            btn.title = `填写 ${acc.name}（${SITE_LABEL[acc.site] || acc.site}）税号/手机号/密码并提交`;
            btn.style.cssText = 'flex:1; min-width:0; padding:7px 10px; background:#1890ff; color:#fff;'
                + 'border:none; border-radius:4px; cursor:pointer; font-size:13px; text-align:left;';
            btn.onclick = () => { closePanel(); login(acc); };
            row.appendChild(btn);

            const del = document.createElement('button');
            del.innerText = '✕';
            del.title = '删除 ' + acc.name;
            del.style.cssText = 'flex:none; width:24px; height:26px; line-height:1; background:#fff; color:#c0c4cc;'
                + 'border:1px solid #dcdfe6; border-radius:4px; cursor:pointer; font-size:12px;';
            del.onmouseenter = () => { del.style.color = '#f5222d'; del.style.borderColor = '#f5222d'; };
            del.onmouseleave = () => { del.style.color = '#c0c4cc'; del.style.borderColor = '#dcdfe6'; };
            del.onclick = () => {
                if (!confirm(`确定删除「${acc.name}」？（只删除本机保存的记录）`)) return;
                saveAccounts(loadAccounts().filter(a => a.name !== acc.name));
                Utils.toast(`已删除「${acc.name}」`, '#52c41a');
                renderPanel();
            };
            row.appendChild(del);

            container.appendChild(row);
        });

        const addBtn = document.createElement('button');
        addBtn.innerText = '➕ 添加公司';
        addBtn.style.cssText = 'display:block; width:100%; padding:7px 10px; margin-top:4px; background:#fff;'
            + 'color:#1890ff; border:1px dashed #1890ff; border-radius:4px; cursor:pointer; font-size:13px;';
        addBtn.onclick = () => openAccountDialog(renderPanel);
        container.appendChild(addBtn);

        const tip = document.createElement('div');
        tip.style.cssText = 'margin-top:10px; padding-top:8px; border-top:1px solid #eee; color:#888; font-size:12px; line-height:1.5;';
        tip.innerHTML = '点公司名 = 自动填表并提交<br>验证码仍需手动点选';
        container.appendChild(tip);
    }

    function renderPanel() {
        const panel = document.getElementById('sz-tax-panel');
        if (!panel) return;
        panel.innerHTML = '';
        const title = document.createElement('div');
        title.innerText = '📋 一键填表登录';
        title.style.cssText = 'font-weight:bold; margin-bottom:8px; padding-bottom:8px; border-bottom:1px solid #eee; font-size:14px;';
        panel.appendChild(title);
        buildPanel(panel);
    }

    function createPanel() {
        const existing = document.getElementById('sz-tax-panel');
        if (existing) { existing.remove(); return; }

        const panel = document.createElement('div');
        panel.id = 'sz-tax-panel';
        panel.style.cssText = 'position:fixed; top:130px; right:20px; z-index:99999; background:#fff;'
            + 'border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.15); padding:14px; min-width:220px;'
            + 'max-height:76vh; overflow-y:auto; font-size:13px; font-family:-apple-system,"Microsoft YaHei",sans-serif;';

        const title = document.createElement('div');
        title.innerText = '📋 一键填表登录';
        title.style.cssText = 'font-weight:bold; margin-bottom:8px; padding-bottom:8px; border-bottom:1px solid #eee; font-size:14px;';
        panel.appendChild(title);

        buildPanel(panel);
        document.body.appendChild(panel);
    }

    function closePanel() {
        const p = document.getElementById('sz-tax-panel');
        if (p) p.remove();
    }

    function injectEntryButton() {
        if (document.getElementById('sz-login-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'sz-login-btn';
        btn.innerText = '📋 一键填表';
        btn.style.cssText = 'position:fixed; top:130px; right:20px; z-index:99999; padding:10px 20px;'
            + 'background:#52c41a; color:white; border:none; border-radius:4px; cursor:pointer;'
            + 'font-weight:bold; box-shadow:0 4px 10px rgba(0,0,0,0.2);';
        btn.onclick = createPanel;
        document.body.appendChild(btn);
    }

    /* ===================== 入口 ===================== */
    GM_registerMenuCommand('➕ 添加公司', () => openAccountDialog(renderPanel));

    function onReady() {
        // 1) 跨站跳转过来的自动填表
        const pending = consumePending();
        if (pending) {
            const acc = loadAccounts().find(a => a.name === pending);
            if (acc) {
                waitForLoginForm().then(ok => { if (ok) fillAndSubmit(acc); });
                return;
            }
        }

        // 只在 tpass 登录页生效
        if (!isTpass()) return;

        // 2) 首次加载：还没配过公司 -> 弹窗引导填写
        if (!isInitialized()) {
            saveAccounts([]); // 标记已初始化，避免每次刷新都弹
            waitForLoginForm().then(ok => { if (ok) injectEntryButton(); });
            openAccountDialog(() => { renderPanel(); injectEntryButton(); });
            return;
        }

        // 3) 常规入口
        waitForLoginForm().then(ok => { if (ok) injectEntryButton(); });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
    window.addEventListener('load', () => { if (!document.getElementById('sz-login-btn')) onReady(); });

})();
