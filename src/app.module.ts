import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { ContentModule } from './content/content.module';

@Module({
  imports: [ConfigModule, ContentModule],
})
export class AppModule {}