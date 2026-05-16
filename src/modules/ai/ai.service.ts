import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as FormData from 'form-data';
import { ChatOpenAI } from '@langchain/openai';
import { SearchTool } from './tools/search.tool';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private model: ChatOpenAI;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpService: HttpService,
    private readonly searchTool: SearchTool,
  ) {
    this.model = new ChatOpenAI({
      openAIApiKey: this.configService.get<string>('OPENAI_API_KEY'),
      modelName: 'gpt-4o',
      temperature: 0,
    });
  }

  async transcribeVoice(audioUrl: string): Promise<string> {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) return 'OpenAI API Key not set.';

    try {
      // 1. Download the audio from WhatsApp URL
      const response = await firstValueFrom(
        this.httpService.get(audioUrl, {
          responseType: 'arraybuffer',
          headers: {
            Authorization: `Bearer ${this.configService.get('WHATSAPP_ACCESS_TOKEN')}`,
          },
        }),
      );

      // 2. Upload to OpenAI Whisper
      const form = new (FormData as any)();
      form.append('file', Buffer.from(response.data), {
        filename: 'voice.ogg',
        contentType: 'audio/ogg',
      });
      form.append('model', 'whisper-1');

      const whisperResponse = await firstValueFrom(
        this.httpService.post('https://api.openai.com/v1/audio/transcriptions', form, {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bearer ${apiKey}`,
          },
        }),
      );

      return whisperResponse.data.text;
    } catch (error) {
      this.logger.error('Failed to transcribe voice', error.message);
      return 'Error transcribing voice note.';
    }
  }

  async analyzeImage(imageUrl: string, caption?: string): Promise<string> {
    // This uses GPT-4o Vision to understand what the user wants based on an image
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    if (!apiKey) return 'OpenAI API Key not set.';

    try {
        const response = await this.model.invoke([
            {
                role: 'user',
                content: [
                    { type: 'text', text: caption || "What is in this image? I want to buy this. Please describe it for a shopping search." },
                    { type: 'image_url', image_url: { url: imageUrl } }
                ]
            }
        ]);
        return response.content as string;
    } catch (error) {
        this.logger.error('Failed to analyze image', error.message);
        return 'Error analyzing image.';
    }
  }

  async processRequest(userInput: string, history: any[] = []) {
    // 1. Determine intent
    const intentDetection = await this.model.invoke([
        { role: 'system', content: 'You are a shopping assistant. Determine if the user wants to SEARCH for a product, BUY a specific item from a previous list, or just CHAT. \nIf SEARCH: reply "SEARCH: [query]". \nIf BUY: reply "BUY: [index or title]". \nOtherwise: reply "CHAT: [response]".' },
        { role: 'user', content: userInput }
    ]);

    const content = intentDetection.content as string;
    if (content.startsWith('SEARCH:')) {
        const query = content.replace('SEARCH:', '').trim();
        const results = await this.searchTool.searchProducts(query);
        
        if (results.length === 0) {
            return "I searched for that but couldn't find any direct matches in Nigeria. Could you be more specific?";
        }

        let response = `I found some options for "${query}":\n\n`;
        results.slice(0, 3).forEach((item, index) => {
            response += `${index + 1}. *${item.title}*\nPrice: ${item.price}\nLink: ${item.link}\n\n`;
        });
        response += `Reply with "Buy 1" to add the first item to your cart and proceed to checkout.`;
        return response;
    }

    if (content.startsWith('BUY:')) {
        return "Great choice! I'm adding that to your cart. Please reply with 'confirm' to pay from your wallet and complete the order.";
    }

    return content.replace('CHAT:', '').trim();
  }
}
