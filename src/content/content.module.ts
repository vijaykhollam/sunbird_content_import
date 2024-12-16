import { Module } from '@nestjs/common';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { CourseModule } from '../course/course.module';

@Module({
  imports: [CourseModule],
  controllers: [ContentController],
  providers: [ContentService],
})
export class ContentModule {}