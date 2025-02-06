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

  @Get('downloadFile')
  async downloadFile() {
    await this.cronService.downloadFile();
    return { message: 'Cron job triggered successfully.' };
  }
}

