create table public.projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  owner_id uuid not null references auth.users (id),
  name text not null,
  status text not null default 'active',
  deleted_at timestamptz
);

-- Amounts are in cents.
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id),
  amount integer not null,
  constraint invoices_amount_positive check (amount > 0)
);
