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
| `PORT` | ні | `3000` | Порт, на якому слухає HTTP-сервер |
| `DB_URL` | **так** | — | Рядок підключення до Postgres без пароля, напр. `postgres://marketplace@localhost:5432/marketplace` |
| `DB_PASSWORD_FILE` | ні | `./secrets/db_password` | Шлях до файла з поточним паролем БД |
| `IDEMPOTENCY_TTL_HOURS` | ні | `24` | Скільки годин пам'ятаємо Idempotency-Key |
| `LOG_LEVEL` | ні | `info` | `debug` \| `info` \| `warn` \| `error` |

Пароль БД **не** зчитується з env — тільки з файлу (`DB_PASSWORD_FILE`), і `pg.Pool` перечитує цей файл на кожне нове з'єднання. Завдяки цьому пароль можна ротувати без рестарту процесу.

### Як запустити

```bash
npm install
cp .env.example .env
cp secrets/db_password.example secrets/db_password

docker compose up -d          # піднімає Postgres з тим самим паролем, що в secrets/db_password.example
npm start
```

Перевірка, що все підключилось:

```bash
curl http://localhost:3000/health
# {"status":"ok","uptime":1.23,"db":"ok"}
```

Якщо прибрати обов'язкову змінну — процес одразу падає з описом того, що саме не так:

```bash
env -u DB_URL npm run start
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
