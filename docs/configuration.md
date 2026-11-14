# Конфігурація і секрети (hw-09, hw-11)


Третє ДЗ курсового проєкту (hw-12) додає шар даних поверх конфігурації з hw-11: SQL-схему, реалістичний обсяг даних і чотири "повільні" запити API, доведені до індексного плану — включно з повнотекстовим пошуком по каталогу. Опис нижче про hw-11 (конфіг і секрети) лишився без змін, це той самий фундамент.

```
process.env → zod-схема (fail-fast) → ConfigService → код
secrets/db_password → password: () => readFile() → pg.Pool → Postgres
```

Фінальний штрих — ротація пароля БД без рестарту сервісу.

## Configuration

Усі змінні описані в `src/config/env.schema.js` однією zod-схемою. `.env.example` — контракт, синхронність із схемою перевіряє `npm run check:env`. Реальний `.env` в git не потрапляє.

| Змінна | Обов'язкова | За замовчуванням | Що це |
|---|---|---|---|
| `NODE_ENV` | ні | `development` | `development` \| `production` \| `test` |
| `PORT` | ні | `3000` | Порт API hw-09 (`npm run start:inmemory`) |
| `ORDERS_API_PORT` | ні | `3001` | Порт Postgres API (`npm start`, з hw-24): checkout (hw-22), картка товару і сесія (hw-23), auth (hw-24) |
| `DB_URL` | **так** | — | Рядок підключення без пароля. Веде на PgBouncer, не на Postgres: `postgres://marketplace@localhost:6432/marketplace`. Значення живе у сховищі (dev і prod), у `.env.example` тільки контракт |
| `DB_PASSWORD_FILE` | ні | `./secrets/db_password` | Шлях до файла з поточним паролем БД |
| `BROKER_URL` | тільки для подій | — | RabbitMQ з логіном і паролем, порт AMQP: `amqp://user:pass@localhost:5672`. Живе у сховищі (dev і prod) поруч із `DB_URL`, у `.env.example` лише плейсхолдер. HTTP API без нього стартує |
| `REDIS_URL` | для `orders-api` і демо hw-23 | — | Redis під кеш і лічильники ліміту (allkeys-lru): `redis://localhost:6380`. Живе у сховищі поруч із `DB_URL` |
| `REDIS_QUEUE_URL` | для `orders-api`, `worker` і демо hw-23 | — | Окремий Redis під BullMQ і сесії (noeviction + AOF): `redis://localhost:6381`. Теж у сховищі |
| `JWT_KID`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` | для `npm start` і демо hw-24 | — | Ключ підпису access-токенів ES256 і його id. Тільки у сховищі, деталі в розділі Auth |
| `JWT_PREV_KID`, `JWT_PREV_PUBLIC_KEY` | лише під час ротації ключа | — | Попередній публічний ключ, теж зі сховища |
| `REFRESH_TOKEN_PEPPER` | для `npm start` і демо hw-24 | — | Перець для HMAC-хешів refresh-токенів, тільки у сховищі |
| `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET` | для `npm start`, `edge` і демо hw-26 | — | Доступ до S3-сумісного сховища. Тільки у сховищі, деталі в розділі Files |
| `STORAGE_ENDPOINT` | ні | порожньо (AWS S3) | Адреса S3-сумісного сховища, локально MinIO: `http://localhost:9900` |
| `STORAGE_REGION` | ні | `us-east-1` | Регіон для підпису SigV4 |
| `EDGE_PORT` | ні | `9910` | Порт `npm run edge`, кешу перед бакетом |
| `DB_PASSWORD` | лише в поді | — | Пароль БД з K8s Secret (hw-28); якщо заданий, має пріоритет над `DB_PASSWORD_FILE` |
| `WARMUP_MS` | ні | `0` | Пауза перед `listen()`; у Deployment 4000, імітує міграції й пул (hw-28) |
| `DRAIN_MS` | ні | `0` | Дренаж після SIGTERM, поки `/readyz` уже червоний; у Deployment 5000 (hw-28) |
| `IDEMPOTENCY_TTL_HOURS` | ні | `24` | Скільки годин пам'ятаємо Idempotency-Key |
| `LOG_LEVEL` | ні | `info` | `debug` \| `info` \| `warn` \| `error` |

Пароль БД **не** зчитується з env — тільки з файлу (`DB_PASSWORD_FILE`), і `pg.Pool` перечитує цей файл на кожне нове з'єднання. Завдяки цьому пароль можна ротувати без рестарту процесу.

Виняток з hw-28: у поді Kubernetes пароль приходить змінною `DB_PASSWORD` з K8s Secret. Там ротація означає новий под, тобто звичайний rollout, а файловий шлях лишається для локального запуску.

### Як запустити

```bash
npm install
cp .env.example .env
cp secrets/db_password.example secrets/db_password

docker compose up -d          # піднімає Postgres з тим самим паролем, що в secrets/db_password.example
npm run start:inmemory        # до hw-24 це був npm start; тепер npm start запускає Postgres API (розділ Auth)
```

Перевірка, що все підключилось:

```bash
curl http://localhost:3000/health
# {"status":"ok","uptime":1.23,"db":"ok"}
```

Якщо прибрати обов'язкову змінну — процес одразу падає з описом того, що саме не так:

```bash
env -u DB_URL npm run start:inmemory
# Invalid environment configuration:
#   - DB_URL: Required
```

### Як виконати ротацію пароля

```bash
bash rotate.sh
```

Скрипт (виконується всередині контейнера Postgres через `docker compose exec`, локальний `psql` не потрібен):

1. Міняє пароль ролі в самій базі (`ALTER ROLE ... WITH PASSWORD ...`) — це першоджерело правди.
2. Тільки після успіху перезаписує `secrets/db_password`.
3. Розриває старі з'єднання (`pg_terminate_backend`), щоб пул був змушений відкрити нові — саме нові з'єднання підхоплюють оновлений пароль.

Сервер під час усього цього не перезапускається — `curl http://localhost:3000/health` продовжує повертати 200, а `uptime` у відповіді тільки росте.

Якщо після цього зробити `docker compose down -v` — Postgres підніметься заново зі стартовим паролем з `db/init.sql`, а `secrets/db_password` лишиться зі старим (ротованим) значенням. Щоб знову синхронізувати — `cp secrets/db_password.example secrets/db_password`.

### Перевірка, що конфіг не розповзається

```bash
npm run check:env    # .env.example відповідає env.schema.js
```

## Секрети поза git і поза образом

- `.env` і `secrets/db_password` — у `.gitignore`, у git лежить лише `.env.example` і `secrets/db_password.example`.
- `Dockerfile` копіює тільки код і `.env.example`; `.dockerignore` виключає `.env`, `secrets/`, тести і решту, що застосунку в проді не треба.
- Пароль в образ не потрапляє на жодному шарі — можна перевірити `docker history --no-trunc <image> | grep -i password`, там пусто.

## Тести

```bash
npm test
```

## Чому саме так

- **`z.coerce.number()`, а не `z.number()`.** Усе, що приходить з env, — рядок; без `coerce` схема впаде на будь-якому числовому полі.
- **Секрет із файлу, а не з env.** Env-змінні надто легко просвічуються (process listings, CI-логи, `docker inspect`, crash-репортери) — файл, який читає лише власний користувач застосунку, звужує поверхню витоку і дозволяє міняти значення без зміни env і рестарту.
- **`password` як функція, а не рядок.** `pg` викликає її на кожне нове фізичне з'єднання — саме це дає ротацію без рестарту.
- **`pool.on('error', ...)` обов'язковий.** Після `pg_terminate_backend` будь-який простійний клієнт зі старим паролем кине неопрацьовану `'error'`-подію — без обробника процес впаде, і це не баг ротації, а відсутній listener.
- **`ALTER ROLE` → файл → `pg_terminate_backend`, саме в такому порядку.** Якщо перший крок впаде, файл (і застосунок) лишаються синхронними з тим, що БД реально приймає.
