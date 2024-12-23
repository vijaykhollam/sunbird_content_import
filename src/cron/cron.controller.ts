import { Controller, Get } from '@nestjs/common';
import { CronService } from './cron.service';

@Controller('cron')
export class CronController {
  constructor(private readonly cronService: CronService) {}

  @Get('trigger')
  async triggerCronJob() {
    await this.cronService.processRecords();
    return { message: 'Cron job triggered successfully.' };
  }
}

