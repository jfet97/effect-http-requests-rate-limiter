---
"effect-http-requests-rate-limiter": patch
---

use sem instead of latch because of contention and FIFO behaviour
