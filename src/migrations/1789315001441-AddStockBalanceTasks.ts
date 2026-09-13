import { MigrationInterface, QueryRunner } from 'typeorm';

// Hand-trimmed: migration:generate also emitted a DROP DEFAULT/SET DEFAULT
// no-op on every table's "id" column (harmless in up(), but its down()
// reverted them to uuid_generate_v4() — a function this DB doesn't have,
// since hw-13 deliberately uses gen_random_uuid() instead; that would have
// broken migrate:revert). Removed all of that churn, kept only what
// actually changed: the tasks queue table, and stock/balance on the
// existing tables.
export class AddStockBalanceTasks1789315001441 implements MigrationInterface {
  name = 'AddStockBalanceTasks1789315001441';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "balance" numeric(12,2) NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD "stock" integer NOT NULL DEFAULT '0'`,
    );
    await queryRunner.query(
      `CREATE TABLE "tasks" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "type" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'pending', "processed" integer NOT NULL DEFAULT '0', "processed_by" character varying, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "processed_at" TIMESTAMP WITH TIME ZONE, "order_id" uuid NOT NULL, CONSTRAINT "PK_8d12ff38fcc62aaba2cab748772" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "tasks" ADD CONSTRAINT "FK_ebc795fe637f4e8c0cfcb392e59" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tasks" DROP CONSTRAINT "FK_ebc795fe637f4e8c0cfcb392e59"`);
    await queryRunner.query(`DROP TABLE "tasks"`);
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "stock"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "balance"`);
  }
}
