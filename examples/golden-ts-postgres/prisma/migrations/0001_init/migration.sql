CREATE TYPE "user_role" AS ENUM ('admin', 'trainer', 'member');

CREATE TABLE "teams" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "deleted_at" TIMESTAMPTZ
);

CREATE TABLE "users" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" TEXT NOT NULL UNIQUE,
  "role" "user_role" NOT NULL DEFAULT 'member',
  "team_id" UUID REFERENCES "teams"("id")
);

CREATE TABLE "dogs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" TEXT NOT NULL,
  "team_id" UUID NOT NULL REFERENCES "teams"("id"),
  "owner_id" UUID REFERENCES "users"("id"),
  "deleted_at" TIMESTAMPTZ
);

CREATE TABLE "transfers" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "dog_id" UUID NOT NULL REFERENCES "dogs"("id"),
  "from_team_id" UUID NOT NULL,
  "to_team_id" UUID NOT NULL,
  "by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
