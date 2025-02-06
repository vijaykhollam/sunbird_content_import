import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class FileLoggerService {
  private readonly logger = new Logger(FileLoggerService.name);
  private readonly logFilePath = path.join(__dirname, '../../logs/error.log');

  logError(message: string, trace: string) {
    const logMessage = `${new Date().toISOString()} - ERROR: ${message}\nStack: ${trace}\n\n`;

    // Log error to the console
    this.logger.error(message);

    // Append error to a file
    fs.appendFile(this.logFilePath, logMessage, (err) => {
      if (err) {
        this.logger.error('Failed to write to log file', err.message);
      }
    });
  }
}
