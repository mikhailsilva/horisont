import { useEffect, useState } from 'react';
import { can, type Me } from '../perm';
import { api, ago } from '../api';
import { ErrorLine, useAsync } from '../ui';

const KINDS = [
  {
    kind: 'wialon',
    title: 'Wialon (Hosting или Local у интегратора)',
    hint: 'Самая распространённая платформа у интеграторов. Wialon Hosting недоступен с российских адресов, поэтому российские парки обычно работают на Wialon Local — укажите адрес вашего сервера.',
    fields: [
      ['base_url', 'Адрес API', 'https://wialon.ваш-интегратор.ru'],
      ['token', 'Токен доступа (только чтение)', ''],
    ],
  },
  {
    kind: 'traccar',
    title: 'Traccar',
    hint: 'Укажите HTTPS-адрес веб-сервера Traccar, не порт приёмника трекеров. Для проверки используйте отдельный аккаунт только для чтения; можно войти по паролю или токену из профиля Traccar.',
    fields: [
      ['base_url', 'Адрес сервера', 'https://traccar.example.ru'],
      ['email', 'E-mail пользователя Traccar', 'name@company.ru', 'opt'],
      ['password', 'Пароль', '', 'opt'],
      ['token', 'или токен (вместо e-mail и пароля)', '', 'opt'],
    ],
  },
  {
    kind: 'aemp',
    title: 'ISO 15143-3 (AEMP 2.0)',
    hint: 'Стандартный API телематики производителей техники: местоположение, моточасы и пробег в одном формате.',
    fields: [
      ['base_url', 'Адрес снимка парка (Fleet)', 'https://api.oem.example/Fleet/1'],
      ['username', 'Логин API', '', 'opt'],
      ['password', 'Пароль API', '', 'opt'],
      ['token', 'или Bearer-токен (вместо логина и пароля)', '', 'opt'],
    ],
  },
];

function normalizeTraccarBaseUrl(value: string): string {
  return value.trim().replace(/\/api\/?$/i, '').replace(/\/+$/, '');
}

export function Connect({ me }: { me: Me }) {
  const list = useAsync(() => api('GET', '/api/connectors'), []);
  const orgs = useAsync(() => api('GET', '/api/orgs'), []);
  const customers = (orgs.data?.orgs ?? []).filter((o: any) => o.kind === 'customer');
  const [kind, setKind] = useState('wialon');
  const [f, setF] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ units: number; devices: string[] } | null>(null);
  const [demoExpires, setDemoExpires] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  useEffect(() => {
    // return from the official Wialon login page: #/connect/wialon?access_token=...
    const m = /access_token=([^&]+)/.exec(location.hash);
    if (m) {
      setKind('wialon');
      setF((x) => ({ ...x, token: decodeURIComponent(m[1]) }));
    }
  }, []);
  const k = KINDS.find((x) => x.kind === kind)!;
  const prepareDemo = async () => {
    setTestBusy(true);
    setErr(null);
    setTestResult(null);
    setOk(null);
    try {
      const r = await api('POST', '/api/connectors/traccar-demo-access', {});
      setF((old) => ({ org_id: old.org_id ?? '', base_url: r.base_url, token: r.token, label: 'Traccar — личный тест (синтетика)' }));
      setDemoExpires(r.expires_at);
    } catch (e) {
      setErr(e);
    } finally {
      setTestBusy(false);
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const login = f.email || f.username;
    if (kind !== 'wialon' && !f.token && !(login && f.password)) {
      setErr(new Error('Укажите логин и пароль или токен'));
      return;
    }
    setBusy(true);
    setErr(null);
    setOk(null);
    setTestResult(null);
    try {
      const payload = { kind, ...f, ...(kind === 'traccar' ? { base_url: normalizeTraccarBaseUrl(f.base_url ?? '') } : {}), org_id: me.org_kind === 'customer' ? me.org_id : f.org_id };
      const r = await api('POST', '/api/connectors', payload);
      setOk(`Подключено: ${r.units} единиц техники, новых машин: ${r.report.new_machines}, точек: ${r.report.result.positions}.`);
      list.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const testTraccar = async () => {
    if (!f.token && !(f.email && f.password)) {
      setErr(new Error('Укажите токен или e-mail и пароль Traccar'));
      return;
    }
    setTestBusy(true);
    setErr(null);
    setTestResult(null);
    try {
      const r = await api('POST', '/api/connectors/test', {
        base_url: normalizeTraccarBaseUrl(f.base_url ?? ''),
        email: f.email,
        password: f.password,
        token: f.token,
        org_id: me.org_kind === 'customer' ? me.org_id : f.org_id,
      });
      setTestResult({ units: r.units, devices: r.devices });
    } catch (e) {
      setErr(e);
    } finally {
      setTestBusy(false);
    }
  };
  const wialonLogin = async () => {
    const host = prompt('Адрес страницы входа Wialon (hosting.wialon.com или адрес Wialon Local)', 'https://hosting.wialon.com');
    if (!host) return;
    try {
      setErr(null);
      const r = await api('GET', `/api/connectors/wialon/login-url?host=${encodeURIComponent(host)}`);
      location.href = r.url;
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Подключения</h1>
        <p className="text-sm text-muted-foreground">
          Если у машин уже есть трекеры в мониторинговой платформе, подключите платформу — все машины появятся в парке автоматически, без нового оборудования.
        </p>
      </div>
      <div className="card divide-y divide-border">
        {(list.data?.connectors ?? []).map((c: any) => (
          <div key={c.id} className="grid gap-2 p-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0">
              <b>{c.label}</b> <span className="text-muted-foreground">· {c.org_name} · {c.units} машин</span>
              <div className="text-xs text-muted-foreground">
                {c.status === 'error' ? <span className="text-danger">{c.last_error}</span> : `синхронизация ${ago(c.last_sync_at)}`}
              </div>
            </div>
            {can(me, 'connectors.manage') && (
              <button
                className="btn-ghost justify-self-start px-3 py-1.5 text-xs sm:justify-self-end"
                onClick={async () => {
                  await api('POST', `/api/connectors/${c.id}/sync`).catch((e) => alert(e.message));
                  list.reload();
                }}
              >
                Обновить
              </button>
            )}
          </div>
        ))}
        {list.data?.connectors?.length === 0 && <div className="p-4 text-sm text-muted-foreground">Подключений пока нет.</div>}
      </div>
      {can(me, 'connectors.manage') && (
        <form onSubmit={submit} className="card space-y-4 p-5">
          <div className="flex flex-wrap gap-2">
            {KINDS.map((x) => (
              <button type="button" key={x.kind} onClick={() => { setKind(x.kind); setF((v) => ({ org_id: v.org_id ?? '' })); setErr(null); setOk(null); setTestResult(null); setDemoExpires(null); }} className={`rounded-xl px-3 py-2 text-sm font-medium ${kind === x.kind ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'}`}>
                {x.title}
              </button>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">{k.hint}</p>
          {kind === 'traccar' && me.role === 'superadmin' && !me.is_demo && (
            <div className="rounded-xl border border-border bg-muted/40 p-4 text-sm">
              <button type="button" className="btn-ghost" onClick={prepareDemo} disabled={busy || testBusy}>Заполнить личный тест · 3 машины</button>
              <p className="mt-2 text-muted-foreground">Изолированный Traccar-совместимый эмулятор в ITles, не VPS и не реальные трекеры. Адрес и временный токен заполнятся автоматически. Выберите отдельного тестового клиента; затем проверьте доступ без сохранения.</p>
              {demoExpires && <p className="mt-2">Токен действует до {new Date(demoExpires).toLocaleString('ru-RU')}. До нажатия «Подключить» машины в парк не добавляются.</p>}
            </div>
          )}
          {kind === 'wialon' && (
            <button type="button" className="btn-ghost" onClick={wialonLogin}>
              Войти в Wialon и получить токен автоматически
            </button>
          )}
          {me.org_kind !== 'customer' && (
            <div>
              <label className="label" htmlFor="connector-org">Клиент, чьи машины подключаются</label>
              <select id="connector-org" className="input" value={f.org_id ?? ''} onChange={(e) => { setF({ ...f, org_id: e.target.value }); setTestResult(null); }} required>
                <option value="">— выберите клиента —</option>
                {customers.map((o: any) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {k.fields.map(([name, label, ph, opt]) => (
            <div key={name}>
              <label className="label" htmlFor={`connector-${name}`}>{label}</label>
              <input
                id={`connector-${name}`}
                className="input"
                type={name === 'password' || name === 'token' ? 'password' : name === 'email' ? 'email' : 'text'}
                autoComplete={name === 'password' ? 'current-password' : 'off'}
                placeholder={ph}
                value={f[name] ?? ''}
                onChange={(e) => { setF({ ...f, [name]: e.target.value }); setTestResult(null); }}
                required={!opt}
              />
            </div>
          ))}
          <ErrorLine e={err} />
          {ok && <div className="rounded-xl bg-success/10 px-3 py-2 text-sm text-success">{ok}</div>}
          {testResult && (
            <div className="rounded-xl bg-success/10 px-3 py-2 text-sm text-success" role="status">
              Доступ проверен: {testResult.units} устройств. {testResult.devices.length > 0 && (
                <span>Найдено: {testResult.devices.join(', ')}{testResult.units > testResult.devices.length ? ' (показаны первые 5)' : ''}.</span>
              )}
            </div>
          )}
          {kind === 'traccar' && (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn-ghost" onClick={testTraccar} disabled={busy || testBusy}>
                {testBusy ? 'Проверяем доступ…' : 'Проверить без сохранения'}
              </button>
              <span className="text-xs text-muted-foreground">Проверка не создаёт подключение или машины.</span>
            </div>
          )}
          <button className="btn-primary" disabled={busy || testBusy}>
            {busy ? 'Проверяем доступ…' : 'Подключить'}
          </button>
        </form>
      )}
    </div>
  );
}
