/**
 * Payment Provider Interface
 * 
 * This abstraction allows UseShop to support multiple payment providers
 * (Monnify, Paystack, Flutterwave, etc.) without changing business logic.
 * 
 * Per the original Monnify Wallet Architecture Design document.
 */
export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

export interface PaymentProvider {
  /**
   * Create a virtual/reserved bank account for a user.
   */
  createVirtualAccount(user: {
    id: string;
    name?: string;
    email?: string;
    phoneNumber: string;
  }): Promise<any>;

  /**
   * Handle successful incoming deposit (credit to wallet).
   * This is usually called from a webhook handler.
   */
  handleIncomingDeposit(params: {
    providerReference: string;
    accountReference: string;
    amount: number;
    currency?: string;
  }): Promise<{ success: boolean; walletId?: string; newBalance?: number }>;

  /**
   * Initiate an outgoing payout / disbursement (e.g. refund to bank).
   */
  initiatePayout(params: {
    phoneNumber: string;
    amount: number;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    reference?: string;
    narration?: string;
  }): Promise<{
    success: boolean;
    message: string;
    reference?: string;
    status?: string;
    data?: any;
  }>;

  /**
   * Handle payout/disbursement webhook updates from the provider.
   */
  handlePayoutUpdate(eventData: any): Promise<void>;
}
