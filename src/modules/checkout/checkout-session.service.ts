import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { CartService, Cart } from '../cart/cart.service';
import { MessagingService } from '../messaging/messaging.service';
import { ShoppingPINService } from '../wallets/pin/shopping-pin.service';
import { FraudCheckService } from '../ai/fraud-check.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Wallet } from '../wallets/entities/wallet.entity';

export type CheckoutSessionStatus =
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMED'
  | 'EXPIRED'
  | 'FAILED'
  | 'COMPLETED';

export interface CheckoutSession {
  id: string;
  phoneNumber: string;
  cartSnapshot: Cart;
  totalAmount: number;
  currency: string;
  status: CheckoutSessionStatus;
  expiresAt: string;
  createdAt: string;
  confirmationAttempts: number;
  lastAttemptAt?: string;
  confirmationReference: string; // Short code we send to the user (e.g. "USE-7842")
  metadata?: Record<string, any>; // IP, device fingerprint, etc. (future)
}

@Injectable()
export class CheckoutSessionService {
  private readonly logger = new Logger(CheckoutSessionService.name);

  // Security & UX constants
  private readonly SESSION_TTL_SECONDS = 60 * 15; // 15 minutes — strict for payments
  private readonly MAX_CONFIRMATION_ATTEMPTS = 3;

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: any,
    private readonly cartService: CartService,
    private readonly messagingService: MessagingService,
    private readonly shoppingPINService: ShoppingPINService,
    private readonly fraudCheckService: FraudCheckService,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
  ) {}

  private getSessionKey(phoneNumber: string): string {
    return `checkout_session:${phoneNumber}`;
  }

  private generateReference(): string {
    // Simple, human-friendly reference (can be improved later)
    const random = Math.floor(1000 + Math.random() * 9000);
    return `USE-${random}`;
  }

  /**
   * Creates a new checkout session from the user's current cart.
   * This is the critical "Pay" step entry point.
   */
  async createSession(phoneNumber: string): Promise<CheckoutSession> {
    // === Fraud Enforcement: Block / Force 2FA from admin actions ===
    if (await this.fraudCheckService.isPhoneBlocked(phoneNumber)) {
      throw new BadRequestException('Your account is currently blocked from making purchases due to a security review. Please contact support.');
    }

    const cart = await this.cartService.getCart(phoneNumber);

    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('No items in cart to checkout');
    }

    // Prevent multiple active checkout sessions
    const existing = await this.getActiveSession(phoneNumber);
    if (existing) {
      // In production we might want to expire the old one or merge
      await this.expireSession(phoneNumber);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.SESSION_TTL_SECONDS * 1000);

    const session: CheckoutSession = {
      id: `chk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      phoneNumber,
      cartSnapshot: cart,
      totalAmount: cart.total,
      currency: cart.currency,
      status: 'PENDING_CONFIRMATION',
      expiresAt: expiresAt.toISOString(),
      createdAt: now.toISOString(),
      confirmationAttempts: 0,
      confirmationReference: this.generateReference(),
    };

    const key = this.getSessionKey(phoneNumber);
    await this.redis.setex(key, this.SESSION_TTL_SECONDS, JSON.stringify(session));

    this.logger.log(
      `Checkout session created for ${phoneNumber} | Ref: ${session.confirmationReference} | Amount: ${session.totalAmount}`,
    );

    // Publish event so workers (and future systems) know a checkout was initiated
    await this.messagingService.publishCheckoutEvent({
      sessionId: session.id,
      phoneNumber,
      action: 'created',
      totalAmount: session.totalAmount,
      cartSnapshot: session.cartSnapshot,
    });

    return session;
  }

  async getActiveSession(phoneNumber: string): Promise<CheckoutSession | null> {
    const key = this.getSessionKey(phoneNumber);
    const data = await this.redis.get(key);

    if (!data) return null;

    const session = JSON.parse(data) as CheckoutSession;

    // Auto-expire check
    if (new Date(session.expiresAt) < new Date()) {
      await this.expireSession(phoneNumber);
      return null;
    }

    return session;
  }

  /**
   * The user has said "Pay" or tapped checkout.
   * We return the reference code they must confirm with.
   */
  async requestPaymentConfirmation(phoneNumber: string): Promise<{
    reference: string;
    total: number;
    currency: string;
    expiresInMinutes: number;
  }> {
    let session = await this.getActiveSession(phoneNumber);

    if (!session) {
      session = await this.createSession(phoneNumber);
    }

    return {
      reference: session.confirmationReference,
      total: session.totalAmount,
      currency: session.currency,
      expiresInMinutes: Math.floor(this.SESSION_TTL_SECONDS / 60),
    };
  }

  /**
   * Core payment confirmation method.
   * This is where PIN validation + fraud checks will live.
   *
   * For now: placeholder with strong guardrails.
   */
  async confirmWithPin(
    phoneNumber: string,
    reference: string,
    pin: string,
    metadata: Record<string, any> = {},
  ): Promise<{ success: boolean; session?: CheckoutSession; message: string }> {
    // === Fraud Enforcement (block takes precedence) ===
    if (await this.fraudCheckService.isPhoneBlocked(phoneNumber)) {
      return {
        success: false,
        message: 'Your account is currently blocked from checkout due to a security review. Contact support.',
      };
    }

    const session = await this.getActiveSession(phoneNumber);

    if (!session) {
      return {
        success: false,
        message: 'No active checkout session. Please start checkout again.',
      };
    }

    if (session.confirmationReference !== reference) {
      return {
        success: false,
        message: 'Invalid confirmation reference.',
      };
    }

    if (session.status !== 'PENDING_CONFIRMATION') {
      return {
        success: false,
        message: `Session is already in status: ${session.status}`,
      };
    }

    // Increment attempts
    session.confirmationAttempts += 1;
    session.lastAttemptAt = new Date().toISOString();

    if (session.confirmationAttempts > this.MAX_CONFIRMATION_ATTEMPTS) {
      session.status = 'FAILED';
      await this.saveSession(session);
      return {
        success: false,
        message: 'Too many failed attempts. This session has been locked.',
      };
    }

    // === Real Shopping PIN Validation ===
    const wallet = await this.walletRepository.findOne({
      where: { 
        user: { phoneNumber }, 
        currency: (session.currency || 'NGN') as any 
      },
    });

    if (!wallet) {
      return { success: false, message: 'Wallet not found for this user.' };
    }

    const pinValidation = await this.shoppingPINService.validatePIN(wallet, pin);

    if (!pinValidation.valid) {
      await this.saveSession(session);
      return { success: false, message: pinValidation.message };
    }

    // Force 2FA enforcement (from admin fraud action) - we already required PIN; attach flag for audit
    const requiresForce2FA = await this.fraudCheckService.phoneRequiresForce2FA(phoneNumber);
    if (requiresForce2FA) {
      this.logger.warn(`Force-2FA flag active for ${phoneNumber} on confirmed session`);
      (session as any).force2FAEnforced = true;
    }

    session.status = 'CONFIRMED';
    await this.saveSession(session);

    this.logger.log(`Real Shopping PIN validated for ${phoneNumber} on session ${session.id}`);

    // Publish confirmed event → CheckoutConsumer will pick this up and run real payment processing
    await this.messagingService.publishCheckoutEvent({
      sessionId: session.id,
      phoneNumber: session.phoneNumber,
      action: 'confirmed',
      totalAmount: session.totalAmount,
      cartSnapshot: session.cartSnapshot,
    });

    return {
      success: true,
      session,
      message: 'Payment confirmation accepted. Proceeding with debit.',
    };
  }

  /**
   * Called after successful wallet debit + order creation
   */
  async markSessionCompleted(phoneNumber: string, orderId: string): Promise<void> {
    const session = await this.getActiveSession(phoneNumber);
    if (!session) return;

    session.status = 'COMPLETED';
    (session as any).completedOrderId = orderId;

    await this.saveSession(session, 60 * 60 * 24); // Keep completed session for 24h for audit
    await this.cartService.clearCart(phoneNumber); // Clear the cart after successful payment
  }

  async expireSession(phoneNumber: string): Promise<void> {
    const key = this.getSessionKey(phoneNumber);
    await this.redis.del(key);
    this.logger.log(`Checkout session expired for ${phoneNumber}`);
  }

  private async saveSession(session: CheckoutSession, ttlSeconds?: number): Promise<void> {
    const key = this.getSessionKey(session.phoneNumber);
    const ttl = ttlSeconds ?? this.SESSION_TTL_SECONDS;
    await this.redis.setex(key, ttl, JSON.stringify(session));
  }
}
