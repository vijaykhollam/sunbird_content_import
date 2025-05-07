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
import type { AxiosResponse } from 'axios';
import fileType from 'file-type';


@Injectable()
export class ContentService {
  
  private readonly middlewareUrl: string;
  private readonly frontendURL: string;
  private readonly framework: string;
  private readonly logger = new Logger(ContentService.name); // Define the logger
  private logFilePath: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly courseService: CourseService, // Inject CourseService here
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly fileLogger: FileLoggerService,
  ) {
    this.middlewareUrl = this.configService.get<string>('MIDDLEWARE_URL') || '';
    this.frontendURL = this.configService.get<string>('FRONTEND_URL') || '';
    this.framework = this.configService.get<string>('FRAMEWORK') || 'scp-framework';
    this.logFilePath = path.join(process.cwd(), 'error.log');  // Places error.log outside dist/content, beside src
  }

    /**
   * Method to process a single content record
   * @param record - Content entity object
   */
    async processSingleContentRecord(record: Content): Promise<string | undefined | false> {

      // Log the start of the process
      this.logger.log(`Processing content record with ID: ${Content}`);

      const title = record.cont_title;
      const fileDownloadURL = record.cont_dwurl || '';
      
      const isMediaFile = fileDownloadURL.match(/\.(m4a|m4v)$/i); // Checks if fileUrl ends with m4a or m4v

      const fileUrl = isMediaFile ? record.convertedUrl || fileDownloadURL : fileDownloadURL;


      const primaryCategory = 'Learning Resource';
      const userId =  this.configService.get<string>('USER_ID') || '';
      const userToken = this.configService.get<string>('USER_TOKEN') || '';
      
      if (!title || !fileUrl) {
        return false;
      }

      const isValidFile = await this.validateFileUrl(fileUrl, record);

      if (!title || !fileUrl || !isValidFile) {
        return false;
      }

      const createdContent = await this.createAndUploadContent(record, title, userId, fileUrl, primaryCategory, userToken);
      
      if (!createdContent) {
        return;
      }

      console.log('content created successfully.');

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
      tenantId: this.configService.get<string>('MIDDLEWARE_TENANT_ID') || '', // Fallback value
      "X-Channel-Id": this.configService.get<string>('X_CHANNEL_ID') || 'qa-scp-channel',
      "Content-Type": "application/json",
    };
  }

  private getUrl(endpoint: string): string {
    return `${this.middlewareUrl}${endpoint}`;
  }
  

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

      const contentLanguage = record.content_language || '';
      const description = record.resource_desc || '';
      const DOMAIN: string | undefined = record.domain;
      const PRIMARY_USER: string | undefined = record.primary_user;
      const PROGRAM: string | undefined = record.program;
      const SUB_DOMAIN: string | undefined = record.sub_domain;
      const TARGET_AGE_GROUP: string | undefined = record.target_age_group;
      const old_system_content_id = record.old_system_content_id || '';
      // Framework fields

      // Function to handle comma-separated values and convert them into arrays
      const toArray = (value: string | undefined): string[] => 
        value ? value.split(",").map(item => item.trim()) : [];

      const additionalFields = {
        description: description,
        domain: toArray(DOMAIN), 
        primaryUser: toArray(PRIMARY_USER),
        program: toArray(PROGRAM),
        subDomain: toArray(SUB_DOMAIN),
        targetAgeGroup: toArray(TARGET_AGE_GROUP),
        contentLanguage: contentLanguage,
        isContentMigrated: 1,
        oldSystemContentId: old_system_content_id,
        contentType: "Resource"
      };

      const originalUrl = record.cont_dwurl || documentUrl;
      const extFromOriginal = path.extname(new URL(originalUrl).pathname).slice(1).toLowerCase();
      const extFromDownloadLink = path.extname(new URL(documentUrl).pathname).slice(1).toLowerCase();
      let fileExtension = extFromOriginal || extFromDownloadLink;
      
        // ✅ Check if it's a Google Drive URL
        const googleDriveMatch = /drive\.google\.com\/file\/d\/([^/]+)\//.exec(documentUrl);
        if (googleDriveMatch) {
          const fileId = googleDriveMatch[1];
          documentUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
          console.log(`📁 Updated documentUrl for public file: ${documentUrl}`);
        
          try {
            const response = await axios.get(documentUrl, { responseType: 'stream', timeout: 15000 });
            const fileTypeResult = await fileType.fromStream(response.data);
            if (fileTypeResult) {
              fileExtension = fileTypeResult.ext.toLowerCase();
              console.log(`✅ Inferred file type from stream: ${fileExtension}`);
            } else {
              console.warn(`⚠️ Could not infer file type from stream. Defaulting to 'pdf'.`);
              fileExtension = 'pdf';
            }
          } catch (err) {
            console.warn(`⚠️ Could not detect file type for Google Drive public file:`, err instanceof Error ? err.message : err);
            fileExtension = 'pdf';
          }
        }        
      
        /*
        const googleDriveMatch = /drive\.google\.com\/file\/d\/([^/]+)\//.exec(documentUrl);
        if (googleDriveMatch) {
          try {
            const fileId = googleDriveMatch[1];
            const apiKey = process.env.GOOGLE_DRIVE_API_KEY;

            // Get metadata for extension
            const metadata = await axios.get(
              `https://www.googleapis.com/drive/v3/files/${fileId}`,
              {
                params: {
                  fields: 'name,mimeType',
                  key: apiKey,
                },
              }
            );

            const { name, mimeType } = metadata.data;
            console.log(`📁 Google Drive API: name = ${name}, mimeType = ${mimeType}`);

            const extFromName = path.extname(name).slice(1).toLowerCase();
            const extFromMime = mime.extension(mimeType);

            fileExtension = extFromName || extFromMime || '';

            // ✅ Update documentUrl to stream raw file
            documentUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
            console.log(`📁 Updated documentUrl for streaming: ${documentUrl}`);
          } catch (err: unknown) {
            if (err instanceof Error) {
              console.warn(`⚠️ Google Drive API lookup failed: ${err.message}`);
            } else {
              console.warn(`⚠️ Google Drive API lookup failed:`, err);
            }
          }
        }
        */
       /* commented 5th may
        const googleDriveMatch = /drive\.google\.com\/file\/d\/([^/]+)\//.exec(documentUrl);
        if (googleDriveMatch) {
          const fileId = googleDriveMatch[1];
          const apiKey = process.env.GOOGLE_DRIVE_API_KEY;
        
          // Attempt to fetch MIME type using Google Drive API
          try {
            const metadata = await axios.get(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
              params: {
                fields: 'name,mimeType',
                key: apiKey,
              },
            });
        
            const { name, mimeType } = metadata.data;
            console.log(`📁 Google Drive API: name = ${name}, mimeType = ${mimeType}`);
        
            const extFromName = path.extname(name).slice(1).toLowerCase();
            const extFromMime = mime.extension(mimeType);
        
            fileExtension = extFromName || extFromMime || '';
            documentUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
            console.log(`📁 Updated documentUrl for streaming: ${documentUrl}`);
          } catch (err: any) {
            console.warn(`⚠️ Google Drive API lookup failed: ${err.response?.status} - ${err.message}`);
            fileExtension = 'pdf'; // fallback
          }
        }
      */    
        
      // 🔄 Fallback to HEAD request if still unknown
      // ✅ Smarter fallback using HEAD request only if extension is missing or useless
      const knownBadExtensions = ['bin', '', undefined];

      if (!fileExtension || knownBadExtensions.includes(fileExtension)) {
        try {
          const headResponse = await axios.head(documentUrl, { timeout: 5000 });
          const mimeTypeFromHead = headResponse.headers['content-type'];

          if (mimeTypeFromHead && mimeTypeFromHead !== 'application/octet-stream') {
            const inferred = mime.extension(mimeTypeFromHead);
            if (inferred) {
              fileExtension = inferred.toLowerCase();
              console.log(`📦 Inferred from HEAD content-type: ${fileExtension}`);
            } else {
              console.warn(`⚠️ MIME type detected but could not infer extension: ${mimeTypeFromHead}`);
            }
          } else {
            console.warn(`⚠️ HEAD response returned generic MIME type: ${mimeTypeFromHead}`);
          }
        } catch (err) {
          console.warn(`⚠️ Failed to infer file extension via HEAD:`, err instanceof Error ? err.message : err);
        }
      }

      /*
      if (!fileExtension || fileExtension === 'bin') {
        const mimeTypeFromHead = await axios.head(documentUrl, { timeout: 5000 }).then(
          (res) => res.headers['content-type'],
          () => null
        );
      
        if (mimeTypeFromHead) {
          const inferred = mime.extension(mimeTypeFromHead);
          if (inferred) {
            fileExtension = inferred.toLowerCase();
            console.log(`📦 Inferred from HEAD content-type: ${fileExtension}`);
          }
        }
      }
     */ 
      
      // 🛡️ Final fallback
      // 🛡️ Final fallback — only override if there's no valid extension
      if (!fileExtension || !SUPPORTED_FILE_TYPES.includes(fileExtension)) {
        console.warn(`⚠️ Could not detect or unsupported file extension: ${fileExtension}`);
        
        const extFromUrl = path.extname(new URL(documentUrl).pathname).slice(1).toLowerCase();
        if (SUPPORTED_FILE_TYPES.includes(extFromUrl)) {
          fileExtension = extFromUrl;
          console.log(`✅ Recovered valid extension from URL: ${fileExtension}`);
        } else {
          fileExtension = 'pdf'; // Safe default
          console.log(`⚠️ Defaulting to fallback extension: pdf`);
        }
      }

      /*
      if (!fileExtension || !SUPPORTED_FILE_TYPES.includes(fileExtension)) {
        console.warn(`⚠️ Could not detect file extension. Falling back to 'pdf'.`);
        fileExtension = 'pdf';
      }*/
      
      console.log(`✅ Final fileExtension resolved: [${fileExtension}]`);
      
            
      console.log(`Resolved file extension: ${fileExtension}`);
      // Step 1: Create Content
      let mimeType = isYouTubeURL
      ? 'video/x-youtube'
      : fileExtension === 'zip'
      ? 'application/vnd.ekstep.html-archive'
      : mime.lookup(fileExtension) || 'application/octet-stream';
    
  
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
    
      /*
      const createResponse = await axios.post(
        `${this.middlewareUrl}/action/content/v3/create`,
        payload,
        { headers }
      );
      */
      const createResponse = await this.retryRequest(
        () => axios.post(`${this.middlewareUrl}/action/content/v3/create`, payload, { headers }),
        3,
        2000,
        'Create Content'
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

        console.log("In s3 upload.");

        // const fileExtension = path.extname(new URL(documentUrl).pathname).slice(1);

        console.log(`Final fileExtension resolved for validation: [${fileExtension}]`);

        if (!SUPPORTED_FILE_TYPES.includes(fileExtension)) {
          console.log("Gracefully exit without throwing");
          return null; // Gracefully exit without throwing
        }
    
        // Step 2: Download Document
        const agent = new https.Agent({  
          rejectUnauthorized: false, // ⚠️ Disable SSL certificate validation
        });
        /*
        const documentResponse = await axios.get(documentUrl, { 
          responseType: 'stream', 
          httpsAgent: agent,
          headers: {} // Ensure no unnecessary headers are passed
        });

        tempFilePath = `/tmp/${uniqueCode}.${fileExtension}`;
        const writer = fs.createWriteStream(tempFilePath);
        documentResponse.data.pipe(writer);
        */
        const documentResponse = await this.fetchWithRetries<NodeJS.ReadableStream>(documentUrl, {
          responseType: 'stream',
          httpsAgent: agent,
          headers: {}
        });
        
        tempFilePath = `/tmp/${uniqueCode}.${fileExtension}`;
        const writer = fs.createWriteStream(tempFilePath);
        (documentResponse.data as NodeJS.ReadableStream).pipe(writer);
        
    
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
        
        /*
        const uploadResponse = await s3
          .upload({
            Bucket: bucketName,
            Key: s3Key,
            Body: fs.createReadStream(tempFilePath),
            ContentType: mimeType || 'application/octet-stream',
          })
          .promise();
        */
          if (!tempFilePath) {
            console.warn('tempFilePath is null. Skipping S3 upload.');
            return null;
          }
          
          const filePath: string = tempFilePath; // TypeScript now knows it's a string
          
          const uploadResponse = await this.retryRequest(
            () => s3.upload({
              Bucket: bucketName,
              Key: s3Key,
              Body: fs.createReadStream(filePath),
              ContentType: mimeType || 'application/octet-stream',
            }).promise(),
            3,
            2000,
            'S3 Upload'
          );                    
    
        console.log('Upload successful:', uploadResponse);
    
        // Step 5: Generate the S3 URL
        fileUrl = `https://${bucketName}.s3-${AWS.config.region}.amazonaws.com/${s3Key}`;

        console.log('fileUrl:', fileUrl);

    
        // Clean up temporary files
        fs.unlinkSync(tempFilePath);
      }
  
      // Step 3: Return Response
      return { doId, versionKey, fileUrl };
  
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const logMessage = `❌ Failed to create content record with documentUrl: ${documentUrl} - ${errorMessage}`;
  
      // ✅ Print error in console
      console.error(logMessage);
  
      // ✅ Log error to file
      this.logErrorToFile(logMessage);
  
      return;
  }   
  }

  private logErrorToFile(logMessage: string): void {
    const logFilePath = path.join(process.cwd(), 'error.log'); // Ensures log is in a fixed location

    // ✅ Write log to `error.log`
    fs.appendFile(logFilePath, `${new Date().toISOString()} - ${logMessage}\n`, (err) => {
        if (err) console.error('❌ Failed to write to error.log', err);
    });
}

private async fetchWithRetries<T>(
  url: string,
  options: any = {},
  retries = 3,
  delayMs = 2000
): Promise<AxiosResponse<T>> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get<T>(url, options);
      return response; // Return full AxiosResponse<T>
    } catch (error: any) {
      const message = error?.code || error?.message || error.toString();

      if (message.includes('EAI_AGAIN') || message.includes('ENOTFOUND') || message.includes('ETIMEDOUT')) {
        console.warn(`⚠️ Attempt ${attempt} failed with network error: ${message}`);
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
      }

      throw error;
    }
  }

  throw new Error(`Failed to fetch ${url} after ${retries} attempts`);
}

private async validateFileUrl(fileUrl: string, record: Content): Promise<boolean> {
  const SUPPORTED_FILE_TYPES = ['pdf', 'mp4', 'zip', 'mp3'];

  const isYouTubeUrl = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//.test(fileUrl);
  const isGoogleDriveUrl = /drive\.google\.com\/file\/d\/([^/]+)\//.test(fileUrl);

  if (isYouTubeUrl) {
    console.log(`Skipping file existence check for YouTube URL: ${fileUrl}`);
    return true;
  }

  if (isGoogleDriveUrl) {
    console.log(`Skipping file existence check for Google Drive URL: ${fileUrl}`);
    return true;
  }

  const ext = path.extname(new URL(fileUrl).pathname).slice(1).toLowerCase();

  try {
    // Primary check using HEAD request
    const response = await axios.head(fileUrl, { timeout: 15000 });

    if (response.status !== 200) {
      throw new Error(`Unexpected status code: ${response.status}`);
    }

    const mimeType = response.headers['content-type'];
    console.log(`File exists: ${fileUrl} (MIME: ${mimeType}, EXT: ${ext})`);

    if (!SUPPORTED_FILE_TYPES.includes(ext)) {
      throw new Error(`Unsupported file type: ${ext} for URL: ${fileUrl}`);
    }

    return true;

  } catch (headError) {
    console.warn(`HEAD request failed for ${fileUrl}. Attempting GET fallback...`);

    try {
      // Fallback check using GET request with Range header (fetch only 1st byte)
      const response = await axios.get(fileUrl, {
        headers: { Range: 'bytes=0-0' },
        timeout: 15000,
      });

      const mimeType = response.headers['content-type'];
      console.log(`(Fallback) File exists: ${fileUrl} (MIME: ${mimeType}, EXT: ${ext})`);

      if (!SUPPORTED_FILE_TYPES.includes(ext)) {
        throw new Error(`Unsupported file type: ${ext} for URL: ${fileUrl}`);
      }

      return true;

    } catch (getError) {
      const errorMessage = getError instanceof Error ? getError.message : 'Unknown fallback error';
      const logMessage = `❌ Fallback failed: ${fileUrl}. Title: ${record.cont_title} - ${errorMessage}`;

      console.error(logMessage);
      this.logErrorToFile(logMessage);
      return false;
    }
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
      fileUrl = fileUrl.trim(); // ✅ Trim spaces
      
      // Step 3: Prepare FormData and Payload
      const formData = new FormData();

      if (isYouTubeURL) {
        this.logger.log('YouTube URL detected, skipping file download and S3 upload.');
        mimeType = 'video/x-youtube';
        formData.append('fileUrl', fileUrl);
        formData.append('mimeType', mimeType); // ✅ Added missing field
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



      // Step 6: Upload to Middleware
      const uploadUrl = `${this.middlewareUrl}/action/content/v3/upload/${contentId}`;
     // console.log('Upload URL:', uploadUrl);
  
     console.log(payload);
     console.log(formData);
     console.log(headers);
     console.log(uploadUrl);

      const uploadFileResponse = await axios.post(uploadUrl, formData, { headers });
      console.log(uploadFileResponse);


      if (this.isZipFile(fileUrl) && uploadFileResponse.status === 500 && !uploadFileResponse.data.success) {
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
  let uploadUrl = `${this.frontendURL}/api/content-upload/get-status`;
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
  
      //const response = await axios.post(reviewUrl, {}, { headers });
      const response = await this.retryRequest(
        () => axios.post(reviewUrl, {}, { headers }),
        3,
        2000,
        'reviewContent'
      );
      
      console.log('Review API Response:', response.data);
  
      return response.data;
    } catch (error) {
      this.handleApiError('reviewContent', error, contentId);
    }
  }

  private handleApiError(methodName: string, error: unknown, contentId?: string) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const logMessage = `❌ API Error in ${methodName}: ${errorMessage}` + 
                        (contentId ? ` (Content ID: ${contentId})` : '');

    // ✅ Print error in console for debugging
    console.error(logMessage);

    // ✅ Log error to file
    this.logErrorToFile(logMessage);
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
  
      console.log('Publish API Response:', body);

     // const response = await axios.post(publishUrl, body, { headers });
      const response = await this.retryRequest(
        () => axios.post(publishUrl, body, { headers }),
        3,
        2000,
        'publishContent'
      );
      
      console.log('Publish API Response:', response.data);
  
      return response.data;
    } catch (error) {
      this.handleApiError('publishContent', error, contentId);
    }
  }

  private async retryRequest<T>(
    fn: () => Promise<T>,
    retries = 3,
    delayMs = 2000,
    label = 'API'
  ): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await fn();
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`⚠️ ${label} attempt ${attempt} failed: ${message}`);
        if (attempt < retries) {
          await new Promise((res) => setTimeout(res, delayMs));
        } else {
          this.handleApiError(label, error);
          throw error;
        }
      }
    }
    throw new Error(`${label} failed after ${retries} retries`);
  }
  
}