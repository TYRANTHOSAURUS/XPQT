// apps/api/src/modules/portal-announcements/dto.ts
export interface Announcement {
  id: string;
  location_id: string;
  title: string;
  body: string;
  published_at: string;
  expires_at: string | null;
  created_by: string | null;
}

export interface PublishAnnouncementDto {
  location_id: string;
  title: string;
  body: string;
  expires_at?: string | null;
}
