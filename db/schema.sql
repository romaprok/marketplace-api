-- Marketplace API — data layer schema (hw-12).
-- Applies cleanly to an empty database: psql -f db/schema.sql

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
    currency TEXT NOT NULL DEFAULT 'UAH' CHECK (currency IN ('UAH', 'USD', 'EUR')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Generated column: recomputed automatically on INSERT/UPDATE, nothing to
    -- maintain by hand. 'simple' config on purpose — see OPTIMIZATIONS.md
    -- "Морфологія" for why a stemming config was not used instead.
    search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', name || ' ' || description)
    ) STORED
);

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
    total NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (total >= 0),
    currency TEXT NOT NULL DEFAULT 'UAH' CHECK (currency IN ('UAH', 'USD', 'EUR')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    -- Price at the moment of purchase — never re-read from products.price,
    -- which can change after the order was placed.
    unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0)
);

-- No indexes on seller_id / order_id / product_id here on purpose: none of
-- q1-q4 touch them, and an index nothing ever scans is a dead index (see
-- the "Жоден твій індекс не лишився мертвим" check in db/OPTIMIZATIONS.md).
-- db/indexes.sql holds exactly the four indexes that q1-q4 actually use.
