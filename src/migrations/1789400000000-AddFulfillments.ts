import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFulfillments1789400000000 implements MigrationInterface {
  name = 'AddFulfillments1789400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "fulfillments" ("order_id" uuid NOT NULL, "event_id" character varying NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_fulfillments_order_id" PRIMARY KEY ("order_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "fulfillments" ADD CONSTRAINT "FK_fulfillments_order_id" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "fulfillments" DROP CONSTRAINT "FK_fulfillments_order_id"`);
    await queryRunner.query(`DROP TABLE "fulfillments"`);
  }
}
