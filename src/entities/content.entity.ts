import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity('Content') // Maps to the Content table
export class Content {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  content_id?: string; // Primary key

  @Column({ type: 'tinyint', default: 0 })
  migrated?: boolean; // Flag to track migration status

  @Column({ type: 'varchar', length: 100, nullable: true })
  cont_title?: string; 

  @Column({ type: 'text', nullable: true })
  cont_url?: string;

  @Column({ type: 'text', nullable: true })
  cont_tags?: string;

  @Column({ type: 'text', nullable: true })
  resource_desc?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  parentid?: string; // Parent ID for hierarchical relationships

  @Column({ type: 'varchar', length: 100 })
  repository_id?: string; // Repository ID to filter records

  @Column({ type: 'tinyint', default: 0 })
  isdeleted?: number; // Soft delete flag
}
