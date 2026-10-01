-- users|products|orders|order_items|sum(orders.total)
SELECT to_regclass('public.orders') IS NOT NULL AS has_orders \gset
\if :has_orders
SELECT (SELECT count(*) FROM users) || '|'
    || (SELECT count(*) FROM products) || '|'
    || (SELECT count(*) FROM orders) || '|'
    || (SELECT count(*) FROM order_items) || '|'
    || (SELECT coalesce(sum(total), 0) FROM orders);
\else
SELECT 'empty-database';
\endif
