// What Supabase migrations expect to exist before they run. Claims come from the transaction-local
// setting `request.jwt.claims`; `nullif(..., '')` because a rolled-back local setting reads as ''.
export const SUPABASE_SHIM = `
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create extension if not exists "uuid-ossp" schema extensions;
create extension if not exists pgcrypto schema extensions;
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
grant usage on schema public, auth, storage, extensions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create function auth.jwt() returns jsonb language sql stable
  as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function auth.uid() returns uuid language sql stable
  as $$ select (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid $$;
create function auth.role() returns text language sql stable
  as $$ select nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role' $$;
create table auth.users (id uuid primary key, email text);
create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  metadata jsonb
);
`
