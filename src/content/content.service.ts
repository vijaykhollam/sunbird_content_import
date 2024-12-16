import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parse } from 'csv-parse/sync';
import axios from 'axios';
import * as fs from 'fs';
import * as AWS from 'aws-sdk';
import FormData from 'form-data';
import * as path from 'path';
import { CourseService } from '../course/course.service';

@Injectable()
export class ContentService {
  private readonly middlewareUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.middlewareUrl = this.configService.get<string>('MIDDLEWARE_QA_URL') || 'https://qa-middleware.tekdinext.com';
  }

  async processCsvAndCreateContent(file: Express.Multer.File, userId: string, userToken: string) {
    const csvData = parse(file.buffer.toString(), { columns: true });
    const results = [];

    for (const row of csvData) {

      if (!row['Title'] || !row['FileUrl']) {
        results.push({ title: row['Title'] || "Unnamed", status: 'Failed', error: 'Missing required fields' });
        continue;
      }

      const title = row['Title'];
      const fileUrl = row['FileUrl'];
      const primaryCategory = row['PrimaryCategory'] || 'Learning Resource';

      try {
        
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

  private async createAndUploadContent(title: string, userId: string, documentUrl: string, primaryCategory: string, userToken: string) {
    try {
      const { v4: uuidv4 } = require('uuid');
      const uniqueCode = uuidv4();
      const mimeType = this.getMimeTypeFromFile(documentUrl);

      const payload = {
        request: {
          content: {
            name: title,
            code: uniqueCode, // Generate a unique code dynamically
            mimeType: mimeType,
            primaryCategory: primaryCategory,
            createdBy: userId || '15155b7a-5316-4bb2-992a-772093e85f44',
          },
        },
      };

      const payloadString = JSON.stringify(payload); // Convert payload to a JSON string
      const contentLength = Buffer.byteLength(payloadString, 'utf8'); // Calculate byte size      
  
      const headers = {
        "Content-Type": "application/json",
        "Content-Length":contentLength,
        "tenantId": this.configService.get<string>('MIDDLEWARE_TENANT_ID'), // Replace with dynamic or environment value
        Authorization: `Bearer ${userToken}`,
        "X-Channel-Id":this.configService.get<string>('X_CHANNEL_ID')
      };

      console.log(headers);
      
      const createResponse = await axios.post(`${this.middlewareUrl}/action/content/v3/create`, payload, {
        headers,
      });

    // Extract required fields from response
    const { identifier: doId, versionKey } = createResponse.data.result;

    console.log('Content created:', { doId, versionKey });

    // Step 2: Download Document
    const documentResponse = await axios.get(documentUrl, { responseType: 'stream' });
    const tempFilePath = `/tmp/${uniqueCode}.pdf`; // Temporary storage
    const writer = fs.createWriteStream(tempFilePath);
    documentResponse.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    // Step 3: Upload Document to AWS S3
    AWS.config.update({
      accessKeyId: this.configService.get<string>('AWS_ACCESS_KEY_ID'),
      secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY'),
      region: this.configService.get<string>('AWS_REGION'),
    });

    const s3 = new AWS.S3();
    const bucketName = this.configService.get<string>('AWS_BUCKET_NAME') || '';

    // Create the file path
    const s3Key = `content/assets/${doId}/dummy.pdf`; // Use your desired filename

    const uploadResponse = await s3
      .upload({
        Bucket: bucketName,
        Key: s3Key,
        Body: fs.createReadStream(tempFilePath),
        ContentType: "application/pdf",
      })
      .promise();

    console.log('Upload successful:', uploadResponse);

    // Clean up the temporary file
    fs.unlinkSync(tempFilePath);

    // Generate the file URL
    const fileUrl = `https://${bucketName}.s3-${AWS.config.region}.amazonaws.com/${s3Key}`;
    console.log('File accessible at:', fileUrl);

    return { doId, versionKey, fileUrl, uploadResponse };
 

    //  return response.data;
    } catch (error) {
    // console.log(error);
     //console.error("Error creating content:", error.response?.data || error.message);
     //throw error;
    }
  }
  

  private async uploadContent(contentId: string, fileUrl: string, userToken: string) {
    try {

      // Step 1: Download the file
      const tempFilePath = await this.downloadFileToTemp(fileUrl, `upload_${Date.now()}.pdf`);
      console.log(`File downloaded to: ${tempFilePath}`);

      // Determine MIME type dynamically from file type
      const mimeType = this.getMimeTypeFromFile(fileUrl);

      const formData = new FormData();
      formData.append('file', fs.createReadStream(tempFilePath));

      // Prepare headers
      const headers = {
        "Content-Type": "application/json",
        "tenantId": this.configService.get<string>('MIDDLEWARE_TENANT_ID'),
        Authorization: `Bearer ${userToken}`,
        "X-Channel-Id": this.configService.get<string>('X_CHANNEL_ID'),
        ...formData.getHeaders(), // Automatically includes Content-Type and boundary
      };
  
      // Prepare payload
      const payload = {
        request: {
          content: {
            fileUrl: fileUrl,
            mimeType: mimeType,
          },
        },
      };
  
      const uploadUrl = `${this.middlewareUrl}/action/content/v3/upload/${contentId}?enctype=multipart/form-data&processData=false`;
      const uploadFileResponse = await axios.post(uploadUrl, formData, { headers });
   
      console.log('File Upload Response:', uploadFileResponse.data);
      return uploadFileResponse.data;

    } catch (error) {
     console.log(error);
      //console.error('Error in createAndUploadContent:', error.response?.data || error.message);
     // throw error;
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
  
      console.log(`File downloaded to: ${tempFilePath}`);
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
  
  
  private getMimeTypeFromFile(fileUrl: string): string {
    // Extract the file extension
    const extension = fileUrl.split('.').pop()?.toLowerCase();
  
    switch (extension) {
      case 'pdf':
        return 'application/pdf';
      case 'mp4':
        return 'video/mp4';
      case 'zip':
        return 'application/zip';
      default:
        throw new Error(`Unsupported file type: ${extension}`);
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