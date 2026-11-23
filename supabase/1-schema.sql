-- First Dibs: run this once in Supabase > SQL Editor.

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  full_name text not null default '',
  cv_text text not null default '',
  cv_name text not null default '',
  notes text not null default '',
  sectors int[] not null default '{}',     -- Find an apprenticeship job categories, 1 to 15
  levels int[] not null default '{}',      -- 2 to 7; empty means any
  location text not null default '',       -- town or postcode; empty means all of England
  distance int not null default 20,        -- miles
  keywords text not null default '',       -- comma separated; empty means no keyword filter
  email_alerts boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.listings (
  id text primary key,
  source text, title text, employer text, location text,
  level int, course text, wage text, closes date, posted date,
  url text, description text not null default '',
  first_seen timestamptz not null default now()
);

create table if not exists public.matches (
  user_id uuid not null references auth.users on delete cascade,
  listing_id text not null references public.listings on delete cascade,
  sector int,
  status text not null default 'new',      -- new, seen, shortlisted, applied, interview, offer, closed, hidden
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  primary key (user_id, listing_id)
);
create index if not exists matches_user_created on public.matches (user_id, created_at desc);

create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null, url text not null,
  enabled boolean not null default true,
  baselined boolean not null default false,
  last_checked timestamptz, last_count int, last_error text,
  created_at timestamptz not null default now()
);

create table if not exists public.site_links (
  site_id uuid not null references public.sites on delete cascade,
  url text not null,
  primary key (site_id, url)
);

create table if not exists public.status (
  id int primary key default 1,
  last_run timestamptz, found int, fresh int, error text
);
insert into public.status (id) values (1) on conflict do nothing;

-- Each person sees only their own data.
alter table public.profiles   enable row level security;
alter table public.listings   enable row level security;
alter table public.matches    enable row level security;
alter table public.sites      enable row level security;
alter table public.site_links enable row level security;   -- no policies: scraper only
alter table public.status     enable row level security;

drop policy if exists "own profile read"   on public.profiles;
drop policy if exists "own profile insert" on public.profiles;
drop policy if exists "own profile update" on public.profiles;
create policy "own profile read"   on public.profiles for select to authenticated using (id = auth.uid());
create policy "own profile insert" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "own profile update" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "signed-in read listings" on public.listings;
create policy "signed-in read listings" on public.listings for select to authenticated using (true);

drop policy if exists "own matches read"   on public.matches;
drop policy if exists "own matches update" on public.matches;
create policy "own matches read"   on public.matches for select to authenticated using (user_id = auth.uid());
create policy "own matches update" on public.matches for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own sites" on public.sites;
create policy "own sites" on public.sites for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "signed-in read status" on public.status;
create policy "signed-in read status" on public.status for select to authenticated using (true);

grant select, insert, update on public.profiles to authenticated;
grant select on public.listings to authenticated;
grant select, update on public.matches to authenticated;
grant select, insert, update, delete on public.sites to authenticated;
grant select on public.status to authenticated;

-- Create a profile row whenever someone signs up.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
