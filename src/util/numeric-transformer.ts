import type { ValueTransformer } from 'typeorm';

// pg returns `numeric` columns as strings (avoids silent precision loss on
// the wire for values that don't fit a JS double exactly) — this transformer
// makes money columns behave like plain numbers in application code while
// the column itself stays `numeric(12,2)` in Postgres.
export const numericTransformer: ValueTransformer = {
  to: (value?: number) => value,
  from: (value?: string) => (value === null || value === undefined ? value : Number(value)),
};
