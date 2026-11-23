-- First Dibs: run this AFTER the scrape function is deployed.
-- Replace the two placeholders first:
--   YOUR-PROJECT-REF  the part of your Project URL before .supabase.co
--   YOUR-CRON-SECRET  the same value you saved as the CRON_SECRET secret

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('first-dibs-scrape') where exists (select 1 from cron.job where jobname = 'first-dibs-scrape');

select cron.schedule(
  'first-dibs-scrape',
  '*/15 * * * *',            -- every 15 minutes
  $$
  select net.http_post(
    url := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/scrape',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'YOUR-CRON-SECRET'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- To check it's running:  select * from cron.job_run_details order by start_time desc limit 5;
-- To stop it:             select cron.unschedule('first-dibs-scrape');
