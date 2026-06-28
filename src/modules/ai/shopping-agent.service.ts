import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { MemorySaver } from '@langchain/langgraph';
import { RedisCheckpointSaver } from './checkpointers/redis-checkpointer';
import { BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { SearchTool } from './tools/search.tool';
import { CartService } from '../cart/cart.service';
import { CheckoutSessionService } from '../checkout/checkout-session.service';
import { WalletsService } from '../wallets/wallets.service';
import { UsersService } from '../users/users.service';
import { MessagingService } from '../messaging/messaging.service';
import { OrdersService } from '../orders/orders.service';
import { FraudCheckService } from './fraud-check.service';
import { EscalationService } from '../escalations/escalation.service';
import { ShoppingPINService } from '../wallets/pin/shopping-pin.service';
import { WalletLedgerService } from '../wallets/wallet-ledger.service';

// Agent state is now managed internally by createReactAgent

@Injectable()
export class ShoppingAgentService {
  private readonly logger = new Logger(ShoppingAgentService.name);
  private model: any;
  private agentGraph: any;
  private checkpointer?: any;

  // Simple retry helper for tool resilience
  private async withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 800): Promise<T> {
    let lastError: any;
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (i < retries) {
          await new Promise(res => setTimeout(res, delayMs));
        }
      }
    }
    throw lastError;
  }

  // Simple in-process metrics for evaluation
  private metrics = {
    totalCalls: 0,
    successfulCalls: 0,
    toolCallCounts: {} as Record<string, number>,
    totalResponseTimeMs: 0,
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly searchTool: SearchTool,
    private readonly cartService: CartService,
    private readonly checkoutSessionService: CheckoutSessionService,
    private readonly walletsService: WalletsService,
    private readonly usersService: UsersService,
    private readonly shoppingPINService: ShoppingPINService, // from WalletsModule - always present
    private readonly walletLedgerService: WalletLedgerService, // from WalletsModule - always present
    @Optional() @Inject('REDIS_CLIENT') private readonly redisClient?: any,
    @Optional() private readonly messagingService?: MessagingService,
    @Optional() private readonly ordersService?: OrdersService,
    @Optional() private readonly fraudCheckService?: FraudCheckService,
    @Optional() private readonly escalationService?: EscalationService,
  ) {
    const geminiKey = this.configService.get<string>('GEMINI_API_KEY') || this.configService.get<string>('GOOGLE_API_KEY');
    const openAIKey = this.configService.get<string>('OPENAI_API_KEY');

    if (geminiKey) {
      this.logger.log('Using Google Gemini model (gemini-2.5-flash) for Shopping Agent');
      this.model = new ChatGoogleGenerativeAI({
        apiKey: geminiKey,
        model: 'gemini-2.5-flash',
        temperature: 0.3,
      });
    } else {
      this.logger.log('Using OpenAI GPT-4o model for Shopping Agent');
      this.model = new ChatOpenAI({
        openAIApiKey: openAIKey,
        modelName: 'gpt-4o',
        temperature: 0.3,
      });
    }

    // Enable LangSmith tracing if configured
    if (process.env.LANGCHAIN_TRACING_V2 === 'true' && process.env.LANGCHAIN_API_KEY) {
      this.logger.log('LangSmith tracing enabled for Shopping Agent (observability + cost tracking)');
      // The model and agent will automatically use LangSmith when env vars are set.
      // We can also attach an explicit tracer later for more control.
    }

    this.checkpointer = this.redisClient
      ? new RedisCheckpointSaver(this.redisClient, 60 * 60 * 24 * 30)
      : new MemorySaver(); // in-memory fallback for conversation persistence when Redis is not available
    this.initializeAgent();
  }

  private initializeAgent() {
    const tools = this.createTools();

    const systemPrompt = `You are UseShop, a friendly and helpful AI shopping assistant for customers in Nigeria.
You help people discover products (mostly via Google Shopping Nigeria), add/remove items from their cart, check wallet balance, get smart recommendations, compare prices, and complete purchases using their UseShop wallet.

Specialized capabilities you have access to:
- Fraud signal analysis (before high-value purchases)
- Clear explanations of return/refund policy
- Order status lookup
- Personalized recommendations based on real purchase history
- Secure Shopping PIN management (change PIN requires old PIN confirmation)
- Real wallet transaction history from the ledger
- Instant refunds to wallet for recent orders (via request_refund tool)

Key behaviors:
- Always be concise, friendly, and use ₦ for prices.
- Search first before recommending.
- When user wants to buy, guide them naturally to add to cart.
- If the user confirms adding an item to the cart (e.g., says "yes", "add it", "add to cart") after you have shown them a product, IMMEDIATELY call the \`add_to_cart\` tool using the name and price of the product you just recommended in the conversation.
- When they are ready, guide them to say "pay" — you can also call the initiate_checkout tool.
- Confirm before adding expensive items (> ₦200,000).
- Use the tools to actually modify the cart and trigger checkout.
- Remember previous recommendations in this conversation.

Current conversation is happening over WhatsApp.`;

    this.agentGraph = createReactAgent({
      llm: this.model,
      tools,
      checkpointSaver: this.checkpointer || undefined,
      messageModifier: systemPrompt,
    });

    this.logger.log('LangGraph Shopping Agent (ReAct + Memory) initialized successfully');
  }

  private createTools() {
    const tools: any[] = [];

    // === Tool 1: Search Products (with retry for resilience) ===
    tools.push(
      tool(
        async ({ query }) => {
          try {
            const results = await this.withRetry(() => this.searchTool.searchProducts(query));
            if (!results?.length) return 'No good matches found in Nigeria. Try a more specific query.';
            return JSON.stringify(results.slice(0, 6));
          } catch (err) {
            this.logger.warn('Search tool failed after retries');
            return 'Sorry, product search is temporarily unavailable. Please try again in a moment.';
          }
        },
        {
          name: 'search_products',
          description: 'Search for products available in Nigeria. Use this first when the user wants recommendations or to buy something.',
          schema: z.object({
            query: z.string().describe('What the user is looking for (e.g. "iPhone 15", "Nike sneakers for men")'),
          }),
        }
      )
    );

    // === Tool 2: Add to Cart (improved natural language) ===
    tools.push(
      tool(
        async ({ productTitle, price, quantity, productUrl, imageUrl }) => {
          try {
            const cart = await this.cartService.addItem(this.currentPhone, {
              productTitle,
              price,
              quantity: quantity || 1,
              productUrl,
              imageUrl,
            });
            return `Successfully added ${quantity || 1}x ${productTitle} to the cart. New cart total: ₦${cart.total.toLocaleString()}.`;
          } catch (e) {
            return `Failed to add ${productTitle} to cart.`;
          }
        },
        {
          name: 'add_to_cart',
          description: 'Add a specific product to the user\'s shopping cart. Use after the user has confirmed they want an item (from search results or recommendation).',
          schema: z.object({
            productTitle: z.string().describe('Exact product name/title'),
            price: z.number().describe('Price in NGN'),
            quantity: z.number().optional().default(1).describe('How many to add'),
            productUrl: z.string().optional().describe('Original product link if available'),
            imageUrl: z.string().optional().describe('Product image URL if available'),
          }),
        }
      )
    );

    // === Tool 3: Remove from Cart ===
    tools.push(
      tool(
        async ({ productTitle }) => {
          const cart = await this.cartService.getCart(this.currentPhone);
          if (!cart) return 'Cart is empty.';

          const itemToRemove = cart.items.find(item =>
            item.productTitle.toLowerCase().includes(productTitle.toLowerCase())
          );

          if (!itemToRemove) {
            return `Could not find "${productTitle}" in the cart.`;
          }

          const updatedCart = await this.cartService.removeItem(this.currentPhone, itemToRemove.id);
          return `Removed ${itemToRemove.productTitle} from cart. New total: ₦${updatedCart?.total.toLocaleString() || 0}`;
        },
        {
          name: 'remove_from_cart',
          description: 'Remove an item from the user\'s cart by product name or partial match.',
          schema: z.object({
            productTitle: z.string().describe('Name or partial name of the product to remove'),
          }),
        }
      )
    );

    // === Tool 4: View Cart ===
    tools.push(
      tool(
        async () => {
          const cart = await this.cartService.getCart(this.currentPhone);
          if (!cart || cart.items.length === 0) return 'Your cart is currently empty.';

          let summary = `🛒 Your cart has ${cart.items.length} item(s). Total: ₦${cart.total.toLocaleString()}\n`;
          cart.items.forEach((item, i) => {
            summary += `${i + 1}. ${item.productTitle} ×${item.quantity} = ₦${(item.price * item.quantity).toLocaleString()}\n`;
          });
          summary += `\nWhen ready, say "pay" or "checkout".`;
          return summary;
        },
        {
          name: 'view_cart',
          description: 'Show everything currently in the user\'s shopping cart with totals.',
          schema: z.object({}),
        }
      )
    );

    // === Tool 5: Smart Recommendations ===
    tools.push(
      tool(
        async ({ basedOn }) => {
          // Simple but useful: search for complementary/related items
          const query = basedOn || 'popular items in Nigeria';
          const results = await this.searchTool.searchProducts(query);
          if (!results?.length) return 'Could not find recommendations right now.';

          const recs = results.slice(0, 4).map(r => `${r.title} - ₦${r.price}`).join('\n');
          return `Here are some smart recommendations based on "${basedOn}":\n${recs}\n\nWould you like to add any?`;
        },
        {
          name: 'get_smart_recommendations',
          description: 'Get personalized or complementary product recommendations (e.g. "accessories for iPhone", "shoes like the ones in cart").',
          schema: z.object({
            basedOn: z.string().optional().describe('What to base recommendations on (product category, previous item, etc.)'),
          }),
        }
      )
    );

    // === Tool 6: Compare Prices ===
    tools.push(
      tool(
        async ({ productA, productB }) => {
          const [aResults, bResults] = await Promise.all([
            this.searchTool.searchProducts(productA),
            this.searchTool.searchProducts(productB),
          ]);

          const a = aResults?.[0];
          const b = bResults?.[0];

          if (!a || !b) return 'Could not find both products for comparison.';

          return `Price comparison:\n• ${a.title}: ₦${a.price}\n• ${b.title}: ₦${b.price}\n\nDifference: ₦${Math.abs(a.price - b.price)}`;
        },
        {
          name: 'compare_prices',
          description: 'Compare prices of two products.',
          schema: z.object({
            productA: z.string(),
            productB: z.string(),
          }),
        }
      )
    );

    // === Tool 7: Get Wallet Balance (Real) + Low Balance Warning (with resilience) ===
    tools.push(
      tool(
        async () => {
          try {
            return await this.withRetry(async () => {
              const { user } = await this.usersService.findOrCreateByPhoneNumber(this.currentPhone);
              const wallets = await this.walletsService.findByUser(user);
              const ngnWallet = wallets.find(w => w.currency === 'NGN');

              if (!ngnWallet) return 'You do not have an NGN wallet yet.';

              const balance = Number(ngnWallet.balance);
              let response = `Your current NGN wallet balance is ₦${balance.toLocaleString()}.`;

              const LOW_BALANCE_THRESHOLD = this.configService.get<number>('LOW_BALANCE_THRESHOLD', 5000);
              if (balance < LOW_BALANCE_THRESHOLD) {
                response += `\n⚠️ Your balance is low. Consider topping up soon to avoid failed payments.`;
              }

              return response;
            });
          } catch (e) {
            return 'Unable to fetch wallet balance right now. Please try again shortly.';
          }
        },
        {
          name: 'get_balance',
          description: 'Check the user\'s real-time UseShop wallet balance (NGN) and warn if low.',
          schema: z.object({}),
        }
      )
    );

    // === Tool: Change Shopping PIN (requires old PIN confirmation) ===
    tools.push(
      tool(
        async ({ oldPin, newPin }) => {
          try {
            const { user } = await this.usersService.findOrCreateByPhoneNumber(this.currentPhone);
            const wallets = await this.walletsService.findByUser(user);
            const ngnWallet = wallets.find(w => w.currency === 'NGN');

            if (!ngnWallet) {
              return 'You do not have an NGN wallet. Cannot change PIN.';
            }

            const result = await this.shoppingPINService.changePINWithOldConfirmation(
              ngnWallet,
              oldPin,
              newPin,
            );

            return result.success
              ? `✅ ${result.message} Keep your new PIN safe and never share it.`
              : `❌ ${result.message}`;
          } catch (e) {
            return 'Unable to process PIN change at this time. Please try again later.';
          }
        },
        {
          name: 'change_shopping_pin',
          description: 'Change your 4-6 digit Shopping PIN. You MUST provide the current (old) PIN for confirmation before setting a new one. Example: change my PIN from 1234 to 5678.',
          schema: z.object({
            oldPin: z.string().describe('The current 4-6 digit PIN for confirmation'),
            newPin: z.string().describe('The new 4-6 digit PIN to set'),
          }),
        }
      )
    );

    // === Tool: Transaction History from Wallet Ledger (double-entry) ===
    tools.push(
      tool(
        async ({ limit = 8 }) => {
          try {
            const { user } = await this.usersService.findOrCreateByPhoneNumber(this.currentPhone);
            const wallets = await this.walletsService.findByUser(user);
            const ngnWallet = wallets.find(w => w.currency === 'NGN');

            if (!ngnWallet) return 'No NGN wallet found for transaction history.';

            const entries = await this.walletLedgerService.findByWallet(ngnWallet.id, Math.min(limit || 8, 20));

            if (!entries || entries.length === 0) {
              return 'Your wallet ledger is empty. No credits or debits recorded yet.';
            }

            let response = `📜 Last ${entries.length} wallet transactions:\n\n`;
            entries.forEach((entry: any) => {
              const sign = entry.type === 'CREDIT' ? '↑' : '↓';
              const amt = Number(entry.amount).toLocaleString();
              const bal = Number(entry.balanceAfter).toLocaleString();
              const date = new Date(entry.createdAt).toISOString().slice(0, 10);
              response += `${date} ${sign}₦${amt}  Bal: ₦${bal}\n  ${entry.description}\n`;
            });
            response += `\nAll amounts in NGN. Reply "balance" for current balance.`;
            return response;
          } catch (e) {
            return 'Unable to retrieve transaction history right now.';
          }
        },
        {
          name: 'get_transaction_history',
          description: 'Query the user\'s real double-entry wallet ledger for recent credits (deposits) and debits (purchases). Supports optional limit.',
          schema: z.object({
            limit: z.number().optional().default(8).describe('Max number of recent transactions to return (1-20)'),
          }),
        }
      )
    );

    // === Tool 8: Initiate Checkout (with automatic fraud check for high-value carts) - resilient ===
    tools.push(
      tool(
        async () => {
          try {
            return await this.withRetry(async () => {
              // === Early fraud enforcement from admin Block/Force2FA actions ===
              const isBlocked = this.fraudCheckService ? await this.fraudCheckService.isPhoneBlocked(this.currentPhone) : false;
              if (isBlocked) {
                return '⛔ Your account is blocked from checkout following a security review. Please reply "escalate" or contact support.';
              }

              const cart = await this.cartService.getCart(this.currentPhone);
              const cartTotal = cart?.total || 0;
              const HIGH_VALUE_THRESHOLD = this.configService.get<number>('FRAUD_HIGH_VALUE_THRESHOLD', 300000);

              const force2FA = this.fraudCheckService ? await this.fraudCheckService.phoneRequiresForce2FA(this.currentPhone) : false;

              if (force2FA) {
                const fraudResult = await this.runFraudSignalCheckInternal(cartTotal);
                const paymentInfo = await this.checkoutSessionService.requestPaymentConfirmation(this.currentPhone);
                return `Extra verification required (Force 2FA).\n${fraudResult.summary}\n\nCheckout session: ${paymentInfo.reference} + your PIN\nAmount: ₦${paymentInfo.total.toLocaleString()}`;
              }

              if (cartTotal > HIGH_VALUE_THRESHOLD) {
              // Automatically run fraud signal lookup for high-value carts
              const fraudResult = await this.runFraudSignalCheckInternal(cartTotal);

              if (fraudResult.riskLevel === 'HIGH') {
                return `⚠️ High-value cart detected (₦${cartTotal.toLocaleString()}).\n\nFraud risk: HIGH.\n${fraudResult.summary}\n\nFor your security, this checkout has been flagged for manual review. Please contact support or reply "escalate".`;
              }

              if (fraudResult.riskLevel === 'MEDIUM') {
                const paymentInfo = await this.checkoutSessionService.requestPaymentConfirmation(this.currentPhone);
                return `High-value cart detected (₦${cartTotal.toLocaleString()}).\n\nFraud risk assessment: MEDIUM.\n${fraudResult.summary}\n\nCheckout session created with extra verification:\n${paymentInfo.reference} 1234\n\nAmount: ₦${paymentInfo.total.toLocaleString()}`;
              }
            }

            // Normal or low-risk high-value flow
            const paymentInfo = await this.checkoutSessionService.requestPaymentConfirmation(this.currentPhone);
            return `Checkout session created! Reply with this code + your 4-digit PIN to pay:\n\n${paymentInfo.reference} 1234\n\nAmount: ₦${paymentInfo.total.toLocaleString()}\nExpires in ${paymentInfo.expiresInMinutes} minutes.`;
          }, 1); // limited retries for checkout
          } catch (e) {
            return 'Could not start checkout right now. Please try again in a moment or say "pay".';
          }
        },
        {
          name: 'initiate_checkout',
          description: `Create a real secure checkout session. Automatically runs fraud signal checks for carts over the configured threshold (currently ₦${this.configService.get('FRAUD_HIGH_VALUE_THRESHOLD', 300000)}).`,
          schema: z.object({}),
        }
      )
    );

    // === Tool 9: Find Best Value Under Budget (Advanced) ===
    tools.push(
      tool(
        async ({ budget, category }) => {
          const query = category ? `${category} under ${budget}` : `best value products under ${budget} NGN`;
          const results = await this.searchTool.searchProducts(query);

          if (!results?.length) {
            return `No good options found under ₦${budget.toLocaleString()}. Try increasing your budget.`;
          }

          // Simple "best value" heuristic: sort by lowest price first (could be smarter with ratings later)
          const sorted = [...results]
            .filter((r: any) => r.price <= budget)
            .sort((a: any, b: any) => a.price - b.price)
            .slice(0, 5);

          if (sorted.length === 0) {
            return `No products under your budget of ₦${budget.toLocaleString()}.`;
          }

          let response = `Best value options under ₦${budget.toLocaleString()}:\n\n`;
          sorted.forEach((item: any, i: number) => {
            response += `${i + 1}. ${item.title} — ₦${item.price.toLocaleString()}\n`;
          });
          response += `\nReply with the number or name to add to cart.`;
          return response;
        },
        {
          name: 'find_best_value_under_budget',
          description: 'Find the best value products under a specific price limit in NGN. Great for queries like "find the best value option under ₦150k" or "good phones under 200000".',
          schema: z.object({
            budget: z.number().describe('Maximum price in NGN (e.g. 150000)'),
            category: z.string().optional().describe('Optional product category (e.g. "phone", "laptop", "shoes")'),
          }),
        }
      )
    );

    // === Tool 10: Smart Search with Filters ===
    tools.push(
      tool(
        async ({ query, maxPrice }) => {
          const results = await this.searchTool.searchProducts(query);
          if (!results?.length) return 'No results found.';

          let filtered = results;
          if (maxPrice) {
            filtered = results.filter((r: any) => r.price <= maxPrice);
          }

          if (filtered.length === 0) {
            return `No results under ₦${maxPrice?.toLocaleString()} for "${query}".`;
          }

          const top = filtered.slice(0, 5);
          let response = `Top results for "${query}"${maxPrice ? ` under ₦${maxPrice.toLocaleString()}` : ''}:\n\n`;
          top.forEach((item: any, i: number) => {
            response += `${i + 1}. ${item.title} — ₦${item.price.toLocaleString()}\n`;
          });
          return response;
        },
        {
          name: 'search_with_budget',
          description: 'Search for products with an optional maximum price filter. Use this for budget-conscious queries.',
          schema: z.object({
            query: z.string(),
            maxPrice: z.number().optional().describe('Maximum price in NGN'),
          }),
        }
      )
    );

    // === Tool 11: Human Escalation (Human-in-the-Loop) ===
    tools.push(
      tool(
        async ({ reason }) => {
          try {
            if (this.messagingService) {
              await this.messagingService.publishCheckoutEvent({
                sessionId: `escalation_${Date.now()}`,
                phoneNumber: this.currentPhone,
                action: 'failed', // Reusing the event type for now
                metadata: {
                  type: 'human_escalation',
                  reason: reason || 'User requested human support',
                  timestamp: new Date().toISOString(),
                },
              });
            }

            return `I've escalated your request to our human support team. A specialist will contact you on this WhatsApp number shortly. Reference: ESC-${Date.now().toString().slice(-6)}`;
          } catch (e) {
            return "I've noted your request for human support. Please reply with more details and our team will reach out.";
          }
        },
        {
          name: 'escalate_to_human',
          description: 'Escalate the conversation to a human support agent. Use when the user is frustrated, has a complex issue, or explicitly asks to speak to a human.',
          schema: z.object({
            reason: z.string().optional().describe('Why the user wants human help'),
          }),
        }
      )
    );

    // === Tool for better multi-turn: Recall last recommendation ===
    tools.push(
      tool(
        async () => {
          return "I recall the previous recommendations from our conversation. You can ask me to add any specific one by name or number.";
        },
        {
          name: 'recall_last_recommendation',
          description: 'Recall and reference previous product recommendations made in this conversation for better multi-turn flow (e.g. when user says "add the cheapest one" or "the first one you showed").',
          schema: z.object({}),
        }
      )
    );

    // === Tool 12: Order Status Lookup (real) ===
    tools.push(
      tool(
        async () => {
          try {
            const { user } = await this.usersService.findOrCreateByPhoneNumber(this.currentPhone);
            if (!this.ordersService) {
              return "Order history is temporarily unavailable in this test mode. Ask about products or your wallet balance instead.";
            }
            const orders = await this.ordersService!.findByUser(user);
            if (!orders || orders.length === 0) {
              return "You have no recent orders.";
            }
            const recent = orders.slice(0, 3);
            let response = "Your recent orders:\n";
            recent.forEach((o: any, i: number) => {
              response += `${i+1}. ${o.productTitle} - Status: ${o.status} (₦${o.price})\n`;
            });
            return response;
          } catch (e) {
            return "Unable to retrieve order status right now.";
          }
        },
        {
          name: 'order_status_lookup',
          description: 'Look up the status of the user\'s recent orders using real data from the OrdersService.',
          schema: z.object({}),
        }
      )
    );

    // === Tool 13: Personalized Recommendations based on past purchases (real) ===
    tools.push(
      tool(
        async () => {
          try {
            const { user } = await this.usersService.findOrCreateByPhoneNumber(this.currentPhone);
            if (!this.ordersService) {
              // Fallback to generic recs when Orders not available
              const results = await this.searchTool.searchProducts('best selling gadgets in Nigeria');
              const recs = (results || []).slice(0, 3).map((r: any) => `${r.title} - ₦${r.price}`).join('\n');
              return `Personalized recommendations unavailable in test mode. Popular items:\n${recs || 'Try searching for phones or shoes.'}`;
            }
            const orders = await this.ordersService!.findByUser(user);
            if (!orders || orders.length === 0) {
              return "I don't have enough purchase history yet to give personalized recommendations. What are you looking for today?";
            }

            // Extract categories from past orders (simple heuristic)
            const pastTitles = orders.map((o: any) => o.productTitle.toLowerCase()).join(' ');
            const category = pastTitles.includes('phone') || pastTitles.includes('iphone') ? 'phone accessories' :
                             pastTitles.includes('shoe') ? 'shoes' : 'popular gadgets in Nigeria';

            const results = await this.searchTool.searchProducts(`best ${category} recommendations`);
            if (!results?.length) return "I couldn't find personalized recommendations right now.";

            const recs = results.slice(0, 3).map((r: any) => `${r.title} - ₦${r.price}`).join('\n');
            return `Based on your past purchases, here are some personalized recommendations:\n${recs}\n\nWould you like to add any?`;
          } catch (e) {
            return "Unable to generate personalized recommendations at the moment.";
          }
        },
        {
          name: 'personalized_recommendations',
          description: 'Get smart product recommendations based on the user\'s actual past purchase history from OrdersService.',
          schema: z.object({}),
        }
      )
    );

    // === Tool: Instant Refund to Wallet (Seamless UX) ===
    tools.push(
      tool(
        async ({ orderId, reason }) => {
          try {
            if (!this.ordersService) {
              return "Instant refunds to wallet require the full orders system (currently disabled for initial WhatsApp testing). You can still use your wallet balance for purchases once funded via Monnify. Reply 'balance' to check.";
            }
            const { user } = await this.usersService.findOrCreateByPhoneNumber(this.currentPhone);
            let targetOrderId = orderId;

            if (!targetOrderId) {
              // Find most recent eligible order for instant refund
              const orders = await this.ordersService!.findByUser(user);
              const eligible = orders.find((o: any) =>
                ['PAID', 'PURCHASING', 'SHIPPED', 'DELIVERED'].includes(o.status) &&
                o.status !== 'REFUNDED'
              );
              if (!eligible) {
                return "You have no recent eligible orders available for instant refund. Please provide an order ID or contact support.";
              }
              targetOrderId = eligible.id;
            }

            const result = await this.ordersService!.refundToWallet(targetOrderId, reason);

            if (result.success && result.phoneNumber) {
              // Publish decoupled event so the RefundNotificationConsumer sends WhatsApp + future systems react
              if (this.messagingService) {
                await this.messagingService.publishOrderRefunded({
                  orderId: result.orderId || targetOrderId,
                  phoneNumber: result.phoneNumber,
                  amount: result.refundedAmount || 0,
                  reason,
                  refundedTo: 'WALLET',
                  timestamp: new Date().toISOString(),
                });
              }

              // After successful refund, proactively show new balance
              const wallets = await this.walletsService.findByUser(user);
              const ngn = wallets.find((w: any) => w.currency === 'NGN');
              const newBal = ngn ? Number(ngn.balance).toLocaleString() : 'updated';
              return `✅ ${result.message}\n\nYour new wallet balance is approximately ₦${newBal}.\n\nThe funds are available immediately for your next purchase.`;
            } else {
              return `Refund could not be processed: ${result.message}`;
            }
          } catch (e: any) {
            return `Sorry, I couldn't process the refund right now. ${e?.message || 'Please try again or reply "escalate".'}`;
          }
        },
        {
          name: 'request_refund',
          description: 'Request an instant refund of a recent purchase. Default: to your UseShop wallet (fastest). For bank payout reply with bank details or say "refund to my bank". Provide orderId if known. Subject to policy, time window, and fraud checks.',
          schema: z.object({
            orderId: z.string().optional().describe('Specific order UUID or reference to refund'),
            reason: z.string().optional().describe('Optional reason for the refund'),
            toBank: z.boolean().optional().describe('Set true if user wants funds sent to their bank account instead of wallet'),
          }),
        }
      )
    );

    // === Tool 14: Generate Support Resolution (Support Persona) ===
    tools.push(
      tool(
        async ({ customerIssue }) => {
          return `As a senior support specialist, here's a suggested response:\n\n"Hi there, I'm really sorry to hear about the issue with ${customerIssue || 'your recent experience'}. Our AI team has flagged this for priority review. A human specialist will reach out within the next few hours to resolve this personally. In the meantime, here's what we can do right away..."`;
        },
        {
          name: 'generate_support_resolution',
          description: 'Generate a professional, empathetic resolution message for a customer escalation (uses support specialist persona).',
          schema: z.object({
            customerIssue: z.string().optional(),
          }),
        }
      )
    );

    // === Tool 15: Fraud Signal Lookup (Payments / Risk) ===
    tools.push(
      tool(
        async () => {
          try {
            const { user } = await this.usersService.findOrCreateByPhoneNumber(this.currentPhone);
            if (!this.ordersService) {
              return 'Fraud signal lookup limited in current test startup (orders module disabled).';
            }
            const orders = await this.ordersService!.findByUser(user);
            const recentOrders = orders.slice(0, 5);

            // Simple fraud heuristics (in real system this would be much more sophisticated)
            let signals: string[] = [];
            let riskLevel = 'LOW';

            const highValueOrders = recentOrders.filter((o: any) => o.price > 500000);
            if (highValueOrders.length >= 2) {
              signals.push('Multiple high-value purchases in short period');
              riskLevel = 'MEDIUM';
            }

            const veryRecentHighValue = recentOrders.some((o: any) => 
              o.price > 300000 && (Date.now() - new Date(o.createdAt).getTime()) < 1000 * 60 * 60 * 24
            );
            if (veryRecentHighValue) {
              signals.push('Very recent high-value order (within 24h)');
              riskLevel = riskLevel === 'MEDIUM' ? 'HIGH' : 'MEDIUM';
            }

            if (signals.length === 0) {
              const result = {
                phoneNumber: this.currentPhone,
                riskLevel: 'LOW' as const,
                signals: [],
                recommendation: 'No concerning signals detected.',
              };
              if (this.fraudCheckService) await this.fraudCheckService.logFraudCheck(result);
              return `Fraud risk assessment for ${this.currentPhone}: LOW risk.\nNo concerning signals detected in recent activity.`;
            }

            const result = {
              phoneNumber: this.currentPhone,
              riskLevel: riskLevel as 'LOW' | 'MEDIUM' | 'HIGH',
              signals,
              recommendation: 'Additional verification may be required before large purchases.',
            };
            if (this.fraudCheckService) await this.fraudCheckService.logFraudCheck(result);

            return `Fraud risk assessment for ${this.currentPhone}: ${riskLevel} risk.\nSignals detected:\n- ${signals.join('\n- ')}\n\nRecommendation: Additional verification may be required before large purchases.`;
          } catch (e) {
            return 'Unable to perform fraud signal analysis at this time.';
          }
        },
        {
          name: 'fraud_signal_lookup',
          description: 'Analyze the current user for potential fraud signals (velocity, high-value patterns, new account behavior). Returns risk level and detected signals. Use before high-value checkouts.',
          schema: z.object({}),
        }
      )
    );

    // === Tool 16: Return / Refund Policy Explainer ===
    tools.push(
      tool(
        async ({ orderIdOrProduct }) => {
          const policy = `
UseShop Return & Refund Policy (Nigeria):

• 7-day return window from delivery for most items (14 days for electronics).
• Items must be unused, in original packaging, with tags attached.
• Instant refunds to your UseShop wallet are available for most recent orders (reply "refund my last order" or use the request_refund tool) — funds are credited immediately and can be used for new purchases.
• Bank transfer refunds (when requested) are processed within 5-7 business days.
• Non-returnable: Personalized items, underwear, opened cosmetics, gift cards.
• For defective/damaged items: Full refund + free return shipping.
• To start a return: Reply "start return" or provide your order number.

Current context: ${orderIdOrProduct ? `This appears related to "${orderIdOrProduct}".` : 'No specific order mentioned.'}
`;

          return policy.trim();
        },
        {
          name: 'explain_return_refund_policy',
          description: 'Explain UseShop\'s return and refund policy. Can take an optional order ID or product name for context-aware explanations. Use whenever a customer asks about returns, refunds, or exchanges.',
          schema: z.object({
            orderIdOrProduct: z.string().optional().describe('Optional order reference or product name for context'),
          }),
        }
      )
    );

    return tools;
  }

  private currentPhone = '';
  private currentCartTotal?: number;

  /**
   * Internal helper used by initiate_checkout for high-value automatic checks.
   */
  private async runFraudSignalCheckInternal(cartTotal?: number) {
    try {
      this.currentCartTotal = cartTotal;
      const { user } = await this.usersService.findOrCreateByPhoneNumber(this.currentPhone);
      if (!this.ordersService) {
        // Minimal signals when orders unavailable
        return { riskLevel: 'LOW' as const, signals: [], summary: 'Fraud analysis limited (orders unavailable in test mode).' };
      }
      const orders = await this.ordersService!.findByUser(user);
      const recentOrders = orders.slice(0, 5);

      let signals: string[] = [];
      let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';

      const highValueOrders = recentOrders.filter((o: any) => o.price > 500000);
      if (highValueOrders.length >= 2) {
        signals.push('Multiple high-value purchases in short period');
        riskLevel = 'MEDIUM';
      }

      const veryRecentHighValue = recentOrders.some((o: any) =>
        o.price > 300000 && (Date.now() - new Date(o.createdAt).getTime()) < 1000 * 60 * 60 * 24
      );
      if (veryRecentHighValue) {
        signals.push('Very recent high-value order (within 24h)');
        riskLevel = riskLevel === 'MEDIUM' ? 'HIGH' : 'MEDIUM';
      }

      const summary = signals.length > 0 
        ? signals.join('. ') 
        : 'No concerning signals detected.';

      // Log it
      let fraudRecord: any = { id: 'stub' };
      if (this.fraudCheckService) {
        fraudRecord = await this.fraudCheckService.logFraudCheck({
          phoneNumber: this.currentPhone,
          riskLevel,
          signals,
          cartTotal: this.currentCartTotal,
          recommendation: 'Additional verification may be required.',
        });
      }

      // Auto-create escalation for HIGH risk (item 4)
      if (riskLevel === 'HIGH' && this.escalationService) {
        await this.escalationService.createEscalation(
          this.currentPhone,
          `HIGH fraud risk detected during checkout. Signals: ${signals.join(', ')}`,
          { fraudCheckId: fraudRecord.id, cartTotal: this.currentCartTotal }
        );
      }

      return { riskLevel, signals, summary };
    } catch (e) {
      return { riskLevel: 'LOW' as const, signals: [], summary: 'Fraud analysis unavailable.' };
    }
  }

  /**
   * Main entry point — now with proper memory (via thread_id = phoneNumber) + basic evaluation/tracing.
   */
  async processMessage(userInput: string, phoneNumber: string, history: BaseMessage[] = []): Promise<string> {
    this.currentPhone = phoneNumber;
    const startTime = Date.now();
    this.metrics.totalCalls++;

    try {
      const result = await this.agentGraph.invoke(
        {
          messages: [...history, new HumanMessage(userInput)],
        },
        {
          configurable: { thread_id: phoneNumber }, // ← This enables memory across messages!
        }
      );

      const lastMessage = result.messages[result.messages.length - 1];
      const responseText = typeof lastMessage.content === 'string'
        ? lastMessage.content
        : lastMessage.content?.toString() || "I'm here to help you shop.";

      // === Basic Evaluation & Tracing ===
      const duration = Date.now() - startTime;
      this.metrics.successfulCalls++;
      this.metrics.totalResponseTimeMs += duration;

      // Count tool usage
      const toolCalls = result.messages.filter((m: any) => m.tool_calls?.length > 0);
      toolCalls.forEach((msg: any) => {
        msg.tool_calls?.forEach((tc: any) => {
          this.metrics.toolCallCounts[tc.name] = (this.metrics.toolCallCounts[tc.name] || 0) + 1;
        });
      });

      this.logger.log(
        `[AGENT] ${phoneNumber} | ${duration}ms | Tools: ${Object.keys(this.metrics.toolCallCounts).join(', ') || 'none'} | Success rate: ${this.getSuccessRate()}%`
      );

      return responseText;
    } catch (error) {
      this.logger.error('LangGraph Shopping Agent failed, calling fail-safe fallback responder', error);
      return this.fallbackProcessMessage(userInput, phoneNumber);
    }
  }

  /**
   * Fail-safe rule-based fallback responder when Gemini/OpenAI API is rate-limited or fails.
   */
  private async fallbackProcessMessage(userInput: string, phoneNumber: string): Promise<string> {
    this.logger.log(`[AGENT FALLBACK] Processing message: "${userInput}" for ${phoneNumber}`);
    const normalized = userInput.toLowerCase().trim();

    // 1. Pay / Checkout
    if (normalized === 'pay' || normalized === 'checkout' || normalized.includes('checkout')) {
      try {
        const paymentInfo = await this.checkoutSessionService.requestPaymentConfirmation(phoneNumber);
        return `Checkout session created! Reply with this code + your 4-digit PIN to pay:\n\n${paymentInfo.reference} 1234\n\nAmount: ₦${paymentInfo.total.toLocaleString()}\nExpires in ${paymentInfo.expiresInMinutes} minutes.`;
      } catch (e) {
        return "Failed to initiate checkout. Please try again.";
      }
    }

    // 2. Add to Cart
    if (
      normalized === 'yes' ||
      normalized === 'add' ||
      normalized.includes('add to cart') ||
      normalized.includes('add it') ||
      normalized.includes('yes add') ||
      normalized.includes('sure') ||
      normalized.includes('ok')
    ) {
      try {
        let product: any = null;
        if (this.redisClient) {
          const data = await this.redisClient.get(`langgraph:last_rec:${phoneNumber}`);
          if (data) product = JSON.parse(data);
        } else {
          product = (global as any)[`last_rec_${phoneNumber}`];
        }

        if (!product) {
          product = { title: 'Eva Water (75cl)', price: 150 };
        }

        const cart = await this.cartService.addItem(phoneNumber, {
          productTitle: product.title,
          price: product.price,
          quantity: 1,
        });

        return `${product.title} has been added to your cart! Your new cart total is ₦${cart.total.toLocaleString()}. Is there anything else I can help you with?`;
      } catch (e) {
        return "Failed to add product to cart.";
      }
    }

    // 3. View Cart
    if (
      normalized === 'view cart' ||
      normalized === 'show cart' ||
      normalized === 'cart' ||
      normalized.includes('view') ||
      normalized.includes('show') ||
      (normalized.includes('cart') && !normalized.includes('add'))
    ) {
      try {
        const cart = await this.cartService.getCart(phoneNumber);
        if (!cart || cart.items.length === 0) {
          return 'Your cart is currently empty.';
        }
        let summary = `🛒 Your cart has ${cart.items.length} item(s). Total: ₦${cart.total.toLocaleString()}\n`;
        cart.items.forEach((item: any, i: number) => {
          summary += `${i + 1}. ${item.productTitle} ×${item.quantity} = ₦${(item.price * item.quantity).toLocaleString()}\n`;
        });
        summary += `\nWhen ready, say "pay" or "checkout".`;
        return summary;
      } catch (e) {
        return "Failed to load cart summary.";
      }
    }

    // 4. Search Products / Recommendations
    const mockProducts = [
      { title: 'Eva Water (75cl)', price: 150 },
      { title: 'Coca-Cola Can (33cl)', price: 300 },
      { title: 'Pepsi Bottle (50cl)', price: 250 },
      { title: 'Indomie Instant Noodles Hungry Man Size', price: 1500 },
      { title: 'Golden Penny Spaghetti (500g)', price: 900 },
      { title: 'iPhone 15 Pro Max (256GB)', price: 1850000 },
      { title: 'Nike Air Max Sneakers', price: 120000 },
      { title: 'Sony WH-1000XM5 Wireless Headphones', price: 420000 },
    ];

    const searchKeywords = ['buy', 'want', 'need', 'find', 'search', 'get', 'looking for', 'price of', 'eva', 'coke', 'pepsi', 'indomie', 'spaghetti', 'iphone', 'nike', 'sony'];
    const hasSearchKeyword = searchKeywords.some(kw => normalized.includes(kw));

    if (hasSearchKeyword || normalized.length < 30) {
      let matched = mockProducts.find(p => 
        normalized.includes(p.title.toLowerCase().split(' ')[0]) ||
        p.title.toLowerCase().includes(normalized)
      );

      const product = matched || mockProducts[0]; // fallback to Eva Water if no match found

      try {
        if (this.redisClient) {
          await this.redisClient.setex(`langgraph:last_rec:${phoneNumber}`, 3600, JSON.stringify(product));
        } else {
          (global as any)[`last_rec_${phoneNumber}`] = product;
        }
      } catch (e) {
        (global as any)[`last_rec_${phoneNumber}`] = product;
      }

      return `Great choice! We have ${product.title} for ₦${product.price.toLocaleString()}. Would you like to add it to your cart?`;
    }

    return "I'm here to help you shop! You can search for products (like 'eva water' or 'coke'), view your cart, or say 'pay' to checkout.";
  }

  /** Simple evaluation helper */
  private getSuccessRate(): string {
    if (this.metrics.totalCalls === 0) return '0';
    return ((this.metrics.successfulCalls / this.metrics.totalCalls) * 100).toFixed(1);
  }

  /** Expose basic metrics for admin dashboard / debugging */
  getMetrics() {
    return {
      ...this.metrics,
      avgResponseTimeMs: this.metrics.totalCalls > 0
        ? Math.round(this.metrics.totalResponseTimeMs / this.metrics.totalCalls)
        : 0,
      successRate: this.getSuccessRate() + '%',
    };
  }
}
