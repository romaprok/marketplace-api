import type { MigrationInterface, QueryRunner } from 'typeorm';

// hw-26: the list of files lives here, not in the bucket. Listing a bucket is
// paid, slow and pages by 1000 keys; "show a user's files" is a query.
export class AddFiles1789700000000 implements MigrationInterface {
  name = 'AddFiles1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "files" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "owner_id" uuid NOT NULL,
      "key" character varying NOT NULL,
      "content_type" character varying NOT NULL,
      "size" bigint NOT NULL,
      "status" character varying NOT NULL DEFAULT 'PENDING',
      "upload_id" character varying,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "completed_at" TIMESTAMP WITH TIME ZONE,
      CONSTRAINT "PK_files" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_files_key" UNIQUE ("key"),
      CONSTRAINT "CHK_files_status" CHECK ("status" IN ('PENDING', 'COMPLETED')),
      CONSTRAINT "FK_files_owner" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE
    )`);
    await queryRunner.query(`CREATE INDEX "IDX_files_owner" ON "files" ("owner_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "files"`);
  }
}
