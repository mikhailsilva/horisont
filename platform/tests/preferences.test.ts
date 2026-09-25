import { beforeAll, describe, expect, it } from 'vitest';
import { call } from './helpers.js';

process.env.DATABASE_URL = 'pglite:memory';
process.env.SETUP_KEY = 'preferences-test-key';
let first = '';
let second = '';

describe('account preferences', () => {
  beforeAll(async () => {
    const setup = await call('POST', '/api/setup', { setup_key: process.env.SETUP_KEY, login: 'settings-admin', password: 'password-test-123' });
    expect(setup.status).toBe(201);
    first = setup.data.token;
    const invite = await call('POST', `/api/orgs/${setup.data.user.org_id}/invites`, { role: 'analyst' }, first);
    const redeemed = await call('POST', '/api/auth/redeem', { code: invite.data.code, login: 'settings-other', password: 'password-test-456' });
    expect(redeemed.status).toBe(201);
    second = redeemed.data.token;
  });

  it('requires authentication', async () => {
    expect((await call('GET', '/api/me/preferences')).status).toBe(401);
    expect((await call('PATCH', '/api/me/preferences', { mapBase: 'hybrid' })).status).toBe(401);
  });

  it('merges explicit choices and persists across sessions without crossing accounts', async () => {
    expect((await call('PATCH', '/api/me/preferences', { mapBase: 'hybrid' }, first)).status).toBe(200);
    await call('PATCH', '/api/me/preferences', { theme: 'light' }, first);
    const login = await call('POST', '/api/auth/login', { login: 'settings-admin', password: 'password-test-123' });
    expect((await call('GET', '/api/me/preferences', undefined, login.data.token)).data.preferences).toEqual({ mapBase: 'hybrid', theme: 'light' });
    expect((await call('GET', '/api/me/preferences', undefined, second)).data.preferences).toEqual({});
    await call('PATCH', '/api/me/preferences', { mapBase: 'topo' }, first);
    expect((await call('GET', '/api/me/preferences', undefined, first)).data.preferences.mapBase).toBe('topo');
  });

  it('rejects unknown fields and invalid values', async () => {
    for (const body of [{ mapBase: 'bad' }, { theme: 'blue' }, { user_id: 'other' }, { mapRelief: 'yes' }]) {
      expect((await call('PATCH', '/api/me/preferences', body, first)).status).toBe(400);
    }
  });
});
