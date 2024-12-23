import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parse } from 'csv-parse/sync';
import axios from 'axios';
import * as fs from 'fs';
import * as AWS from 'aws-sdk';
import FormData from 'form-data';
import * as path from 'path';
import { CourseService } from '../course/course.service';
import { Console } from 'console';
import { Content } from '../entities/content.entity';
import { AxiosError } from 'axios';

@Injectable()
export class ContentService {
  
  private readonly middlewareUrl: string;
  private readonly framework: string;
  private readonly logger = new Logger(ContentService.name); // Define the logger

  constructor(
    private readonly configService: ConfigService,
    private readonly courseService: CourseService // Inject CourseService here
  ) {
    this.middlewareUrl = this.configService.get<string>('MIDDLEWARE_QA_URL') || 'https://qa-middleware.tekdinext.com';
    this.framework = this.configService.get<string>('FRAMEWORK') || 'scp-framework';
  }

  async processCsvAndCreateContent(file: Express.Multer.File, userId: string, userToken: string) {
    const csvData = parse(file.buffer.toString(), { columns: true });
    const results = [];

    for (const row of csvData) {

      if (!row['ContentTitle'] || !row['ContentURL']) {
        results.push({ title: row['ContentTitle'] || "Unnamed", status: 'Failed', error: 'Missing required fields' });
        continue;
      }

      console.log('testing API');

      const title = row['ContentTitle'];
      const fileUrl = row['ContentURL'];
      const primaryCategory = row['PrimaryCategory'] || 'Learning Resource';

      try {

        /*
        const courseName = 'Course 10th Dec';
        const description = 'Course 10th Desc';
        const existingCourse = await this.courseService.getCourseByName(courseName);

        if (existingCourse && !existingCourse.content) {
          const existingCourse = await this.courseService.createCourse(courseName, description);
          console.log("Course Does not exist.");
        }
        return;
       */
       
        

        //  Step 1: Create Content and upload it to s3
        const createdContent = await this.createAndUploadContent(title, userId, fileUrl, primaryCategory, userToken);
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
    async processSingleContentRecord(record: Content): Promise<void> {


      const title = record.cont_title;
      const fileUrl = record.cont_url;
      const primaryCategory = 'Learning Resource';
      const userId =  this.configService.get<string>('USER_ID') || '15155b7a-5316-4bb2-992a-772093e85f44';
      const userToken = this.configService.get<string>('USER_TOKEN') || '';

      if (!title || !fileUrl ) {
        return;
      }

      const createdContent = await this.createAndUploadContent(title, userId, fileUrl, primaryCategory, userToken);
      
      
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
      }
   


     /*
     
      this.logger.log(`Processing single content record: content_id=${record.content_id}`);
  
      // Add your processing logic for a single record here
      await new Promise((resolve) => setTimeout(resolve, 500)); // Simulate processing delay
  
      this.logger.log(`Successfully processed content_id: ${record.content_id}`);
      */
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

  private async createAndUploadContent(
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
  
      const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
      const isYouTubeURL = YOUTUBE_URL_REGEX.test(documentUrl);
  
      const uniqueCode = uuidv4();
      let mimeType: string | false = false;
      let fileUrl: string = documentUrl; // Default to documentUrl
      let tempFilePath: string | null = null;

      // Framework fields
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
  
      // Step 1: Create Content
      mimeType = isYouTubeURL ? 'video/x-youtube' : mime.lookup(path.extname(new URL(documentUrl).pathname).slice(1)) || 'application/octet-stream';
  
      const payload = {
        request: {
          content: {
            name: title,
            code: uniqueCode,
            mimeType: mimeType,
            primaryCategory: primaryCategory,
            framework: this.framework,
            createdBy: userId || '15155b7a-5316-4bb2-992a-772093e85f44',
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
    
      const createResponse = await axios.post(
        `${this.middlewareUrl}/action/content/v3/create`,
        payload,
        { headers }
      );
  
      const { identifier: doId, versionKey } = createResponse.data.result;
      console.log('Content created:', { doId, versionKey });
  
      // Step 2: Handle Upload Logic
      if (isYouTubeURL) {
        // Use YouTube URL directly, skip file upload
        this.logger.log('YouTube URL detected, skipping file download and S3 upload.');
        fileUrl = documentUrl; // Directly use the YouTube URL
      } else {
        // Handle Regular File URLs
        const fileExtension = path.extname(new URL(documentUrl).pathname).slice(1);
  
        if (!['pdf', 'mp4', 'zip'].includes(fileExtension)) {
          throw new Error(`Unsupported file type: ${fileExtension}`);
        }
  
        // Step 2.1: Download Document
        const documentResponse = await axios.get(documentUrl, { responseType: 'stream' });
        tempFilePath = `/tmp/${uniqueCode}.${fileExtension}`;
        const writer = fs.createWriteStream(tempFilePath);
        documentResponse.data.pipe(writer);
  
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
  
        // Step 2.2: Upload to AWS S3
        AWS.config.update({
          accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
          secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
          region: this.configService.get<string>('AWS_REGION'),
        });
  
        const s3 = new AWS.S3();
        const bucketName = this.configService.get<string>('AWS_BUCKET_NAME') || '';
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
  
        // Step 2.3: Generate the S3 URL
        fileUrl = `https://${bucketName}.s3-${AWS.config.region}.amazonaws.com/${s3Key}`;
  
        // Clean up the temporary file
        fs.unlinkSync(tempFilePath);
      }
  
      // Step 3: Return Response
      // console.log('Final File URL:', fileUrl);
      // console.log('doId:', doId);
      return { doId, versionKey, fileUrl };
  
    } catch (error) {
     // console.error("Error creating or uploading content:", error.message || error);
     // throw error;
    }
  }
  
  

  private async uploadContent(contentId: string, fileUrl: string, userToken: string) {
    try {
      const path = require('path');
      const mime = require('mime-types'); // Ensure this library is installed
  
      const YOUTUBE_URL_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
  
      // Check if the URL is a YouTube URL
      const isYouTubeURL = YOUTUBE_URL_REGEX.test(fileUrl);
  
      let mimeType: string | false = false;
      let tempFilePath: string | null = null;
  
      if (isYouTubeURL) {
        this.logger.log('YouTube URL detected, skipping file download and S3 upload.');
  
        mimeType = 'text/html'; // YouTube URLs are typically treated as HTML links
  
      } else {
        // Step 1: Extract file extension and MIME type dynamically
        const fileExtension = path.extname(new URL(fileUrl).pathname).slice(1); // e.g., 'pdf'
        mimeType = mime.lookup(fileExtension) || 'application/octet-stream';
  
        if (!['pdf', 'mp4', 'zip'].includes(fileExtension)) {
          throw new Error(`Unsupported file type: ${fileExtension}`);
        }
  
        // Step 2: Download the file dynamically with its correct extension
        tempFilePath = await this.downloadFileToTemp(fileUrl, `upload_${Date.now()}.${fileExtension}`);
  
        if (!fs.existsSync(tempFilePath)) {
          throw new Error(`File not found at ${tempFilePath}`);
        }
  
        const stats = fs.statSync(tempFilePath);
        // console.log(`File size: ${stats.size} bytes`);
        // console.log(`File downloaded to: ${tempFilePath}`);
      }
  
      // Step 3: Prepare FormData and Payload
      const formData = new FormData();
  
      if (isYouTubeURL) {
        // Pass YouTube URL directly
        formData.append('fileUrl', fileUrl);
      } else if (tempFilePath) {
        formData.append('file', fs.createReadStream(tempFilePath));
      }
  
      // Step 4: Prepare headers
      const headers = {
        "tenantId": this.configService.get<string>('MIDDLEWARE_TENANT_ID'),
        Authorization: `Bearer ${userToken}`,
        "X-Channel-Id": this.configService.get<string>('X_CHANNEL_ID'),
        ...formData.getHeaders(),
      };
  
      // Step 5: Prepare payload with dynamic MIME type
      const payload = {
        request: {
          content: {
            fileUrl: isYouTubeURL ? fileUrl : undefined,
            mimeType: mimeType,
          },
        },
      };
  
     // console.log('Headers:', headers);
     // console.log('Payload:', payload);
  
      // Step 6: Upload to Middleware
      const uploadUrl = `${this.middlewareUrl}/action/content/v3/upload/${contentId}`;
     // console.log('Upload URL:', uploadUrl);
  
      const uploadFileResponse = await axios.post(uploadUrl, formData, { headers });
  
     // console.log('File Upload Response:', uploadFileResponse.data);
  
      // Clean up temporary file if it exists
      if (tempFilePath) {
        fs.unlinkSync(tempFilePath);
      }
  
      return uploadFileResponse.data;
    } catch (error) {
     // console.log('Error in upload API');
      const axiosError = error as AxiosError;
  
      if (axiosError.response) {
        console.error('Response Status:', axiosError.response.status);
        console.error('Response Data:', axiosError.response.data);
        console.error('Response Headers:', axiosError.response.headers);
      } else if (axiosError.request) {
        console.error('No response received:', axiosError.request);
      } else {
        console.error('Error Message:', axiosError.message);
      }
  
      throw axiosError;
    }
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
            lastPublishedBy: "15155b7a-5316-4bb2-992a-772093e85f44",
          },
        },
      };
  
      const response = await axios.post(publishUrl, body, { headers });
      console.log('Publish API Response:', response.data);
  
      return response.data;
    } catch (error) {
      //console.error('Error in publishContent:', error.response?.data || error.message);
      //throw error;
    }
  }
  
}