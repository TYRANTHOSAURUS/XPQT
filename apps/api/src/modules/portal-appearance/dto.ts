// apps/api/src/modules/portal-appearance/dto.ts
export interface PortalAppearance {
  location_id: string;
  hero_image_url: string | null;
  welcome_headline: string | null;
  supporting_line: string | null;
  greeting_enabled: boolean;
}

export interface UpdatePortalAppearanceDto {
  location_id: string;
  welcome_headline?: string | null;
  supporting_line?: string | null;
  greeting_enabled?: boolean;
}
