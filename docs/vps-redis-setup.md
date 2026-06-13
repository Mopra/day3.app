# VPS Redis setup for Day3 (BullMQ queue)

A runbook for the agent on the VPS. Goal: a single Redis instance, reachable
**from Vercel over the public internet**, secured with **TLS + an ACL password**
(`rediss://…`), and tuned so **BullMQ never loses jobs**. No IP allowlisting —
Vercel functions don't have stable egress IPs, so TLS + a strong password is the
security boundary.

Assumptions: Ubuntu 22.04/24.04 (or Debian 12) VPS, root/sudo, and a **DNS
hostname pointing at this VPS** (e.g. `redis.day3.app` → the VPS public IP). The
hostname matters: with a real hostname we get a publicly-trusted Let's Encrypt
cert and the client needs zero extra TLS config. (A self-signed fallback is in
the appendix.)

Outcome you hand back to the app: one line —
`REDIS_URL=rediss://day3:<PASSWORD>@redis.day3.app:6379`

---

## 0. Variables (set these first)

```bash
REDIS_HOST="redis.day3.app"          # the DNS name pointing at this VPS
ACL_USER="day3"
ACL_PASS="$(openssl rand -hex 32)"   # strong random password — SAVE THIS
echo "ACL password: $ACL_PASS"       # copy it now; you'll need it for REDIS_URL
```

Confirm DNS resolves to this box before continuing (Let's Encrypt needs it):

```bash
dig +short "$REDIS_HOST"             # must show this VPS's public IP
```

---

## 1. Install Redis (>= 7)

Use the official Redis APT repo so you get a current 7.x (Ubuntu's default is
older and may lack the ACL/TLS ergonomics):

```bash
sudo apt-get update
sudo apt-get install -y lsb-release curl gpg
curl -fsSL https://packages.redis.io/gpg | sudo gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/redis.list
sudo apt-get update
sudo apt-get install -y redis
redis-server --version               # expect 7.x
```

---

## 2. TLS certificate (Let's Encrypt)

Issue a cert for `$REDIS_HOST`. Standalone mode needs port 80 free briefly.

```bash
sudo apt-get install -y certbot
sudo certbot certonly --standalone -d "$REDIS_HOST" --non-interactive --agree-tos \
  -m admin@day3.app          # use a real email you control

# Certs land in /etc/letsencrypt/live/$REDIS_HOST/{fullchain.pem,privkey.pem}
```

Give the `redis` user access to the cert files (renewals re-create them, so we
copy into a redis-owned dir and add a renewal hook):

```bash
sudo mkdir -p /etc/redis/tls
sudo cp /etc/letsencrypt/live/"$REDIS_HOST"/fullchain.pem /etc/redis/tls/redis.crt
sudo cp /etc/letsencrypt/live/"$REDIS_HOST"/privkey.pem  /etc/redis/tls/redis.key
sudo chown -R redis:redis /etc/redis/tls
sudo chmod 600 /etc/redis/tls/redis.key

# Auto-copy on renewal + reload Redis:
sudo tee /etc/letsencrypt/renewal-hooks/deploy/redis-tls.sh >/dev/null <<EOF
#!/bin/bash
cp /etc/letsencrypt/live/$REDIS_HOST/fullchain.pem /etc/redis/tls/redis.crt
cp /etc/letsencrypt/live/$REDIS_HOST/privkey.pem  /etc/redis/tls/redis.key
chown -R redis:redis /etc/redis/tls
chmod 600 /etc/redis/tls/redis.key
systemctl restart redis-server
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/redis-tls.sh
```

---

## 3. Configure Redis

Write a drop-in config. Key choices, and why:

- **`port 0`** — disable the plaintext port entirely; only TLS is exposed.
- **`tls-port 6379`** — serve TLS on the standard port (so the URL is clean).
- **`tls-auth-clients no`** — clients authenticate with the ACL password over
  TLS; they do **not** present a client certificate. Without this, Redis would
  demand mutual-TLS and reject Vercel.
- **`maxmemory-policy noeviction`** — **critical for BullMQ.** A queue must never
  have its keys evicted under memory pressure; `noeviction` makes Redis refuse
  writes instead of silently dropping job data.
- **`appendonly yes`** — persist the queue across restarts.
- **`requirepass` is intentionally omitted** — we use ACL users instead (below).

```bash
sudo tee /etc/redis/redis.conf.d/day3.conf >/dev/null <<'EOF'
# --- Day3 BullMQ Redis ---
bind 0.0.0.0 -::*
protected-mode yes

# TLS only
port 0
tls-port 6379
tls-cert-file /etc/redis/tls/redis.crt
tls-key-file  /etc/redis/tls/redis.key
tls-auth-clients no

# Queue durability
appendonly yes
maxmemory-policy noeviction
# Optional: cap memory (leave headroom for the OS). Example for a 2GB box:
# maxmemory 1500mb

# Disable the default user; all access goes through the ACL user below.
user default off
EOF
```

Make sure `redis.conf` includes the drop-in (the Redis package's main config is
`/etc/redis/redis.conf`):

```bash
grep -q 'include /etc/redis/redis.conf.d/\*.conf' /etc/redis/redis.conf \
  || echo 'include /etc/redis/redis.conf.d/*.conf' | sudo tee -a /etc/redis/redis.conf
```

---

## 4. Create the ACL user

Add the app user with the password from step 0. `allkeys allcommands` gives
BullMQ everything it needs; tighten later if you split queues per app.

```bash
sudo tee /etc/redis/users.acl >/dev/null <<EOF
user $ACL_USER on >$ACL_PASS ~* &* +@all
EOF
sudo chown redis:redis /etc/redis/users.acl
sudo chmod 600 /etc/redis/users.acl

# Point Redis at the ACL file:
echo "aclfile /etc/redis/users.acl" | sudo tee -a /etc/redis/redis.conf.d/day3.conf
```

> Note: `aclfile` and inline `user` directives can't both define users in the
> main config; we keep the app user in `users.acl` and only `user default off`
> inline. If Redis complains, move `user default off` into `users.acl` as
> `user default off nopass ~* &* -@all`.

---

## 5. Firewall + start

Open the TLS port to the world (TLS + ACL is the guard). Keep SSH open.

```bash
sudo ufw allow 22/tcp
sudo ufw allow 6379/tcp
sudo ufw --force enable

sudo systemctl enable redis-server
sudo systemctl restart redis-server
sudo systemctl status redis-server --no-pager | head -15
```

---

## 6. Verify

Locally on the VPS (TLS, with the Let's Encrypt CA the system already trusts):

```bash
redis-cli --tls -h "$REDIS_HOST" -p 6379 --user "$ACL_USER" --pass "$ACL_PASS" PING
# → PONG
redis-cli --tls -h "$REDIS_HOST" -p 6379 --user "$ACL_USER" --pass "$ACL_PASS" \
  CONFIG GET maxmemory-policy
# → noeviction
```

From another machine (e.g. your laptop) prove it's reachable over the internet:

```bash
redis-cli --tls -h redis.day3.app -p 6379 --user day3 --pass '<PASSWORD>' PING
```

---

## 7. Hand back the URL

```
REDIS_URL=rediss://day3:<PASSWORD>@redis.day3.app:6379
```

Put this value in **both**:
- the **Vercel** project env (web tier — the queue *producer*), and
- the **VPS worker** `.env` (the queue *consumer*).

With a Let's Encrypt cert no extra client TLS config is needed — BullMQ/ioredis
parse `rediss://` and validate against the public CA chain automatically.

---

## How the app uses it (for reference — already in code)

The web tier (Vercel) only enqueues; the worker (this VPS) consumes. BullMQ over
ioredis:

```ts
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

// rediss:// turns on TLS automatically.
const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,   // required by BullMQ Workers
});

const queue = new Queue("day3-jobs", { connection });          // producer (Vercel)
const worker = new Worker("day3-jobs", processor, { connection }); // consumer (VPS)
```

---

## Appendix A — self-signed TLS (no DNS hostname)

If you can't point a hostname at the VPS, use a self-signed CA. The client must
then trust your CA explicitly (you'd pass the CA pem to BullMQ via
`tls: { ca }`), which is more moving parts — prefer the Let's Encrypt path.

```bash
sudo mkdir -p /etc/redis/tls && cd /etc/redis/tls
sudo openssl genrsa -out ca.key 4096
sudo openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
  -subj "/CN=Day3 Redis CA" -out ca.crt
sudo openssl genrsa -out redis.key 2048
sudo openssl req -new -key redis.key -subj "/CN=<VPS_PUBLIC_IP>" -out redis.csr
sudo openssl x509 -req -in redis.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out redis.crt -days 825 -sha256
sudo chown -R redis:redis /etc/redis/tls && sudo chmod 600 /etc/redis/tls/redis.key
```

Then download `ca.crt` to give to the app (it becomes `tls.ca` on the client),
and connect with `redis-cli --tls --cacert ca.crt ...`.

## Appendix B — Docker alternative

```bash
docker run -d --name day3-redis --restart unless-stopped \
  -p 6379:6379 \
  -v /etc/redis/tls:/tls:ro \
  -v /etc/redis/users.acl:/data/users.acl:ro \
  redis:7 \
  redis-server --port 0 --tls-port 6379 \
    --tls-cert-file /tls/redis.crt --tls-key-file /tls/redis.key \
    --tls-auth-clients no \
    --appendonly yes --maxmemory-policy noeviction \
    --aclfile /data/users.acl --user default off
```

## Security checklist

- [ ] `port 0` (no plaintext listener); only `tls-port` is open.
- [ ] `tls-auth-clients no` (password auth over TLS, not mutual-TLS).
- [ ] Strong random `ACL_PASS` (32 bytes hex); default user disabled.
- [ ] `maxmemory-policy noeviction` (BullMQ jobs are never evicted).
- [ ] `appendonly yes` (queue survives restarts).
- [ ] UFW: only 22 + 6379 open.
- [ ] Cert auto-renews (certbot deploy hook restarts Redis).
- [ ] `REDIS_URL` stored only in Vercel env + the worker `.env` (never committed).
