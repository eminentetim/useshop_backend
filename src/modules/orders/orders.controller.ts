import { Controller, Post, Param, Body, Get, Query } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { MessagingService } from '../messaging/messaging.service';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly messagingService: MessagingService,
  ) {}

  /**
   * Admin / Support endpoint to trigger an instant refund to the customer's UseShop wallet.
   * This is the main way human agents (via dashboard or escalations) can issue refunds.
   */
  @Post(':id/refund')
  async refundOrder(
    @Param('id') orderId: string,
    @Body() body: { reason?: string; force?: boolean },
  ) {
    const result = await this.ordersService.refundToWallet(orderId, body.reason);

    if (result.success && result.phoneNumber) {
      // Publish event so RefundNotificationConsumer sends WhatsApp + other systems react
      await this.messagingService.publishOrderRefunded({
        orderId,
        phoneNumber: result.phoneNumber,
        amount: result.refundedAmount || 0,
        reason: body.reason,
        refundedTo: 'WALLET',
        timestamp: new Date().toISOString(),
      });
    }

    return {
      success: result.success,
      message: result.message,
      refundedAmount: result.refundedAmount,
      orderId,
    };
  }

  @Get('refundable')
  async getRefundableOrders(@Query('phone') phone?: string) {
    // Simple helper for admin dashboards — in production add pagination + auth
    if (!phone) {
      return { message: 'Provide ?phone= to list recent refundable orders for a customer' };
    }
    // For now, return a note. Full implementation can use UsersService + find recent paid orders
    return {
      note: 'This endpoint can be expanded to list eligible orders for a phone number.',
      phone,
    };
  }

  /**
   * List recent orders for admin dashboard UI (supports phone filter).
   * Used by the refunds/orders management interface.
   */
  @Get()
  async listOrders(@Query('phone') phone?: string, @Query('limit') limit = '50') {
    const orders = await this.ordersService.findRecentOrders(parseInt(limit, 10) || 50, phone);
    return orders.map(o => ({
      id: o.id,
      phoneNumber: o.user?.phoneNumber,
      productTitle: o.productTitle,
      price: Number(o.price),
      status: o.status,
      createdAt: o.createdAt,
      metadata: o.metadata,
    }));
  }

  /**
   * Admin endpoint for refund directly to customer's bank account via Monnify.
   */
  @Post(':id/refund-bank')
  async refundToBank(
    @Param('id') orderId: string,
    @Body() body: { reason?: string; bankCode: string; accountNumber: string; accountName: string },
  ) {
    const result = await this.ordersService.refundToBank(orderId, {
      bankCode: body.bankCode,
      accountNumber: body.accountNumber,
      accountName: body.accountName,
    }, body.reason);

    return result;
  }
}

