SELECT id, status, total, currency, created_at FROM orders WHERE buyer_id = 'a0000000-0000-4000-8000-000000000001' AND created_at BETWEEN '2025-01-01' AND '2026-01-01' ORDER BY created_at DESC
