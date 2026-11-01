(function () {
  /**
   * 围炉渠道 · 设置面板（DSH client 端）。
   *
   * DSH 不会按 Config schema 自动渲染表单，插件必须自己提供 client 入口：
   * 末尾用 window.__ModuleLoader__.load 注册，apply(ctx) 里往 settings.section 插槽
   * 挂一个 React 组件。写法对齐 dsh-model-health（宿主 React 由 factory 的 require 注入）。
   *
   * 这里刻意不用 JSX —— 插件是零构建的，直接 React.createElement。
   * 配置读写走后端插件暴露的 GET/POST /api/campfire/config。
   */

  let injectedReact = null;

  function provideReact(react) {
    injectedReact = react;
  }

  function getReact() {
    if (!injectedReact) throw new Error('[campfire] React 尚未注入');
    return injectedReact;
  }

  const NS = 'campfire';

  const zh = {
    tab: '围炉渠道',
    title: '接入围炉',
    lead: '填好下面三项，重启 DSH 即可在群里被 @ 到。',
    baseUrl: '围炉地址',
    baseUrlHint: '例如 http://192.168.31.252:8099。DSH 跑在容器里时要用 http://127.0.0.1:8099。',
    token: '渠道令牌',
    tokenHint: '以 cf_ 开头。在围炉里创建成员时生成。',
    tokenKeep: '已保存，留空表示不修改',
    memberHandle: '成员特征名',
    memberHandleHint: '必须与围炉里的成员特征名一致，例如 dsh-pc',
    chatIds: '要接入的群',
    chatIdsHint: '多个用逗号分隔，默认 main',
    advanced: '高级',
    cwd: '会话工作目录',
    cwdHint: '留空用 DSH 当前工作区',
    save: '保存',
    saving: '保存中…',
    reload: '重新读取',
    loading: '读取配置中…',
    loadFailed: '读取配置失败',
    saved: '已保存。重启 DSH 后生效。',
    saveFailed: '保存失败',
    configFile: '配置文件',
    notReady: '宿主未提供 webServer，无法读写配置，请直接改配置文件。',
  };

  const en = {
    tab: 'Campfire',
    title: 'Connect to Campfire',
    lead: 'Fill in these three fields, then restart DSH.',
    baseUrl: 'Campfire URL',
    baseUrlHint: 'e.g. http://192.168.31.252:8099. Inside a container use http://127.0.0.1:8099.',
    token: 'Token',
    tokenHint: 'Starts with cf_. Created when adding the member in Campfire.',
    tokenKeep: 'Saved — leave blank to keep',
    memberHandle: 'Member handle',
    memberHandleHint: 'Must match the handle in Campfire, e.g. dsh-pc',
    chatIds: 'Chats',
    chatIdsHint: 'Comma separated, default: main',
    advanced: 'Advanced',
    cwd: 'Working directory',
    cwdHint: 'Empty = DSH default workspace',
    save: 'Save',
    saving: 'Saving…',
    reload: 'Reload',
    loading: 'Loading…',
    loadFailed: 'Failed to load config',
    saved: 'Saved. Restart DSH to apply.',
    saveFailed: 'Save failed',
    configFile: 'Config file',
    notReady: 'Host has no webServer; edit the config file directly.',
  };

  const styles = {
    wrap: { padding: '4px 0', maxWidth: 720 },
    lead: { margin: '0 0 16px', fontSize: 13, opacity: 0.75, lineHeight: 1.7 },
    field: { marginBottom: 16 },
    label: { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 },
    hint: { margin: '5px 0 0', fontSize: 11.5, opacity: 0.6, lineHeight: 1.6 },
    input: {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      fontSize: 13,
      borderRadius: 8,
      border: '1px solid rgba(128,128,128,0.35)',
      background: 'transparent',
      color: 'inherit',
      fontFamily: 'inherit',
    },
    row: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 },
    btn: {
      padding: '7px 16px',
      fontSize: 13,
      borderRadius: 8,
      border: '1px solid rgba(128,128,128,0.35)',
      background: 'rgba(212,97,60,0.12)',
      color: 'inherit',
      cursor: 'pointer',
      fontFamily: 'inherit',
    },
    btnGhost: {
      padding: '7px 14px',
      fontSize: 13,
      borderRadius: 8,
      border: '1px solid rgba(128,128,128,0.25)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      fontFamily: 'inherit',
    },
    ok: { fontSize: 12.5, color: '#2e7d32', marginTop: 8 },
    err: { fontSize: 12.5, color: '#c0392b', marginTop: 8 },
    meta: { fontSize: 11.5, opacity: 0.55, marginTop: 16, wordBreak: 'break-all' },
  };

  function ConfigPanel(props) {
    const React = getReact();
    const h = React.createElement;
    const t = props.t;

    const [loading, setLoading] = React.useState(true);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState('');
    const [notice, setNotice] = React.useState('');
    const [noticeWarn, setNoticeWarn] = React.useState(false);
    const [configFile, setConfigFile] = React.useState('');
    const [hasToken, setHasToken] = React.useState(false);
    const [form, setForm] = React.useState({
      baseUrl: '',
      token: '',
      memberHandle: '',
      chatIds: '',
      cwd: '',
    });

    const load = React.useCallback(async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch('/api/campfire/config', { credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data?.error || t('loadFailed'));
        const c = data.config || {};
        setConfigFile(data.configFile || '');
        setHasToken(Boolean(c.hasToken));
        setForm({
          baseUrl: c.baseUrl || '',
          token: '',
          memberHandle: c.memberHandle || '',
          chatIds: Array.isArray(c.chatIds) ? c.chatIds.join(', ') : c.chatIds || '',
          cwd: c.cwd || '',
        });
      } catch (e) {
        setError(String(e?.message || e));
      } finally {
        setLoading(false);
      }
    }, [t]);

    React.useEffect(() => {
      load();
    }, [load]);

    const onField = (key) => (event) => {
      const value = event.target.value;
      setForm((prev) => ({ ...prev, [key]: value }));
      setNotice('');
      setNoticeWarn(false);
    };

    const save = async () => {
      const tokenInput = form.token.trim();
      // 围炉签发的令牌一定是 cf_ 开头；写错了会一直 401，不如在这里就拦下
      if (tokenInput && !tokenInput.startsWith('cf_')) {
        setNotice('');
        setNoticeWarn(false);
        setError('渠道令牌应以 cf_ 开头——你填的看起来不是围炉签发的令牌。去围炉「成员管理 → 接入设置 → 生成渠道令牌」拿一把。');
        return;
      }
      setSaving(true);
      setError('');
      setNotice('');
      try {
        const payload = {
          baseUrl: form.baseUrl.trim(),
          memberHandle: form.memberHandle.trim(),
          chatIds: form.chatIds,
          cwd: form.cwd.trim(),
        };
        if (form.token.trim()) payload.token = form.token.trim();
        const res = await fetch('/api/campfire/config', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data?.error || t('saveFailed'));
        setNotice(data.message || t('saved'));
        // 服务端保存时顺手探了一次 /v1/meta：没通过就用警示色，别让用户以为成了
        setNoticeWarn(Boolean(data.probe?.checked && !data.probe?.ok));
        setForm((prev) => ({ ...prev, token: '' }));
        setHasToken((prev) => prev || Boolean(form.token.trim()));
      } catch (e) {
        setError(String(e?.message || e));
      } finally {
        setSaving(false);
      }
    };

    const field = (key, label, hint, opts) =>
      h(
        'div',
        { style: styles.field, key },
        h('label', { style: styles.label }, label),
        h('input', {
          style: styles.input,
          value: form[key],
          onChange: onField(key),
          placeholder: opts?.placeholder || '',
          type: opts?.type || 'text',
          spellCheck: false,
          autoComplete: opts?.autoComplete || 'off',
          disabled: loading || saving,
        }),
        hint ? h('p', { style: styles.hint }, hint) : null,
      );

    if (loading) return h('div', { style: styles.wrap }, h('p', { style: styles.lead }, t('loading')));

    return h(
      'div',
      { style: styles.wrap },
      h('p', { style: styles.lead }, t('lead')),

      field('baseUrl', t('baseUrl'), t('baseUrlHint'), { placeholder: 'http://192.168.31.252:8099' }),

      field(
        'token',
        t('token'),
        hasToken ? t('tokenKeep') : t('tokenHint'),
        { type: 'password', placeholder: hasToken ? '••••••••' : 'cf_…', autoComplete: 'new-password' },
      ),

      field('memberHandle', t('memberHandle'), t('memberHandleHint'), { placeholder: 'dsh-pc' }),

      field('chatIds', t('chatIds'), t('chatIdsHint'), { placeholder: 'main' }),

      field('cwd', `${t('advanced')} · ${t('cwd')}`, t('cwdHint'), { placeholder: '' }),

      h(
        'div',
        { style: styles.row },
        h(
          'button',
          {
            type: 'button',
            style: { ...styles.btn, opacity: saving ? 0.6 : 1, cursor: saving ? 'default' : 'pointer' },
            onClick: save,
            disabled: saving || loading,
          },
          saving ? t('saving') : t('save'),
        ),
        h('button', { type: 'button', style: styles.btnGhost, onClick: load, disabled: saving }, t('reload')),
      ),

      notice ? h('p', { style: noticeWarn ? styles.err : styles.ok }, notice) : null,
      error ? h('p', { style: styles.err }, error) : null,
      configFile ? h('p', { style: styles.meta }, `${t('configFile')}: ${configFile}`) : null,
    );
  }

  const inject = ['slots', 'locale'];

  function apply(ctx) {
    const React = getReact();
    ctx.effect(
      () =>
        ctx.locale.register(NS, { zh, en }),
      'campfire: dictionaries',
    );
    const t = ctx.locale.bind(NS);

    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'campfire',
          order: 40,
          label: () => t('tab'),
          locale: NS,
        },
        () => React.createElement(ConfigPanel, { t, locale: ctx.locale }),
      ),
    );
  }

  window.__ModuleLoader__.load({
    id: 'campfire-dsh-plugin',
    factory: (require) => {
      provideReact(require('react'));
      return { apply, inject };
    },
  });
})();
