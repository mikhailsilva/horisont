# АвтоГРАФ.WEB: тестовые серверы для коннектора

Руководство для пользователя: `docs/guide/autograph-technokom.pdf` (исходник — `.md`, сборка — `node docs/guide/render.mjs autograph-technokom`).

## Что есть

| Сервер | Что это | Для чего |
|---|---|---|
| `https://demo.tk-nav.com` (demo/demo) | Публичное демо **производителя** (настоящий АвтоГРАФ.WEB): архивы 2013 года и часть живых объектов | «Проверить без сохранения». Импорт в не-демо клиента запрещён сервером (`demo_only`) |
| `…/api/autograph-demo` в ITles | Синтетический эмулятор API (`platform/server/routes/autograph-demo.ts`), 3 машины: К-742М, John Deere 8R, МТЗ-82.1 | Кнопка «Заполнить личный тест · 3 машины» у реального суперадминистратора; токен на 24 ч; импорт только в демо-клиента |
| VDS (Zo), `stand/personal_autograph.py` | Тот же контракт на отдельном хосте за временным Cloudflare Quick Tunnel | Проверка по сети извне ITles |

Контракт проверен на `demo.tk-nav.com` 25.09.2026: `POST /ServiceJSON/Login` (form) → токен текстом; затем заголовок `AG-Token`; `EnumSchemas` → `EnumDevices?schemaID=` → `GetOnlineInfo`/`GetTrack?IDs=…` (не более 10 объектов, иначе HTTP 429); неверный логин/токен → 401. Моточасы и пробег коннектор берёт из онлайн-итогов схемы (`Final`), поэтому параметр вида «Накоп. МЧ» (`MotohoursByCANEmh`) должен быть включён в итоги у дилера.

## VDS — состояние на 25.09.2026 11:38 UTC

Каталог `/home/workspace/itles-autograph-demo` (Debian 12 под gVisor, без systemd): `personal_autograph.py`, `start.sh` (копия `stand/start-personal-autograph-zo.sh`), `.env` с режимом `0600` (логин `itles-demo`, случайный пароль — не коммитить и не публиковать). Процесс слушает `127.0.0.1:8766`, наружу — только через Quick Tunnel; адрес `*.trycloudflare.com` меняется при перезапуске и пишется в `public-url.txt`. Шлюз, стенд и Traccar-демо не перезапускались.

Проверено: без токена `EnumSchemas` → 401, неверный пароль → 401; `platform/scripts/autograph-check.ts` через публичный адрес получил 3 машины, 222 записи за 6 ч, моточасы и CAN-датчики у всех трёх. Перезапуск: `./start.sh` на хосте.

## Проверка

```bash
.venv/bin/python -m pytest -q tests/test_personal_autograph.py tests/test_autograph_paths.py
pnpm --dir platform exec vitest run tests/autograph.test.ts
AUTOGRAPH_URL=https://demo.tk-nav.com AUTOGRAPH_USER=demo AUTOGRAPH_PASSWORD=demo pnpm --dir platform exec tsx scripts/autograph-check.ts
```
