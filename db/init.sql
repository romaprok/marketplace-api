-- Sets the starting password for local dev; must match
-- secrets/db_password.example so `docker compose down -v` + a fresh `up`
-- stays in sync with `cp secrets/db_password.example secrets/db_password`.
ALTER ROLE marketplace WITH PASSWORD 'dev_local_only_changeme';

GRANT ALL PRIVILEGES ON DATABASE marketplace TO marketplace;
