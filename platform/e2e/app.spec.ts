import { expect, test } from '@playwright/test';

const SHOTS = process.env.SHOTS_DIR ?? '../docs/img/ui';

test('landing → setup → hierarchy → machine → phone in the cab → data on the machine page', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Масло, моточасы и местоположение/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/landing.png`, fullPage: true });

  await page.goto('/app/');
  await page.getByText('Первый запуск').waitFor();
  const inputs = page.locator('form input');
  await inputs.nth(0).fill('ui-e2e-setup-key');
  await inputs.nth(2).fill('fuchs-admin');
  await inputs.nth(3).fill('password-123');
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page.getByRole('heading', { name: 'Парк техники' })).toBeVisible();

  await page.goto('/app/#/orgs');
  await page.getByPlaceholder('Название организации').fill('Дистрибьютор Северо-Запад');
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page.getByText('Дистрибьютор Северо-Запад')).toBeVisible();
  await page.locator('form select').first().selectOption('customer');
  await page.locator('form select').nth(1).selectOption({ label: 'Дистрибьютор Северо-Запад' });
  await page.getByPlaceholder('Название организации').fill('Леспромхоз Тайга');
  await page.getByRole('button', { name: 'Создать' }).click();
  await expect(page.getByText('Леспромхоз Тайга')).toBeVisible();

  await page.goto('/app/#/');
  await page.getByRole('button', { name: '+ Машина' }).click();
  await page.locator('.fixed form input').first().fill('Харвестер №7');
  await page.locator('.fixed form select').nth(1).selectOption('harvester');
  await page.getByPlaceholder('Марка').fill('John Deere');
  await page.getByPlaceholder('Модель').fill('1270G');
  await page.getByRole('button', { name: 'Добавить' }).click();
  await expect(page.getByRole('heading', { name: 'Харвестер №7' })).toBeVisible();

  await page.getByRole('button', { name: '+ Телефон (ссылка)' }).click();
  await expect(page.getByText(/Код действует 2 часа/)).toBeVisible();
  const codeEl = page.locator('.font-mono.text-5xl');
  await expect(codeEl).toHaveText(/^\d{6}$/);
  const code = (await codeEl.textContent())!.trim();
  await page.getByLabel('Закрыть').click();

  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    geolocation: { latitude: 61.7849, longitude: 34.3469, accuracy: 6 },
    permissions: ['geolocation'],
  });
  const cab = await phone.newPage();
  await cab.goto('/app/#/cab');
  await cab.locator('input').fill(code);
  await cab.getByRole('button', { name: 'Подключить' }).click();
  await expect(cab.getByText('Харвестер №7')).toBeVisible({ timeout: 20_000 });
  await cab.getByRole('button', { name: 'Начать работу' }).click();
  for (let i = 1; i <= 4; i++) {
    await phone.setGeolocation({ latitude: 61.7849 + i * 0.0004, longitude: 34.3469 + i * 0.0002, accuracy: 5 });
    await cab.waitForTimeout(5500); // the phone sends at most one fix per 5 s while moving
  }
  await cab.getByPlaceholder('например 4521,4').fill('4521,4');
  await cab.getByRole('button', { name: 'Отправить' }).click();
  await expect(cab.getByText('Показание сохранено на сервере')).toBeVisible();
  await expect(cab.getByText(/точек принято · (только что|\d+ мин назад)/)).toBeVisible({ timeout: 45_000 });
  await cab.screenshot({ path: `${SHOTS}/cab.png` });

  // positions travel through the phone outbox; poll the machine page like a dispatcher would
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(/61\.78\d+, 34\.34\d+/).first()).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 40_000 });
  await expect(page.getByText('4 521,4')).toBeVisible();
  await expect(page.getByText(/[2-9]\d* точек за период/)).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/machine.png`, fullPage: true });
  await page.goto('/app/#/');
  await expect(page.getByText('Харвестер №7')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/fleet.png`, fullPage: true });

  const harvester = page.getByRole('button', { name: 'Харвестер: 1' });
  await expect(harvester).toBeVisible();
  await harvester.click();
  await expect(harvester).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('row').filter({ hasText: 'Харвестер №7' })).toHaveCount(1);
  const machineSort = page.getByRole('columnheader', { name: /Машина/ });
  await expect(machineSort).toHaveAttribute('aria-sort', 'ascending');
  await machineSort.getByRole('button').click();
  await expect(machineSort).toHaveAttribute('aria-sort', 'descending');

  const layers = page.getByRole('button', { name: /^(Схема|Спутник|Гибрид|Топокарта)$/ });
  const hasLayerToolbar = await layers.isVisible({ timeout: 5_000 }).catch(() => false);
  if (hasLayerToolbar) {
    await layers.click();
    const hybrid = page.getByLabel('Гибрид');
    const preferenceSaved = page.waitForResponse((response) => response.url().includes('/api/me/preferences') && response.request().method() === 'PATCH');
    await hybrid.check();
    await preferenceSaved;
  } else {
    await page.evaluate(async () => fetch('/api/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${localStorage.getItem('itles_token')}` },
      body: JSON.stringify({ mapBase: 'hybrid' }),
    }));
  }
  await page.reload();
  if (hasLayerToolbar) {
    await expect(page.getByRole('button', { name: 'Гибрид' })).toBeVisible();
    await page.getByRole('button', { name: 'Гибрид' }).click();
    await expect(page.getByLabel('Гибрид')).toBeChecked();
  } else {
    await expect.poll(() => page.evaluate(async () => {
      const response = await fetch('/api/me/preferences', { headers: { authorization: `Bearer ${localStorage.getItem('itles_token')}` } });
      return (await response.json()).preferences.mapBase;
    })).toBe('hybrid');
  }

  const auth = await page.evaluate(() => ({ token: localStorage.getItem('itles_token'), api: localStorage.getItem('itles_api') }));
  const accountContext = await browser.newContext();
  await accountContext.addInitScript((state) => {
    if (state.token) localStorage.setItem('itles_token', state.token);
    if (state.api) localStorage.setItem('itles_api', state.api);
  }, auth);
  const otherAccountPage = await accountContext.newPage();
  await otherAccountPage.goto('/app/#/');
  await expect(otherAccountPage.getByRole('heading', { name: 'Парк техники' })).toBeVisible();
  await expect.poll(() => otherAccountPage.evaluate(async () => {
    const response = await fetch('/api/me/preferences', { headers: { authorization: `Bearer ${localStorage.getItem('itles_token')}` } });
    return (await response.json()).preferences.mapBase;
  })).toBe('hybrid');
  await accountContext.close();

  const machineId = await page.evaluate(async () => {
    const token = localStorage.getItem('itles_token');
    const response = await fetch('/api/machines', { headers: { authorization: `Bearer ${token}` } });
    return (await response.json()).machines[0].id as string;
  });
  const mobileAccount = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
  });
  await mobileAccount.addInitScript((state) => {
    if (state.token) localStorage.setItem('itles_token', state.token);
    if (state.api) localStorage.setItem('itles_api', state.api);
  }, auth);
  const mobileAccountPage = await mobileAccount.newPage();
  await mobileAccountPage.goto(`/app/#/machine/${machineId}`);
  await mobileAccountPage.getByRole('button', { name: '+ Телефон (ссылка)' }).click();
  await expect(mobileAccountPage.getByRole('link', { name: 'Подключить это устройство' })).toBeVisible();
  await mobileAccount.close();

  await cab.goto('/app/#/cab?code=123456');
  await expect(cab.getByText(/уже подключён к машине/)).toBeVisible();
  const replace = cab.getByRole('button', { name: 'Подключить и заменить привязку' });
  await expect(replace).toBeDisabled();
  await cab.getByLabel(/текущая привязка этого браузера будет заменена/).check();
  await expect(replace).toBeEnabled();
  await phone.close();
});
