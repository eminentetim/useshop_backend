import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Apply request logging with correlation IDs
  app.use(new RequestLoggerMiddleware().use.bind(new RequestLoggerMiddleware()));

  // Enable CORS for dashboard (adjust in production)
  app.enableCors();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`Application is running on: http://localhost:${port}`);
}
bootstrap();
