/* ==========================================================================
   大肥鱼的QQ机器人服务 — 前端逻辑
   纯 vanilla JS：无框架、无构建、无外部依赖。
   结构：常量 → 工具函数 → API → 状态 → 视图 → 页面 → 事件 → 启动。
   ========================================================================== */
(function () {
  'use strict';

  /* ============================== 常量 ============================== */

  var VERSION = '1.0.0';
  var LOG_REFRESH_MS = 5000;
  var ROUTES = ['connect', 'overview', 'bot', 'persona', 'capabilities', 'models', 'harness', 'plugins', 'logs'];

  var BRIDGE_STATES = {
    online: { label: '在线', tone: 'ok' },
    connecting: { label: '连接中', tone: 'warn' },
    degraded: { label: '降级运行', tone: 'warn' },
    stopped: { label: '已停止', tone: 'danger' },
    disabled: { label: '已关闭', tone: 'muted' },
    unconfigured: { label: '未配置', tone: 'muted' },
    unknown: { label: '未知', tone: 'muted' }
  };

  var GATEWAY_STATES = {
    connected: '已连接',
    connecting: '连接中',
    reconnecting: '重连中',
    stopped: '已停止'
  };

  var LEVELS = ['info', 'warn', 'error', 'raw'];

  /* 与 bridge/lib/runtime.js 的 BASE_DEPLOYMENT_PROMPT 保持一致。 */
  var BASE_DEPLOYMENT_PROMPT = [
    '你正在通过 QQ 官方机器人（QQ 开放平台）与用户对话，你的最终回复会作为一条纯文本 QQ 消息直接发给对方。',
    '因此：只输出要发给用户的正文，不要写旁白式的过程说明，不要用 Markdown 表格、HTML 或超长代码块；内容要简洁、分点清晰。',
    '你可以使用工具完成任务，但工具调用的过程不会展示给 QQ 用户，只有最终回复会发出。'
  ].join('\n');

  /* 与 bridge/lib/runtime.js 的 PERSONA_PRESETS 保持一致。 */
  var PERSONA_PRESETS = [
    {
      id: 'assistant',
      label: '助手',
      persona: {
        name: '小助手',
        role: '一个可靠、务实的通用助理，帮用户查资料、写东西、算数、处理文件。',
        style: '口语化、简洁，先说结论再给理由；不确定时直说不确定。',
        rules: '回答控制在 300 字以内；需要更多细节时主动问用户要不要展开。'
      }
    },
    {
      id: 'engineer',
      label: '严谨工程师',
      persona: {
        name: '工程师',
        role: '一个严谨的软件工程师，擅长排障、读代码、给可执行的步骤。',
        style: '结构化、精确，给命令和代码时用最简形式，不省略关键参数。',
        rules: '涉及破坏性操作前必须先说明后果；给出结论时附上依据。'
      }
    },
    {
      id: 'catgirl',
      label: '温柔猫娘',
      persona: {
        name: '喵酱',
        role: '一只温柔黏人的猫娘助手，喜欢用轻快的语气陪用户聊天、也认真帮忙做事。',
        style: '亲切可爱，句尾偶尔带「喵」，但不要每句都带；技术内容依然要准确。',
        rules: '不因为卖萌而牺牲信息准确性；用户明显在赶时间时切换成简洁模式。'
      }
    },
    {
      id: 'snarky',
      label: '吐槽搭子',
      persona: {
        name: '老铁',
        role: '一个嘴上不饶人但很靠谱的搭子，负责接梗和干活。',
        style: '幽默、直给，可以适度吐槽，但不冒犯、不阴阳怪气。',
        rules: '吐槽归吐槽，最终必须给出有用的答案。'
      }
    },
    { id: 'blank', label: '空模板', persona: { name: null, role: '', style: '', rules: '' } }
  ];

  /* 与 bridge/lib/runtime.js 的 IMAGE_PROVIDER_PRESETS 保持一致。 */
  var IMAGE_PRESETS = {
    siliconflow: { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors' },
    openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1' },
    zhipu: { label: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'cogview-3-flash' },
    custom: { label: '自定义', baseUrl: '', model: '' }
  };

  /* 与 shared/runtime.js 的 MODEL_PROVIDER_PROTOCOLS 保持一致。 */
  var MODEL_PROTOCOLS = [
    { value: 'openai-completions', label: 'openai-completions（OpenAI 兼容）' },
    { value: 'openai-responses', label: 'openai-responses（Responses API）' },
    { value: 'anthropic-messages', label: 'anthropic-messages（Anthropic 协议）' }
  ];

  /* 与 shared/runtime.js 的 ROUTE_PATTERN 保持一致：路由名要能当作 provider id 与凭据名后缀。 */
  var PROVIDER_ROUTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

  /* 「接入其他模型服务商」的一键预设：只填协议与接口地址；路由名留空时才会填入建议值。 */
  var MODEL_PROVIDER_PRESETS = [
    { id: 'zhipu', label: '智谱 GLM', route: 'zhipu', api: 'openai-completions', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
    { id: 'qwen', label: '通义千问', route: 'qwen', api: 'openai-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { id: 'aliyun', label: '阿里云', route: 'aliyun', api: 'openai-completions', baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
    { id: 'moonshot', label: '月之暗面 Kimi', route: 'moonshot', api: 'openai-completions', baseURL: 'https://api.moonshot.cn/v1' },
    { id: 'siliconflow', label: '硅基流动', route: 'siliconflow', api: 'openai-completions', baseURL: 'https://api.siliconflow.cn/v1' },
    { id: 'openai', label: 'OpenAI', route: 'openai', api: 'openai-completions', baseURL: 'https://api.openai.com/v1' },
    { id: 'openrouter', label: 'OpenRouter', route: 'openrouter', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1' },
    { id: 'custom', label: '自定义', route: '', api: '', baseURL: '' }
  ];

  /* Harness 服务页的一键预设：只填服务商标识与接口地址。 */
  var HARNESS_PRESETS = [
    { id: 'deepseek', label: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com' },
    { id: 'openai', label: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
    { id: 'custom', label: '自定义', provider: '', baseUrl: '' }
  ];

  /* 模型页「模型类型」卡片：五类模型各自绑定 config.models.<kind>。 */
  var MODEL_KINDS = [
    { id: 'chat', label: '对话模型', hint: 'QQ 会话真正使用的模型', follow: '留空则不启用' },
    { id: 'stt', label: '语音转文字', hint: '把 QQ 语音消息转成文字', follow: '跟随对话模型' },
    { id: 'tts', label: '文字转语音', hint: '把回复转成语音发送，音色可留空', follow: '跟随对话模型' },
    { id: 'embedding', label: '嵌入', hint: '文本向量化，用于检索与记忆', follow: '跟随对话模型' },
    { id: 'rerank', label: '重排序', hint: '对检索结果重新排序', follow: '跟随对话模型' }
  ];

  /* 快捷操作。reload-config 对应「重载插件配置」；若服务端只认文档里的 reload，会自动退回。 */
  var CONTROLS = [
    { action: 'reconnect', label: '重连网关' },
    { action: 'test-connection', label: '测试连通性' },
    { action: 'reload-config', label: '重载插件配置', fallback: 'reload' },
    { action: 'clear-log', label: '清空日志', danger: true, confirm: '确定要清空日志文件吗？该操作不可撤销。' }
  ];

  var NAV = [
    {
      title: '接入',
      items: [
        { id: 'connect', label: '连接', icon: 'plug' }
      ]
    },
    {
      title: '监控',
      items: [
        { id: 'overview', label: '总览', icon: 'gauge' },
        { id: 'logs', label: '日志', icon: 'terminal' }
      ]
    },
    {
      title: '机器人',
      items: [
        { id: 'bot', label: '机器人', icon: 'robot' },
        { id: 'persona', label: '人格', icon: 'user' },
        { id: 'capabilities', label: '能力', icon: 'sliders' }
      ]
    },
    {
      title: '扩展',
      items: [
        { id: 'models', label: '模型', icon: 'chip' },
        { id: 'harness', label: 'Harness 服务', icon: 'server' },
        { id: 'plugins', label: '插件', icon: 'puzzle' }
      ]
    }
  ];

  var ICONS = {
    gauge: '<path d="M3.5 19a9 9 0 1 1 17 0"/><path d="M12 13.6 16.4 9.2"/><circle cx="12" cy="14" r="1.4"/>',
    terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 2.6 2.6L7 14.2"/><path d="M12.5 15.2H17"/>',
    robot: '<rect x="4" y="7.5" width="16" height="11.5" rx="2.5"/><path d="M12 3.5v4"/><circle cx="9.2" cy="13" r="1.1"/><circle cx="14.8" cy="13" r="1.1"/>',
    user: '<circle cx="12" cy="8.2" r="3.4"/><path d="M5.2 20a6.8 6.8 0 0 1 13.6 0"/>',
    sliders: '<path d="M4 7.5h9"/><path d="M17.5 7.5H20"/><circle cx="15.2" cy="7.5" r="2.2"/><path d="M4 16.5h5"/><path d="M13.5 16.5H20"/><circle cx="11.2" cy="16.5" r="2.2"/>',
    chip: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10.5 3.5v3.5M13.5 3.5v3.5M10.5 17v3.5M13.5 17v3.5M3.5 10.5H7M3.5 13.5H7M17 10.5h3.5M17 13.5h3.5"/>',
    puzzle: '<path d="M10.2 4.5a2 2 0 1 1 3.6 1.2v.9h3.1a1 1 0 0 1 1 1v3h-.9a2 2 0 1 0 0 3.6h.9v3.1a1 1 0 0 1-1 1h-3.1v-.9a2 2 0 1 0-3.6 0v.9H7.1a1 1 0 0 1-1-1v-3.1h.9a2 2 0 1 0 0-3.6H6.1v-3a1 1 0 0 1 1-1h3.1v-.9Z"/>',
    refresh: '<path d="M20 11.5a8 8 0 1 0-2.6 6"/><path d="M20 5.5v6h-6"/>',
    logout: '<path d="M15 5.5H6.5a1.5 1.5 0 0 0-1.5 1.5v10a1.5 1.5 0 0 0 1.5 1.5H15"/><path d="M16.5 12H9"/><path d="m13.8 9 3 3-3 3"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m15.6 15.6 3.9 3.9"/>',
    download: '<path d="M12 4v10"/><path d="m8.2 10.5 3.8 3.8 3.8-3.8"/><path d="M5 19h14"/>',
    check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.4 12.3 2.5 2.5 4.7-5"/>',
    alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v5"/><circle cx="12" cy="16" r="0.9"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.2"/><circle cx="12" cy="8" r="0.9"/>',
    dot: '<circle cx="12" cy="12" r="4.2"/>',
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    plug: '<path d="M9 3.5v4.2M15 3.5v4.2"/><path d="M6.6 7.7h10.8v3.6a5.4 5.4 0 0 1-10.8 0Z"/><path d="M12 16.8v3.7"/>',
    server: '<rect x="3.5" y="4.5" width="17" height="6" rx="1.8"/><rect x="3.5" y="13.5" width="17" height="6" rx="1.8"/><path d="M7.3 7.5h.01M7.3 16.5h.01"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4.5 17.5 4.8-4.4 3.4 3 2.6-2.3 4.2 3.7"/>'
  };

  /* ============================ 工具函数 ============================ */

  var ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  var RAW = typeof Symbol === 'function' ? Symbol('raw') : '__raw__';

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, function (ch) {
      return ESCAPE_MAP[ch];
    });
  }

  function raw(str) {
    var box = {};
    box[RAW] = true;
    box.str = String(str);
    return box;
  }

  function isRaw(value) {
    return !!value && typeof value === 'object' && value[RAW] === true;
  }

  function interpolate(value) {
    if (value === null || value === undefined || value === false || value === true) return '';
    if (Array.isArray(value)) {
      var joined = '';
      for (var i = 0; i < value.length; i += 1) joined += interpolate(value[i]);
      return joined;
    }
    if (isRaw(value)) return value.str;
    return escapeHtml(value);
  }

  /* 标签模板：默认转义所有插值，raw() 用于插入已生成的片段。 */
  function html(strings) {
    var values = Array.prototype.slice.call(arguments, 1);
    var out = strings[0];
    for (var i = 0; i < values.length; i += 1) {
      out += interpolate(values[i]) + strings[i + 1];
    }
    return raw(out);
  }

  /* 生成属性串：值为 true 输出布尔属性，false/null/undefined 跳过。 */
  function attrs(map) {
    var out = '';
    Object.keys(map).forEach(function (key) {
      var value = map[key];
      if (value === false || value === null || value === undefined) return;
      out += value === true ? ' ' + key : ' ' + key + '="' + escapeHtml(value) + '"';
    });
    return raw(out);
  }

  function icon(name, cls) {
    var path = ICONS[name] || ICONS.dot;
    return html`<svg class="icon ${cls || ''}" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(path)}</svg>`;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function getPath(obj, path) {
    if (!obj) return undefined;
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i += 1) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function setPath(obj, path, value) {
    if (!obj) return;
    var parts = String(path).split('.');
    var last = parts.pop();
    var cur = obj;
    for (var i = 0; i < parts.length; i += 1) {
      if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[last] = value;
  }

  function fieldId(path) {
    return 'f-' + String(path).replace(/[^a-zA-Z0-9]+/g, '-');
  }

  function clampInt(value, min, max, fallback) {
    var n = typeof value === 'number' ? value : Number(value);
    if (!isFinite(n)) return fallback;
    n = Math.trunc(n);
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  function cleanList(value) {
    if (!Array.isArray(value)) return [];
    var seen = [];
    value.forEach(function (entry) {
      var text = typeof entry === 'string' ? entry.trim() : '';
      if (text !== '' && seen.indexOf(text) < 0) seen.push(text);
    });
    return seen;
  }

  function textOf(value, fallback) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return fallback;
    return String(value);
  }

  function formatBytes(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatUptime(sec) {
    var n = Number(sec);
    if (!isFinite(n) || n < 0) return '—';
    n = Math.trunc(n);
    var days = Math.floor(n / 86400);
    var hours = Math.floor((n % 86400) / 3600);
    var mins = Math.floor((n % 3600) / 60);
    var secs = n % 60;
    var parts = [];
    if (days > 0) parts.push(days + ' 天');
    if (days > 0 || hours > 0) parts.push(hours + ' 小时');
    if (days > 0 || hours > 0 || mins > 0) parts.push(mins + ' 分');
    if (parts.length === 0 || days === 0) parts.push(secs + ' 秒');
    return parts.join(' ');
  }

  function parseTime(value) {
    if (!value) return null;
    var ms = Date.parse(value);
    return isNaN(ms) ? null : ms;
  }

  function formatTime(value) {
    var ms = parseTime(value);
    if (ms === null) return '—';
    var d = new Date(ms);
    var pad = function (n) {
      return n < 10 ? '0' + n : String(n);
    };
    return (
      d.getFullYear() +
      '-' + pad(d.getMonth() + 1) +
      '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) +
      ':' + pad(d.getMinutes()) +
      ':' + pad(d.getSeconds())
    );
  }

  function shortTime(value) {
    var ms = parseTime(value);
    if (ms === null) return '--:--:--';
    var d = new Date(ms);
    var pad = function (n) {
      return n < 10 ? '0' + n : String(n);
    };
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function timeAgo(value) {
    var ms = parseTime(value);
    if (ms === null) return '—';
    var diff = (Date.now() - ms) / 1000;
    if (diff < 0) diff = 0;
    if (diff < 5) return '刚刚';
    if (diff < 60) return Math.floor(diff) + ' 秒前';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    return Math.floor(diff / 86400) + ' 天前';
  }

  function shortId(value) {
    var text = String(value === null || value === undefined ? '' : value);
    if (text.length <= 14) return text === '' ? '—' : text;
    return text.slice(0, 6) + '…' + text.slice(-4);
  }

  function sceneLabel(scene) {
    if (scene === 'group') return '群聊';
    if (scene === 'c2c') return '私聊';
    return scene ? String(scene) : '未知场景';
  }

  function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  /* =============================== API =============================== */

  function ApiError(status, message, data) {
    this.name = 'ApiError';
    this.status = status;
    this.message = message;
    this.data = data;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  // Set by the shell when the console is mounted under a path prefix.
  var API_BASE = (typeof window !== "undefined" && window.__QQBOT_BASE__) || "";

  function api(path, options) {
    var opts = options || {};
    var init = {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: Object.assign({ Accept: 'application/json' }, opts.headers || {})
    };
    if (opts.body !== undefined && opts.body !== null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    }
    return fetch(API_BASE + '/api' + path, init).then(
      function (res) {
        return res
          .text()
          .catch(function () {
            return '';
          })
          .then(function (textRaw) {
            var data = null;
            if (textRaw) {
              try {
                data = JSON.parse(textRaw);
              } catch (err) {
                data = null;
              }
            }
            if (!res.ok) {
              var msg =
                data && typeof data.error === 'string' && data.error !== ''
                  ? data.error
                  : '请求失败（HTTP ' + res.status + '）';
              if (res.status === 401 && path !== '/session' && path !== '/login') handleUnauthorized();
              throw new ApiError(res.status, msg, data);
            }
            if (data === null) throw new ApiError(res.status, '服务器返回了无法解析的数据', null);
            return data;
          });
      },
      function () {
        throw new ApiError(0, '网络请求失败，请确认控制台服务仍在运行', null);
      }
    );
  }

  /* ============================== 状态 ============================== */

  var state = {
    session: { checked: false, authed: false, mustChange: false },
    route: 'overview',
    overview: null,
    config: null,
    revision: null,
    updatedAt: null,
    draft: null,
    plugins: null,
    models: null,
    logs: { lines: [], path: '', bytes: 0 },
    imageTest: null,
    loaded: {},
    loading: {},
    errors: {},
    busy: {},
    reverting: false,
    revertHash: '',
    ui: {
      username: 'harness', password: '',
      credCurrent: '', credUsername: '', credPassword: '', credConfirm: '', credError: '',
      toolSearch: '',
      imagePrompt: '一只坐在窗台上的橘猫',
      installTab: 'catalog',
      installPath: '',
      installUrl: '',
      pluginEdit: null,
      pluginDraft: null,
      providerForm: null,
      harnessAt: 0,
      logLines: 300,
      logAuto: false,
      logStick: true
    }
  };

  var logTimer = null;

  function busySet(key, on) {
    if (on) state.busy[key] = true;
    else delete state.busy[key];
  }

  function isBusy(key) {
    return !!state.busy[key];
  }

  function syncBusy() {
    var nodes = document.querySelectorAll('[data-busy]');
    Array.prototype.forEach.call(nodes, function (el) {
      var key = el.getAttribute('data-busy');
      if (isBusy(key)) {
        el.disabled = true;
        el.classList.add('is-busy');
      } else {
        el.classList.remove('is-busy');
        el.disabled = el.hasAttribute('data-locked');
      }
    });
  }

  function isConfigDirty() {
    if (!state.draft || !state.config) return false;
    return JSON.stringify(state.draft) !== JSON.stringify(state.config);
  }

  function isPluginDraftDirty(draft) {
    if (!draft || !state.plugins) return false;
    var item = findInstalled(draft.id);
    if (!item) return false;
    if (draft.name !== textOf(item.name, '')) return true;
    if (draft.description !== textOf(item.description, '')) return true;
    /* prompt 已知时按全文比较；未知（旧服务端）时只要填了就视为修改。 */
    if (draft.promptKnown) return textOf(draft.prompt, '') !== textOf(item.prompt, '');
    return textOf(draft.prompt, '') !== '';
  }

  function isDirty() {
    return isConfigDirty() || isPluginDraftDirty(state.ui.pluginDraft);
  }

  function findInstalled(id) {
    var list = state.plugins && Array.isArray(state.plugins.installed) ? state.plugins.installed : [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  function resetData() {
    stopLogTimer();
    state.overview = null;
    state.config = null;
    state.revision = null;
    state.updatedAt = null;
    state.draft = null;
    state.plugins = null;
    state.models = null;
    state.logs = { lines: [], path: '', bytes: 0 };
    state.imageTest = null;
    state.loaded = {};
    state.loading = {};
    state.errors = {};
    state.busy = {};
    state.ui.pluginEdit = null;
    state.ui.pluginDraft = null;
    state.ui.providerForm = null;
    state.ui.credCurrent = '';
    state.ui.credPassword = '';
    state.ui.credConfirm = '';
    state.ui.credError = '';
    state.ui.harnessAt = 0;
    state.ui.installPath = '';
    state.ui.installUrl = '';
    state.ui.logStick = true;
  }

  function handleUnauthorized() {
    var wasAuthed = state.session.authed;
    state.session = { checked: true, authed: false, mustChange: false };
    resetData();
    if (wasAuthed) {
      render();
      toast('error', '登录状态已过期，请重新登录');
    }
  }

  /* ============================== Toast ============================== */

  function toast(kind, message, action) {
    var host = document.getElementById('toasts');
    if (!host) return;
    var tone = kind === 'success' ? 'success' : kind === 'error' ? 'error' : 'info';
    var iconName = tone === 'success' ? 'check' : tone === 'error' ? 'alert' : 'info';
    var el = document.createElement('div');
    el.className = 'toast toast-' + tone;
    el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    el.innerHTML = html`<span class="toast-icon">${icon(iconName, 'icon-sm')}</span>
      <div class="toast-body">
        <div class="toast-msg">${message}</div>
        ${action ? html`<button type="button" class="btn btn-sm" data-act="${action.act}">${action.label}</button>` : ''}
      </div>
      <button type="button" class="toast-close" data-act="dismiss-toast" aria-label="关闭提示">×</button>`.str;
    host.appendChild(el);
    var life = action ? 10000 : 4200;
    setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 320);
    }, life);
  }

  function removeToast(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  /* ============================== 视图 ============================== */

  function currentPage() {
    return PAGES[state.route] || PAGES.overview;
  }

  function view() {
    if (!state.session.checked) {
      return html`<div class="boot-screen"><span class="spinner"></span><span>正在加载…</span></div>`;
    }
    if (!state.session.authed) return loginView();
    if (state.session.mustChange) return credentialsView();
    return shellView(currentPage());
  }

  function loginView() {
    return html`<div class="login-wrap">
      <div class="card login-card">
        <div class="login-brand">
          <span class="brand-mark">${icon('robot')}</span>
          <span><strong>大肥鱼的QQ机器人服务</strong><span>v${VERSION}</span></span>
        </div>
        <form id="login-form" autocomplete="off">
          <label class="field">
            <span class="field-label">用户名</span>
            <input class="input" id="login-username" type="text" data-ui="username" value="${state.ui.username}"
              placeholder="请输入用户名" autocomplete="username" ${attrs({ autofocus: true })}>
          </label>
          <label class="field">
            <span class="field-label">密码</span>
            <input class="input" id="login-password" type="password" data-ui="password" value="${state.ui.password}"
              placeholder="请输入密码" autocomplete="current-password">
          </label>
          <button type="submit" class="btn btn-primary btn-block" data-busy="login">${isBusy('login') ? '登录中…' : '进入控制台'}</button>
          <p class="login-default-hint">默认账号与密码均为 <code>harness</code>，首次登录后必须修改。</p>
        </form>
        <p class="login-hint">登录状态保存在会话 Cookie 中，30 天内免登录；服务端也可以用 <code>scripts/set-password.sh</code> 重置账号密码。</p>
      </div>
    </div>`;
  }

  /* 默认凭据未修改前只显示这张卡片：没有侧边栏、没有导航，也不能关闭。 */
  function credentialsView() {
    var error = textOf(state.ui.credError, '');
    return html`<div class="login-wrap">
      <div class="card login-card login-card-wide">
        <div class="login-brand">
          <span class="brand-mark">${icon('robot')}</span>
          <span><strong>大肥鱼的QQ机器人服务</strong><span>首次登录必须修改凭据</span></span>
        </div>
        <div class="hint-box hint-box-accent"><strong>必须先修改默认账号密码。</strong>默认账号与密码均为 harness；修改成功后所有登录状态都会失效，需要用新账号重新登录。修改完成前控制台不会加载任何数据。</div>
        <form id="credential-form" autocomplete="off">
          <label class="field">
            <span class="field-label">当前密码</span>
            <input class="input" id="cred-current" type="password" data-ui="cred-current" value="${state.ui.credCurrent}"
              placeholder="默认密码 harness" autocomplete="current-password" ${attrs({ autofocus: true })}>
          </label>
          <label class="field">
            <span class="field-label">新用户名</span>
            <input class="input" id="cred-username" type="text" data-ui="cred-username" value="${state.ui.credUsername}"
              placeholder="新的登录用户名" autocomplete="username">
          </label>
          <label class="field">
            <span class="field-label">新密码</span>
            <input class="input" id="cred-password" type="password" data-ui="cred-password" value="${state.ui.credPassword}"
              placeholder="至少 6 位，同时含大写字母、小写字母和数字" autocomplete="new-password">
          </label>
          <label class="field">
            <span class="field-label">确认新密码</span>
            <input class="input" id="cred-confirm" type="password" data-ui="cred-confirm" value="${state.ui.credConfirm}"
              placeholder="再输入一次新密码" autocomplete="new-password">
          </label>
          <div class="form-error" id="cred-error">${error}</div>
          <button type="submit" class="btn btn-primary btn-block" data-busy="cred-save">${isBusy('cred-save') ? '提交中…' : '修改账号密码'}</button>
        </form>
        <p class="login-hint">改完会退出所有登录状态，必须用新账号重新登录。</p>
      </div>
    </div>`;
  }

  function shellView(page) {
    return html`<div class="app">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">${icon('robot')}</span>
          <span class="brand-text"><strong>大肥鱼的QQ机器人服务</strong><span>v${VERSION}</span></span>
        </div>
        <nav class="nav" aria-label="主导航">
          ${NAV.map(function (group) {
            return html`<div class="nav-group">
              <div class="nav-group-title">${group.title}</div>
              ${group.items.map(function (item) {
                var active = item.id === state.route;
                return html`<a class="nav-item${active ? ' is-active' : ''}" href="#/${item.id}"
                  ${active ? raw('aria-current="page"') : ''}>${icon(item.icon)}<span>${item.label}</span></a>`;
              })}
            </div>`;
          })}
        </nav>
        <div class="sidebar-foot">
          <button type="button" class="btn btn-block" data-act="logout" data-busy="logout">${icon('logout')}<span>退出登录</span></button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div class="topbar-heading">
            <h1>${page.title}</h1>
            <p>${page.subtitle}</p>
          </div>
          <div class="topbar-actions" id="topbar-status">${topStatusView()}</div>
        </header>
        <main class="content" id="content">
          <div class="content-inner" id="page-content">${bodyView()}</div>
        </main>
        <footer class="footer" id="app-footer">${footerView()}</footer>
      </div>
    </div>`;
  }

  function topStatusView() {
    var bridge = state.overview && state.overview.bridge ? state.overview.bridge : null;
    var info = BRIDGE_STATES[(bridge && bridge.state) || 'unknown'] || BRIDGE_STATES.unknown;
    return html`<span class="pill pill-${info.tone}">${icon('dot')}<span>${info.label}</span></span>
      <button type="button" class="btn btn-sm" data-act="page-refresh" data-busy="page-refresh">${icon('refresh')}<span>刷新</span></button>`;
  }

  function footerView() {
    var log = state.overview && state.overview.log ? state.overview.log : null;
    var path = log && typeof log.path === 'string' && log.path !== '' ? log.path : '—';
    var size = log && typeof log.bytes === 'number' ? formatBytes(log.bytes) : '';
    return html`<span>大肥鱼的QQ机器人服务 <strong>v${VERSION}</strong></span>
      <span class="footer-sep">·</span>
      <span>日志文件：<code>${path}</code>${size ? html` <span class="muted">（${size}）</span>` : ''}</span>`;
  }

  function bodyView() {
    var page = currentPage();
    if (state.loading[state.route]) return loadingView();
    if (state.errors[state.route]) return errorView(state.errors[state.route]);
    return page.render();
  }

  function loadingView() {
    return html`<section class="card skeleton-card">
      <div class="loading-line"><span class="spinner"></span><span>加载中…</span></div>
      <div class="skel w-40"></div>
      <div class="skel w-90"></div>
      <div class="skel w-70"></div>
      <div class="skel w-90"></div>
      <div class="skel w-40"></div>
    </section>`;
  }

  function errorView(message) {
    return html`<section class="card">
      <div class="card-body">
        <div class="empty">${message || '加载失败'}</div>
        <button type="button" class="btn" data-act="page-refresh" data-busy="page-refresh">${icon('refresh')}<span>重新加载</span></button>
      </div>
    </section>`;
  }

  function emptyCard(text) {
    return html`<section class="card"><div class="card-body"><div class="empty">${text}</div></div></section>`;
  }

  function cardHead(title, subtitle, actions) {
    return html`<div class="card-head">
      <div><h2>${title}</h2>${subtitle ? html`<p>${subtitle}</p>` : ''}</div>
      ${actions ? html`<div class="card-head-actions">${actions}</div>` : ''}
    </div>`;
  }

  function render() {
    var root = document.getElementById('app');
    if (!root) return;
    root.innerHTML = view().str;
    syncBusy();
    var page = currentPage();
    if (page && typeof page.after === 'function') page.after();
    if (state.session.checked && !state.session.authed) {
      var input = document.getElementById('login-username');
      if (input) input.focus();
      return;
    }
    if (state.session.mustChange) {
      var credInput = document.getElementById('cred-current');
      if (credInput) credInput.focus();
    }
  }

  function renderContent() {
    var host = document.getElementById('page-content');
    if (!host) {
      render();
      return;
    }
    host.innerHTML = bodyView().str;
    syncBusy();
    var page = currentPage();
    if (page && typeof page.after === 'function') page.after();
  }

  var CONFIG_ROUTES = ['connect', 'bot', 'persona', 'capabilities', 'models', 'harness'];

  /* 异步回调只在用户仍停留在对应页面时重绘，避免抢走输入焦点。 */
  function renderIf(route) {
    if (state.route === route) renderContent();
  }

  function renderConfigPages() {
    if (CONFIG_ROUTES.indexOf(state.route) >= 0) renderContent();
  }

  function patchTopStatus() {
    var host = document.getElementById('topbar-status');
    if (host) host.innerHTML = topStatusView().str;
  }

  function patchFooter() {
    var host = document.getElementById('app-footer');
    if (host) host.innerHTML = footerView().str;
  }

  /* ============================ 表单片段 ============================ */

  function rowShell(label, hint, control) {
    var id = control && control.id ? control.id : '';
    return html`<div class="form-row">
      <div class="form-label">${id ? html`<label for="${id}">${label}</label>` : html`<span>${label}</span>`}${hint ? html`<div class="form-hint">${hint}</div>` : ''}</div>
      <div class="form-control">${control ? control.node : ''}</div>
    </div>`;
  }

  function rowInput(label, hint, path, options) {
    var opts = options || {};
    var value = getPath(state.draft, path);
    var id = fieldId(path);
    var node = html`<input class="input${opts.narrow ? ' input-narrow' : ''}" id="${id}" type="${opts.type || 'text'}"
        data-path="${path}" data-type="text" value="${value === null || value === undefined ? '' : value}"
        ${attrs({ placeholder: opts.placeholder, maxlength: opts.maxlength, autocomplete: opts.autocomplete })}>`;
    return rowShell(label, hint, { id: id, node: node });
  }

  function rowTextarea(label, hint, path, rows) {
    var value = getPath(state.draft, path);
    var id = fieldId(path);
    var node = html`<textarea class="textarea" id="${id}" rows="${rows || 3}" data-path="${path}" data-type="text"
        ${attrs({ placeholder: '留空表示不发送' })}>${value === null || value === undefined ? '' : value}</textarea>`;
    return rowShell(label, hint, { id: id, node: node });
  }

  function rowNumber(label, hint, path, min, max, step, unit) {
    var value = getPath(state.draft, path);
    var id = fieldId(path);
    var node = html`<div class="form-control-row">
      <input class="input" id="${id}" type="number" data-path="${path}" data-type="number"
        value="${value === null || value === undefined ? '' : value}" min="${min}" max="${max}" step="${step || 1}">
      ${unit ? html`<span class="unit">${unit}</span>` : ''}
      <span class="unit">范围 ${min}–${max}</span>
    </div>`;
    return rowShell(label, hint, { id: id, node: node });
  }

  function rowSwitch(label, hint, path) {
    var value = !!getPath(state.draft, path);
    var node = html`<label class="switch">
      <input type="checkbox" data-path="${path}" data-type="bool" aria-label="${label}" ${attrs({ checked: value })}>
      <span class="track"></span>
      <span class="switch-label">${value ? '已开启' : '已关闭'}</span>
    </label>`;
    return rowShell(label, hint, { node: node });
  }

  function rowSelect(label, hint, path, options) {
    var value = getPath(state.draft, path);
    var current = value === null || value === undefined ? '' : String(value);
    var id = fieldId(path);
    var known = false;
    var node = html`<select class="select" id="${id}" data-path="${path}" data-type="select">
      ${options.map(function (opt) {
        var optValue = String(opt.value);
        if (optValue === current) known = true;
        return html`<option value="${optValue}" ${attrs({ selected: optValue === current })}>${opt.label}</option>`;
      })}
      ${known ? '' : html`<option value="${current}" selected>${current === '' ? '（未设置）' : current + '（当前值）'}</option>`}
    </select>`;
    return rowShell(label, hint, { id: id, node: node });
  }

  function rowChips(label, hint, path, placeholder) {
    var node = html`<div class="chips" data-chips="${path}">${chipsInner(path, placeholder)}</div>`;
    return rowShell(label, hint, { node: node });
  }

  function chipsInner(path, placeholder) {
    var list = getPath(state.draft, path);
    var arr = Array.isArray(list) ? list : [];
    return html`${arr.map(function (value, index) {
        return html`<span class="chip"><span class="chip-text" title="${value}">${value}</span><button type="button" class="chip-x" data-act="chip-remove" data-path="${path}" data-index="${index}" aria-label="移除 ${value}">×</button></span>`;
      })}
      ${arr.length === 0 ? html`<span class="chips-empty">当前为「不限制」</span>` : ''}
      <input class="chip-input" type="text" data-chip="${path}" placeholder="${placeholder || '输入后按 Enter 添加'}">`;
  }

  /* ======================= 配置页公共操作条 ======================= */

  function actionBarView() {
    var dirty = isConfigDirty();
    var revision = state.revision === null || state.revision === undefined ? '—' : state.revision;
    return html`<div class="actionbar" id="actionbar">
      <div class="actionbar-info">
        <span class="dot ${dirty ? 'dot-warn' : 'dot-ok'}"></span>
        <span>${dirty ? '有未保存的修改' : '已与服务器同步'}</span>
        <span class="muted">配置版本 revision ${revision}${state.updatedAt ? html` · 更新于 ${formatTime(state.updatedAt)}` : ''}</span>
      </div>
      <div class="actionbar-btns">
        <button type="button" class="btn" data-act="config-reset" ${dirty ? '' : raw('disabled')}>放弃修改</button>
        <button type="button" class="btn btn-primary" data-act="config-save" data-busy="config-save"
          ${dirty ? '' : raw('disabled data-locked="config"')}>保存修改</button>
      </div>
    </div>`;
  }

  function patchActionBar() {
    var el = document.getElementById('actionbar');
    if (!el) return;
    el.outerHTML = actionBarView().str;
  }

  function syncDirtyUI() {
    patchActionBar();
    syncInlineSaveButtons();
    syncPluginSaveButton();
    syncBusy();
  }

  /* 页面内联的「保存」按钮（连接页、Harness 服务页）与顶部操作条保持同样的可用状态。 */
  function syncInlineSaveButtons() {
    var dirty = isConfigDirty();
    var nodes = document.querySelectorAll('[data-act="config-save"][data-inline-save]');
    Array.prototype.forEach.call(nodes, function (el) {
      if (dirty) el.removeAttribute('data-locked');
      else el.setAttribute('data-locked', 'config');
    });
  }

  /* ============================ 页面：连接 ============================ */

  /* 桥接三态：未配置 / 连接中 / 在线（机器人名）。 */
  function connectStateInfo(bridge) {
    var name = bridge && bridge.state ? String(bridge.state) : 'unknown';
    var bot = bridge ? textOf(bridge.bot, '') : '';
    if (name === 'online') {
      return {
        tone: 'ok',
        label: bot === '' ? '在线' : '在线（' + bot + '）',
        detail: '桥接已经连上 QQ 网关，可以收发消息了。'
      };
    }
    if (name === 'connecting') {
      return { tone: 'warn', label: '连接中', detail: '桥接正在连接 QQ 网关，通常几秒内完成。' };
    }
    if (name === 'degraded') {
      return { tone: 'warn', label: bot === '' ? '在线（降级运行）' : '在线（' + bot + '，降级运行）', detail: '桥接仍然连着 QQ，但最近有错误，详情见总览与日志。' };
    }
    if (name === 'stopped') {
      return { tone: 'danger', label: '已停止', detail: '桥接进程没有在运行，先确认服务是否已启动。' };
    }
    if (name === 'disabled') {
      return { tone: 'muted', label: '未配置', detail: '机器人总开关是关闭状态，开启后才会连接 QQ。' };
    }
    return { tone: 'muted', label: '未配置', detail: '还没把 AppID / AppSecret 交给桥接进程。' };
  }

  function connectStatusView() {
    var bridge = state.overview && state.overview.bridge ? state.overview.bridge : null;
    var info = connectStateInfo(bridge);
    var gateway = bridge && bridge.gateway ? GATEWAY_STATES[bridge.gateway] || bridge.gateway : '';
    return html`<span class="pill pill-${info.tone}">${icon('dot')}<span>${info.label}</span></span>
      <span class="connect-status-text">${info.detail}</span>
      ${gateway === '' ? '' : html`<span class="muted">网关 ${gateway}</span>`}`;
  }

  function patchConnectStatus() {
    var host = document.getElementById('connect-status');
    if (!host) return;
    host.innerHTML = connectStatusView().str;
  }

  function renderConnect() {
    if (!state.draft) return errorView('配置尚未加载');
    var secret = textOf(getPath(state.draft, 'qq.clientSecret'), '');
    return html`
      ${actionBarView()}
      <section class="card">
        ${cardHead('QQ 机器人凭据', 'QQ 开放平台的机器人 AppID 与 AppSecret')}
        <div class="card-body">
          <div class="hint-box">这里填 QQ 开放平台的机器人凭据（AppID / AppSecret），控制台把它写进运行时配置，桥接进程读取后连上 QQ 网关。</div>
          ${rowInput('AppID', 'QQ 开放平台「开发设置」里的机器人 AppID', 'qq.appId', { placeholder: '102xxxxxxx', autocomplete: 'off' })}
          <div class="form-row">
            <div class="form-label"><label for="${fieldId('qq.clientSecret')}">AppSecret</label><div class="form-hint">机器人密钥，只保存在本机配置里</div></div>
            <div class="form-control">
              <div class="form-control-row">
                <input class="input" id="${fieldId('qq.clientSecret')}" type="password" data-path="qq.clientSecret"
                  data-type="text" value="${secret}" autocomplete="off" placeholder="在开放平台重置后复制">
                <button type="button" class="btn btn-sm" data-act="connect-key-toggle">显示</button>
              </div>
            </div>
          </div>
          <div class="form-row">
            <div class="form-label"><span>保存与测试</span><div class="form-hint">测试用的是已经保存进配置的凭据，改完请先保存</div></div>
            <div class="form-control">
              <div class="form-control-row">
                <button type="button" class="btn btn-primary" data-act="config-save" data-busy="config-save" data-inline-save ${isConfigDirty() ? '' : raw('disabled data-locked="config"')}>保存</button>
                <button type="button" class="btn" data-act="connect-test" data-busy="connect-test">${icon('plug')}<span>测试连接</span></button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        ${cardHead('桥接状态', '凭据保存后桥接会自动重连，通常几秒内生效')}
        <div class="card-body">
          <div class="connect-status" id="connect-status">${connectStatusView()}</div>
          <div class="hint-box">凭据保存后桥接会自动重连，通常几秒内生效；这里只是把凭据写进配置，真正的连接由桥接进程完成。</div>
        </div>
      </section>`;
  }

  /* ============================ 页面：总览 ============================ */

  function renderOverview() {
    var ov = state.overview;
    if (!ov) return emptyCard('暂无总览数据');
    var bridge = ov.bridge || {};
    var counters = bridge.counters || {};
    var runtime = bridge.runtime || null;
    var system = ov.system || {};
    var log = ov.log || {};
    var info = BRIDGE_STATES[bridge.state] || BRIDGE_STATES.unknown;
    var gateway = bridge.gateway ? GATEWAY_STATES[bridge.gateway] || bridge.gateway : '—';

    return html`
      <section class="stats">
        <div class="card stat">
          <div class="stat-title">运行状态</div>
          <div class="stat-main"><span class="pill pill-${info.tone}">${icon('dot')}<span>${info.label}</span></span></div>
          <div class="stat-meta">构建 <code>${textOf(bridge.build, '—')}</code></div>
        </div>
        <div class="card stat">
          <div class="stat-title">机器人名称</div>
          <div class="stat-main">${textOf(bridge.bot, '未连接')}</div>
          <div class="stat-meta">网关 ${gateway}</div>
        </div>
        <div class="card stat">
          <div class="stat-title">累计接收</div>
          <div class="stat-main">${Number(counters.inbound) || 0}</div>
          <div class="stat-meta">已回复 ${Number(counters.replied) || 0} · 已拒绝 ${Number(counters.rejected) || 0}</div>
        </div>
        <div class="card stat">
          <div class="stat-title">失败数</div>
          <div class="stat-main">${Number(counters.failed) || 0}</div>
          <div class="stat-meta">${bridge.lastError ? html`<span class="dot dot-danger"></span>最近有错误` : html`<span class="dot dot-ok"></span>近期无错误`}</div>
        </div>
      </section>

      <section class="card">
        ${cardHead('快捷操作', '对桥接进程立即生效，不需要重启 Harness')}
        <div class="card-body">
          <div class="actions-row">
            ${CONTROLS.map(function (item) {
              return html`<button type="button" class="btn${item.danger ? ' btn-danger' : ''}" data-act="control"
                data-action="${item.action}" data-busy="control-${item.action}"
                ${attrs({ 'data-fallback': item.fallback, 'data-confirm': item.confirm })}>${item.label}</button>`;
            })}
          </div>
        </div>
      </section>

      <div class="two-col">
        <section class="card">
          ${cardHead('最近活动', '最近一条来信、最近一次回复与最近一次错误')}
          <div class="card-body">${activityView(bridge)}</div>
        </section>
        <section class="card">
          ${cardHead('运行时摘要', '当前生效的人格、能力与模型')}
          <div class="card-body">${runtimeView(runtime)}</div>
        </section>
      </div>

      <section class="card">
        ${cardHead('运行环境', '控制台进程与公开访问地址')}
        <div class="card-body">
          <table class="table">
            <tbody>
              <tr><th>主机名</th><td class="mono">${textOf(system.hostname, '—')}</td></tr>
              <tr><th>平台</th><td class="mono">${textOf(system.platform, '—')}</td></tr>
              <tr><th>Node 版本</th><td class="mono">${textOf(system.node, '—')}</td></tr>
              <tr><th>运行时长</th><td>${formatUptime(system.uptimeSec)}</td></tr>
              <tr><th>内存占用</th><td>${Number(system.memUsedMB) || 0} MB / ${Number(system.memTotalMB) || 0} MB</td></tr>
              <tr><th>公开地址</th><td>${system.publicBaseUrl
                ? html`<a class="mono" href="${system.publicBaseUrl}" target="_blank" rel="noopener noreferrer">${system.publicBaseUrl}</a>`
                : html`<span class="muted">未配置</span>`}</td></tr>
              <tr><th>日志文件</th><td class="mono">${textOf(log.path, '—')} <span class="muted">（${formatBytes(log.bytes)}）</span></td></tr>
            </tbody>
          </table>
        </div>
      </section>`;
  }

  function activityView(bridge) {
    var rows = [];
    if (bridge.lastInbound) {
      var inbound = bridge.lastInbound;
      rows.push({
        tone: 'in',
        iconName: 'download',
        title: '收到消息',
        at: inbound.at,
        detail:
          sceneLabel(inbound.scene) +
          ' · 发送者 ' + shortId(inbound.sender) +
          (inbound.group ? ' · 群 ' + shortId(inbound.group) : '') +
          ' · ' + (Number(inbound.chars) || 0) + ' 字'
      });
    }
    if (bridge.lastReply) {
      var reply = bridge.lastReply;
      rows.push({
        tone: 'out',
        iconName: 'check',
        title: '已回复',
        at: reply.at,
        detail: '会话 ' + shortId(reply.sessionId) + ' · ' + (Number(reply.chars) || 0) + ' 字'
      });
    }
    if (bridge.lastError) {
      rows.push({ tone: 'err', iconName: 'alert', title: '最近错误', at: bridge.updatedAt, detail: bridge.lastError });
    }
    if (rows.length === 0) return html`<div class="empty">暂无活动记录</div>`;
    return html`<ul class="activity">
      ${rows.map(function (row) {
        return html`<li class="activity-item">
          <span class="activity-dot ${row.tone}">${icon(row.iconName)}</span>
          <div class="activity-main">
            <div class="activity-title">${row.title}<span class="activity-time" title="${formatTime(row.at)}">${timeAgo(row.at)}</span></div>
            <div class="activity-detail">${row.detail}</div>
          </div>
        </li>`;
      })}
    </ul>`;
  }

  function capabilityPill(label, on) {
    return html`<span class="pill ${on ? 'pill-ok' : 'pill-muted'}">${label} ${on ? '开' : '关'}</span>`;
  }

  function runtimeView(runtime) {
    if (!runtime) return html`<div class="empty">暂无运行时信息（桥接可能尚未启动）</div>`;
    var caps = runtime.capabilities || {};
    var plugins = runtime.plugins || {};
    var model = runtime.model || {};
    var tools = Array.isArray(runtime.tools) ? runtime.tools : [];
    return html`<dl class="kv">
        <div class="kv-row"><dt>人格</dt><dd>${textOf(runtime.personaName, '（未命名）')} <span class="muted">revision ${runtime.revision === undefined || runtime.revision === null ? '—' : runtime.revision}</span></dd></div>
        <div class="kv-row"><dt>能力开关</dt><dd class="kv-pills">${capabilityPill('工具', !!caps.tools)} ${capabilityPill('联网', !!caps.web)} ${capabilityPill('生图', !!caps.image)}</dd></div>
        <div class="kv-row"><dt>插件</dt><dd>已启用 ${Number(plugins.enabled) || 0} / 共 ${Number(plugins.total) || 0}</dd></div>
        <div class="kv-row"><dt>当前模型</dt><dd>${textOf(model.provider, '—')} · ${textOf(model.model, '—')}${model.reasoningEffort ? html` <span class="muted">推理强度 ${model.reasoningEffort}</span>` : ''}</dd></div>
        <div class="kv-row"><dt>可见工具</dt><dd>${tools.length} 个</dd></div>
      </dl>
      ${tools.length
        ? html`<div class="chips-list">${tools.map(function (tool) {
            return html`<span class="chip chip-static" title="${textOf(tool.description, '')}">${textOf(tool.name, '')}</span>`;
          })}</div>`
        : ''}`;
  }

  /* ============================ 页面：机器人 ============================ */

  function renderBot() {
    if (!state.draft) return errorView('配置尚未加载');
    return html`
      ${actionBarView()}
      <section class="card">
        ${cardHead('基础行为', '控制机器人是否响应，以及回复时附带的信息')}
        <div class="card-body">
          ${rowSwitch('启用机器人', '关闭后不再连接 QQ，也不会响应任何消息', 'bot.enabled')}
          ${rowSwitch('响应群聊 @', '关闭后群里 @机器人 也不会回复', 'bot.replyToGroup')}
          ${rowSwitch('响应私聊', '关闭后好友私聊不会回复', 'bot.replyToC2C')}
          ${rowSwitch('即时回执', '收到消息先回一条「已收到」，避免用户以为机器人没反应', 'bot.ackEnabled')}
          ${rowInput('回执文案', '即时回执的内容，建议简短', 'bot.ackText', { placeholder: '🤖 已收到，正在处理，请稍候…' })}
          ${rowSwitch('附带发送者信息', '在提示词里带上发送者 / 群的 openid，便于模型区分群里不同的人', 'bot.includeSenderHeader')}
        </div>
      </section>

      <section class="card">
        ${cardHead('欢迎语', '被拉进群或加好友时发送一次，留空表示不发送')}
        <div class="card-body">
          ${rowTextarea('入群欢迎语', '被拉进群时发送，留空则不发送', 'bot.welcomeGroupText', 2)}
          ${rowTextarea('加好友欢迎语', '被添加为好友时发送，留空则不发送', 'bot.welcomeFriendText', 2)}
        </div>
      </section>

      <section class="card">
        ${cardHead('回复长度', '超长回复会按段落切分成多条 QQ 消息')}
        <div class="card-body">
          ${rowNumber('单条消息上限', '超出后按段落切分，过小会把一句话拆断', 'bot.maxChars', 200, 4000, 50, '字符')}
          ${rowNumber('最多分片数', '一条回复最多切成几条消息，超出部分会被截断', 'bot.maxChunks', 1, 4, 1, '条')}
        </div>
      </section>

      <section class="card">
        ${cardHead('白名单', '用于限制「谁能驱动机器人」。列表为空表示不限制')}
        <div class="card-body">
          ${rowChips('用户 openid 白名单', '留空 = 不限制：任何私聊用户都能驱动机器人。输入 openid 后按 Enter 添加', 'bot.allowedUserOpenids', '输入用户 openid 后按 Enter')}
          ${rowChips('群 openid 白名单', '留空 = 不限制：任何群都可以 @机器人。输入群 openid 后按 Enter', 'bot.allowedGroupOpenids', '输入群 openid 后按 Enter')}
        </div>
      </section>`;
  }

  /* ============================ 页面：人格 ============================ */

  function composePromptPreview(persona) {
    if (persona.useCustom && String(persona.custom || '').trim() !== '') return String(persona.custom).trim();
    var parts = [BASE_DEPLOYMENT_PROMPT];
    var name = String(persona.name || '').trim();
    var role = String(persona.role || '').trim();
    var style = String(persona.style || '').trim();
    var rules = String(persona.rules || '').trim();
    if (name !== '') parts.push('你的名字是「' + name + '」，用户这样称呼你时要自然回应。');
    if (role !== '') parts.push('你的角色设定：' + role);
    if (style !== '') parts.push('你的说话风格：' + style);
    if (rules !== '') parts.push('必须遵守的规则：\n' + rules);
    return parts.join('\n\n');
  }

  function previewView() {
    var persona = (state.draft && state.draft.persona) || {};
    var text = composePromptPreview(persona);
    var custom = !!persona.useCustom;
    return html`<div class="form-hint">${custom
      ? '已启用「完全自定义」，预览内容完全来自自定义提示词（与上方字段无关）。'
      : '预览 = 固定部署说明 + 名称 / 角色 / 风格 / 规则，与桥接实际注入的提示词一致。'}</div>
      <pre class="preview" id="persona-preview">${text === '' ? '（当前提示词为空，请至少填写角色或启用完全自定义）' : text}</pre>`;
  }

  function patchPreview() {
    var host = document.getElementById('persona-preview');
    if (!host) return;
    var persona = (state.draft && state.draft.persona) || {};
    var text = composePromptPreview(persona);
    host.textContent = text === '' ? '（当前提示词为空，请至少填写角色或启用完全自定义）' : text;
  }

  function renderPersona() {
    if (!state.draft) return errorView('配置尚未加载');
    var persona = state.draft.persona || {};
    return html`
      ${actionBarView()}
      <section class="card">
        ${cardHead('人设', '这些字段会拼接成 QQ 会话的系统提示词')}
        <div class="card-body">
          ${rowInput('名称', '机器人自称的名字，会在提示词中出现', 'persona.name', { placeholder: '沃酱' })}
          ${rowTextarea('角色', '它是谁、擅长什么', 'persona.role', 3)}
          ${rowTextarea('说话风格', '语气、长度、表达习惯', 'persona.style', 3)}
          ${rowTextarea('必须遵守的规则', '硬性约束，每条一行更清晰', 'persona.rules', 4)}
        </div>
      </section>

      <section class="card">
        ${cardHead('预设模板', '一键填入角色 / 风格 / 规则，覆盖前会先确认')}
        <div class="card-body">
          <div class="preset-row">
            ${PERSONA_PRESETS.map(function (preset) {
              return html`<button type="button" class="btn" data-act="persona-preset" data-preset="${preset.id}">${preset.label}</button>`;
            })}
          </div>
          <div class="hint-box">模板只填充人设字段，不改变能力与模型设置；「空模板」会清空角色 / 风格 / 规则。</div>
        </div>
      </section>

      <section class="card">
        ${cardHead('完全自定义', '开启后用一段完整提示词替代上面的人设字段')}
        <div class="card-body">
          ${rowSwitch('使用自定义提示词', '开启后上方的人设字段不再生效，注意保留部署说明', 'persona.useCustom')}
          ${persona.useCustom
            ? rowTextarea('自定义提示词', '整段内容会原样作为 QQ 会话的系统提示词', 'persona.custom', 10)
            : html`<div class="form-row"><div class="form-label"><span>自定义提示词</span><div class="form-hint">当前未启用</div></div><div class="form-control"><div class="empty">开启上面的开关后即可编辑完整提示词</div></div></div>`}
        </div>
      </section>

      <section class="card">
        ${cardHead('实时预览', '随输入即时更新，与桥接实际注入的内容一致')}
        <div class="card-body">${previewView()}</div>
      </section>`;
  }

  /* ============================ 页面：能力 ============================ */

  function runtimeTools() {
    var runtime = state.overview && state.overview.bridge ? state.overview.bridge.runtime : null;
    return runtime && Array.isArray(runtime.tools) ? runtime.tools : [];
  }

  function deniedList() {
    var list = state.draft ? getPath(state.draft, 'capabilities.deniedTools') : [];
    return Array.isArray(list) ? list : [];
  }

  function filteredTools() {
    var keyword = String(state.ui.toolSearch || '').trim().toLowerCase();
    var tools = runtimeTools();
    if (keyword === '') return tools;
    return tools.filter(function (tool) {
      var name = String(tool && tool.name ? tool.name : '').toLowerCase();
      var desc = String(tool && tool.description ? tool.description : '').toLowerCase();
      return name.indexOf(keyword) >= 0 || desc.indexOf(keyword) >= 0;
    });
  }

  function toolListView() {
    var tools = filteredTools();
    var denied = deniedList();
    var total = runtimeTools().length;
    if (total === 0) {
      return html`<div class="empty">运行时还没有上报任何工具（桥接可能未启动，或工具开关被关闭）。</div>`;
    }
    if (tools.length === 0) return html`<div class="empty">没有匹配「${state.ui.toolSearch}」的工具。</div>`;
    return html`${tools.map(function (tool) {
      var name = textOf(tool.name, '');
      var on = denied.indexOf(name) >= 0;
      return html`<label class="check-row">
        <input type="checkbox" data-deny="${name}" ${attrs({ checked: on })}>
        <span class="check-main">
          <span class="check-title">${name}</span>
          <span class="check-desc">${textOf(tool.description, '（无描述）')}</span>
        </span>
      </label>`;
    })}`;
  }

  function denySummaryView() {
    var denied = deniedList();
    if (denied.length === 0) {
      return html`<span class="muted">当前没有禁止任何工具，模型可以使用全部可用工具。</span>`;
    }
    return html`<span>已禁止 ${denied.length} 个：</span>
      <span class="chips-list">${denied.map(function (name) {
        return html`<span class="chip chip-static">${name}</span>`;
      })}</span>`;
  }

  function patchToolPanel() {
    var list = document.getElementById('tool-list');
    if (list) list.innerHTML = toolListView().str;
    var summary = document.getElementById('deny-summary');
    if (summary) summary.innerHTML = denySummaryView().str;
  }

  function setDeny(name, on) {
    var list = deniedList().slice();
    var index = list.indexOf(name);
    if (on && index < 0) list.push(name);
    if (!on && index >= 0) list.splice(index, 1);
    setPath(state.draft, 'capabilities.deniedTools', list);
    patchToolPanel();
    syncDirtyUI();
  }

  function imageResultView() {
    var result = state.imageTest;
    if (!result) return '';
    if (result.ok === false) {
      return html`<div class="image-result">
        <span class="pill pill-danger">测试失败</span>
        <span>${textOf(result.error, '未知错误')}</span>
      </div>`;
    }
    return html`<div class="image-result">
      ${result.url ? html`<img src="${result.url}" alt="测试生成图片">` : ''}
      <div>
        <div class="stat-meta"><span class="pill pill-ok">测试成功</span>${result.ms !== undefined ? html`<span>耗时 ${Number(result.ms) || 0} ms</span>` : ''}${result.bytes !== undefined ? html`<span>${formatBytes(result.bytes)}</span>` : ''}</div>
        ${result.url ? html`<div class="stat-meta"><a href="${result.url}" target="_blank" rel="noopener noreferrer">${result.url}</a></div>` : ''}
        ${result.path ? html`<div class="stat-meta">已保存到 <code>${result.path}</code></div>` : ''}
      </div>
    </div>`;
  }

  function renderCapabilities() {
    if (!state.draft) return errorView('配置尚未加载');
    var image = getPath(state.draft, 'capabilities.image') || {};
    var providerOptions = Object.keys(IMAGE_PRESETS).map(function (id) {
      return { value: id, label: IMAGE_PRESETS[id].label + '（' + id + '）' };
    });
    return html`
      ${actionBarView()}
      <section class="card">
        ${cardHead('工具与联网', '总开关关闭后，模型看不到任何工具')}
        <div class="card-body">
          ${rowSwitch('工具调用', '关闭后模型只能纯文本回答，不调用任何工具', 'capabilities.tools')}
          ${rowSwitch('联网检索', '控制 web_search / web_fetch 两个内建联网工具', 'capabilities.web')}
        </div>
      </section>

      <section class="card">
        ${cardHead('工具清单', '勾选 = 禁止该工具（写入 deniedTools），未勾选表示允许')}
        <div class="card-body">
          <div class="tool-toolbar">
            <input class="input" type="search" data-ui="tool-search" value="${state.ui.toolSearch}" placeholder="搜索工具名或描述" aria-label="搜索工具">
            <button type="button" class="btn btn-sm" data-act="tools-all">全选禁止</button>
            <button type="button" class="btn btn-sm" data-act="tools-none">全不选</button>
            <span class="muted">共 ${runtimeTools().length} 个工具，按钮作用于当前筛选结果</span>
          </div>
          <div class="tool-list" id="tool-list">${toolListView()}</div>
          <div class="hint-box" id="deny-summary">${denySummaryView()}</div>
        </div>
      </section>

      <section class="card">
        ${cardHead('生图', '需要模型支持图片生成；测试使用已保存的配置')}
        <div class="card-body" id="image-form">
          ${rowSwitch('启用生图', '关闭后模型无法生成图片', 'capabilities.image.enabled')}
          ${rowSelect('服务商', '决定请求体格式：硅基流动与 OpenAI 兼容接口不同', 'capabilities.image.provider', providerOptions)}
          <div class="form-row">
            <div class="form-label"><span>服务商预设</span><div class="form-hint">一键填入服务商、baseUrl 与模型</div></div>
            <div class="form-control">
              <div class="preset-row">
                ${Object.keys(IMAGE_PRESETS).map(function (id) {
                  return html`<button type="button" class="btn btn-sm" data-act="img-preset" data-preset="${id}">${IMAGE_PRESETS[id].label}</button>`;
                })}
              </div>
            </div>
          </div>
          ${rowInput('Base URL', '接口根地址，通常以 /v1 结尾', 'capabilities.image.baseUrl', { placeholder: 'https://api.siliconflow.cn/v1' })}
          <div class="form-row">
            <div class="form-label"><label for="${fieldId('capabilities.image.apiKey')}">API Key</label><div class="form-hint">仅保存在本机配置里</div></div>
            <div class="form-control">
              <div class="form-control-row">
                <input class="input" id="${fieldId('capabilities.image.apiKey')}" type="password" data-path="capabilities.image.apiKey"
                  data-type="text" value="${textOf(image.apiKey, '')}" autocomplete="off" placeholder="sk-…">
                <button type="button" class="btn btn-sm" data-act="img-key-toggle">显示</button>
              </div>
            </div>
          </div>
          ${rowInput('模型', '生图模型名，例如 Kwai-Kolors/Kolors', 'capabilities.image.model', { placeholder: 'Kwai-Kolors/Kolors' })}
          ${rowInput('尺寸', '如 1024x1024，需服务商支持', 'capabilities.image.size', { narrow: true, placeholder: '1024x1024' })}
          ${rowInput('图片公开地址', '生成结果对外可访问的前缀，用于把图片发到 QQ', 'capabilities.image.publicBaseUrl', { placeholder: 'http://你的域名:端口' })}
          <div class="form-row">
            <div class="form-label"><span>连通性测试</span><div class="form-hint">用当前已保存的配置生成一张图；改完配置请先保存</div></div>
            <div class="form-control">
              <div class="form-control-row">
                <input class="input" type="text" data-ui="image-prompt" value="${state.ui.imagePrompt}" placeholder="测试用的提示词">
                <button type="button" class="btn" data-act="image-test" data-busy="image-test">${icon('image')}<span>测试生图</span></button>
              </div>
              ${imageResultView()}
            </div>
          </div>
        </div>
      </section>`;
  }

  /* ============================ 页面：模型 ============================ */

  /* ------------------------- 模型页：公共片段 ------------------------- */

  /* config.models.providers（草稿数组，未保存的改动也会显示）。 */
  function providerList() {
    var list = getPath(state.draft, 'models.providers');
    return Array.isArray(list) ? list : [];
  }

  /* /api/models 返回的提供方列表；提供方允许零个模型。 */
  function catalogProviders() {
    return state.models && Array.isArray(state.models.providers) ? state.models.providers : [];
  }

  function pickEntry(list, id) {
    var hit = null;
    (Array.isArray(list) ? list : []).forEach(function (item) {
      if (item && item.id === id) hit = item;
    });
    return hit;
  }

  function effortList(model) {
    return model && Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : [];
  }

  /* 与 shared/runtime.js 的凭据名规则保持一致。 */
  function routeEnvName(route) {
    return 'qqbot_' + String(route || '').replace(/[^A-Za-z0-9_]/g, '_');
  }

  function knownProtocol(api) {
    var known = false;
    MODEL_PROTOCOLS.forEach(function (item) {
      if (item.value === api) known = true;
    });
    return known;
  }

  /* 模型列表文本：每行「id」或「id 显示名」。 */
  function parseModelLines(text) {
    var out = [];
    var seen = [];
    String(text === null || text === undefined ? '' : text).split(/\r?\n/).forEach(function (line) {
      var trimmed = line.trim();
      if (trimmed === '') return;
      var parts = trimmed.split(/\s+/);
      var id = parts.shift();
      if (id === '' || seen.indexOf(id) >= 0) return;
      seen.push(id);
      out.push({ id: id, name: parts.join(' ').trim() || id });
    });
    return out;
  }

  function modelLinesText(models) {
    var list = Array.isArray(models) ? models : [];
    return list.map(function (item) {
      var id = textOf(item && item.id, '');
      var name = textOf(item && item.name, '');
      return name === '' || name === id ? id : id + ' ' + name;
    }).join('\n');
  }

  function providerSelectView(id, uiName, providers, currentId, followLabel) {
    var known = false;
    providers.forEach(function (item) {
      if (item && item.id === currentId) known = true;
    });
    return html`<select class="select" id="${id}" data-ui="${uiName}">
      ${followLabel ? html`<option value="" ${attrs({ selected: currentId === '' })}>${followLabel}</option>` : ''}
      ${providers.length === 0 && !followLabel ? html`<option value="">（暂无可用提供方）</option>` : ''}
      ${providers.map(function (item) {
        return html`<option value="${item.id}" ${attrs({ selected: item.id === currentId })}>${textOf(item.name, item.id)}</option>`;
      })}
      ${known || currentId === '' ? '' : html`<option value="${currentId}" selected>${currentId}（当前值，已不在列表中）</option>`}
    </select>`;
  }

  function modelSelectView(id, uiName, models, currentId) {
    var known = false;
    models.forEach(function (item) {
      if (item && item.id === currentId) known = true;
    });
    return html`<select class="select" id="${id}" data-ui="${uiName}">
      ${models.length === 0 ? html`<option value="">（该提供方暂无可用模型）</option>` : ''}
      ${models.map(function (item) {
        return html`<option value="${item.id}" ${attrs({ selected: item.id === currentId })}>${textOf(item.name, item.id)}</option>`;
      })}
      ${known || currentId === '' || models.length === 0 ? '' : html`<option value="${currentId}" selected>${currentId}（当前值，已不在列表中）</option>`}
    </select>`;
  }

  /* 推理强度：只有模型声明了 reasoningEfforts 才会渲染；空值表示「用模型默认值」。 */
  function effortSelectView(path, model, current) {
    var efforts = effortList(model);
    var known = false;
    efforts.forEach(function (item) {
      if (item.id === current) known = true;
    });
    var fallback = '';
    if (!known && current === '' && efforts.length > 0) {
      var preferred = pickEntry(efforts, model.defaultEffort);
      fallback = '（模型默认' + (preferred ? '：' + textOf(preferred.name, preferred.id) : '') + '）';
    }
    return html`<select class="select" id="${fieldId(path)}" data-path="${path}" data-type="select">
      ${fallback === '' ? '' : html`<option value="" selected>${fallback}</option>`}
      ${efforts.map(function (item) {
        return html`<option value="${item.id}" ${attrs({ selected: item.id === current })}>${textOf(item.name, item.id)}</option>`;
      })}
      ${known || current === '' ? '' : html`<option value="${current}" selected>${current}（当前值，已不在该模型的选项中）</option>`}
    </select>`;
  }

  /* 主干锁定的实时状态：对比桥接上报的 harnessModel 与已保存的锁定值。 */
  function harnessEffectiveView() {
    var runtime = state.overview && state.overview.bridge ? state.overview.bridge.runtime : null;
    var effective = runtime && runtime.harnessModel ? runtime.harnessModel : null;
    var lock = getPath(state.config, 'models.harness') || {};
    var text = effective ? textOf(effective.provider, '—') + '/' + textOf(effective.model, '—') : '—';
    var holding = !!(effective && lock.provider === effective.provider && lock.model === effective.model);
    var pill = !lock.lock
      ? html`<span class="pill pill-muted">锁定已关闭</span>`
      : holding
        ? html`<span class="pill pill-ok">锁定生效</span>`
        : html`<span class="pill pill-warn">等待恢复</span>`;
    return html`${pill}<span class="mono">${text}</span>${effective && effective.reasoningEffort ? html`<span class="muted">推理强度 ${effective.reasoningEffort}</span>` : ''}`;
  }

  function patchHarnessEffective() {
    var host = document.getElementById('harness-effective');
    if (!host) return;
    host.innerHTML = harnessEffectiveView().str;
  }

  /* 仅当用户仍停留在 Harness 服务页时才刷新主干状态，避免打断输入焦点。 */
  function refreshHarnessStatus() {
    var now = Date.now();
    if (state.ui.harnessAt && now - state.ui.harnessAt < 8000) return;
    state.ui.harnessAt = now;
    refreshOverviewSilently().then(function () {
      if (state.route === 'harness') patchHarnessEffective();
    });
  }

  /* ------------------------ 卡片 1：模型类型 ------------------------ */

  /* 五类模型行共用的服务商选择：第一项固定是「留空」语义；一个服务商都没有时给一行占位提示。 */
  function kindProviderSelectView(kind, label, providers, currentId, followLabel) {
    var known = false;
    providers.forEach(function (item) {
      if (item && item.id === currentId) known = true;
    });
    return html`<select class="select" id="kind-${kind}-provider" data-ui="kind-provider" data-kind="${kind}" aria-label="${label} 服务商">
      <option value="" ${attrs({ selected: currentId === '' })}>${followLabel}</option>
      ${providers.length === 0 ? html`<option value="" disabled>（尚未接入服务商）</option>` : ''}
      ${providers.map(function (item) {
        return html`<option value="${item.id}" ${attrs({ selected: item.id === currentId })}>${textOf(item.name, item.id)}</option>`;
      })}
      ${known || currentId === '' ? '' : html`<option value="${currentId}" selected>${currentId}（当前值，已不在列表中）</option>`}
    </select>`;
  }

  function kindModelSelectView(kind, label, models, currentId, emptyLabel) {
    var known = false;
    models.forEach(function (item) {
      if (item && item.id === currentId) known = true;
    });
    return html`<select class="select" id="kind-${kind}-model" data-ui="kind-model" data-kind="${kind}" aria-label="${label} 模型">
      ${models.length === 0 ? html`<option value="">${emptyLabel}</option>` : ''}
      ${models.map(function (item) {
        return html`<option value="${item.id}" ${attrs({ selected: item.id === currentId })}>${textOf(item.name, item.id)}</option>`;
      })}
      ${known || currentId === '' || models.length === 0 ? '' : html`<option value="${currentId}" selected>${currentId}（当前值，已不在列表中）</option>`}
    </select>`;
  }

  /* 一行 = 服务商 + 模型 + 测试，外加该类型特有的字段（对话的推理强度、语音的音色）。 */
  function modelKindRow(meta) {
    var kind = meta.id;
    var selection = getPath(state.draft, 'models.' + kind) || {};
    var providers = catalogProviders();
    var provider = pickEntry(providers, selection.provider);
    var models = provider && Array.isArray(provider.models) ? provider.models : [];
    var model = pickEntry(models, selection.model);
    var emptyLabel = '（该服务商暂无可用模型）';
    if (providers.length === 0) emptyLabel = '（尚未接入服务商）';
    else if (textOf(selection.provider, '') === '') emptyLabel = meta.follow;
    var efforts = kind === 'chat' ? effortList(model) : [];
    return html`<div class="form-row">
      <div class="form-label"><span>${meta.label}</span><div class="form-hint">${meta.hint}</div></div>
      <div class="form-control">
        <div class="form-control-row model-kind-fields">
          ${kindProviderSelectView(kind, meta.label, providers, textOf(selection.provider, ''), meta.follow)}
          ${kindModelSelectView(kind, meta.label, models, textOf(selection.model, ''), emptyLabel)}
          <button type="button" class="btn btn-sm" data-act="model-kind-test" data-kind="${kind}" data-busy="kind-test-${kind}">测试</button>
        </div>
        ${model && model.description ? html`<div class="form-hint">${model.description}</div>` : ''}
        ${efforts.length
          ? html`<div class="form-control-row model-kind-extra">
              <span class="unit">推理强度</span>
              ${effortSelectView('models.chat.reasoningEffort', model, textOf(selection.reasoningEffort, ''))}
            </div>`
          : ''}
        ${kind === 'tts'
          ? html`<div class="form-control-row model-kind-extra">
              <span class="unit">音色</span>
              <input class="input" id="${fieldId('models.tts.voice')}" type="text" data-path="models.tts.voice" data-type="text"
                value="${textOf(selection.voice, '')}" placeholder="留空使用服务商默认音色" autocomplete="off">
            </div>`
          : ''}
      </div>
    </div>`;
  }

  function modelKindsCard() {
    var revision = state.revision === null || state.revision === undefined ? '—' : state.revision;
    return html`<section class="card">
      ${cardHead('模型类型', '五类模型各自选择服务商与模型；留空表示不启用或跟随对话模型')}
      <div class="card-body">
        <div class="hint-box hint-box-accent"><strong>这些设置只影响 QQ 里的对话，Harness 主干（你正在用的界面）不受影响。</strong>主干锁定已经移到「Harness 服务」页。</div>
        ${MODEL_KINDS.map(modelKindRow)}
        <div class="form-hint">保存会把整份配置文档按 revision ${revision} 提交；正在进行的 QQ 对话会在下一轮生效。</div>
      </div>
    </section>`;
  }

  /* ------------------------ 卡片 2：服务商 ------------------------ */

  function providerRowView(entry, index) {
    var route = textOf(entry && entry.route, '');
    var displayName = textOf(entry && entry.displayName, route);
    var models = entry && Array.isArray(entry.models) ? entry.models : [];
    var hasKey = textOf(entry && entry.apiKey, '') !== '';
    var names = models.slice(0, 6).map(function (item) {
      return textOf(item && item.id, '');
    });
    return html`<div class="plugin-item">
      <div class="plugin-top">
        <span class="plugin-name">${displayName}</span>
        <span class="badge badge-accent">${route}</span>
        <span class="mono provider-url">${textOf(entry && entry.baseURL, '（未填写接口地址）')}</span>
        <span class="pill ${models.length > 0 ? 'pill-ok' : 'pill-muted'}">${models.length} 个模型</span>
        <span class="pill ${hasKey ? 'pill-ok' : 'pill-muted'}">${hasKey ? '已填 Key' : '未填 Key'}</span>
        <span class="provider-actions">
          <button type="button" class="btn btn-sm" data-act="provider-test" data-index="${index}" data-busy="provider-test-${route}">测试</button>
          <button type="button" class="btn btn-sm" data-act="provider-edit" data-index="${index}">编辑</button>
          <button type="button" class="btn btn-sm btn-danger" data-act="provider-remove" data-index="${index}"
            ${attrs({ 'data-confirm': '确定删除服务商「' + displayName + '」吗？保存后会从 Harness 移除这条路由。' })}>删除</button>
        </span>
      </div>
      <div class="plugin-meta">
        <span>协议 ${textOf(entry && entry.api, 'openai-completions')}</span>
        <span>凭据名 ${textOf(entry && entry.apiKeyEnv, '') === '' ? '（服务端自动生成）' : entry.apiKeyEnv}</span>
        <span>模型 ${names.length > 0 ? names.join('、') + (models.length > names.length ? ' 等' : '') : '—'}</span>
      </div>
    </div>`;
  }

  function providerEnvLabel(form) {
    var route = String(form.route || '').trim();
    if (form.envAuto) return routeEnvName(route);
    var current = textOf(form.apiKeyEnv, '');
    return current === '' ? routeEnvName(route) : current;
  }

  function providerFormView() {
    var form = state.ui.providerForm;
    if (!form) return '';
    var editing = form.index !== null && form.index !== undefined;
    return html`<div class="hint-box">${editing
      ? '正在编辑服务商：保存后写回 config.models.providers，并自动接入 Harness。'
      : '新增服务商：保存后写回 config.models.providers，并自动接入 Harness。接口地址为空或没有模型的条目不会生效。'}</div>
      <div class="form-row">
        <div class="form-label"><span>服务商预设</span><div class="form-hint">一键填入协议与接口地址，之后仍可修改</div></div>
        <div class="form-control">
          <div class="preset-row">
            ${MODEL_PROVIDER_PRESETS.map(function (item) {
              return html`<button type="button" class="btn btn-sm" data-act="provider-preset" data-preset="${item.id}">${item.label}</button>`;
            })}
          </div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-label"><label for="provider-display-name">显示名</label><div class="form-hint">控制台与 Harness 里展示的名字，留空则用路由名</div></div>
        <div class="form-control">
          <input class="input" id="provider-display-name" type="text" data-provider-field="displayName" value="${textOf(form.displayName, '')}"
            placeholder="智谱 GLM" autocomplete="off">
        </div>
      </div>
      <div class="form-row">
        <div class="form-label"><label for="provider-route">路由名 route</label><div class="form-hint">唯一标识，需以字母或数字开头，最长 64 个字符</div></div>
        <div class="form-control">
          <input class="input" id="provider-route" type="text" data-provider-field="route" value="${textOf(form.route, '')}"
            placeholder="zhipu" maxlength="64" autocomplete="off">
          <div class="form-hint">凭据名 <code id="provider-key-env">${providerEnvLabel(form)}</code>，会写入 Harness 凭据库</div>
          <div class="form-error" id="provider-route-error">${textOf(form.error, '')}</div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-label"><label for="provider-api">协议 api</label><div class="form-hint">决定请求体格式，需要与服务商一致</div></div>
        <div class="form-control">
          <select class="select" id="provider-api" data-provider-field="api">
            ${MODEL_PROTOCOLS.map(function (item) {
              return html`<option value="${item.value}" ${attrs({ selected: item.value === form.api })}>${item.label}</option>`;
            })}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-label"><label for="provider-base-url">接口地址 baseURL</label><div class="form-hint">通常以 /v1 结尾，结尾的斜杠会被去掉</div></div>
        <div class="form-control">
          <input class="input" id="provider-base-url" type="text" data-provider-field="baseURL" value="${textOf(form.baseURL, '')}"
            placeholder="https://open.bigmodel.cn/api/paas/v4" autocomplete="off">
        </div>
      </div>
      <div class="form-row">
        <div class="form-label"><label for="provider-api-key">API Key</label><div class="form-hint">只保存在本机运行时配置里；留空表示沿用已有凭据</div></div>
        <div class="form-control">
          <div class="form-control-row">
            <input class="input" id="provider-api-key" type="password" data-provider-field="apiKey" value="${textOf(form.apiKey, '')}"
              placeholder="sk-…" autocomplete="off">
            <button type="button" class="btn btn-sm" data-act="provider-key-toggle">显示</button>
          </div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-label"><label for="provider-models">模型列表</label><div class="form-hint">每行一个模型：<code>id</code> 或 <code>id 显示名</code></div></div>
        <div class="form-control">
          <textarea class="textarea" id="provider-models" rows="6" data-provider-field="models"
            placeholder="glm-4.6 GLM-4.6">${textOf(form.models, '')}</textarea>
          <div class="form-control-row">
            <button type="button" class="btn btn-sm" data-act="provider-discover" data-busy="provider-discover">拉取模型</button>
            <span class="muted">用上面的地址与 Key 调用服务商的模型列表接口，成功后覆盖本框内容</span>
          </div>
        </div>
      </div>
      <div class="form-row">
        <div class="form-label"><span>保存</span><div class="form-hint">保存后约 1.5 秒重新拉取模型目录</div></div>
        <div class="form-control">
          <div class="form-control-row">
            <button type="button" class="btn btn-primary" data-act="provider-save" data-busy="provider-save">保存</button>
            <button type="button" class="btn" data-act="provider-cancel">取消</button>
          </div>
        </div>
      </div>`;
  }

  function providersCard() {
    var list = providerList();
    var form = state.ui.providerForm;
    var actions = form
      ? ''
      : html`<button type="button" class="btn btn-sm btn-primary" data-act="provider-add">${icon('plus')}<span>新增服务商</span></button>`;
    return html`<section class="card">
      ${cardHead('接入其他模型服务商', '写入 config.models.providers 数组；保存后由桥接注册到 Harness 的模型路由', actions)}
      <div class="card-body">
        ${list.length === 0
          ? html`<div class="empty">还没有接入任何服务商，点右上角「新增服务商」开始。</div>`
          : html`${list.map(function (entry, index) {
              return providerRowView(entry, index);
            })}`}
        ${providerFormView()}
      </div>
    </section>`;
  }

  /* ---------------------- 卡片 3：主干锁定（Harness 服务页） ---------------------- */

  function harnessModelCard() {
    var harness = getPath(state.draft, 'models.harness') || {};
    var providers = catalogProviders();
    var provider = pickEntry(providers, harness.provider);
    var models = provider && Array.isArray(provider.models) ? provider.models : [];
    var model = pickEntry(models, harness.model);
    var efforts = effortList(model);
    return html`<section class="card">
      ${cardHead('主干锁定', '把 Harness 主干（Harness 界面自己的会话）钉在这个模型上：一旦有别的操作把它改掉，QQ 机器人会在 20 秒内自动恢复，并写一条日志。')}
      <div class="card-body">
        ${rowSwitch('锁定主干模型', '可选功能，默认关闭；关闭后不再自动恢复，下面的服务商与模型就是恢复目标', 'models.harness.lock')}
        <div class="form-row">
          <div class="form-label"><label for="harness-provider">提供方</label><div class="form-hint">锁定目标，保存后生效</div></div>
          <div class="form-control">${providerSelectView('harness-provider', 'harness-provider', providers, harness.provider)}</div>
        </div>
        <div class="form-row">
          <div class="form-label"><label for="harness-model">模型</label><div class="form-hint">可选项由提供方决定</div></div>
          <div class="form-control">${modelSelectView('harness-model', 'harness-model', models, harness.model)}</div>
        </div>
        ${efforts.length
          ? html`<div class="form-row">
              <div class="form-label"><label for="${fieldId('models.harness.reasoningEffort')}">推理强度</label><div class="form-hint">越高越慢，但推理更充分</div></div>
              <div class="form-control">${effortSelectView('models.harness.reasoningEffort', model, harness.reasoningEffort)}</div>
            </div>`
          : ''}
        <div class="form-row">
          <div class="form-label"><span>当前生效</span><div class="form-hint">桥接上报的 Harness 主干模型，用来确认锁定是否生效</div></div>
          <div class="form-control"><div class="form-control-row" id="harness-effective">${harnessEffectiveView()}</div></div>
        </div>
      </div>
    </section>`;
  }

  function renderModels() {
    if (!state.draft) return errorView('配置尚未加载');
    return html`
      ${actionBarView()}
      ${modelKindsCard()}
      ${providersCard()}`;
  }

  /* ========================== 页面：Harness 服务 ========================== */

  function harnessApiKeyRow() {
    var apiKey = textOf(getPath(state.draft, 'harness.apiKey'), '');
    return html`<div class="form-row">
      <div class="form-label"><label for="${fieldId('harness.apiKey')}">API Key</label><div class="form-hint">只保存在本机配置里，留空表示不鉴权</div></div>
      <div class="form-control">
        <div class="form-control-row">
          <input class="input" id="${fieldId('harness.apiKey')}" type="password" data-path="harness.apiKey"
            data-type="text" value="${apiKey}" autocomplete="off" placeholder="sk-…">
          <button type="button" class="btn btn-sm" data-act="harness-key-toggle">显示</button>
        </div>
      </div>
    </div>`;
  }

  function harnessServiceCard() {
    return html`<section class="card">
      ${cardHead('Harness 服务', '把控制台接到一个 DeepSeek Harness 服务上，方便后续在 Harness 里继续开发这个项目；不填也能独立运行。')}
      <div class="card-body">
        <div class="form-row">
          <div class="form-label"><span>服务商预设</span><div class="form-hint">一键填入服务商与接口地址，之后仍可修改</div></div>
          <div class="form-control">
            <div class="preset-row">
              ${HARNESS_PRESETS.map(function (item) {
                return html`<button type="button" class="btn btn-sm" data-act="harness-preset" data-preset="${item.id}">${item.label}</button>`;
              })}
            </div>
          </div>
        </div>
        ${rowSwitch('启用 Harness 服务', '关闭后控制台不连接 Harness；QQ 机器人仍然独立运行', 'harness.enabled')}
        ${rowInput('服务商', '服务商标识，例如 deepseek', 'harness.provider', { placeholder: 'deepseek' })}
        ${rowInput('接口地址', 'Harness 服务的根地址', 'harness.baseUrl', { placeholder: 'https://api.deepseek.com' })}
        ${harnessApiKeyRow()}
        ${rowInput('默认模型', '留空表示用服务端的默认模型', 'harness.model', { placeholder: 'deepseek-chat' })}
        <div class="form-row">
          <div class="form-label"><span>保存与测试</span><div class="form-hint">测试用的是上面当前填写的地址与 Key，可以先测再保存</div></div>
          <div class="form-control">
            <div class="form-control-row">
              <button type="button" class="btn btn-primary" data-act="config-save" data-busy="config-save" data-inline-save ${isConfigDirty() ? '' : raw('disabled data-locked="config"')}>保存</button>
              <button type="button" class="btn" data-act="harness-test" data-busy="harness-test">${icon('server')}<span>测试连接</span></button>
            </div>
          </div>
        </div>
      </div>
    </section>`;
  }

  function renderHarness() {
    if (!state.draft) return errorView('配置尚未加载');
    return html`
      ${actionBarView()}
      ${harnessServiceCard()}
      ${harnessModelCard()}`;
  }

  /* ============================ 页面：插件 ============================ */

  function sourceBadge(source) {
    var map = { builtin: '内置', path: '本地目录', url: '远程链接' };
    var label = map[source] || textOf(source, '未知来源');
    return html`<span class="badge${source === 'builtin' ? ' badge-accent' : ''}">${label}</span>`;
  }

  function pluginItemView(plugin) {
    var id = textOf(plugin.id, '');
    var editing = state.ui.pluginEdit === id && state.ui.pluginDraft;
    var draft = editing ? state.ui.pluginDraft : null;
    var commands = Array.isArray(plugin.commands) ? plugin.commands : [];
    return html`<div class="plugin-item">
      <div class="plugin-top">
        <span class="plugin-name">${textOf(plugin.name, id)}</span>
        <span class="badge">v${textOf(plugin.version, '0.0.0')}</span>
        ${sourceBadge(plugin.source)}
        ${plugin.enabled ? html`<span class="pill pill-ok">已启用</span>` : html`<span class="pill pill-muted">已停用</span>`}
        <label class="switch">
          <input type="checkbox" data-toggle-plugin="${id}" aria-label="启用或停用插件" ${attrs({ checked: !!plugin.enabled })}>
          <span class="track"></span>
          <span class="switch-label">${plugin.enabled ? '启用' : '停用'}</span>
        </label>
      </div>
      <div class="plugin-meta">
        <span>作者 ${textOf(plugin.author, '未知')}</span>
        <span>安装于 ${plugin.installedAt ? formatTime(plugin.installedAt) : '—'}</span>
        <span>提示词 ${Number(plugin.promptChars) || 0} 字符</span>
      </div>
      ${plugin.description ? html`<div class="plugin-desc">${plugin.description}</div>` : ''}
      ${plugin.error ? html`<div class="plugin-error">插件有问题：${plugin.error}</div>` : ''}
      ${commands.length
        ? html`<div class="plugin-cmds">${commands.map(function (command) {
            return html`<span class="plugin-cmd"><code>${textOf(command.pattern, '')}</code>${command.label ? html`<span>${command.label}</span>` : ''}</span>`;
          })}</div>`
        : html`<div class="plugin-meta"><span>没有快捷命令，仅注入提示词</span></div>`}
      ${editing
        ? html`<div class="plugin-form">
            <div>
              <span class="field-label">名称</span>
              <input class="input" type="text" data-plugin-field="name" value="${textOf(draft.name, '')}">
            </div>
            <div>
              <span class="field-label">描述</span>
              <input class="input" type="text" data-plugin-field="description" value="${textOf(draft.description, '')}">
            </div>
            <div>
              <span class="field-label">提示词</span>
              <textarea class="textarea" rows="4" data-plugin-field="prompt"
                placeholder="${draft.promptKnown ? '这段文字会注入到人设提示词里，可以清空' : '留空表示保持当前内容不变（当前 ' + (Number(plugin.promptChars) || 0) + ' 字符）'}">${textOf(draft.prompt, '')}</textarea>
            </div>
            <div class="plugin-form-actions">
              <button type="button" class="btn btn-primary" data-act="plugin-save" data-id="${id}" data-busy="plugin-save-${id}">保存</button>
              <button type="button" class="btn" data-act="plugin-cancel">取消</button>
              <span class="muted" id="plugin-dirty-note">${isPluginDraftDirty(draft) ? '有未保存的修改' : '未修改'}</span>
            </div>
          </div>`
        : ''}
      ${editing
        ? ''
        : html`<div class="plugin-actions">
            <button type="button" class="btn btn-sm" data-act="plugin-edit" data-id="${id}">编辑</button>
            <button type="button" class="btn btn-sm btn-danger" data-act="plugin-uninstall" data-id="${id}" data-busy="plugin-remove-${id}"
              data-confirm="确定要卸载插件「${textOf(plugin.name, id)}」吗？该插件的目录会被删除。">卸载</button>
          </div>`}
    </div>`;
  }

  function catalogItemView(entry) {
    var id = textOf(entry.id, '');
    return html`<div class="catalog-item">
      <div class="catalog-main">
        <div class="plugin-top">
          <span class="plugin-name">${textOf(entry.name, id)}</span>
          <span class="badge">v${textOf(entry.version, '0.0.0')}</span>
          ${entry.installed ? html`<span class="pill pill-ok">已安装</span>` : ''}
        </div>
        ${entry.description ? html`<div class="plugin-desc">${entry.description}</div>` : ''}
        <div class="plugin-meta"><span>作者 ${textOf(entry.author, '未知')}</span></div>
      </div>
      <button type="button" class="btn btn-sm${entry.installed ? '' : ' btn-primary'}" data-act="plugin-install"
        data-source="catalog" data-id="${id}" data-busy="install-${id}" ${entry.installed ? raw('disabled') : ''}>${entry.installed ? '已安装' : '安装'}</button>
    </div>`;
  }

  function renderPlugins() {
    var data = state.plugins;
    if (!data) return emptyCard('插件列表尚未加载');
    var installed = Array.isArray(data.installed) ? data.installed : [];
    var catalog = Array.isArray(data.catalog) ? data.catalog : [];
    var tab = state.ui.installTab;
    return html`
      <section class="card">
        ${cardHead('已安装插件', '共 ' + installed.length + ' 个，启用 ' + installed.filter(function (p) { return p && p.enabled; }).length + ' 个')}
        <div class="card-body">
          ${installed.length ? installed.map(pluginItemView) : html`<div class="empty">还没有安装任何插件。</div>`}
        </div>
      </section>

      <section class="card">
        ${cardHead('安装新插件', '支持内置目录、本地目录与远程 tar.gz 链接')}
        <div class="card-body">
          <div class="tabs">
            <button type="button" class="tab${tab === 'catalog' ? ' is-active' : ''}" data-act="install-tab" data-tab="catalog">内置目录</button>
            <button type="button" class="tab${tab === 'path' ? ' is-active' : ''}" data-act="install-tab" data-tab="path">本地目录</button>
            <button type="button" class="tab${tab === 'url' ? ' is-active' : ''}" data-act="install-tab" data-tab="url">远程链接</button>
          </div>
          <div class="tab-panel">
            ${tab === 'catalog'
              ? (catalog.length
                  ? catalog.map(catalogItemView)
                  : html`<div class="empty">内置目录为空。</div>`)
              : ''}
            ${tab === 'path'
              ? html`<div class="form-row">
                  <div class="form-label"><label for="install-path">插件目录</label><div class="form-hint">服务器上的绝对路径，目录内需有 plugin.json</div></div>
                  <div class="form-control">
                    <div class="form-control-row">
                      <input class="input" id="install-path" type="text" data-ui="install-path" value="${state.ui.installPath}" placeholder="/data/plugins/my-plugin">
                      <button type="button" class="btn btn-primary" data-act="plugin-install" data-source="path" data-busy="install-path">安装</button>
                    </div>
                  </div>
                </div>`
              : ''}
            ${tab === 'url'
              ? html`<div class="form-row">
                  <div class="form-label"><label for="install-url">tar.gz 链接</label><div class="form-hint">下载并解压到插件目录，包内需有 plugin.json</div></div>
                  <div class="form-control">
                    <div class="form-control-row">
                      <input class="input" id="install-url" type="text" data-ui="install-url" value="${state.ui.installUrl}" placeholder="https://example.com/plugin.tar.gz">
                      <button type="button" class="btn btn-primary" data-act="plugin-install" data-source="url" data-busy="install-url">安装</button>
                    </div>
                  </div>
                </div>`
              : ''}
          </div>
          <div class="hint-box">插件格式：一个目录 + <code>plugin.json</code>。清单支持 <code>name</code>、<code>version</code>、<code>description</code>、<code>author</code>、<code>prompt</code>（注入人设的提示词）与 <code>commands</code>（正则快捷命令，不消耗模型调用）。安装后可在上方启用或编辑。</div>
        </div>
      </section>`;
  }

  /* ============================ 页面：日志 ============================ */

  function logLinesView() {
    var lines = state.logs && Array.isArray(state.logs.lines) ? state.logs.lines : [];
    if (lines.length === 0) return raw('<div class="empty">暂无日志内容。</div>');
    return html`${lines.map(function (line) {
      var level = String((line && line.level) || '').toLowerCase();
      if (LEVELS.indexOf(level) < 0) level = 'raw';
      return html`<div class="log-line level-${level}"><span class="log-time">${shortTime(line && line.time)}</span><span class="log-text">${textOf(line && line.text, '')}</span></div>`;
    })}`;
  }

  function renderLogs() {
    var lines = state.logs && Array.isArray(state.logs.lines) ? state.logs.lines : [];
    var path = state.logs && state.logs.path ? state.logs.path : state.overview && state.overview.log ? state.overview.log.path : '';
    var bytes = state.logs && typeof state.logs.bytes === 'number' ? state.logs.bytes : null;
    return html`
      <section class="card">
        <div class="card-head">
          <div>
            <h2>运行日志</h2>
            <div class="log-meta">
              <span>${textOf(path, '—')}</span>
              ${bytes === null ? '' : html`<span>${formatBytes(bytes)}</span>`}
              <span>显示 ${lines.length} 行，最新的在最后</span>
            </div>
          </div>
          <div class="card-head-actions log-toolbar">
            <select class="select" data-ui="log-lines" aria-label="显示行数">
              ${[100, 300, 1000].map(function (n) {
                return html`<option value="${n}" ${attrs({ selected: Number(state.ui.logLines) === n })}>${n} 行</option>`;
              })}
            </select>
            <label class="switch">
              <input type="checkbox" data-ui="log-auto" aria-label="自动刷新日志" ${attrs({ checked: !!state.ui.logAuto })}>
              <span class="track"></span>
              <span class="switch-label">自动刷新</span>
            </label>
            <button type="button" class="btn btn-sm" data-act="logs-refresh" data-busy="logs-refresh">${icon('refresh')}<span>刷新</span></button>
            <button type="button" class="btn btn-sm" data-act="logs-download">${icon('download')}<span>下载</span></button>
          </div>
        </div>
        <div class="log-view" id="log-view" role="log" aria-label="运行日志" tabindex="0">${logLinesView()}</div>
      </section>`;
  }

  function patchLogView() {
    var view = document.getElementById('log-view');
    if (!view) {
      renderContent();
      return;
    }
    var atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
    if (atBottom) state.ui.logStick = true;
    view.innerHTML = logLinesView().str;
    var meta = document.querySelector('.log-meta');
    if (meta) {
      var lines = state.logs && Array.isArray(state.logs.lines) ? state.logs.lines : [];
      var bytes = state.logs && typeof state.logs.bytes === 'number' ? state.logs.bytes : null;
      var path = state.logs && state.logs.path ? state.logs.path : '';
      meta.innerHTML = html`<span>${textOf(path, '—')}</span>${bytes === null ? '' : html`<span>${formatBytes(bytes)}</span>`}<span>显示 ${lines.length} 行，最新的在最后</span>`.str;
    }
    if (state.ui.logStick) view.scrollTop = view.scrollHeight;
  }

  /* ============================== 页面表 ============================== */

  var PAGES = {
    connect: {
      title: '连接',
      subtitle: '填写 QQ 机器人凭据，把控制台接到 QQ',
      render: renderConnect,
      after: null
    },
    overview: {
      title: '总览',
      subtitle: '运行状态、最近活动与运行环境',
      render: renderOverview,
      after: null
    },
    bot: {
      title: '机器人',
      subtitle: '回复行为、欢迎语与白名单',
      render: renderBot,
      after: null
    },
    persona: {
      title: '人格',
      subtitle: '人设字段、预设模板与提示词预览',
      render: renderPersona,
      after: null
    },
    capabilities: {
      title: '能力',
      subtitle: '工具调用、联网检索与生图',
      render: renderCapabilities,
      after: null
    },
    models: {
      title: '模型',
      subtitle: 'QQ 会话的五类模型与服务商接入',
      render: renderModels,
      after: null
    },
    harness: {
      title: 'Harness 服务',
      subtitle: '接入 DeepSeek Harness 服务与可选的主干锁定',
      render: renderHarness,
      after: function () {
        refreshHarnessStatus();
      }
    },
    plugins: {
      title: '插件',
      subtitle: '已安装插件管理与新插件安装',
      render: renderPlugins,
      after: null
    },
    logs: {
      title: '日志',
      subtitle: '查看与下载运行日志',
      render: renderLogs,
      after: function () {
        var view = document.getElementById('log-view');
        if (!view) return;
        view.addEventListener(
          'scroll',
          function () {
            state.ui.logStick = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
          },
          { passive: true }
        );
        if (state.ui.logStick) view.scrollTop = view.scrollHeight;
      }
    }
  };

  /* ============================== 数据加载 ============================== */

  var PAGE_LOADS = {
    connect: ['config', 'overview'],
    overview: ['overview'],
    bot: ['config'],
    persona: ['config'],
    capabilities: ['config', 'overview'],
    models: ['config', 'models', 'overview'],
    harness: ['config', 'models', 'overview'],
    plugins: ['plugins'],
    logs: ['logs']
  };

  function loadOverview() {
    return api('/overview').then(function (data) {
      state.overview = data && typeof data === 'object' ? data : {};
      state.loaded.overview = true;
      patchTopStatus();
      patchFooter();
    });
  }

  function loadConfig() {
    return api('/config').then(function (data) {
      var config = data && data.config && typeof data.config === 'object' ? data.config : {};
      state.config = config;
      state.revision = data && typeof data.revision === 'number' ? data.revision : null;
      state.updatedAt = data && typeof data.updatedAt === 'string' ? data.updatedAt : null;
      state.draft = clone(config);
      state.loaded.config = true;
    });
  }

  var LOADERS = {
    overview: loadOverview,
    config: loadConfig,
    models: function () {
      return api('/models').then(function (data) {
        state.models = data && typeof data === 'object' ? data : { current: {}, providers: [] };
        state.loaded.models = true;
      });
    },
    plugins: function () {
      return api('/plugins').then(function (data) {
        state.plugins = {
          installed: data && Array.isArray(data.installed) ? data.installed : [],
          catalog: data && Array.isArray(data.catalog) ? data.catalog : []
        };
        state.loaded.plugins = true;
      });
    },
    logs: function () {
      return api('/logs?lines=' + encodeURIComponent(state.ui.logLines)).then(function (data) {
        state.logs = {
          lines: data && Array.isArray(data.lines) ? data.lines : [],
          path: data && typeof data.path === 'string' ? data.path : '',
          bytes: data && typeof data.bytes === 'number' ? data.bytes : 0
        };
        state.loaded.logs = true;
      });
    }
  };

  function loadPage(route, force, forceAll) {
    /* 默认凭据未修改前不要碰任何数据接口（后端会返回 403）。 */
    if (state.session.mustChange) return Promise.resolve();
    var needs = PAGE_LOADS[route] || [];
    var todo = needs.filter(function (name) {
      if (!force && state.loaded[name]) return false;
      /* 不用远端配置覆盖尚未保存的草稿（只有用户明确确认过的刷新才强制覆盖）。 */
      if (name === 'config' && !forceAll && state.loaded.config && isConfigDirty()) return false;
      return true;
    });
    if (todo.length === 0) return Promise.resolve();
    state.loading[route] = true;
    if (state.route === route) renderContent();
    var failures = [];
    var chain = Promise.resolve();
    todo.forEach(function (name) {
      chain = chain.then(function () {
        return LOADERS[name]().catch(function (err) {
          if (err && err.status === 401) throw err;
          failures.push(err && err.message ? err.message : '加载失败');
        });
      });
    });
    return chain
      .catch(function () {
        /* 401 已由 handleUnauthorized 处理 */
      })
      .then(function () {
        if (state.route !== route) return;
        delete state.loading[route];
        state.errors[route] = failures.length ? failures.join('；') : null;
        renderContent();
      });
  }

  function refreshOverviewSilently() {
    return api('/overview')
      .then(function (data) {
        state.overview = data && typeof data === 'object' ? data : {};
        state.loaded.overview = true;
        patchTopStatus();
        patchFooter();
        if (state.route === 'overview') renderContent();
      })
      .catch(function () {
        /* 静默失败：总览会在下次进入页面时重新加载 */
      });
  }

  /* ============================== 动作：登录 ============================== */

  function doLogin() {
    var username = String(state.ui.username || '');
    var password = String(state.ui.password || '');
    if (username.trim() === '') {
      toast('error', '请输入用户名');
      var userBox = document.getElementById('login-username');
      if (userBox) userBox.focus();
      return;
    }
    if (password === '') {
      toast('error', '请输入密码');
      var passBox = document.getElementById('login-password');
      if (passBox) passBox.focus();
      return;
    }
    if (isBusy('login')) return;
    busySet('login', true);
    syncBusy();
    api('/login', { method: 'POST', body: { username: username, password: password } })
      .then(function (res) {
        var mustChange = !!(res && res.mustChange);
        state.ui.password = '';
        state.session = { checked: true, authed: true, mustChange: mustChange };
        resetData();
        if (mustChange) {
          /* 默认凭据未改：不加载任何数据，先让用户改账号密码。 */
          state.ui.credUsername = textOf(res && res.username, '') || state.ui.username;
          render();
          toast('info', '首次登录，请先修改默认账号密码');
          return undefined;
        }
        render();
        toast('success', '登录成功，正在加载数据');
        /* 没有指定页面时，登录后默认停在「连接」页。 */
        if (!window.location.hash) window.location.hash = '#/connect';
        return loadPage(state.route, true);
      })
      .catch(function (err) {
        /* 登录接口的 401 表示口令错误，必须原样提示（api() 不会对它触发掉线处理）。 */
        toast('error', err && err.message ? err.message : '登录失败');
      })
      .then(function () {
        busySet('login', false);
        syncBusy();
      });
  }

  function doLogout() {
    if (isBusy('logout')) return;
    busySet('logout', true);
    syncBusy();
    api('/logout', { method: 'POST', body: {} })
      .then(function () {
        toast('success', '已退出登录');
      })
      .catch(function (err) {
        toast('error', err && err.message ? err.message : '退出失败');
      })
      .then(function () {
        busySet('logout', false);
        state.session = { checked: true, authed: false, mustChange: false };
        state.ui.password = '';
        resetData();
        render();
      });
  }

  /* ======================= 动作：首次登录修改凭据 ======================= */

  function setCredentialError(message, focusId) {
    state.ui.credError = textOf(message, '');
    var box = document.getElementById('cred-error');
    if (box) box.textContent = state.ui.credError;
    if (focusId) {
      var input = document.getElementById(focusId);
      if (input) input.focus();
    }
  }

  /* 客户端校验只是方便用户；服务端的错误信息始终原样展示。 */
  function credentialError() {
    var current = String(state.ui.credCurrent || '');
    var username = String(state.ui.credUsername || '').trim();
    var password = String(state.ui.credPassword || '');
    var confirm = String(state.ui.credConfirm || '');
    if (current === '') return { message: '请输入当前密码', focus: 'cred-current' };
    if (username === '') return { message: '新用户名不能为空', focus: 'cred-username' };
    if (password.length < 6) return { message: '新密码至少 6 位', focus: 'cred-password' };
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      return { message: '新密码必须同时包含大写字母、小写字母和数字', focus: 'cred-password' };
    }
    if (password !== confirm) return { message: '两次输入的新密码不一致', focus: 'cred-confirm' };
    return null;
  }

  function changeCredentials() {
    if (isBusy('cred-save')) return;
    var invalid = credentialError();
    if (invalid) {
      setCredentialError(invalid.message, invalid.focus);
      return;
    }
    var username = String(state.ui.credUsername || '').trim();
    busySet('cred-save', true);
    syncBusy();
    api('/change-credentials', {
      method: 'POST',
      body: {
        currentPassword: String(state.ui.credCurrent || ''),
        username: username,
        password: String(state.ui.credPassword || '')
      }
    })
      .then(function () {
        /* 服务端会丢弃所有会话：直接回到登录页，不自动进入控制台。 */
        state.session = { checked: true, authed: false, mustChange: false };
        state.ui.username = username;
        state.ui.password = '';
        resetData();
        render();
        toast('success', '修改成功，请用新账号重新登录');
      })
      .catch(function (err) {
        var message = err && err.message ? err.message : '修改失败，请重试';
        /* 401 已经由 api() 送回登录页，这里只需要处理还在本页时的情况。 */
        if (!state.session.mustChange) return;
        setCredentialError(message, 'cred-current');
        toast('error', message);
      })
      .then(function () {
        busySet('cred-save', false);
        syncBusy();
      });
  }

  /* ============================== 动作：配置 ============================== */

  function normalizeConfig(input) {
    var cfg = clone(input || {});
    var qq = cfg.qq && typeof cfg.qq === 'object' ? cfg.qq : (cfg.qq = {});
    ['appId', 'clientSecret'].forEach(function (key) {
      qq[key] = textOf(qq[key], '');
    });

    var bot = cfg.bot && typeof cfg.bot === 'object' ? cfg.bot : (cfg.bot = {});
    ['enabled', 'replyToGroup', 'replyToC2C', 'ackEnabled', 'includeSenderHeader'].forEach(function (key) {
      bot[key] = !!bot[key];
    });
    ['ackText', 'welcomeGroupText', 'welcomeFriendText'].forEach(function (key) {
      bot[key] = textOf(bot[key], '');
    });
    bot.maxChars = clampInt(bot.maxChars, 200, 4000, 1500);
    bot.maxChunks = clampInt(bot.maxChunks, 1, 4, 4);
    bot.allowedUserOpenids = cleanList(bot.allowedUserOpenids);
    bot.allowedGroupOpenids = cleanList(bot.allowedGroupOpenids);

    var persona = cfg.persona && typeof cfg.persona === 'object' ? cfg.persona : (cfg.persona = {});
    ['name', 'role', 'style', 'rules', 'custom'].forEach(function (key) {
      persona[key] = textOf(persona[key], '');
    });
    persona.useCustom = !!persona.useCustom;

    var capabilities = cfg.capabilities && typeof cfg.capabilities === 'object' ? cfg.capabilities : (cfg.capabilities = {});
    capabilities.tools = !!capabilities.tools;
    capabilities.web = !!capabilities.web;
    capabilities.deniedTools = cleanList(capabilities.deniedTools);
    var image = capabilities.image && typeof capabilities.image === 'object' ? capabilities.image : (capabilities.image = {});
    image.enabled = !!image.enabled;
    ['provider', 'baseUrl', 'apiKey', 'model', 'size', 'publicBaseUrl'].forEach(function (key) {
      image[key] = textOf(image[key], '');
    });

    var harness = cfg.harness && typeof cfg.harness === 'object' ? cfg.harness : (cfg.harness = {});
    harness.enabled = !!harness.enabled;
    ['provider', 'baseUrl', 'apiKey', 'model'].forEach(function (key) {
      harness[key] = textOf(harness[key], '');
    });

    var models = cfg.models && typeof cfg.models === 'object' ? cfg.models : (cfg.models = {});
    var chat = models.chat && typeof models.chat === 'object' ? models.chat : (models.chat = {});
    ['provider', 'model', 'reasoningEffort'].forEach(function (key) {
      chat[key] = textOf(chat[key], '');
    });
    chat.applyAsDefault = !!chat.applyAsDefault;

    /* 其余四类模型默认全空，新装时页面上就是「留空」状态。 */
    [['stt', []], ['tts', ['voice']], ['embedding', []], ['rerank', []]].forEach(function (spec) {
      var kind = spec[0];
      var box = models[kind] && typeof models[kind] === 'object' ? models[kind] : (models[kind] = {});
      box.provider = textOf(box.provider, '');
      box.model = textOf(box.model, '');
      spec[1].forEach(function (key) {
        box[key] = textOf(box[key], '');
      });
    });

    var harnessModel = models.harness && typeof models.harness === 'object' ? models.harness : (models.harness = {});
    harnessModel.lock = !!harnessModel.lock;
    ['provider', 'model', 'reasoningEffort'].forEach(function (key) {
      harnessModel[key] = textOf(harnessModel[key], '');
    });

    models.providers = Array.isArray(models.providers) ? models.providers : [];

    return cfg;
  }

  /* opts.message 可替换成功提示；opts.onSaved 在写入成功后调用（模型页用来延迟重拉模型目录）。 */
  function saveConfig(opts) {
    var options = opts && typeof opts === 'object' ? opts : {};
    if (!state.draft || !isConfigDirty() || isBusy('config-save')) return;
    var payload = normalizeConfig(state.draft);
    busySet('config-save', true);
    syncBusy();
    api('/config', { method: 'PUT', body: { config: payload, revision: state.revision } })
      .then(function (res) {
        var revision = res && typeof res.revision === 'number' ? res.revision : state.revision;
        if (Object.prototype.hasOwnProperty.call(payload, 'revision')) payload.revision = revision;
        state.config = payload;
        state.draft = clone(payload);
        state.revision = revision;
        state.updatedAt = new Date().toISOString();
        state.loaded.config = true;
        state.errors[state.route] = null;
        toast('success', options.message || '配置已保存');
        renderConfigPages();
        if (typeof options.onSaved === 'function') options.onSaved();
        return refreshOverviewSilently();
      })
      .catch(function (err) {
        if (!err) return;
        if (err.status === 409) {
          toast('error', err.message, { label: '重新加载配置', act: 'config-reload' });
        } else if (err.status !== 401) {
          toast('error', err.message || '保存失败');
        }
      })
      .then(function () {
        busySet('config-save', false);
        syncDirtyUI();
      });
  }

  function reloadConfig(force) {
    if (!force && isConfigDirty() && !window.confirm('重新加载将丢弃本地未保存的修改，确定继续吗？')) return;
    if (isBusy('config-reload')) return;
    busySet('config-reload', true);
    syncBusy();
    loadConfig()
      .then(function () {
        if (state.errors[state.route]) state.errors[state.route] = null;
        toast('success', '配置已重新加载');
        renderConfigPages();
        return refreshOverviewSilently();
      })
      .catch(function (err) {
        if (err && err.status !== 401) toast('error', err && err.message ? err.message : '重新加载失败');
      })
      .then(function () {
        busySet('config-reload', false);
        syncBusy();
      });
  }

  function resetDraft() {
    if (!isConfigDirty()) return;
    if (!window.confirm('放弃当前未保存的修改？')) return;
    state.draft = clone(state.config);
    renderContent();
  }

  /* ============================== 动作：控制 ============================== */

  function runControl(action, fallback) {
    var key = 'control-' + action;
    if (isBusy(key)) return;
    busySet(key, true);
    syncBusy();
    api('/control', { method: 'POST', body: { action: action } })
      .catch(function (err) {
        /* 服务端若不认识这个指令（HTTP 400），退回文档里的等效指令再试一次。 */
        if (fallback && err && err.status === 400) {
          return api('/control', { method: 'POST', body: { action: fallback } });
        }
        throw err;
      })
      .then(function (res) {
        toast('success', res && res.message ? res.message : '操作成功');
        return refreshOverviewSilently();
      })
      .catch(function (err) {
        if (err && err.status !== 401) toast('error', err && err.message ? err.message : '操作失败');
      })
      .then(function () {
        busySet(key, false);
        syncBusy();
        renderIf('overview');
      });
  }

  /* ============================ 动作：连接页 ============================ */

  function toggleConnectSecretVisibility(button) {
    var input = document.getElementById(fieldId('qq.clientSecret'));
    if (!input) return;
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? '隐藏' : '显示';
  }

  /* 校验的是已经保存进配置的 QQ 凭据，服务端无论成败都会给一句 message。 */
  function testConnection() {
    if (isBusy('connect-test')) return;
    busySet('connect-test', true);
    syncBusy();
    api('/control', { method: 'POST', body: { action: 'test-connection' } })
      .then(function (res) {
        controlToast(res, '连接测试已完成');
        return refreshOverviewSilently();
      })
      .catch(function (err) {
        if (err && err.status !== 401) toast('error', err && err.message ? err.message : '测试连接失败');
      })
      .then(function () {
        busySet('connect-test', false);
        syncBusy();
        if (state.route === 'connect') patchConnectStatus();
      });
  }

  /* ========================== 动作：Harness 服务页 ========================== */

  function applyHarnessPreset(id) {
    var preset = null;
    HARNESS_PRESETS.forEach(function (item) {
      if (item.id === id) preset = item;
    });
    if (!preset || !state.draft) return;
    var harness = getPath(state.draft, 'harness');
    if (!harness || typeof harness !== 'object') {
      setPath(state.draft, 'harness', {});
      harness = getPath(state.draft, 'harness');
    }
    harness.provider = preset.provider;
    harness.baseUrl = preset.baseUrl;
    renderContent();
    if (preset.id === 'custom') {
      var input = document.getElementById(fieldId('harness.provider'));
      if (input) input.focus();
      toast('info', '已切换到自定义，请自行填写服务商与接口地址');
      return;
    }
    toast('info', '已填入「' + preset.label + '」的服务商与接口地址，记得保存');
  }

  function toggleHarnessKeyVisibility(button) {
    var input = document.getElementById(fieldId('harness.apiKey'));
    if (!input) return;
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? '隐藏' : '显示';
  }

  /* 用当前填写的地址与 Key 测试 Harness 连接，不需要先保存。 */
  function testHarness() {
    if (isBusy('harness-test')) return;
    var baseUrl = textOf(getPath(state.draft, 'harness.baseUrl'), '').trim();
    if (baseUrl === '') {
      toast('error', '请先填写接口地址');
      var input = document.getElementById(fieldId('harness.baseUrl'));
      if (input) input.focus();
      return;
    }
    busySet('harness-test', true);
    syncBusy();
    api('/control', {
      method: 'POST',
      body: {
        action: 'test-harness',
        payload: { baseUrl: baseUrl, apiKey: textOf(getPath(state.draft, 'harness.apiKey'), '') }
      }
    })
      .then(function (res) {
        controlToast(res, 'Harness 连接正常');
      })
      .catch(function (err) {
        if (err && err.status !== 401) toast('error', err && err.message ? err.message : '测试 Harness 连接失败');
      })
      .then(function () {
        busySet('harness-test', false);
        syncBusy();
      });
  }

  /* ============================== 动作：生图 ============================== */

  function testImage() {
    if (isBusy('image-test')) return;
    var prompt = String(state.ui.imagePrompt || '').trim();
    if (prompt === '') {
      toast('error', '请先填写测试用的提示词');
      return;
    }
    busySet('image-test', true);
    syncBusy();
    api('/image/test', { method: 'POST', body: { prompt: prompt } })
      .then(function (res) {
        state.imageTest = res || {};
        if (res && res.ok === false) toast('error', res.error ? res.error : '生图测试失败');
        else toast('success', '生图测试成功');
        renderContent();
      })
      .catch(function (err) {
        state.imageTest = { ok: false, error: err && err.message ? err.message : '生图测试失败' };
        if (err && err.status !== 401) toast('error', state.imageTest.error);
        renderContent();
      })
      .then(function () {
        busySet('image-test', false);
        syncBusy();
      });
  }

  /* ============================== 动作：插件 ============================== */

  function openPluginEditor(id) {
    var plugin = findInstalled(id);
    if (!plugin) return;
    /* 新版服务端会返回 prompt 全文，可以直接编辑；老版本只给 promptChars，则留空表示不改。 */
    var promptKnown = typeof plugin.prompt === 'string';
    state.ui.pluginEdit = id;
    state.ui.pluginDraft = {
      id: id,
      name: textOf(plugin.name, ''),
      description: textOf(plugin.description, ''),
      prompt: promptKnown ? plugin.prompt : '',
      promptKnown: promptKnown
    };
    renderContent();
  }

  function closePluginEditor() {
    if (isPluginDraftDirty(state.ui.pluginDraft) && !window.confirm('放弃该插件未保存的修改？')) return;
    state.ui.pluginEdit = null;
    state.ui.pluginDraft = null;
    renderContent();
  }

  function updatePluginDraft(field, value) {
    if (!state.ui.pluginDraft) return;
    state.ui.pluginDraft[field] = value;
    syncPluginSaveButton();
  }

  function syncPluginSaveButton() {
    var draft = state.ui.pluginDraft;
    if (!draft) return;
    var dirty = isPluginDraftDirty(draft);
    var buttons = document.querySelectorAll('[data-act="plugin-save"]');
    Array.prototype.forEach.call(buttons, function (btn) {
      if (btn.getAttribute('data-id') !== draft.id) return;
      if (isBusy('plugin-save-' + draft.id)) {
        btn.disabled = true;
        btn.classList.add('is-busy');
      } else {
        btn.classList.remove('is-busy');
        btn.disabled = !dirty;
      }
    });
    var note = document.getElementById('plugin-dirty-note');
    if (note) note.textContent = dirty ? '有未保存的修改' : '未修改';
  }

  function savePlugin(id) {
    var draft = state.ui.pluginDraft;
    if (!draft || draft.id !== id || !isPluginDraftDirty(draft)) return;
    var plugin = findInstalled(id);
    if (!plugin) return;
    var body = {
      name: draft.name,
      description: draft.description,
      enabled: !!plugin.enabled
    };
    if (draft.promptKnown) body.prompt = textOf(draft.prompt, '');
    else if (String(draft.prompt || '').trim() !== '') body.prompt = draft.prompt;
    var key = 'plugin-save-' + id;
    busySet(key, true);
    syncBusy();
    api('/plugins/' + encodeURIComponent(id), { method: 'PUT', body: { plugin: body } })
      .then(function () {
        toast('success', '插件「' + textOf(plugin.name, id) + '」已保存');
        state.ui.pluginEdit = null;
        state.ui.pluginDraft = null;
        return loadPlugins();
      })
      .catch(function (err) {
        if (err && err.status !== 401) {
          toast('error', err && err.message ? err.message : '保存插件失败');
          syncPluginSaveButton();
        }
      })
      .then(function () {
        busySet(key, false);
        syncBusy();
      });
  }

  function togglePlugin(id, enabled, el) {
    var plugin = findInstalled(id);
    if (!plugin) return;
    var key = 'plugin-toggle-' + id;
    if (isBusy(key)) return;
    busySet(key, true);
    if (el) el.disabled = true;
    var previous = !!plugin.enabled;
    api('/plugins/' + encodeURIComponent(id) + '/toggle', { method: 'POST', body: { enabled: !!enabled } })
      .then(function () {
        plugin.enabled = !!enabled;
        toast('success', '已' + (enabled ? '启用' : '停用') + '插件「' + textOf(plugin.name, id) + '」');
        renderIf('plugins');
      })
      .catch(function (err) {
        if (el) el.checked = previous;
        if (err && err.status !== 401) toast('error', err && err.message ? err.message : '操作失败');
      })
      .then(function () {
        busySet(key, false);
        if (el) el.disabled = false;
        syncBusy();
      });
  }

  function uninstallPlugin(id) {
    var plugin = findInstalled(id);
    if (!plugin) return;
    var key = 'plugin-remove-' + id;
    if (isBusy(key)) return;
    busySet(key, true);
    api('/plugins/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function () {
        toast('success', '已卸载插件「' + textOf(plugin.name, id) + '」');
        if (state.ui.pluginEdit === id) {
          state.ui.pluginEdit = null;
          state.ui.pluginDraft = null;
        }
        return loadPlugins();
      })
      .catch(function (err) {
        if (err && err.status !== 401) toast('error', err && err.message ? err.message : '卸载失败');
      })
      .then(function () {
        busySet(key, false);
        syncBusy();
      });
  }

  function loadPlugins() {
    return LOADERS.plugins()
      .then(function () {
        if (state.route === 'plugins') state.errors.plugins = null;
        renderIf('plugins');
      })
      .catch(function (err) {
        if (err && err.status !== 401) toast('error', err && err.message ? err.message : '插件列表加载失败');
      });
  }

  function installPlugin(source, el) {
    var body = { source: source };
    var key = 'install-' + source;
    if (source === 'catalog') {
      body.id = el.getAttribute('data-id');
      key = 'install-' + body.id;
    } else if (source === 'path') {
      body.path = String(state.ui.installPath || '').trim();
      if (body.path === '') {
        toast('error', '请填写插件目录的绝对路径');
        return;
      }
    } else {
      body.url = String(state.ui.installUrl || '').trim();
      if (body.url === '') {
        toast('error', '请填写 tar.gz 链接');
        return;
      }
    }
    if (isBusy(key)) return;
    busySet(key, true);
    syncBusy();
    api('/plugins/install', { method: 'POST', body: body })
      .then(function (res) {
        toast('success', res && res.message ? res.message : '插件安装成功');
        if (source === 'path') state.ui.installPath = '';
        if (source === 'url') state.ui.installUrl = '';
        return loadPlugins();
      })
      .catch(function (err) {
        if (err && err.status !== 401) toast('error', err && err.message ? err.message : '安装失败');
      })
      .then(function () {
        busySet(key, false);
        syncBusy();
      });
  }

  /* ============================== 动作：日志 ============================== */

  function refreshLogs(silent) {
    if (!isBusy('logs-refresh')) {
      busySet('logs-refresh', true);
      syncBusy();
    }
    return api('/logs?lines=' + encodeURIComponent(state.ui.logLines))
      .then(function (data) {
        state.logs = {
          lines: data && Array.isArray(data.lines) ? data.lines : [],
          path: data && typeof data.path === 'string' ? data.path : '',
          bytes: data && typeof data.bytes === 'number' ? data.bytes : 0
        };
        state.loaded.logs = true;
        if (state.route === 'logs') patchLogView();
      })
      .catch(function (err) {
        if (!silent && err && err.status !== 401) toast('error', err && err.message ? err.message : '日志加载失败');
      })
      .then(function () {
        busySet('logs-refresh', false);
        syncBusy();
      });
  }

  function setLogAuto(on) {
    state.ui.logAuto = !!on;
    if (logTimer !== null) {
      clearInterval(logTimer);
      logTimer = null;
    }
    if (on) {
      logTimer = setInterval(function () {
        if (state.route === 'logs' && state.session.authed && !document.hidden) refreshLogs(true);
      }, LOG_REFRESH_MS);
    }
  }

  function stopLogTimer() {
    if (logTimer !== null) {
      clearInterval(logTimer);
      logTimer = null;
    }
    state.ui.logAuto = false;
  }

  function downloadLogs() {
    var lines = state.logs && Array.isArray(state.logs.lines) ? state.logs.lines : [];
    if (lines.length === 0) {
      toast('error', '当前没有可下载的日志内容');
      return;
    }
    var text = lines
      .map(function (line) {
        return '[' + textOf(line && line.time, '') + '] [' + textOf(line && line.level, 'raw') + '] ' + textOf(line && line.text, '');
      })
      .join('\n');
    try {
      var blob = new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = 'qqbot-' + stamp() + '.log';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 2000);
      toast('success', '已开始下载 ' + lines.length + ' 行日志');
    } catch (err) {
      toast('error', '浏览器不支持下载该内容');
    }
  }

  /* ============================ 页面级动作 ============================ */

  function refreshPage() {
    if (isBusy('page-refresh')) return;
    var route = state.route;
    var needsConfig = (PAGE_LOADS[route] || []).indexOf('config') >= 0;
    var dirtyHere = needsConfig
      ? isConfigDirty()
      : route === 'plugins'
        ? isPluginDraftDirty(state.ui.pluginDraft)
        : false;
    if (dirtyHere && !window.confirm('刷新将丢弃未保存的修改，确定继续吗？')) return;
    busySet('page-refresh', true);
    syncBusy();
    if (route === 'logs') {
      refreshLogs(false).then(function () {
        busySet('page-refresh', false);
        syncBusy();
      });
      return;
    }
    state.ui.pluginEdit = null;
    state.ui.pluginDraft = null;
    loadPage(route, true, true).then(function () {
      busySet('page-refresh', false);
      syncBusy();
    });
  }

  function applyPersonaPreset(id) {
    var preset = null;
    PERSONA_PRESETS.forEach(function (item) {
      if (item.id === id) preset = item;
    });
    if (!preset || !state.draft) return;
    var persona = state.draft.persona || {};
    var hasContent = String(persona.role || '') !== '' || String(persona.style || '') !== '' || String(persona.rules || '') !== '';
    var hasName = String(persona.name || '') !== '';
    if ((hasContent || hasName) && !window.confirm('将用「' + preset.label + '」覆盖当前的人设内容，确定继续吗？')) return;
    if (preset.persona.name !== null) persona.name = preset.persona.name;
    persona.role = preset.persona.role;
    persona.style = preset.persona.style;
    persona.rules = preset.persona.rules;
    state.draft.persona = persona;
    renderContent();
    toast('info', '已应用预设「' + preset.label + '」，记得保存');
  }

  function applyImagePreset(id) {
    var preset = IMAGE_PRESETS[id];
    if (!preset || !state.draft) return;
    var image = getPath(state.draft, 'capabilities.image');
    if (!image || typeof image !== 'object') {
      setPath(state.draft, 'capabilities.image', {});
      image = getPath(state.draft, 'capabilities.image');
    }
    image.provider = id;
    if (id === 'custom') {
      renderContent();
      var input = document.getElementById(fieldId('capabilities.image.baseUrl'));
      if (input) input.focus();
      toast('info', '已切换到自定义服务商，请自行填写 baseUrl 与模型');
      return;
    }
    image.baseUrl = preset.baseUrl;
    image.model = preset.model;
    renderContent();
    toast('info', '已填入「' + preset.label + '」的 baseUrl 与模型，记得保存');
  }

  function toggleApiKeyVisibility(button) {
    var input = document.getElementById(fieldId('capabilities.image.apiKey'));
    if (!input) return;
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? '隐藏' : '显示';
  }

  function addChips(path, value) {
    var text = String(value || '');
    var parts = text.split(/[,，\s]+/).filter(function (part) {
      return part.trim() !== '';
    });
    if (parts.length === 0) return;
    var list = cleanList(getPath(state.draft, path));
    var added = 0;
    parts.forEach(function (part) {
      var item = part.trim();
      if (list.indexOf(item) < 0) {
        list.push(item);
        added += 1;
      }
    });
    if (added === 0) {
      toast('info', '该 openid 已经在列表里了');
      return;
    }
    setPath(state.draft, path, list);
    var host = document.querySelector('[data-chips="' + path + '"]');
    if (host) {
      host.innerHTML = chipsInner(path).str;
      var input = host.querySelector('.chip-input');
      if (input) input.focus();
    }
    syncDirtyUI();
  }

  function removeChip(path, index) {
    var list = cleanList(getPath(state.draft, path));
    if (index < 0 || index >= list.length) return;
    list.splice(index, 1);
    setPath(state.draft, path, list);
    var host = document.querySelector('[data-chips="' + path + '"]');
    if (host) {
      host.innerHTML = chipsInner(path).str;
      var input = host.querySelector('.chip-input');
      if (input) input.focus();
    }
    syncDirtyUI();
  }

  function setAllDenied(on) {
    var list = deniedList().slice();
    filteredTools().forEach(function (tool) {
      var name = textOf(tool && tool.name, '');
      if (name === '') return;
      var index = list.indexOf(name);
      if (on && index < 0) list.push(name);
      if (!on && index >= 0) list.splice(index, 1);
    });
    setPath(state.draft, 'capabilities.deniedTools', list);
    renderContent();
  }

  /* 依赖式选择：换提供方时切到它的第一个模型，换模型时校正推理强度。
     没有声明 reasoningEfforts 的模型保留原来的强度值，不写空字符串。 */
  function pickModelSelection(path, which, value) {
    if (!state.draft) return;
    var providers = catalogProviders();
    var selection = getPath(state.draft, path) || {};
    if (which === 'model-provider' || which === 'harness-provider' || which === 'kind-provider') {
      var provider = pickEntry(providers, value);
      if (!provider) return;
      var models = Array.isArray(provider.models) ? provider.models : [];
      selection.provider = provider.id;
      if (models.length > 0) {
        selection.model = models[0].id;
        var efforts = effortList(models[0]);
        if (efforts.length > 0) selection.reasoningEffort = textOf(models[0].defaultEffort, efforts[0].id);
      } else {
        selection.model = '';
      }
    } else {
      var all = [];
      providers.forEach(function (item) {
        if (item && Array.isArray(item.models)) all = all.concat(item.models);
      });
      selection.model = value;
      var picked = pickEntry(all, value);
      if (picked) {
        var list = effortList(picked);
        if (list.length > 0 && !pickEntry(list, selection.reasoningEffort)) {
          selection.reasoningEffort = textOf(picked.defaultEffort, list[0].id);
        }
      }
    }
    setPath(state.draft, path, selection);
    renderContent();
  }

  function handleHarnessSelect(which, value) {
    pickModelSelection('models.harness', which, value);
  }

  /* 模型类型行：选「留空」时清空 provider / model，其余情况沿用依赖式选择。 */
  function handleKindSelect(kind, which, value) {
    if (!state.draft || !kind) return;
    var path = 'models.' + kind;
    var selection = getPath(state.draft, path);
    if (!selection || typeof selection !== 'object') {
      setPath(state.draft, path, {});
      selection = getPath(state.draft, path);
    }
    if (value === '') {
      selection.provider = '';
      selection.model = '';
      if (Object.prototype.hasOwnProperty.call(selection, 'reasoningEffort')) selection.reasoningEffort = '';
      setPath(state.draft, path, selection);
      renderContent();
      return;
    }
    pickModelSelection(path, which === 'kind-provider' ? 'kind-provider' : 'kind-model', value);
  }

  /* --------------------------- 模型页：动作 --------------------------- */

  function controlToast(res, fallback) {
    var ok = !res || res.ok !== false;
    toast(ok ? 'success' : 'error', res && res.message ? res.message : fallback);
  }

  /* 五类模型共用的测试按钮：payload.kind 决定测哪一类，默认 chat。 */
  function testKindModel(kind) {
    var type = textOf(kind, 'chat') || 'chat';
    var selection = getPath(state.draft, 'models.' + type) || {};
    var provider = textOf(selection.provider, '');
    var model = textOf(selection.model, '');
    if (provider === '' || model === '') {
      toast('error', '请先选择服务商与模型');
      return;
    }
    var key = 'kind-test-' + type;
    if (isBusy(key)) return;
    var payload = { provider: provider, model: model, kind: type };
    if (type === 'chat' && textOf(selection.reasoningEffort, '') !== '') {
      payload.reasoningEffort = selection.reasoningEffort;
    }
    busySet(key, true);
    syncBusy();
    api('/control', { method: 'POST', body: { action: 'test-model', payload: payload } })
      .then(function (res) {
        controlToast(res, '模型可用');
      })
      .catch(function (err) {
        if (err && err.status !== 401) toast('error', err && err.message ? err.message : '测试失败');
      })
      .then(function () {
        busySet(key, false);
        syncBusy();
      });
  }

  function testProviderRoute(index) {
    var entry = providerList()[index];
    if (!entry) return;
    var models = Array.isArray(entry.models) ? entry.models : [];
    if (models.length === 0) {
      toast('error', '「' + textOf(entry.displayName, entry.route) + '」还没有模型，先填写模型列表或拉取模型');
      return;
    }
    var key = 'provider-test-' + textOf(entry.route, index);
    if (isBusy(key)) return;
    busySet(key, true);
    syncBusy();
    api('/control', {
      method: 'POST',
      body: {
        action: 'test-model',
        payload: { provider: textOf(entry.route, ''), model: textOf(models[0] && models[0].id, '') }
      }
    })
      .then(function (res) {
        controlToast(res, '模型可用');
      })
      .catch(function (err) {
        if (err && err.status !== 401) toast('error', err && err.message ? err.message : '测试失败');
      })
      .then(function () {
        busySet(key, false);
        syncBusy();
      });
  }

  function patchProviderFormHints() {
    var form = state.ui.providerForm;
    if (!form) return;
    var env = document.getElementById('provider-key-env');
    if (env) env.textContent = providerEnvLabel(form);
    var error = document.getElementById('provider-route-error');
    if (error) error.textContent = textOf(form.error, '');
  }

  function updateProviderForm(field, value) {
    var form = state.ui.providerForm;
    if (!form) return;
    form[field] = value;
    if (field === 'route') {
      form.error = '';
      patchProviderFormHints();
    }
  }

  function openProviderForm(index) {
    var editing = index !== null && index !== undefined;
    if (editing) {
      var entry = providerList()[index];
      if (!entry) return;
      var route = textOf(entry.route, '');
      var env = textOf(entry.apiKeyEnv, '');
      state.ui.providerForm = {
        index: index,
        displayName: textOf(entry.displayName, ''),
        route: route,
        api: knownProtocol(entry.api) ? entry.api : MODEL_PROTOCOLS[0].value,
        baseURL: textOf(entry.baseURL, ''),
        apiKeyEnv: env,
        apiKey: textOf(entry.apiKey, ''),
        envAuto: env === '' || env === routeEnvName(route),
        models: modelLinesText(entry.models),
        error: ''
      };
    } else {
      state.ui.providerForm = {
        index: null,
        displayName: '',
        route: '',
        api: MODEL_PROTOCOLS[0].value,
        baseURL: '',
        apiKeyEnv: '',
        apiKey: '',
        envAuto: true,
        models: '',
        error: ''
      };
    }
    renderContent();
  }

  function providerFormDirty(form) {
    if (!form) return false;
    var route = String(form.route || '').trim();
    if (form.index === null || form.index === undefined) {
      return route !== '' || String(form.baseURL || '').trim() !== '' || String(form.apiKey || '') !== '' || parseModelLines(form.models).length > 0;
    }
    var entry = providerList()[form.index];
    if (!entry) return false;
    return (
      route !== textOf(entry.route, '') ||
      String(form.displayName || '').trim() !== textOf(entry.displayName, '') ||
      form.api !== textOf(entry.api, '') ||
      String(form.baseURL || '').trim().replace(/\/+$/, '') !== textOf(entry.baseURL, '') ||
      String(form.apiKey || '') !== textOf(entry.apiKey, '') ||
      modelLinesText(parseModelLines(form.models)) !== modelLinesText(entry.models)
    );
  }

  function closeProviderForm() {
    var form = state.ui.providerForm;
    if (!form) return;
    if (providerFormDirty(form) && !window.confirm('放弃这个服务商未保存的修改？')) return;
    state.ui.providerForm = null;
    renderContent();
  }

  function providerRouteError(route, index) {
    var name = String(route || '').trim();
    if (name === '') return '请填写路由名（route）';
    if (!PROVIDER_ROUTE_PATTERN.test(name)) {
      return '路由名需以字母或数字开头，只能包含字母、数字、点、下划线、短横线，最长 64 个字符';
    }
    var list = providerList();
    for (var i = 0; i < list.length; i += 1) {
      if (i === (index === null || index === undefined ? -1 : index)) continue;
      if (list[i] && textOf(list[i].route, '') === name) return '路由名「' + name + '」已被占用，请换一个';
    }
    return '';
  }

  function applyProviderPreset(id) {
    var form = state.ui.providerForm;
    var preset = null;
    MODEL_PROVIDER_PRESETS.forEach(function (item) {
      if (item.id === id) preset = item;
    });
    if (!form || !preset) return;
    if (preset.api !== '') form.api = preset.api;
    if (preset.baseURL !== '') form.baseURL = preset.baseURL;
    if (preset.route !== '' && String(form.route || '').trim() === '') form.route = preset.route;
    form.error = '';
    renderContent();
    toast('info', preset.id === 'custom'
      ? '已切换到自定义，请自行填写协议与接口地址'
      : '已填入「' + preset.label + '」的协议与接口地址，可继续修改');
  }

  function toggleProviderKeyVisibility(button) {
    var input = document.getElementById('provider-api-key');
    if (!input) return;
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? '隐藏' : '显示';
  }

  function discoverProviderModels() {
    var form = state.ui.providerForm;
    if (!form) return;
    var baseURL = String(form.baseURL || '').trim();
    if (baseURL === '') {
      form.error = '';
      patchProviderFormHints();
      toast('error', '请先填写接口地址（baseURL）');
      return;
    }
    if (isBusy('provider-discover')) return;
    busySet('provider-discover', true);
    syncBusy();
    api('/control', {
      method: 'POST',
      body: {
        action: 'discover-models',
        payload: {
          baseURL: baseURL,
          api: String(form.api || ''),
          apiKey: String(form.apiKey || ''),
          provider: String(form.route || '').trim()
        }
      }
    })
      .then(function (res) {
        var ok = !res || res.ok !== false;
        toast(ok ? 'success' : 'error', res && res.message ? res.message : ok ? '已拉取模型列表' : '没有拉取到模型');
        var found = res && res.payload && Array.isArray(res.payload.models) ? res.payload.models : [];
        if (ok && found.length > 0) {
          form.models = modelLinesText(found);
          renderContent();
        }
      })
      .catch(function (err) {
        if (err && err.status !== 401) toast('error', err && err.message ? err.message : '拉取模型失败');
      })
      .then(function () {
        busySet('provider-discover', false);
        syncBusy();
      });
  }

  /* 保存后桥接需要一点时间把新路由同步给 Harness，因此延迟重拉模型目录。 */
  function refreshModelsLater() {
    setTimeout(function () {
      LOADERS.models()
        .catch(function () {
          /* 静默：用户可以点右上角刷新 */
        })
        .then(function () {
          return refreshOverviewSilently();
        })
        .then(function () {
          if (state.route === 'models') renderContent();
        });
    }, 1500);
  }

  function commitProviders() {
    if (!isConfigDirty()) {
      renderContent();
      toast('info', '没有需要保存的修改');
      return;
    }
    renderContent();
    saveConfig({ message: '已保存，正在接入…', onSaved: refreshModelsLater });
  }

  function saveProviderForm() {
    var form = state.ui.providerForm;
    if (!form) return;
    var route = String(form.route || '').trim();
    var error = providerRouteError(route, form.index);
    if (error !== '') {
      form.error = error;
      patchProviderFormHints();
      toast('error', error);
      return;
    }
    var list = providerList().slice();
    var entry = {
      route: route,
      displayName: String(form.displayName || '').trim() || route,
      api: knownProtocol(form.api) ? form.api : MODEL_PROTOCOLS[0].value,
      baseURL: String(form.baseURL || '').trim().replace(/\/+$/, ''),
      apiKeyEnv: providerEnvLabel(form),
      apiKey: String(form.apiKey || ''),
      models: parseModelLines(form.models)
    };
    if (form.index === null || form.index === undefined) list.push(entry);
    else list[form.index] = entry;
    setPath(state.draft, 'models.providers', list);
    state.ui.providerForm = null;
    commitProviders();
  }

  function removeProvider(index) {
    var list = providerList().slice();
    if (index < 0 || index >= list.length) return;
    var entry = list[index] || {};
    list.splice(index, 1);
    setPath(state.draft, 'models.providers', list);
    var form = state.ui.providerForm;
    if (form && form.index !== null && form.index !== undefined) {
      if (form.index === index) state.ui.providerForm = null;
      else if (form.index > index) form.index -= 1;
    }
    toast('info', '已移除「' + textOf(entry.displayName, entry.route) + '」，正在保存');
    commitProviders();
  }

  function applyPathControl(el) {
    var path = el.getAttribute('data-path');
    var type = el.getAttribute('data-type') || 'text';
    if (type === 'bool') {
      setPath(state.draft, path, !!el.checked);
      var label = el.parentNode ? el.parentNode.querySelector('.switch-label') : null;
      if (label) label.textContent = el.checked ? '已开启' : '已关闭';
    } else if (type === 'number') {
      var value = Number(String(el.value).trim());
      if (!isFinite(value)) value = Number(el.getAttribute('min')) || 0;
      var min = Number(el.getAttribute('min'));
      var max = Number(el.getAttribute('max'));
      if (isFinite(min)) value = Math.max(min, value);
      if (isFinite(max)) value = Math.min(max, value);
      value = Math.trunc(value);
      if (el.value !== String(value)) el.value = String(value);
      setPath(state.draft, path, value);
    } else {
      setPath(state.draft, path, el.value);
    }
    syncDirtyUI();
    if (path.indexOf('persona.') === 0) patchPreview();
  }

  function applyPathTyping(el) {
    var path = el.getAttribute('data-path');
    var type = el.getAttribute('data-type') || 'text';
    if (type === 'number') {
      var text = String(el.value).trim();
      var numeric = Number(text);
      setPath(state.draft, path, text === '' ? '' : isFinite(numeric) ? numeric : text);
    } else {
      setPath(state.draft, path, el.value);
    }
    syncDirtyUI();
    if (path.indexOf('persona.') === 0) patchPreview();
  }

  /* ============================== 路由 ============================== */

  function parseHash() {
    var text = String(window.location.hash || '').replace(/^#\/?/, '');
    var name = text.split(/[/?#]/)[0].trim();
    /* 默认落在「连接」页：新装时第一件事就是填 QQ 凭据。 */
    return ROUTES.indexOf(name) >= 0 ? name : 'connect';
  }

  function gotoRoute(route) {
    if (route === state.route) {
      loadPage(route, false);
      return;
    }
    if (state.route === 'logs') stopLogTimer();
    state.ui.pluginEdit = null;
    state.ui.pluginDraft = null;
    state.route = route;
    if (!state.session.authed || state.session.mustChange) {
      render();
      return;
    }
    render();
    /* 会随时间变化的页面每次进入都重新拉取（配置草稿不会被覆盖）。 */
    var fresh = route === 'overview' || route === 'logs' || route === 'capabilities';
    loadPage(route, fresh);
  }

  /* ============================== 事件 ============================== */

  function onClick(ev) {
    var target = ev.target;
    if (!target || typeof target.closest !== 'function') return;
    var el = target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var confirmText = el.getAttribute('data-confirm');
    if (confirmText && !window.confirm(confirmText)) return;

    switch (act) {
      case 'dismiss-toast': {
        var box = el.closest('.toast');
        if (box) removeToast(box);
        return;
      }
      case 'logout':
        doLogout();
        break;
      case 'page-refresh':
        refreshPage();
        break;
      case 'control':
        runControl(el.getAttribute('data-action'), el.getAttribute('data-fallback'));
        break;
      case 'config-save':
        saveConfig();
        break;
      case 'config-reset':
        resetDraft();
        break;
      case 'config-reload':
        reloadConfig(true);
        break;
      case 'chip-remove':
        removeChip(el.getAttribute('data-path'), Number(el.getAttribute('data-index')));
        break;
      case 'persona-preset':
        applyPersonaPreset(el.getAttribute('data-preset'));
        break;
      case 'img-preset':
        applyImagePreset(el.getAttribute('data-preset'));
        break;
      case 'img-key-toggle':
        toggleApiKeyVisibility(el);
        break;
      case 'image-test':
        testImage();
        break;
      case 'connect-key-toggle':
        toggleConnectSecretVisibility(el);
        break;
      case 'connect-test':
        testConnection();
        break;
      case 'harness-preset':
        applyHarnessPreset(el.getAttribute('data-preset'));
        break;
      case 'harness-key-toggle':
        toggleHarnessKeyVisibility(el);
        break;
      case 'harness-test':
        testHarness();
        break;
      case 'model-kind-test':
        testKindModel(el.getAttribute('data-kind'));
        break;
      case 'provider-add':
        openProviderForm(null);
        break;
      case 'provider-edit':
        openProviderForm(Number(el.getAttribute('data-index')));
        break;
      case 'provider-remove':
        removeProvider(Number(el.getAttribute('data-index')));
        break;
      case 'provider-cancel':
        closeProviderForm();
        break;
      case 'provider-save':
        saveProviderForm();
        break;
      case 'provider-preset':
        applyProviderPreset(el.getAttribute('data-preset'));
        break;
      case 'provider-key-toggle':
        toggleProviderKeyVisibility(el);
        break;
      case 'provider-discover':
        discoverProviderModels();
        break;
      case 'provider-test':
        testProviderRoute(Number(el.getAttribute('data-index')));
        break;
      case 'tools-all':
        setAllDenied(true);
        break;
      case 'tools-none':
        setAllDenied(false);
        break;
      case 'install-tab':
        state.ui.installTab = el.getAttribute('data-tab');
        renderContent();
        break;
      case 'plugin-edit':
        openPluginEditor(el.getAttribute('data-id'));
        break;
      case 'plugin-cancel':
        closePluginEditor();
        break;
      case 'plugin-save':
        savePlugin(el.getAttribute('data-id'));
        break;
      case 'plugin-uninstall':
        uninstallPlugin(el.getAttribute('data-id'));
        break;
      case 'plugin-install':
        installPlugin(el.getAttribute('data-source'), el);
        break;
      case 'logs-refresh':
        refreshLogs(false);
        break;
      case 'logs-download':
        downloadLogs();
        break;
      default:
        break;
    }

    var toastBox = el.closest('.toast');
    if (toastBox) removeToast(toastBox);
  }

  function onInput(ev) {
    var el = ev.target;
    if (!el || typeof el.getAttribute !== 'function') return;

    if (el.hasAttribute('data-path')) {
      var type = el.getAttribute('data-type') || 'text';
      if (type !== 'bool') applyPathTyping(el);
      return;
    }
    var providerField = el.getAttribute('data-provider-field');
    if (providerField) {
      updateProviderForm(providerField, el.value);
      return;
    }
    var field = el.getAttribute('data-plugin-field');
    if (field) {
      updatePluginDraft(field, el.value);
      return;
    }
    var ui = el.getAttribute('data-ui');
    if (!ui) return;
    if (ui === 'username') state.ui.username = el.value;
    else if (ui === 'password') state.ui.password = el.value;
    else if (ui === 'cred-current') state.ui.credCurrent = el.value;
    else if (ui === 'cred-username') state.ui.credUsername = el.value;
    else if (ui === 'cred-password') state.ui.credPassword = el.value;
    else if (ui === 'cred-confirm') state.ui.credConfirm = el.value;
    else if (ui === 'tool-search') {
      state.ui.toolSearch = el.value;
      patchToolPanel();
    } else if (ui === 'image-prompt') state.ui.imagePrompt = el.value;
    else if (ui === 'install-path') state.ui.installPath = el.value;
    else if (ui === 'install-url') state.ui.installUrl = el.value;
  }

  function onChange(ev) {
    var el = ev.target;
    if (!el || typeof el.getAttribute !== 'function') return;

    var providerField = el.getAttribute('data-provider-field');
    if (providerField) {
      updateProviderForm(providerField, el.value);
      return;
    }
    var ui = el.getAttribute('data-ui');
    if (ui === 'log-lines') {
      state.ui.logLines = clampInt(el.value, 50, 5000, 300);
      state.ui.logStick = true;
      refreshLogs(false);
      return;
    }
    if (ui === 'log-auto') {
      setLogAuto(!!el.checked);
      return;
    }
    if (ui === 'harness-provider' || ui === 'harness-model') {
      handleHarnessSelect(ui, el.value);
      return;
    }
    if (ui === 'kind-provider' || ui === 'kind-model') {
      handleKindSelect(el.getAttribute('data-kind'), ui, el.value);
      return;
    }
    var toggleId = el.getAttribute('data-toggle-plugin');
    if (toggleId) {
      togglePlugin(toggleId, !!el.checked, el);
      return;
    }
    var deny = el.getAttribute('data-deny');
    if (deny !== null) {
      setDeny(deny, !!el.checked);
      return;
    }
    if (el.hasAttribute('data-path')) applyPathControl(el);
  }

  function onKeydown(ev) {
    var el = ev.target;
    if (!el || typeof el.getAttribute !== 'function') return;
    if (ev.key === 'Enter' && el.hasAttribute('data-chip')) {
      ev.preventDefault();
      var value = el.value;
      el.value = '';
      addChips(el.getAttribute('data-chip'), value);
      return;
    }
    if ((ev.key === 's' || ev.key === 'S') && (ev.metaKey || ev.ctrlKey) && state.session.authed && isConfigDirty()) {
      ev.preventDefault();
      saveConfig();
    }
  }

  function onSubmit(ev) {
    var form = ev.target;
    if (form && form.id === 'login-form') {
      ev.preventDefault();
      doLogin();
    } else if (form && form.id === 'credential-form') {
      ev.preventDefault();
      changeCredentials();
    }
  }

  function onHashChange() {
    var next = parseHash();
    if (state.reverting) {
      /* 这是我们自己回退地址栏产生的事件，忽略；若是用户的新导航则照常处理。 */
      var ours = window.location.hash === state.revertHash;
      state.reverting = false;
      if (ours) return;
    }
    if (next === state.route) return;
    if (isDirty() && !window.confirm('当前页面有未保存的修改，离开将丢失这些修改。确定要离开吗？')) {
      state.reverting = true;
      state.revertHash = '#/' + state.route;
      window.location.hash = state.revertHash;
      setTimeout(function () {
        state.reverting = false;
      }, 500);
      return;
    }
    gotoRoute(next);
  }

  function onBeforeUnload(ev) {
    if (!state.session.authed || !isDirty()) return;
    ev.preventDefault();
    ev.returnValue = '';
    return '';
  }

  function bindEvents() {
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('submit', onSubmit);
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('beforeunload', onBeforeUnload);
  }

  /* ============================== 启动 ============================== */

  function boot() {
    bindEvents();
    state.route = parseHash();
    render();
    api('/session')
      .then(function (data) {
        var mustChange = !!(data && data.mustChange);
        state.session = { checked: true, authed: !!(data && data.authed), mustChange: mustChange };
        var name = textOf(data && data.username, '');
        if (mustChange && name !== '') state.ui.credUsername = name;
      })
      .catch(function () {
        state.session = { checked: true, authed: false, mustChange: false };
        toast('error', '无法连接控制台服务，请确认服务已启动');
      })
      .then(function () {
        render();
        /* 必须改默认凭据时，除了 /session 之外不请求任何接口。 */
        if (!state.session.authed || state.session.mustChange) return undefined;
        /* 页脚 / 顶栏需要总览里的日志路径与桥接状态，非总览页也要拉一次。 */
        if (state.route !== 'overview' && !state.loaded.overview) {
          loadOverview().catch(function () {
            /* 静默：进入总览页时会重新加载 */
          });
        }
        return loadPage(state.route, true);
      })
      .catch(function () {
        /* 兜底：任何未预期的失败都不应该让界面卡在「正在加载…」 */
        state.session = { checked: true, authed: state.session.authed, mustChange: !!state.session.mustChange };
        render();
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
