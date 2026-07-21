# Distill.ai Deployment Strategy: Alibaba Cloud

Deployment plan and current live state for the Distill.ai monorepo on Alibaba Cloud, built for the
Qwen Cloud hackathon. Scoped to the hackathon reality: a real Alibaba Cloud deployment by the
**July 9, 2026** deadline, lean cost, fast to stand up, co-located in **Singapore
(ap-southeast-1)** to sit next to our Qwen Cloud (Singapore) endpoint.

> **Status: LIVE on Alibaba Cloud.** Phase 1 is deployed and serving traffic. The Phase 2 SAE
> migration described below remains the forward plan and is not provisioned yet.

## Live deployment

| Item | Value |
| --- | --- |
| Public URL | <https://distill-ai.duckdns.org> |
| Health check | <https://distill-ai.duckdns.org/api/v1/health> |
| Compute | Alibaba Cloud ECS, `ecs.e-c1m2.large` (2 vCPU / 4 GB), Ubuntu 22.04 |
| Region | `ap-southeast-1` (Singapore), Zone B |
| Runtime | Full stack via `docker-compose`: api, worker, client, postgres (pgvector), redis |
| TLS | Caddy 2 terminating HTTPS with an automatic Let's Encrypt certificate |
| LLM | Qwen-Plus via Alibaba Cloud Model Studio |
| Embeddings | `text-embedding-v4`, 1024 dimensions, via Alibaba Cloud Model Studio |
| Model Studio endpoint | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (OpenAI compatible) |

Both the LLM and the embedding model are served by Alibaba Cloud Model Studio over its
OpenAI-compatible endpoint, configured through `LLM_BASE_URL` and `EMBEDDINGS_BASE_URL`
(see `src/modules/llm/llm.provider.ts` and `.env.example`).

### Hardening applied to the live box

- Only ports `80` and `443` are open to the internet. Caddy owns both.
- The raw API port is closed externally. The API is reachable only through the client proxy.
- SSH on port `22` is restricted to a single operator IP, not `0.0.0.0/0`.
- Secrets live in a `chmod 600` `.env` on the instance and are never committed.

### Verified end-to-end in production

Real RFQs were submitted through both the UI and the API against the live deployment. The
`tool_calls` audit table confirms live Qwen traffic (`extract_request` and `search_catalog`
tool calls returning `ok`), so extraction, classification, and catalog matching are genuinely
running on Model Studio in production rather than on fixtures.

## Stack being deployed

A pnpm monorepo producing two container images plus a static client:

- **API** (NestJS, `Dockerfile.api`): HTTP API, serves Server-Sent Events (SSE).
- **Worker** (same image, `node dist/worker.js`): always-on Bull/Redis queue consumer + a cron
  recovery sweep. Long-lived process, not request/response.
- **Client** (Next.js / React, `Dockerfile.client`): static-ish front end.
- **Data:** PostgreSQL + pgvector (1024-dim embeddings in a `vector(1024)` column), Redis (Bull
  queue + pub/sub for SSE).

The always-on worker and persistent SSE connections are the constraint that drives the compute
choice: this is a long-lived, multi-process, persistent-connection workload, not a serverless
function workload.

## Recommended architecture

```
GitHub (Distill-AI)  --CI/CD-->  ACR (Personal, Singapore)  --pull-->  Compute: SAE
  lint/test/Trivy                  distill/api:<sha>                      api app   --+
  build -> push                    distill/client:<sha>                   worker app--+-- same VPC --> RDS PostgreSQL (pgvector)
                                                                                      +------------> ApsaraDB Redis (Tair)
Client build  --------------------------------------------------------------------->  OSS static hosting + CDN
```

## Decision: compute target

**Chosen: SAE (Serverless App Engine), with a single ECS VM as the day-1 safety net.**

- **Phase 1 (week 1): ECS + docker-compose** for a guaranteed live demo. One VM, our existing
  `docker-compose.yml` runs unchanged, exact parity with local. Fastest path to a public URL,
  lowest risk. Covered by the free 12-month ECS trial + new-account credits.
- **Phase 2 (week 2): migrate api + worker to SAE.** SAE is a managed, Kubernetes-backed
  container PaaS that runs persistent instances, so the Bull consumer, cron sweep, and SSE all
  work as in any container. It deploys straight from Docker images with no Kubernetes YAML, and
  it both is and looks cloud-native. Best credibility per hour invested for a hackathon.

### Alternatives considered

| Option | Worker + SSE | Effort | Verdict |
|---|---|---|---|
| **SAE** | Yes (persistent instances) | Moderate, no k8s YAML | **Primary.** Cloud-native, low overhead. |
| **ECS + docker-compose** | Yes (plain VM) | Lowest | **Day-1 safety net.** Less cloud-native, single point of failure. |
| **ACK (managed k8s) / ACS** | Yes | Highest | Only if k8s-fluent or judged on it. ACK Serverless (ASK) is deprecated; use ACS for serverless k8s. |
| **Function Compute** | Forced, awkward | High | Not recommended. Always-on worker + persistent SSE fight FC's request/response model. |

## Data, storage, networking

Go managed for the databases: the free trials cover the entire hackathon window and remove a
class of "my DB container lost its volume" failures.

- **PostgreSQL: ApsaraDB RDS for PostgreSQL.** pgvector is officially supported (PG 14+; stores
  up to 16k dims, indexes up to 2k, so `vector(1024)` both stores and indexes). Enable via the
  console Extension Marketplace or `CREATE EXTENSION vector;`. Free trial: `pg.n2.2c.1m`, 30 days.
- **Redis: ApsaraDB for Redis / Tair**, standard **Master-Replica (NOT cluster)**. Two hard
  requirements for Bull:
  - set **`maxmemory-policy = noeviction`** (eviction deletes job-lock keys and corrupts the queue);
  - do not use cluster mode (Bull's multi-key Lua ops break across cluster slots).
  Free trial: 4 GB, 1 month. Use a separate connection for the SSE pub/sub subscriber.
- **Client + PDFs: OSS** static website hosting (public-read bucket) for the client build, plus an
  object bucket for generated quote PDFs (public URL, or private + signed URLs if sensitive).
  Within the OSS free quota (first 5 GB storage, first 100 GB egress free).
- **Networking:** put compute + RDS + Redis in the **same VPC and region**, connect over the
  **internal endpoints** (intra-VPC traffic is free), and whitelist the compute private IP on each
  database. **No NAT Gateway** is needed for database access; only provision one if private
  compute needs outbound internet.

## Deploy order

1. Create the VPC (Singapore) and a vSwitch.
2. Provision RDS for PostgreSQL, enable the `vector` extension, run our migrations.
3. Provision ApsaraDB for Redis (Master-Replica, `noeviction`). Whitelist the compute private IP.
4. Create the ACR namespace + repos; build and push the images.
5. **Phase 1:** ECS VM, install Docker, `docker compose up -d` pointing at the managed DB + Redis
   internal endpoints. Open the API port via security group; put Nginx or an ALB in front for TLS.
6. **Phase 2:** create two SAE apps (api, worker) from the ACR images, set env vars and health
   checks, point at the same DB + Redis. Front with an ALB for TLS and clean SSE termination.
7. Build the client and upload to OSS static hosting (optionally front with CDN).

## CD pipeline (GitHub Actions)

We stay on GitHub Actions rather than moving to Alibaba's Yunxiao/Flow: we already run
lint/test/build + Trivy + gitleaks there, and Flow expects the code in Codeup. We bolt a CD job
onto the existing CI.

Flow:

1. **Trigger** on push to `main` (or a release branch).
2. **Change-filter** with `dorny/paths-filter@v4` so only the image whose package changed builds
   (feeds a build matrix). This is the monorepo "only deploy what changed" control.
3. **Build + push:** `aliyun/acr-login@v1` (region `ap-southeast-1`) ->
   `docker/build-push-action` -> tag `registry-intl.ap-southeast-1.aliyuncs.com/distill/<image>:<sha>`.
4. **Deploy:** `aliyun/setup-aliyun-cli-action@v1` ->
   `aliyun sae DeployApplication --AppId <id> --ImageUrl <acr image:sha> --UpdateStrategy RollingUpdate`.
   (ECS variant: SSH in and `docker compose pull && docker compose up -d`. ACK variant:
   `aliyun/ack-set-context@v1` + `kubectl set image`.)

Build-and-push skeleton (identical regardless of compute target):

```yaml
- uses: aliyun/acr-login@v1
  with:
    login-server: https://registry-intl.ap-southeast-1.aliyuncs.com
    region-id: ap-southeast-1
    access-key-id: ${{ secrets.ALIYUN_ACCESS_KEY_ID }}
    access-key-secret: ${{ secrets.ALIYUN_ACCESS_KEY_SECRET }}
- uses: docker/build-push-action@v6
  with:
    context: .
    file: Dockerfile.api
    push: true
    tags: registry-intl.ap-southeast-1.aliyuncs.com/distill/api:${{ github.sha }}
```

## ACR approach and measures

- **Edition: ACR Personal Edition (free)** in Singapore. Limits (3 namespaces, 300 repos) easily
  cover our two images. It has no SLA and no built-in multi-engine vuln scanning (see measures).
- **Layout:** one namespace `distill`, two **private** repos (`api`, `client`), tagged by commit
  SHA (not `latest`) for provenance.
- **Endpoints (Singapore):** public `registry-intl.ap-southeast-1.aliyuncs.com`; in-VPC
  `registry-intl-vpc.ap-southeast-1.aliyuncs.com` (no internet egress charge on pull).
- **Auth:** CI authenticates with a dedicated RAM user via `aliyun/acr-login@v1`; laptop pushes
  use the separate ACR docker-login password (not the Alibaba account password).

Security and operational measures:

- **Least-privilege RAM:** a dedicated RAM user (not the root account) scoped to
  `AliyunContainerRegistryFullAccess` (+ `AliyunSAEFullAccess` for deploy). AccessKey stored in
  **GitHub Secrets** with environment protection rules; rotate the keys.
- **Private repos + VPC pull:** pull over the in-VPC endpoint with an `imagePullSecret` for the
  private repos.
- **Vulnerability scanning:** Personal Edition has no built-in scan, so keep **Trivy in CI** (we
  already run it); optionally add `aliyun/acr-image-scan`. If image scanning is a judging
  criterion, spin up a short-lived **ACR Enterprise Basic** for the demo (adds multi-engine scan,
  Cosign signing, and policy-based pull blocking).
- **Provenance:** SHA-tagged images, so every deployed artifact traces to a commit.

## Secrets and RAM

GitHub Secrets needed: `ALIYUN_ACCESS_KEY_ID`, `ALIYUN_ACCESS_KEY_SECRET`, plus `SAE_APP_ID_API`
and `SAE_APP_ID_CLIENT` (SAE) or `ECS_HOST` + `ECS_SSH_KEY` (ECS). One dedicated RAM user, scoped
to only the policies above.

## Cost

Effectively **$0 for the hackathon window**: ECS 12-month free trial + new-account credits, RDS
30-day free trial, Redis 1-month free trial, OSS within the free quota, ACR Personal free.
Intra-VPC traffic free, no NAT Gateway.

## Verify before relying

- Exact `aliyun sae DeployApplication` flag names against the live SAE OpenAPI (CLI params shift
  between API versions).
- The ACR instance domain in the console (Enterprise Edition uses a per-instance custom domain).
- Per-unit Singapore prices in the pricing calculator at provision time.

## References

- ACR billing / editions: https://www.alibabacloud.com/help/en/acr/product-overview/billing-description
- ACR access credentials / endpoints: https://www.alibabacloud.com/help/en/acr/user-guide/configure-access-credentials
- `aliyun/acr-login`: https://github.com/aliyun/acr-login
- `aliyun/ack-set-context`: https://github.com/aliyun/ack-set-context
- `aliyun/setup-aliyun-cli-action`: https://github.com/aliyun/setup-aliyun-cli-action
- SAE product / billing: https://www.alibabacloud.com/en/product/severless-application-engine
- SAE deploy via image: https://www.alibabacloud.com/help/en/sae/sae-application-deployment/
- ACS (ACK Serverless successor): https://www.alibabacloud.com/help/en/cs/product-overview/product-introduction
- ASK deprecation notice: https://www.alibabacloud.com/help/en/ack/product-overview/product-change-announcement-on-deprecation-of-cluster-creation-interface-for-ack-serverless-clusters
- RDS PostgreSQL pgvector: https://www.alibabacloud.com/help/en/rds/apsaradb-rds-for-postgresql/pgvector-use-guide
- ApsaraDB for Redis / Tair: https://www.alibabacloud.com/en/product/tair
- BullMQ production (noeviction): https://docs.bullmq.io/guide/going-to-production
- OSS static hosting: https://www.alibabacloud.com/help/en/oss/user-guide/hosting-static-websites
- OSS pricing: https://www.alibabacloud.com/en/product/oss/pricing
- RDS private connection / VPC: https://www.alibabacloud.com/help/en/rds/support/how-do-i-connect-to-an-apsaradb-rds-instance
- dorny/paths-filter: https://github.com/dorny/paths-filter
- GitHub Actions + ACK: https://www.alibabacloud.com/blog/github-actions-%2B-ack-a-powerful-combination-for-cloud-native-devops-implementation_597623
