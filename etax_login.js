// ==UserScript==
// @name         深圳/浙江税务-一键填表登录（代账版）
// @namespace    http://tampermonkey.net/
// @version      16.5
// @license      MIT
// @description  电子税务局 tpass 登录页一键填写（税号/手机号/密码）并提交。支持上百家企业：搜索/简拼、双击快捷键、在线授权、名单备份还原。账号只存本机浏览器，验证码仍需人工点选。
// @match        https://tpass.shenzhen.chinatax.gov.cn:8443/*
// @match        https://tpass.zhejiang.chinatax.gov.cn:8443/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @downloadURL  https://pan.zhuyongfu.cn/raw/code/etax_login.js
// @updateURL    https://pan.zhuyongfu.cn/raw/code/etax_login.js
// ==/UserScript==

(function () {
    'use strict';

    /* ===================== 配置 ===================== */
    // 面板标题栏显示这个版本；发布新版本时同步改脚本头 @version（smoke 会校验两者一致）
    const VERSION = '16.5';
    const STORE_KEY = 'etax_accounts_v1';             // 公司名单（GM_setValue）
    const PENDING_KEY = 'etax_pending_autofill';      // 跨站跳转待填标记
    const SNAP_KEY = 'etax_accounts_snapshots_v1';    // 写库前自动快照
    const LICENSE_KEY = 'sz_login_license_v1';        // 授权记录（与导出助手隔离）
    const DEVK = 'sz_dev_id';                         // 设备号（与导出助手共用，值一致）

    const AUTH_URL = 'https://etax.zhuyongfu.cn';
    const GUIDE_URL = 'https://etax.zhuyongfu.cn/login';
    const CODE_RE = /^ETL-[0-9A-Z]{4}-[0-9A-Z]{4}$/; // 本产品独立短码号段
    const TOKEN_HDRS = ['ETL2', 'ETL1'];              // 服务端返回 token 的头（兼容两种）
    const PLANS = { trial: 1, login: 1, agency: 1 };  // agency 为后台只发该档时兜底
    const PUB = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE4Orws9ePBy2NU7lqwFN2h5PLFvSMAifVhLXg/asVUA2FG0u3czN/dY+iOtRtVJrL3/DFdNTbX4mCQAVkIRlyFg==';

    const FREE_CAP = 3;                               // 未授权可用前 3 家
    const TRIAL_DAYS = 3;                             // 设为 0 则装好即 3 家
    const PULL_GAP = 6 * 3600 * 1000;                 // 续期拉取间隔
    const NET_TIMEOUT = 8000;
    const DOUBLE_GAP = 350;                           // 双击按键判定窗口

    /* 代账版：点公司后先切到「代理业务」再填表。开关存 GM，可在脚本菜单切换 */
    const AGENCY_KEY = 'etax_agency_tab_v1';
    const AGENCY_LABEL = '代理业务';
    const AGENCY_WAIT = 4000;                         // 等 Vue 重绘表单的最长时间

    const CONFIG = {
        sites: {
            shenzhen: 'https://tpass.shenzhen.chinatax.gov.cn:8443/#/login?redirect_uri=https%3A%2F%2Fetax.shenzhen.chinatax.gov.cn%3A8443%2Fmhzx%2Fapi%2Fmh%2Ftpass%2Fcode&client_id=b5492bba3b4e4f37b977c354a2b26a59&response_type=code&state=f407e89320184a86a2a638ce35c70848&client_pid=b5492bba3b4e4f37b977c354a2b26a59',
            zhejiang: 'https://tpass.zhejiang.chinatax.gov.cn:8443/#/login?redirect_uri=https%3A%2F%2Fetax.zhejiang.chinatax.gov.cn%3A8443%2Fmhzx%2Fapi%2Fmh%2Ftpass%2Fcode&client_id=tct8zta97w6c46zdt9zc2648227df5z2&response_type=code&state=c816f6aebc074f789f9f09a1202efccc'
        },
        accounts: []   // 发布版必须留空
    };
    const SITE_LABEL = { shenzhen: '深圳', zhejiang: '浙江' };

    /* 页面 realm：带 @grant 时脚本在沙箱，事件构造器 / localStorage / fetch 都要取页面的 */
    const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    const PageEvent = PAGE.Event || Event;
    const PageMouseEvent = PAGE.MouseEvent || MouseEvent;
    const PageInputEvent = PAGE.InputEvent || PageEvent;
    const PLS = (() => { try { return PAGE.localStorage || null; } catch (e) { return null; } })();
    const NetFetch = (() => {
        try { return PAGE.fetch ? PAGE.fetch.bind(PAGE) : fetch.bind(window); }
        catch (e) { return fetch.bind(window); }
    })();
    const Subtle = (() => {
        try { return (PAGE.crypto && PAGE.crypto.subtle) || crypto.subtle; }
        catch (e) { return crypto.subtle; }
    })();
    const BlobCtor = (() => { try { return PAGE.Blob || Blob; } catch (e) { return Blob; } })();

    /* ===================== 通用工具 ===================== */
    const Utils = {
        sleep: (ms) => new Promise(r => setTimeout(r, ms)),
        isVisible: (el) => {
            if (!el) return false;
            const st = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0;
        },
        toast: (msg, color = '#1890ff', ms = 2600) => {
            let el = document.getElementById('sz-toast');
            if (!el) {
                el = document.createElement('div');
                el.id = 'sz-toast';
                el.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483646;'
                    + 'background:#333;color:#fff;padding:8px 20px;border-radius:0 0 8px 8px;font-size:14px;'
                    + 'box-shadow:0 2px 10px rgba(0,0,0,.3);max-width:80vw;';
                (document.body || document.documentElement).appendChild(el);
            }
            el.textContent = msg;              // 公司名来自用户输入，禁止 innerHTML
            el.style.backgroundColor = color;
            if (ms) setTimeout(() => { if (el) el.remove(); }, ms);
        },
        pulseEntry: () => {
            const b = document.getElementById('sz-login-btn');
            if (!b) return;
            b.classList.remove('pulse');
            void b.offsetWidth;
            b.classList.add('pulse');
            setTimeout(() => b.classList.remove('pulse'), 500);
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
            el.dispatchEvent(new PageMouseEvent('click', opts));   // 只派发一次
        }
    };

    /* ===================== 站点 / 登录表单（保留 v15.4 逻辑） ===================== */
    function currentSite() {
        const h = location.hostname;
        return Object.keys(CONFIG.sites).find(k => h.includes(k)) || null;
    }
    function isTpass() { return location.hostname.indexOf('tpass.') === 0; }

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
            Utils.toast('❌ 未找到登录表单', '#f5222d', 3000); return;
        }
        function fillField(el, value) {
            el.value = value;
            let ev;
            try { ev = new PageInputEvent('input', { bubbles: true, cancelable: true, data: value }); }
            catch (e) { ev = new PageEvent('input', { bubbles: true, cancelable: true }); }
            el.dispatchEvent(ev);
            el.dispatchEvent(new PageEvent('change', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new PageEvent('blur', { bubbles: true, cancelable: true }));
            const parent = el.parentElement;
            if (parent && parent.classList.contains('el-input')) parent.classList.remove('is-error');
        }
        fillField(taxInput, acc.taxId);
        fillField(phoneInput, acc.phone);
        fillField(pwdInput, acc.password);
        Utils.toast('已填写: ' + acc.name, '#52c41a');
        await Utils.sleep(500);
        const ok = await waitClickable(loginBtn);
        if (!ok) Utils.toast('⚠️ 登录按钮还是禁用状态，可能表单校验没过', '#faad14', 4000);
        Actions.clickStandard(loginBtn);
        Utils.toast('已点击登录，请手动完成验证码点选', '#faad14', 6000);
    }

    /* ===================== 代理业务 tab（代账版） ===================== */
    /* 实测：深圳 tpass 登录页是 Vue 的 .tabsCls span 三标签（企业业务/自然人业务/代理业务），
     * 点「代理业务」后整个 <form> 会被换掉（DOM 节点不是同一个），但
     * .el-autocomplete / .mobileInp / .pwdInp 三个选择器仍命中，登录按钮文本仍是「登录」。
     * 所以：必须先切、再等新表单出现、最后才 getLoginForm() 取值填充。 */
    function agencyEnabled() {
        try { return GM_getValue(AGENCY_KEY, 1) !== 0; } catch (e) { return true; }
    }
    function findAgencyTab() {
        const all = document.querySelectorAll('.tabsCls span');
        for (let i = 0; i < all.length; i++) {
            if ((all[i].textContent || '').trim() === AGENCY_LABEL) return all[i];
        }
        return null;
    }
    function agencyIsActive() {
        const t = findAgencyTab();
        return !!(t && t.classList && t.classList.contains('activeCls'));
    }
    /** @returns {'off'|'absent'|'already'|'switched'|'timeout'} */
    async function ensureAgencyTab(timeout) {
        if (!agencyEnabled()) return 'off';
        const tab = findAgencyTab();
        if (!tab) return 'absent';                    // 该站点没有这个 tab（如浙江），照常填
        if (agencyIsActive()) return 'already';
        const before = document.querySelector('.pwdInp > .el-input__inner');
        tab.click();                                  // Vue 监听 click；实测 el.click() 可触发
        const start = Date.now(), limit = timeout || AGENCY_WAIT;
        while (Date.now() - start < limit) {
            const tax = document.querySelector('.el-autocomplete .el-input__inner');
            const pwd = document.querySelector('.pwdInp > .el-input__inner');
            // 三重判据：标签已激活 + 表单节点已替换 + 第一个框文案变成「代理机构…」
            if (agencyIsActive() && tax && pwd && pwd !== before && /代理机构/.test(tax.placeholder || '')) {
                return 'switched';
            }
            await Utils.sleep(100);
        }
        return 'timeout';
    }
    async function loginWithAgency(acc) {
        const r = await ensureAgencyTab();
        if (r === 'timeout') {
            // 没切成功绝不填：否则会把客户资料填进「企业业务」表单并提交，等于点错登录方式
            Utils.toast('⚠️ 没能切到「代理业务」，已取消填表，请手动点一下该标签再试', '#f5222d', 5000);
            return;
        }
        await fillAndSubmit(acc);
    }

    function login(acc) {
        if (!canUse(acc)) { Utils.toast('未激活：仅名单最前 ' + FREE_CAP + ' 家可用', '#faad14', 3200); return; }
        const target = CONFIG.sites[acc.site];
        if (!target) { Utils.toast('❌ 未配置站点: ' + acc.site, '#f5222d', 3000); return; }
        if (currentSite() !== acc.site || !isTpass()) {
            let ok = false;
            try { GM_setValue(PENDING_KEY, JSON.stringify({ name: acc.name, ts: Date.now() })); ok = true; }
            catch (e) { }
            Utils.toast('正在跳转 ' + (SITE_LABEL[acc.site] || acc.site) + ' 登录页...', '#faad14');
            window.location.href = ok ? target : withAutofill(target, acc.name);
            return;
        }
        loginWithAgency(acc);
    }
    function withAutofill(url, name) {
        const i = url.indexOf('#');
        const param = '?autofill=' + encodeURIComponent(name);
        return i === -1 ? url + param : url.slice(0, i) + param + url.slice(i);
    }
    function consumePending() {
        try {
            const raw = GM_getValue(PENDING_KEY, '');
            if (raw) {
                GM_deleteValue(PENDING_KEY);
                const o = JSON.parse(raw);
                if (o && o.name && Date.now() - (o.ts || 0) <= 120000) return o.name;
            }
        } catch (e) { }
        try {
            const u = new URL(window.location.href);
            const name = u.searchParams.get('autofill');
            if (name) {
                u.searchParams.delete('autofill');
                history.replaceState(null, '', u.pathname + u.search + u.hash);
                return name;
            }
        } catch (e) { }
        return null;
    }

    /* ===================== 名单存取 / 备份 / 导入 ===================== */
    function loadAccounts() {
        try { const v = GM_getValue(STORE_KEY, null); if (Array.isArray(v)) return v; }
        catch (e) { }
        return CONFIG.accounts || [];
    }
    function saveAccounts(list) {
        try {
            const cur = loadAccounts();
            if (JSON.stringify(cur) !== JSON.stringify(list)) {
                const snaps = GM_getValue(SNAP_KEY, []) || [];
                snaps.unshift({ at: Date.now(), accounts: cur });
                GM_setValue(SNAP_KEY, snaps.slice(0, 5));
            }
        } catch (e) { }
        try { GM_setValue(STORE_KEY, list); } catch (e) { }
    }
    function isInitialized() {
        try { return GM_getValue(STORE_KEY, null) !== null; } catch (e) { return true; }
    }
    function restoreLast() {
        try {
            const snaps = GM_getValue(SNAP_KEY, []) || [];
            if (!snaps.length) { Utils.toast('没有可恢复的快照', '#faad14'); return; }
            const cur = loadAccounts();
            GM_setValue(STORE_KEY, snaps[0].accounts);   // 直接写，避免自动生成新快照
            GM_setValue(SNAP_KEY, [{ at: Date.now(), accounts: cur }].concat(snaps.slice(1)).slice(0, 5));
            refreshAll();
            Utils.toast('已恢复上一版名单（再点一次可回到恢复前）', '#52c41a');
        } catch (e) { Utils.toast('恢复失败：' + e.message, '#f5222d'); }
    }

    // 导入模板：JSON 数组（推荐）；或每行一条 Tab 分隔，列序固定、不带表头
    const TEMPLATE_JSON = JSON.stringify([
        {
            name: '深圳市华兴科技有限公司', site: 'shenzhen', taxId: '91440300XXXXXXXXXX',
            phone: '13800138000', password: '登录密码', alias: '华兴科技', code: 'A001', tags: ['福田']
        },
        {
            name: '元创云际（浙江）贸易有限公司', site: 'zhejiang', taxId: '91330100XXXXXXXXXX',
            phone: '13900139000', password: '登录密码', alias: '', code: 'A002', tags: []
        }
    ], null, 2);

    // 未知站点不再静默兜底为深圳，返回 null 由导入流程汇总弹窗提示
    function normSite(s) {
        const v = String(s || '').trim().toLowerCase();
        if (!v) return 'shenzhen';
        if (v.indexOf('zhejiang') >= 0 || v.indexOf('浙江') >= 0 || v === 'zj' || v === 'z') return 'zhejiang';
        if (v.indexOf('shenzhen') >= 0 || v.indexOf('深圳') >= 0 || v === 'sz' || v === 's') return 'shenzhen';
        return null;
    }
    function splitLine(line) {
        let p;
        if (line.indexOf('\t') >= 0) p = line.split('\t');
        else if (line.indexOf(',') >= 0) p = line.split(',');
        else if (line.indexOf('，') >= 0) p = line.split('，');
        else if (line.indexOf('|') >= 0) p = line.split('|');
        else p = line.split(/\s+/);
        return p.map(x => String(x).trim());
    }
    function parseBulk(text) {
        const t = String(text || '').trim();
        if (!t) throw new Error('内容为空');
        const issues = [], list = [], raw = [];
        if (t.charAt(0) === '[') {
            let arr;
            try { arr = JSON.parse(t); } catch (e) { throw new Error('JSON 格式不对：' + e.message); }
            if (!Array.isArray(arr)) throw new Error('JSON 顶层必须是数组 [ ... ]');
            arr.forEach((o, i) => raw.push({ row: i + 1, o: o || {} }));
        } else {
            t.split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach((line, i) => {
                const p = splitLine(line).filter(Boolean);
                raw.push({ row: i + 1, o: { name: p[0], taxId: p[1], phone: p[2], password: p[3], site: p[4], alias: p[5], code: p[6] } });
            });
        }
        raw.forEach(({ row, o }) => {
            const name = String(o.name || o.公司简称 || o.企业名 || o.公司 || '').trim();
            const siteV = o.site || o.归属城市 || o.城市 || o.站点 || '';
            const taxId = String(o.taxId || o.taxid || o.税号 || o.纳税人识别号 || '').trim();
            const phone = String(o.phone || o.手机号 || o.电话 || '').trim();
            const password = String(o.password || o.pwd || o.密码 || '');
            const site = normSite(siteV);
            if (site === null) { issues.push('第 ' + row + ' 行：站点「' + siteV + '」未识别（应为 shenzhen / 深圳 / zhejiang / 浙江），本行已跳过'); return; }
            if (!name || !taxId || !password) { issues.push('第 ' + row + ' 行：公司名 / 税号 / 密码 有空缺，本行已跳过'); return; }
            list.push({
                name, site, taxId, phone, password,
                alias: String(o.alias || o.简称 || '').trim(),
                code: String(o.code || o.编号 || '').trim(),
                tags: Array.isArray(o.tags) ? o.tags.map(String) : []
            });
        });
        return { list, issues };
    }
    // 同名 / 去噪后短名撞车：概率极低，只汇总提示，不做主键改造
    function findConflicts(list) {
        const issues = [], shortMap = new Map();
        loadAccounts().concat(list).forEach(a => {
            const key = NameIndex.normalize(a.alias || a.name).short;
            if (shortMap.has(key) && shortMap.get(key) !== a.name) {
                issues.push('显示名可能撞车：「' + shortMap.get(key) + '」与「' + a.name + '」都显示为「' + key + '」，建议给其中一家填 alias');
            }
            shortMap.set(key, a.name);
        });
        const names = new Set();
        list.forEach(a => { if (names.has(a.name)) issues.push('导入内容里出现同名：「' + a.name + '」，后者会覆盖前者'); names.add(a.name); });
        return issues;
    }
    function mergeAccounts(list) {
        const cur = loadAccounts();
        let added = 0, updated = 0;
        list.forEach(a => {
            const i = cur.findIndex(x => x.name === a.name);
            if (i >= 0) { cur[i] = a; updated++; } else { cur.push(a); added++; }
        });
        saveAccounts(cur);
        return { added, updated, total: cur.length };
    }

    function exportBackup() {
        const payload = { schema: 2, product: 'etax_login', exportedAt: new Date().toISOString(), accounts: loadAccounts() };
        const blob = new BlobCtor([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'etax-名单-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        Utils.toast('已导出 ' + payload.accounts.length + ' 家（含明文密码，请妥善保管）', '#52c41a', 4000);
    }
    function pickRestoreFile() {
        let inp = document.getElementById('szl-file');
        if (!inp) {
            inp = document.createElement('input');
            inp.id = 'szl-file'; inp.type = 'file'; inp.accept = '.json,application/json';
            inp.style.display = 'none';
            document.body.appendChild(inp);
            inp.addEventListener('change', () => { if (inp.files && inp.files[0]) openRestore(inp.files[0]); inp.value = ''; });
        }
        inp.click();
    }
    function openRestore(file) {
        const RC = (() => { try { return PAGE.FileReader || FileReader; } catch (e) { return FileReader; } })();
        const r = new RC();
        r.onerror = () => Utils.toast('文件读取失败', '#f5222d');
        r.onload = async () => {
            let arr;
            try {
                const o = JSON.parse(String(r.result));
                arr = Array.isArray(o) ? o : o.accounts;
                if (!Array.isArray(arr)) throw new Error('文件里没有公司列表');
            } catch (e) { Utils.toast('还原失败：' + e.message, '#f5222d', 4000); return; }
            const ok = arr.filter(x => x && x.name && x.taxId && x.password);
            const cur = loadAccounts(), curNames = new Set(cur.map(x => x.name));
            let add = 0, upd = 0;
            ok.forEach(x => { if (curNames.has(x.name)) upd++; else add++; });
            const lines = [
                '文件里共 ' + arr.length + ' 条，有效 ' + ok.length + ' 条，跳过 ' + (arr.length - ok.length) + ' 条',
                '相对当前名单：新增 ' + add + ' 家，覆盖 ' + upd + ' 家',
                '当前名单 ' + cur.length + ' 家；还原前会自动存一份快照，可一键回退'
            ];
            const act = await openModal({
                title: '还原名单', lines,
                actions: [
                    { label: '合并（同名覆盖）', value: 'merge', primary: true },
                    { label: '覆盖（清空后导入）', value: 'replace' },
                    { label: '取消', value: 'cancel' }
                ]
            });
            if (act === 'cancel' || act === null) return;
            const next = act === 'replace' ? ok : (() => {
                const c = loadAccounts();
                ok.forEach(a => { const i = c.findIndex(x => x.name === a.name); if (i >= 0) c[i] = a; else c.push(a); });
                return c;
            })();
            saveAccounts(next);
            refreshAll();
            Utils.toast('已还原，共 ' + next.length + ' 家', '#52c41a');
        };
        r.readAsText(file, 'utf-8');
    }

    /* ===================== 名称归一化 / 检索索引 ===================== */
    const COLL = new Intl.Collator('zh-CN');
    // ICU 的 zh-CN 排序即拼音序，用边界字二分反查首字母，零依赖、离线可用
    const BOUND = [['A', '阿'], ['B', '八'], ['C', '擦'], ['D', '搭'], ['E', '蛾'], ['F', '发'], ['G', '噶'],
        ['H', '哈'], ['J', '击'], ['K', '喀'], ['L', '垃'], ['M', '妈'], ['N', '拿'], ['O', '哦'], ['P', '啪'],
        ['Q', '期'], ['R', '然'], ['S', '撒'], ['T', '塌'], ['W', '挖'], ['X', '昔'], ['Y', '压'], ['Z', '匝']];
    const REGION = /^(?:中国|深圳市|深圳|广州市|广州|浙江省|浙江|杭州市|杭州|东莞市|东莞|上海市|上海|北京市|北京)+/;
    const LEGAL = /(?:有限责任公司|股份有限公司|有限公司|有限合伙|合伙企业|分公司|公司)$/;
    const letterCache = new Map();

    const NameIndex = {
        normalize(raw) {
            const full = String(raw || '').trim()
                .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
                .replace(/\s+/g, '');
            const tags = [];
            const core = full.replace(/[（(]([^）)]*)[）)]/g, (_, s) => { tags.push(s); return ''; });
            const short = core.replace(REGION, '').replace(LEGAL, '') || core || full;
            return { full, short, tags };
        },
        letter(ch) {
            if (letterCache.has(ch)) return letterCache.get(ch);
            let v = /[a-z0-9]/i.test(ch) ? ch.toUpperCase() : '';
            if (/[\u4e00-\u9fa5]/.test(ch)) {
                for (const [k, b] of BOUND) { if (COLL.compare(ch, b) >= 0) v = k; else break; }
            }
            letterCache.set(ch, v);
            return v;
        },
        build(accounts) {
            return accounts.map((a, _i) => {
                const n = this.normalize(a.alias || a.name);
                const full = this.normalize(a.name).full;
                const py = Array.from(n.short).map(c => this.letter(c)).join('').toLowerCase();
                const keys = [
                    n.short, py, full,
                    ...n.tags, ...(Array.isArray(a.tags) ? a.tags : []),
                    a.code, String(a.taxId || '').slice(-4), String(a.phone || '').slice(-4)
                ].filter(Boolean).map(x => String(x).toLowerCase());
                return Object.assign({}, a, { _i, short: n.short, full, py, letter: this.letter(n.short[0] || '') || '#', keys });
            });
        }
    };
    function isSubseq(needle, hay) { let i = 0; for (const c of hay) if (c === needle[i]) i++; return i === needle.length; }
    function searchIndex(idx, q, site = 'all') {
        const t = String(q || '').trim().toLowerCase().replace(/\s+/g, '');
        let list = idx.filter(a => site === 'all' || a.site === site);
        if (!t) return list.sort((a, b) => COLL.compare(a.short, b.short));
        return list.map(a => {
            let s = 0;
            a.keys.forEach((k, i) => {
                const w = 100 - Math.min(i, 20);
                if (k === t) s = Math.max(s, w);
                else if (k.startsWith(t)) s = Math.max(s, w - 20);
                else if (k.includes(t)) s = Math.max(s, w - 40);
            });
            if (!s && isSubseq(t, a.py)) s = 10;
            return { a, s };
        }).filter(x => x.s > 0).sort((x, y) => y.s - x.s || COLL.compare(x.a.short, y.a.short)).map(x => x.a);
    }

    /* ===================== 在线授权 ===================== */
    const License = {
        _st: null, _pk: null,
        load() { try { const raw = PLS && PLS.getItem(LICENSE_KEY); const o = raw ? JSON.parse(raw) : null; return (o && typeof o === 'object') ? o : null; } catch (e) { return null; } },
        save(rec) { try { if (PLS) PLS.setItem(LICENSE_KEY, JSON.stringify(rec)); } catch (e) { } },
        b64u(s) {
            const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
            const u = new Uint8Array(b.length);
            for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
            return u;
        },
        pubKey() {
            if (!this._pk) this._pk = Subtle.importKey('spki', this.b64u(PUB), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
            return this._pk;
        },
        async verify(token) {
            const seg = String(token || '').trim().split('.');
            if (seg.length !== 3 || TOKEN_HDRS.indexOf(seg[0]) < 0) return { ok: false, why: '授权凭证格式不对' };
            let p, raw, sig;
            try {
                raw = this.b64u(seg[1]); sig = this.b64u(seg[2]);
                p = JSON.parse(new TextDecoder().decode(raw));
            } catch (e) { return { ok: false, why: '授权凭证读不出来' }; }
            if (sig.length !== 64) return { ok: false, why: '签名长度不对' };
            let good = false;
            try { good = await Subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await this.pubKey(), sig, raw); }
            catch (e) { return { ok: false, why: '本浏览器不支持网页加密验签（需 Chrome 37+ / Edge 79+）' }; }
            if (!good) return { ok: false, why: '授权凭证校验不过' };
            if (p.v !== 1) return { ok: false, why: '授权凭证版本不支持：' + p.v };
            if (!PLANS[p.plan]) return { ok: false, why: '套餐未知：' + p.plan };
            return { ok: true, p };
        },
        // 与导出助手完全一致的 fp 算法，保证同一台电脑 devId 相同
        fp() {
            const n = PAGE.navigator || navigator, s = PAGE.screen || screen;
            const raw = [n.platform, n.hardwareConcurrency, n.language, s.width, s.height, new Date().getTimezoneOffset()].join('|');
            let h = 0;
            for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) & 0x7fffffff;
            return 'f' + h.toString(36);
        },
        devId() {
            try { const v = PLS && PLS.getItem(DEVK); if (v) return v; const f = this.fp(); if (PLS) PLS.setItem(DEVK, f); return f; }
            catch (e) { return this.fp(); }
        },
        devOk(dev) { return !dev || dev === this.devId() || dev === this.fp(); },
        trial() {
            const rec = this.load() || {};
            if (TRIAL_DAYS <= 0) return { iat: 0, exp: 0, tid: '' };
            if (rec.trial && rec.trial.exp) return rec.trial;
            const now = Math.floor(Date.now() / 1000);
            const t = { iat: now, exp: now + TRIAL_DAYS * 86400, tid: 'T' + now.toString(36) + Math.random().toString(36).slice(2, 8) };
            rec.trial = t; this.save(rec); return t;
        },
        _judge(p) {
            const now = Math.floor(Date.now() / 1000);
            if (p.exp !== 0 && now >= p.exp) return { ok: false, plan: p.plan, trial: false, why: '授权已到期（' + this.date(p.exp) + '）' };
            if (!this.devOk(p.dev)) return { ok: false, plan: p.plan, trial: false, why: '这个授权绑在别的设备上（可在落地页自助转移，每月 1 次）' };
            return { ok: true, plan: p.plan, trial: false, exp: p.exp, leftDays: p.exp === 0 ? -1 : Math.ceil((p.exp - now) / 86400) };
        },
        _trial() {
            if (TRIAL_DAYS <= 0) return { ok: false, plan: '', trial: false, why: '未激活：仅名单最前 ' + FREE_CAP + ' 家可用' };
            const t = this.trial(), now = Math.floor(Date.now() / 1000);
            if (now >= t.exp) return { ok: false, plan: 'trial', trial: true, tid: t.tid, why: '试用期已结束，去落地页获取激活码' };
            return { ok: true, plan: 'trial', trial: true, exp: t.exp, tid: t.tid, leftDays: Math.ceil((t.exp - now) / 86400) };
        },
        async refresh() {
            const rec = this.load() || {};
            if (rec.bannedAt) this._st = { ok: false, plan: '', trial: false, why: '授权已被管理员停用，请微信联系客服' };
            else if (rec.tok) {
                const v = await this.verify(rec.tok);
                this._st = v.ok ? this._judge(v.p) : { ok: false, plan: '', trial: false, why: v.why };
            } else this._st = this._trial();
            if (rec.net) LicNet.pull(rec).catch(() => { });
            return this._st;
        },
        async install(code) {
            const c = String(code || '').trim().toUpperCase();
            if (!CODE_RE.test(c)) return { ok: false, why: '授权码格式不对：应为 ETL-XXXX-XXXX（本工具只支持在线码）' };
            const r = await LicNet.redeem(c);
            if (!r.ok) return r;
            const v = await this.verify(r.token);
            if (!v.ok) return { ok: false, why: v.why };
            const st = this._judge(v.p);
            if (!st.ok) return { ok: false, why: st.why };
            const rec = this.load() || {};
            rec.tok = r.token; rec.net = c; delete rec.bannedAt;
            this.save(rec);
            await this.refresh();
            return { ok: true, st: this._st };
        },
        state() { return this._st || { ok: false, plan: '', trial: false, why: '授权状态还没初始化' }; },
        date(ts) { return new Date(ts * 1000).toISOString().slice(0, 10); }
    };

    const LicNet = {
        async post(path, body) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) { } }, NET_TIMEOUT);
            let res = null;
            try {
                res = await NetFetch(AUTH_URL + path, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body || {}), cache: 'no-store', signal: ctrl.signal
                });
            } catch (e) {
                return { ok: false, net: true, why: e && e.name === 'AbortError' ? '连接授权服务器超时，请稍后再试' : '连不上授权服务器，请检查网络' };
            } finally { clearTimeout(timer); }
            let j = null;
            try { j = await res.json(); } catch (e) { }
            if (!j) return { ok: false, net: true, why: '授权服务返回异常（HTTP ' + res.status + '）' };
            if (!res.ok || j.ok === false) return { ok: false, code: j.code, why: j.msg || ('服务器返回 HTTP ' + res.status) };
            return { ok: true, json: j };
        },
        async redeem(code) {
            const r = await this.post('/v1/activate', {
                code, devId: License.devId(), taxId: '',   // 登录页尚无企业身份
                tid: (License.state() || {}).tid || ''
            });
            if (!r.ok) return r;
            const j = r.json || {};
            if (!j.token) return { ok: false, why: '服务器没返回授权凭证，请微信联系客服' };
            return { ok: true, token: String(j.token) };
        },
        async pull(rec) {
            if (!rec || !rec.net) return false;
            const r = await this.post('/v1/refresh', { code: rec.net, devId: License.devId(), taxCount: loadAccounts().length });
            if (!r.ok) {
                if (r.code === 'BANNED') {
                    rec.tok = ''; rec.bannedAt = Date.now(); License.save(rec);
                    License._st = { ok: false, plan: '', trial: false, why: '授权已被管理员停用，请微信联系客服' };
                    refreshAll();
                }
                return false;   // 网络失败不锁死：本地 token 继续用到到期
            }
            const tk = (r.json || {}).token;
            if (!tk) return false;
            const v = await License.verify(String(tk));
            if (!v.ok) return false;
            const last = Number(rec.pulled || 0);
            if (!last || (Date.now() - last) >= PULL_GAP) {
                rec.tok = String(tk); rec.pulled = Date.now(); License.save(rec);
            }
            License._st = License._judge(v.p);
            refreshAll();
            return true;
        }
    };

    function canUse(acc) {
        if (License.state().ok) return true;
        // 门禁按原始名单索引判断，避免搜索排序绕过免费额度；同时避免每行都读一次 GM 存储
        if (typeof acc._i === 'number') return acc._i < FREE_CAP;
        const i = loadAccounts().findIndex(x => x.name === acc.name);
        return i >= 0 && i < FREE_CAP;
    }
    function licenseBrief() {
        const s = License.state();
        if (!s.plan) return { t: '未激活', c: '#a32d2d' };
        if (!s.ok) return { t: s.plan === 'trial' ? '试用结束' : '已过期', c: '#a32d2d' };
        if (s.plan === 'trial') return { t: '试用 剩 ' + s.leftDays + ' 天', c: '#ba7517' };
        return { t: s.leftDays === -1 ? '已激活·永久' : '已激活 ' + s.leftDays + ' 天', c: '#3b6d11' };
    }

    /* ===================== 样式 ===================== */
    const CSS = [
        // 浮层始终避开登录表单：宽度由 fitPanel() 按表单右缘动态计算（上限 300px）
        '#sz-tax-panel{position:fixed;top:72px;right:16px;z-index:99999;width:300px;max-width:calc(100vw - 24px);max-height:min(66vh,480px);display:flex;flex-direction:column;background:rgba(255,255,255,.97);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border:1px solid rgba(148,163,184,.28);border-radius:12px;box-shadow:0 14px 36px rgba(15,23,42,.16),0 2px 8px rgba(15,23,42,.06);font:13px/1.5 "PingFang SC","Microsoft YaHei UI","Source Han Sans SC",sans-serif;color:#1f2937;overflow:hidden}',
        '.szl-hd{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid #eef1f5;flex:none}',
        '.szl-hd b{font-size:13px;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.szl-x{border:0;background:none;cursor:pointer;color:#94a3b8;font-size:15px;line-height:1;width:22px;height:22px;border-radius:5px}',
        // 版本号：排障时报给客服用；user-select:all 方便双击整段选中复制
        '.szl-ver{flex:none;font:10px/1.4 Consolas,Monaco,monospace;color:#94a3b8;background:#f1f5f9;border-radius:4px;padding:1px 5px;user-select:all;cursor:default}',
        '.szl-x:hover{background:#f1f5f9;color:#475569}',
        '.szl-search{margin:8px 12px 6px;flex:none;position:relative}',
        '.szl-search input{width:100%;box-sizing:border-box;padding:7px 26px 7px 28px;border:1px solid #cbd5e1;border-radius:7px;font-size:13px;outline:none;color:#1f2937;background:rgba(255,255,255,.9)}',
        '.szl-search input:focus{border-color:#1d4ed8;box-shadow:0 0 0 3px rgba(29,78,216,.12)}',
        '.szl-ico{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:#94a3b8;pointer-events:none}',
        '.szl-clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);border:0;background:none;color:#94a3b8;cursor:pointer;font-size:13px}',
        '.szl-chips{display:flex;gap:4px;padding:0 12px 6px;flex-wrap:wrap;flex:none;font-size:11px;align-items:center}',
        '.szl-chip{border:1px solid #e2e8f0;background:#fff;color:#64748b;border-radius:999px;padding:2px 8px;cursor:pointer}',
        '.szl-chip.on{background:#eff6ff;border-color:#93c5fd;color:#1d4ed8}.szl-count{margin-left:auto;color:#94a3b8;white-space:nowrap}',
        '.szl-list{flex:1;min-height:60px;overflow-y:auto;padding:0 8px 6px 6px;position:relative;scrollbar-width:thin}',
        '.szl-group{font-size:10px;color:#94a3b8;padding:6px 8px 2px;position:sticky;top:0;background:rgba(255,255,255,.97);z-index:1}',
        '.szl-row{display:flex;align-items:center;gap:4px;padding:1px 4px}',
        // 行不再是实心蓝条：左侧 3px 色条只标站点，hover / 键盘选中才显色
        '.szl-main{flex:1;min-width:0;display:flex;align-items:center;gap:7px;min-height:32px;padding:5px 8px 5px 10px;border:0;border-left:3px solid transparent;border-radius:6px;background:transparent;color:#263244;cursor:pointer;text-align:left;font-size:13px;transition:background .12s ease,color .12s ease}',
        '.szl-main.sz{border-left-color:#2563eb}.szl-main.zj{border-left-color:#0f9d58}',
        '.szl-main:hover,.szl-main:focus-visible{background:#1d4ed8;color:#fff;outline:none}',
        '.szl-main:focus-visible{box-shadow:0 0 0 2px #93c5fd}',
        '.szl-main:disabled{color:#aab4c2;cursor:not-allowed;background:transparent;border-left-color:#d8dee7}',
        '.szl-main:disabled:hover{background:transparent;color:#aab4c2}',
        '.szl-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}',
        '.szl-name mark{background:#fde68a;color:#1f2937;border-radius:2px;padding:0 1px}',
        '.szl-lock{font-size:11px;flex:none;opacity:.55}',
        '.szl-row.is-cursor .szl-main{background:#eff6ff;color:#1d4ed8;box-shadow:inset 0 0 0 1px #bfdbfe}',
        '.szl-row.is-cursor .szl-main:hover{background:#1d4ed8;color:#fff}',
        '.szl-row.is-cursor .szl-main:disabled{background:#f1f5f9;color:#aab4c2;box-shadow:none}',
        '.szl-mini{border:0;background:none;color:#94a3b8;border-radius:5px;width:20px;height:24px;cursor:pointer;flex:none;opacity:0;font-size:12px}',
        '.szl-row:hover .szl-mini,.szl-mini:focus-visible{opacity:1}.szl-mini:hover{color:#ef4444;background:#fee2e2}',
        '.szl-alpha{position:absolute;right:0;top:4px;display:flex;flex-direction:column;gap:0;font-size:9px;color:#94a3b8;background:rgba(255,255,255,.92);border-radius:4px;padding:2px}',
        '.szl-alpha span{cursor:pointer;padding:0 2px}.szl-alpha span:hover{color:#1d4ed8}',
        '.szl-ft{flex:none;border-top:1px solid #eef1f5;padding:7px 10px 8px;background:rgba(248,250,252,.9)}',
        '.szl-acts{display:flex;gap:4px}',
        '.szl-btn{flex:1;border:1px solid #dbe2ea;background:#fff;color:#475569;border-radius:6px;padding:5px 2px;font-size:11px;cursor:pointer;white-space:nowrap}',
        '.szl-btn:hover{border-color:#93c5fd;color:#1d4ed8}.szl-btn.primary{background:#1d4ed8;border-color:#1d4ed8;color:#fff;flex:none;padding:5px 10px}',
        '.szl-lic{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:11px;min-height:18px}',
        '.szl-state{font-weight:600;white-space:nowrap}.szl-state+span{color:#94a3b8;white-space:nowrap}',
        // 授权入口常驻：试用期 / 已激活 / 已过期都能打开输入区
        '.szl-licbtn{margin-left:auto;border:0;background:none;color:#1d4ed8;font-size:11px;cursor:pointer;padding:2px 4px;border-radius:4px;white-space:nowrap}',
        '.szl-licbtn:hover,.szl-licbtn:focus-visible{background:#eff6ff;text-decoration:underline;outline:none}',
        '.szl-tip{color:#8a97a8;font-size:11px;margin-top:5px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.szl-licfrm{display:none;margin-top:6px;padding:8px;background:#fff;border:1px solid #e2e8f0;border-radius:7px}',
        '.szl-licinfo{font-size:10px;color:#64748b;margin-bottom:6px;line-height:1.4}',
        '.szl-licdev{display:flex;align-items:center;gap:6px;font-size:10px;color:#64748b;margin-bottom:6px}',
        '.szl-licdev code{font:11px Consolas,monospace;background:#f1f5f9;padding:1px 5px;border-radius:3px;color:#334155;user-select:all}',
        '.szl-licdev button{border:0;background:none;color:#1d4ed8;font-size:10px;cursor:pointer;padding:0}',
        '.szl-licfrm input{width:100%;box-sizing:border-box;padding:6px 8px;font:12px Consolas,monospace;border:1px solid #cbd5e1;border-radius:6px;outline:none;color:#1f2937;background:#fff}',
        '.szl-licfrm input:focus{border-color:#1d4ed8;box-shadow:0 0 0 3px rgba(29,78,216,.1)}',
        '.szl-licfrm .l{display:flex;gap:8px;margin-top:6px;align-items:center;flex-wrap:wrap}.szl-licfrm .l a{font-size:11px;color:#1d4ed8;text-decoration:none}',
        '.szl-licmsg{font-size:11px;margin-top:5px;line-height:1.4;word-break:break-all}.szl-licmsg.ok{color:#3b6d11}.szl-licmsg.err{color:#a32d2d}',
        '.szl-lichint{font-size:10px;color:#94a3b8;margin-top:5px;line-height:1.4}',
        '.szl-empty{padding:16px 10px;color:#94a3b8;text-align:center;font-size:12px}',
        '.szl-more{display:block;width:100%;border:0;background:none;color:#1d4ed8;font-size:11px;padding:7px;cursor:pointer}',
        '#sz-login-btn.pulse{animation:szlPulse .2s ease-out 2}',
        '@keyframes szlPulse{0%{box-shadow:0 0 0 0 rgba(82,196,26,.7)}100%{box-shadow:0 0 0 12px rgba(82,196,26,0)}}',
        '@media (prefers-reduced-motion:reduce){.szl-main,#sz-login-btn.pulse{transition:none!important;animation:none!important}}',
        '@media (max-width:600px){#sz-tax-panel{left:8px;right:8px;top:auto;bottom:8px;width:auto;max-height:72vh;max-width:none}}'
    ].join('\n');
    function injectStyle() {
        if (document.getElementById('szl-style')) return;
        const s = document.createElement('style');
        s.id = 'szl-style'; s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }

    /* ===================== 通用弹窗（内容一律 textContent） ===================== */
    function openModal(opts) {
        return new Promise(resolve => {
            const old = document.getElementById('szl-modal'); if (old) old.remove();
            const mask = document.createElement('div');
            mask.id = 'szl-modal';
            mask.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font:13px/1.6 -apple-system,"Microsoft YaHei",sans-serif;color:#303133;';
            const box = document.createElement('div');
            box.style.cssText = 'width:min(460px,94vw);max-height:80vh;overflow:auto;background:#fff;border-radius:10px;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.28);';
            const h = document.createElement('div');
            h.textContent = opts.title || '提示';
            h.style.cssText = 'font-weight:600;font-size:15px;margin-bottom:10px;';
            box.appendChild(h);
            (opts.lines || []).forEach(t => {
                const p = document.createElement('div');
                p.textContent = '· ' + t;
                p.style.cssText = 'font-size:12px;color:#606266;margin:4px 0;word-break:break-all;';
                box.appendChild(p);
            });
            const bar = document.createElement('div');
            bar.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap;';
            const done = (v) => { mask.remove(); resolve(v); };
            (opts.actions || [{ label: '知道了', value: 'ok', primary: true }]).forEach(a => {
                const b = document.createElement('button');
                b.textContent = a.label;
                b.style.cssText = 'padding:6px 14px;border-radius:6px;border:1px solid #dcdfe6;background:#fff;cursor:pointer;font-size:13px;color:#606266;'
                    + (a.primary ? 'background:#2563eb;color:#fff;border-color:#2563eb;' : '');
                b.onclick = () => done(a.value);
                bar.appendChild(b);
            });
            box.appendChild(bar);
            mask.appendChild(box);
            mask.addEventListener('click', e => { if (e.target === mask) done(null); });
            document.body.appendChild(mask);
        });
    }

    /* ===================== 添加 / 批量导入弹窗 ===================== */
    const inputCss = 'width:100%;box-sizing:border-box;padding:7px 10px;font-size:13px;border:1px solid #dcdfe6;border-radius:6px;outline:none;background:#fff;color:#303133;';
    const btnCss = 'padding:6px 14px;border-radius:6px;border:1px solid #dcdfe6;background:#fff;cursor:pointer;font-size:13px;color:#606266;';

    function openAccountDialog(openBulk) {
        const old = document.getElementById('sz-acc-dialog'); if (old) old.remove();
        const mask = document.createElement('div');
        mask.id = 'sz-acc-dialog';
        mask.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font:14px/1.6 -apple-system,"Microsoft YaHei",sans-serif;color:#303133;';
        mask.innerHTML = `
<div style="width:min(440px,94vw);max-height:88vh;overflow:auto;background:#fff;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.28);padding:18px 20px 16px;">
  <div style="font-weight:700;font-size:15px;margin-bottom:4px;">🏢 添加公司</div>
  <div style="color:#909399;font-size:12px;margin-bottom:12px;">数据只保存在本机浏览器，不上传服务器，也不写进脚本源码。</div>
  <label style="display:block;font-size:12px;color:#606266;margin-bottom:4px;">公司全称 / 简称</label>
  <input id="sz-f-name" autocomplete="off" placeholder="如：深圳市华兴科技有限公司" style="${inputCss}">
  <div style="display:flex;gap:8px;margin-top:10px;">
    <div style="flex:1;"><label style="display:block;font-size:12px;color:#606266;margin-bottom:4px;">归属城市</label>
      <select id="sz-f-site" style="${inputCss}"><option value="shenzhen">深圳</option><option value="zhejiang">浙江</option></select></div>
    <div style="flex:1;"><label style="display:block;font-size:12px;color:#606266;margin-bottom:4px;">显示简称（选填）</label>
      <input id="sz-f-alias" autocomplete="off" placeholder="留空自动算" style="${inputCss}"></div>
    <div style="flex:1;"><label style="display:block;font-size:12px;color:#606266;margin-bottom:4px;">客户编号（选填）</label>
      <input id="sz-f-code" autocomplete="off" placeholder="如 A001" style="${inputCss}"></div>
  </div>
  <label style="display:block;font-size:12px;color:#606266;margin:10px 0 4px;">纳税人识别号</label>
  <input id="sz-f-taxid" autocomplete="off" placeholder="18 位统一社会信用代码" style="${inputCss}">
  <label style="display:block;font-size:12px;color:#606266;margin:10px 0 4px;">手机号</label>
  <input id="sz-f-phone" autocomplete="off" placeholder="登录手机号" style="${inputCss}">
  <label style="display:block;font-size:12px;color:#606266;margin:10px 0 4px;">密码
    <label style="float:right;font-weight:400;color:#909399;cursor:pointer;"><input id="sz-f-show" type="checkbox"> 显示</label></label>
  <input id="sz-f-pwd" type="password" autocomplete="off" placeholder="登录密码" style="${inputCss}">
  <div id="sz-acc-msg" style="min-height:18px;font-size:12px;color:#e6a23c;margin-top:8px;"></div>
  <div data-act="bulk-toggle" style="font-size:12px;color:#1890ff;cursor:pointer;margin-top:4px;user-select:none;">📥 批量导入 / 查看导入模板</div>
  <div id="sz-acc-bulk" style="display:${openBulk ? 'block' : 'none'};margin-top:8px;">
    <textarea id="sz-f-bulk" spellcheck="false" placeholder="粘贴 JSON 数组；或每行一条 Tab 分隔：name taxId phone password site alias code" style="width:100%;height:150px;box-sizing:border-box;font:12px/1.5 Consolas,monospace;padding:8px;border:1px solid #dcdfe6;border-radius:6px;resize:vertical;"></textarea>
    <div style="margin-top:6px;text-align:right;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
      <button data-act="template" style="${btnCss}">复制导入模板</button>
      <button data-act="file" style="${btnCss}">从文件还原</button>
      <button data-act="import" style="${btnCss}">导入（同名覆盖）</button>
    </div>
  </div>
  <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap;">
    <button data-act="more" style="${btnCss}">继续添加</button>
    <button data-act="cancel" style="${btnCss}">取消</button>
    <button data-act="ok" style="${btnCss};background:#1890ff;color:#fff;border-color:#1890ff;">确定</button>
  </div>
</div>`;
        document.body.appendChild(mask);
        const $ = id => mask.querySelector('#' + id);
        const fName = $('sz-f-name'), fSite = $('sz-f-site'), fAlias = $('sz-f-alias'), fCode = $('sz-f-code'),
            fTax = $('sz-f-taxid'), fPhone = $('sz-f-phone'), fPwd = $('sz-f-pwd'), fShow = $('sz-f-show'),
            msg = $('sz-acc-msg'), bulkBox = $('sz-acc-bulk'), fBulk = $('sz-f-bulk');

        fShow.onchange = () => { fPwd.type = fShow.checked ? 'text' : 'password'; };
        mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
        setTimeout(() => (openBulk ? fBulk : fName).focus(), 50);

        function readForm() {
            return {
                name: fName.value.trim(), site: fSite.value, taxId: fTax.value.trim(),
                phone: fPhone.value.trim(), password: fPwd.value,
                alias: fAlias.value.trim(), code: fCode.value.trim(), tags: []
            };
        }
        function commit() {
            const acc = readForm();
            if (!acc.name || !acc.taxId || !acc.phone || !acc.password) {
                msg.textContent = '⚠️ 公司名 / 税号 / 手机号 / 密码 都不能为空'; return null;
            }
            mergeAccounts([acc]); refreshAll(); return acc;
        }
        mask.addEventListener('click', async e => {
            const act = e.target && e.target.dataset ? e.target.dataset.act : null;
            if (!act) return;
            if (act === 'bulk-toggle') {
                bulkBox.style.display = bulkBox.style.display === 'none' ? 'block' : 'none';
                if (bulkBox.style.display === 'block') fBulk.focus();
                return;
            }
            if (act === 'template') {
                fBulk.value = TEMPLATE_JSON; fBulk.focus(); fBulk.select();
                try { document.execCommand('copy'); Utils.toast('模板已复制（也已填入文本框）', '#52c41a'); }
                catch (err) { Utils.toast('模板已填入文本框，请手动复制', '#52c41a'); }
                return;
            }
            if (act === 'file') { mask.remove(); pickRestoreFile(); return; }
            if (act === 'import') {
                let parsed;
                try { parsed = parseBulk(fBulk.value); }
                catch (err) { msg.style.color = '#f56c6c'; msg.textContent = '导入失败：' + err.message; return; }
                if (!parsed.list.length) { msg.style.color = '#f56c6c'; msg.textContent = '没解析出有效条目'; return; }
                const issues = parsed.issues.concat(findConflicts(parsed.list));
                if (issues.length) {
                    const go = await openModal({
                        title: '导入前请确认', lines: issues.slice(0, 12).concat(issues.length > 12 ? ['……另有 ' + (issues.length - 12) + ' 条'] : []),
                        actions: [{ label: '仍要导入 ' + parsed.list.length + ' 家', value: 'go', primary: true }, { label: '返回修改', value: 'cancel' }]
                    });
                    if (go !== 'go') return;
                }
                const r = mergeAccounts(parsed.list);
                refreshAll();
                Utils.toast('已导入 ' + r.added + ' 家，更新 ' + r.updated + ' 家，共 ' + r.total + ' 家', '#52c41a', 3200);
                mask.remove();
                return;
            }
            if (act === 'cancel') { mask.remove(); return; }
            if (act === 'ok') { const a = commit(); if (!a) return; Utils.toast('已保存「' + a.name + '」', '#52c41a'); mask.remove(); return; }
            if (act === 'more') {
                const a = commit(); if (!a) return;
                fName.value = ''; fTax.value = ''; fPhone.value = ''; fPwd.value = ''; fAlias.value = ''; fCode.value = '';
                msg.style.color = '#3b6d11'; msg.textContent = '已保存「' + a.name + '」，共 ' + loadAccounts().length + ' 家，继续填下一家 ↓';
                fName.focus();
            }
        });
    }

    /* ===================== 主面板 ===================== */
    const UI = { q: '', site: 'all', limit: 30, cursor: -1, visible: [] };
    let IDX = [];

    function refreshAll() {
        IDX = NameIndex.build(loadAccounts());
        if (document.getElementById('sz-tax-panel')) { renderChips(); renderList(); renderFooter(); }
    }
    function highlight(short, q) {
        const frag = document.createDocumentFragment();
        const t = String(q || '').trim();
        const pos = t ? short.indexOf(t) : -1;
        if (pos < 0) { frag.appendChild(document.createTextNode(short)); return frag; }
        frag.appendChild(document.createTextNode(short.slice(0, pos)));
        const m = document.createElement('mark'); m.textContent = short.slice(pos, pos + t.length); frag.appendChild(m);
        frag.appendChild(document.createTextNode(short.slice(pos + t.length)));
        return frag;
    }
    function renderList() {
        const list = document.getElementById('szl-list');
        if (!list) return;
        list.innerHTML = '';
        const all = searchIndex(IDX, UI.q, UI.site);
        UI.visible = all;
        UI.cursor = Math.min(UI.cursor, all.length - 1);
        // 站点 chips 已带数量，计数只在搜索时出现，避免窄面板里挤成两行
        const count = document.getElementById('szl-count');
        if (count) count.textContent = UI.q ? '命中 ' + all.length : '';

        if (!all.length) {
            const e = document.createElement('div');
            e.className = 'szl-empty';
            e.textContent = IDX.length ? '没找到，换个关键词（公司名 / 简拼 / 编号 / 税号后 4 位）' : '还没有公司，点下面「➕ 添加公司」或「📥 批量导入」';
            list.appendChild(e); return;
        }
        const shown = all.slice(0, UI.limit);
        const grouped = !UI.q && IDX.length > 40;
        let lastLetter = '';
        const frag = document.createDocumentFragment();
        shown.forEach((a, i) => {
            if (grouped && a.letter !== lastLetter) {
                lastLetter = a.letter;
                const g = document.createElement('div');
                g.className = 'szl-group'; g.id = 'szl-g-' + a.letter; g.textContent = a.letter;
                frag.appendChild(g);
            }
            const row = document.createElement('div');
            row.className = 'szl-row' + (i === UI.cursor ? ' is-cursor' : '');
            const main = document.createElement('button');
            main.className = 'szl-main ' + (a.site === 'zhejiang' ? 'zj' : 'sz');
            const usable = canUse(a);
            main.disabled = !usable;
            // 全称、站点、完整税号、手机尾号全部放进悬停提示，行内只留公司名
            main.title = a.full + '\n' + (SITE_LABEL[a.site] || a.site)
                + ' · 税号 ' + a.taxId
                + (a.phone ? ' · 手机尾号 ' + String(a.phone).slice(-4) : '')
                + (usable ? '' : '\n未激活：仅名单最前 ' + FREE_CAP + ' 家可用');
            const name = document.createElement('span');
            name.className = 'szl-name'; name.appendChild(highlight(a.short, UI.q)); main.appendChild(name);
            if (!usable) { const lk = document.createElement('span'); lk.className = 'szl-lock'; lk.textContent = '🔒'; main.appendChild(lk); }
            main.onclick = () => { closePanel(); login(a); };
            row.appendChild(main);

            const del = document.createElement('button');
            del.className = 'szl-mini'; del.textContent = '✕'; del.title = '删除 ' + a.name;
            del.onclick = () => {
                if (!confirm('确定删除「' + a.name + '」？（只删除本机保存的记录）')) return;
                saveAccounts(loadAccounts().filter(x => x.name !== a.name));
                refreshAll(); Utils.toast('已删除「' + a.name + '」', '#52c41a');
            };
            row.appendChild(del);
            frag.appendChild(row);
        });
        list.appendChild(frag);

        if (all.length > shown.length) {
            const more = document.createElement('button');
            more.className = 'szl-more'; more.textContent = '显示更多（还有 ' + (all.length - shown.length) + ' 家）';
            more.onclick = () => { UI.limit += 30; renderList(); };
            list.appendChild(more);
        }
        if (grouped) {
            const bar = document.createElement('div'); bar.className = 'szl-alpha';
            Array.from(new Set(all.map(a => a.letter))).forEach(L => {
                const s = document.createElement('span'); s.textContent = L;
                s.onclick = () => { const g = document.getElementById('szl-g-' + L); if (g) g.scrollIntoView({ block: 'start' }); };
                bar.appendChild(s);
            });
            list.appendChild(bar);
        }
    }
    function licenseDetail() {
        const s = License.state();
        if (!s.plan) return '当前：未激活 · 仅名单最前 ' + FREE_CAP + ' 家可用' + (s.why ? '（' + s.why + '）' : '');
        if (s.trial) return s.exp
            ? '当前：试用至 ' + License.date(s.exp) + ' · 激活后不限公司数'
            : '当前：试用期已结束 · 激活后不限公司数';
        return '当前：' + s.plan + ' · ' + (s.leftDays === -1 ? '永久有效' : '到期 ' + License.date(s.exp));
    }
    function licBtnLabel(s, open) {
        if (open) return '收起 ✕';
        return s.ok ? (s.trial ? '输入授权码' : '授权信息 / 续期') : '激活 / 续期';
    }
    function toggleLicenseForm(forceOpen) {
        const f = document.getElementById('szl-licfrm'); if (!f) return;
        const open = typeof forceOpen === 'boolean' ? forceOpen : (f.style.display !== 'block');
        f.style.display = open ? 'block' : 'none';
        // 展开时让面板临时长高，而不是把公司列表压成两三行
        const p = panelEl(); if (p) p.style.maxHeight = open ? 'min(86vh, 640px)' : '';
        const btn = document.getElementById('szl-licbtn');
        if (btn) btn.textContent = licBtnLabel(License.state(), open);
        if (!open) return;
        const dev = document.getElementById('szl-dev'); if (dev) dev.textContent = License.devId();
        const info = document.getElementById('szl-licinfo'); if (info) info.textContent = licenseDetail();
        const inp = document.getElementById('szl-licin'); if (inp) inp.focus();
    }
    function renderFooter() {
        const box = document.getElementById('szl-lic');
        if (!box) return;
        box.innerHTML = '';
        const s = License.state(), b = licenseBrief();
        const st = document.createElement('span');
        st.className = 'szl-state'; st.textContent = b.t; st.style.color = b.c;
        st.title = s.why || ''; box.appendChild(st);
        if (!s.ok) {
            const tip = document.createElement('span');
            tip.textContent = '仅前 ' + FREE_CAP + ' 家可用'; tip.title = s.why || '';
            box.appendChild(tip);
        }
        // 入口永远存在：试用期内可提前激活、已激活可续期换码、过期可重新激活
        const act = document.createElement('button');
        act.id = 'szl-licbtn'; act.className = 'szl-licbtn';
        const frm = document.getElementById('szl-licfrm');
        act.textContent = licBtnLabel(s, !!frm && frm.style.display === 'block');
        act.title = '打开 / 收起授权码输入框';
        act.onclick = () => toggleLicenseForm();
        box.appendChild(act);
    }

    function createPanel() {
        const existing = document.getElementById('sz-tax-panel');
        if (existing) { existing.remove(); return null; }
        injectStyle();
        const p = document.createElement('div'); p.id = 'sz-tax-panel';
        p.innerHTML = `
<div class="szl-hd"><b>📋 一键填表登录</b><span class="szl-ver" id="szl-ver" title="当前版本 v${VERSION} · 反馈问题时请一并告知（双击可选中复制）">v${VERSION}</span><button class="szl-x" id="szl-x" title="关闭（Esc / 双击 P）">✕</button></div>
<div class="szl-search"><span class="szl-ico">⌕</span><input id="szl-q" autocomplete="off" spellcheck="false" title="可搜：公司全称 / 简称 / 拼音简拼 / 客户编号 / 税号或手机号后 4 位" placeholder="公司名 / 简拼 / 编号 / 尾号"><button class="szl-clear" id="szl-clear" title="清空">✕</button></div>
<div class="szl-chips" id="szl-chips"></div>
<div class="szl-list" id="szl-list"></div>
<div class="szl-ft">
  <div class="szl-acts">
    <button class="szl-btn" data-a="add" title="添加一家公司">➕ 添加</button>
    <button class="szl-btn" data-a="bulk" title="批量导入（JSON / 每行一条 Tab 分隔）">📥 导入</button>
    <button class="szl-btn" data-a="export" title="导出备份文件">⬇ 备份</button>
    <button class="szl-btn" data-a="import" title="从备份文件还原（自动存快照）">⬆ 还原</button>
  </div>
  <div class="szl-lic" id="szl-lic"></div>
  <div class="szl-licfrm" id="szl-licfrm">
    <div class="szl-licinfo" id="szl-licinfo"></div>
    <div class="szl-licdev">设备码 <code id="szl-dev"></code><button type="button" id="szl-devcopy">复制</button></div>
    <input id="szl-licin" autocomplete="off" spellcheck="false" placeholder="粘贴 ETL-XXXX-XXXX 授权码">
    <div class="l">
      <button class="szl-btn primary" id="szl-licok">确认激活</button>
      <a href="${GUIDE_URL}" target="_blank" rel="noreferrer">获取授权码 / 购买</a>
    </div>
    <div class="szl-licmsg" id="szl-licmsg"></div>
    <div class="szl-lichint" title="向客服购买 ETL- 开头的授权码；可直接整段粘贴聊天消息，脚本会自动提取其中的授权码。换机 / 重装按落地页流程自助转移（每月 1 次）">ETL- 开头，向客服购买；换机 / 重装按落地页自助转移（每月 1 次）</div>
  </div>
  <div class="szl-tip" title="双击 P 开/关面板 · 双击 S 定位搜索框 · ↑↓ 选择 · Enter 登录 · Esc 关闭；点公司名自动填表并提交，验证码仍需手动点选">双击 P 开关 · 双击 S 搜索 · ↑↓ 选择 · Enter 登录</div>
</div>`;
        document.body.appendChild(p);

        const q = p.querySelector('#szl-q');
        q.value = UI.q;
        q.addEventListener('input', () => { UI.q = q.value; UI.limit = 30; UI.cursor = -1; renderList(); });
        q.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); UI.cursor = Math.min(UI.cursor + 1, UI.visible.length - 1); renderList(); scrollCursor(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); UI.cursor = Math.max(UI.cursor - 1, 0); renderList(); scrollCursor(); }
            else if (e.key === 'Enter') { e.preventDefault(); const a = UI.visible[UI.cursor]; if (a && canUse(a)) { closePanel(); login(a); } }
            else if (e.key === 'Escape') { e.preventDefault(); closePanel(); }
        });
        p.querySelector('#szl-clear').onclick = () => { UI.q = ''; q.value = ''; UI.limit = 30; UI.cursor = -1; renderList(); q.focus(); };
        p.querySelector('#szl-x').onclick = closePanel;

        const chips = p.querySelector('#szl-chips');
        [['all', '全部'], ['shenzhen', '深圳'], ['zhejiang', '浙江']].forEach(([v, label]) => {
            const c = document.createElement('button');
            c.className = 'szl-chip' + (UI.site === v ? ' on' : '');
            c.textContent = label + ' ' + (v === 'all' ? IDX.length : IDX.filter(a => a.site === v).length);
            c.onclick = () => { UI.site = v; UI.limit = 30; UI.cursor = -1; renderChips(); renderList(); };
            chips.appendChild(c);
        });
        const cnt = document.createElement('span'); cnt.id = 'szl-count'; cnt.className = 'szl-count'; chips.appendChild(cnt);

        p.querySelector('.szl-acts').addEventListener('click', e => {
            const a = e.target && e.target.dataset ? e.target.dataset.a : null;
            if (a === 'add') openAccountDialog(false);
            else if (a === 'bulk') openAccountDialog(true);
            else if (a === 'export') exportBackup();
            else if (a === 'import') pickRestoreFile();
            // 「恢复上一版」已移到 Tampermonkey 脚本菜单
        });
        p.querySelector('#szl-devcopy').onclick = () => {
            const v = p.querySelector('#szl-dev').textContent;
            const ta = document.createElement('textarea');
            ta.value = v; ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
            document.body.appendChild(ta); ta.select();
            let copied = false;
            try { copied = document.execCommand('copy'); } catch (e) { }
            ta.remove();
            Utils.toast(copied ? '设备码已复制：' + v : '设备码：' + v, copied ? '#52c41a' : '#faad14', 3000);
        };
        const submitLicense = async () => {
            const btn = p.querySelector('#szl-licok'), msg = p.querySelector('#szl-licmsg');
            const inp = p.querySelector('#szl-licin');
            // 允许整段粘贴客服消息，从中提取 ETL-XXXX-XXXX
            const hit = String(inp.value || '').toUpperCase().match(/ETL-[0-9A-Z]{4}-[0-9A-Z]{4}/);
            if (!hit) {
                msg.className = 'szl-licmsg err';
                msg.textContent = '没找到授权码，应形如 ETL-XXXX-XXXX';
                inp.focus(); return;
            }
            btn.disabled = true; btn.textContent = '校验中…';
            msg.className = 'szl-licmsg'; msg.textContent = '正在连接授权服务器…';
            try {
                const r = await License.install(hit[0]);
                if (r.ok) {
                    inp.value = '';                       // 只有成功才清空，失败保留用户输入
                    msg.className = 'szl-licmsg ok';
                    msg.textContent = '激活成功 · ' + licenseDetail();
                    toggleLicenseForm(false);
                    Utils.toast('授权成功 · ' + licenseDetail(), '#52c41a', 4000);
                    refreshAll();                          // 重绘列表，解除置灰门禁
                    setTimeout(() => { if (msg) msg.textContent = ''; }, 8000);
                } else {
                    msg.className = 'szl-licmsg err';
                    msg.textContent = r.why || '激活失败';
                }
            } catch (e) {
                msg.className = 'szl-licmsg err';
                msg.textContent = '激活出错：' + (e && e.message ? e.message : e);
            } finally { btn.disabled = false; btn.textContent = '确认激活'; }
        };
        p.querySelector('#szl-licok').onclick = submitLicense;
        p.querySelector('#szl-licin').addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); submitLicense(); }
        });
        return p;
    }
    function renderChips() {
        const chips = document.getElementById('szl-chips'); if (!chips) return;
        const defs = [
            ['all', '全部', IDX.length],
            ['shenzhen', '深圳', IDX.filter(a => a.site === 'shenzhen').length],
            ['zhejiang', '浙江', IDX.filter(a => a.site === 'zhejiang').length]
        ];
        Array.from(chips.querySelectorAll('.szl-chip')).forEach((c, i) => {
            const d = defs[i]; if (!d) return;
            c.className = 'szl-chip' + (d[0] === UI.site ? ' on' : '');
            c.textContent = d[1] + ' ' + d[2];
        });
    }
    function scrollCursor() {
        const el = document.querySelector('.szl-row.is-cursor');
        if (el) el.scrollIntoView({ block: 'nearest' });
    }
    function panelEl() { return document.getElementById('sz-tax-panel'); }

    // 取页面登录表单（非面板内）的最右边界，用来算面板可用宽度
    function formRightEdge() {
        let right = 0;
        document.querySelectorAll('input, button').forEach(el => {
            if (el.id === 'sz-login-btn' || el.id === 'szl-file') return;
            if (el.closest && el.closest('#sz-tax-panel')) return;
            const r = el.getBoundingClientRect();
            if (r.width < 120 || r.width > Math.min(window.innerWidth * 0.6, 700)) return;
            if (r.bottom < 0 || r.top > window.innerHeight || r.right > window.innerWidth - 8) return;
            right = Math.max(right, r.right);
        });
        return right;
    }
    // 面板贴右边缘，宽度自动让出登录表单；窄屏交给底部抽屉媒体查询
    function fitPanel(p) {
        if (!p) return;
        // clientWidth 不含滚动条，与 position:fixed 的 right 基准一致（否则会少算 15px 余量）
        const vw = document.documentElement.clientWidth || window.innerWidth;
        if (vw <= 600) { p.style.width = ''; return; }
        const fr = formRightEdge();
        const avail = fr ? (vw - 16 - fr - 24) : (vw - 32);
        p.style.width = Math.max(220, Math.min(300, Math.round(avail))) + 'px';
    }
    function syncEntry() {
        const b = document.getElementById('sz-login-btn');
        if (b) b.style.display = panelEl() ? 'none' : '';
    }
    function openPanel() {
        if (!panelEl()) createPanel();
        fitPanel(panelEl());
        syncEntry();
        refreshAll();
        return panelEl();
    }
    function closePanel() {
        const p = panelEl(); if (!p) return;
        // 只 blur 面板内的焦点，避免触发税局登录框的校验
        const ae = document.activeElement;
        if (ae && p.contains(ae) && ae.blur) ae.blur();
        p.remove();
        syncEntry();
    }
    function togglePanel() { if (panelEl()) closePanel(); else openPanel(); }
    function focusSearch(openIfClosed) {
        if (!panelEl()) { if (!openIfClosed) return; openPanel(); }
        const q = document.getElementById('szl-q');
        if (q) { q.focus(); q.select(); }
    }

    /* ===================== 双击快捷键 ===================== */
    function isEditable(el) {
        if (!el || !el.tagName) return false;
        if (el.isContentEditable) return true;
        const tag = el.tagName.toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select';
    }
    const lastKey = { p: 0, s: 0 };
    function bindHotkeys() {
        document.addEventListener('keydown', e => {
            if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.repeat || e.isComposing || e.keyCode === 229) return;
            const k = String(e.key || '').toLowerCase();
            if (k !== 'p' && k !== 's') return;
            if (isEditable(e.target)) {
                const t = Date.now();
                if (t - lastKey[k] <= DOUBLE_GAP) { lastKey[k] = 0; Utils.pulseEntry(); }
                else lastKey[k] = t;
                return;   // 不拦截，字符正常输入；仅确认是双击时提示一次
            }
            const now = Date.now();
            if (now - lastKey[k] > DOUBLE_GAP) { lastKey[k] = now; return; }
            lastKey[k] = 0;
            e.preventDefault(); e.stopPropagation();
            if (k === 'p') togglePanel(); else focusSearch(true);
        }, true);
    }

    /* ===================== 入口 ===================== */
    function injectEntryButton() {
        if (document.getElementById('sz-login-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'sz-login-btn';
        btn.innerText = '📋 一键填表';
        btn.title = '单击打开；双击 P 开/关，双击 S 定位搜索框';
        btn.style.cssText = 'position:fixed;top:72px;right:16px;z-index:99999;padding:8px 14px;background:#52c41a;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,.18);';
        btn.onclick = () => { if (panelEl()) closePanel(); else openPanel(); };
        document.body.appendChild(btn);
        syncEntry();   // 面板若已打开，入口按钮保持隐藏，避免两层重叠
    }
    let menuReady = false;
    function registerMenus() {
        if (menuReady) return; menuReady = true;
        GM_registerMenuCommand('🔍 搜索公司', () => focusSearch(true));
        GM_registerMenuCommand('➕ 添加公司', () => openAccountDialog(false));
        GM_registerMenuCommand('📥 批量导入', () => openAccountDialog(true));
        GM_registerMenuCommand('⬇ 备份名单', exportBackup);
        GM_registerMenuCommand('⬆ 还原名单', pickRestoreFile);
        // 「恢复上一版」从主面板移入脚本菜单：低频救命功能，不占面板空间
        GM_registerMenuCommand('🕘 恢复上一版名单', restoreLast);
        GM_registerMenuCommand('🔀 代理业务自动切换：开 / 关', () => {
            const on = agencyEnabled() ? 0 : 1;
            try { GM_setValue(AGENCY_KEY, on); } catch (e) { }
            Utils.toast(on ? '已开启：点公司后自动切到「代理业务」再填表'
                : '已关闭：点公司后不再切换登录标签', on ? '#52c41a' : '#faad14', 3200);
        });
    }

    async function onReady() {
        registerMenus();
        injectStyle();
        bindHotkeysOnce();
        // 授权状态必须先就绪：跨站跳转过来的自动填表也会走 canUse 门禁
        try { await License.refresh(); } catch (e) { }
        const pending = consumePending();
        if (pending) {
            const acc = loadAccounts().find(a => a.name === pending);
            if (acc && canUse(acc)) { waitForLoginForm().then(ok => { if (ok) loginWithAgency(acc); }); return; }
        }
        if (!isTpass()) return;
        refreshAll();
        waitForLoginForm().then(ok => { if (ok) injectEntryButton(); });
        if (!isInitialized()) {
            saveAccounts([]);
            openAccountDialog(false);
        }
        if (!window.__szlPullTimer) {
            window.__szlPullTimer = setInterval(() => { License.refresh().then(() => refreshAll()); }, PULL_GAP);
        }
    }
    let hotkeyReady = false;
    function bindHotkeysOnce() {
        if (hotkeyReady) return; hotkeyReady = true;
        bindHotkeys();
        // 点面板外自动收起，把登录表单的位置让出来；弹窗与入口按钮不触发
        document.addEventListener('pointerdown', e => {
            const p = panelEl(); if (!p) return;
            const t = e.target;
            if (p.contains(t)) return;
            if (t && t.closest && t.closest('#sz-login-btn, #szl-modal, #sz-acc-dialog, #szl-file, #sz-toast')) return;
            closePanel();
        }, true);
        window.addEventListener('resize', () => fitPanel(panelEl()));
    }

    // 供页面改版时自诊断（不参与业务逻辑）
    try { PAGE.__szLoginDebug = { version: VERSION, build: (list) => NameIndex.build(list), search: searchIndex, normalize: NameIndex.normalize, parseBulk, normSite, License, LicNet, ensureAgencyTab, agencyEnabled }; }
    catch (e) { }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
    else onReady();
    window.addEventListener('load', () => { if (!document.getElementById('sz-login-btn')) onReady(); });
})();
