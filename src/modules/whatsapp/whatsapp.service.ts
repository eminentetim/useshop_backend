import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { UsersService } from '../users/users.service';
import { WalletsService } from '../wallets/wallets.service';
import { PaymentsService } from '../payments/payments.service';
import { AiService } from '../ai/ai.service';
import { OrdersService } from '../orders/orders.service';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly usersService: UsersService,
    private readonly walletsService: WalletsService,
    private readonly paymentsService: PaymentsService,
    private readonly aiService: AiService,
    private readonly ordersService: OrdersService,
  ) {}

  async handleIncomingMessage(body: any) {
    this.logger.log('Received WhatsApp message', JSON.stringify(body));

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const phoneNumber = message.from;
    const messageType = message.type;
    let userInput = '';

    // 1. Find or create user
    const { user, isNew } = await this.usersService.findOrCreateByPhoneNumber(phoneNumber);

    if (isNew) {
      await this.handleOnboarding(user);
      return;
    }

    // 2. Process Multimodal Input
    try {
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
    } catch (error) {
      this.logger.error('Error processing multimodal input', error.message);
      await this.sendMessage(phoneNumber, "Sorry, I had trouble processing that. Could you try again or send a text?");
      return;
    }

    if (!userInput) return;

    // 3. Handle basic commands before AI processing
    const normalizedInput = userInput.toLowerCase().trim();
    if (normalizedInput === 'balance' || normalizedInput === 'wallet') {
      await this.handleBalanceCheck(user);
      return;
    }

    if (normalizedInput === 'confirm') {
        await this.handleCheckout(user);
        return;
    }

    // 4. AI Orchestration
    const aiResponse = await this.aiService.processRequest(userInput);
    await this.sendMessage(phoneNumber, aiResponse);
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

  private async handleOnboarding(user: any) {
    const wallet = await this.walletsService.createWallet(user);
    let welcomeMessage = `Welcome to UseShop! 🛍️ I'm your AI shopping assistant.\n\nI've created your NGN wallet.`;

    try {
      const monnifyAccount = await this.paymentsService.createReservedAccount({
        id: user.id,
        phoneNumber: user.phoneNumber,
        name: user.name,
        email: user.email,
      });

      if (monnifyAccount && monnifyAccount.accounts) {
        const acc = monnifyAccount.accounts[0];
        await this.walletsService.updateWallet(wallet.id, {
          monnifyAccountNumber: acc.accountNumber,
          monnifyBankName: acc.bankName,
          monnifyAccountReference: monnifyAccount.accountReference,
        });

        welcomeMessage += `\n\nYou can fund your wallet by transferring to:\nBank: ${acc.bankName}\nAccount: ${acc.accountNumber}\nName: ${acc.accountName}`;
      }
    } catch (error) {
      welcomeMessage += `\n\n(Wallet funding is currently being set up. I'll notify you once it's ready!)`;
    }

    await this.sendMessage(user.phoneNumber, welcomeMessage);
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

  async sendMessage(to: string, text: string) {
    const phoneNumberId = this.configService.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const accessToken = this.configService.get<string>('WHATSAPP_ACCESS_TOKEN');

    if (!phoneNumberId || !accessToken) {
      this.logger.warn('WhatsApp credentials not set. Message not sent:', text);
      return;
    }

    const url = `https://graph.facebook.com/v17.0/${phoneNumberId}/messages`;
    const data = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: to,
      type: 'text',
      text: { body: text },
    };

    try {
      await firstValueFrom(
        this.httpService.post(url, data, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
    } catch (error) {
      this.logger.error('Failed to send WhatsApp message', error.response?.data || error.message);
    }
  }
}
