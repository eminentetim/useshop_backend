import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { UsersService } from '../users/users.service';
import { WalletsService } from '../wallets/wallets.service';
import { PaymentsService } from '../payments/payments.service';
import { AiService } from '../ai/ai.service';
import { OrdersService } from '../orders/orders.service';
import { CheckoutSessionService } from '../checkout/checkout-session.service';
import { MessagingService, WhatsAppMessageEvent } from '../messaging/messaging.service';
import { ShoppingAgentService } from '../ai/shopping-agent.service';
import { ShoppingPINService } from '../wallets/pin/shopping-pin.service';
import { Twilio } from 'twilio';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly usersService: UsersService,
    private readonly walletsService: WalletsService,
    private readonly aiService: AiService,
    private readonly checkoutSessionService: CheckoutSessionService,
    @Optional() private readonly ordersService?: OrdersService,
    @Optional() private readonly messagingService?: MessagingService,
    @Optional() private readonly paymentsService?: PaymentsService,
    @Optional() private readonly shoppingAgentService?: ShoppingAgentService,
    private readonly shoppingPINService?: ShoppingPINService,
  ) {}

  private onboardingStates = new Map<string, { step: 'AWAITING_PIN' | 'AWAITING_PIN_CONFIRM'; tempPin?: string }>();

  async handleIncomingMessage(body: any) {
    this.logger.log('Received WhatsApp message payload:', JSON.stringify(body));

    let phoneNumber = '';
    let messageType = 'text';
    let isTwilio = false;

    // Check if it is a Twilio payload
    if (body.MessageSid || body.From) {
      isTwilio = true;
      phoneNumber = body.From;
      if (phoneNumber && phoneNumber.startsWith('whatsapp:')) {
        phoneNumber = phoneNumber.replace('whatsapp:', '');
      }
    } else {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      if (!message) return;
      phoneNumber = message.from;
      messageType = message.type;
    }

    if (!phoneNumber) return;

    // Find or create user
    const { user } = await this.usersService.findOrCreateByPhoneNumber(phoneNumber);

    // Process Multimodal Input
    let userInput = '';
    try {
      if (isTwilio) {
        const numMedia = parseInt(body.NumMedia || '0', 10);
        if (numMedia > 0) {
          const contentType = body.MediaContentType0 || '';
          const mediaUrl = body.MediaUrl0;
          if (contentType.startsWith('audio/')) {
            userInput = await this.aiService.transcribeVoice(mediaUrl);
          } else if (contentType.startsWith('image/')) {
            userInput = await this.aiService.analyzeImage(mediaUrl, body.Body || '');
          } else if (contentType.startsWith('video/')) {
            userInput = "I received your video! I'm still learning how to watch videos, but I can help if you describe what's in it or send a photo.";
            await this.sendMessage(phoneNumber, userInput);
            return;
          }
        } else {
          userInput = body.Body || '';
        }
      } else {
        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const message = value?.messages?.[0];

        if (messageType === 'text') {
          userInput = message.text.body;
        } else if (messageType === 'audio') {
          const audioUrl = await this.getMediaUrl(message.audio.id);
          userInput = await this.aiService.transcribeVoice(audioUrl);
        } else if (messageType === 'image') {
          const imageUrl = await this.getMediaUrl(message.image.id);
          userInput = await this.aiService.analyzeImage(imageUrl, message.image.caption);
        } else if (messageType === 'video') {
          userInput = "I received your video! I'm still learning how to watch videos, but I can help if you describe what's in it or send a photo.";
          await this.sendMessage(phoneNumber, userInput);
          return;
        }
      }
    } catch (error) {
      this.logger.error('Error processing multimodal input', error.message);
      await this.sendMessage(phoneNumber, "Sorry, I had trouble processing that. Could you try again or send a text?");
      return;
    }

    if (!userInput) return;

    // Check if onboarding PIN setup is active/needed
    let wallets = await this.walletsService.findByUser(user);
    let ngnWallet = wallets.find(w => w.currency === 'NGN');
    if (!ngnWallet) {
      ngnWallet = await this.walletsService.createWallet(user);
    }

    const pinSet = this.shoppingPINService ? this.shoppingPINService.hasPINSet(ngnWallet) : false;
    const onboardingState = this.onboardingStates.get(phoneNumber);

    if (!pinSet || onboardingState) {
      await this.handlePinSetup(phoneNumber, userInput.trim(), ngnWallet, user);
      return;
    }

    // 3. Handle basic commands before AI processing
    const normalizedInput = userInput.toLowerCase().trim();

    if (normalizedInput === 'balance' || normalizedInput === 'wallet') {
      await this.handleBalanceCheck(user);
      return;
    }

    // === NEW SECURE CHECKOUT FLOW (CheckoutSession + PIN) ===
    if (normalizedInput === 'pay' || normalizedInput === 'checkout') {
      await this.handlePaymentRequest(phoneNumber);
      return;
    }

    // User is responding with a confirmation reference + PIN (e.g. "USE-7842 1234")
    if (/^use-\d{4}\s+\d{4}$/i.test(normalizedInput)) {
      await this.handlePaymentConfirmation(phoneNumber, normalizedInput);
      return;
    }

    // Legacy support (will be removed)
    if (normalizedInput === 'confirm') {
      await this.handleLegacyCheckout(user);
      return;
    }

    // 4. AI Orchestration — Direct call for testing (bypasses consumer circular dependency)
    if (this.shoppingAgentService) {
      try {
        const aiResponse = await this.shoppingAgentService.processMessage(userInput, phoneNumber);
        await this.sendMessage(phoneNumber, aiResponse);
      } catch (error) {
        this.logger.error('Direct agent call failed', error);
        await this.sendMessage(phoneNumber, "Sorry, the AI is having a moment. Please try again shortly.");
      }
    } else {
      await this.sendMessage(phoneNumber, "AI agent not available in this test configuration.");
    }
  }

  private async getMediaUrl(mediaId: string): Promise<string> {
    const accessToken = this.configService.get<string>('WHATSAPP_ACCESS_TOKEN');
    const url = `https://graph.facebook.com/v17.0/${mediaId}`;

    const response = await firstValueFrom(
      this.httpService.get(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    );

    return response.data.url;
  }

  private async handlePinSetup(phoneNumber: string, userInput: string, ngnWallet: any, user: any) {
    let state = this.onboardingStates.get(phoneNumber);

    if (!state) {
      // Step 1: Initialize onboarding and call Monnify reserved account
      let virtualAccountInfo = '';
      try {
        if (this.paymentsService) {
          const monnifyAcct = await this.paymentsService.createReservedAccount({
            id: user.id,
            phoneNumber: user.phoneNumber,
            name: user.name || '',
            email: user.email || '',
          });

          if (monnifyAcct && monnifyAcct.accounts && monnifyAcct.accounts.length > 0) {
            const acct = monnifyAcct.accounts[0];
            
            // Save virtual account details to wallet entity
            await this.walletsService.updateWallet(ngnWallet.id, {
              monnifyAccountNumber: acct.accountNumber,
              monnifyAccountReference: monnifyAcct.accountReference,
              monnifyBankName: acct.bankName,
            });

            // Update local object reference
            ngnWallet.monnifyAccountNumber = acct.accountNumber;
            ngnWallet.monnifyBankName = acct.bankName;

            virtualAccountInfo = `\n🏦 *Your Wallet Funding Account Details*:\n• Bank Name: ${acct.bankName}\n• Account Number: ${acct.accountNumber}\n• Account Name: ${acct.accountName}\n`;
          }
        }
      } catch (error) {
        this.logger.error(`Failed to create Monnify reserved account: ${error.message}`);
      }

      const welcomeText = 
        `Welcome to UseShop! 🛍️ I'm your AI shopping assistant. I've created your NGN wallet.\n` +
        `${virtualAccountInfo}\n` +
        `To secure your wallet transactions, please choose a 4 to 6-digit Shopping PIN. Reply with your desired PIN now (e.g. 1234):`;

      await this.sendMessage(phoneNumber, welcomeText);
      this.onboardingStates.set(phoneNumber, { step: 'AWAITING_PIN' });
      return;
    }

    if (state.step === 'AWAITING_PIN') {
      if (!/^\d{4,6}$/.test(userInput)) {
        await this.sendMessage(phoneNumber, `❌ Invalid PIN. Please reply with a 4 to 6-digit numeric PIN (e.g. 1234) to secure your wallet:`);
        return;
      }

      this.onboardingStates.set(phoneNumber, { step: 'AWAITING_PIN_CONFIRM', tempPin: userInput });
      await this.sendMessage(phoneNumber, `Please re-enter your 4 to 6-digit Shopping PIN to confirm:`);
      return;
    }

    if (state.step === 'AWAITING_PIN_CONFIRM') {
      if (userInput !== state.tempPin) {
        this.onboardingStates.set(phoneNumber, { step: 'AWAITING_PIN' });
        await this.sendMessage(phoneNumber, `❌ PINs did not match. Let's try again.\n\nPlease choose a 4 to 6-digit Shopping PIN. Reply with your desired PIN now:`);
        return;
      }

      try {
        if (this.shoppingPINService) {
          await this.shoppingPINService.setPIN(ngnWallet, userInput);
        }
        this.onboardingStates.delete(phoneNumber);

        let fundingText = '';
        if (ngnWallet.monnifyAccountNumber) {
          fundingText = `🏦 *Bank Name:* ${ngnWallet.monnifyBankName}\n🔢 *Account Number:* \`${ngnWallet.monnifyAccountNumber}\`\n👤 *Account Name:* UseShop User ${user.phoneNumber}`;
        } else {
          fundingText = `(Virtual funding accounts are temporarily offline, but you can shop using test credentials.)`;
        }

        const successText = 
          `✅ *Setup Complete!*\n\n` +
          `Your Shopping PIN has been set and your NGN wallet is now active. 🎉\n\n` +
          `💡 *Please fund your wallet to start shopping:*\n` +
          `You can deposit funds by making a standard bank transfer to your dedicated virtual account:\n\n` +
          `${fundingText}\n\n` +
          `After funding, just send me a message with what you want to buy, and we will get started!`;

        await this.sendMessage(phoneNumber, successText);
      } catch (error) {
        this.logger.error(`Failed to set PIN: ${error.message}`);
        this.onboardingStates.set(phoneNumber, { step: 'AWAITING_PIN' });
        await this.sendMessage(phoneNumber, `❌ There was an error saving your PIN. Please try again. Reply with your desired 4 to 6-digit PIN now:`);
      }
      return;
    }
  }

  private async handleBalanceCheck(user: any) {
    const wallets = await this.walletsService.findByUser(user);
    const ngnWallet = wallets.find((w) => w.currency === 'NGN');

    let message = `Your UseShop Balances:\n`;
    wallets.forEach((w) => {
      message += `- ${w.currency}: ${w.balance}\n`;
    });

    if (ngnWallet?.monnifyAccountNumber) {
      message += `\nFund your NGN wallet via:\n${ngnWallet.monnifyBankName} - ${ngnWallet.monnifyAccountNumber}`;
    }

    await this.sendMessage(user.phoneNumber, message);
  }

  private async handleCheckout(user: any) {
    try {
        if (!this.ordersService) {
          await this.sendMessage(user.phoneNumber, "Legacy checkout path unavailable in current test mode. Use 'pay' to start the secure PIN checkout flow instead.");
          return;
        }
        const pendingOrders = await this.ordersService.findByUser(user);
        const lastPending = pendingOrders.find(o => o.status === 'PENDING_PAYMENT');

        if (!lastPending) {
            await this.sendMessage(user.phoneNumber, "You don't have any pending orders in your cart.");
            return;
        }

        await this.ordersService.checkout(lastPending.id);
        await this.sendMessage(user.phoneNumber, `Payment successful! 🛍️ I'm now processing your order for "${lastPending.productTitle}". I'll notify you once it's shipped.`);
    } catch (error) {
        await this.sendMessage(user.phoneNumber, `Checkout failed: ${error.message}. Please fund your wallet or try again.`);
    }
  }

  /**
   * New secure flow: User says "Pay" or "Checkout"
   */
  private async handlePaymentRequest(phoneNumber: string) {
    try {
      const paymentInfo = await this.checkoutSessionService.requestPaymentConfirmation(phoneNumber);

      const message = 
        `🛒 Ready to pay ₦${paymentInfo.total.toLocaleString()}?\n\n` +
        `Please reply with your confirmation code and 4-digit PIN like this:\n` +
        `${paymentInfo.reference} 1234\n\n` +
        `This code expires in ${paymentInfo.expiresInMinutes} minutes.`;

      await this.sendMessage(phoneNumber, message);
    } catch (error) {
      await this.sendMessage(phoneNumber, `Unable to start checkout: ${error.message}`);
    }
  }

  /**
   * User replies with "USE-7842 1234"
   */
  private async handlePaymentConfirmation(phoneNumber: string, input: string) {
    const [reference, pin] = input.toUpperCase().split(' ');

    const result = await this.checkoutSessionService.confirmWithPin(phoneNumber, reference, pin);

    if (!result.success) {
      await this.sendMessage(phoneNumber, result.message);
      return;
    }

    const session = result.session!;

    if (this.ordersService) {
      try {
        await this.sendMessage(phoneNumber, '⏳ PIN confirmed. Processing wallet payment and creating your order...');
        await this.ordersService.processCheckoutSessionPayment(session);
        await this.sendMessage(
          phoneNumber,
          `🛍️ *Payment Successful!*\n\n` +
          `Your payment of ₦${session.totalAmount.toLocaleString()} was debited from your wallet.\n` +
          `Your order has been placed and is now being processed. Tracking ID: \`US-${session.id.split('-')[0].toUpperCase()}\``
        );
      } catch (error) {
        this.logger.error('Failed to process checkout session payment:', error);
        await this.sendMessage(
          phoneNumber,
          `❌ Payment accepted, but we encountered an error completing your order: ${error.message}. Please contact support.`
        );
      }
    } else {
      await this.sendMessage(
        phoneNumber,
        `Payment of ₦${session.totalAmount.toLocaleString()} is being processed.\n` +
        `Your order will be created shortly. You'll receive tracking details.`
      );
    }
  }

  /**
   * Legacy "confirm" flow — will be deprecated
   */
  private async handleLegacyCheckout(user: any) {
    await this.sendMessage(
      user.phoneNumber,
      'The old "confirm" command is being replaced with the new secure checkout flow.\n\n' +
      'Please reply with "pay" to start the new secure checkout process.'
    );
  }

  async sendMessage(to: string, text: string) {
    const accountSid = this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const authToken = this.configService.get<string>('TWILIO_AUTH_TOKEN');

    if (accountSid && authToken) {
      const fromNumber = this.configService.get<string>('TWILIO_PHONE_NUMBER') || 'whatsapp:+14155238886';
      
      const formattedTo = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
      const formattedFrom = fromNumber.startsWith('whatsapp:') ? fromNumber : `whatsapp:${fromNumber}`;

      try {
        const client = new Twilio(accountSid, authToken);
        await client.messages.create({
          body: text,
          from: formattedFrom,
          to: formattedTo,
        });
        this.logger.log(`WhatsApp message sent via Twilio to ${formattedTo}`);
        return;
      } catch (error) {
        this.logger.error(`Failed to send WhatsApp message via Twilio: ${error.message}`);
        return;
      }
    }

    // Fallback to Facebook Graph API
    const phoneNumberId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const accessToken = this.configService.get<string>('WHATSAPP_ACCESS_TOKEN');

    if (!phoneNumberId || !accessToken) {
      this.logger.warn('Neither Twilio nor Facebook WhatsApp credentials are set. Message not sent:', text);
      return;
    }

    const cleanTo = to.replace('whatsapp:', '');
    const url = `https://graph.facebook.com/v17.0/${phoneNumberId}/messages`;
    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanTo,
      type: 'text',
      text: { body: text },
    };

    try {
      await firstValueFrom(
        this.httpService.post(url, data, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      this.logger.log(`WhatsApp message sent via Facebook Graph API to ${cleanTo}`);
    } catch (error) {
      this.logger.error('Failed to send WhatsApp message via Facebook Graph API', error.response?.data || error.message);
    }
  }
}
