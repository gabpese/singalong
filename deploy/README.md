# Free hosting (Oracle Cloud) with HTTPS

**English** · [Português (Brasil)](README.pt-BR.md)

The goal: open Singalong from **any computer** (for example, the TV at a friend's house), **without your PC being on**. How the pieces fit and what each setting does: [infrastructure](../docs/infrastructure.md).

## What runs in the cloud and what stays at home

| | Where | Why |
|---|---|---|
| API, Rooms, Queue, TV, phones, Score, backing vocals, MP4s already made | **cloud VM** | It is light and has to be always up. |
| **New songs** (download from YouTube, separate the voice, align the lyrics) | **the Owner's computer** (the installable app) | It is heavy on the CPU, and YouTube blocks datacenter IPs ("Sign in to confirm you're not a bot"). |

A Room created from the installable app sends its new songs to that Owner's computer, which prepares them and plays them straight from there. The cloud plays the songs it has: the ones copied with `sync-library.sh` and, in [Hybrid mode](#hybrid-mode-songs-in-the-cloud-optional), the ones the Owners' computers send on their own.

> **Copyright.** The repository is **public**: the songs (`storage/`) never go into it or into the image. They go by SSH straight
> to **your** VM. Share the VM's address only with whom you want.

## How to spend nothing (read before clicking)

A new Oracle account starts on a **Free Trial** (credits for 30 days) and is **not upgraded to paid on its own**: according to the
[official documentation](https://docs.oracle.com/iaas/Content/FreeTier/freetier.htm), the card is charged only if **you** do the *Upgrade*.
After the trial, what is **Always Free** keeps working; the rest is turned off. Rules:

1. **Never click "Upgrade"** (the yellow notice at the top of the console).
2. **Only create resources with the "Always Free-eligible" badge** (the creation screen shows it). No badge, no creating.
3. **A VM of at most 2 OCPUs and 12 GB** (Ampere A1). Above the free limit, VMs are **turned off** and deleted after 30 days.
4. **Do not create:** a NAT Gateway, a Load Balancer, extra volumes (the VM's disk plus the extras add up to at most 200 GB), a database, or a **reserved IP**.
5. **An alert budget (recommended):** *Billing & Cost Management → Budgets → Create budget*, amount US$ 1, alert at 1%. It only **warns** by e-mail (it does not block),
   but it reveals any charge at the first cent.
6. **Sign in to the console at least once every 60 days**: unused free accounts can be turned off, and VMs idle for a long time reclaimed.

## Step by step

### 1. The Oracle account and VM (you do it; ~20 min)
1. Create the account at <https://www.oracle.com/cloud/free/>. It asks for a **card** only to verify your identity; Always Free charges nothing.
2. Pick the **region** closest to you (e.g. São Paulo or Vinhedo). It cannot be changed later.
3. In *Compute → Instances → Create instance*:
   - **Image:** Canonical **Ubuntu 24.04**.
   - **Shape:** `VM.Standard.A1.Flex` (ARM) with **2 OCPUs and 12 GB** (the current free limit). If *Out of capacity* shows, try again later or another
     availability domain; as an alternative, `VM.Standard.E2.1.Micro` (AMD, 1 GB), which also serves the API.
   - **SSH key:** let Oracle generate it and **download the private key** (`.key`/`.pem`). Keep it safe.
4. Once it is created, note the **public IP** (the one the VM gets on its own, the "ephemeral" one: it is free and lasts as long as the VM exists, even across stops and starts).
   **Do not reserve an IP** (*Reserved public IPs*): sources say a reserved IP can be charged. If you recreate the VM, the IP changes and updating DuckDNS is enough.
5. Open the ports: *Networking → Virtual cloud networks → your VCN → Subnet → Security List → Add Ingress Rules*:
   source `0.0.0.0/0`, protocol TCP, ports **80** and **443**.

### 2. A free address with HTTPS (you do it; 2 min)
HTTPS is **required**: without it the browser allows neither the key change nor the microphone.
1. Go to <https://www.duckdns.org> (log in with GitHub/Google), create a subdomain (`singalong`) and point it to the VM's **public IP**.
2. Your address will be `singalong.duckdns.org`. Caddy gets the certificate (Let's Encrypt) on its own.

### 3. Prepare the VM (1 command)
On your PC, in Git Bash (adjust the key's path and the IP):

```bash
ssh -i ~/Downloads/ssh-key.key ubuntu@VM_IP
# already inside the VM:
curl -fsSL https://raw.githubusercontent.com/gabpese/singalong/main/deploy/setup-vm.sh | bash
nano /opt/singalong/.env        # change SITE_ADDRESS to your DuckDNS address
exit                            # leave and SSH in again (so the docker group takes effect)
```

### 4. Copy the song library (from your PC to the VM)
At the project's root, in Git Bash:

```bash
deploy/sync-library.sh ubuntu@VM_IP ~/Downloads/ssh-key.key
```

### 5. Publish the API
GitHub Actions builds the image (the **Actions → Deploy** tab, after CI passes on `main`). First make the package public
(the image has no songs or secrets): GitHub → your profile → **Packages → singalong-api → Package settings → Change visibility → Public**.

Then, on the VM:

```bash
cd /opt/singalong && ./deploy.sh
```

Open `https://YOUR_ADDRESS.duckdns.org`: create a Room and open the TV.

### 6. Automatic deploy on every merge to `main` (optional)
On GitHub: **Settings → Secrets and variables → Actions**:
- *Secrets:* `DEPLOY_HOST` (the VM's IP), `DEPLOY_USER` (`ubuntu`), `DEPLOY_SSH_KEY` (the private key's **content**, including the `BEGIN/END` lines).
- *Variables:* `DEPLOY_ENABLED` = `true`.

From then on, every merge to `main` with a green CI publishes the image and updates the VM on its own.

## Maintenance

- Logs: `cd /opt/singalong && docker compose -f docker-compose.prod.yml logs -f api`
- Restart: `docker compose -f docker-compose.prod.yml restart`
- Update by hand: `./deploy.sh`. It pulls a new API image, not the files in `/opt/singalong`: when a change touches `deploy.sh`, `docker-compose.prod.yml` or the `Caddyfile`, [download it again](../docs/infrastructure.md#the-files-on-the-vm) first.
- Rooms and the Queue live in the `api-data` volume; the certificates in `caddy-data` (do not delete it).
- Oracle can reclaim free VMs that sit **idle** for a long time; occasional use is usually enough. If it is removed, recreate it and repeat steps 3 to 5.

## Pairing by e-mail (optional)

So that each person asks for the code in their own app (instead of you generating it with `curl`), the server sends the code by e-mail only to those you authorize.

1. Create a free account at <https://www.brevo.com> (300 e-mails a day on the free plan).
2. In *Senders, Domains & Dedicated IPs → Senders*, add the **sender e-mail** (it can be your Gmail) and confirm it through the link Brevo sends to it.
3. In *SMTP & API → API keys*, create a key and copy it (it shows only once).
4. On the VM, edit `.env` (`nano /opt/singalong/.env`) and fill in, with no spaces around the `=`:

   ```
   PAIR_ALLOWED_EMAILS=ana@example.com,bia@example.com
   BREVO_API_KEY=the-copied-key
   MAIL_FROM=the-verified-sender@gmail.com
   ```
   Use `PAIR_ALLOWED_EMAILS=*` (an asterisk) to allow **any** e-mail; it is still limited to a few requests per IP and per address.
5. Apply it: `./deploy.sh`. To authorize more people later, edit `PAIR_ALLOWED_EMAILS` and run `./deploy.sh` again.

The Brevo key is a secret: it stays only in the VM's `.env` (never in the repository or in a chat). The messages may land in the spam folder the first time.

## Hybrid mode: songs in the cloud (optional)

So that the songs certain people prepare also exist on the server (and any Room plays them without downloading them again):

1. The person installs the app and pairs **by e-mail** (the connect screen asks for the e-mail and sends the code).
2. On the VM, edit `.env` (`nano /opt/singalong/.env`) and list the e-mails that send to the cloud, separated by commas:

   ```
   ENABLED_TO_SEND_TO_CLOUD=ana@example.com,bia@example.com
   ```
3. Apply it: `./deploy.sh`. If the VM's `docker-compose.prod.yml` is old, copy the new one from this repository first (it passes this variable on).

A computer paired without an e-mail (before Hybrid mode existed, or with an administrator code that names no e-mail) has to pair again by e-mail: the e-mail it paired with is what decides whether it sends. The library the computer already had goes up on its own the next time the app starts the Session. The songs live in `storage/cache` in the API's volume; the automatic cleanup (`CACHE_MAX_GB`) deletes the least played ones when it passes the limit.

## The administrator's page

There is no fixed `/admin` (it is the first path an attacker tries). The page lives at a **secret address only you know**, set in the VM's `.env`:

```bash
# generate a random address and save it in .env (do not paste the result in any chat):
echo "ADMIN_PATH=$(openssl rand -hex 16)" >> /opt/singalong/.env
cd /opt/singalong && ./deploy.sh
grep ADMIN_PATH .env        # the value is your address: https://YOUR_ADDRESS/<value>/
```

Without `ADMIN_PATH` (or with fewer than 16 characters) and without `ADMIN_TOKEN`, the page does not exist and any attempt to guess the address gets a 404. When it opens, the page asks for the `ADMIN_TOKEN`, which stays only in that browser tab. There you:

- **authorize e-mails**: who gets the pairing code and who sends songs to the cloud (it takes effect at once, without `deploy.sh`);
- **see and disconnect the paired computers**;
- **remove songs from the cloud** (they stay blocked: no computer sends them again until you allow it).

Keep the address and the token to yourself (in a password manager) and always use `https`. To change the address, change `ADMIN_PATH` and run `./deploy.sh`.

## The app's version and the update message

The administrator's page has the **Versão do app** card: there you publish the **latest version**, the **minimum version**, the **message** (what changed) and the **download address**, and it takes effect **at once**, without editing `.env` or running `./deploy.sh`.

- Whoever is **below the latest** sees "Há uma versão nova" in the app, with the message and the "Atualizar agora" button.
- Whoever is **below the minimum** sees "Atualização necessária" and **stops getting work** from the server until they update.
- The web's home page shows the latest version and the download button with the published address.
- The card shows where the values in effect come from (**publicada aqui** or **vem do .env**), a preview of the notices and how many computers are up to date. The computers table shows **each one's version** and whether it is up to date (the version is the one the app reported in its last heartbeat).
- **Voltar ao .env** deletes what was published there, and `APP_LATEST_VERSION`, `APP_MIN_VERSION`, `APP_NOTES` and `APP_DOWNLOAD_URL` take effect again. With nothing published on the page, `.env` keeps applying as before.
- The message is plain text (up to 500 characters) and the address has to start with `http://` or `https://`.

## Security

- The API has no login: whoever knows the address and a Room's code gets in. Do not spread the address.
- Only Caddy (80/443) is exposed; the API and Redis are internal.
- To lock it down further, you can put **Cloudflare Access** or a user and password in Caddy (`basicauth`) in front. It is not on by default, because it gets in the way of the TV of whoever just wants to open the link.
