import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Content } from '../entities/content.entity';
import { ContentService } from '../content/content.service';

import fs from 'fs';
import path from 'path';
import AWS from 'aws-sdk';
import axios from 'axios';
import https from 'https';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    @InjectRepository(Content)
    private readonly contentRepository: Repository<Content>,
    private readonly contentService: ContentService,
  ) {}



  async downloadFile(limit: number = 1): Promise<void> 
  {
      let documentUrl = 'https://prathamopenschool.org/CourseContent/FCGames/One_and_many_EN.zip'; 
      let doId = 'do_2142149445604474881181';
      let uniqueCode ='asdasdas';
      let mimeType = 'application/vnd.ekstep.html-archive'
      let fileUrl = '';
      let tempFilePath = '';
      const unzipper = require('unzipper');
      const archiver = require('archiver');
      
    
      // Step 1: Check if it's a YouTube URL
      if (documentUrl.includes('youtube.com')) {
        console.log('YouTube URL detected, skipping file download and S3 upload.');
        fileUrl = documentUrl;
      } else {
        const fileExtension = path.extname(new URL(documentUrl).pathname).slice(1);
    
        if (!['zip', 'pdf', 'jpg', 'png', 'docx'].includes(fileExtension)) {
          console.warn(`Unsupported file type: ${fileExtension}`);
          return;
        }
    
        // Step 2: Download Document
        const agent = new https.Agent({  
          rejectUnauthorized: false, // ⚠️ Disable SSL certificate validation
        });

        const documentResponse = await axios.get(documentUrl, { responseType: 'stream', httpsAgent: agent  });
        tempFilePath = `/tmp/${uniqueCode}.${fileExtension}`;
        const writer = fs.createWriteStream(tempFilePath);
        documentResponse.data.pipe(writer);
    
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
    
        // === ZIP FILE LOGIC ===
        if (fileExtension === 'zip') {
          // Step 3: Unzip and Remove Additional Folder
          const extractedPath = `/tmp/${uniqueCode}_extracted`;
          fs.mkdirSync(extractedPath, { recursive: true });
    
          await fs.createReadStream(tempFilePath).pipe(unzipper.Extract({ path: extractedPath })).promise();
    
          // Check and flatten the extra folder structure
          const extractedFiles = fs.readdirSync(extractedPath);
          if (extractedFiles.length === 1 && fs.statSync(path.join(extractedPath, extractedFiles[0])).isDirectory()) {
            const innerFolderPath = path.join(extractedPath, extractedFiles[0]);
            const finalFolderPath = `/tmp/${uniqueCode}_final`;
            fs.mkdirSync(finalFolderPath, { recursive: true });
    
            fs.readdirSync(innerFolderPath).forEach((file) => {
              fs.renameSync(path.join(innerFolderPath, file), path.join(finalFolderPath, file));
            });
    
            fs.rmdirSync(innerFolderPath);
            fs.rmdirSync(extractedPath);
          } else {
            fs.renameSync(extractedPath, `/tmp/${uniqueCode}_final`);
          }
    
          // Step 4: Re-Zip the Contents
          const finalZipPath = `/tmp/${uniqueCode}_cleaned.zip`;
          const output = fs.createWriteStream(finalZipPath);
          const archive = archiver('zip', { zlib: { level: 9 } });
    
          archive.pipe(output);
          archive.directory(`/tmp/${uniqueCode}_final`, false);
          await archive.finalize();
    
          await new Promise((resolve, reject) => {
            output.on('close', resolve);
            output.on('error', reject);
          });
    
          // Replace tempFilePath with the cleaned ZIP path for S3 upload
          tempFilePath = finalZipPath;
    
          // Clean up temporary extraction folder
          fs.rmSync(`/tmp/${uniqueCode}_final`, { recursive: true, force: true });
        }
    
        // === AWS S3 Upload Logic ===
        AWS.config.update({
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          region: process.env.AWS_REGION,
        });
    
        const s3 = new AWS.S3();
        const bucketName = process.env.AWS_BUCKET_NAME || '';
        const s3Key = `content/assets/${doId}/file.${fileExtension}`;
    
        const uploadResponse = await s3
          .upload({
            Bucket: bucketName,
            Key: s3Key,
            Body: fs.createReadStream(tempFilePath),
            ContentType: mimeType || 'application/octet-stream',
          })
          .promise();
    
        console.log('Upload successful:', uploadResponse);
    
        // Step 5: Generate the S3 URL
        fileUrl = `https://${bucketName}.s3-${AWS.config.region}.amazonaws.com/${s3Key}`;
    
        // Clean up temporary files
        fs.unlinkSync(tempFilePath);
      }
    
      console.log(fileUrl);
  }

  async processRecords(limit: number = 1): Promise<void> {
    this.logger.log('Cron job started: Fetching records to process...');
  
    // Use QueryBuilder for the NOT EXISTS subquery
    /*
    const records = await this.contentRepository
      .createQueryBuilder('c')
      .where('NOT EXISTS (SELECT 1 FROM Content child WHERE child.parentid = c.content_id)')
      .andWhere('c.repository_id = :repositoryId', { repositoryId: 'SCAPP' })
      .andWhere('c.isdeleted = :isDeleted', { isDeleted: 0 })
      .andWhere('c.migrated = :migrated', { migrated: 0 })
      .take(limit)
      .getMany();
    */
      const records = await this.contentRepository
      .createQueryBuilder('c')
      .where('c.migrated = :migrated', { migrated: 0 })
      .andWhere('c.content_id = :contentId', { contentId: '02c6d8c2-6bec-42b8-8249-ff659035a0e4' })
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
        const result = await this.contentService.processSingleContentRecord(record);
        console.log(result);

        if (result) 
        {
              record.migrated = 1; // ✅ Success
        }
        else
        {
              record.migrated = 2; // ❌ Failure
        }

        // ✅ Assign only valid string values to `do_id`
        record.do_id = typeof result === 'string' ? result : undefined;

        await this.contentRepository.save(record);

  
        this.logger.log(`Successfully migrated content_id: ${record.content_id}`);
      } catch (error) {
        this.logger.error(`Error processing content_id ${record.content_id}:`, error);
      }
    }
  
    this.logger.log('Cron job completed successfully.');
  }
  
}
