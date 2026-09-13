-- Realistic-volume seed for hw-12. Skewed distributions (not 33/33/33),
-- Ukrainian product text so the FTS part of the assignment has something to
-- search. random() means re-running this gives different numbers each time
-- (expected — see hw-12 hints), but row counts and the skew shape stay the
-- same.

-- Anchor buyer with a fixed UUID, used by db/queries/q1.sql. Everything
-- else in this file uses gen_random_uuid() (fresh id on every reseed), so
-- a query that hardcodes a literal buyer_id needs at least one row whose id
-- doesn't change between reseeds — otherwise a fresh `docker compose down
-- -v` + reseed would silently zero out q1's result set.
INSERT INTO users (id, email, display_name, created_at) VALUES
    ('a0000000-0000-4000-8000-000000000001', 'demo.buyer@example.com', 'Демо Покупець', now() - interval '250 days');

-- 1. Users (buyers and sellers alike — this domain doesn't split the role).
INSERT INTO users (email, display_name, created_at)
SELECT
    'user' || i || '@example.com',
    'Користувач ' || i,
    now() - (random() * interval '365 days')
FROM generate_series(1, 50000) AS s (i);

-- rn is assigned in a randomized order (ORDER BY random(), evaluated once
-- here), so downstream FK picks below don't need a fresh random() call per
-- row: a deterministic function of the row's own generate_series index is
-- enough, and — unlike random() inside a join condition — it doesn't risk
-- Postgres materializing the inner side and reusing one cached row for
-- every outer row (that trap is easy to fall into here).
CREATE TEMP TABLE tmp_users AS
SELECT id, row_number() OVER (ORDER BY random()) AS rn FROM users;
CREATE UNIQUE INDEX ON tmp_users (rn);

-- 2. Products. Name/description built from fixed Ukrainian word lists so the
-- catalog reads like a real marketplace instead of "Product 1", "Product 2".
-- Every 40th row is forced to "Шкіряні кросівки" (2.5% of the catalog) —
-- that's the phrase q4.sql searches for. Every 53rd row's description gets
-- the genitive plural "кросівок" instead, for the "Морфологія" comparison
-- in OPTIMIZATIONS.md (a disjoint-ish ~1.9% slice, on purpose: 'simple' FTS
-- config does not stem, so these two word forms are different lexemes).
INSERT INTO products (seller_id, name, description, price, currency, status, created_at)
SELECT
    u.id,
    CASE
        WHEN s.i % 40 = 0 THEN 'Шкіряні кросівки'
        ELSE
            (ARRAY['Стильні', 'Зручні', 'Легкі', 'Теплі', 'Водостійкі', 'Класичні',
                   'Спортивні', 'Універсальні', 'Якісні', 'Практичні', 'Елегантні',
                   'Міцні', 'Компактні', 'Сучасні', 'Преміальні', 'Повсякденні',
                   'Яскраві', 'Мінімалістичні', 'Функціональні', 'Надійні',
                   'Дихаючі', 'Вологостійкі', 'Багатофункціональні', 'Витончені']
            )[1 + (s.i % 24)]
            || ' ' ||
            (ARRAY['кросівки', 'черевики', 'сумка', 'рюкзак', 'светр', 'куртка',
                   'сукня', 'футболка', 'джинси', 'шапка', 'шарф', 'ремінь',
                   'годинник', 'навушники', 'ноутбук', 'смартфон', 'валіза',
                   'парасоля', 'окуляри', 'портфель', 'кеди', 'сандалі']
            )[1 + ((s.i * 7) % 22)]
    END,
    'Виготовлено з ' ||
        (ARRAY['натуральної шкіри', 'бавовни', 'вовни', 'поліестеру', 'нейлону',
               'замші', 'денім-тканини', 'переробленого пластику', 'металу', 'текстилю']
        )[1 + ((s.i * 3) % 10)] ||
        '. Підходить для щоденного використання та активного відпочинку.' ||
        CASE WHEN s.i % 53 = 0
            THEN ' У нашому магазині великий вибір кросівок на будь-яку погоду.'
            ELSE ''
        END,
    round((10 + random() * 490)::numeric, 2),
    CASE WHEN random() < 0.9 THEN 'UAH' ELSE 'USD' END,
    CASE WHEN random() < 0.92 THEN 'active' ELSE 'archived' END,
    now() - (random() * interval '400 days')
FROM generate_series(1, 120000) AS s (i)
JOIN tmp_users u ON u.rn = 1 + ((s.i::bigint * 48271 + 7) % 50000);

CREATE TEMP TABLE tmp_products AS
SELECT id, price, row_number() OVER (ORDER BY random()) AS rn FROM products;
CREATE UNIQUE INDEX ON tmp_products (rn);

-- 3. Orders (the "main" high-volume table). Status is skewed the way a real
-- store looks: most orders complete, a minority stay pending, a small tail
-- gets cancelled. total starts at 0 and is filled in from order_items below.
INSERT INTO orders (buyer_id, status, total, currency, created_at)
SELECT
    u.id,
    -- ~65% paid, ~30% pending, ~5% cancelled (two independent draws
    -- compound, but the skew — most orders complete, cancellations are the
    -- tail — is exactly what a real store looks like).
    CASE
        WHEN random() < 0.65 THEN 'paid'
        WHEN random() < 0.85 THEN 'pending'
        ELSE 'cancelled'
    END,
    0,
    CASE WHEN random() < 0.9 THEN 'UAH' ELSE 'USD' END,
    now() - (random() * interval '400 days')
FROM generate_series(1, 150000) AS s (i)
JOIN tmp_users u ON u.rn = 1 + ((s.i::bigint * 48271 + 23) % 50000);

-- Anchor orders for the anchor buyer above: three inside the period
-- db/queries/q1.sql filters on (2025-01-01..2026-01-01), one deliberately
-- outside it, so the query demonstrates the period filter actually
-- excluding a row, not just the buyer_id filter.
INSERT INTO orders (id, buyer_id, status, total, currency, created_at) VALUES
    ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'paid', 0, 'UAH', '2025-03-10'),
    ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'pending', 0, 'UAH', '2025-07-22'),
    ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'paid', 0, 'UAH', '2025-11-05'),
    ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'paid', 0, 'UAH', '2024-06-01');

CREATE TEMP TABLE tmp_orders AS
SELECT id, row_number() OVER (ORDER BY random()) AS rn FROM orders;
CREATE UNIQUE INDEX ON tmp_orders (rn);

-- 4. Order items — 1-3 lines per order on average (~350k rows for 150k
-- orders). unit_price is copied from the product's current price (a
-- snapshot at purchase time, same idea as in db/schema.sql's comment).
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT
    o.id,
    p.id,
    1 + floor(random() * 3)::int,
    p.price
FROM generate_series(1, 350000) AS s (i)
JOIN tmp_orders o ON o.rn = 1 + ((s.i::bigint * 48271 + 11) % 150000)
JOIN tmp_products p ON p.rn = 1 + ((s.i::bigint * 48271 + 97) % 120000);

-- One line item per anchor order, so their totals aren't left at 0.
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o.id, (SELECT id FROM products LIMIT 1), 1, (SELECT price FROM products LIMIT 1)
FROM (VALUES
    ('b0000000-0000-4000-8000-000000000001'::uuid),
    ('b0000000-0000-4000-8000-000000000002'::uuid),
    ('b0000000-0000-4000-8000-000000000003'::uuid),
    ('b0000000-0000-4000-8000-000000000004'::uuid)
) AS o (id);

-- Backfill orders.total from its actual line items instead of leaving it a
-- random, inconsistent number.
UPDATE orders o
SET total = oi.sum_total
FROM (
    SELECT order_id, sum(quantity * unit_price) AS sum_total
    FROM order_items
    GROUP BY order_id
) oi
WHERE oi.order_id = o.id;

DROP TABLE tmp_users, tmp_products, tmp_orders;

-- ANALYZE alone is not enough here: it gives the planner fresh statistics,
-- but only VACUUM updates the visibility map, which Index Only Scan needs
-- to avoid heap fetches. See hw-12 hints / OPTIMIZATIONS.md.
VACUUM (ANALYZE);
