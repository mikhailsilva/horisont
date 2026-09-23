import { useState } from 'react';
import type { Me } from '../main';
import { api } from '../api';
import { ErrorLine, Modal, useAsync } from '../ui';

const KIND_RU: Record<string, string> = { fuchs: 'FUCHS', distributor: 'Дистрибьютор', customer: 'Клиент' };

function Users({ org, me }: { org: any; me: Me }) {
  const users = useAsync(() => api('GET', `/api/orgs/${org.id}/users`), [org.id]);
  const [code, setCode] = useState<any>(null);
  const invite = async (role: string) => setCode(await api('POST', `/api/orgs/${org.id}/invites`, { role }));
  return (
    <div className="space-y-2">
      {(users.data?.users ?? []).map((u: any) => (
        <div key={u.id} className="flex items-center justify-between rounded-xl border border-border px-3 py-2 text-sm">
          <div>
            <b>{u.login}</b> <span className="text-muted-foreground">· {u.role === 'admin' ? 'администратор' : 'сотрудник'}</span>
            {u.disabled && <span className="badge ml-2 bg-muted text-muted-foreground">отключён</span>}
          </div>
          {u.id !== me.id && (
            <button
              className="text-xs text-muted-foreground hover:text-danger"
              onClick={async () => {
                await api('PATCH', `/api/users/${u.id}`, { disabled: !u.disabled });
                users.reload();
              }}
            >
              {u.disabled ? 'включить' : 'отключить'}
            </button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost" onClick={() => invite('member')}>
          Пригласить сотрудника
        </button>
        <button className="btn-ghost" onClick={() => invite('admin')}>
          Пригласить администратора
        </button>
      </div>
      {code && (
        <Modal title="Код приглашения" onClose={() => setCode(null)}>
          <p className="text-sm text-muted-foreground">
            Передайте код человеку: вход → «У меня есть код». Действует {code.expires_in_days} дней, одноразовый. Роль:{' '}
            {code.role === 'admin' ? 'администратор' : 'сотрудник'}.
          </p>
          <div className="my-5 text-center font-mono text-4xl font-bold tracking-widest text-primary">{code.code}</div>
        </Modal>
      )}
    </div>
  );
}

export function Orgs({ me }: { me: Me }) {
  const orgs = useAsync(() => api('GET', '/api/orgs'), []);
  const [open, setOpen] = useState<string | null>(me.org_id);
  const [f, setF] = useState<any>({ kind: me.org_kind === 'fuchs' ? 'distributor' : 'customer' });
  const [err, setErr] = useState<unknown>(null);
  const list: any[] = orgs.data?.orgs ?? [];
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', '/api/orgs', f);
      setF({ ...f, name: '' });
      orgs.reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{me.org_kind === 'customer' ? 'Организация' : 'Организации'}</h1>
      {me.role === 'admin' && me.org_kind !== 'customer' && (
        <form onSubmit={create} className="card grid gap-3 p-5 md:grid-cols-4">
          {me.org_kind === 'fuchs' && (
            <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              <option value="distributor">Дистрибьютор</option>
              <option value="customer">Клиент</option>
            </select>
          )}
          {me.org_kind === 'fuchs' && f.kind === 'customer' && (
            <select className="input" value={f.parent_id ?? ''} onChange={(e) => setF({ ...f, parent_id: e.target.value })} required>
              <option value="">— дистрибьютор —</option>
              {list
                .filter((o) => o.kind === 'distributor')
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
            </select>
          )}
          <input className="input md:col-span-2" placeholder="Название организации" value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          <button className="btn-primary">Создать</button>
          <div className="md:col-span-4">
            <ErrorLine e={err} />
          </div>
        </form>
      )}
      <div className="space-y-3">
        {list.map((o) => (
          <div key={o.id} className="card p-5">
            <div className="flex cursor-pointer flex-wrap items-center justify-between gap-2" onClick={() => setOpen(open === o.id ? null : o.id)}>
              <div>
                <span className="badge mr-2 bg-primary/10 text-primary">{KIND_RU[o.kind]}</span>
                <b>{o.name}</b>
                <span className="ml-2 text-sm text-muted-foreground">
                  {o.machines} машин · {o.users} пользователей
                </span>
              </div>
              <span className="text-muted-foreground">{open === o.id ? '▲' : '▼'}</span>
            </div>
            {open === o.id && (
              <div className="mt-4 space-y-4">
                {o.kind === 'customer' && me.org_id === o.id && me.role === 'admin' && (
                  <label className="flex items-start gap-3 rounded-xl bg-warning/10 p-3 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={o.share_location_up}
                      onChange={async (e) => {
                        await api('PATCH', `/api/orgs/${o.id}`, { share_location_up: e.target.checked });
                        orgs.reload();
                      }}
                    />
                    <span>
                      <b>Показывать местоположение машин дистрибьютору и FUCHS.</b> Моточасы и пробег видны им всегда; координаты — только если отмечено.
                      Отключить сбор координат отдельной машины можно на её странице.
                    </span>
                  </label>
                )}
                {(me.role === 'admin' && (me.org_id === o.id || me.org_kind !== 'customer')) && <Users org={o} me={me} />}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
