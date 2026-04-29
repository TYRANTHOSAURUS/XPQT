import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { DailyListPayload } from './daily-list.service';

// TODO: PDF rendering temporarily disabled. The previous implementation used
// @react-pdf/renderer, which forced React 18 into the api workspace and
// collided with web's React 19 (broke Vercel bundles with an "Activity"
// runtime error). The dep was removed to unblock deploys. Replace with one
// of:
//   - Puppeteer/Playwright HTML→PDF (recommended; templates can be plain
//     HTML+CSS and reused by the web admin preview)
//   - pdfkit / pdfmake (no headless browser, but more imperative)
//   - A dedicated rendering microservice
// Until then, any caller that hits renderDaglijst will get a 503 instead
// of crashing — the rest of the daily-list flow continues to work.

@Injectable()
export class PdfRendererService {
  private readonly log = new Logger(PdfRendererService.name);

  async renderDaglijst(_input: RenderInput): Promise<RenderResult> {
    this.log.warn('renderDaglijst called while PDF renderer is disabled (see TODO in pdf-renderer.service.ts)');
    throw new ServiceUnavailableException(
      'PDF export temporarily disabled — see TODO in apps/api/src/modules/daily-list/pdf-renderer.service.ts',
    );
  }
}

export interface RenderInput {
  payload: DailyListPayload;
  generation: {
    version: number;
    generated_at: string;
    triggered_by: 'admin_manual' | 'auto';
  };
}

export interface RenderResult {
  buffer: Buffer;
  mimeType: string;
  sizeBytes: number;
  renderMs: number;
}
