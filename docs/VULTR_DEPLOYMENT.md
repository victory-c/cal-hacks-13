# Isolated sponsor hosting: Vultr

Use a **new, dedicated Vultr VM** for this project. Do not reuse Hermes or another existing
server. The temporary shared preview still runs on the Mac until sponsor hosting is ready.

## Verified recommendation

The current [Cal Hacks 13 Devpost](https://cal-hacks-13-0.devpost.com/) lists an explicit
**[MLH] Best Use of Vultr** category (one winning team, M5Stack Official Tab5). Hosting the working
project on Vultr is a direct integration with that category and needs minimal architecture changes.
This supports a practical hosting choice, not a claim about winning probability.

Microsoft's category evaluates production-minded agents and customer value; moving to Azure alone
does not establish those qualities. Annapurna Labs' sponsorship does not establish an AWS credit
or hosting prize. The [official Hive resources](https://hive.hackberkeley.org/resources) did not
provide a verified event-specific AWS cloud-credit offer when checked.

The [Vultr MLH offer](https://discover.vultr.com/mlh) advertises promotional credits without a
public amount. Confirm the actual credited balance and expiry in the account before provisioning.

The [official public plan API](https://api.vultr.com/v2/plans) and
[OS API](https://api.vultr.com/v2/os) were checked on October 24, 2026:

| Setting | Prepared choice |
| --- | --- |
| Instance | New `bullwark-calhacks13-preview` |
| Region | San Jose (`sjc`), subject to availability |
| Plan | `vc2-2c-4gb`: 2 vCPU, 4GB RAM, 80GB disk |
| Listed price | USD 20/month before applicable taxes; use confirmed promotional credit |
| OS | Ubuntu 24.04 LTS x64, OS id 2284 |
| Runtime | Existing Docker Compose app, persistent facts/model volumes, visible team login |

## Current account blocker

The Berkeley Google identity successfully signed into Vultr. The console displays that the
account could not be automatically verified, is pending additional review, and may take up to
48 hours. Navigating to support also returns the same account gate. No Vultr instance, SSH key,
API key or firewall resource was created, and the MLH credit balance remains unverified.

A local draft requests expedited review before the October 25, 9:00 AM Pacific submission
deadline. It has not been sent. The user chose to seek onsite Vultr/MLH assistance; account review
remains the blocker. Identity/payment verification, if requested, stays with the owner.

Once the account is approved, confirm the credit and final price, create only the dedicated
instance, deploy the verified Linux image, transfer runtime secrets securely, migrate canonical
data, and repeat the public login/provider/SSE/MCP checks before switching the preview URL.
The existing Compose instructions are in [PREVIEW.md](PREVIEW.md).

## Cancelled existing-server attempt: rollback complete

The initial attempt to use an existing Hermes AWS host was cancelled at the user's direction.
The newly installed Docker/Compose/Buildx/containerd/runc packages, build container/cache,
model volume, downloaded images, deployment directory, copied secrets, tunnel unit and
Docker-created network rules were removed. Temporary local migration-secret copies were deleted.
No new AWS cloud resource or security-group rule was created. The application and tunnel were
never started on that host, and the Mac preview was never cut over.

Verification after cleanup showed the original Hermes process still running with its October 15
start time, the original listening ports, and 13GB free disk. Only new isolated sponsor resources
may be used for further deployment work.
