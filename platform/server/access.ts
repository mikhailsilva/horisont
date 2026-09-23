import type { Db } from './db.js';
import { forbidden, notFound } from './http.js';

export interface UserPrincipal {
  kind: 'user';
  id: string;
  login: string;
  org_id: string;
  org_kind: 'fuchs' | 'distributor' | 'customer';
  org_name: string;
  role: 'admin' | 'member';
  label: string | null;
}
export interface DevicePrincipal {
  kind: 'device';
  source_id: string;
  machine_id: string | null;
  org_id: string;
}
export interface GatewayPrincipal {
  kind: 'gateway';
}
export type Principal = UserPrincipal | DevicePrincipal | GatewayPrincipal;

/** Orgs a user may read: FUCHS sees all, a distributor its customers, a customer itself. */
export async function visibleOrgIds(db: Db, u: UserPrincipal): Promise<string[]> {
  if (u.org_kind === 'fuchs') return (await db.query<{ id: string }>(`select id from orgs`)).rows.map((r) => r.id);
  if (u.org_kind === 'distributor') {
    const r = await db.query<{ id: string }>(`select id from orgs where id = $1 or parent_id = $1`, [u.org_id]);
    return r.rows.map((x) => x.id);
  }
  return [u.org_id];
}

export async function assertOrgVisible(db: Db, u: UserPrincipal, orgId: string) {
  const ids = await visibleOrgIds(db, u);
  if (!ids.includes(orgId)) throw notFound('Организация не найдена');
}

/**
 * Who may manage an org's fleet (machines, sources, connectors): the org's own admin, or the
 * admin of its distributor (onboarding help). Location/sharing switches stay with the owner.
 */
export async function assertCanManageOrg(db: Db, u: UserPrincipal, orgId: string) {
  if (u.role !== 'admin') throw forbidden('Действие доступно администратору организации');
  if (u.org_id === orgId) return;
  const r = await db.query<{ parent_id: string | null }>(`select parent_id from orgs where id = $1`, [orgId]);
  const parent = r.rows[0]?.parent_id;
  if (u.org_kind === 'distributor' && parent === u.org_id) return;
  if (u.org_kind === 'fuchs') return;
  throw forbidden();
}

export function assertOwnerAdmin(u: UserPrincipal, orgId: string) {
  if (u.role !== 'admin' || u.org_id !== orgId)
    throw forbidden('Это решение принимает только главный администратор организации-владельца техники');
}

export interface MachineAccessRow {
  id: string;
  org_id: string;
  location_enabled: boolean;
  share_location_up: boolean;
}

export async function loadVisibleMachine(db: Db, u: UserPrincipal, id: string): Promise<MachineAccessRow> {
  const r = await db.query<MachineAccessRow>(
    `select m.id, m.org_id, m.location_enabled, o.share_location_up
       from machines m join orgs o on o.id = m.org_id where m.id = $1`,
    [id],
  );
  const m = r.rows[0];
  if (!m) throw notFound('Машина не найдена');
  await assertOrgVisible(db, u, m.org_id);
  return m;
}

export function locationVisible(u: UserPrincipal, m: MachineAccessRow): boolean {
  return m.location_enabled && (u.org_id === m.org_id || m.share_location_up);
}
