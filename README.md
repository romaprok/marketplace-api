# Marketplace API

Курсовий проєкт robot_dreams Node.js: API маркетплейсу, який від ДЗ до ДЗ обростає шаром даних, подіями, кешем, auth, файлами, кластером, а тепер логами, метриками й трейсами. Цей README описує поточний крок (hw-29), розділи попередніх ДЗ лежать у `docs/`.

## Документація

| ДЗ | Про що | Файл |
|---|---|---|
| hw-09, hw-11 | контракт API, конфіг, ротація пароля БД, таблиця змінних застосунку | [docs/configuration.md](docs/configuration.md) |
| hw-12 | SQL-схема, обсяг даних, індекси | [docs/hw-12-data-layer.md](docs/hw-12-data-layer.md) |
| hw-13 | TypeORM, міграції, N+1 | [docs/hw-13-typeorm.md](docs/hw-13-typeorm.md) |
| hw-14 | конкурентність, атомарний checkout | [docs/hw-14-concurrency.md](docs/hw-14-concurrency.md) |
| hw-15 | PgBouncer, бекап, restore-drill | [docs/hw-15-ops.md](docs/hw-15-ops.md) |
| hw-16 | testcontainers, supertest, Pact | [docs/hw-16-testing.md](docs/hw-16-testing.md) |
| hw-18 | realtime: socket.io і SSE | [docs/hw-18-realtime.md](docs/hw-18-realtime.md) |
| hw-19 | RabbitMQ, ack, DLQ | [docs/hw-19-rabbitmq.md](docs/hw-19-rabbitmq.md) |
| hw-22 | transactional outbox, ідемпотентність | [docs/hw-22-outbox.md](docs/hw-22-outbox.md) |
| hw-23 | Redis: кеш, сесії, ліміт, BullMQ | [docs/hw-23-redis.md](docs/hw-23-redis.md) |
| hw-24 | JWT, ротація refresh, RBAC | [docs/hw-24-auth.md](docs/hw-24-auth.md) |
| hw-26 | presigned, multipart, edge-кеш | [docs/hw-26-files.md](docs/hw-26-files.md) |
| hw-28 | distroless-образ, сканер, kind, Pulumi, rolling update | [docs/hw-28-kubernetes.md](docs/hw-28-kubernetes.md) |

## Observability (hw-29)

О 03:15 один запит віддав 500. Що з ним сталося? Тепер на це є хвилинна відповідь. Беремо `trace_id` з рядка логу, по ньому відкриваємо трейс у Tempo, і там видно, на якому SQL-запиті все відкотилось і з якою помилкою. Скільки ще таких було і чи повільніше стало, показує дашборд. Ключ скрізь один: `trace_id` активного спана OpenTelemetry. Власного uuid-корелятора немає.

```
клієнт ── traceparent ──► Postgres API (node --import dist/telemetry/otel.js)
                           ├── pino → stdout, рядок = JSON: trace_id зі спана, user_id і idempotency_key з AsyncLocalStorage
                           ├── GET /metrics ◄────── Prometheus :22901, scrape кожні 5 с
                           └── OTLP/HTTP ─────────► Tempo :22918 (прийом) / :22904 (трейс за id)
Grafana :22900: Prometheus і Tempo як датасорси з provisioning, дашборд RED з JSON у репо
```

| Змінна | Джерело | Навіщо |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | сховище (#11) | куди API шле спани; без неї `otel.ts` не стартує і називає змінну |
| `PROMETHEUS_URL` | сховище (#11) | `demo:metrics` звіряє з Prometheus свої числа і запити панелей |
| `TRACE_API_URL` | сховище (#11) | `demo:trace` читає трейс за id з Tempo |
| `GRAFANA_ADMIN_PASSWORD` | сховище (#11) | пароль адміна Grafana, `npm run obs:up` передає його в compose |
| `LOG_LEVEL` | оточення, `info` | рівень pino |
| `OTEL_BSP_SCHEDULE_DELAY` | оточення, 5000 | як часто батч спанів іде в Tempo; `demo:trace` ставить своєму поду 200 |

Решта (`DB_URL`, обидва Redis, `JWT_*`, `STORAGE_*`) така сама, як для API з hw-24/26. Нового env-файлу немає. Усі npm-скрипти, яким потрібні значення, стоять на `scripts/with-secrets.sh`.

### Стенд

`observability/compose.yaml` підключений у `docker-compose.yml` через `include`, тож той самий `docker compose up -d --wait` піднімає і його. Версії: Tempo 2.10.10, Prometheus 3.15.1, Grafana 13.2.4. Порти лежать у діапазоні 22900-22999.

Пам'ять (`docker stats --no-stream`, Docker Desktop з 7,65 ГіБ). Без стенда решта compose займає 760 МіБ. Зі стендом виходить 1158 МіБ: Grafana 313, Prometheus 55, Tempo 29. Після прогонів демо Grafana тримається на 307, Prometheus на 48, Tempo на 55. Разом із вузлом kind з hw-28 (907 МіБ) це близько 2,1 ГіБ, тож влазить із запасом. Grafana тут найдорожча. Ще й на кожному старті вона качала з grafana.com 18 плагінів, серед них навіть «оновлення» вбудованих Prometheus і Tempo. Це вимкнено (`GF_PLUGINS_PREINSTALL_DISABLED=true`): стенд не залежить від мережі, а обидва датасорси на вбудованих версіях відповідають `OK`.

В образі Tempo немає ні shell, ні wget, тож healthcheck усередині не написати. Його готовність (`/ready`) перевіряє healthcheck Grafana. Це важливо: перші ~15 с Tempo ще вступає у власний ring і відкидає спани. Без цього `demo:trace` одразу після `up --wait` нічого б не знайшов.

### Логи

pino, один JSON-об'єкт на рядок у stdout. Куди їх везти далі, вирішує платформа (`kubectl logs`, колектор), процес у файли не пише. `trace_id` і `span_id` додає `mixin` логера в момент виклику, з `trace.getActiveSpan()`. `user_id` (з hw-24) і `idempotency_key` (з hw-22) лежать в AsyncLocalStorage (`src/telemetry/context.ts`). Жодна функція не приймає `req` заради логу. tenant у маркетплейсі один, тож цього поля немає.

Компонент називає поле `layer`. Чекаут проходить чотири шари: `checkout.controller` → `orders.service` → `orders.repo`, а `http` пише рядок доступу, коли відповідь пішла. Один чекаут дає 6 рядків:

```json
{"level":"info","layer":"orders.repo","trace_id":"3e2559f9…3101","span_id":"…","user_id":"2079295e-…","idempotency_key":"8ac8936b-…","quantity":1,"msg":"stock reserved"}
{"level":"info","layer":"http","trace_id":"3e2559f9…3101","method":"POST","route":"/v1/checkout","status":201,"duration_ms":17,"msg":"request finished"}
```

Рядок доступу пишеться з `res.on('finish')`. Спершу я обгорнув цей обробник в `AsyncResource.bind`, а потім прибрав: з ним і без нього `demo:logs` дає ті самі числа. Обробник створюється всередині запиту і несе його контекст із собою. Контекст губиться в колбеках, створених поза запитом, а на шляху чекауту таких немає. Колбеки пулу pg, які могли б загубити контекст, OpenTelemetry прив'язує сам, і сплеск із 8 паралельних запитів це підтверджує.

Невдалий запит (4xx/5xx) несе в рядку доступу заголовки і тіло, бо саме його потім шукатимуть. Секрети в них ховає `redact`: `req.headers.authorization`, `req.headers.cookie`, `req.body.password`, `req.body.refresh_token`, `req.body.email`. Шляхи точні, redact їх не вгадує. Пароль на рівень глибше (`req.body.credentials.password`) пішов би в лог як є. У JSON переведено весь шлях запиту API (`console.*` там більше немає). Окремі процеси (relay, consumer, worker, edge) лишились на `console`, вони поза цим ДЗ.

### Метрики

RED на рівні HTTP, в одному middleware з рядком доступу, щоб лог і метрики не могли розійтись:

- `http_requests_total{method, route, status}`: Rate і Errors;
- `http_request_duration_seconds{method, route}`: Duration, histogram.

Summary не беру, бо його квантилі між інстансами не агрегуються. `route` береться з шаблону Express (`/v1/orders/:orderId`), сирий шлях туди не йде. Усе, що закінчилось до маршрутизації (невідомий шлях, поганий токен, ліміт 429), отримує одне значення `unmatched`. `/metrics` стоїть перед лімітером і в RED не рахується, у трейси скрейпи теж не потрапляють. Метрики віддає `@prometheus-io/client` 0.16.1: це той самий prom-client, переїхав під організацію Prometheus, а старий пакет позначено deprecated.

Межі бакетів, у секундах: `0.005 0.01 0.025 0.05 0.1 0.25 0.5 1 2.5 5`.

Чекаут у демо триває 5-100 мс, і найповільніші (до 103 мс) стоять у черзі на блокування рядка товару. Найдовший запит у системі це логін: scrypt (N=2^15) дає 190-230 мс. Дрібні бакети до 250 мс дають роздільність саме там, де живуть звичайні запити. 0.5-5 с лишені під деградацію: Redis з таймаутом 500 мс, очікування блокувань, повільна база. Такі запити мають лягти в якийсь бакет: у `+Inf` вони зникли б для будь-якого квантиля. Верхній скінченний бакет 5 с у 20 разів більший за найгірший випадок. Коли я тимчасово поставив бакети до 25 мс, 58 з 62 чекаутів опинились вище верхньої межі, і квантиль показав саму межу.

Гістограма не знає, де саме в бакеті лежить запит, і квантиль інтерполює всередині бакета. У трьох прогонах клієнт виміряв p95 чекауту 87, 65 і 80 мс, а `histogram_quantile` з Prometheus дав 96, 95 і 95. Обидва p95 правдиві, просто гістограма знає лише, що запит ліг у бакет 50-100 мс.

Ще одна пастка: ряд, що з'явився одразу зі значенням 10, не має точки «до», і `rate()` показує весь стрибок як нуль. Тому `demo:metrics` спершу прогріває кожен ряд (201, 500, 404) і чекає, поки Prometheus їх зіскрейпить.

### Трейси

`src/telemetry/otel.ts` вантажиться через `node --import` перед застосунком (`npm start`, `npm run orders-api`, поди демо). Інструментації патчать http, express і pg у момент, коли ті завантажуються, тож мусять бути зареєстровані раніше. Імпорт першим рядком `orders-api.ts` не допоміг би: ESM лінкує всі імпорти, перш ніж виконати бодай один. Наш код ESM, і express приходить через `import`, повз `require()`. Без loader-хука `@opentelemetry/instrumentation/hook.mjs` express-інструментація його не бачила. Серверний спан тоді звався просто `POST`, без маршруту і без спана обробника. pg і http завантажуються через `require()` з CommonJS всередині typeorm і express, тому їх патчило і без хука.

Що в трейсі одного чекауту: серверний спан `POST /v1/checkout` (http), під ним `request handler - /v1/checkout` (express, лише обробники, без спанів на кожен роутер і middleware), а під ним 11 спанів pg: з'єднання з пулу і 10 запитів, від `START` до `ROLLBACK`. Вхідний `traceparent` продовжується пропагатором W3C. Статус ERROR для 5xx ставить сама http-інструментація, для 4xx статус лишається Unset. Помилку контролер кладе і в лог, і в спан обробника (`recordException`, статус ERROR з повідомленням), тож у трейсі видно не лише, що впало, а й що саме. OpenTelemetry взято лінії 3.0: `@opentelemetry/sdk-trace` 3.0.0, `exporter-trace-otlp-proto` 0.300.0. Експорт батчами, раз на 5 с.

Звідки 500 у демо. Под демо (`src/demo-pod.ts`) підставляє `placeOrder` хук `beforeCommit`: якщо Idempotency-Key починається з `fail-`, хук кидає помилку вже після списання залишку і балансу. Тож 500 народжується глибоко в транзакції і закінчується `ROLLBACK`, як справжня відмова. У звичайному API цього хука немає.

### Дашборд

`observability/grafana/dashboards/marketplace-red.json`, uid `marketplace-red`. Датасорси і провайдер дашбордів провіжаться з `observability/grafana/provisioning/`. uid датасорсів фіксовані, і JSON на них посилається. Дашборд відкривається без логіну (анонімний Viewer), а змінювати щось можна лише адміном.

| Панель | Питання | PromQL |
|---|---|---|
| Rate | скільки запитів на секунду, по маршрутах | `sum by (route) (rate(http_requests_total{job="marketplace-api"}[1m]))` |
| Errors | яка частка закінчується 5xx | `sum by (route) (rate(http_requests_total{job="marketplace-api", status=~"5.."}[1m])) / sum by (route) (rate(http_requests_total{job="marketplace-api"}[1m]))` |
| Duration | за скільки відповідаємо, p95 і p99 | `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{job="marketplace-api"}[1m])))` і те саме з 0.99 |

`[1m]` замість звичних `[5m]` обрано під хвилинне демо. Prometheus скрейпить `host.docker.internal:3001` (`npm run orders-api`) і `:22910`, де `demo:metrics` піднімає свій под. Той із двох, що не запущений, просто `down`. Наприкінці `demo:metrics` виконує всі запити панелей проти Prometheus і друкує `dashboard-panels-with-data`. Це бонусний рядок, не частина вердикту: він залежить від того, чи бачить Prometheus хост. На Docker Desktop бачить. На Linux `host-gateway` веде на адресу хоста в мережі Docker, а под слухає лише 127.0.0.1, тож там рядок, найімовірніше, покаже 0.

### Три демо, по три прогони

Кожне демо на старті чистить базу (`prepareDb`) і бере свій простір імен лімітера. Усі числа порахані з виводу пода і з `/metrics`. Демо саме перевіряє інваріант і за порушення виходить з кодом 1.

`npm run demo:logs`, усі три прогони дали однаковий результат, ~4 с кожен:

```
layers=4  distinct-trace-ids=1  trace-id-matches-header=1  lines-of-request=6
burst=8  burst-trace-ids=8  burst-uneven=0  burst-lines-per-request=6  burst-matches-header=1
secret-req-logged=1  secret-in-logs=0  non-json-lines=0
```

Рядки першого запиту знаходяться за його Idempotency-Key, тож `trace_id` тут лише перевіряється. Для сплеску групуються всі рядки, що з'явились у його вікні, незалежно від того, звідки. Секрети йдуть двома запитами: вигаданий bearer-токен (401 від `authenticate`) і неправильний пароль у тілі логіну (401 від маршруту).

`npm run demo:metrics`, ~15 с:

| прогін | sent-ok / fail | counter-delta | errors-delta | above-top-bucket | series before → after | найповільніший, мс | p95 клієнт / Prometheus, мс |
|---|---|---|---|---|---|---|---|
| 1 | 50 / 10 | 60 | 10 | 0 | 4 → 4 | 101 | 87 / 96 |
| 2 | 50 / 10 | 60 | 10 | 0 | 4 → 4 | 70 | 65 / 95 |
| 3 | 50 / 10 | 60 | 10 | 0 | 4 → 4 | 103 | 80 / 95 |

Сто різних id замовлень дають сто 404 і жодного нового ряду. У всіх трьох прогонах `prometheus-in-sync=1` і `dashboard-panels-with-data=3`.

`npm run demo:trace`, ~5 с:

```
http-status=500  spans=13  orphan-spans=0  server-parent-matches-header=1
trace-matches-header=1  trace-matches-log=1  span-status-error=1  trace-wait-ms=749 / 744 / 732
```

Спани демо читає з Tempo, звідти ж, куди дивилася б людина. Под шле батч раз на 200 мс, і демо опитує `/api/traces/<id>`, поки серверний спан не з'явиться і кількість спанів не перестане рости. Єдиний батьківський спан, якого в трейсі легітимно немає, це наш із заголовка, і демо окремо перевіряє, що серверний спан посилається саме на нього.

### Що зламав, щоб перевірити демо

| Зміна | Що показало демо |
|---|---|
| «поточний запит» у змінній модуля замість ALS/спана | `burst-trace-ids=1`: усі 48 рядків сплеску під одним id |
| свій uuid як корелятор у логах | `trace-matches-log=0` |
| пропагатор W3C не зареєстровано | трейс пішов під новим id: `spans=0`, `trace-matches-header=0` |
| сирий шлях у `route` | `series-after=104` при `series-before=4` |
| бакети лише до 25 мс | `above-top-bucket=58` |
| прибрано шлях `req.body.password` | `secret-in-logs=1` |
| прибрано шлях `req.headers.authorization` | `secret-in-logs=1` |
| демо валить чекаут 409 замість 500 | `span-status-error=0`: 4xx лишає статус Unset |

### SLO

SLI для чекауту: частка відповідей `/v1/checkout`, що не 5xx. SLO 99,5 % за 30 днів. Бюджет помилок: 0,005 × 30 діб × 24 год × 60 хв = 216 хвилин на місяць, або кожен двохсотий чекаут. Рахується з того самого лічильника: `1 - sum(increase(http_requests_total{route="/v1/checkout",status=~"5.."}[30d])) / sum(increase(http_requests_total{route="/v1/checkout"}[30d]))`. Алерт ставиться не на сам SLI, а на швидкість, з якою згорає бюджет (burn rate) у коротшому вікні, наприклад за годину. Живого алерта тут немає, ДЗ його не просить.

Також немає доставки логів у Loki, tail-based sampling, Sentry/GlitchTip і другого сервісу з вихідним викликом. Трейси пишуться всі (AlwaysOn). Для демо так і треба, а в бою семплінг був би першим питанням.

### Grading (hw-29: Observability)

Потрібні Docker і Node 22.15+. Порти 22900, 22901, 22904, 22910 і 22918 на хості мають бути вільні.

```bash
docker compose up -d --wait   # Postgres, PgBouncer, обидва Redis, MinIO і стенд: Prometheus, Grafana, Tempo

export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:22918
export PROMETHEUS_URL=http://127.0.0.1:22901
export TRACE_API_URL=http://127.0.0.1:22904
export DB_URL=postgres://marketplace@127.0.0.1:6432/marketplace
export DB_PASSWORD_FILE=secrets/db_password.example
export REDIS_URL=redis://127.0.0.1:6380
export REDIS_QUEUE_URL=redis://127.0.0.1:6381
export STORAGE_ENDPOINT=http://127.0.0.1:9900
export STORAGE_ACCESS_KEY=marketplace
export STORAGE_SECRET_KEY=dev_local_only_changeme
export STORAGE_BUCKET=marketplace-files
export SKIP_VAULT=1            # у грейдера немає доступу до сховища

# под демо це API з hw-24, йому потрібна пара ES256; одноразова, PEM у base64
node -e 'const {generateKeyPairSync}=require("node:crypto");
const k=generateKeyPairSync("ec",{namedCurve:"P-256",
  privateKeyEncoding:{type:"pkcs8",format:"pem"},
  publicKeyEncoding:{type:"spki",format:"pem"}});
const fs=require("node:fs");
fs.writeFileSync("/tmp/priv.b64",Buffer.from(k.privateKey).toString("base64"));
fs.writeFileSync("/tmp/pub.b64",Buffer.from(k.publicKey).toString("base64"));'
export JWT_KID=grader
export JWT_PRIVATE_KEY="$(cat /tmp/priv.b64)"
export JWT_PUBLIC_KEY="$(cat /tmp/pub.b64)"
export REFRESH_TOKEN_PEPPER="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"

npm ci

npm run demo:logs
npm run demo:metrics
npm run demo:trace
```

Демо самі збирають TypeScript (`tsc`) і накочують міграції. Под API вони піднімають окремим процесом із `--import` трейсингу і вбивають після себе. Дашборд: http://127.0.0.1:22900. Основний шлях без `SKIP_VAULT` той самий: адреси стенда, пароль Grafana і все для API приїжджають зі сховища через `scripts/with-secrets.sh`, а стенд через сховище піднімає `npm run obs:up`.
