# UseShop — Improved Conversational Commerce Flow (Production Grade)

**Date**: 2026-05-26  
**Context**: Analysis of the proposed user flow using the `startup-team` skill.  
**Project Fit**: Extremely high — this is the core product loop for UseShop (WhatsApp AI shopping assistant for Nigeria with wallet funding via Monnify).

---

## Executive Summary

The proposed flow is **good directionally** but **not production-ready** in its current form.

### Current Implementation Gaps (as of today)
- No real cart system (orders with `PENDING_PAYMENT` status are used as a crude cart).
- AI is simple prompt-based intent detection (no tools, no memory, no state).
- "confirm" magic word triggers checkout (very brittle).
- No Redis usage despite being in docker-compose.
- No message queue (RabbitMQ not present).
- No session/checkout state machine.
- No PIN, no fraud signals, weak security on payments.
- WhatsApp webhook does too much work synchronously.

**Verdict from Startup Team**: The flow can become **outstanding** with the additions below. Without them it will be fragile and risky for real money movement.

---

## Proposed Production Flow

```mermaid
User (WhatsApp)
  → Webhook (validate + fast ack + enqueue message)
  → RabbitMQ (durable queue)
  → AI Agent Worker (LangGraph + Tools + Redis Memory)
       ├── Understand Intent + Media (Vision + Whisper)
       ├── Tool Calls: search_products, add_to_cart, view_cart, etc.
       └── Generate Rich Response (text + product images + quick replies)
  → Send via WhatsApp
       ↓
User interacts (selects, "add 2", "remove", "view cart")
       ↓
Cart updated in Redis (short TTL + user-scoped)
       ↓
User: "pay" or "checkout"
       ↓
Create CheckoutSession (Redis, short TTL, idempotency key)
       ↓
Request Confirmation (PIN or future biometric)
       ↓
Validate PIN + Run Fraud Signals (velocity, amount, device signals via metadata)
       ↓
Atomic Wallet Debit (TypeORM Transaction + Ledger Event)
       ↓
Create Order + Publish OrderCreated Event (RabbitMQ)
       ↓
Fulfillment Worker + Notification Worker
       ↓
Send Confirmation + Rich Tracking Message
```

---

## Key Additions Required (Prioritized)

### 1. Infrastructure (DevOps + Backend)
- **Redis** (already in compose) — Carts, Checkout Sessions, AI short-term memory, rate limiting.
- **RabbitMQ** — Add to docker-compose. Use for reliable async processing of:
  - AI message processing
  - Wallet debits / order creation
  - Fulfillment jobs
  - Notifications & recovery flows
- Proper **correlation IDs** and structured logging across the entire user journey.

### 2. Backend Changes (NestJS + TypeScript)
- New `CartModule` + `RedisCartService` (using ioredis).
- New `CheckoutSession` entity or Redis-backed value object (with expiration, items, total, status).
- Refactor `WhatsappService` to be a thin adapter:
  - Fast webhook ack
  - Enqueue to RabbitMQ
- Move heavy logic to **Consumers/Workers**.
- Strengthen `PaymentsService`:
  - Monnify webhook handler (for deposit credits)
  - Fraud signal hooks before debit
- Make `checkout()` fully event-driven and idempotent.

### 3. AI Layer (AI Systems Engineer)
- **Replace** current `processRequest` with a proper **LangGraph agent**.
- Define clear **Tools** the agent can call:
  - `searchProducts(query)`
  - `addToCart(item)`
  - `removeFromCart(itemId)`
  - `viewCart()`
  - `getWalletBalance()`
  - `initiateCheckout()`
- Add memory (Redis + Postgres user preferences).
- Add evaluation + cost tracking from day one.
- Support rich WhatsApp responses (interactive buttons, image carousels via media IDs).

### 4. Payment & Security Hardening (Payments Sacred)
- Never trust raw "PIN" over WhatsApp long-term. Start with:
  - Short-lived `CheckoutSession` token sent to user.
  - PIN + device fingerprinting (store last 4 digits of phone + simple metadata).
  - Velocity checks, amount thresholds, manual review queue for high value.
- Full double-entry ledger for wallet movements (separate `WalletTransaction` events).
- Idempotency keys on every debit and order creation.

### 5. Frontend / Ops (Dashboard)
- Real-time view of active carts and conversations.
- Manual intervention tools ("release cart", "refund", "flag user").
- AI cost dashboard and bad recommendation review queue.
- Abandoned cart recovery campaign management.

### 6. Outstanding / Differentiating Features
- **Smart Memory**: "You usually shop for phones between ₦900k–₦1.5M".
- **Proactive Recovery**: WhatsApp message 3 hours after abandoned cart with smart discount suggestion from AI.
- **Multi-modal Excellence**: Photo of a product → AI finds exact or better alternatives + price comparison.
- **Trust Signals**: Show "Funded via Monnify • Protected by UseShop Guarantee" in every confirmation.
- **Human Escalation**: "Talk to human" button that creates a ticket in the dashboard.

---

## Recommended Implementation Order

1. **Add Redis client** + create `CartService` with basic add/view/remove (1-2 days).
2. **Add RabbitMQ** to docker-compose + basic producer/consumer setup (1 day).
3. **Refactor WhatsApp webhook** to enqueue messages (fast path).
4. **Build first version of LangGraph shopping agent** with 4-5 core tools.
5. **Implement CheckoutSession + PIN confirmation flow** with proper state machine.
6. **Add Monnify webhook handler** for deposit credits (currently the biggest missing piece for funding).
7. **Build admin dashboard views** for carts, conversations, and payment ops.
8. **Add observability** (correlation IDs, basic metrics, cost tracking).

---

## Risk Register (High)

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|----------|
| WhatsApp message ordering/dupes | High | High | Use Redis idempotency + sequence numbers per conversation |
| Fraud on PIN flow | Medium | Very High | Velocity checks + manual review + limits per user |
| AI hallucinating prices or wrong products | High | High | Tool grounding + human review queue + evaluation set |
| Cost explosion on AI calls | Medium | Medium | Strict tool budgets + caching + cheaper models for simple intents |
| Fulfillment failures (Puppeteer) | Very High | High | Make fulfillment a proper queued job with retries + human fallback |

---

## Conclusion

The proposed flow is **the right north star** for UseShop.

To make it **seamless, smart, and outstanding**, we must treat it as a **distributed, event-driven, stateful system** with:
- Redis for fast mutable state (carts, sessions)
- RabbitMQ for reliable work distribution
- LangGraph for intelligent, tool-using AI
- Strong payment security primitives from day one

This combination, executed well on the defined stack (NestJS + Next.js + Postgres + Redis + Monnify), has the potential to be a category-defining product in Nigerian conversational commerce.

**Next Action Recommended**: The team should produce the detailed technical design + first implementation PR for the **Redis Cart + CheckoutSession** layer.

---
*Generated by the Startup Engineering Team (Backend/Payments + AI + DevOps leads)*
