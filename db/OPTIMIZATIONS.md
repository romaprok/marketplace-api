# Оптимізація запитів — hw-12

Дані: 50 001 users (50 000 + 1 anchor), 120 000 products, 150 004 orders
(150 000 + 4 anchor), 350 004 order_items (`db/seed.sql`, `VACUUM (ANALYZE)`
наприкінці). Anchor-рядки — це кілька рядків із фіксованими (не
`gen_random_uuid()`) id, вставлені окремо, щоб `db/queries/q1.sql` і
`q3.sql`, які захардкожені на конкретні значення, стабільно повертали
непорожній і однаковий результат на кожному пересіді — див. коментарі в
`db/seed.sql`. Усі плани зняті на моїй машині (Postgres 16, Docker Desktop,
M-серія Mac) — числа інші на іншому залізі, але порядок прискорення
(десятки разів, не мілісекунди) той самий.

## q1 — замовлення власника за період

Файл: `db/queries/q1.sql`. Індекс: `idx_orders_buyer_created_at`.

### До

```
Sort  (cost=5256.89..5256.89 rows=1 width=40) (actual time=10.462..12.731 rows=5 loops=1)
  Sort Key: created_at DESC
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=3166
  ->  Gather  (cost=1000.00..5256.88 rows=1 width=40) (actual time=5.399..12.698 rows=5 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=3163
        ->  Parallel Seq Scan on orders  (cost=0.00..4256.78 rows=1 width=40) (actual time=3.565..8.101 rows=2 loops=3)
              Filter: ((created_at >= '2025-01-01 00:00:00+00'::timestamp with time zone) AND (created_at <= '2026-01-01 00:00:00+00'::timestamp with time zone) AND (buyer_id = 'a0000000-0000-4000-8000-000000000001'::uuid))
              Rows Removed by Filter: 50000
              Buffers: shared hit=3163
Planning:
  Buffers: shared hit=97
Planning Time: 0.568 ms
Execution Time: 12.801 ms
```

### Після

```
Index Scan Backward using idx_orders_buyer_created_at on orders  (cost=0.42..8.44 rows=1 width=40) (actual time=0.055..0.081 rows=5 loops=1)
  Index Cond: ((buyer_id = 'a0000000-0000-4000-8000-000000000001'::uuid) AND (created_at >= '2025-01-01 00:00:00+00'::timestamp with time zone) AND (created_at <= '2026-01-01 00:00:00+00'::timestamp with time zone))
  Buffers: shared hit=6 read=3
Planning:
  Buffers: shared hit=139 read=2
Planning Time: 0.574 ms
Execution Time: 0.129 ms
```

`Index Scan Backward using idx_orders_buyer_created_at` — індекс покрив і
фільтр (`buyer_id`, `created_at`), і сортування (`ORDER BY created_at DESC`
читається назад по тому ж btree, окремий `Sort` зник). `Parallel Seq Scan` +
`Gather` + окремий `Sort` (3166 buffers) перетворились на єдиний
`Index Scan` (9 buffers) — execution time з 12.8 мс до 0.13 мс (~99×). 5, а
не 3, рядків у результаті — крім 3 anchor-замовлень у періоді, цьому ж
buyer_id випало ще пару замовлень зі звичайного випадкового генератора; це
нормально й не впливає на план.

## q2 — фільтр за статусом

Файл: `db/queries/q2.sql`. Індекс: `idx_orders_pending_created_at` (partial).

### До

```
Limit  (cost=5567.09..5572.92 rows=50 width=50) (actual time=8.790..10.327 rows=50 loops=1)
  Buffers: shared hit=3237
  ->  Gather Merge  (cost=5567.09..9941.93 rows=37496 width=50) (actual time=8.789..10.309 rows=50 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=3237
        ->  Sort  (cost=4567.07..4613.94 rows=18748 width=50) (actual time=6.461..6.464 rows=40 loops=3)
              Sort Key: created_at DESC
              Sort Method: top-N heapsort  Memory: 35kB
              Buffers: shared hit=3237
              ->  Parallel Seq Scan on orders  (cost=0.00..3944.27 rows=18748 width=50) (actual time=0.118..4.598 rows=14938 loops=3)
                    Filter: (status = 'pending'::text)
                    Rows Removed by Filter: 35064
                    Buffers: shared hit=3163
Planning:
  Buffers: shared hit=94
Planning Time: 0.344 ms
Execution Time: 10.384 ms
```

### Після

```
Limit  (cost=0.29..15.73 rows=50 width=50) (actual time=0.054..0.221 rows=50 loops=1)
  Buffers: shared hit=50 read=2
  ->  Index Scan Backward using idx_orders_pending_created_at on orders  (cost=0.29..13822.26 rows=44766 width=50) (actual time=0.054..0.217 rows=50 loops=1)
        Buffers: shared hit=50 read=2
Planning:
  Buffers: shared hit=126
Planning Time: 0.445 ms
Execution Time: 0.254 ms
```

`Index Scan Backward using idx_orders_pending_created_at` — і фільтр
(`status='pending'` вбудований у сам partial-індекс, тому в плані навіть
нема окремого `Filter`), і `ORDER BY ... LIMIT 50` — індекс уже впорядкований
за `created_at`, тому `Sort`/`Gather Merge`/паралельні воркери зникли
повністю. Buffers впали з 3237 до 52 (~62×), час — з 10.4 мс до 0.25 мс
(~41×).

## q3 — пошук без урахування регістру

Файл: `db/queries/q3.sql`. Індекс: `idx_users_email_lower` (expression).

### До

```
Seq Scan on users  (cost=0.00..1407.01 rows=250 width=63) (actual time=0.021..20.935 rows=1 loops=1)
  Filter: (lower(email) = 'user1@example.com'::text)
  Rows Removed by Filter: 50000
  Buffers: shared read=657
Planning:
  Buffers: shared hit=84
Planning Time: 0.658 ms
Execution Time: 20.962 ms
```

### Після

```
Index Scan using idx_users_email_lower on users  (cost=0.41..8.43 rows=1 width=63) (actual time=0.040..0.040 rows=1 loops=1)
  Index Cond: (lower(email) = 'user1@example.com'::text)
  Buffers: shared hit=1 read=3
Planning:
  Buffers: shared hit=107 read=1
Planning Time: 0.398 ms
Execution Time: 0.063 ms
```

`Index Scan using idx_users_email_lower` — звичайний індекс на `email` тут
не допоміг би: у `WHERE` стоїть `lower(email)`, функція від колонки, а не
сама колонка, тому потрібен саме expression-індекс. `Seq Scan` пройшовся по
657 buffers (уся таблиця), `Index Scan` — по 4. Execution time 21.0 мс →
0.063 мс (~330×).

## q4 — повнотекстовий пошук по каталогу

Файл: `db/queries/q4.sql`. Індекс: `idx_products_search_vector` (GIN по
`tsvector`). Значення нижче — третій прогін після `CREATE INDEX` (перший
прогін по холодному GIN явно повільніший — кеш індексу ще порожній; другий і
третій прогони вже стабільно збігаються, тому в звіт іде третій).

### До

```
Limit  (cost=10503.27..10503.32 rows=20 width=53) (actual time=53.428..53.431 rows=20 loops=1)
  Buffers: shared hit=8445 read=559
  ->  Sort  (cost=10503.27..10503.72 rows=181 width=53) (actual time=53.426..53.428 rows=20 loops=1)
        Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
        Sort Method: top-N heapsort  Memory: 29kB
        Buffers: shared hit=8445 read=559
        ->  Seq Scan on products  (cost=0.00..10498.45 rows=181 width=53) (actual time=0.065..52.904 rows=3000 loops=1)
              Filter: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
              Rows Removed by Filter: 117000
              Buffers: shared hit=8439 read=559
Planning:
  Buffers: shared hit=85 read=9
Planning Time: 0.582 ms
Execution Time: 53.575 ms
```

### Після

```
Limit  (cost=765.96..766.01 rows=20 width=53) (actual time=5.530..5.533 rows=20 loops=1)
  Buffers: shared hit=3014
  ->  Sort  (cost=765.96..766.47 rows=202 width=53) (actual time=5.529..5.530 rows=20 loops=1)
        Sort Key: (ts_rank(search_vector, '''шкіряні'' & ''кросівки'''::tsquery)) DESC, id
        Sort Method: top-N heapsort  Memory: 29kB
        Buffers: shared hit=3014
        ->  Bitmap Heap Scan on products  (cost=47.01..760.59 rows=202 width=53) (actual time=0.775..5.133 rows=3000 loops=1)
              Recheck Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
              Heap Blocks: exact=3000
              Buffers: shared hit=3008
              ->  Bitmap Index Scan on idx_products_search_vector  (cost=0.00..46.96 rows=202 width=0) (actual time=0.511..0.511 rows=3000 loops=1)
                    Index Cond: (search_vector @@ '''шкіряні'' & ''кросівки'''::tsquery)
                    Buffers: shared hit=8
Planning:
  Buffers: shared hit=119
Planning Time: 0.436 ms
Execution Time: 5.586 ms
```

`Bitmap Index Scan on idx_products_search_vector` знаходить усі 3000
збігів за 8 buffers замість повного `Seq Scan` по 120 000 рядків (9004
buffers). `ts_rank` все одно рахується й сортується по всіх 3000 збігах —
це не оминути жодним індексом, ранжування завжди дивиться на всіх
кандидатів — тому `Heap Blocks: exact=3000` в плані лишається; порівняно з
117 000 відкинутих рядків `Seq Scan`'у це все одно на порядок менше буферів
(3014 проти 9004) і execution time з 53.6 мс до 5.6 мс (~10×) — менше, ніж
у q1-q3, саме тому, що сама вибірка (3000 рядків) велика і невідворотна;
пришвидшився саме пошук збігів (GIN проти повного скану), а не подальша
обробка знайдених рядків.

## Морфологія

`plainto_tsquery('simple', ...)` не має стемінгу — `simple`-конфіг лише
приводить до нижнього регістру й токенізує, без словникової нормалізації
словоформ. Тому дві форми одного слова — це для нього два різні лексеми:

```sql
SELECT count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівки');
-- 3000
SELECT count(*) FROM products WHERE search_vector @@ plainto_tsquery('simple', 'кросівок');
-- 2264
```

3000 і 2264 — це майже не одна й та сама множина рядків: `'шкіряні
кросівки'` (лема) навмисно зашита в 2.5% каталогу (`db/seed.sql`, `i % 40 =
0`), а `'кросівок'` — в іншому, здебільшого непересічному наборі рядків
(`i % 53 = 0`). Причина в тому, що в цій базі просто немає українського
текст-пошукового конфігу, здатного звести обидва до однієї леми:

```sql
SELECT count(*) FROM pg_ts_config;  -- 29
```

`\dF` показує всі 29 — серед них є `russian` (та ще 27 інших мов), але
**немає `ukrainian`**. Підмінити `'simple'` на `'russian'` для українського
тексту — не фікс: `russian`-словник stem'ить за правилами російської
морфології, і на українських словах (інша система відмінкових закінчень)
дасть спотворені або взагалі невірні леми — це не рішення проблеми, а її
маскування іншою, теж неправильною поведінкою. Чесний варіант — окремий
`ukrainian`-словник (snowball/ispell, підключається розширенням, якого в
стандартній поставці Postgres нема) або пошуковий рушій над Postgres, який
уже вміє українську морфологію з коробки — це і є межа, де "просто додати
пошук" у Postgres закінчується.

## Довідково: ціна generated tsvector-колонки

```
pg_total_relation_size('products') = 78 MB, з них pg_relation_size (сам heap) = 70 MB
```

Для 120 000 рядків із короткими name/description це відчутно більше, ніж
була б таблиця без `search_vector`: збережена (`STORED`) tsvector-колонка
займає місце в кожному рядку heap'а нарівні з іншими колонками, і кожен
`INSERT`/`UPDATE` тепер додатково рахує `to_tsvector()`. Ціна виправдана
тим, що взамін GIN-індекс будується миттєво (без окремого проходу
`UPDATE ... SET search_vector = ...` по всій таблиці) і колонку не потрібно
підтримувати вручну — жодного ризику розсинхронізації з `name`/`description`.
