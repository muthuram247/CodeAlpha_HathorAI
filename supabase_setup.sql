-- HATHOR AI — run this entire file in Supabase Dashboard → SQL Editor.
-- The music API writes rows using a server-only service-role key after verifying
-- the current user's Supabase access token. Browser sessions can only read/delete
-- their own rows. Never put the service-role key in config.js.

create extension if not exists pgcrypto;

create table if not exists public.generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  prompt text not null,
  genre text not null,
  mood text not null,
  instruments text[] not null default '{}',
  duration_seconds integer not null check (duration_seconds between 8 and 30),
  tempo integer not null check (tempo between 40 and 200),
  audio_path text not null,
  created_at timestamptz not null default now()
);

create index if not exists generations_user_created_idx
  on public.generations (user_id, created_at desc);

alter table public.generations enable row level security;
revoke all on table public.generations from anon, authenticated;
grant select, delete on table public.generations to authenticated;

drop policy if exists "Users can read their own music history" on public.generations;
create policy "Users can read their own music history"
  on public.generations for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own music history" on public.generations;
create policy "Users can delete their own music history"
  on public.generations for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Create a PRIVATE Storage bucket for generated MP3s.
-- Files are stored under {supabase-user-uuid}/{random-file-name}.mp3.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('hathor-audio', 'hathor-audio', false, 52428800, array['audio/mpeg'])
on conflict (id) do update set
  public = false,
  file_size_limit = 52428800,
  allowed_mime_types = array['audio/mpeg'];

-- No browser write policy is needed: the server uploads with the private service-role
-- key, and the app supplies short-lived signed links after verifying the current user.
-- Keep service-role credentials in Render → Environment, never in GitHub.
