import { DataSource } from 'typeorm';
import { User } from '../../src/entities/User.js';
import { startTestPostgres, TestPostgres } from '../testkit/postgres.js';
import { aUser } from '../testkit/builders.js';

// Repository tests against a REAL postgres:16-alpine in testcontainers, not
// a mock. This is the thing a mock can never catch: the schema and the
// entity agreeing on what's actually in the database (see lecture's
// "broken repo, green test" example — the exact failure mode this guards).
describe('User repository (TypeORM) against real Postgres', () => {
  let pg: TestPostgres;
  let dataSource: DataSource;

  beforeAll(async () => {
    pg = await startTestPostgres();
    dataSource = pg.dataSource;
  }, 120000);

  afterEach(async () => {
    await pg.truncateAll();
  });

  afterAll(async () => {
    await pg.stop();
  });

  test('creates a user and reads it back by id', async () => {
    const repo = dataSource.getRepository(User);
    const saved = await repo.save(repo.create(aUser({ email: 'ada@example.test' })));

    const found = await repo.findOneBy({ id: saved.id });
    expect(found?.email).toBe('ada@example.test');
    expect(found?.displayName).toBe('Test User');
  });

  test('unknown id resolves to null, not an error', async () => {
    const repo = dataSource.getRepository(User);
    const found = await repo.findOneBy({ id: '00000000-0000-4000-8000-000000000000' });
    expect(found).toBeNull();
  });

  // The constraint case a mock can never fail: db/schema.sql (hw-12) and the
  // User entity (hw-13) both declare email UNIQUE — this is Postgres saying
  // no, not the application.
  test('duplicate email violates the unique constraint', async () => {
    const repo = dataSource.getRepository(User);
    await repo.save(repo.create(aUser({ email: 'dup@example.test' })));

    await expect(repo.save(repo.create(aUser({ email: 'dup@example.test' })))).rejects.toMatchObject({
      code: '23505',
    });
  });
});
