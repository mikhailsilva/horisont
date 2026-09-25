import { beforeAll, describe, expect, it } from 'vitest';
import { call } from './helpers.js';

process.env.DATABASE_URL = 'pglite:memory';
process.env.SETUP_KEY = 'machine-photo-test-key';
let admin = '';
let viewer = '';
let machine = '';
let otherMachine = '';
let superadmin = '';
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

describe('machine passport photo', () => {
  beforeAll(async () => {
    const setup = await call('POST', '/api/setup', { setup_key: process.env.SETUP_KEY, login: 'photo-super', password: 'password-photo-123' });
    superadmin = setup.data.token;
    const org = await call('POST', '/api/orgs', { kind: 'customer', name: 'Фото парк' }, setup.data.token);
    const invite = await call('POST', `/api/orgs/${org.data.org.id}/invites`, { role: 'admin' }, setup.data.token);
    admin = (await call('POST', '/api/auth/redeem', { code: invite.data.code, login: 'photo-admin', password: 'password-admin-123' })).data.token;
    const machineResult = await call('POST', '/api/machines', { org_id: org.data.org.id, name: 'Трактор фото' }, admin);
    expect(machineResult.status).toBe(201);
    machine = machineResult.data.machine.id;
    const viewInvite = await call('POST', `/api/orgs/${org.data.org.id}/invites`, { role: 'viewer' }, admin);
    viewer = (await call('POST', '/api/auth/redeem', { code: viewInvite.data.code, login: 'photo-viewer', password: 'password-viewer-123' })).data.token;
    const otherOrg = await call('POST', '/api/orgs', { kind: 'customer', name: 'Другой парк' }, superadmin);
    const otherResult = await call('POST', '/api/machines', { org_id: otherOrg.data.org.id, name: 'Чужой трактор' }, superadmin);
    expect(otherResult.status).toBe(201);
    otherMachine = otherResult.data.machine.id;
  });

  it('requires authentication and enforces edit capability', async () => {
    expect((await call('GET', `/api/machines/${machine}/photo`)).status).toBe(401);
    expect((await call('PATCH', `/api/machines/${machine}/photo`, { data_url: tinyPng }, viewer)).status).toBe(403);
    expect((await call('GET', `/api/machines/${otherMachine}/photo`, undefined, admin)).status).toBe(404);
    expect((await call('PATCH', `/api/machines/${otherMachine}/photo`, { data_url: tinyPng }, admin)).status).toBe(404);
  });

  it('stores and removes a bounded raster photo for the visible machine', async () => {
    const path = `/api/machines/${machine}/photo`;
    const photo = tinyPng;
    expect((await call('GET', path, undefined, admin)).data.photo).toBeNull();
    expect((await call('PATCH', path, { data_url: photo }, admin)).data.photo).toBe(photo);
    expect((await call('GET', path, undefined, viewer)).data.photo).toBe(photo);
    expect((await call('PATCH', path, { data_url: 'data:image/svg+xml;base64,PHN2Zz4=' }, admin)).status).toBe(400);
    expect((await call('PATCH', path, { data_url: 'data:image/png;base64,AAAA' }, admin)).status).toBe(400);
    expect((await call('DELETE', path, undefined, admin)).data.photo).toBeNull();
    expect((await call('GET', path, undefined, admin)).data.photo).toBeNull();
  });
});
