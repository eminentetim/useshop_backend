import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Order, OrderStatus } from './entities/order.entity';
import { User } from '../users/entities/user.entity';
import { Wallet, Currency } from '../wallets/entities/wallet.entity';
import { LedgerEntryType } from '../wallets/entities/wallet-ledger.entity';
import { Transaction, TransactionType, TransactionStatus } from '../wallets/entities/transaction.entity';
import { WalletLedgerService } from '../wallets/wallet-ledger.service';
import { FraudCheckService } from '../ai/fraud-check.service';
import { EscalationService } from '../escalations/escalation.service';
import { PaymentsService } from '../payments/payments.service';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { UsersService } from '../users/users.service';
import { CheckoutSessionService } from '../checkout/checkout-session.service';
import { MessagingService } from '../messaging/messaging.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    private readonly dataSource: DataSource,
    private readonly fulfillmentService: FulfillmentService,
    private readonly usersService: UsersService,
    private readonly checkoutSessionService: CheckoutSessionService,
    private readonly walletLedgerService: WalletLedgerService,
    @InjectRepository(Wallet)
    private readonly walletRepository: Repository<Wallet>,
    private readonly configService: ConfigService,
    private readonly fraudCheckService: FraudCheckService,
    private readonly escalationService: EscalationService,
    private readonly paymentsService: PaymentsService,
    private readonly messagingService: MessagingService,
  ) {}

  async createOrder(user: User, productData: any): Promise<Order> {
    const order = this.orderRepository.create({
      user,
      productTitle: productData.title,
      price: productData.price,
      productUrl: productData.link,
      imageUrl: productData.image,
      status: OrderStatus.PENDING_PAYMENT,
    });
    return this.orderRepository.save(order);
  }

  async checkout(orderId: string): Promise<Order> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const order = await queryRunner.manager.findOne(Order, {
        where: { id: orderId },
        relations: ['user'],
      });

      if (!order) throw new BadRequestException('Order not found');
      if (order.status !== OrderStatus.PENDING_PAYMENT) {
        throw new BadRequestException('Order is already processed or paid');
      }

      // 1. Find NGN Wallet
      const wallet = await queryRunner.manager.findOne(Wallet, {
        where: { user: { id: order.user.id }, currency: Currency.NGN },
      });

      if (!wallet || wallet.balance < order.price) {
        throw new BadRequestException('Insufficient balance in NGN wallet');
      }

      // 2. Deduct Balance
      wallet.balance = Number(wallet.balance) - Number(order.price);
      await queryRunner.manager.save(wallet);

      // 3. Create Transaction Record
      const transaction = queryRunner.manager.create(Transaction, {
        wallet,
        amount: order.price,
        type: TransactionType.PURCHASE,
        status: TransactionStatus.SUCCESS,
        reference: `ORDER_${order.id}`,
        metadata: { orderId: order.id, product: order.productTitle },
      });
      await queryRunner.manager.save(transaction);

      // 4. Update Order Status
      order.status = OrderStatus.PAID;
      const savedOrder = await queryRunner.manager.save(order);

      await queryRunner.commitTransaction();
      
      this.logger.log(`Order ${order.id} paid successfully. Triggering fulfillment...`);
      // Fire and forget fulfillment for now
      this.fulfillmentService.processAutomatedPurchase(order.id, order.productUrl).then(result => {
        if (result.success) {
            this.orderRepository.update(order.id, { 
                status: OrderStatus.PURCHASING, 
                thirdPartyOrderId: result.thirdPartyOrderId 
            });
        }
      });
      
      return savedOrder;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Checkout failed for order ${orderId}`, err.stack);
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async findByUser(user: User): Promise<Order[]> {
    return this.orderRepository.find({
      where: { user: { id: user.id } },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * List recent orders (for admin dashboard). Supports optional phone filter.
   */
  async findRecentOrders(limit = 50, phoneNumber?: string): Promise<Order[]> {
    const query = this.orderRepository.createQueryBuilder('order')
      .leftJoinAndSelect('order.user', 'user')
      .orderBy('order.createdAt', 'DESC')
      .take(limit);

    if (phoneNumber) {
      query.where('user.phoneNumber = :phone', { phone: phoneNumber });
    }

    return query.getMany();
  }

  /**
   * Refund to customer's actual bank account via Monnify disbursement.
   * This is the non-instant path (subject to Monnify processing + possible OTP).
   * We still debit the UseShop wallet ledger immediately for accounting.
   */
  async refundToBank(
    orderId: string,
    bankDetails: { bankCode: string; accountNumber: string; accountName: string },
    reason?: string,
  ): Promise<{ success: boolean; message: string; reference?: string; monnifyStatus?: string }> {
    // Reuse most of the validation from the wallet path (simplified duplicate for clarity)
    const order = await this.orderRepository.findOne({ where: { id: orderId }, relations: ['user'] });
    if (!order) throw new BadRequestException('Order not found');
    if (order.status === OrderStatus.REFUNDED) {
      return { success: false, message: 'Already refunded' };
    }

    const amount = Number(order.price);
    const phone = order.user.phoneNumber;

    // Debit the wallet via ledger (accounting must stay consistent)
    const { user } = await this.usersService.findOrCreateByPhoneNumber(phone);
    const wallet = await this.walletRepository.findOne({ where: { user: { id: user.id }, currency: Currency.NGN } });

    if (wallet) {
      const newBalance = Number(wallet.balance) - amount;
      await this.walletLedgerService.recordEntry({
        wallet,
        type: LedgerEntryType.DEBIT,
        amount,
        balanceAfter: newBalance,
        reference: `BANK_REFUND_${orderId}`,
        description: reason || `Bank refund for order ${order.productTitle}`,
        metadata: { orderId, payoutType: 'monnify_disbursement', ...bankDetails },
      });
      wallet.balance = newBalance;
      await this.walletRepository.save(wallet);
    }

    // Initiate real bank transfer
    const disbursement = await this.paymentsService.initiateMonnifyDisbursement({
      phoneNumber: phone,
      amount,
      bankCode: bankDetails.bankCode,
      accountNumber: bankDetails.accountNumber,
      accountName: bankDetails.accountName,
      narration: `Refund for ${order.productTitle}`,
      reference: `BANKREF_${orderId}`,
    });

    // Mark order refunded
    order.status = OrderStatus.REFUNDED;
    order.metadata = {
      ...(order.metadata || {}),
      refundedAt: new Date().toISOString(),
      refundReason: reason,
      payoutType: 'BANK',
      bankDetails,
      monnifyDisbursement: disbursement,
    };
    await this.orderRepository.save(order);

    // Publish event (consumer will notify user)
    await this.messagingService.publishOrderRefunded({
      orderId,
      phoneNumber: phone,
      amount,
      reason,
      refundedTo: 'BANK',
      timestamp: new Date().toISOString(),
      metadata: { monnifyStatus: (disbursement as any).monnifyStatus, reference: disbursement.reference },
    }).catch(() => {});

    return {
      success: disbursement.success,
      message: disbursement.message,
      reference: disbursement.reference,
      monnifyStatus: (disbursement as any).monnifyStatus,
    };
  }

  /**
   * Instant refund to the user's UseShop wallet.
   * Uses the modern double-entry WalletLedgerService for the credit.
   * Also records a legacy REFUND Transaction for compatibility.
   * Atomic via queryRunner.
   */
  async refundToWallet(orderId: string, reason?: string): Promise<{ 
    success: boolean; 
    message: string; 
    refundedAmount?: number; 
    phoneNumber?: string; 
    orderId?: string;
  }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const order = await queryRunner.manager.findOne(Order, {
        where: { id: orderId },
        relations: ['user'],
      });

      if (!order) {
        throw new BadRequestException('Order not found');
      }

      if (order.status === OrderStatus.REFUNDED) {
        return { success: false, message: 'Order has already been refunded.' };
      }

      if (![OrderStatus.PAID, OrderStatus.PURCHASING, OrderStatus.SHIPPED, OrderStatus.DELIVERED].includes(order.status)) {
        return { success: false, message: `Order cannot be refunded in its current status: ${order.status}` };
      }

      // === Improved Eligibility Rules ===
      const REFUND_WINDOW_DAYS = this.configService.get<number>('REFUND_WINDOW_DAYS', 14);
      const daysSincePurchase = (Date.now() - new Date(order.createdAt).getTime()) / (1000 * 60 * 60 * 24);

      if (daysSincePurchase > REFUND_WINDOW_DAYS) {
        return {
          success: false,
          message: `Refund window of ${REFUND_WINDOW_DAYS} days has passed. Please contact support for manual review.`,
        };
      }

      const amount = Number(order.price);

      // Fraud / Risk gate for refunds - more aggressive
      const phone = order.user.phoneNumber;
      if (await this.fraudCheckService.isPhoneBlocked(phone)) {
        return {
          success: false,
          message: 'Refunds are currently restricted on this account due to a security review. Please contact support.',
        };
      }

      // Aggressive rule: recent HIGH fraud signals block instant refund (auto-escalates)
      try {
        const recentChecks = await this.fraudCheckService.getRecentChecks(30);
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const highRiskRecent = recentChecks.filter((c: any) =>
          c.phoneNumber === phone &&
          c.riskLevel === 'HIGH' &&
          new Date(c.timestamp).getTime() > sevenDaysAgo
        );
        if (highRiskRecent.length > 0) {
          await this.escalationService.createEscalation(
            phone,
            `Refund requested for order ${orderId} but recent HIGH fraud signals detected (${highRiskRecent.length}). Manual review required.`,
            { orderId, recentHighRiskChecks: highRiskRecent.length, type: 'fraud_blocked_refund' }
          ).catch(() => {});
          return {
            success: false,
            message: 'This refund has been flagged for manual review due to recent high-risk fraud signals. An escalation has been created for support.',
          };
        }
      } catch (e) {
        this.logger.warn('Could not perform recent fraud signal check for refund gate');
      }

      // Auto-escalation on high-value refunds (Seamless UX + risk control)
      const HIGH_REFUND_THRESHOLD = this.configService.get<number>('FRAUD_HIGH_VALUE_THRESHOLD', 300000);
      if (amount > HIGH_REFUND_THRESHOLD) {
        this.logger.warn(`High-value refund requested for order ${orderId} (₦${amount}) by ${phone}`);
        await this.escalationService.createEscalation(
          phone,
          `High-value refund (₦${amount.toLocaleString()}) requested for order ${orderId}. Review required before or after processing.`,
          {
            orderId,
            amount,
            type: 'high_value_refund',
            autoTriggered: true,
          }
        ).catch(e => this.logger.error('Failed to auto-create escalation for high value refund', e));
      }

      if (amount <= 0) {
        return { success: false, message: 'Invalid refund amount.' };
      }

      // Find or create user's NGN wallet
      const { user } = await this.usersService.findOrCreateByPhoneNumber(order.user.phoneNumber);
      let wallet = await queryRunner.manager.findOne(Wallet, {
        where: { user: { id: user.id }, currency: Currency.NGN },
      });

      if (!wallet) {
        // Should rarely happen; create one on the fly
        wallet = queryRunner.manager.create(Wallet, {
          user,
          currency: Currency.NGN,
          balance: 0,
          status: 'ACTIVE' as any,
        });
        wallet = await queryRunner.manager.save(wallet);
      }

      const previousBalance = Number(wallet.balance);
      const newBalance = previousBalance + amount;

      // 1. Modern double-entry ledger credit (source of truth for balance views)
      await this.walletLedgerService.recordEntry({
        wallet,
        type: LedgerEntryType.CREDIT,
        amount,
        balanceAfter: newBalance,
        reference: `REFUND_${order.id}`,
        description: reason || `Instant refund for order ${order.productTitle}`,
        metadata: {
          orderId: order.id,
          product: order.productTitle,
          source: 'instant_refund_to_wallet',
        },
      });

      // 2. Update wallet balance
      wallet.balance = newBalance;
      await queryRunner.manager.save(wallet);

      // 3. Legacy transaction record (for existing reports)
      const refundTx = queryRunner.manager.create(Transaction, {
        wallet,
        amount,
        type: TransactionType.REFUND,
        status: TransactionStatus.SUCCESS,
        reference: `REFUND_${order.id}`,
        metadata: { orderId: order.id, reason: reason || 'Customer requested / policy' },
      });
      await queryRunner.manager.save(refundTx);

      // 4. Update order status
      order.status = OrderStatus.REFUNDED;
      order.metadata = {
        ...(order.metadata || {}),
        refundedAt: new Date().toISOString(),
        refundReason: reason || 'Instant wallet refund',
      };
      await queryRunner.manager.save(order);

      await queryRunner.commitTransaction();

      this.logger.log(`Instant refund processed for order ${orderId} → ₦${amount} credited to wallet ${wallet.id}`);

      return {
        success: true,
        message: `Refund of ₦${amount.toLocaleString()} has been instantly credited to your UseShop wallet.`,
        refundedAmount: amount,
        phoneNumber: order.user.phoneNumber,
        orderId: order.id,
      };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Refund failed for order ${orderId}`, err.stack);
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Process a confirmed CheckoutSession: creates orders from the cart snapshot
   * and performs atomic wallet debits.
   *
   * This is the method the CheckoutConsumer should call on 'confirmed' events.
   */
  async processCheckoutSessionPayment(checkoutSession: any): Promise<void> {
    const { phoneNumber, cartSnapshot, totalAmount } = checkoutSession;

    if (!cartSnapshot?.items?.length) {
      this.logger.warn('No items in checkout session cartSnapshot');
      return;
    }

    // For simplicity we create one Order per line item (can be improved later)
    const createdOrders: any[] = [];

    for (const item of cartSnapshot.items) {
      const order = await this.createOrderFromItem(phoneNumber, item);
      createdOrders.push(order);
    }

    // Perform atomic debit + status update for each order
    for (const order of createdOrders) {
      try {
        await this.checkout(order.id); // This does the atomic wallet debit
        this.logger.log(`Order ${order.id} paid successfully from checkout session`);
      } catch (error) {
        this.logger.error(`Failed to checkout order ${order.id} from session`, error);
        // In production: partial rollback or compensation logic
      }
    }

    // Mark the checkout session as completed (clears cart too)
    await this.checkoutSessionService.markSessionCompleted(phoneNumber, createdOrders[0]?.id);
  }

  private async createOrderFromItem(phoneNumber: string, item: any) {
    const { user } = await this.usersService.findOrCreateByPhoneNumber(phoneNumber);

    const order = this.orderRepository.create({
      user,
      productTitle: item.productTitle,
      price: item.price,
      productUrl: item.productUrl || '',
      imageUrl: item.imageUrl,
      status: OrderStatus.PENDING_PAYMENT,
    });

    return this.orderRepository.save(order);
  }
}
