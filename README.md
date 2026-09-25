# ITles — моточасы, пробег и местоположение спецтехники (FUCHS)

**v2 — работающий код и протокольный стенд; испытания на смонтированной машине впереди.** Архитектура и ответы заказчика — в [диздоке v2](docs/design/DESIGN-v2.md), проверенное состояние — в [ROADMAP](docs/ROADMAP.md). Отдельно собраны [решения из диалогов, ключи по именам и следующие шаги](docs/research/dialogue-decisions-and-next-steps.md) и [история восстановления](docs/research/project-history.md).

**Перенос 25.09.2026.** В ветке по умолчанию [`mikhailsilva/horisont`](https://github.com/mikhailsilva/horisont) после squash-слияния [PR #1](https://github.com/mikhailsilva/horisont/pull/1) находится дерево исходников `raulwulff6769/framework-lab` с изменениями PR #5. Исходные Git-предки PR #5 не входят в историю этой ветки: полная история доступна в том же репозитории по [архивному тегу `archive/framework-lab-pr5-2026.09.25`](https://github.com/mikhailsilva/horisont/tree/archive/framework-lab-pr5-2026.09.25), дерево которого совпадает с импортом. Upstream — источник переноса, новые PR открываются здесь, а не в upstream или прежних [`somemateria/biildfe4`](https://github.com/somemateria/biildfe4) / [`clutteredcal/ITles`](https://github.com/clutteredcal/ITles). Перенос Git не меняет production-базу и действующий деплой Vercel: по последней проверке 24.09 `itles.vercel.app` обслуживает выпуск по закреплённому SHA из framework-lab. Новый код проверять локальными тестами и изолированным Preview ([руководство Vercel](docs/operations/vercel.md)).

Архивные [APK Android](https://github.com/mikhailsilva/horisont/releases/tag/android-2026.09.24) и [ZIP Windows](https://github.com/mikhailsilva/horisont/releases/tag/desktop-2026.09.24) от 24.09 перенесены отдельными prerelease с исходными тегами и без пересборки. Они **старше текущего кода** и не проверены на физических устройствах; прежний v0.3.0 остался в [старой копии](https://github.com/clutteredcal/ITles/releases/tag/v0.3.0). Ключ подписи APK не переносился — обновления поверх этой сборки потребуют оригинальный ключ либо новой установки.

| Часть | Где | Проверка |
|---|---|---|
| API + веб-кабинет + лендинг + «Телефон в кабине» | `platform/` | `cd platform && pnpm test` (PGlite; `TEST_DATABASE_URL=postgres://…` — на PostgreSQL), `pnpm e2e` (Playwright) |
| Шлюз трекеров (EGTS, Wialon IPS, Galileosky, Wialon Retranslator; ограниченный FLEX 1.0/2.0) | `gateway/` | `python -m pytest tests` (пакеты из набора Traccar для прежних протоколов; примеры производителя и имитатор для FLEX) |
| Сквозной прогон трекер → шлюз → платформа | `scripts/gateway_e2e.py` | `.venv/bin/python scripts/gateway_e2e.py --output /tmp/itles-gateway-e2e.json` (отчёт вне Git); `docs/evidence/gateway-e2e.json` — архивный прогон трёх машин |
| Проверка одометрии | `scripts/odometry_validation.py` | `docs/evidence/odometry-validation.json` |
| Windows / Android | `apps/desktop`, `apps/mobile` | исходники здесь; архивные binaries 24.09 — в prerelease [`desktop-2026.09.24`](https://github.com/mikhailsilva/horisont/releases/tag/desktop-2026.09.24) и [`android-2026.09.24`](https://github.com/mikhailsilva/horisont/releases/tag/android-2026.09.24), не из текущей головы и без проверки на реальных устройствах |

Запуск на своём сервере (VPS): `cd platform && pnpm install && pnpm build && DATABASE_URL=postgres://… SETUP_KEY=… GATEWAY_TOKEN=… node --import tsx dev/server.ts`;
шлюз: `cd gateway && ITLES_API_URL=https://… GATEWAY_TOKEN=… python3 -m itles_gateway`.
Файловая SQLite-очередь шлюза требует POSIX-файловых прав и каталога без записи
для других пользователей; запускать её на доверенном Linux/POSIX-сервере, не
в общем каталоге. Windows-приложение — отдельный клиент, не серверный шлюз.
Приём NTCB/FLEX включается отдельно: `PORT_NAVTELECOM_FLEX=<выбранный порт>`.
Для FLEX 1.0/2.0 проверены базовые поля моточасов, пробега и координат по
публичным примерам производителя и синтетическому TCP-прогону, **не по
смонтированному терминалу**. Поддерживается незашифрованный NTCB с преамбулой
`@NTC` для идентификации и согласования FLEX, а не старые команды телеметрии NTCB.
FLEX 3.0 запрашивается понизить до 2.0; пользовательские поля 207+ для
Modbus-масла, произвольные преамбулы и шифрование не поддерживаются. До пилота
нужна сквозная политика отключения координат на шлюзе и проверка терминала на стенде.
Для счётчиков в маске обязательно поле 3 (время события); при нулевом времени
события кадр со счётчиками не получает ACK, и архив может застрять. Время
последней фиксации координат не подменяет время события: исправление часов
предотвратит новые ошибки, но уже сформированные записи требуют отдельного
решения об их обработке.
Vercel: из корня `pnpm --dir platform build:vercel` формирует `platform/.vercel/output` (Build Output API v3); состояние действующего проекта и порядок безопасного обновления — в [операционном руководстве](docs/operations/vercel.md). Для локального превью лендинга и API: из корня `npm run dev` (зависимости платформы установятся, сборка создаст `platform/dist`, сервер запустится на `:5173` с локальной PGlite).

---

# ITles × FUCHS — телематика моточасов, пробега и местоположения спецтехники

Технический проект и проверочный стенд системы «устройство на машине → сервер → ПК/телефон»
для FUCHS, дистрибьюторов FUCHS и конечных клиентов (поле, лес, карьер, стройка, дорога).

| Что | Где |
|---|---|
| Диздок (главный документ) | [`docs/design/DESIGN.md`](docs/design/DESIGN.md) |
| Excel: таблицы, расчёты, результаты стенда, риски, вопросы | [`deliverables/ITles_Fuchs_telematics.xlsx`](deliverables/ITles_Fuchs_telematics.xlsx) |
| Результаты моделирования (генерируются) | [`docs/simulation-results.md`](docs/simulation-results.md) |
| Методика и допущения модели | [`docs/simulation-report.md`](docs/simulation-report.md) |
| Сквозной прогон через реальный шлюз | [`docs/evidence/traccar-e2e.json`](docs/evidence/traccar-e2e.json) |
| Аудит прежней ветки `hoplite/thasos-804ac857` | [`docs/audit-previous-branch.md`](docs/audit-previous-branch.md) |
| Источники | [`docs/research/sources.md`](docs/research/sources.md) |
| Конфигурация шлюза устройств | [`infra/traccar/traccar.xml`](infra/traccar/traccar.xml) |

## Что здесь реальное

Протокольный слой не имитируется: пакеты Galileosky, Wialon IPS 2.0 и EGTS собираются по
спецификациям байт в байт и проверяются на пакетах реальных устройств; их принимает настоящий
Traccar 6.15.3. Моделируются только машина (смены, электрика, движение), приёмник GNSS и
покрытие сети — с явными допущениями.

## Воспроизведение

```sh
uv venv .venv --python 3.12 && . .venv/bin/activate
uv pip install -r requirements.txt
python -m pytest -q                      # тесты, включая пакеты из наборов реальных устройств
python scripts/run_scenarios.py          # сценарии → docs/simulation-results.md, docs/img/
python scripts/build_workbook.py         # Excel → deliverables/
```

Пересчёт формул Excel (чтобы значения были видны без Excel):
`soffice --headless --calc --convert-to xlsx --outdir /tmp/recalc deliverables/ITles_Fuchs_telematics.xlsx`
и копирование результата обратно.

### Сквозной прогон через Traccar

Нужны Java 21 и сборка `traccar-other-6.15.3.zip` с GitHub-релиза Traccar.

```sh
cp infra/traccar/traccar.xml <traccar>/conf/traccar.xml
(cd <traccar> && java -jar tracker-server.jar conf/traccar.xml &)
# первый пользователь Traccar становится администратором:
curl -X POST http://127.0.0.1:8082/api/users -H 'Content-Type: application/json' \
     -d '{"name":"stand-admin","email":"stand-admin@local","password":"<пароль>"}'
TRACCAR_USER=stand-admin@local TRACCAR_PASSWORD='<пароль>' python scripts/traccar_e2e.py --days 2
```

Скрипт поднимает приёмник пересылки на `127.0.0.1:9100`, моделирует 7 классов машин,
отправляет данные по TCP (Galileosky :5034, Wialon IPS :5039, EGTS :5165), ждёт пересылку,
сверяет с базой шлюза и пишет `docs/evidence/traccar-e2e.json`.

### Стенд квалификации трекера (реальное железо)

Эмулятор ЭБУ шлёт кадры J1939 модели машины и отвечает на запросы PGN 59904. С USB-CAN
адаптером, подключённым ко входу CAN трекера:

```sh
python -m sim.canbus --profile harvester --interface socketcan --channel can0 --realtime --log bench.asc
```

В песочнице доступна только `--interface virtual`.

## Ограничения

Работа на конкретной машине (доступ к CAN, программа считывателя, монтаж, покрытие сети) здесь
не проверяется — это стенд квалификации и пилот (диздок, раздел 9). Семантика тегов CAN_B0/CAN_B1
Galileosky — гипотеза H-GS-1, подлежит стендовой проверке.
