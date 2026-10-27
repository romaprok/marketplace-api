import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOutboxInbox1789500000000 implements MigrationInterface {
  name = 'AddOutboxInbox1789500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Same field roles as Debezium's Outbox Event Router reads, so moving the
    // relay to CDC later doesn't touch consumers. Debezium's own defaults are
    // aggregatetype/aggregateid without underscores: with these names
    // route.by.field and table.field.event.key have to be set explicitly.
    await queryRunner.query(
      `CREATE TABLE "outbox" ("id" uuid NOT NULL, "aggregate_type" character varying NOT NULL, "aggregate_id" character varying NOT NULL, "type" character varying NOT NULL, "payload" jsonb NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "published_at" TIMESTAMP WITH TIME ZONE, "attempts" integer NOT NULL DEFAULT 0, CONSTRAINT "PK_outbox_id" PRIMARY KEY ("id"))`,
    );
    // the relay only ever looks at unpublished rows, and they're a tiny
    // fraction of the table once it has history
    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_unpublished" ON "outbox" ("created_at", "id") WHERE "published_at" IS NULL`,
    );

    await queryRunner.query(
      `CREATE TABLE "processed_messages" ("message_id" character varying NOT NULL, "consumer" character varying NOT NULL, "processed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_processed_messages" PRIMARY KEY ("message_id", "consumer"))`,
    );

    // order_id is filled in by the same transaction that claimed the key
    await queryRunner.query(
      `CREATE TABLE "idempotency_keys" ("key" character varying NOT NULL, "order_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_idempotency_keys" PRIMARY KEY ("key"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" ADD CONSTRAINT "FK_idempotency_keys_order_id" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "idempotency_keys" DROP CONSTRAINT "FK_idempotency_keys_order_id"`);
    await queryRunner.query(`DROP TABLE "idempotency_keys"`);
    await queryRunner.query(`DROP TABLE "processed_messages"`);
    await queryRunner.query(`DROP INDEX "IDX_outbox_unpublished"`);
    await queryRunner.query(`DROP TABLE "outbox"`);
  }
}
