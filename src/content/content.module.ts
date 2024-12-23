import { Module } from '@nestjs/common';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { CourseModule } from '../course/course.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [CourseModule, ConfigModule], // Import ConfigModule
  controllers: [ContentController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}
