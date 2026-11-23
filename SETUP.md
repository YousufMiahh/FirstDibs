# First Dibs: setup guide

About 30 to 40 minutes, best done on a computer. Menu names in Supabase, Netlify and Brevo change from time to time, so if a label differs slightly, look for the closest match.

What's in this folder:

| Path | What it is |
|---|---|
| `site/` | The website. This folder goes to Netlify. |
| `site/config.js` | Two values you paste in (step 5). |
| `supabase/1-schema.sql` | Creates the database tables and privacy rules. |
| `supabase/functions/scrape/index.ts` | The scraper, matcher and email sender. |
| `supabase/2-schedule.sql` | Makes the scraper run every 15 minutes. |

## 1. Create the Supabase project

1. Sign up at supabase.com and create a new project. Save the database password somewhere.
2. Open **SQL Editor**, paste in everything from `supabase/1-schema.sql`, and press **Run**. It should say "Success".

## 2. Set up login

1. Go to **Authentication > Sign In / Providers > Email**.
2. Turn **Confirm email** off and save.

Why: Supabase's built-in mailer is heavily limited and may refuse to send confirmation emails to your friend. With confirmation off, people sign up with an email and password and are in straight away. The trade-off is that "forgot password" emails won't work until you connect your own mail service under Authentication > Emails > SMTP settings (Brevo's SMTP details work there).

## 3. Set up alert emails (Brevo)

1. Create a free account at brevo.com.
2. Under **Senders**, add the email address alerts should come from and verify it.
3. Under **SMTP & API > API keys**, create a key and copy it.

If you own a domain, Resend works too: use `RESEND_API_KEY` instead of `BREVO_API_KEY` in the next step.

## 4. Deploy the scraper

1. In Supabase, go to **Edge Functions > Deploy a new function > Via Editor**.
2. Name it exactly `scrape`. Delete the sample code, paste in everything from `supabase/functions/scrape/index.ts`, and deploy.
3. Open the function's settings and turn **Verify JWT** off. (The function does its own checking: it only accepts the scheduler's secret or a signed-in user.)
4. Go to **Edge Functions > Secrets** and add:

| Name | Value |
|---|---|
| `CRON_SECRET` | Any long random string you make up. Keep a copy for step 6. |
| `BREVO_API_KEY` | The key from step 3. |
| `MAIL_FROM` | `First Dibs <the-address-you-verified@example.com>` |
| `SITE_URL` | Your Netlify address (add it after step 5). |

## 5. Put the site on Netlify

1. In Supabase, open **Project Settings > API** (or the **Connect** button) and copy the **Project URL** and the **anon / publishable** key.
2. Open `site/config.js` in a text editor and paste both in. Never put the service role or secret key in this file.
3. Sign up at netlify.com, choose **Add new project > Deploy manually**, and drag the whole `site` folder onto the page.
4. Copy the address Netlify gives you. Save it as the `SITE_URL` secret (step 4), and in Supabase under **Authentication > URL Configuration** set it as the **Site URL**.

## 6. Switch on the schedule

1. Open `supabase/2-schedule.sql`. Replace `YOUR-PROJECT-REF` (the part of your Project URL before `.supabase.co`) and `YOUR-CRON-SECRET` (the value from step 4).
2. Paste it into **SQL Editor** and run it. If it complains about `pg_cron` or `pg_net`, enable both under **Database > Extensions** and run it again.

## 7. Try it

1. Open your Netlify address, create an account, and pick your categories, level and location in **Settings**.
2. Upload your CV in **Profile**.
3. Press **Check now** on the Board. Matches should appear within a minute, and an email should arrive.
4. Press **Apply with Claude** on a vacancy. Claude Desktop opens with everything filled in; press send.
5. Send your friend the Netlify address. They create their own account and see only their own data.

## If something doesn't work

| What you see | Likely cause |
|---|---|
| "One step left" page | `config.js` still has the placeholder values. |
| "Couldn't load your profile" | `1-schema.sql` hasn't been run, or didn't finish. |
| "The check didn't run" | The function isn't named `scrape`, or isn't deployed. |
| Check runs but "0 vacancies read" | Find an apprenticeship changed its page layout or blocked the request. Open **Edge Functions > scrape > Logs**. The parser is in `parseFaa` in `index.ts`. |
| Matches appear but no email | Check the note after "Check now"; it shows the email provider's error. Usually the sender isn't verified or `MAIL_FROM` doesn't match it. |
| Nothing happens on schedule | Run `select * from cron.job_run_details order by start_time desc limit 5;` in SQL Editor. |
| "Apply with Claude" does nothing | Claude Desktop isn't installed on that device. Use "Copy the prompt instead" or "Open in claude.ai". |
| An added site says "No links found" | That page builds its vacancy list with JavaScript, which this scraper can't read. |

## Good to know

- **England only for the main feed.** The built-in scraper reads Find an apprenticeship, which covers England. For Wales, Scotland, Northern Ireland or a particular employer, add the vacancies page under Settings > Sites it checks.
- **Added sites work differently.** The scraper remembers every link on the page and alerts you when a new one appears. On the first visit it only reports links that mention "apprentice".
- **Speed.** Checks run every 15 minutes. To change that, edit the `*/15 * * * *` line in `2-schedule.sql` and run it again.
- **Be a polite scraper.** Each check makes two page requests per distinct search. Check each site's terms of use before adding it.
- **Free-tier limits.** Supabase may pause free projects that sit unused; the 15-minute schedule should keep yours active, but check their current rules.
