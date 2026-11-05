import type { MigrationInterface, QueryRunner } from 'typeorm';

// hw-24: who the user is (password), what they may do (role), and the
// refresh-token families that keep them logged in.
export class AddAuth1789600000000 implements MigrationInterface {
  name = 'AddAuth1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD "role" character varying NOT NULL DEFAULT 'buyer'`);
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "CHK_users_role" CHECK ("role" IN ('buyer', 'seller', 'admin'))`,
    );
    // NULL: the account has no password and can't log in (rows from earlier hws)
    await queryRunner.query(`ALTER TABLE "users" ADD "password_hash" text`);

    // Only the HMAC of the token is stored, so a dump of this table is not a
    // dump of live sessions.
    await queryRunner.query(`CREATE TABLE "refresh_tokens" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "user_id" uuid NOT NULL,
      "family_id" uuid NOT NULL,
      "token_hash" character(64) NOT NULL,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
      "used_at" TIMESTAMP WITH TIME ZONE,
      "revoked_at" TIMESTAMP WITH TIME ZONE,
      CONSTRAINT "PK_refresh_tokens" PRIMARY KEY ("id"),
      CONSTRAINT "FK_refresh_tokens_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    )`);
    // every refresh looks a token up by its hash
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_refresh_tokens_hash" ON "refresh_tokens" ("token_hash")`);
    // reuse detection and logout revoke a whole family
    await queryRunner.query(`CREATE INDEX "IDX_refresh_tokens_family" ON "refresh_tokens" ("family_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "password_hash"`);
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "CHK_users_role"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "role"`);
  }
}
