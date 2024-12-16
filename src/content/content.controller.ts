import { Controller, Post, UploadedFile, UseInterceptors, Body } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { ContentService } from './content.service';

@ApiTags('Content')
@Controller('content')
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @Post('bulk-create')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Bulk create content from CSV' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'The CSV file containing Title and FileUrl columns',
        },
        userId: {
          type: 'string',
          example: '15155b7a-5316-4bb2-992a-772093e85f44',
          description: 'The ID of the user creating the content',
        },
        userToken: {
          type: 'string',
          example: '',
          description: 'User Token for creating content. This user should have access to create content.',
        },
      },
    },
  })
  async bulkCreateContent(
    @UploadedFile() file: Express.Multer.File,
    @Body('userId') userId: string,
    @Body('userToken') userToken: string,
  ) {
    return this.contentService.processCsvAndCreateContent(file, userId, userToken);
  }
}
