import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parse } from 'csv-parse/sync';
import axios from 'axios';
import * as fs from 'fs';
import * as AWS from 'aws-sdk';
import FormData from 'form-data';
import * as path from 'path';
import { CourseService } from '../course/course.service';
import { Content } from '../entities/content.entity';
import { AxiosError } from 'axios';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { FileLoggerService } from '../logger/file-logger.service';
import https from 'https';


@Injectable()
export class ContentService {
  
  private readonly middlewareUrl: string;
  private readonly framework: string;
  private readonly logger = new Logger(ContentService.name); // Define the logger

  constructor(
    private readonly configService: ConfigService,
    private readonly courseService: CourseService, // Inject CourseService here
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly fileLogger: FileLoggerService,
  ) {
    this.middlewareUrl = this.configService.get<string>('MIDDLEWARE_QA_URL') || 'https://qa-middleware.tekdinext.com';
    this.framework = this.configService.get<string>('FRAMEWORK') || 'scp-framework';
    
    /*
    // Initialize Winston error logger for file-based error logging
    this.errorLogger = winston.createLogger({
        level: 'error',
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        ),
        transports: [
          new winston.transports.File({
            filename: 'logs/content_errors.log',
            level: 'error',
          }),
        ],
      });
      */
  }

  async processCsvAndCreateContent(file: Express.Multer.File, userId: string, userToken: string) {
    const csvData = parse(file.buffer.toString(), { columns: true });
    const results = [];

    for (const row of csvData) {

      if (!row['ContentTitle'] || !row['ContentURL']) {
        results.push({ title: row['ContentTitle'] || "Unnamed", status: 'Failed', error: 'Missing required fields' });
        continue;
      }

      //console.log('testing API');

      const title = row['ContentTitle'];
      const fileUrl = row['ContentURL'];
      const primaryCategory = row['PrimaryCategory'] || 'Learning Resource';

      try {
        //  Step 1: Create Content and upload it to s3
        const createdContent = await this.createAndUploadContent(row, title, userId, fileUrl, primaryCategory, userToken);
        console.log('createdContent:', createdContent);

        if (createdContent) {
          //  Step 2: Upload Media
          const uploadedContent = await this.uploadContent(createdContent.doId, createdContent.fileUrl, userToken);
          console.log('Uploaded Content:', uploadedContent);

 
          // Step 3: Review Content
          const reviewedContent = await this.reviewContent(createdContent.doId, userToken);
          console.log('Reviewed Content:', reviewedContent);


          // Step 4: Publish Content
          const publishedContent = await this.publishContent(createdContent.doId, userToken);
          console.log('published Content:', publishedContent);

          // Step 5: Create or Select Course
          //  const course = await this.getOrCreateCourse(row.courseName, userToken);
          // const existingCourse = await this.ContentService.getCourseByName(courseName);
          // console.log('Course selected or created:', course);
          
        }
       // 
      // results.push({ id: createdContent.id, status: 'Success' });

      } catch (error) {
        results.push({ title, status: 'Failed', error: (error as any).message });
      }
    }

    return results;
  }

    /**
   * Method to process a single content record
   * @param record - Content entity object
   */
    async processSingleContentRecord(record: Content): Promise<string | undefined> {

      // Log the start of the process
      this.logger.log(`Processing content record with ID: ${Content}`);

      const title = record.cont_title;
      const fileUrl = record.cont_url;

      /*
       // New fields added
        domain: ["Learning for work"],
        subDomain: ["Career Exploration"],
        targetAgeGroup: ["0-3 yrs", "3-6 yrs"],
        primaryUser: ["Educators", "Learners/Children"],
        contentLanguage: "Hindi",
        program: ["Open School"], 

      */

      

      const primaryCategory = 'Learning Resource';
      const userId =  this.configService.get<string>('USER_ID') || '';
      const userToken = this.configService.get<string>('USER_TOKEN') || '';

      if (!title || !fileUrl ) {
        return;
      }

      const createdContent = await this.createAndUploadContent(record, title, userId, fileUrl, primaryCategory, userToken);
      
      /*
      const createdContent = {
        doId: 'do_214215581538918400184',
        fileUrl: 'https://qa-knowlg-inquiry.s3-ap-south-1.amazonaws.com/content/assets/do_214215581538918400184/file.pdf'
      };
      */      
      
      if (!createdContent) {
        return;
      }
      console.log(createdContent);

 
      if (createdContent) {
        //  Step 2: Upload Media
        const uploadedContent = await this.uploadContent(createdContent.doId, createdContent.fileUrl, userToken);
        console.log('Uploaded Content:', uploadedContent);

        
        // Step 3: Review Content
        const reviewedContent = await this.reviewContent(createdContent.doId, userToken);
        console.log('Reviewed Content:', reviewedContent);


        // Step 4: Publish Content
        const publishedContent = await this.publishContent(createdContent.doId, userToken);
        console.log('published Content:', publishedContent);  
        
        if (publishedContent)
        {
          // Return Do Id when published content is returned.
          return createdContent.doId;
        }
      }
    }

  /*
  private async getOrCreateCourse(courseName: string): Promise<Course> {
    // Check if course exists; create if not
   // const existingCourse = await this.ContentService.getCourseByName(courseName);
    // return existingCourse || 
    //this.ContentService.createCourse(courseName);
  }
  */

  private getHeaders(userToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${userToken}`, // Ensure no undefined Authorization
      tenantId: this.configService.get<string>('MIDDLEWARE_TENANT_ID') || 'ef99949b-7f3a-4a5f-806a-e67e683e38f3', // Fallback value
      "X-Channel-Id": this.configService.get<string>('X_CHANNEL_ID') || 'qa-scp-channel',
      "Content-Type": "application/json",
    };
  }

  private getUrl(endpoint: string): string {
    return `${this.middlewareUrl}${endpoint}`;
  }

  /*

  async findSecondTopmostParent(contentId: string): Promise<any> {
    const result = await this.contentRepository.query(
      `
      WITH ParentHierarchy AS (
          SELECT 
              content_id, 
              parentid, 
              cont_title, 
              cont_url, 
              1 AS level
          FROM Content
          WHERE content_id = @0
          
          UNION ALL
          
          SELECT 
              parent.content_id, 
              parent.parentid, 
              parent.cont_title, 
              parent.cont_url, 
              child.level + 1
          FROM Content AS parent
          INNER JOIN ParentHierarchy AS child
              ON parent.content_id = child.parentid
      )
      SELECT TOP 1 *
      FROM (
          SELECT *, ROW_NUMBER() OVER (ORDER BY level DESC) AS RowNum
          FROM ParentHierarchy
      ) AS HierarchyWithRowNum
      WHERE RowNum = 2
      OPTION (MAXRECURSION 1000);
      `,
      [contentId]
    );
  
    return result[0] || null;
  }
  */
  

  private async createAndUploadContent(
    record: Content,
    title: string,
    userId: string,
    documentUrl: string,
    primaryCategory: string,
    userToken: string
  ) {
    try {
      const { v4: uuidv4 } = require('uuid');
      const path = require('path');
      const mime = require('mime-types'); // Ensure mime-types is installed
      const SUPPORTED_FILE_TYPES = ['pdf', 'mp4', 'zip', 'mp3'];
  
      const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
      const isYouTubeURL = YOUTUBE_URL_REGEX.test(documentUrl);
  
      const uniqueCode = uuidv4();
      let fileUrl: string = documentUrl; // Default to documentUrl
      let tempFilePath: string | null = null;

      /*
      const domain = record.DOMAIN;
      const subDomain = record.SUB_DOMAIN;
      const targetAgeGroup = record.TARGET_AGE_GROUP;
      const primaryUser = record.PRIMARY_USER;
      
      */
      const contentLanguage = record.CONTENT_LANGUAGE;
      const description = record.resource_desc;
      // Framework fields
      /*
      const additionalFields = {
        state: ["Maharashtra"],
        board: ["Maharashtra Education Board"],
        medium: ["Marathi"],
        gradeLevel: ["Grade 10"],
        courseType: ["Foundation Course"],
        subject: ["Hindi"],
        isForOpenSchool: ["Yes"],
        program: ["Second Chance"],
      };
      */

      const additionalFields = {
        description: description,
        // New fields added
        domain: ["Learning for work"], // no changes needed currently
        primaryUser: ["Educators", "Learners/Children"], // no changes needed currently
        program: ["Open School"], // no changes needed currently
        subDomain: ["Career Exploration"], // no changes needed currently
        targetAgeGroup: ["14-18 yrs", "18 yrs +"], // no changes needed currently
        contentLanguage: contentLanguage,
        isContentMigrated:1,
        contentType:"Resource"
      };
  
      // Step 1: Create Content
      const ext = path.extname(new URL(documentUrl).pathname).slice(1).toLowerCase();
      let mimeType = isYouTubeURL 
          ? 'video/x-youtube' 
          : (ext === 'zip' 
              ? 'application/vnd.ekstep.html-archive' 
              : mime.lookup(ext) || 'application/octet-stream');
  
      const payload = {
        request: {
          content: {
            name: title,
            code: uniqueCode,
            mimeType: mimeType,
            primaryCategory: primaryCategory,
            framework: this.framework,
            createdBy: userId || '',
            ...additionalFields, // Merged dynamic fields here
          },
        },
      };
  
      const payloadString = JSON.stringify(payload);
      const contentLength = Buffer.byteLength(payloadString, 'utf8');
  
      const headers = {
        "Content-Type": "application/json",
        "Content-Length": contentLength,
        tenantId: this.configService.get<string>('MIDDLEWARE_TENANT_ID'),
        Authorization: `Bearer ${userToken}`,
        "X-Channel-Id": this.configService.get<string>('X_CHANNEL_ID'),
      };

      console.log(payloadString);
      console.log(headers);
    
      const createResponse = await axios.post(
        `${this.middlewareUrl}/action/content/v3/create`,
        payload,
        { headers }
      );
  
      console.log(createResponse);


      const { identifier: doId, versionKey } = createResponse.data.result;
      console.log('Content created:', { doId, versionKey });
  
      
    
      // Step 1: Check if it's a YouTube URL
      if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/.test(documentUrl)) 
      {
        console.log('YouTube URL detected, skipping file download and S3 upload.');
        fileUrl = documentUrl;
      }
      else
      {

        const fileExtension = path.extname(new URL(documentUrl).pathname).slice(1);

        if (!SUPPORTED_FILE_TYPES.includes(fileExtension)) {
          /*
          this.logger.warn(`Unsupported file type: ${fileExtension} for documentUrl: ${documentUrl}`);
          this.errorLogger.warn({
            message: 'Unsupported file type',
            title,
            userId,
            documentUrl,
            fileExtension,
          });
          */
          return null; // Gracefully exit without throwing
        }
    
        // Step 2: Download Document
        const agent = new https.Agent({  
          rejectUnauthorized: false, // ⚠️ Disable SSL certificate validation
        });

        /*
        const documentResponse = await axios.get(documentUrl, { responseType: 'stream', httpsAgent: agent  });
        */

        const documentResponse = await axios.get(documentUrl, { 
          responseType: 'stream', 
          httpsAgent: agent,
          headers: {} // Ensure no unnecessary headers are passed
        });

        tempFilePath = `/tmp/${uniqueCode}.${fileExtension}`;
        const writer = fs.createWriteStream(tempFilePath);
        documentResponse.data.pipe(writer);
    
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
    
        // === ZIP FILE LOGIC ===
        if (fileExtension === 'zip') {

          const unzipper = require('unzipper');
          const archiver = require('archiver');
              
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
  
      // Step 3: Return Response
      // console.log('Final File URL:', fileUrl);
      // console.log('doId:', doId);
      return { doId, versionKey, fileUrl };
  
    } catch (error) {

      if (error instanceof Error) {
        // Properly handle Error objects
        this.logger.error(`Failed to create  content record with documentUrl: ${documentUrl}`, error.stack);
      } else {
        // Handle non-Error exceptions
        const errorMessage = typeof error === 'string' ? error : JSON.stringify(error);
        this.logger.error(`An unknown error occurred: ${errorMessage}`);
        this.fileLogger.logError(
          `Failed to upload content record with documentUrl: ${documentUrl}`,
          `Unknown error: ${errorMessage}`
        );
      }
     // console.error("Error creating or uploading content:", error.message || error);
     // throw error;
    }
  }
  
  

  private async uploadContent(contentId: string, fileUrl: string, userToken: string) {
    try {
      console.log('uploadContent');

      const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;

      // Check if the URL is a YouTube URL
      const isYouTubeURL = YOUTUBE_URL_REGEX.test(fileUrl);


      const path = require('path');
      const mime = require('mime-types'); // Ensure this library is installed

      let mimeType: string | false = false;
      let tempFilePath: string | null = null;

      
      // Step 3: Prepare FormData and Payload
      const formData = new FormData();

      if (isYouTubeURL) {
        this.logger.log('YouTube URL detected, skipping file download and S3 upload.');
        mimeType = 'video/x-youtube';
        formData.append('fileUrl', fileUrl);
      } else {

        const fileExtension = path.extname(new URL(fileUrl).pathname).slice(1); // e.g., 'pdf'

        mimeType = fileExtension === 'zip'
          ? 'application/vnd.ekstep.html-archive'
          : mime.lookup(fileExtension) || 'application/octet-stream';
        
        formData.append('fileUrl', fileUrl);

        // Step 2: Download the file dynamically with its correct extension
        tempFilePath = await this.downloadFileToTemp(fileUrl, `upload_${Date.now()}.${fileExtension}`);
        // formData.append('file', fs.createReadStream(tempFilePath));
      }

      // Step 1: Prepare headers
      const headers = {
        "tenantId": this.configService.get<string>('MIDDLEWARE_TENANT_ID'),
        Authorization: `Bearer ${userToken}`,
        "X-Channel-Id": this.configService.get<string>('X_CHANNEL_ID'),
        ...formData.getHeaders(),
      };

     // console.log('isYouTubeURL');
     // console.log(fileUrl);


      // Step 2: Prepare payload
      const payload = {
        request: {
          content: {
            fileUrl: fileUrl,
            mimeType: mimeType,
          },
        },
      };

    console.log(payload);
    console.log(formData);
    console.log(headers);

      // Step 6: Upload to Middleware
      const uploadUrl = `${this.middlewareUrl}/action/content/v3/upload/${contentId}`;
     // console.log('Upload URL:', uploadUrl);
  
      const uploadFileResponse = await axios.post(uploadUrl, formData, { headers });
      console.log(uploadFileResponse);


      if (this.isZipFile(fileUrl) && uploadFileResponse.status === 500 || !uploadFileResponse.data.success) {
        console.log('Initial upload failed. Retrying...');
        await this.retryUntilSuccess(fileUrl);
      }
  
    // console.log('File Upload Response:', uploadFileResponse.data);
 
    // Clean up temporary file if it exists
    if (tempFilePath) 
    {
        fs.unlinkSync(tempFilePath);
    }

      return uploadFileResponse.data;
    } catch (error) {

      if (axios.isAxiosError(error)) {
        console.error('Error during file upload (Axios):', error.message);
        if (this.isZipFile(fileUrl) && error.response?.status === 500) {
          console.log('Retrying due to server error...');
          await this.retryUntilSuccess(fileUrl);
        }
      } else if (error instanceof Error) {
        console.error('Error during file upload (Generic):', error.message);
      } else {
        console.error('Unknown error during file upload:', error);
      }

    }
}


private async retryUntilSuccess(contentUrl: any) {

  if (!this.isZipFile(contentUrl)) {
    console.error(`Invalid file type: Only .zip files are supported. Provided URL: ${contentUrl}`);
    return;
  }

  let success = false;
  let retries = 0;
  const startTime = Date.now();
  let uploadUrl = 'https://dev-admin.prathamdigital.org/api/content-upload/get-status';
  let userToken = this.configService.get<string>('USER_TOKEN') || '';
  
  const headers = {
    "Content-Type": "application/json",
    "Accept": 'application/json',
    Authorization: `Bearer ${userToken}`,
  };

  // Generate formData dynamically
  const formData = {
    contenturl: contentUrl
};

  while (!success) {
    retries++;
    try {
      const response = await axios.post(uploadUrl, formData, { headers: headers });
      const data = response.data;
      console.log(`Retry ${retries}: Response -`, data);

      if (data.success) {
        success = true;
        const endTime = Date.now();
        const timeTaken = (endTime - startTime) / 1000; // Time in seconds

        console.log(`Operation succeeded after ${retries} retries and ${timeTaken} seconds.`);
        this.logToFile(retries, timeTaken);
      } else {
        console.log(`Retry ${retries}: Current status - success: ${data.success}`);
      }
    } catch (error) {

      if (axios.isAxiosError(error)) 
      {
          console.error(`Retry ${retries}: Axios error occurred -`, error.message);
      }
      else if (error instanceof Error)
      {
          console.error(`Retry ${retries}: Generic error occurred -`, error.message);
      }
      else
      {
          console.error(`Retry ${retries}: Unknown error occurred -`, error);
      }
    }

    // Wait for 2 seconds before retrying
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

private isZipFile(fileUrl: string): boolean {
  return fileUrl.toLowerCase().endsWith('.zip');
}

private logToFile(retries: number, timeTaken: number) {
  const logMessage = `Success after ${retries} retries and ${timeTaken} seconds.\n`;
  const logFilePath = 'upload_log.txt';

  fs.appendFile(logFilePath, logMessage, (err) => {
    if (err) {
      console.error('Error writing to log file:', err.message);
    } else {
      console.log('Log written to file:', logFilePath);
    }
  });
}

  private async downloadFileToTemp(fileUrl: string, fileName: string): Promise<string> {
    const tempFilePath = path.join('/tmp', fileName);
    try {
      const response = await axios.get(fileUrl, { responseType: 'stream' });
      const writer = fs.createWriteStream(tempFilePath);
      response.data.pipe(writer);
  
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
  
      // console.log(`File downloaded to: ${tempFilePath}`);
      return tempFilePath;
    } catch (error) {
      if (error instanceof Error) {
        console.error(`Error downloading file from ${fileUrl}:`, error.message);
      } else {
        console.error(`Unexpected error while downloading file from ${fileUrl}:`, error);
      }
      // Re-throw the error to ensure the function does not return undefined
      throw error;
    }
  }

  private async reviewContent(contentId: string, userToken:string) {
    try {
      const headers = this.getHeaders(userToken);
      const reviewUrl = this.getUrl(`/action/content/v3/review/${contentId}`);

      console.log('Calling reviewContent API:', reviewUrl);
  
      const response = await axios.post(reviewUrl, {}, { headers });
      console.log('Review API Response:', response.data);
  
      return response.data;
    } catch (error) {
      //console.error('Error in reviewContent:', error.response?.data || error.message);
      //throw error;
    }
  }
  

  private async publishContent(contentId: string, userToken:string) {
    try {
      const headers = this.getHeaders(userToken);
      const publishUrl = this.getUrl(`/action/content/v3/publish/${contentId}`);
      const userId =  this.configService.get<string>('USER_ID') || '';
  
      console.log('Calling publishContent API:', publishUrl);
  
      const body = {
        request: {
          content: {
            publishChecklist: [
              "No Hate speech, Abuse, Violence, Profanity",
              "Is suitable for children",
              "Correct Board, Grade, Subject, Medium",
              "Appropriate Title, Description",
              "No Sexual content, Nudity or Vulgarity",
              "No Discrimination or Defamation",
              "Appropriate tags such as Resource Type, Concepts",
              "Relevant Keywords",
              "Audio (if any) is clear and easy to understand",
              "No Spelling mistakes in the text",
              "Language is simple to understand",
              "Can see the content clearly on Desktop and App",
              "Content plays correctly"
            ],
            lastPublishedBy: userId,
          },
        },
      };
  
      const response = await axios.post(publishUrl, body, { headers });
      console.log('Publish API Response:', response.data);
  
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('Error during Publish API (Axios):', error.message);
      } else if (error instanceof Error) {
        console.error('Error during Publish API (Axios):', error.message);
      } else {
        console.error('Error during Publish API (Axios):', error);
      }
      //console.error('Error in publishContent:', error.response?.data || error.message);
      //throw error;
    }
  }
  
}