import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Content } from '../entities/content.entity';
import { ContentService } from '../content/content.service';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    @InjectRepository(Content)
    private readonly contentRepository: Repository<Content>,
    private readonly contentService: ContentService,
  ) {}

  async processRecords(limit: number = 1): Promise<void> {
    this.logger.log('Cron job started: Fetching records to process...');
  
    // Use QueryBuilder for the NOT EXISTS subquery
    const records = await this.contentRepository
      .createQueryBuilder('c')
      .where('NOT EXISTS (SELECT 1 FROM Content child WHERE child.parentid = c.content_id)')
      .andWhere('c.repository_id = :repositoryId', { repositoryId: 'SCAPP' })
      .andWhere('c.isdeleted = :isDeleted', { isDeleted: 0 })
      .andWhere('c.migrated = :migrated', { migrated: 0 })
      .take(limit)
      .getMany();
  
    if (records.length === 0) {
      this.logger.log('No records to process.');
      return;
    }
  
    for (const record of records) {
      try {
        this.logger.log(`Processing content_id: ${record.content_id}`);
  
        console.log(record);
  
        // Process each record using ContentService
        await this.contentService.processSingleContentRecord(record);
  
        // Mark the record as migrated
        record.migrated = true;
        await this.contentRepository.save(record);
  
        this.logger.log(`Successfully migrated content_id: ${record.content_id}`);
      } catch (error) {
        this.logger.error(`Error processing content_id ${record.content_id}:`, error);
      }
    }
  
    this.logger.log('Cron job completed successfully.');
  }
  
}
