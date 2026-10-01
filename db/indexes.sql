-- Minimal index set: exactly one index per slow query (q1-q4), nothing
-- "just in case" — every index here is expected to show idx_scan > 0 after
-- running db/queries/*.sql through EXPLAIN ANALYZE.

-- q1: search orders by owner (buyer) + period. Plain composite btree — the
-- most selective column (buyer_id) leads, created_at narrows within it.
CREATE INDEX idx_orders_buyer_created_at ON orders (buyer_id, created_at);

-- q2: filter by status = 'pending', most recent first. 'pending' is a
-- minority status (~30% of orders — see OPTIMIZATIONS.md), so a partial
-- index scoped to just that status is both smaller than a full index and
-- lets the planner skip the sort entirely (it walks the index already in
-- created_at order instead of scanning + sorting matching rows).
CREATE INDEX idx_orders_pending_created_at ON orders (created_at) WHERE status = 'pending';

-- q3: case-insensitive email lookup. The query filters on lower(email), not
-- email — the existing UNIQUE index on users.email (case-sensitive) can't
-- serve this, so it needs its own expression index.
CREATE INDEX idx_users_email_lower ON users (lower(email));

-- q4: full-text search over the catalog. GIN over the generated tsvector
-- column from db/schema.sql.
CREATE INDEX idx_products_search_vector ON products USING GIN (search_vector);
