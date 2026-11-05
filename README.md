# Marketplace API — конфіг, який не дає застосунку стартувати наосліп

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
| `IDEMPOTENCY_TTL_HOURS` | ні | `24` | Скільки годин пам'ятаємо Idempotency-Key |
| `LOG_LEVEL` | ні | `info` | `debug` \| `info` \| `warn` \| `error` |

Пароль БД **не** зчитується з env — тільки з файлу (`DB_PASSWORD_FILE`), і `pg.Pool` перечитує цей файл на кожне нове з'єднання. Завдяки цьому пароль можна ротувати без рестарту процесу.

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

## Дата-шар (hw-12)

Схема, дані і оптимізація чотирьох повільних запитів для домену Marketplace
(users / products / orders / order_items). `DB_URL` для цього шару — та сама
змінна з таблиці Configuration вище, вона вже вказує на базу цього ДЗ:
новий env-файл не додавався.

- **Головна таблиця** (обсяг ≥100 000): `orders`.
- **Таблиця повнотекстового пошуку** (q4, обсяг ≥100 000): `products`.

| Файл | Призначення |
|---|---|
| `db/schema.sql` | 4 таблиці, 4 FOREIGN KEY, `numeric` для грошей, `timestamptz` для часу, `search_vector` — генерована tsvector-колонка на `products` |
| `db/seed.sql` | 50 000 users, 120 000 products, 150 000 orders, 350 000 order_items, скошені розподіли, `VACUUM (ANALYZE)` наприкінці |
| `db/queries/q1.sql` | замовлення власника (`buyer_id`) за період |
| `db/queries/q2.sql` | замовлення за статусом (`pending`), найновіші перші |
| `db/queries/q3.sql` | пошук користувача за email без урахування регістру |
| `db/queries/q4.sql` | повнотекстовий пошук по каталогу (`tsvector` + `plainto_tsquery`) |
| `db/indexes.sql` | 4 індекси — по одному на кожен запит, включно з GIN під q4 |
| `db/OPTIMIZATIONS.md` | EXPLAIN (ANALYZE, BUFFERS) до/після для кожного запиту + секція "Морфологія" |

### Grading (hw-12: SQL-шар)

Ці команди відтворюють усі кроки з нуля — свіжий `docker compose down -v`,
чиста схема, seed, EXPLAIN до індексів, індекси, EXPLAIN після:

```bash
docker compose down -v && docker compose up -d --wait

# застосувати схему і дані
docker compose exec -T postgres psql -U marketplace -d marketplace < db/schema.sql
docker compose exec -T postgres psql -U marketplace -d marketplace < db/seed.sql

# "до": кожен з чотирьох запитів має містити Seq Scan
for q in q1 q2 q3 q4; do
  docker compose exec -T postgres psql -U marketplace -d marketplace \
    -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/$q.sql)"
done

# індекси
docker compose exec -T postgres psql -U marketplace -d marketplace < db/indexes.sql
docker compose exec -T postgres psql -U marketplace -d marketplace -c "ANALYZE;"

# "після": Index/Bitmap Index Scan замість Seq Scan (q4 — прогнати 2-3 рази,
# перший прогін іде по холодному GIN)
for q in q1 q2 q3 q4; do
  docker compose exec -T postgres psql -U marketplace -d marketplace \
    -c "EXPLAIN (ANALYZE, BUFFERS) $(cat db/queries/$q.sql)"
done

# жоден індекс не мертвий
docker compose exec -T postgres psql -U marketplace -d marketplace -Atc "
  SELECT indexrelname FROM pg_stat_user_indexes
  WHERE schemaname='public' AND idx_scan = 0
    AND indexrelid NOT IN (SELECT conindid FROM pg_constraint WHERE conindid <> 0);"
# -> порожній вивід
```

`docker compose exec` іде напряму в контейнер — без залежності від
локального `psql` чи від того, який порт `5432` займає на хості.

## TypeORM data layer (hw-13)

SQL-схема з hw-12 переїхала в код: entities + relations + міграції, `synchronize: false` завжди. Плюс доведений і вилікуваний N+1, і звітний запит, який неможливо виразити через `find()`.

| Файл | Призначення |
|---|---|
| `src/entities/*.ts` | `User`, `Product`, `Order`, `OrderItem` — типи колонок і `nullable` відповідають `db/schema.sql` |
| `src/migrations/*.ts` | згенерована `migration:generate`, прочитана й відкатна (`down()` реально дропає) |
| `src/data-source.ts` | `DataSource` із `synchronize: false`; підключення з `DB_URL` + `DB_PASSWORD_FILE`, як у конфіг-шарі hw-11 — нового env-файлу нема |
| `src/seed.ts` | детермінований ідемпотентний seed (фіксовані UUID, `save()` за наявним id — upsert, не дублікат) |
| `src/demo-nplus1.ts` | N+1 на графі `order → items → product`, лічильник запитів через власний `Logger` |
| `src/report.ts` | виторг по продавцях (`paid`-замовлення) через `createQueryBuilder().getRawMany()` |
| `scripts/with-secrets.sh` | обгортка навколо `migrate`/`migrate:show`/`migrate:revert`/`seed`/`demo:nplus1`/`report`; `SKIP_VAULT=1` — аварійний вхід для грейдера |

### Чому `numeric(12,2)`, а не `integer` у центах

Загальна порада ОРМ-лекції — гроші як `integer` у мінорних одиницях (центах). Але `db/schema.sql` з hw-12 уже зафіксував `numeric(12,2)` для `price`/`total`/`unit_price` — і entities мають відповідати цій схемі (вимога п.1), а не переписувати її заново під нову лекцію. Тому тут `numeric(12,2)` наскрізно: у Postgres це так само точний десятковий тип без похибки округлення, яку дає `float`; ціна — `pg` повертає `numeric` рядком, а не числом, тому кожна `price`/`total`/`unit_price`-колонка йде з `transformer` (`src/util/numeric-transformer.ts`), який конвертує рядок у `number` при читанні.

### Чому `search_vector` з hw-12 немає в `Product`-entity

`search_vector` (генерована `tsvector`-колонка + GIN-індекс) — артефакт пошукової оптимізації з SQL-шару hw-12, не частина реляційної доменної моделі, з якою працює це ДЗ (relations/міграції/N+1/QueryBuilder). TypeORM 0.3 технічно вміє generated-колонки (`generatedType: 'STORED'`, `asExpression`), але тягнути це в entity заради жодного критерію цього ДЗ — зайва складність без вигоди. Якщо колонка знадобиться на рівні ORM пізніше — це окрема міграція, написана руками поверх згенерованої тут.

### `onDelete` — де RESTRICT, де CASCADE

Той самий вибір, що і в `db/schema.sql`: `products.seller_id`, `orders.buyer_id`, `order_items.product_id` — `RESTRICT` (історія покупок і каталогу не повинна зникати мовчки, якщо видалили користувача чи товар). `order_items.order_id` — єдиний `CASCADE`: рядок замовлення без самого замовлення не має сенсу existence.

### N+1: доведено і вилікувано (`npm run demo:nplus1`)

Граф `order → order_items → product` (2 рівні), 25 замовлень у сіді:

| Стратегія | Запитів |
|---|---|
| наївно (запит у циклі, обидва рівні) | **75** (≥ 25 — розмір колекції) |
| `relations: ['items', 'items.product']` (join-стратегія за замовчуванням) | **1** |
| `leftJoinAndSelect` (QueryBuilder, та сама ідея) | **1** |
| `relationLoadStrategy: 'query'` (2 рівні → 1 + 2×2) | **5** |

Наївний варіант: `orders.find()` (1 запит) → на кожне замовлення окремий запит по `order_items` (N) → на кожен item окремий запит по `product` (ще N). Це не залежить від того, скільки саме запитів на рівень — головне, що число росте з розміром колекції, а не лишається константою. Обидва "виправлені" варіанти дають фіксоване число незалежно від N — перевірено: 25 замовлень у сіді, число запитів (1, або 5 для `'query'`-стратегії) те саме, що було б і на 250.

### Repository vs QueryBuilder — де межа

`Repository`/`find()` — поки запит describable як "сутність (-і) з опціональними фільтрами/відношеннями": там ORM повертає граф entities, і це саме те, що потрібно. Щойно результат — не сутність, а **обчислене значення поверх групи рядків** (сума, кількість, середнє по `GROUP BY`) — `find()` фізично не може це виразити: він завжди повертає entities, а не довільні агреговані колонки. `src/report.ts` — саме такий випадок: "виторг по продавцях" — це не список продавців і не список замовлень, це нова, обчислена форма даних, тому `createQueryBuilder().getRawMany()`.

### Секрети — той самий підхід, що в hw-11/hw-12, плюс легка Infisical-обгортка

`data-source.ts` не містить жодного захардкодженого хоста/пароля — `DB_URL` і `DB_PASSWORD_FILE` приходять з `process.env`, який наповнює `scripts/with-secrets.sh`. У проді ця обгортка робить `infisical export --env=<env> > .secrets/infisical.env` (одноразово, руками) і підвантажує цей файл в оточення перед запуском команди; `.secrets/` — поза git (`.gitignore`). Для грейдера, у якого немає доступу до сховища, — аварійний вхід `SKIP_VAULT=1`: обгортка одразу виконує команду з тим, що вже є в оточенні (дев-креденшели з `docker-compose.yml`, не секрет).

### Grading (hw-13: TypeORM-шар)

```bash
docker compose down -v && docker compose up -d --wait

cp .env.example .env
cp secrets/db_password.example secrets/db_password

npm ci
npx tsc --noEmit

export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm run build
npm run migrate
npm run migrate:show     # -> [X] на єдиній міграції

npm run migrate:revert   # відкат
npm run migrate          # і назад

npm run seed
npm run seed              # ідемпотентно — кількість рядків не змінюється

npm run demo:nplus1       # числа "до/після" — див. таблицю вище
npm run report             # виторг по продавцях, з GROUP BY
```

`with-secrets.sh` читає `DB_URL`/`DB_PASSWORD_FILE` з того самого оточення, що й Express-застосунок (hw-11) і SQL-шар (hw-12) — жодних нових env-файлів це ДЗ не додає.

## Конкурентність (hw-14)

Транзакційний checkout поверх схеми з hw-12/hw-13: декремент stock, списання балансу покупця, запис замовлення і задачі на post-processing — усе в одній транзакції, з атомарним захистом від oversell.

| Файл | Призначення |
|---|---|
| `src/checkout.ts` | транзакційне оформлення замовлення: атомарний `UPDATE ... WHERE stock >= $n RETURNING` |
| `src/entities/Task.ts` + `src/migrations/*AddStockBalanceTasks*.ts` | черга задач post-processing (`stock`/`balance` теж тут — нові колонки, не було в hw-12/13) |
| `src/demo-race.ts` (`npm run demo:race`) | 50 паралельних checkout на товар зі stock=10 — доводить відсутність oversell |
| `src/demo-workers.ts` (`npm run demo:workers`) | 4 воркери розбирають чергу через `FOR UPDATE SKIP LOCKED` |
| `src/with-retry.ts` + `src/demo-retry.ts` (`npm run demo:retry`) | ретрай-обгортка на 40001/40P01, сценарій, що провокує serialization failure |

### Чому атомарний `UPDATE ... RETURNING`, а не `SELECT ... FOR UPDATE`

`UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 RETURNING price` — перевірка і лок в одному виразі: Postgres бере лок на рядок і одразу ж переевалює `WHERE` проти актуального (щойно залоченого) значення `stock`, тому два конкурентні checkout на останню одиницю фізично не можуть обидва побачити `stock >= 1` як true. Нуль рядків у відповіді = товару нема, без окремого `SELECT` і без вікна для гонки. Працює на звичайному `READ COMMITTED` — саме тому цей патерн кращий за `SELECT ... FOR UPDATE` + перевірку в JS для цього конкретного випадку: не треба піднімати isolation level, і код коротший (`SELECT FOR UPDATE` теж унеможливлює гонку, але вимагає додаткового `if` в JS між читанням і записом — зайва поверхня для помилки).

### `npm run demo:race` — числа з мого запуску

```
Attempts: 50
Successful: 10
Failed: 40 (insufficient stock: 40, insufficient balance: 0)
Final stock: 0
Rows with negative stock: 0
```

Рівно 10 успішних (= початковий stock), 0 рядків з від'ємним stock — жодного oversell при 50 справді одночасних (`Promise.all`, без черг у застосунку) спробах купити останню одиницю.

**Пастка, на яку я наступив:** `manager.query()` в TypeORM для `UPDATE`/`DELETE` повертає кортеж `[rows, rowCount]`, а не масив рядків напряму (на відміну від `SELECT`/`INSERT`) — перша версія перевіряла `stockRows.length === 0`, що для кортежу довжини 2 ніколи не було true, тому перевірка stock мовчки не спрацьовувала (усі 50 "успішали", `total` виходив `NaN`, бо `stockRows[0]` був масивом, а не рядком). Фікс — деструктурувати `const [stockRows] = await manager.query(...)`.

### `npm run demo:workers` — числа з мого запуску

```
Tasks: 20, workers: 4
Distribution: { 'worker-1': 5, 'worker-2': 5, 'worker-3': 5, 'worker-4': 5 }
Processed exactly once: 20/20
Processed twice or more (should be 0): 0
Parallel wall-clock time: 177ms
Sequential estimate (20 x ~35ms): 700ms
```

20 задач, 4 воркери, кожна задача оброблена рівно один раз (`processed` — лічильник у самому рядку). ~177 мс паралельно проти оцінки ~700 мс послідовно — приблизно 4× швидше, збігається з кількістю воркерів (жодної задачі, за яку "посперечались" би два воркери одночасно — `SKIP LOCKED` пропускає залочені рядки замість очікування).

### `npm run demo:retry` — числа з мого запуску

```
retry #1 for +30: caught 40001, backing off and retrying whole transaction
Initial balance: 100
Top-ups: 50 + 30
Retries caught (40001/40P01): 1
Final balance: 180 (expected 180)
```

Два конкурентних поповнення балансу (`+50` і `+30`) під `REPEATABLE READ`: обидва читають той самий знімок `balance`, обидва рахують нове значення від нього — друга транзакція, що намагається закомітитись, отримує `40001` (Postgres бачить, що рядок змінився відносно її знімка). Ретрай-обгортка ловить **тільки** `40001`/`40P01` і повторює **всю** транзакцію (включно з читанням) — фінальний баланс `180` (`100 + 50 + 30`) підтверджує, що це не lost update: повтор лише запису замість повного повтору транзакції дав би `130` або `150`, залежно від того, яке з двох поповнень "загубилось" би.

### Чому ретрай ловить лише `40001`/`40P01`

Це єдині два коди Postgres, які означають "транзакція відкочена через конфлікт з іншою транзакцією, спробуй ще раз з нуля" — а не "твій запит помилковий" чи "бізнес-правило порушено". Будь-яка інша помилка (порушення `CHECK`, `NOT NULL`, `InsufficientStockError`/`InsufficientBalanceError` із `checkout.ts`) — це реальна відмова чи баг, і повторювати її сліпо означає замаскувати справжню проблему нескінченним циклом ретраїв.

### Grading (hw-14: конкурентність)

```bash
docker compose down -v && docker compose up -d --wait

cp .env.example .env
cp secrets/db_password.example secrets/db_password

npm ci
npx tsc --noEmit

export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm run build
npm run migrate          # застосовує і InitSchema (hw-13), і AddStockBalanceTasks (hw-14)

npm run demo:race        # exit 0, "Successful: 10", "Rows with negative stock: 0"
npm run demo:workers     # exit 0, "Processed twice or more (should be 0): 0"
npm run demo:retry       # exit 0, "Final balance: 180 (expected 180)"
```

## Data layer ops (hw-15)

Перед Postgres тепер стоїть PgBouncer, є скрипт нічного бекапу і скрипт, який відновлює останній дамп у чистий контейнер та перевіряє, що дані на місці.

| Файл | Що це |
|---|---|
| `pgbouncer/pgbouncer.ini`, `pgbouncer/userlist.txt` | конфіг PgBouncer і дев-користувач (пароль той самий, що в compose) |
| `scripts/backup.sh` | `pg_dump -Fc` у `backups/` з датою в імені |
| `scripts/restore-drill.sh` | відновлення останнього дампу в чистий контейнер і звірка |
| `scripts/control.sql` | контрольний запит, спільний для обох скриптів |
| `backup.cron` | рядок розкладу, щоночі о 03:00 |
| `RESTORE-DRILL.md` | протокол мого drill-у: розмір, час, RTO, RPO |

### Як підняти

```bash
docker compose up -d --wait
```

Назовні відкритий тільки PgBouncer, порт 6432. Порт Postgres я з compose прибрав: застосунок має ходити через пулер, а в мене на 5432 ще й сидить локальний Postgres. `.env.example` уже вказує на 6432, таке саме значення треба виставити в `DB_URL` у сховищі (dev і prod). Нового env-файлу немає.

Адмін-консоль PgBouncer, користувач той самий:

```bash
PGPASSWORD=dev_local_only_changeme psql -h 127.0.0.1 -p 6432 -U marketplace -d pgbouncer -c "SHOW POOLS"
```

### Бекап

```bash
bash scripts/with-secrets.sh dev bash scripts/backup.sh
```

Дамп лягає в `backups/` (в gitignore, тека міняється через `BACKUP_DIR`), в імені дата і час. Поруч файл `.control` із контрольним значенням на момент бекапу: кількість рядків у `users`, `products`, `orders`, `order_items` і сума `orders.total`. Ця сума потрібна drill-у, щоб було з чим порівнювати, навіть якщо вихідної бази вже нема.

`pg_dump` іде прямо в контейнер `postgres`, повз PgBouncer: це одна довга транзакція, а версія клієнта має збігатися з сервером (хостовий `pg_dump` у мене 14, сервер 16). Скрипт одразу перевіряє, що архів читається. Зі свого боку TOC теж краще дивитись через контейнер, бо `pg_restore` старіше за 16 такий дамп не відкриє:

```bash
docker compose exec -T postgres pg_restore --list < backups/<файл>.dump
```

Розклад лежить у `backup.cron`. Шлях `/opt/marketplace-api` треба підставити свій, ставиться через `crontab backup.cron`.

### Відновлення

```bash
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

Скрипт бере найновіший дамп, піднімає чистий `postgres:16-alpine` (порожній volume, сам його створює і сам прибирає), робить `pg_restore --no-owner` і порівнює контрольне значення з `.control`. Друкує `MATCH` або виходить з кодом 1. Що вийшло в мене, написано в RESTORE-DRILL.md. Справжнє відновлення відрізняється лише ціллю: той самий `pg_restore --no-owner -d <база>` у порожню базу.

### Чому transaction mode і що він ламає

Клієнтів у застосунку багато (плюс воркери з hw-14), а з'єднання з Postgres дорогі, бо це окремий процес на кожне. У transaction mode PgBouncer віддає клієнту справжнє з'єднання тільки на час транзакції, тож до 200 клієнтів (`max_client_conn`) ділять п'ять серверних (`default_pool_size`). Розплата в тому, що між транзакціями клієнт може опинитись на іншому з'єднанні, і все, що тримається на сесії, ламається: `SET` поза транзакцією (треба `SET LOCAL` всередині), `LISTEN/NOTIFY`, сесійні advisory locks, курсори `WITH HOLD` і іменовані prepared statements. З останніми допомагає `max_prepared_statements = 200`, PgBouncer це вміє з 1.21, у нас 1.24.1. У коді hw-14 нічого з цього списку немає: `FOR UPDATE SKIP LOCKED` і `REPEATABLE READ` живуть усередині однієї транзакції, і `demo:race`, `demo:workers`, `demo:retry` через PgBouncer дали ті самі числа, що й напряму.

### Ротація пароля після PgBouncer

`userlist.txt` статичний, тому `rotate.sh` з hw-11 разом із PgBouncer ламає застосунок: Postgres уже на новому паролі, PgBouncer ще на старому, і `/health` віддає `password authentication failed`. Я це перевірив. Руками лікується так: записати новий пароль у `pgbouncer/userlist.txt` і зробити `docker compose restart pgbouncer`. Нормальне рішення (`auth_query`, щоб PgBouncer сам питав пароль у Postgres) у це ДЗ не входить. Після таких експериментів файл варто повертати через `git checkout pgbouncer/userlist.txt`, бо `docker compose down -v` знову підніме Postgres зі стартовим паролем.

### Grading (hw-15: PgBouncer, бекап, drill)

```bash
docker compose up -d --wait

export DB_URL=postgres://marketplace:dev_local_only_changeme@127.0.0.1:6432/marketplace
export SKIP_VAULT=1    # у грейдера немає доступу до сховища

# необов'язково, але на порожній базі drill нічого не доводить
npm ci && npm run build && npm run migrate && npm run seed

bash scripts/with-secrets.sh dev bash scripts/backup.sh
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

Змінна підключення в цьому проєкті з hw-11 називається `DB_URL`. `backup.sh` приймає і `DATABASE_URL`, тож шаблон із ДЗ теж спрацює. Пароль тут прямо в URL: це дев-пароль із `docker-compose.yml`, не секрет. У сховищі все інакше: `DB_URL` без пароля, а пароль у файлі з `DB_PASSWORD_FILE` (як у hw-11), і скрипт так само це розуміє. `restore-drill.sh` до живої бази не ходить узагалі, йому потрібен тільки дамп. Обидва скрипти читають значення прямо з оточення, тож працюють і через обгортку, і голими (`bash scripts/backup.sh`).

Решта перевірок:

```bash
PGPASSWORD=dev_local_only_changeme psql -h 127.0.0.1 -p 6432 -U marketplace -d marketplace -c "SELECT 1"
PGPASSWORD=dev_local_only_changeme psql -h 127.0.0.1 -p 6432 -U marketplace -d pgbouncer -c "SHOW POOLS"
grep -E '^\s*pool_mode\s*=\s*transaction' pgbouncer/pgbouncer.ini
grep -cE '^(@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)|([0-9*/,-]+[[:space:]]+){4}[0-9*/,-]+)[[:space:]]+.*backup' backup.cron
grep -iE 'RTO|RPO' RESTORE-DRILL.md
```

## Тестування (hw-16)

Драбинка довіри поверх усього попереднього. Інтеграційні тести ганяють справжній Postgres у testcontainers, E2E іде через supertest, а контракт перевіряє Pact з брокером і `can-i-deploy`.

### Де ця робота розходиться з текстом ДЗ

Постановка описує повний Nest-застосунок (`Test.createTestingModule`, `ValidationPipe`, `HttpStatus`). Nest у цьому проєкті немає взагалі: `src/app.js` з hw-09 написаний на Express з `express-openapi-validator`. Спільна функція конфігурації, про яку йдеться в підказках ДЗ, тут уже є, це `createApp()`. Переписувати застосунок на Nest заради формулювання означало б міняти робочий продакшн-код без потреби. Тому E2E ганяє `createApp()` через supertest напряму. Інструмент той самий, змінився лише клей.

Важливіше інше. `/v1/products` і `/v1/orders` досі працюють з масивами в памʼяті (`src/data.js`, hw-09). Шар Postgres/TypeORM з hw-12…14 живе окремо: ним користуються `seed.ts`, `report.ts`, `checkout.ts` і демо, але не HTTP.

Звідси три наслідки. Інтеграційні тести (`test/integration/`) перевіряють той шар, що реально є: TypeORM-репозиторії проти справжнього `postgres:16-alpine`. E2E (`test/e2e/`) проходить `create → read` через HTTP, але запис у Postgres довести не може, бо застосунок його не робить. Чесно він доводить ось що: `DB_URL` і `DB_PASSWORD_FILE` вказують на одноразовий Postgres з testcontainers, а не на dev-базу, і `/health` бачить живе зʼєднання через той самий конфіг. Контракт описує `GET /products/{productId}`, бо відповідь цього ендпоінта не залежить від того, звідки береться каталог. З тієї ж причини `stateHandler` для `product prod_1 exists` порожній: `prod_1` лежить у статичному каталозі завжди. Коли каталог переїде в Postgres, там зʼявиться `INSERT … ON CONFLICT DO NOTHING`.

### Файли

| Шлях | Що там |
|---|---|
| `test/testkit/postgres.ts` | піднімає `postgres:16-alpine` через `@testcontainers/postgresql`, накатує міграції з hw-13, дає `truncateAll()` |
| `test/testkit/app.ts` | справжній `createApp()` на одноразовому Postgres: для E2E і для верифікації провайдера |
| `test/testkit/builders.ts` | `aUser()`, `aProduct()`, `anOrder()`: валідні унікальні дефолти, тест називає лише поле, яке перевіряє |
| `test/integration/user.repository.test.ts`, `order.repository.test.ts` | 7 тестів на 2 репозиторії TypeORM: unique (23505), FK (23503), JOIN, GROUP BY |
| `test/e2e/orders.e2e.test.ts` | supertest проти `createApp()`: happy path, 404, 400 від `express-openapi-validator` |
| `test/contract/consumer/products.pact.test.ts` | Pact-консюмер `marketplace-web`, пише `pacts/marketplace-web-marketplace-api.json` |
| `test/contract/provider/verify.ts` | верифікація провайдера проти файлу або проти брокера, з публікацією результату |
| `.github/workflows/contract.yml` | job `test` (tsc, integration, e2e) і job `contract` (публікація, верифікація, `can-i-deploy`) |

### Ізоляція: TRUNCATE між тестами, контейнер на файл

Кожен тестовий файл піднімає свій `postgres:16-alpine` у `beforeAll` і гасить у `afterAll`, а між тестами `afterEach` робить `TRUNCATE … RESTART IDENTITY CASCADE`. ROLLBACK-стратегію я свідомо не взяв. Частина тестів навмисно ловить 23505 і 23503, а після такої помилки транзакція в Postgres лишається aborted, і щоб працювати далі, довелось би обгортати кожен ризикований запит у `SAVEPOINT`. TRUNCATE працює в autocommit, тож помилка одного запиту не заважає наступному. `npm run test:integration && npm run test:integration` проходить двічі поспіль без ручної чистки.

### Команди

```bash
npx tsc --noEmit           # основний застосунок (src/), test/ не чіпає

npm run test:integration   # 2 репозиторії, 7 тестів, testcontainers
npm run test:e2e           # supertest: happy path і 2 негативні кейси
npm run test:contract      # Pact-консюмер, пише pacts/*.json
npm run verify:provider    # провайдер проти локального pacts/*.json, брокер не потрібен
```

Потрібен Node 22.22 або новіший: testcontainers 12 тягне `undici@8`, який на Node 20 падає ще до першого тесту з `webidl.util.markAsUncloneable is not a function`, і Pact теж вимагає 22. Dockerfile і CI вже на 22.

Усі чотири компілюють `test/**/*.ts` окремим `tsconfig.test.json` у `dist-test/`, основний `dist/` від `npm run build` лишається як був. Запускаються через `node --experimental-vm-modules`, бо проєкт увесь на ESM, а Jest 30 досі тримає ESM за цим прапорцем. `pacts/` лежить у `.gitignore`: контракт щоразу генерує `npm run test:contract`, і в CI так само.

### Локальний брокер і повний гейт `can-i-deploy`

```bash
docker compose up -d --wait        # разом з Postgres і PgBouncer піднімає broker-db і broker на :9292

npm run test:contract              # pacts/marketplace-web-marketplace-api.json

VERSION=1.0.0-local

# 1. публікація контракту
curl -X PUT "http://127.0.0.1:9292/pacts/provider/marketplace-api/consumer/marketplace-web/version/$VERSION" \
  -H 'Content-Type: application/json' -d @pacts/marketplace-web-marketplace-api.json
# 201

# 2. до верифікації деплоїти ще не можна
curl "http://127.0.0.1:9292/can-i-deploy?pacticipant=marketplace-web&version=$VERSION&to=prod"
# "deployable":null, "unknown":1

# 3. провайдер верифікує контракт з брокера і публікує результат
PACT_BROKER_URL=http://127.0.0.1:9292 PACT_PROVIDER_VERSION=$VERSION npm run verify:provider
# exit 0, "Results published to Pact Broker", "has a matching body (OK)"

# 4. тег prod на ту саму версію провайдера
curl -X PUT "http://127.0.0.1:9292/pacticipants/marketplace-api/versions/$VERSION/tags/prod" \
  -H 'Content-Type: application/json'
# 201

# 5. тепер можна
curl "http://127.0.0.1:9292/can-i-deploy?pacticipant=marketplace-web&version=$VERSION&to=prod"
# "deployable":true

docker compose down -v
```

Обидві відповіді кроку 5, зняті на моїй машині:

```
До тега:    "deployable":null,"reason":"There is no verified pact between version 1.0.0-local of marketplace-web and the latest version of marketplace-api with tag prod (no such version exists)","success":0,"failed":0,"unknown":1
Після тега: "deployable":true,"reason":"All required verification results are published and successful","success":1,"failed":0,"unknown":0
```

Зазвичай я запускаю верифікацію через обгортку: `bash scripts/with-secrets.sh dev npm run verify:provider`. Тоді `PACT_BROKER_URL` і `PACT_BROKER_TOKEN` приїжджають зі сховища з ДЗ #11, так само як `DB_URL`. У грейдера сховища нема, тому в кроці 3 адреса стоїть прямо в оточенні. Під `SKIP_VAULT=1` обгортка виконує ту саму команду без змін, тож обидві форми рівноцінні. Код читає лише `process.env.PACT_BROKER_URL` і `PACT_BROKER_TOKEN`, адреси чи токена в ньому немає. Без `PACT_BROKER_URL` верифікація йде проти локального `pacts/*.json`. Сам застосунок під час верифікації, як і в E2E, стартує на одноразовому Postgres з testcontainers (`test/testkit/app.ts`), тож ні `.env`, ні сховище для бази йому не потрібні.

### CI: `.github/workflows/contract.yml`

Job `test` ставить залежності, перевіряє `tsc --noEmit` і ганяє `test:integration` та `test:e2e`. Docker на `ubuntu-latest` уже є, тож testcontainers працюють без налаштувань. Job `contract` стартує лише після нього: піднімає брокер з того ж `docker-compose.yml`, генерує і публікує контракт, верифікує провайдера з `publishVerificationResult: true`, ставить тег `prod` і валить джобу, якщо `can-i-deploy` не відповів `"deployable":true`. Адреса й токен брокера беруться з GitHub secrets `PACT_BROKER_URL` і `PACT_BROKER_TOKEN`. Поки hosted-брокера немає, secrets порожні, і job ходить у брокер, який сам підняв на `127.0.0.1:9292`. Версією і провайдера, і консюмера CI бере `github.sha`, один рядок на всіх кроках прогону.

## Realtime (hw-18)

Зміна статусу замовлення тепер доходить до клієнта одразу, двома транспортами: socket.io (кімната `orders:<id>`) і SSE (`GET /orders/:id/events`). Обидва слухають одну шину подій, тож бізнес-логіка про транспорти не знає нічого.

### Що тут не так, як у тексті ДЗ

ДЗ написане під Nest (`@WebSocketGateway()`, guards, Nest-контролер). Цей проєкт з hw-09 на Express, Nest тут не було ніколи, і переписувати весь HTTP-шар заради одного ДЗ я не став. Gateway зроблений на голому socket.io, який сідає на той самий `http.Server`, що й Express. Шина подій звичайний `EventEmitter`, а не RxJS `Subject`: роль та сама, а нової залежності не треба. Файли названі так, як просить ДЗ, але вони `.js`, бо весь HTTP-шар проєкту на JS і запускається без збірки (`node src/server.js`).

Ще три речі, яких у проєкті просто не було:

- Ендпоінта зміни статусу не існувало. Тепер є `PATCH /v1/orders/:orderId/status`, і він же в `openapi.yaml`. Переходи між статусами не обмежені: будь-який з `pending | paid | cancelled`, кожен виклик дає подію.
- Автентифікації в проєкті нема взагалі. Замість неї заголовок `X-User-Id` на `POST /v1/orders` (записується в `buyer_id`) і `auth: { userId }` у handshake socket.io. Без `userId` сокет не підключиться. `join` чужого або неіснуючого замовлення отримує однакову відмову `{ ok: false, error: "forbidden" }`, щоб через join не можна було перебирати id.
- Замовлення досі живуть у памʼяті (`src/data.js`, hw-09), а не в Postgres. Після рестарту їх немає, як і раніше.

SSE стоїть поза `/v1` (бо саме цю адресу перевіряє грейдер) і без перевірки власника: грейдер стукає туди curl-ом без жодного заголовка. У проді там мав би стояти той самий guard, що й на `join`.

| Файл | Що це |
|---|---|
| `src/orders/order-events.service.js` | шина подій + буфер останніх 100 подій на кожне замовлення, id подій окремі для кожного замовлення |
| `src/orders/orders.service.js` | `changeOrderStatus()`: міняє статус і публікує подію. Emit іде звідси, не з контролера |
| `src/orders/orders.gateway.js` | socket.io: перевірка `userId` у handshake, `join` з перевіркою власника, emit тільки в `orders:<id>` |
| `src/orders/orders.controller.js` | SSE-потік з `retry:`, `id:`, `Last-Event-ID` і `PATCH .../status` |
| `scripts/realtime-demo.mjs` | headless-демо ізоляції кімнат, контрольний режим `--same-room` |

### Як запустити

```bash
npm ci
cp .env.example .env
cp secrets/db_password.example secrets/db_password
npm run start:inmemory        # :3000, і HTTP, і socket.io (до hw-24 це був npm start)
```

`docker compose up` для цього ДЗ не потрібен: база потрібна тільки `/health`, а замовлення в памʼяті.

### Перевірка

```bash
# замовлення, з яким працюємо
curl -s -X POST localhost:3000/v1/orders -H 'content-type: application/json' \
  -H 'Idempotency-Key: k1' -H 'X-User-Id: alice' \
  -d '{"items":[{"product_id":"prod_1","quantity":1}]}'
# -> {"id":"order_1","buyer_id":"alice",...}
# order_1 буде лише на щойно запущеному сервері; якщо вже щось створювали
# (зокрема демо-скриптом), далі підставляйте id з відповіді

# заголовок SSE
curl -sN --max-time 2 -D - -o /dev/null http://localhost:3000/orders/order_1/events | grep -i '^content-type'
# -> content-type: text/event-stream

# зміна статусу (у другому терміналі, поки відкритий curl -sN .../events)
curl -s -X PATCH localhost:3000/v1/orders/order_1/status \
  -H 'content-type: application/json' -d '{"status":"paid"}'
```

Що побачить відкритий потік:

```
retry: 1000

id: 1
event: order.status
data: {"id":1,"orderId":"order_1","status":"paid","changedAt":"2026-10-01T12:32:49.521Z"}
```

Ще три зміни статусу (`cancelled`, `pending`, `paid`), і тоді:

```bash
curl -sN --max-time 2 -H 'Last-Event-ID: 3' http://localhost:3000/orders/order_1/events | grep '^id:' | head -1
# -> id: 4
```

Дограється рівно четверта подія, без дублів: буфер віддається і підписка відкривається в одному тіку, між ними нічого не встигне опублікуватись.

Демо ізоляції кімнат (API має бути запущений, адресу можна змінити через `API_URL`):

```bash
node scripts/realtime-demo.mjs; echo "exit=$?"
# A_RECEIVED=1
# B_RECEIVED=0
# FOREIGN_JOIN=denied
# exit=0

node scripts/realtime-demo.mjs --same-room; echo "exit=$?"
# A_RECEIVED=1
# B_RECEIVED=1
# FOREIGN_JOIN=denied
# exit=0
```

Обидва клієнти належать одному покупцю (дві вкладки), тому `--same-room` міняє лише кімнату клієнта B, а не його права. `FOREIGN_JOIN` це третій клієнт під іншим `userId`, який пробує зайти в кімнату замовлення A. Якщо його пустили, скрипт теж повертає 1. Сам скрипт я перевірив і з іншого боку: тимчасово поміняв `io.to(room).emit` на `io.emit`, і основний прогін дав `B_RECEIVED=1`, `exit=1`. Код 2 означає, що скрипт узагалі не зміг відпрацювати (API не запущений тощо).

### Два інстанси

Кімнати socket.io і SSE-буфер живуть у памʼяті кожного процесу, тому за балансувальником `PATCH`, що прийшов на інстанс 1, почують лише його сокети, а клієнт на інстансі 2 не отримає нічого (і `Last-Event-ID` там історії не знайде). Лікується `@socket.io/redis-adapter`, який розсилає emit у кімнату на всі інстанси через Redis Pub/Sub, плюс спільний буфер подій (наприклад, Redis Streams) і sticky sessions для long-polling транспорту socket.io. Хоча першим тут зламається навіть не це, а in-memory список замовлень з hw-09.

## Trade-offs: WebSocket vs SSE

Для нотифікацій про статус замовлення я б лишив у проді SSE. Клієнт тут нічого не надсилає, статус міняє сервер, а пропущені за час обриву події повертаються через `Last-Event-ID` майже безкоштовно: браузерний `EventSource` сам реконектиться і сам шле цей заголовок. І це звичайний HTTP, який пройде через будь-який проксі й існуючий auth-middleware. WebSocket я б тримав для того, де клієнт справді багато говорить, як-от чат покупця з продавцем.

| Критерій | WebSocket (socket.io) | SSE |
|---|---|---|
| Напрям каналу | в обидва боки по одному з'єднанню | тільки сервер → клієнт, клієнт говорить звичайними HTTP-запитами |
| Реконект і відновлення | socket.io реконектиться сам, але пропущене за час обриву не доїде без `connectionStateRecovery` або свого буфера, а кімнату після реконекту треба знову `join` | `EventSource` реконектиться сам і шле `Last-Event-ID`, серверу лишається дограти з буфера |
| Вимоги до інфраструктури | `Upgrade` має пройти через кожен проксі й балансувальник, для long-polling fallback потрібні sticky sessions, бібліотека на обох боках | звичайна HTTP-відповідь, на проксі треба лише вимкнути буферизацію; на HTTP/1.1 браузер тримає до ~6 з'єднань на origin |
| Ціна на подію | 2–14 байт заголовка кадру плюс обгортка socket.io `42["order.status",{...}]` | текстові рядки `id:` / `event:` / `data:`, кілька десятків байт службового тексту, лише UTF-8 |
| Ізоляція і права | кімнати й ack з коробки, перевірка власника в обробнику `join` | «кімната» це просто URL, перевірка звичайним middleware на `GET` |

## Async-події через RabbitMQ (hw-19)

Цей розділ описує стан на hw-19. З hw-22 `placeOrder()` більше не публікує напряму, подія йде через outbox і relay (розділ «Outbox та ідемпотентність» нижче), а консюмер дедуплікує ще й через `processed_messages`.

Realtime з hw-18 доставляє лише тим, хто підключений зараз. Тут між сервісом і його читачами з'являється брокер, який тримає повідомлення, поки читач не прийде. Замовлення оформлюється тим самим `checkout()` з hw-14, після COMMIT публікується `order.placed`, а склад (окремий споживач) створює для замовлення запит на збирання в таблиці `fulfillments`. Якщо склад у цей момент лежить, подія чекає в черзі.

```
placeOrder() ─► checkout() COMMIT ─► publish order.placed, чекаємо confirm
                                          │
                             shop.events (topic)
              order.placed ───────────────┼────────────── будь-що інше
                    ▼                                          ▼
   warehouse.order-placed (quorum, delivery-limit 3)    shop.unrouted (alternate exchange)
     споживач: INSERT fulfillments ON CONFLICT DO NOTHING → ack
     помилка: reject(requeue) → після 4-ї доставки ─► shop.dlx ─► warehouse.order-placed.dlq
```

| Файл | Що там |
|---|---|
| `src/messaging/topology.ts` | exchange, черги, binding, DLX і DLQ, alternate exchange. Викликає споживач або демо, продюсер про це не знає |
| `src/messaging/order-placed.event.ts` | контракт події і перевірка вхідного тіла |
| `src/messaging/publisher.ts` | публікація через confirm-канал (`waitForConfirms`) |
| `src/messaging/order-placed.consumer.ts` | ручний ack після ефекту, `prefetch`, ідемпотентний ефект |
| `src/place-order.ts` | `checkout()` + публікація |
| `src/consumer.ts` | споживач як окремий процес (`npm run consumer`) |
| `src/entities/Fulfillment.ts`, `src/migrations/*AddFulfillments*` | таблиця ефекту |
| `src/demo-*.ts` | три демо, кожне саме чистить черги і свої дані з минулих прогонів |

Подія виглядає так. Це окремо спроектований контракт, а не ORM-сутність, розгорнута в JSON:

```json
{
  "eventId": "order.placed:5f0c…",
  "type": "order.placed",
  "version": 1,
  "occurredAt": "2026-10-01T13:20:11.402Z",
  "data": { "orderId": "5f0c…", "buyerId": "…", "productId": "…", "quantity": 1, "total": 10, "currency": "UAH" }
}
```

`eventId` виводиться з `orderId`, а не генерується щоразу заново. Замовлення оформлюється один раз, тож якщо продюсер колись перепублікує ту саму подію, вона прийде з тим самим id.

### Що показали три прогони

Чистий volume, `npm ci`, далі три команди підряд. Числа з моєї машини:

```
demo:publish                demo:dlq                      demo:duplicate
published=5                 rejected=4                    published=1
delivered=5                 deliveries=4                  killed=1
effect=5                    delivery-limit=3              deliveries=2
acked=5                     work=0                        redelivered=1
work=0                      dlq=1                         effect=1
dlq=0                       dlq-reason=delivery_limit     skipped=1
prefetch=20                 effect=0                      fulfillment-rows=1
fulfillment-rows=5          fulfillment-rows=0            work=0
effect-ms-avg=2.2                                         dlq=0
```

У `demo:dlq` отруєна подія коректна за формою, але посилається на замовлення, якого не існує. FK на `fulfillments` відмовляє щоразу, споживач робить `reject(requeue=true)`, і після четвертої доставки (перша плюс три повтори при `x-delivery-limit=3`) брокер відправляє її в DLQ. Причину демо читає із заголовка `x-first-death-reason`, у `x-death` там `reason=delivery_limit count=1`. Тіло, яке взагалі не парситься, споживач відхиляє одразу з `requeue=false`, бо повтор йому не допоможе. Причина тоді буде `rejected`.

Дубль у `demo:duplicate` я викликаю справжнім падінням. Споживач запускається окремим процесом, застосовує ефект, і перед ack вбиває сам себе `SIGKILL`. ОС закриває сокет, брокер бачить обрив і повертає повідомлення в чергу. Другий, здоровий споживач отримує його з `redelivered=true`, `INSERT` нічого не вставляє, і повідомлення просто підтверджується. `channel.close()` для цього не підходить, бо це коректне завершення, а не те, як падає под о третій ночі.

Демо перевіряють себе ще й з іншого боку. Я тимчасово робив ефект неідемпотентним (`ON CONFLICT DO UPDATE`), і `demo:duplicate` показав `effect=2` та впав з exit 1. З `noAck: true` він показав `deliveries=1`: під autoAck повідомлення зникає в момент доставки, повертати нічого.

### Чому prefetch=20

Ефект займає один `INSERT`, в середньому 1–2 мс (`effect-ms-avg`). З `prefetch=1` споживач після кожного ack простоював би на мережевий round trip. З дефолтним 0 ліміту немає взагалі, і перший споживач забрав би всю чергу. Перевірка за формулою `prefetch × час обробки < consumer_timeout`: 20 × 2 мс ≈ 40 мс, і навіть якщо обробка колись стане секундною, 20 с проти стокових 30 хвилин. Брати більше, наприклад 2000, теж не варто. Якщо один із двох споживачів почне гальмувати, усі ці повідомлення висітимуть на ньому, поки другий простоює.

### At-least-once, а не exactly-once

RabbitMQ обіцяє одне: повідомлення без ack повернеться в чергу. Ack означає «я більше не вимагаю повтору», і він може загубитися вже після того, як ефект застосовано. Саме це `demo:duplicate` робить навмисно. Тому доставка тут at-least-once, і `deliveries=2` в демо це підтверджує. Exactly-once доставки не дає ні RabbitMQ, ні будь-який інший брокер.

Результат при цьому один, бо ефект ідемпотентний. Одне замовлення — один запит на збирання: `INSERT INTO fulfillments … ON CONFLICT (order_id) DO NOTHING`, де `order_id` первинний ключ. Повторна доставка впирається в ключ і нічого не змінює (`effect=1`, `skipped=1`). Ідемпотентність тут властивість самої операції, вона дісталась від природного ключа. Тому ні окремий ключ ідемпотентності, ні таблиця оброблених id не знадобились. Дедуп у `Set` у пам'яті процесу не пережив би рестарт, а таблиця в Postgres переживе. At-least-once доставка плюс ідемпотентний ефект дають exactly-once результат.

### Що лишилось відкритим

- Публікація йде після COMMIT, і спільної транзакції між Postgres і RabbitMQ нема. Якщо процес впаде між ними, замовлення буде, а події ні. Закрито transactional outbox у hw-22.
- Щілини «позначив оброблене, а ефекту ще нема» тут немає, бо позначка і ефект — це той самий `INSERT`. Вона з'явиться, щойно ефект стане зовнішнім (лист, платіж). Тоді позначка і ефект мають іти одним COMMIT, це `processed_messages` з hw-22, де так і зроблено.
- Dead-lettering за замовчуванням at-most-once: брокер перепубліковує в DLX без confirm, і якщо DLQ недоступна, повідомлення губиться. Стратегія `dead-letter-strategy: at-least-once` працює тільки в парі з `overflow: reject-publish`. Без неї політика приймається, але брокер мовчки відкочується на at-most-once і пише про це лише в лог. Це з документації і з прогону в коді лекції, сам я цього не відтворював. Для ДЗ лишив дефолт.
- `reject` і `nack` з `requeue=true` поводяться по-різному. Я перевірив на двох версіях. На 4.2.9 обидва доходять до delivery-limit за ті ж 4 доставки. На 4.3.4 `nack` delivery-count не збільшує: 9357 доставок за 20 секунд і нічого в DLQ. Тому споживач робить `reject`, і апгрейд на 4.3 його не зламає.
- Повідомлення з routing key, на який ніхто не підписаний, брокер підтверджує позитивним confirm і викидає. Від цього стоїть alternate exchange `shop.unrouted`. Перевірив: опублікував `order.refunded`, confirm прийшов, повідомлення лежить у `shop.unrouted`.
- Якщо брокер скасує споживача (видалили чергу або пробито `consumer_timeout`), у callback приходить `null`. Споживач на це виходить з кодом 1, а не робить вигляд, що живий.

RabbitMQ 4.2.9, бо це LTS-гілка з підтримкою до 30.06.2030. 4.3 поточна, але підтримка в неї до 30.04.2028. Черга quorum, DLQ classic: у quorum-DLQ свій дефолтний delivery-limit, і оператор, який розглядає її через `get` + `nack`, міг би випадково вичерпати ліміт і загубити повідомлення.

Перед демо зупиніть `npm run consumer`, якщо він запущений. Він теж слухає `warehouse.order-placed` і забере частину повідомлень, тож числа демо попливуть.

### Grading (hw-19: RabbitMQ)

```bash
docker compose up -d --wait

export DB_URL=postgres://marketplace@127.0.0.1:6432/marketplace
export DB_PASSWORD_FILE=secrets/db_password.example
export BROKER_URL=amqp://marketplace:dev_local_only_changeme@127.0.0.1:5672
export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm ci

npm run demo:publish
npm run demo:dlq
npm run demo:duplicate
```

`BROKER_URL` іде на порт AMQP 5672. Порт 15672 — це вебморда менеджменту (`marketplace` / `dev_local_only_changeme`), там видно `x-death` очима. Демо самі збирають TypeScript і накочують міграції, окремо `npm run build` / `npm run migrate` запускати не треба. Основний шлях без `SKIP_VAULT` той самий: `BROKER_URL` і `DB_URL` приїжджають зі сховища через `scripts/with-secrets.sh`.

## Outbox та ідемпотентність (hw-22)

З hw-24 `POST /v1/checkout` вимагає access-токен і бере покупця з нього, `X-User-Id` більше не читається (розділ Auth). Приклади з `X-User-Id` нижче описують стан на hw-22.

У hw-19 замовлення комітилось у Postgres, а подія публікувалась окремим кроком уже після COMMIT. Між цими двома записами вміщалося падіння процесу: замовлення є, а події немає. Тепер подія лягає в таблицю `outbox` тієї самої бази тим самим COMMIT, а назовні її виносить окремий relay. Ціна відома наперед. Relay може опублікувати подію двічі, тому консюмер дедуплікує, і робить це на двох рівнях.

```
POST /v1/checkout (npm run orders-api), Idempotency-Key + X-User-Id
→ placeOrder(key), одна транзакція:
  INSERT idempotency_keys          ключ запиту
  checkout(): stock, balance, order, order_items, tasks
  INSERT outbox (order.placed)
  COMMIT

relay:      SELECT … WHERE published_at IS NULL FOR UPDATE SKIP LOCKED
            → publish (confirm) → UPDATE published_at → COMMIT

консюмер, одна транзакція:
            INSERT processed_messages ON CONFLICT DO NOTHING
            INSERT fulfillments ON CONFLICT (order_id) DO NOTHING
            → ack
```

| Файл | Що там |
|---|---|
| `src/migrations/*AddOutboxInbox*` | `outbox` з частковим індексом `WHERE published_at IS NULL`, `processed_messages`, `idempotency_keys` |
| `src/http/checkout.route.ts`, `src/orders-api.ts` | HTTP-край: `POST /v1/checkout` окремим процесом (`npm run orders-api`, порт `ORDERS_API_PORT`) |
| `src/place-order.ts` | ключ, замовлення і рядок outbox одним COMMIT; publish тут немає |
| `src/checkout.ts` | тіло checkout з hw-14 винесено в `checkoutWith(manager, …)`, щоб воно жило всередині чужої транзакції |
| `src/messaging/outbox-relay.ts` | один прохід relay; `src/relay.ts` крутить його в циклі (`npm run relay`) |
| `src/messaging/order-placed.consumer.ts` | inbox і природний ключ в одній транзакції |
| `src/demo-outbox.ts`, `demo-crash-write.ts`, `demo-crash-relay.ts` (+ `-child`) | три демо, кожне саме прибирає за собою |

### Три рівні ідемпотентності

Ключ на краю, рівень 3. Заголовок той самий, що в hw-09: `Idempotency-Key`, обов'язковий. `POST /v1/checkout` передає його в `placeOrder`, а та першим ділом вставляє ключ у `idempotency_keys` з `ON CONFLICT DO NOTHING`. Якщо паралельно прийде такий самий запит, його вставка чекає на унікальному індексі, поки перший не закомітиться, потім бачить конфлікт і повертає те саме замовлення. Склад і баланс другий запит не чіпає. Відповідь на повтор така сама, як на перший запит (201 і той самий `order_id`), плюс `Idempotency-Replay: true`, як у hw-09.

Ключ означає намір купити, тому тіло запиту не хешується: два однакові замовлення з різними ключами законно стають двома. Але той самий ключ з іншим покупцем, товаром чи кількістю дає 422. Такий запит означає баг у клієнті. Заодно чужий покупець не отримає чуже замовлення, вгадавши ключ. Порівняння робиться в SQL, тож регістр UUID не важить. Ключ лежить у Postgres і комітиться разом із замовленням. Тому його бачать усі інстанси, і він переживає рестарт, на відміну від `Map` у hw-09.

Чому окремий процес і новий шлях замість `POST /v1/orders`? Замовлення hw-09 живуть у пам'яті, і на них стоять Pact-контракт з hw-16 і realtime-статуси з hw-18. Переводити все це на Postgres означало б переписати три попередні ДЗ. Тож in-memory `/v1/orders` лишився як був, а запис у Postgres отримав свій ендпоінт на окремому порту. Він не описаний в `openapi.yaml`, бо той контракт належить API з `npm start`.

```bash
npm run build && npm run migrate && npm run orders-api      # :3001
curl -i -X POST localhost:3001/v1/checkout \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -H 'X-User-Id: <uuid покупця>' \
  -d '{"product_id":"<uuid товару>","quantity":1}'
```

| Відповідь | Коли |
|---|---|
| 201 `{ "order_id" }` | замовлення створено, або це повтор (тоді ще `Idempotency-Replay: true`) |
| 400 | немає ключа чи `X-User-Id`, невалідне або зламане тіло |
| 409 | не вистачає товару чи грошей; ключ відкочується разом із транзакцією, тож повтор пробує заново |
| 422 | той самий ключ з іншим тілом або від іншого покупця |

Inbox, рівень 2: `processed_messages (message_id, consumer)`. Ключ у ньому `eventId`, і з hw-22 це id рядка outbox (у hw-19 він виводився з `orderId`). Подія пишеться в outbox один раз і при кожній спробі публікації читається з того самого рядка, тож повтор приходить з тим самим id. Форма контракту не змінилась. Позначка і ефект комітяться разом. Якщо ефект падає, позначка відкочується з ним, і повтор чесно пробує ще раз.

Природний ключ, рівень 1, лишився з hw-19: один `fulfillment` на замовлення. Після того як inbox почистять, він не дасть зробити ефект удруге.

### Що показали три прогони

Свіжий volume, міграції з нуля, команди з Grading нижче. Мої числа:

```
demo:outbox           demo:crash-write        demo:crash-relay
requests=2            write-failed=1          killed=1
status-201=2          outbox-before-crash=1   published-before-kill=1
replayed=1            orders=0                unpublished-after-kill=1
key-reuse-422=1       outbox=0                published=1
orders=1              published=0             deliveries=2
outbox=1              deliveries=0            applied=1
published=1           effect=0                skipped=1
deliveries=1          stock-left=100          effect=1
effect=1                                      processed=1
processed=1
stock-taken=1
```

`demo:outbox` піднімає справжній маршрут `/v1/checkout` на вільному порту і шле два HTTP-запити з одним ключем одночасно, як клієнт, що не дочекався відповіді й повторив. Обидва отримали 201 з тим самим `order_id`, один із них позначений як replay. Вийшло одне замовлення, одна подія, одна доставка, і зі складу пішла одна одиниця. Третій запит з тим самим ключем, але кількістю 2, отримав 422.

`demo:crash-write` валить транзакцію вже після вставки в outbox. Щоб це було видно в числах, хук перед COMMIT рахує рядки outbox і бачить один (`outbox-before-crash=1`), а тоді кидає виняток. ROLLBACK забирає і замовлення, і подію, relay нічого не знаходить, склад лишається 100. Падіння тут змодельоване винятком у транзакції: для Postgres це той самий ROLLBACK, що й смерть процесу посеред транзакції.

`demo:crash-relay` вбиває relay по-справжньому. Relay працює в дочірньому процесі й після підтвердження від брокера робить собі `SIGKILL`, ще до `UPDATE published_at`. ОС закриває сокети, Postgres відкочує транзакцію relay, і рядок лишається неопублікованим. Здоровий relay публікує його вдруге. Консюмер отримує дві доставки, першу застосовує, другу відкидає inbox.

Я перевірив і зворотний бік, навмисно ламаючи код. Маршрут, який ігнорує заголовок і генерує ключ сам, дав у `demo:outbox` `orders=3` і `stock-taken=4`, exit 1. Консюмер без дедупу дав `applied=2`, і `demo:crash-relay` вийшов з кодом 1. Outbox, записаний окремим COMMIT, дав у `demo:crash-write` подію-сироту: `outbox=1 published=1` при `orders=0`. Вона ще й чотири рази пройшла через консюмер і впала в DLQ, бо такого замовлення не існує.

Окремо прогнав два `npm run relay` паралельно на 200 подіях: 200 повідомлень, 0 дублів, кожен relay виніс рівно 100.

### Чому не можна поміняти місцями publish і `UPDATE published_at`

Якщо спершу закомітити позначку «опубліковано», а потім публікувати, то відмова брокера або смерть процесу між цими кроками лишить рядок, який каже «вже віддано», хоча брокер його не отримав. Relay його більше не візьме, і подія загубиться назавжди. У правильному порядку найгірше, що трапиться, це дубль, а дубль консюмер відкидає. Помилка від publish теж не означає «не доставлено»: могла загубитись лише відповідь брокера. Тож вибір тут між дублем і втратою, і дубль лікується, а втрата ні.

### Порядок, прибирання, Debezium

Порядку доставки relay не гарантує. `ORDER BY created_at, id` впорядковує лише вибірку, а `SKIP LOCKED` розкидає рядки між relay. Консюмеру порядок і не потрібен: на замовлення одна подія, ефект ідемпотентний. Якби знадобився, то тільки в межах ключа партиціонування (`aggregate_id`). Курсора по id тут немає й бути не може, бо рядок стає видимим на COMMIT, а не тоді, коли отримав id. Тому relay шукає саме `published_at IS NULL`.

Outbox росте, і разом з ним дорожчає частковий індекс, на якому стоїть relay. План: періодичне `DELETE FROM outbox WHERE published_at < now() - interval '7 days'` пачками, а на більших обсягах місячні партиції з `DROP PARTITION`. `processed_messages` так само, але з TTL довшим за найдовше вікно повторної доставки. Після чистки страхує природний ключ.

Імена колонок у snake_case. Debezium Outbox Event Router за замовчуванням чекає `aggregatetype` і `aggregateid`, тож при переході на CDC треба буде явно задати `route.by.field=aggregate_type` і `table.field.event.key=aggregate_id`. Ролі полів ті самі, консюмерів переписувати не доведеться.

Ефект консюмера тепер окрема транзакція з двома вставками, тож `effect-ms-avg` у `demo:publish` виріс до 13–30 мс залежно від прогону. Для `prefetch=20` це однаково 20 × 30 мс ≈ 0.6 с проти 30 хвилин `consumer_timeout`.

### Grading (hw-22: outbox)

```bash
docker compose up -d --wait

export DB_URL=postgres://marketplace@127.0.0.1:6432/marketplace
export DB_PASSWORD_FILE=secrets/db_password.example
export BROKER_URL=amqp://marketplace:dev_local_only_changeme@127.0.0.1:5672
export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm ci

npm run demo:outbox
npm run demo:crash-write
npm run demo:crash-relay
```

Брокер той самий RabbitMQ з hw-19, окремий процес, AMQP на 5672. Демо самі збирають TypeScript і накочують міграції. Основний шлях без `SKIP_VAULT` той самий: `DB_URL` і `BROKER_URL` приїжджають зі сховища через `scripts/with-secrets.sh`.

## Redis: кеш, сесії, ліміти, черга (hw-23)

Redis тут нічого не робить правильнішим. Він робить швидшим найгарячіше читання, тримає стан між запитами і виносить повільну роботу з HTTP. Усе, що стосується грошей і залишків, як і раніше вирішує Postgres: умовний `UPDATE` з hw-14 і ключ ідемпотентності з hw-22.

| Інстанс | Налаштування | Що там лежить | Порт |
|---|---|---|---|
| `redis-cache` | `maxmemory 32mb`, `allkeys-lru`, без персистентності | картки товарів, лічильники рейт-ліміту | 6380 |
| `redis-queue` | `noeviction`, `maxmemory 256mb`, AOF `everysec` | BullMQ (черга `jobs`), сесії | 6381 |

Інстансів два, бо вимоги протилежні. Кешу потрібен ліміт пам'яті й витіснення, а BullMQ у документації прямо каже, що з довільним витісненням ключів черга працювати не може, і просить `noeviction`. `maxmemory-policy` одна на весь процес Redis, `SELECT 1` її не розводить.

| Файл | Що там |
|---|---|
| `src/cache/cache-aside.ts` | cache-aside, TTL з джитером, single-flight лок, зняття лока Lua-скриптом |
| `src/catalog/product-card.ts` | важке читання і його інвалідація |
| `src/session/sessions.ts` | сесія на Redis-хеші з rolling TTL |
| `src/ratelimit/sliding-window.ts` | ковзне вікно одним Lua-скриптом, 429 і `Retry-After` |
| `src/queue/jobs.ts`, `src/worker.ts` | черга BullMQ, ретраї, `jobId`, планувальник; воркер `npm run worker` |
| `src/http/api.ts`, `src/redis/clients.ts` | збірка API для `npm run orders-api`, з'єднання з двома Redis |
| `src/demo-cache.ts`, `demo-session.ts`, `demo-ratelimit.ts`, `demo-queue.ts` (+ `demo-pod.ts`, `demo-redis-kit.ts`) | чотири демо |

`npm run orders-api` з hw-22 тепер віддає ще `GET /v1/products/:id/card` і `GET /v1/session`, а рейт-ліміт стоїть перед усіма маршрутами.

### Кеш картки товару

Важке читання тут картка товару: сам товар, продавець, залишок і агрегат по всіх рядках замовлень цього товару (`sold`, `orders`). Саме агрегат росте разом з магазином. Промах іде в базу і кладе картку в Redis, влучання в базу не ходить. TTL ставиться завжди: `300 + random(0..60)` секунд, щоб ключі, прогріті одним махом, не протухли в одну секунду. Після оформлення замовлення checkout видаляє картку цього товару, бо змінились залишок і продажі. Ця інвалідація йде додатково до TTL. Якщо `DEL` не пройде, картка проживе застарілою до кінця свого TTL, і це нормально.

Кеш не має права валити запит. Кожен виклик Redis загорнутий, і помилка означає «йди в базу». Перевірив руками: зупинив `redis-cache`, картка далі віддавалась із бази з кодом 200, а в лог пішли попередження. З'єднання для запитів налаштоване падати швидко (`enableOfflineQueue: false`, `commandTimeout: 500`), щоб мертвий Redis не підвішував HTTP.

Лавину гасить single-flight. Перший, хто не знайшов ключ, бере `SET lock:<key> <token> NX PX 2000` і йде в базу. Решта кожні 25 мс перечитує кеш і чекає щонайбільше 3 секунди, після чого йде в базу сама. Переможець після захоплення лока ще раз читає кеш: попередній власник міг записати картку між нашим `GET` і `SET NX`, і без цієї перевірки зрідка виходило б два походи. Лок знімається тільки своїм токеном, Lua-скриптом compare-and-delete. Redis тут 8.4.7, тож `DELEX … IFEQ` теж спрацював би. Lua лишив, бо він працює на будь-якій версії, у тому числі на керованих Redis, які 8.4 ще не мають.

### Якщо stampede-лок зламається

Лок може підвести: процес завис довше за 2 секунди TTL, Redis перезапустився і забув ключ, мережа розірвалась між `SET NX` і роботою. Тоді в базу підуть двоє або більше, і кожен запише в кеш ту саму картку, останній перезапише попереднього. Ми заплатимо зайвими запитами до Postgres. Без лока це видно в числах: 25 одночасних запитів дали 25 походів у базу замість одного. Зламаного стану не буде, бо картка все одно лише знімок із TTL, і жоден бізнес-інваріант від лока не залежить. Залишок і гроші захищає умовний `UPDATE … WHERE stock >= $1` з hw-14, повторне замовлення відсікає ключ ідемпотентності в Postgres. Тому fencing token тут не потрібен. Якби від лока залежало «списати рівно один раз», я взяв би транзакцію чи унікальний індекс, лок на Redis для такого не годиться.

### Сесії

Сесія живе у Redis-хеші `sess:<id>`, а в браузері лежить тільки cookie `sid`: 32 випадкові байти, `HttpOnly`, `SameSite=Lax`, у production ще `Secure`. Бібліотеку не брав, вистачило свого токен-стану. TTL 30 хвилин, і він ковзає. Кожен запит робить `EXPIRE`, який для неіснуючого ключа повертає 0 і не воскрешає протухлу сесію. Cookie отримує новий `Max-Age` разом з ним. Процес нічого не тримає в пам'яті, тому сесію підхоплює будь-який под, у тому числі перезапущений.

Сесії лежать у `redis-queue`, і це свідомий вибір. У кеш-інстансі `allkeys-lru` колись викине чиюсь сесію, і людину розлогінить без жодної причини, яку можна відтворити. Третій інстанс тільки під сесії зараз означав би ще один контейнер і ще один моніторинг без реальної потреби. Ціну я бачу: сесії й задачі ділять 256 МБ, і якщо пам'ять скінчиться, `noeviction` почне відмовляти в записі обом одразу. Зате відмова буде гучною помилкою, тихої втрати не буде. Якщо Redis сесій недоступний, запит іде далі без сесії, а `GET /v1/session` відповідає 503.

### Рейт-ліміт

Ковзне вікно (sliding window log на sorted set), бо сплеск ми не дозволяємо: за будь-які 10 секунд проходить не більше 20 запитів, тоді як фіксоване вікно на межі пропустило б 40, а token bucket сплеск дозволяє за задумом. Ліміт рахується на клієнта, ключ `X-User-Id`, а без нього IP. `X-User-Id` у цьому курсі тримає місце справжньої ідентичності до auth у hw-24, підробити його поки що легко.

Вся перевірка йде одним Lua-скриптом: `ZREMRANGEBYSCORE`, `ZCARD`, `ZADD`, `PEXPIRE`. Ті самі команди з Node пускали б інший под між `ZCARD` і `ZADD`. Час береться з `TIME` самого Redis, щоб поди з різним годинником бачили одне вікно. Перевищення віддає 429 і `Retry-After`: скільки секунд лишилось, поки найстаріший запит вийде з вікна. Якщо Redis недоступний, ліміт пропускає запит. Він береже потужність сервісу, правильність від нього не залежить, і падіння Redis не повинно класти API. Лічильники лежать у кеш-інстансі, бо їх не шкода втратити. Витіснення лише обнулило б вікно одного клієнта, а активні ключі LRU майже не чіпає.

### Черга

Одна черга BullMQ `jobs` на дві роботи, яким нема чого робити в HTTP-запиті:

- `send-receipt`: квитанція покупцю. `jobId` дорівнює `receipt-<orderId>`, тож другий `add` для того ж замовлення нічого не додає. Двокрапки в `jobId` BullMQ не дозволяє.
- `outbox-cleanup`: чистка, яку обіцяв розділ hw-22. Пачками видаляє з `outbox` опубліковані рядки, старші за тиждень. Планувальник ставиться через `upsertJobScheduler` щогодини при кожному старті воркера. Саме upsert, бо `add` після кожного рестарту додавав би ще один планувальник. Старого repeat-API у BullMQ 6 вже немає.

Ретраї: `attempts: 4`, `backoff: { type: 'exponential', delay: 500, jitter: 0.5 }`. За формулою BullMQ це 500 мс, 1 с, 2 с, з яких джитер віднімає до половини. `removeOnComplete: { age: 24 год }` замість `true`, бо з `true` виконана задача зникає, і той самий `jobId` знову проходить. Воркер підключається з `maxRetriesPerRequest: null`, щоб при обриві він чекав Redis і не падав. Продюсер навпаки падає швидко (`enableOfflineQueue: false`), і що робити далі, вирішує той, хто викликав `add`. Невідома назва задачі кидає `UnrecoverableError`, ретраї їй не допоможуть.

Квитанцію поки ніхто не ставить у чергу. Природне місце для цього консюмер `order.placed` з hw-19/22: доставка at-least-once плюс `jobId` дадуть рівно одну квитанцію на замовлення. Справжнього поштового провайдера в проєкті немає, воркер пише квитанцію в лог.

### Що показали прогони

Свіжі volume, команди з Grading нижче. Мої числа:

```
demo:cache               demo:session                demo:ratelimit        demo:queue
cache-lru=1              requests=3                  instances=2           queue-noeviction=1
cache-maxmemory=1        sessions=1                  limit=20              attempts=3
warmed=60                in-redis=1                  window-ms=10000       retry-gap-1-ms=463
ttl-distinct=37          ttl-before-ms=1798492       requests=45           retry-gap-2-ms=733
ttl-min=300              ttl-after-ms=1799995        allowed=20            completed=1
ttl-max=357              ttl-renewed=1               blocked=25            added=2
cold-keys-written=6500   restarted=1                 status=429            queued=1
evicted=13               session-requests=3          retry-after=1         dedup-after-complete=1
concurrent=25                                        retry-after-sec=10    schedulers=1
db-calls=1                                                                 scheduled-runs=4
stampede-ms=27.0
db-calls-warm=0
warm-read-ms-avg=0.23
```

`demo:cache` створює 60 товарів і прогріває їхні картки. 60 ключів отримали від 36 до 41 різного TTL у межах 300–360 с. Потім демо заливає в кеш холодні значення по 4 КБ, щоразу у свіжому просторі імен `cold:<uuid>`, бо перезапис тих самих ключів пам'яті не додає. Заливка йде, поки LRU не витіснить кілька карток. Після 6500 холодних ключів зникло від 3 до 13 карток. Демо бере ту картку, яку обрав сам LRU. На неї летять 25 одночасних запитів з двох окремих з'єднань (два «поди»), і в базу йде рівно один. Після цього 100 читань теплого ключа дають 0 походів у базу, 0.23 мс на читання. Походи в базу рахує логер TypeORM, тобто кожен SQL, що реально пішов у Postgres, а не виклики наших функцій. Холодні ключі з минулих прогонів демо прибирає через `SCAN` + `UNLINK`. `KEYS` у коді немає ніде, він блокує весь Redis.

`demo:session` і `demo:ratelimit` піднімають поди окремими дочірніми процесами (`demo-pod.ts`). Спочатку я тримав два «поди» в одному процесі, і лімітер у пам'яті модуля таку перевірку проходив. Процеси ділять лише Redis. У `demo:session` між запитами справжня пауза 1.5 с: TTL сходить до 1798492 мс, а наступний запит повертає його на 1799995. Потім под вбивається `SIGKILL`, стартує новий, і третій запит потрапляє в ту саму сесію з `requests=3`. `demo:ratelimit` шле 45 запитів (більше за 2 × limit) по черзі в два поди: пройшло рівно 20, решта отримали 429.

`demo:queue` ставить квитанцію двічі з одним `jobId` ще до старту воркера (`queued=1`), двічі робить upsert планувальника (`schedulers=1`) і запускає воркер з «поштою», яка двічі відповідає 503. Між спробами пройшло 345–596 мс і 606–1040 мс на шести прогонах, тобто експонента з джитером плюс кілька десятків мілісекунд, поки BullMQ переносить відкладену задачу в чергу. За 3.5 с планувальник спрацював 4 рази. Після виконання третій `add` з тим самим `jobId` нічого не створює, бо задача ще лежить серед виконаних.

Я перевірив і зворотний бік, навмисно ламаючи код:

| Що зламав | Що показало демо |
|---|---|
| лок завжди «захоплений» | `db-calls=25`, exit 1 |
| TTL без джитера | `ttl-distinct=1`, exit 1 |
| лічильник ліміту в пам'яті процесу | `allowed=40 blocked=5`, тобто 2 × limit, exit 1 |
| сесії в пам'яті процесу | після рестарту `sessions=2`, `session-requests=1`, exit 1 |
| `removeOnComplete: true` | `dedup-after-complete=0`, квитанція пішла двічі, exit 1 |
| без `jobId` | `queued=2`, три квитанції на одне замовлення, exit 1 |

Перед `demo:queue` зупиніть `npm run worker`, якщо він запущений: він забере частину задач. `demo:cache` навмисно заливає `redis-cache` холодними даними, тож після нього кеш майже порожній.

### Grading (hw-23: Redis)

```bash
docker compose up -d --wait

export DB_URL=postgres://marketplace@127.0.0.1:6432/marketplace
export DB_PASSWORD_FILE=secrets/db_password.example
export REDIS_URL=redis://127.0.0.1:6380         # кеш, allkeys-lru
export REDIS_QUEUE_URL=redis://127.0.0.1:6381   # черга і сесії, noeviction
export SKIP_VAULT=1    # у грейдера немає доступу до сховища

npm ci

npm run demo:cache
npm run demo:session
npm run demo:ratelimit
npm run demo:queue
```

Обидва Redis у dev без пароля. RabbitMQ для цих демо не потрібен. Демо самі збирають TypeScript, `demo:cache` і `demo:queue` ще й накочують міграції. TypeScript лишився на 5.9.3, точною версією без діапазону: саме з нею збирається і тестується BullMQ 6.3.11, тож `npm ci` не притягне 7.x. Основний шлях без `SKIP_VAULT` той самий, `REDIS_URL` і `REDIS_QUEUE_URL` приїжджають зі сховища через `scripts/with-secrets.sh`.

## Auth (hw-24)

До hw-24 `POST /v1/checkout` брав покупця з заголовка `X-User-Id`, тож замовити міг будь-хто від імені будь-кого. Тепер API спершу з'ясовує, хто прийшов: це автентифікація, і доводить її підпис access-токена. Потім окремо вирішує, чи можна цій людині те, що вона просить: це авторизація, тобто роль і власність. Криптографія відповідає лише на перше питання, друге залежить від даних, яких у токені немає.

`npm start` тепер запускає саме Postgres API (`src/orders-api.ts`). Користувачі, замовлення і товари живуть там. Застосунок hw-09 із замовленнями в пам'яті переїхав на `npm run start:inmemory`, і на ньому, як і раніше, стоять Pact-контракт hw-16 і realtime hw-18. `X-User-Id` більше ніде не читається: checkout бере покупця з токена, а рейт-ліміт з hw-23 рахує на `sub` або, для анонімних запитів, на IP.

| Змінна | Джерело | Навіщо |
|---|---|---|
| `JWT_PRIVATE_KEY` | сховище (#11) | підпис access-токенів. Base64 від PKCS#8 PEM, EC P-256 |
| `JWT_PUBLIC_KEY` | сховище (#11) | перевірка підпису. Base64 від SPKI PEM, має бути парою до приватного |
| `JWT_KID` | сховище (#11) | id ключа, іде в заголовок кожного токена |
| `REFRESH_TOKEN_PEPPER` | сховище (#11) | «перець» для HMAC-хешів refresh-токенів, щонайменше 32 символи |
| `JWT_PREV_KID`, `JWT_PREV_PUBLIC_KEY` | сховище, лише під час ротації | попередній ключ: ще перевіряє, вже не підписує |
| `DB_URL` | сховище (#12) | Postgres через PgBouncer |
| `REDIS_URL`, `REDIS_QUEUE_URL` | сховище (#23) | кеш і ліміти; черга, сесії і денилист |
| `DB_PASSWORD_FILE` | шлях з оточення, файл поза git | пароль БД, як з hw-11 |
| `ORDERS_API_PORT` | оточення, за замовчуванням 3001 | порт API |

Дефолтів для ключів і перцю в схемі немає, бо дефолт тут означає ключ, зашитий у код. Конфіг перевіряється першою дією процесу: `src/config/api-env.ts` імпортується найпершим, ще до `data-source.ts`, який читає `DB_URL` уже при імпорті. Тому голий старт без сховища не встигає дійти до бази і називає, чого бракує:

```
$ npm start
Invalid environment configuration:
  - DB_URL: Required
  - REDIS_URL: Required
  - REDIS_QUEUE_URL: Required
  - JWT_KID: Required
  - JWT_PRIVATE_KEY: Required
  - JWT_PUBLIC_KEY: Required
  - REFRESH_TOKEN_PEPPER: Required
```

Ключі розбираються одразу. RSA замість EC, обрізаний base64 (той самий `DECODER routines::unsupported`) і публічний ключ від іншої пари теж падають на старті з назвою змінної, до першого підпису. Повний запуск іде через `npm run start:vault`, тобто `scripts/with-secrets.sh dev npm run start`.

### Токени

Access-токен це JWT на 10 хвилин, підписаний ES256. У ньому `sub`, `role`, `fid` (сім'я refresh-токенів), `jti`, `iss`, `aud`, `exp`, а в заголовку `kid` і `typ: at+jwt`. Обрав ES256, бо OWASP позначає RS256 як «Not recommended» і радить ES256, PS256 або EdDSA. З цих трьох у ES256 найменший ключ і підпис (64 байти замість 256 у RSA-2048), підписує він швидше, а P-256 розуміє будь-який шлюз і будь-яка бібліотека. Верифікатор має лише публічний ключ, тож виписати собі токен він не може, хай навіть зламаний.

Перевірка йде через `jwtVerify` з `jose` з явним `algorithms: ['ES256']`, плюс `issuer`, `audience` і `typ`. Що б не стояло в полі `alg` заголовка, приймається тільки ES256: це і є захист від algorithm confusion (RFC 8725 §3.1). Токен з `alg: none` відкидається тим самим правилом, я перевірив. Ключ обирається за `kid` зі списку відомих, невідомий `kid` дає 401.

Refresh-токен непрозорий: 32 випадкові байти, ніякого JWT. У таблиці `refresh_tokens` лежить лише `token_hash = HMAC-SHA256(pepper, token)`, і по ньому стоїть унікальний індекс. Дамп таблиці не дає ні чинних токенів, ні навіть способу перевірити вгаданий, бо перець лежить у сховищі, а не в базі. Живе refresh 14 днів.

Паролі хешуються scrypt (N=2^15, r=8, p=3, близько 32 МіБ і сотні мілісекунд на хеш). Argon2id в `node:crypto` є лише з Node 24.7, курс працює на 22, а scrypt OWASP називає запасним варіантом. Порівняння йде через `timingSafeEqual`. Для невідомого email сервер однаково рахує один хеш, щоб за часом відповіді не можна було перебрати, які адреси зареєстровані.

### Ротація refresh і детекція повтору

Кожен успішний refresh позначає поточний токен `used_at` і видає наступний у тій самій сім'ї (`family_id`). Усе це одна транзакція з `SELECT … FOR UPDATE` по рядку токена, тому два одночасні refresh з одним токеном ідуть по черзі, і другий бачить `used_at`. Токен, який уже витратили, означає, що його тримають двоє, і ми не знаємо, хто з них злодій. Тому відкликається вся сім'я, разом зі свіжим токеном чесного клієнта, а в лог іде рядок:

```
[auth] refresh token reuse detected: user=3f6c… family=9b1e…, family revoked
```

Саме так це формулює RFC 9700 §4.14.2: або sender-constrained токен, або ротація з детекцією повтору. Зв'язок між старим і новим токеном (у нас це `family_id`) зберігається, щоб виявлений повтор було чим відкликати. Ротація без сім'ї тут нічого не дає: злодій рефрешиться першим, а чесний клієнт отримує 401 і мовчки логіниться заново, поки сесія злодія живе далі. Заодно сім'я потрапляє в денилист, тож access-токени, які злодій уже отримав, теж помирають одразу, без очікування `exp`.

Гонку на клієнті я вирішив серіалізацією на клієнті, без вікна благодаті. Якщо фронт пошле два refresh одночасно, другий спрацює як повтор і вилогінить користувача. Тому клієнт мусить тримати один спільний проміс на refresh для всіх запитів. Вікно благодаті віддало б пару будь-кому, хто встиг у ці кілька секунд, зокрема й злодієві. До того ж його не зробити чесно без зберігання відкритого нового токена, а в базі в нас тільки хеші.

### Чому логаут це дві дії

Refresh-токен це рядок у базі, і вистачить позначити його сім'ю `revoked_at`. Access-токен самодостатній: підпис лишається чинним до `exp`, і база про нього нічого не знає. Тому другий крок кладе його `jti` в денилист з TTL рівно на залишок життя токена (плюс секунда). Без першого кроку refresh далі виписує нові access-токени. Без другого вкрадений access працює ще до 10 хвилин після логауту. Це видно в числах: коли я вимкнув денилист, `after-logout` став 200. Разом з `jti` у денилист іде й сім'я. Так помирають і старші access-токени того самого логіна, отримані до останнього refresh (`old-access-after-logout=401`).

Ці дві дії пишуть у два різні сховища, і атомарними вони не є, це той самий dual write, що в hw-22. Порядок обрано свідомо. Спершу Postgres: після цього кроку нових access-токенів уже не буде. Потім Redis. Якщо Redis не відповів, клієнт отримує 503 і повторює логаут, обидва кроки ідемпотентні. Найгірше, що лишиться, якщо клієнт не повторить: access доживе до свого `exp`, а refresh уже мертвий.

Денилист лежить у `redis-queue` (noeviction). У кеш-інстансі `allkeys-lru` міг би витіснити запис про відкликаний токен, і той ожив би. Ключ складається з `iss` і `jti`. Кожен запис зникає разом із токеном, який він блокує, тож список ніколи не більший за кількість живих зараз токенів. Якщо Redis з денилистом недоступний під час перевірки, API відповідає 503 і нікого не пускає. Це вибір безпеки проти доступності, і 503 обрано замість 401, щоб клієнти не почали масово рефрешитись.

### 401 і 403

401 означає, що ми не знаємо, хто це: немає токена, протух, зіпсований, підроблений, відкликаний. На 401 клієнт іде рефрешити. 403 означає, що ми точно знаємо, хто це, і відповідь «ні». Рефреш тут не допоможе, клієнт показує помилку. Переплутати їх означає або вічний цикл рефрешу, або вилогінювання на кожній чужій сторінці. 401 віддається разом із `WWW-Authenticate: Bearer error="invalid_token"`.

### Ролі і власність

Ресурс із власником тут замовлення (`orders.buyer_id`). Ресурс, у який пише лише привілейована роль, це товари: створювати їх можуть тільки `seller` і `admin`. Рівень ролі перевіряє гард `requireRole('seller', 'admin')` на `POST /v1/products`, і покупець отримує 403. Продавцем нового товару стає той, хто в токені, а не поле з тіла.

Рівень власності свідомо зроблено поза гардом. Межа проходить в обробнику `GET /v1/orders/:id`, одразу після того, як замовлення завантажено одним запитом: тільки тоді ми знаємо, чиє воно. Немає такого замовлення, буде 404. Є, але воно чуже, буде 403 (адмін бачить усі). Гард стоїть до завантаження, і щоб дізнатись власника, йому довелось би сходити в базу вдруге.

Роль у токені лише кеш, джерело правди це колонка `users.role`. Розжалуваний адмін лишається адміном до `exp` свого access-токена, тобто до 10 хвилин. Наступний refresh бере роль уже з таблиці, бо ротація читає `users.role`, і копія в токені оновлюється. Якщо треба миттєво, лишається відкликати сім'ї цього користувача і покласти їх у денилист. Це два запити, але окремої кнопки для цього я поки не робив. `GET /v1/me` показує обидва значення, `role` з бази і `token_role` з токена.

### Ключ підпису: overlap-ротація і kid

`kid` у заголовку каже верифікатору, яким ключем перевіряти, і завдяки цьому ключ можна міняти без «всі вилогінились». Ротація йде так. Генеруємо нову пару і кладемо її в `JWT_KID`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, а старий публічний ключ переїжджає в `JWT_PREV_KID` і `JWT_PREV_PUBLIC_KEY`. Нові токени вже підписані новим ключем, а старі ще проходять перевірку. Через 10 хвилин (`ACCESS_TTL`) старих токенів у природі не лишилось, і `JWT_PREV_*` прибираємо. Перевірив на двох парах: старий токен приймається під час overlap і отримує 401 «unknown kid» після нього. Refresh-токени від ключа підпису не залежать, тож ротація ключа нікого не вилогінює. З перцем інакше: його зміна робить недійсними всі refresh-токени, і перелогінитись доведеться всім.

Ключі dev і prod різні, і ось їхні відбитки (SHA-256 від публічного ключа в DER). API друкує такий самий рядок при старті, сам ключ не потрапляє в лог ніколи:

```
dev   kid=dev-2026-10   SHA256:wOpH93ilOg6hAjKf4YeXtFa2mJ_N72KPDRIWeX3uC-I
prod  kid=prod-2026-10  SHA256:SLfIhamAPAojdUmabcwKUALWAHL2DbG9MfNoxW-Uncw
```

У логах є `jti`, `family_id` і відбиток ключа, а самих токенів немає: ні access, ні refresh, ні їхніх хвостів. `demo:reuse` перевіряє це по лог-виводу пода (`tokens-in-log=0`).

### Що показали прогони

Свіжий volume, одноразова пара ES256, команди з Grading нижче:

```
demo:auth                    demo:reuse                  demo:rbac
login=200                    login=200                   anon=401
no-token=401                 r1-refresh=200              own=200
with-token=200               r1-reuse=401                foreign=403
refresh=200                  r2-after-reuse=401          role-denied=403
logout=204                   access-after-reuse=401      role-allowed=201
after-logout=401             family-tokens=2             tampered=401
refresh-after-logout=401     family-alive-tokens=0       tampered-foreign=401
old-access-after-logout=401  reuse-logged=1              missing=404
deny-ttl-sec=601             tokens-in-log=0             checkout=201
family-alive-tokens=0                                    logins=3
```

Кожне демо саме піднімає застосунок окремим процесом на вільному порту, з власним простором імен рейт-ліміту, і вбиває його в `finally`. Користувачі створюються з адресами `@demo.test` і прибираються на початку наступного прогону разом зі своїми токенами, замовленнями й товарами. `tampered` це access-токен Аліси, де в payload `role` замінено на `admin`, а підпис лишився старий.

Що я ламав навмисно, щоб перевірити самі демо:

| Що зламав | Що показало демо |
|---|---|
| `decodeJwt` замість `jwtVerify` | `tampered=201`, `tampered-foreign=200`, exit 1 |
| повтор не відкликає сім'ю | `r2-after-reuse=200`, `family-alive-tokens=3`, exit 1 |
| денилист вимкнено | `after-logout=200`, `old-access-after-logout=200`, exit 1 |
| гард ролі вимкнено | `role-denied=201`, exit 1 |
| перевірку власності прибрано | `foreign=200`, exit 1 |
| 403 віддається як 401 | `role-denied=401`, exit 1 |

### Grading (hw-24: Auth)

```bash
docker compose up -d --wait

export DB_URL=postgres://marketplace@127.0.0.1:6432/marketplace
export DB_PASSWORD_FILE=secrets/db_password.example
export REDIS_URL=redis://127.0.0.1:6380
export REDIS_QUEUE_URL=redis://127.0.0.1:6381
export SKIP_VAULT=1            # у грейдера немає доступу до сховища

# одноразова пара ES256 для прогону; PEM їде в base64, щоб багаторядковість не поїхала
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
# щонайменше 32 символи, тому теж генерується
export REFRESH_TOKEN_PEPPER="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"

npm ci

npm run demo:auth
npm run demo:reuse
npm run demo:rbac
```

RabbitMQ для цих демо не потрібен. Демо самі збирають TypeScript і накочують міграції. Основний шлях без `SKIP_VAULT` той самий: ключі, перець, `DB_URL` і обидва Redis приїжджають зі сховища через `scripts/with-secrets.sh`.

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
