# Deploying this site to lexleaf.in

For a static site hosted on Vercel and a domain bought at GoDaddy. Written once, in
order, so it can be followed again if anything is ever rebuilt from scratch.

The site needs no build step: Vercel serves these files as they are.

---

## Part 1 — Put the site on Vercel

1. Sign in at [vercel.com](https://vercel.com) with the GitHub account that owns the
   repository.
2. **Add New… › Project**. In the list of repositories, find this one and press
   **Import**. If it is not listed, press **Adjust GitHub App Permissions** and grant
   Vercel access to it.
3. On the configuration screen:
   - **Framework Preset**: `Other`.
   - **Root Directory**: leave as it is if this file is at the top of the repository.
     If the site sits inside a folder (for example `website`), choose that folder.
   - **Build Command**: leave empty.
   - **Output Directory**: leave empty.
   - **Install Command**: leave empty.
4. **Deploy**. After about a minute the site opens at an address like
   `lexleaf-site.vercel.app`. This address already works; the domain comes next.

Every push to the default branch now deploys automatically, and pull requests get their
own preview addresses.

## Part 2 — Build a vocabulary of the DNS terms

Two records are enough for a site. A **record** is a line in a table that tells the
internet where to find something.

| Term         | What it means here                                                                    |
| ------------ | ------------------------------------------------------------------------------------- |
| **A record** | "This name lives at this numeric address." Used for `lexleaf.in` on its own.          |
| **CNAME**    | "This name is an alias for that name." Used for `www.lexleaf.in`.                     |
| **Host**     | The name part of the record: `@` means the bare domain, `www` means `www.lexleaf.in`. |
| **Value**    | Where the record points. Copied from Vercel.                                          |
| **TTL**      | How long a resolver may keep the answer cached. Leave it at the default or one hour.  |
| **Apex**     | The bare domain, `lexleaf.in`, with no `www` in front.                                |

Why two records and not one: a CNAME is not allowed on the bare domain, so the bare
domain has to use an A record. `www` can use a CNAME, and Vercel prefers that because it
can move its own addresses without you editing anything.

## Part 3 — Tell Vercel which domain to answer for

1. In the Vercel project, open **Settings › Domains**.
2. Type `lexleaf.in` and press **Add**.
3. When Vercel asks whether to add `www.lexleaf.in` as well, say yes. It is added as a
   redirect to the bare domain, which is what most sites want.
4. Vercel now shows, on the domain's card, **the exact records to create** and marks them
   as not yet configured. Two things to copy from there:
   - the **A record value** for `@`. Many projects show `76.76.21.21`; newer projects may
     show a different address such as `216.198.79.1`;
   - the **CNAME target** for `www`, which may look like
     `d1d4fc829fe7bc7c.vercel-dns-017.com` rather than `cname.vercel-dns.com`.

Use exactly what the card shows. The values in this document are only examples.

## Part 4 — Edit the DNS records at GoDaddy

The domain's nameservers are currently `ns05.domaincontrol.com` and
`ns06.domaincontrol.com`, which means GoDaddy runs the DNS for the domain. Keep it that
way: it is the simplest arrangement, and anything else already in that table (email, a
DMARC record) keeps working untouched.

1. Go to [dcc.godaddy.com](https://dcc.godaddy.com) and sign in.
2. Next to `lexleaf.in`, press **DNS** (or **Manage DNS**).
3. Find the existing records and remove the ones that claim the site:
   - two **A** records with host `@` pointing at `15.197.148.33` and `3.33.130.190`.
     These are GoDaddy's parking addresses, which is why the domain shows an empty page
     today;
   - any **CNAME** with host `www` (it currently points at `lexleaf.in`);
   - if a **Forwarding** entry exists, delete it too. GoDaddy's forwarding and Vercel's
     redirects do the same job, and having both causes a loop.
4. Add the two records Vercel showed:

   | Type  | Name  | Value                          | TTL    |
   | ----- | ----- | ------------------------------ | ------ |
   | A     | `@`   | the address from Vercel's card | 1 hour |
   | CNAME | `www` | the target from Vercel's card  | 1 hour |

   Some GoDaddy screens spell the bare host as the domain itself, `lexleaf.in`, instead
   of `@`. Both mean the same thing. Do not add a trailing dot to the CNAME target in
   GoDaddy's form; it adds what it needs.

5. Save. The change usually takes a few minutes; it can take up to an hour because of the
   old TTL, and rarely longer.

## Part 5 — Check it worked

1. Back in **Settings › Domains** on Vercel, the card for `lexleaf.in` should move from
   "Invalid Configuration" to **Valid Configuration**. Vercel then issues a free HTTPS
   certificate by itself; no action is needed.
2. Visit `https://lexleaf.in`. It should serve the site over HTTPS. Visit
   `https://www.lexleaf.in`; it should redirect to the bare domain.
3. If the domain still shows the old page, it is DNS caching, not a mistake: check
   [dnschecker.org](https://dnschecker.org) for the A record of `lexleaf.in` and see
   whether the addresses have changed worldwide.
4. Common snags:
   - **"Invalid Configuration" and the old address still shows** — an old A record was
     left behind. Two A records for the same host split traffic between them randomly.
   - **A certificate warning** — the certificate is issued only after DNS resolves to
     Vercel. It disappears within a few minutes of the record being right.
   - **`www` redirects oddly, or too many redirects** — GoDaddy's own Forwarding is
     still on, or `www` has both a CNAME and an A record. Only the CNAME should exist.

## Part 6 — Later

- Change the site: edit, commit, push. Vercel redeploys within a minute.
- Change the domain, or move registrars: the DNS records move with it; nothing in Vercel
  changes.
- Add a second site on a subdomain, for example `docs.lexleaf.in`: add it as a domain in
  the other Vercel project, then create one CNAME at GoDaddy with host `docs` pointing at
  the target Vercel shows. The bare domain is left alone.
- Email on the domain: leave the MX records alone when editing; adding the A record for
  the website does not affect them.
