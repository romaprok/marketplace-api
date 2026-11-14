# Дата-шар (hw-12)

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

## Grading (hw-12: SQL-шар)

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
