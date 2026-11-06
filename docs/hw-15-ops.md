# Data layer ops (hw-15)

Перед Postgres тепер стоїть PgBouncer, є скрипт нічного бекапу і скрипт, який відновлює останній дамп у чистий контейнер та перевіряє, що дані на місці.

| Файл | Що це |
|---|---|
| `pgbouncer/pgbouncer.ini`, `pgbouncer/userlist.txt` | конфіг PgBouncer і дев-користувач (пароль той самий, що в compose) |
| `scripts/backup.sh` | `pg_dump -Fc` у `backups/` з датою в імені |
| `scripts/restore-drill.sh` | відновлення останнього дампу в чистий контейнер і звірка |
| `scripts/control.sql` | контрольний запит, спільний для обох скриптів |
| `backup.cron` | рядок розкладу, щоночі о 03:00 |
| `RESTORE-DRILL.md` | протокол мого drill-у: розмір, час, RTO, RPO |

## Як підняти

```bash
docker compose up -d --wait
```

Назовні відкритий тільки PgBouncer, порт 6432. Порт Postgres я з compose прибрав: застосунок має ходити через пулер, а в мене на 5432 ще й сидить локальний Postgres. `.env.example` уже вказує на 6432, таке саме значення треба виставити в `DB_URL` у сховищі (dev і prod). Нового env-файлу немає.

Адмін-консоль PgBouncer, користувач той самий:

```bash
PGPASSWORD=dev_local_only_changeme psql -h 127.0.0.1 -p 6432 -U marketplace -d pgbouncer -c "SHOW POOLS"
```

## Бекап

```bash
bash scripts/with-secrets.sh dev bash scripts/backup.sh
```

Дамп лягає в `backups/` (в gitignore, тека міняється через `BACKUP_DIR`), в імені дата і час. Поруч файл `.control` із контрольним значенням на момент бекапу: кількість рядків у `users`, `products`, `orders`, `order_items` і сума `orders.total`. Ця сума потрібна drill-у, щоб було з чим порівнювати, навіть якщо вихідної бази вже нема.

`pg_dump` іде прямо в контейнер `postgres`, повз PgBouncer: це одна довга транзакція, а версія клієнта має збігатися з сервером (хостовий `pg_dump` у мене 14, сервер 16). Скрипт одразу перевіряє, що архів читається. Зі свого боку TOC теж краще дивитись через контейнер, бо `pg_restore` старіше за 16 такий дамп не відкриє:

```bash
docker compose exec -T postgres pg_restore --list < backups/<файл>.dump
```

Розклад лежить у `backup.cron`. Шлях `/opt/marketplace-api` треба підставити свій, ставиться через `crontab backup.cron`.

## Відновлення

```bash
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

Скрипт бере найновіший дамп, піднімає чистий `postgres:16-alpine` (порожній volume, сам його створює і сам прибирає), робить `pg_restore --no-owner` і порівнює контрольне значення з `.control`. Друкує `MATCH` або виходить з кодом 1. Що вийшло в мене, написано в RESTORE-DRILL.md. Справжнє відновлення відрізняється лише ціллю: той самий `pg_restore --no-owner -d <база>` у порожню базу.

## Чому transaction mode і що він ламає

Клієнтів у застосунку багато (плюс воркери з hw-14), а з'єднання з Postgres дорогі, бо це окремий процес на кожне. У transaction mode PgBouncer віддає клієнту справжнє з'єднання тільки на час транзакції, тож до 200 клієнтів (`max_client_conn`) ділять п'ять серверних (`default_pool_size`). Розплата в тому, що між транзакціями клієнт може опинитись на іншому з'єднанні, і все, що тримається на сесії, ламається: `SET` поза транзакцією (треба `SET LOCAL` всередині), `LISTEN/NOTIFY`, сесійні advisory locks, курсори `WITH HOLD` і іменовані prepared statements. З останніми допомагає `max_prepared_statements = 200`, PgBouncer це вміє з 1.21, у нас 1.24.1. У коді hw-14 нічого з цього списку немає: `FOR UPDATE SKIP LOCKED` і `REPEATABLE READ` живуть усередині однієї транзакції, і `demo:race`, `demo:workers`, `demo:retry` через PgBouncer дали ті самі числа, що й напряму.

## Ротація пароля після PgBouncer

`userlist.txt` статичний, тому `rotate.sh` з hw-11 разом із PgBouncer ламає застосунок: Postgres уже на новому паролі, PgBouncer ще на старому, і `/health` віддає `password authentication failed`. Я це перевірив. Руками лікується так: записати новий пароль у `pgbouncer/userlist.txt` і зробити `docker compose restart pgbouncer`. Нормальне рішення (`auth_query`, щоб PgBouncer сам питав пароль у Postgres) у це ДЗ не входить. Після таких експериментів файл варто повертати через `git checkout pgbouncer/userlist.txt`, бо `docker compose down -v` знову підніме Postgres зі стартовим паролем.

## Grading (hw-15: PgBouncer, бекап, drill)

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
