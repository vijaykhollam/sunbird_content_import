import { Injectable } from '@nestjs/common';

@Injectable()
export class CourseService {
  private courses = []; // Temporary in-memory store

  async createCourse(name: string, description: string): Promise<any> {
    const course = {
      id: `${Date.now()}`, // Simulate unique ID
      name,
      description,
    };
    return course;
  }

  async getCourseByName(name: string): Promise<any> {
   // return this.courses.find(course => course.name === name) || null;
  }
}
