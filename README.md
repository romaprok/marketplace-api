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

### Grading

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
